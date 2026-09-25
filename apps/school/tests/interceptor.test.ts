import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/platform/db";
import { secure } from "@/platform/security/interceptor";
import { invalidateLicenseCache } from "@/platform/license";
import { installTestSchool, makeUser, req, resetDb, sessionFor } from "./helpers";

const ok = async () => ({ hello: "world" });
const body = async (r: Response) => (await r.json()) as { data?: unknown; error?: { code: string } };

beforeEach(async () => {
  await resetDb();
  await installTestSchool();
});

describe("central security interceptor", () => {
  it("401 without a session", async () => {
    const h = secure({ permission: "students.view" }, ok);
    const r = await h(req("/x"));
    expect(r.status).toBe(401);
    expect((await body(r)).error?.code).toBe("UNAUTHENTICATED");
  });

  it("403 when the role lacks the permission; audited", async () => {
    await makeUser({ username: "parent1", type: "PARENT", roles: ["parent"] });
    const cookie = await sessionFor("parent1");
    const r = await secure({ permission: "students.create" }, ok)(req("/x", { cookie }));
    expect(r.status).toBe(403);
    expect(await db.auditLog.count({ where: { action: "security.denied" } })).toBe(1);
  });

  it("allows when the role has the permission", async () => {
    await makeUser({ username: "reg", roles: ["registrar"] });
    const cookie = await sessionFor("reg");
    const r = await secure({ permission: "students.create" }, ok)(req("/x", { cookie }));
    expect(r.status).toBe(200);
    expect((await body(r)).data).toEqual({ hello: "world" });
  });

  it("any-of permissions", async () => {
    await makeUser({ username: "bur", roles: ["bursar"] });
    const cookie = await sessionFor("bur");
    const r = await secure({ permission: ["students.create", "finance.create_payment"] }, ok)(req("/x", { cookie }));
    expect(r.status).toBe(200);
  });

  it("primary admin passes even if every role permission is stripped (privilege-loss safeguard)", async () => {
    const admin = await db.user.findFirstOrThrow({ where: { isPrimaryAdmin: true } });
    await db.userRole.deleteMany({ where: { userId: admin.id } });
    const cookie = await sessionFor("owner", "Owner-pass-123");
    const r = await secure({ permission: "finance.reverse_payment" }, ok)(req("/x", { cookie }));
    expect(r.status).toBe(200);
  });

  it("blocks a disabled module server-side", async () => {
    await db.moduleSetting.create({ data: { moduleKey: "finance", enabled: false } });
    const cookie = await sessionFor("owner", "Owner-pass-123");
    const r = await secure({ module: "finance", permission: "finance.view" }, ok)(req("/x", { cookie }));
    expect(r.status).toBe(403);
    expect((await body(r)).error?.code).toBe("MODULE_DISABLED");
  });

  it("blocks a disabled feature flag", async () => {
    const cookie = await sessionFor("owner", "Owner-pass-123");
    const r = await secure({ feature: "communication.sms" }, ok)(req("/x", { cookie }));
    expect((await body(r)).error?.code).toBe("FEATURE_DISABLED");
  });

  it("read-only license mode refuses writes but allows reads", async () => {
    const inst = await db.schoolInstallation.findFirstOrThrow();
    await db.schoolInstallation.update({ where: { id: inst.id }, data: { createdAt: new Date(Date.now() - 90 * 86_400_000) } });
    invalidateLicenseCache();
    const cookie = await sessionFor("owner", "Owner-pass-123");
    const write = await secure({}, ok)(req("/x", { cookie, method: "POST", body: {} }));
    expect(write.status).toBe(402);
    const read = await secure({}, ok)(req("/x", { cookie }));
    expect(read.status).toBe(200);
    const exempt = await secure({ licenseExempt: true }, ok)(req("/x", { cookie, method: "POST", body: {} }));
    expect(exempt.status).toBe(200);
  });

  it("blocks cross-origin mutations (CSRF)", async () => {
    const cookie = await sessionFor("owner", "Owner-pass-123");
    const bad = await secure({}, ok)(req("/x", { cookie, method: "POST", body: {}, headers: { origin: "http://evil.example" } }));
    expect(bad.status).toBe(403);
    const good = await secure({}, ok)(req("/x", { cookie, method: "POST", body: {}, headers: { origin: "http://school.local" } }));
    expect(good.status).toBe(200);
  });

  it("forces a password change before anything else", async () => {
    await makeUser({ username: "newbie", roles: ["teacher"], mustChange: true });
    const cookie = await sessionFor("newbie");
    const r = await secure({ permission: "students.view" }, ok)(req("/x", { cookie }));
    expect((await body(r)).error?.code).toBe("PASSWORD_CHANGE_REQUIRED");
    const allowed = await secure({ allowPasswordChangePending: true }, ok)(req("/x", { cookie }));
    expect(allowed.status).toBe(200);
  });

  it("never leaks internal errors", async () => {
    const cookie = await sessionFor("owner", "Owner-pass-123");
    const r = await secure({}, async () => {
      throw new Error("relation \"secret_table\" does not exist");
    })(req("/x", { cookie }));
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toMatch(/secret_table/);
  });

  it("runs business policies after RBAC", async () => {
    const cookie = await sessionFor("owner", "Owner-pass-123");
    const r = await secure({ policies: [async () => { throw new (await import("@/platform/errors")).AppError("FINANCIAL_LOCKOUT", "locked", 403); }] }, ok)(req("/x", { cookie }));
    expect((await body(r)).error?.code).toBe("FINANCIAL_LOCKOUT");
  });
});
