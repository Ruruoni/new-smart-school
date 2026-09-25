import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/platform/db";
import { login, logout, validateSession, changeOwnPassword, SESSION_COOKIE } from "@/platform/auth/service";
import { AppError } from "@/platform/errors";
import { ADMIN, installTestSchool, makeUser, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
  await installTestSchool();
});

describe("login", () => {
  it("issues an opaque session and never stores the raw token", async () => {
    const r = await login({ username: "Owner", password: ADMIN.password });
    const s = await db.session.findFirstOrThrow();
    expect(s.tokenHash).not.toBe(r.token);
    expect(s.tokenHash).toHaveLength(64);
    expect((await validateSession(r.token))?.user.username).toBe("owner");
  });
  it("gives the same error for unknown user and wrong password", async () => {
    const a = await login({ username: "nobody", password: "whatever1" }).catch((e) => e);
    const b = await login({ username: "owner", password: "wrong-pass-1" }).catch((e) => e);
    expect(a).toBeInstanceOf(AppError);
    expect(a.message).toBe(b.message);
    expect(a.status).toBe(401);
  });
  it("locks the account after 5 failures, even for the right password", async () => {
    for (let i = 0; i < 5; i++) await login({ username: "owner", password: "bad-pass-123" }).catch(() => undefined);
    const err = await login({ username: "owner", password: ADMIN.password }).catch((e) => e);
    expect(err.code).toBe("RATE_LIMITED");
    expect(await db.auditLog.count({ where: { action: "auth.account_locked" } })).toBe(1);
  });
  it("refuses disabled accounts", async () => {
    const u = await makeUser({ username: "gone" });
    await db.user.update({ where: { id: u.id }, data: { status: "SUSPENDED" } });
    const err = await login({ username: "gone", password: "Passw0rd-test" }).catch((e) => e);
    expect(err.code).toBe("ACCOUNT_DISABLED");
  });
});

describe("sessions", () => {
  it("logout revokes the session", async () => {
    const r = await login({ username: "owner", password: ADMIN.password });
    await logout(r.token);
    expect(await validateSession(r.token)).toBeNull();
  });
  it("rejects expired and disabled-user sessions", async () => {
    const u = await makeUser({ username: "temp" });
    const r = await login({ username: "temp", password: "Passw0rd-test" });
    await db.user.update({ where: { id: u.id }, data: { status: "DISABLED" } });
    expect(await validateSession(r.token)).toBeNull();
    await db.user.update({ where: { id: u.id }, data: { status: "ACTIVE" } });
    await db.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await validateSession(r.token)).toBeNull();
  });
  it("password change revokes existing sessions and enforces policy", async () => {
    const u = await makeUser({ username: "changer" });
    const r = await login({ username: "changer", password: "Passw0rd-test" });
    await expect(changeOwnPassword(u.id, "Passw0rd-test", "short", null)).rejects.toThrow();
    await changeOwnPassword(u.id, "Passw0rd-test", "Brand-new-pass9", null);
    expect(await validateSession(r.token)).toBeNull();
    await expect(login({ username: "changer", password: "Brand-new-pass9" })).resolves.toBeTruthy();
  });
  it("cookie name is stable", () => expect(SESSION_COOKIE).toBe("ss_session"));
});
