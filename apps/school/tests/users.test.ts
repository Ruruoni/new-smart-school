import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/platform/db";
import { authorize } from "@/platform/security/interceptor";
import * as users from "@/modules/users/service";
import { installTestSchool, makeUser, req, resetDb, sessionFor, ADMIN } from "./helpers";

async function ctxFor(username: string, password?: string) {
  const cookie = await sessionFor(username, password);
  return authorize({}, req("/x", { cookie }));
}

beforeEach(async () => {
  await resetDb();
  await installTestSchool();
});

const base = { password: "Temp-pass-123", firstName: "T", lastName: "User", userType: "TEACHER" as const, mustChangePassword: true };

describe("user administration", () => {
  it("creates users with roles and audits it", async () => {
    const admin = await ctxFor("owner", ADMIN.password);
    const u = await users.createUser(admin, { ...base, username: "mr.bello", roleKeys: ["teacher"] });
    expect(u.mustChangePassword).toBe(true);
    const roles = await db.userRole.findMany({ where: { userId: u.id }, include: { role: true } });
    expect(roles.map((r) => r.role.key)).toEqual(["teacher"]);
    expect(await db.auditLog.count({ where: { action: "user.create" } })).toBe(1);
  });

  it("rejects duplicate usernames and weak passwords", async () => {
    const admin = await ctxFor("owner", ADMIN.password);
    await users.createUser(admin, { ...base, username: "dup" });
    await expect(users.createUser(admin, { ...base, username: "dup" })).rejects.toThrow(/already taken/);
    await expect(users.createUser(admin, { ...base, username: "weak", password: "abc" })).rejects.toThrow();
  });

  it("prevents privilege escalation: a registrar cannot mint a bursar or admin-like role", async () => {
    await makeUser({ username: "admin2", roles: ["registrar", "principal"] }); // has users.create? no
    // give a delegated user-manager a limited role
    const mgr = await users.createRole(await ctxFor("owner", ADMIN.password), { key: "user_manager", name: "User manager", permissions: ["users.view", "users.create", "users.edit", "roles.view", "students.view"] });
    await makeUser({ username: "hr", roles: ["user_manager"] });
    const hr = await ctxFor("hr");
    // bursar carries finance.* permissions hr does not hold
    await expect(users.createUser(hr, { ...base, username: "sneaky", roleKeys: ["bursar"] })).rejects.toThrow(/cannot grant/);
    // a role within its own permissions is fine
    await expect(users.createUser(hr, { ...base, username: "okuser", roleKeys: ["user_manager"] })).resolves.toBeTruthy();
    // the protected role can never be handed out
    await expect(users.createUser(await ctxFor("owner", ADMIN.password), { ...base, username: "wannabe", roleKeys: ["primary_admin"] })).rejects.toThrow(/Primary Admin role/);
    expect(mgr.key).toBe("user_manager");
  });

  it("protects the Primary Admin from disable / role removal / foreign password reset", async () => {
    const admin = await ctxFor("owner", ADMIN.password);
    await makeUser({ username: "deputy", roles: ["principal"] });
    const owner = await db.user.findFirstOrThrow({ where: { isPrimaryAdmin: true } });
    await expect(users.setUserStatus(admin, owner.id, "DISABLED")).rejects.toThrow(/cannot be disabled/);
    const roles = await users.setUserRoles(admin, owner.id, []);
    expect(roles).toContain("primary_admin");
    const deputy = await ctxFor("deputy");
    await expect(users.resetUserPassword({ ...deputy, can: () => true, require: () => undefined }, owner.id, "Whatever-123")).rejects.toThrow(/Only the Primary Admin/);
  });

  it("optimistic concurrency: stale user edits are refused", async () => {
    const admin = await ctxFor("owner", ADMIN.password);
    const u = await users.createUser(admin, { ...base, username: "edit.me" });
    await users.updateUser(admin, u.id, { version: u.version, firstName: "First" });
    await expect(users.updateUser(admin, u.id, { version: u.version, firstName: "Second" })).rejects.toMatchObject({ code: "STALE_WRITE" });
  });

  it("disabling a user revokes their sessions", async () => {
    const admin = await ctxFor("owner", ADMIN.password);
    const u = await makeUser({ username: "victim", roles: ["teacher"] });
    const cookie = await sessionFor("victim");
    await users.setUserStatus(admin, u.id, "SUSPENDED");
    await expect(authorize({}, req("/x", { cookie }))).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("ownership transfer requires the password and moves the protection", async () => {
    const admin = await ctxFor("owner", ADMIN.password);
    const heir = await makeUser({ username: "heir", roles: ["principal"] });
    await expect(users.transferPrimaryAdmin(admin, heir.id, "wrong-password")).rejects.toThrow(/Password confirmation/);
    await users.transferPrimaryAdmin(admin, heir.id, ADMIN.password);
    expect((await db.user.findUniqueOrThrow({ where: { id: heir.id } })).isPrimaryAdmin).toBe(true);
    expect(await db.user.count({ where: { isPrimaryAdmin: true } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: "primary_admin.transferred" } })).toBe(1);
  });
});

describe("roles", () => {
  it("system and protected roles cannot be deleted or edited", async () => {
    const admin = await ctxFor("owner", ADMIN.password);
    const owner = await db.role.findUniqueOrThrow({ where: { key: "primary_admin" } });
    const teacher = await db.role.findUniqueOrThrow({ where: { key: "teacher" } });
    await expect(users.setRolePermissions(admin, owner.id, ["students.view"])).rejects.toThrow(/cannot be edited/);
    await expect(users.deleteRole(admin, teacher.id)).rejects.toThrow(/cannot be deleted/);
  });
  it("custom role lifecycle", async () => {
    const admin = await ctxFor("owner", ADMIN.password);
    const role = await users.createRole(admin, { key: "librarian", name: "Librarian", permissions: ["students.view"] });
    await users.setRolePermissions(admin, role.id, ["students.view", "announcements.view"]);
    expect((await users.listRoles()).find((r) => r.key === "librarian")?.permissions).toEqual(["announcements.view", "students.view"]);
    await users.deleteRole(admin, role.id);
    expect(await db.role.count({ where: { key: "librarian" } })).toBe(0);
  });
  it("cannot grant unknown permissions", async () => {
    const admin = await ctxFor("owner", ADMIN.password);
    await expect(users.createRole(admin, { key: "bad", name: "Bad", permissions: ["nope.nope"] })).rejects.toThrow(/Unknown permission/);
  });
});
