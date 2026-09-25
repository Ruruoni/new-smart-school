import { mkdir, writeFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@cloud/server/db";
import { handleOps } from "@cloud/server/ops";
import { createOperator } from "@cloud/server/operators";
import * as inst from "@cloud/server/installations";
import { verifyOwnToken } from "@cloud/server/signing";

async function reset() {
  const rows = await db.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await db.$executeRawUnsafe(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
}
const HOST = "tower.example.ng";
type Sess = { cookie: string };
const PASS = "correct-horse-battery";

async function call(path: string, method = "GET", data?: unknown, sess?: Sess, headers: Record<string, string> = {}) {
  const url = `https://${HOST}/api/ops/${path}`;
  const req = new Request(url, { method, headers: { host: HOST, ...(data !== undefined ? { "content-type": "application/json" } : {}), ...(sess ? { cookie: sess.cookie } : {}), ...(method !== "GET" ? { origin: `https://${HOST}` } : {}), ...headers }, body: data !== undefined ? JSON.stringify(data) : undefined });
  const res = await handleOps(req, path.split("?")[0]!.split("/").filter(Boolean));
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json, res };
}
async function signIn(email: string): Promise<Sess> {
  const r = await call("login", "POST", { email, password: PASS });
  expect(r.status).toBe(200);
  const set = r.res.headers.get("set-cookie")!;
  return { cookie: set.split(";")[0]! };
}
let viewer: Sess, support: Sess, admin: Sess;

beforeEach(async () => {
  await reset();
  await createOperator({ email: "root@x.ng", name: "Root", password: PASS, role: "SUPER_ADMIN" });
  await createOperator({ email: "sup@x.ng", name: "Support", password: PASS, role: "SUPPORT" });
  await createOperator({ email: "view@x.ng", name: "Viewer", password: PASS, role: "VIEWER" });
  admin = await signIn("root@x.ng"); support = await signIn("sup@x.ng"); viewer = await signIn("view@x.ng");
});

describe("sign-in and session", () => {
  it("sets an HttpOnly, SameSite=Strict cookie and never echoes the password hash", async () => {
    const r = await call("login", "POST", { email: "ROOT@x.ng", password: PASS });
    const c = r.res.headers.get("set-cookie")!;
    expect(c).toMatch(/HttpOnly/); expect(c).toMatch(/SameSite=Strict/); expect(c).toMatch(/Path=\//);
    expect(JSON.stringify(r.body)).not.toMatch(/argon2|passwordHash/);
    expect((await call("me", "GET", undefined, admin)).body.data).toMatchObject({ email: "root@x.ng", role: "SUPER_ADMIN" });
  });
  it("rejects wrong passwords with one generic message and locks after repeated failures", async () => {
    for (let i = 0; i < 5; i++) { const r = await call("login", "POST", { email: "sup@x.ng", password: "nope" }); expect(r.status).toBe(401); expect(r.body.error.message).toBe("Incorrect email or password"); }
    expect((await call("login", "POST", { email: "sup@x.ng", password: PASS })).status).toBe(429);
    expect((await call("login", "POST", { email: "ghost@x.ng", password: "x" })).body.error.message).toBe("Incorrect email or password");
  });
  it("refuses cross-origin sign-in and cross-origin changes", async () => {
    expect((await call("login", "POST", { email: "root@x.ng", password: PASS }, undefined, { origin: "https://evil.example" })).status).toBe(403);
    expect((await call("installations", "POST", { schoolName: "X School" }, admin, { origin: "https://evil.example" })).status).toBe(403);
  });
  it("everything requires a session; logging out revokes it", async () => {
    for (const p of ["me", "overview", "installations", "alerts", "conflicts", "flags", "releases", "audit", "operators"]) expect((await call(p)).status, p).toBe(401);
    expect((await call("logout", "POST", {}, admin)).status).toBe(200);
    expect((await call("me", "GET", undefined, admin)).status).toBe(401);
  });
});

describe("configuration and infrastructure failures", () => {
  it("the operator cookie is Secure only when the sign-in came over HTTPS (works on plain-HTTP localhost, strict behind TLS)", async () => {
    const http = await handleOps(new Request("http://tower.local/api/ops/login", { method: "POST", headers: { host: "tower.local", "content-type": "application/json" }, body: JSON.stringify({ email: "root@x.ng", password: PASS }) }), ["login"]);
    expect(http.headers.get("set-cookie")).not.toMatch(/;\s*Secure/i);
    const tls = await handleOps(new Request("http://tower.local/api/ops/login", { method: "POST", headers: { host: "tower.local", "content-type": "application/json", "x-forwarded-proto": "https" }, body: JSON.stringify({ email: "root@x.ng", password: PASS }) }), ["login"]);
    expect(tls.headers.get("set-cookie")).toMatch(/;\s*Secure/i);
    expect(tls.headers.get("set-cookie")).toMatch(/SameSite=Strict/);
  });

  it("a misconfigured tower answers with a structured 503 (no variable names to the visitor, a reference id), and infra errors are named", async () => {
    const { errorResponse, CloudConfigError } = await import("@cloud/server/errors");
    const cfg = errorResponse(new CloudConfigError(["CLOUD_ENCRYPTION_KEY: is not set"]));
    expect(cfg.status).toBe(503);
    const body = await cfg.json();
    expect(body.error).toMatchObject({ code: "SERVER_MISCONFIGURED", requestId: expect.any(String) });
    expect(JSON.stringify(body)).not.toContain("CLOUD_ENCRYPTION_KEY");
    const down = await errorResponse(Object.assign(new Error("Can't reach database server"), { code: "P1001" })).json();
    expect(down.error.code).toBe("DATABASE_UNAVAILABLE");
    const missing = await errorResponse(Object.assign(new Error("The table `public.operators` does not exist"), { code: "P2021" })).json();
    expect(missing.error.code).toBe("DATABASE_NOT_MIGRATED");
  });

  it("the health report is honest: ok only when config, database and schema are fine", async () => {
    const { runHealthChecks } = await import("@cloud/server/health");
    expect(await runHealthChecks("t")).toMatchObject({ ok: true, status: 200, body: { checks: { config: "ok", database: "ok", schema: "ok" } } });
    const { resetEnvCache } = await import("@cloud/server/env");
    const saved = process.env.CLOUD_ENCRYPTION_KEY; delete process.env.CLOUD_ENCRYPTION_KEY; resetEnvCache();
    try {
      const r = await runHealthChecks("t");
      expect(r).toMatchObject({ ok: false, status: 503, body: { code: "SERVER_MISCONFIGURED", checks: { config: "fail", database: "skipped" } } });
      expect(JSON.stringify(r.body)).not.toContain("CLOUD_ENCRYPTION_KEY");
    } finally { process.env.CLOUD_ENCRYPTION_KEY = saved; resetEnvCache(); }
  });
});

describe("roles", () => {
  it("viewers read, support operates, only super admins change licences, suspend or manage operators", async () => {
    expect((await call("installations", "GET", undefined, viewer)).status).toBe(200);
    expect((await call("installations", "POST", { schoolName: "Nope School" }, viewer)).status).toBe(403);
    const made = await call("installations", "POST", { schoolName: "Role School" }, support);
    expect(made.status).toBe(201);
    const id = made.body.data.installation.id;
    expect((await call(`installations/${id}/commands`, "POST", { cmd: "REQUEST_BACKUP" }, support)).status).toBe(200);
    for (const [p, m, d] of [[`installations/${id}/suspend`, "POST", { reason: "unpaid fees" }], [`installations/${id}/resume`, "POST", {}], [`installations/${id}/license`, "PUT", { plan: "premium" }], [`installations/${id}/decommission`, "POST", { reason: "closing" }], ["flags", "PUT", { key: "sms.enabled", enabled: true }], ["releases", "POST", { version: "2.1.0" }], ["operators", "GET", undefined]] as const)
      expect((await call(p, m, d, support)).status, p).toBe(403);
    expect((await call("operators", "GET", undefined, viewer)).status).toBe(403);
    expect((await call("operators", "GET", undefined, admin)).status).toBe(200);
  });
});

describe("installation lifecycle from the Control Tower", () => {
  it("create → register → licence → flags → suspend → resume, with secrets never exposed and every action audited", async () => {
    const made = await call("installations", "POST", { schoolName: "Lifecycle College", state: "Enugu", modules: ["students", "finance"] }, support);
    const { installation, registrationToken } = made.body.data;
    expect(registrationToken).toMatch(/^SSR-SS-/);
    expect(JSON.stringify(made.body)).not.toContain("secretEnc");
    const id = installation.id;
    await inst.registerInstallation({ registrationToken, schoolName: "Lifecycle College", appVersion: "2.0.0", schemaVersion: "1" }, "9.9.9.9");

    const detail = (await call(`installations/${id}`, "GET", undefined, viewer)).body.data;
    expect(detail.installation).toMatchObject({ status: "ACTIVE", code: installation.code });
    expect(JSON.stringify(detail)).not.toMatch(/secretEnc|tokenHash/);
    expect(detail.moduleCatalogue).toContain("cbt");

    // per-school feature override, then clear it
    expect((await call(`installations/${id}/flags`, "PUT", { key: "communication.sms", enabled: true }, support)).status).toBe(200);
    expect((await call(`installations/${id}`, "GET", undefined, viewer)).body.data.flags).toContainEqual({ key: "communication.sms", enabled: true });
    expect((await call(`installations/${id}/flags`, "PUT", { key: "Bad Key!", enabled: true }, support)).status).toBe(400);
    await call(`installations/${id}/flags`, "PUT", { key: "communication.sms", enabled: null }, support);

    // licence changes are signed into the token the school will receive
    expect((await call(`installations/${id}/license`, "PUT", { plan: "premium", modules: ["students", "finance", "cbt"], expiresAt: "2030-01-01T00:00:00.000Z", graceDays: 14 }, admin)).status).toBe(200);
    let claims = await verifyOwnToken((await inst.licenseTokenFor(await db.installation.findUniqueOrThrow({ where: { id } })))!);
    expect(claims).toMatchObject({ plan: "premium", graceDays: 14, status: "ACTIVE" });
    expect(claims.modules).toEqual(["students", "finance", "cbt"]);
    expect((await call(`installations/${id}/license`, "PUT", { modules: ["not_a_module"] }, admin)).status).toBe(400);

    // suspension needs a real reason, then travels in the licence; resuming reverses it
    expect((await call(`installations/${id}/suspend`, "POST", { reason: "no" }, admin)).status).toBe(400);
    expect((await call(`installations/${id}/suspend`, "POST", { reason: "Fees unpaid for two terms" }, admin)).status).toBe(200);
    expect((await call(`installations/${id}/suspend`, "POST", { reason: "Fees unpaid for two terms" }, admin)).status).toBe(409);
    claims = await verifyOwnToken((await inst.licenseTokenFor(await db.installation.findUniqueOrThrow({ where: { id } })))!);
    expect(claims.status).toBe("SUSPENDED");
    expect((await call(`installations/${id}/resume`, "POST", {}, admin)).status).toBe(200);
    claims = await verifyOwnToken((await inst.licenseTokenFor(await db.installation.findUniqueOrThrow({ where: { id } })))!);
    expect(claims.status).toBe("ACTIVE");

    // the operator's actions are on the record with who did them
    const audit = (await call(`audit?installationId=${id}`, "GET", undefined, viewer)).body.data as { action: string; operatorEmail: string | null }[];
    const acts = audit.map((a) => a.action);
    for (const a of ["installation.create", "feature.override", "license.update", "installation.suspend", "installation.resume"]) expect(acts, a).toContain(a);
    expect(audit.find((a) => a.action === "installation.suspend")!.operatorEmail).toBe("root@x.ng");
  });

  it("commands: a message needs text; the command is stored for delivery on the next heartbeat", async () => {
    const { installation, registrationToken } = (await call("installations", "POST", { schoolName: "Command School" }, support)).body.data;
    await inst.registerInstallation({ registrationToken, schoolName: "Command School", appVersion: "2.0.0", schemaVersion: "1" }, null);
    expect((await call(`installations/${installation.id}/commands`, "POST", { cmd: "MESSAGE" }, support)).status).toBe(400);
    expect((await call(`installations/${installation.id}/commands`, "POST", { cmd: "MESSAGE", text: "Please update to 2.1 this weekend." }, support)).status).toBe(200);
    expect((await call(`installations/${installation.id}/commands`, "POST", { cmd: "FORMAT_DISK" }, support)).status).toBe(400);
    const stored = await db.command.findMany({ where: { installationId: installation.id } });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ type: "MESSAGE", args: { text: "Please update to 2.1 this weekend." }, deliveredAt: null });
  });

  it("a decommissioned installation stops being able to authenticate", async () => {
    const { installation, registrationToken } = (await call("installations", "POST", { schoolName: "Closing School" }, support)).body.data;
    await inst.registerInstallation({ registrationToken, schoolName: "Closing School", appVersion: "2.0.0", schemaVersion: "1" }, null);
    expect((await call(`installations/${installation.id}/decommission`, "POST", { reason: "School closed" }, admin)).status).toBe(200);
    const row = await db.installation.findUniqueOrThrow({ where: { id: installation.id } });
    expect(row).toMatchObject({ status: "DECOMMISSIONED", secretEnc: null });
    expect((await call(`installations/${installation.id}/token`, "POST", {}, support)).status).toBe(409);
  });

  it("malformed ids and bodies are client errors, never 500s", async () => {
    expect((await call("installations/not-a-uuid", "GET", undefined, viewer)).status).toBe(400);
    expect((await call("installations", "POST", { schoolName: "" }, support)).status).toBe(400);
    expect((await call("installations/00000000-0000-4000-8000-000000000000", "GET", undefined, viewer)).status).toBe(404);
    expect((await call("nothing/here", "GET", undefined, viewer)).status).toBe(404);
  });
});

describe("alerts, conflicts, flags, releases, operators, backups", () => {
  it("lists open alerts worst-first and lets support acknowledge them (audited)", async () => {
    const { installation } = (await call("installations", "POST", { schoolName: "Alert School" }, support)).body.data;
    await db.alert.createMany({ data: [{ installationId: installation.id, kind: "SYNC_BACKLOG", severity: "WARNING", message: "backlog" }, { installationId: installation.id, kind: "OFFLINE", severity: "CRITICAL", message: "gone" }] });
    const list = (await call("alerts", "GET", undefined, viewer)).body.data;
    expect(list.map((a: { kind: string }) => a.kind)).toEqual(["OFFLINE", "SYNC_BACKLOG"]);
    expect((await call(`alerts/${list[0].id}/ack`, "POST", {}, viewer)).status).toBe(403);
    expect((await call(`alerts/${list[0].id}/ack`, "POST", {}, support)).status).toBe(200);
    expect((await db.alert.findUniqueOrThrow({ where: { id: list[0].id } })).acknowledgedAt).not.toBeNull();
    expect(await db.cloudAudit.count({ where: { action: "alert.acknowledge" } })).toBe(1);
  });
  it("global flags and releases are super-admin only; duplicate versions are refused", async () => {
    expect((await call("flags", "PUT", { key: "communication.sms", enabled: true, description: "SMS gateway" }, admin)).status).toBe(200);
    expect((await call("flags", "GET", undefined, viewer)).body.data).toHaveLength(1);
    expect((await call("releases", "POST", { version: "2.1.0", notes: "Fixes", mandatory: true }, admin)).status).toBe(201);
    expect((await call("releases", "POST", { version: "2.1.0" }, admin)).status).toBe(409);
    expect((await call("releases", "POST", { version: "v2" }, admin)).status).toBe(400);
    expect((await call("overview", "GET", undefined, viewer)).body.data.latestVersion).toBe("2.1.0");
  });
  it("operators: weak passwords refused, cannot disable yourself or the last super admin, disabling revokes live sessions", async () => {
    expect((await call("operators", "POST", { email: "n@x.ng", name: "New", password: "short", role: "VIEWER" }, admin)).status).toBe(400);
    const made = await call("operators", "POST", { email: "new@x.ng", name: "New Person", password: PASS, role: "SUPPORT" }, admin);
    expect(made.status).toBe(201); expect(JSON.stringify(made.body)).not.toMatch(/passwordHash|argon2/);
    const root = await db.operator.findUniqueOrThrow({ where: { email: "root@x.ng" } });
    expect((await call(`operators/${root.id}/active`, "POST", { active: false }, admin)).status).toBe(409);
    const sup = await db.operator.findUniqueOrThrow({ where: { email: "sup@x.ng" } });
    expect((await call("me", "GET", undefined, support)).status).toBe(200);
    expect((await call(`operators/${sup.id}/active`, "POST", { active: false }, admin)).status).toBe(200);
    expect((await call("me", "GET", undefined, support)).status).toBe(401);
    expect((await call("login", "POST", { email: "sup@x.ng", password: PASS })).status).toBe(401);
  });
  it("only super admins can download an uploaded backup, and the download is audited", async () => {
    const { installation } = (await call("installations", "POST", { schoolName: "Backup School" }, support)).body.data;
    await mkdir("./.data/test-backups", { recursive: true });
    const path = "./.data/test-backups/ops-test.bin";
    await writeFile(path, Buffer.from("encrypted-bytes"));
    const b = await db.backupUpload.create({ data: { installationId: installation.id, fileName: "ops-test.bin", sizeBytes: 15n, sha256: "a".repeat(64), storagePath: path } });
    expect((await call(`backups/${b.id}/download`, "GET", undefined, support)).status).toBe(403);
    const r = await call(`backups/${b.id}/download`, "GET", undefined, admin);
    expect(r.res.headers.get("content-disposition")).toContain("ops-test.bin");
    expect(await db.cloudAudit.count({ where: { action: "backup.download" } })).toBe(1);
  });
});
