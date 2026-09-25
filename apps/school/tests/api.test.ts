import { beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { handle, routes } from "@/api/index";
import { db } from "@/platform/db";
import { resetLoginThrottle } from "@/platform/auth/service";
import { resetAdmissionThrottle } from "@/modules/admissions/service";
import { setSetting } from "@/platform/settings";
import * as fin from "@/modules/finance/service";
import * as res from "@/modules/results/service";
import * as people from "@/modules/people/service";
import * as academics from "@/modules/academics/service";
import { hashPassword } from "@/platform/password";
import { ADMIN, makeUser, resetDb, installTestSchool } from "./helpers";
import { adminCtx, seedAcademics } from "./fixtures";

interface CallOpts { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string>; form?: FormData }
async function call(path: string, opts: CallOpts = {}) {
  const [p, qs] = path.split("?");
  const headers = new Headers({ host: "school.local", ...(opts.headers ?? {}) });
  if (opts.cookie) headers.set("cookie", opts.cookie);
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) { headers.set("content-type", "application/json"); body = JSON.stringify(opts.body); }
  const r = await handle(new Request(`http://school.local/api${p}${qs ? `?${qs}` : ""}`, { method: opts.method ?? "GET", headers, body }), p!.split("/").filter(Boolean));
  let json: any = null;
  const ct = r.headers.get("content-type") ?? "";
  if (ct.includes("json")) json = await r.json(); else await r.arrayBuffer();
  return { status: r.status, json, headers: r.headers };
}
async function loginCookie(username: string, password: string) {
  const r = await call("/auth/login", { method: "POST", body: { username, password } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return /ss_session=[^;]+/.exec(r.headers.get("set-cookie")!)![0];
}

beforeEach(async () => {
  await rm("./.data/test-storage", { recursive: true, force: true });
  await resetDb();
  resetLoginThrottle(); resetAdmissionThrottle();
});

describe("route table audit", () => {
  const PUBLIC = ["GET /setup/status", "POST /setup", "POST /auth/login", "GET /public/admissions", "POST /public/admissions/apply", "POST /public/admissions/status", "POST /public/admissions/documents", "GET /public/logo", "POST /device/attendance/scan"];

  it("the ONLY unauthenticated endpoints are the reviewed, intentionally-public ones", () => {
    const pub = routes.filter((r) => r.guard === "public").map((r) => `${r.method} ${r.path}`).sort();
    expect(pub).toEqual([...PUBLIC].sort());
  });

  it("every other endpoint rejects an unauthenticated request with 401 — never 200 or 500", async () => {
    await installTestSchool();
    const protectedRoutes = routes.filter((r) => r.guard !== "public");
    expect(protectedRoutes.length).toBeGreaterThan(120);
    const failures: string[] = [];
    for (const r of protectedRoutes) {
      const path = r.path.replace(/:([a-zA-Z]+)/g, "00000000-0000-4000-8000-000000000001");
      const out = await call(path, { method: r.method, ...(r.method === "GET" ? {} : { body: {} }), headers: { origin: "http://school.local" } });
      if (out.status !== 401) failures.push(`${r.method} ${r.path} → ${out.status}`);
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it("the routes a suspended or lapsed school still needs stay available (recovery, export, checking in with the cloud) and nothing else is exempt", () => {
    const exempt = routes.filter((r) => r.guard !== "public" && r.guard.licenseExempt).map((r) => `${r.method} ${r.path}`).sort();
    expect(exempt).toEqual([
      "GET /auth/me", "GET /backup/:id/download", "GET /files/:id", "GET /notifications", "GET /roles/mine", "GET /sync/status", "GET /system/health",
      "POST /auth/change-password", "POST /auth/logout", "POST /backup/:id/restore", "POST /backup/:id/verify", "POST /backup/run", "POST /notifications/read",
      "POST /sync/now", "POST /sync/register",
    ].sort());
  });

  it("no duplicate routes; unknown paths 404; wrong verbs 405", async () => {
    expect(new Set(routes.map((r) => `${r.method} ${r.path}`)).size).toBe(routes.length);
    expect((await call("/nope/nothing")).status).toBe(404);
    expect((await call("/setup/status", { method: "DELETE" })).status).toBe(405);
  });
});

describe("setup, login, session", () => {
  it("first-run setup works exactly once and seeds roles, grading, templates and rules", async () => {
    expect((await call("/setup/status")).json.data.needsSetup).toBe(true);
    const bad = await call("/setup", { method: "POST", body: { schoolName: "X", admin: { username: "a", password: "x", firstName: "", lastName: "" } } });
    expect(bad.status).toBe(422);
    expect(bad.json.error.code).toBe("VALIDATION");
    const ok = await call("/setup", { method: "POST", body: { schoolName: "Springfield Academy", admin: { username: "boss", password: "Sup3r-secret-1", firstName: "Bo", lastName: "Ss" } } });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.data.installationCode).toMatch(/^SS-/);
    expect((await call("/setup/status")).json.data.needsSetup).toBe(false);
    expect((await call("/setup", { method: "POST", body: { schoolName: "Again", admin: { username: "x2", password: "Sup3r-secret-1", firstName: "A", lastName: "B" } } })).status).toBe(409);
    expect(await db.role.count()).toBeGreaterThan(5);
    expect(await db.gradeRule.count()).toBe(9);
    expect(await db.automationRule.count()).toBeGreaterThan(5);
    expect(await db.notificationTemplate.count()).toBeGreaterThan(20);
  });

  it("login sets a hardened cookie; /auth/me returns server-computed grants; logout revokes", async () => {
    await installTestSchool();
    const bad = await call("/auth/login", { method: "POST", body: { username: "owner", password: "nope-nope-1" } });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("set-cookie")).toBeNull();
    const r = await call("/auth/login", { method: "POST", body: { username: "OWNER", password: ADMIN.password } });
    const setCookie = r.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Path=\//);
    const cookie = /ss_session=[^;]+/.exec(setCookie)![0];
    const me = await call("/auth/me", { cookie });
    expect(me.json.data.user).toMatchObject({ username: "owner", isPrimaryAdmin: true });
    expect(me.json.data.permissions).toContain("finance.reverse_payment");
    expect(me.json.data.modules).toEqual(expect.arrayContaining(["students", "finance", "cbt"]));
    expect(me.json.data.school.schoolName).toBe("Greenfield College");
    expect(JSON.stringify(me.json)).not.toMatch(/passwordHash|cloudSecret/);
    const out = await call("/auth/logout", { method: "POST", cookie });
    expect(out.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    expect((await call("/auth/me", { cookie })).status).toBe(401);
  });

  it("the session cookie is Secure exactly when the sign-in came over HTTPS (the default 'auto'), so a plain-HTTP LAN can log in and a TLS proxy gets the stricter cookie", async () => {
    await installTestSchool();
    const plain = await call("/auth/login", { method: "POST", body: { username: "owner", password: ADMIN.password } });
    expect(plain.headers.get("set-cookie")).not.toMatch(/;\s*Secure/i);
    const proxied = await call("/auth/login", { method: "POST", body: { username: "owner", password: ADMIN.password }, headers: { "x-forwarded-proto": "https" } });
    expect(proxied.headers.get("set-cookie")).toMatch(/;\s*Secure/i);
    expect(proxied.headers.get("set-cookie")).toMatch(/HttpOnly/);
  });

  it("forced password change: everything else is blocked until done", async () => {
    await installTestSchool();
    await makeUser({ username: "newbie", roles: ["teacher"], mustChange: true });
    const cookie = await loginCookie("newbie", "Passw0rd-test");
    expect((await call("/students", { cookie })).json.error.code).toBe("PASSWORD_CHANGE_REQUIRED");
    expect((await call("/auth/me", { cookie })).status).toBe(200);
    expect((await call("/auth/change-password", { method: "POST", cookie, body: { currentPassword: "Passw0rd-test", newPassword: "short" } })).status).toBe(422);
    const ok = await call("/auth/change-password", { method: "POST", cookie, body: { currentPassword: "Passw0rd-test", newPassword: "Brand-new-pass-9" } });
    expect(ok.status).toBe(200);
    expect((await call("/auth/me", { cookie })).status).toBe(401); // all sessions revoked
    await loginCookie("newbie", "Brand-new-pass-9");
  });

  it("blocks cross-origin mutations and reports validation errors as 422, never 500", async () => {
    await installTestSchool();
    const cookie = await loginCookie("owner", ADMIN.password);
    expect((await call("/users", { method: "POST", cookie, body: {}, headers: { origin: "http://evil.example" } })).status).toBe(403);
    const v = await call("/users", { method: "POST", cookie, body: { username: "x" }, headers: { origin: "http://school.local" } });
    expect(v.status).toBe(422);
    expect(v.json.error.details.length).toBeGreaterThan(0);
    const malformed = await call("/users", { method: "POST", cookie, headers: { "content-type": "application/json", origin: "http://school.local" } });
    expect([422, 400]).toContain(malformed.status);
  });
});

describe("authorization over HTTP", () => {
  beforeEach(async () => { await installTestSchool(); });

  it("role permissions gate endpoints; primary admin reaches everything", async () => {
    await makeUser({ username: "teach", roles: ["teacher"] });
    await makeUser({ username: "bur", roles: ["bursar"] });
    const t = await loginCookie("teach", "Passw0rd-test");
    const b = await loginCookie("bur", "Passw0rd-test");
    const o = await loginCookie("owner", ADMIN.password);
    expect((await call("/finance/summary", { cookie: t })).status).toBe(403);
    expect((await call("/finance/summary", { cookie: b })).status).toBe(200);
    expect((await call("/users", { cookie: b })).status).toBe(403);
    expect((await call("/users", { cookie: o })).json.data.items.length).toBe(3);
    expect((await call("/roles", { cookie: t })).status).toBe(403);
    expect((await call("/audit", { cookie: b })).status).toBe(403);
    expect((await call("/audit", { cookie: o })).json.data.total).toBeGreaterThan(0);
    expect((await call("/audit/verify", { cookie: o })).json.data.intact).toBe(true);
    expect(await db.auditLog.count({ where: { action: "security.denied" } })).toBeGreaterThanOrEqual(3);
  });

  it("a disabled module disappears server-side (403 MODULE_DISABLED), not just from the menu", async () => {
    const o = await loginCookie("owner", ADMIN.password);
    expect((await call("/settings/modules/finance", { method: "PUT", cookie: o, body: { enabled: false }, headers: { origin: "http://school.local" } })).status).toBe(200);
    const r = await call("/finance/summary", { cookie: o });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("MODULE_DISABLED");
    expect((await call("/auth/me", { cookie: o })).json.data.modules).not.toContain("finance");
    expect((await call("/settings/modules/platform", { method: "PUT", cookie: o, body: { enabled: false }, headers: { origin: "http://school.local" } })).status).toBe(403); // core can't be disabled
  });

  it("parents are scoped to their own children through the API (IDOR) and the financial lockout is enforced on results", async () => {
    await resetDb(); // seedAcademics2 performs its own installation
    const S = await seedAcademics2();
    const cookie = await loginCookie(S.parentUser, "Parent-pass-1");
    const mine = await call("/me/children", { cookie });
    expect(mine.json.data.map((c: { id: string }) => c.id)).toEqual([S.kid.id]);
    expect((await call(`/students/${S.kid.id}`, { cookie })).status).toBe(200);
    expect((await call(`/students/${S.stranger.id}`, { cookie })).status).toBe(404);
    expect((await call("/students", { cookie })).json.data.total).toBe(1);
    expect((await call("/users", { cookie })).status).toBe(403);
    expect((await call(`/results/students/${S.kid.id}/report-card?termId=${S.termId}`, { cookie })).status).toBe(200);
    expect((await call(`/results/students/${S.stranger.id}/report-card?termId=${S.termId}`, { cookie })).status).toBe(404);
    // school enables the lockout and the child owes overdue fees
    await db.$transaction((tx) => setSetting(tx, "finance.lockout", { enabled: true, graceDays: 0, minimumOutstanding: 0, message: "Please visit the bursary." }));
    await fin.createFeeStructure(await adminCtx(), { name: "T1", termId: S.termId, items: [{ name: "Tuition", amount: 70000 }] });
    await fin.generateInvoice(await adminCtx(), { studentId: S.kid.id, termId: S.termId, dueDate: "2020-01-01" });
    const locked = await call(`/results/students/${S.kid.id}/report-card?termId=${S.termId}`, { cookie });
    expect(locked.status).toBe(403);
    expect(locked.json.error).toMatchObject({ code: "FINANCIAL_LOCKOUT", details: { outstanding: "70000.00", message: "Please visit the bursary." } });
    expect((await call(`/results/students/${S.kid.id}/report-card.pdf?termId=${S.termId}`, { cookie })).status).toBe(403);
    const state = await call(`/finance/students/${S.kid.id}/lockout`, { cookie });
    expect(state.json.data).toMatchObject({ locked: true, outstanding: "70000.00" });
    const owner = await loginCookie("owner", ADMIN.password);
    expect((await call(`/results/students/${S.kid.id}/report-card?termId=${S.termId}`, { cookie: owner })).status).toBe(200); // staff unaffected
    await call("/finance/payments", { method: "POST", cookie: owner, body: { studentId: S.kid.id, amount: 70000, method: "CASH", idempotencyKey: "api-pay-000001" }, headers: { origin: "http://school.local" } });
    const pdf = await call(`/results/students/${S.kid.id}/report-card.pdf?termId=${S.termId}`, { cookie });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
  });
});

describe("public admissions & uploads over HTTP", () => {
  it("applicant flow with multipart document upload, type/size enforcement, and staff-only file access", async () => {
    const S = await seedAcademics();
    void S;
    const info = await call("/public/admissions");
    expect(info.status).toBe(200);
    expect(info.json.data.classes.length).toBeGreaterThan(0);
    const apply = await call("/public/admissions/apply", { method: "POST", body: { firstName: "Ife", lastName: "Ade", gender: "FEMALE", dateOfBirth: "2014-04-04", guardianName: "Tola Ade", guardianRelationship: "Father", guardianPhone: "08031112222" } });
    expect(apply.status, JSON.stringify(apply.json)).toBe(200);
    const { applicationNumber, accessCode } = apply.json.data;
    const upload = (kind: string, data: Buffer, name: string, mime: string) => {
      const form = new FormData();
      form.set("applicationNumber", applicationNumber); form.set("accessCode", accessCode); form.set("kind", kind);
      form.set("file", new File([new Uint8Array(data)], name, { type: mime }));
      return call("/public/admissions/documents", { method: "POST", form });
    };
    const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 1)]);
    expect((await upload("BIRTH_CERTIFICATE", pdf, "birth.pdf", "application/pdf")).status).toBe(200);
    expect((await upload("BIRTH_CERTIFICATE", Buffer.from("MZ" + "x".repeat(100)), "birth.pdf", "application/pdf")).status).toBe(415);
    expect((await upload("PASSPORT_PHOTO", Buffer.alloc(6 * 1024 * 1024, 1), "p.png", "image/png")).status).toBe(413); // oversize is refused before anything is stored
    expect((await upload("PASSPORT_PHOTO", pdf, "photo.pdf", "application/pdf")).status).toBe(415); // a photo must be an image
    const wrong = await call("/public/admissions/status", { method: "POST", body: { applicationNumber, accessCode: "WRONG123" } });
    expect(wrong.status).toBe(404);
    const st = await call("/public/admissions/status", { method: "POST", body: { applicationNumber, accessCode } });
    expect(st.json.data.status).toBe("SUBMITTED");
    // staff file access
    await makeUser({ username: "reg", roles: ["registrar"] });
    await makeUser({ username: "teach2", roles: ["teacher"] });
    const reg = await loginCookie("reg", "Passw0rd-test");
    const rec = (await call("/admissions", { cookie: reg })).json.data.items[0];
    const full = await call(`/admissions/${rec.id}`, { cookie: reg });
    const fileId = full.json.data.documents[0].fileId;
    expect((await call(`/files/${fileId}`, { cookie: reg })).status).toBe(200);
    expect((await call(`/files/${fileId}`, { cookie: await loginCookie("teach2", "Passw0rd-test") })).status).toBe(404);
    expect(JSON.stringify(full.json)).not.toContain("accessCodeHash");
  });

  it("attendance devices authenticate by API key (no cookie), and bad keys get 401", async () => {
    await seedAcademics();
    const o = await loginCookie("owner", ADMIN.password);
    const dev = await call("/attendance/devices", { method: "POST", cookie: o, body: { name: "Gate", kind: "QR_SCANNER" }, headers: { origin: "http://school.local" } });
    expect(dev.status).toBe(200);
    const key = dev.json.data.apiKey;
    expect((await call("/device/attendance/scan", { method: "POST", body: { scans: [{ token: "SS1.x.y", scannedAt: new Date().toISOString() }] } })).status).toBe(401);
    expect((await call("/device/attendance/scan", { method: "POST", headers: { "x-device-key": "ssd_bad" }, body: { scans: [] } })).status).toBe(401);
    const ok = await call("/device/attendance/scan", { method: "POST", headers: { "x-device-key": key }, body: { scans: [{ token: "SS1.not-valid.sig", scannedAt: new Date().toISOString() }] } });
    expect(ok.status).toBe(200);
    expect(ok.json.data.results[0].status).toBe("REJECTED");
  });
});

// A parent with one child (with a published result) and a stranger child.
async function seedAcademics2() {
  const S = await seedAcademics();
  const teacher = await people.createTeacher(S.admin, { firstName: "Tea", lastName: "Cher" });
  const cs = await academics.assignClassSubject(S.admin, { classId: S.jss1.id, subjectId: S.math.id, teacherId: teacher.teacher.id });
  const kid = (await people.createStudent(S.admin, { firstName: "Kid", lastName: "One", gender: "MALE", classId: S.jss1.id, guardians: [{ newParent: { firstName: "Par", lastName: "One", phone: "08021110000" }, relationship: "Mother" }] })).student;
  const stranger = (await people.createStudent(S.admin, { firstName: "Stranger", lastName: "Two", gender: "MALE", classId: S.jss1.id })).student;
  const sheet = await res.getScoreSheet(S.admin, cs.id, S.t1.id);
  const [c1, c2, ex] = sheet.components.map((c) => c.id) as [string, string, string];
  await res.saveScores(S.admin, { classSubjectId: cs.id, termId: S.t1.id, entries: [kid.id, stranger.id].flatMap((studentId) => [{ studentId, typeId: c1, score: 15 }, { studentId, typeId: c2, score: 15 }, { studentId, typeId: ex, score: 40 }]) });
  await res.processResults(S.admin, { termId: S.t1.id, classId: S.jss1.id, allowIncomplete: true });
  await res.publishResults(S.admin, { termId: S.t1.id, classId: S.jss1.id });
  const parentUser = await db.user.findFirstOrThrow({ where: { userType: "PARENT" } });
  await db.user.update({ where: { id: parentUser.id }, data: { passwordHash: await hashPassword("Parent-pass-1"), mustChangePassword: false } });
  return { kid, stranger, termId: S.t1.id, parentUser: parentUser.username };
}
