import { z } from "zod";
import { db, transact, type Tx } from "@/platform/db";
import type { SecurityContext } from "@/platform/security/context";
import { auditIn } from "@/platform/security/interceptor";
import { hashPassword, assertPasswordPolicy, verifyPassword } from "@/platform/password";
import { revokeAllSessions } from "@/platform/auth/service";
import { conflict, forbidden, notFound, validation } from "@/platform/errors";
import { assertUpdated, asPage, ilike, skipTake, type PageQuery } from "@/platform/util";
import { PERMISSIONS } from "@/platform/rbac/catalog";

const username = z.string().trim().toLowerCase().min(3).max(40).regex(/^[a-z0-9._-]+$/, "Letters, numbers, dot, dash, underscore only");

export const CreateUserInput = z.object({
  username,
  password: z.string(),
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().min(1).max(60),
  email: z.string().email().optional(),
  phone: z.string().trim().max(30).optional(),
  userType: z.enum(["ADMIN", "TEACHER", "STAFF", "PARENT", "STUDENT"]),
  roleKeys: z.array(z.string()).default([]),
  mustChangePassword: z.boolean().default(true),
});
export type CreateUserInput = z.infer<typeof CreateUserInput>;

export const UpdateUserInput = z.object({
  version: z.number().int(),
  firstName: z.string().trim().min(1).max(60).optional(),
  lastName: z.string().trim().min(1).max(60).optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
});

const publicUser = { id: true, username: true, email: true, phone: true, firstName: true, lastName: true, userType: true, status: true, isPrimaryAdmin: true, mustChangePassword: true, lastLoginAt: true, version: true, createdAt: true } as const;

/**
 * Privilege-escalation guard: you may only grant roles whose permissions you hold yourself, and only the
 * Primary Admin may ever hand out the protected role (via an explicit ownership transfer, not here).
 */
export async function assertCanGrant(ctx: SecurityContext, tx: Tx, roleKeys: string[]) {
  if (!roleKeys.length) return;
  const roles = await tx.role.findMany({ where: { key: { in: roleKeys } }, include: { permissions: { include: { permission: true } } } });
  if (roles.length !== new Set(roleKeys).size) throw validation("Unknown role", { roleKeys });
  for (const role of roles) {
    if (role.isProtected) throw forbidden("The Primary Admin role cannot be assigned. Use ownership transfer.");
    if (ctx.user.isPrimaryAdmin) continue;
    const missing = role.permissions.map((rp) => rp.permission.key).filter((k) => !ctx.can(k));
    if (missing.length) throw forbidden(`You cannot grant the "${role.name}" role because it carries permissions you do not have`, { missing });
  }
}

export async function listUsers(q: PageQuery & { userType?: string; status?: string }) {
  const where = {
    deletedAt: null,
    ...(q.userType ? { userType: q.userType as never } : {}),
    ...(q.status ? { status: q.status as never } : {}),
    ...(q.q ? { OR: [{ username: ilike(q.q) }, { firstName: ilike(q.q) }, { lastName: ilike(q.q) }, { email: ilike(q.q) }] } : {}),
  };
  const [items, total] = await Promise.all([
    db.user.findMany({ where, select: { ...publicUser, roles: { select: { role: { select: { key: true, name: true } } } } }, orderBy: [{ lastName: "asc" }, { firstName: "asc" }], ...skipTake(q) }),
    db.user.count({ where }),
  ]);
  return asPage(items, total, q);
}

export async function createUser(ctx: SecurityContext, raw: z.input<typeof CreateUserInput>) {
  const input = CreateUserInput.parse(raw);
  assertPasswordPolicy(input.password);
  const passwordHash = await hashPassword(input.password);
  return transact(async (tx) => {
    if (await tx.user.findUnique({ where: { username: input.username } })) throw conflict("That username is already taken");
    if (input.email && (await tx.user.findUnique({ where: { email: input.email } }))) throw conflict("That email is already in use");
    await assertCanGrant(ctx, tx, input.roleKeys);
    const user = await tx.user.create({
      data: { username: input.username, passwordHash, firstName: input.firstName, lastName: input.lastName, email: input.email, phone: input.phone, userType: input.userType, mustChangePassword: input.mustChangePassword },
      select: publicUser,
    });
    if (input.roleKeys.length) {
      const roles = await tx.role.findMany({ where: { key: { in: input.roleKeys } }, select: { id: true } });
      await tx.userRole.createMany({ data: roles.map((r) => ({ userId: user.id, roleId: r.id })) });
    }
    await auditIn(tx, ctx, { action: "user.create", module: "platform", entityType: "User", entityId: user.id, after: { username: user.username, userType: user.userType, roles: input.roleKeys } });
    return user;
  });
}

export async function updateUser(ctx: SecurityContext, id: string, raw: z.infer<typeof UpdateUserInput>) {
  const { version, ...patch } = UpdateUserInput.parse(raw);
  return transact(async (tx) => {
    const before = await tx.user.findFirst({ where: { id, deletedAt: null }, select: publicUser });
    if (!before) throw notFound("User");
    const r = await tx.user.updateMany({ where: { id, version }, data: { ...patch, version: { increment: 1 } } });
    assertUpdated(r.count, "User", before.version);
    const after = await tx.user.findUniqueOrThrow({ where: { id }, select: publicUser });
    await auditIn(tx, ctx, { action: "user.update", module: "platform", entityType: "User", entityId: id, before, after });
    return after;
  });
}

export async function setUserStatus(ctx: SecurityContext, id: string, status: "ACTIVE" | "SUSPENDED" | "DISABLED") {
  return transact(async (tx) => {
    const u = await tx.user.findFirst({ where: { id, deletedAt: null } });
    if (!u) throw notFound("User");
    if (u.isPrimaryAdmin && status !== "ACTIVE") throw forbidden("The Primary Admin account cannot be disabled");
    if (u.id === ctx.user.id && status !== "ACTIVE") throw forbidden("You cannot disable your own account");
    await tx.user.update({ where: { id }, data: { status, version: { increment: 1 } } });
    if (status !== "ACTIVE") await revokeAllSessions(tx, id);
    await auditIn(tx, ctx, { action: status === "ACTIVE" ? "user.enable" : "user.disable", module: "platform", entityType: "User", entityId: id, before: { status: u.status }, after: { status } });
  });
}

export async function resetUserPassword(ctx: SecurityContext, id: string, newPassword: string) {
  assertPasswordPolicy(newPassword);
  const passwordHash = await hashPassword(newPassword);
  return transact(async (tx) => {
    const u = await tx.user.findFirst({ where: { id, deletedAt: null } });
    if (!u) throw notFound("User");
    // Only the Primary Admin may reset the Primary Admin's password (they use "change password" normally).
    if (u.isPrimaryAdmin && !ctx.user.isPrimaryAdmin) throw forbidden("Only the Primary Admin can reset this account");
    await tx.user.update({ where: { id }, data: { passwordHash, mustChangePassword: true, failedLoginCount: 0, lockedUntil: null, passwordChangedAt: new Date(), version: { increment: 1 } } });
    await revokeAllSessions(tx, id);
    await auditIn(tx, ctx, { action: "user.reset_password", module: "platform", entityType: "User", entityId: id });
  });
}

/** Replace a user's whole-school roles. The Primary Admin's role set can never shrink below "primary_admin". */
export async function setUserRoles(ctx: SecurityContext, id: string, roleKeys: string[]) {
  return transact(async (tx) => {
    const u = await tx.user.findFirst({ where: { id, deletedAt: null }, include: { roles: { include: { role: true } } } });
    if (!u) throw notFound("User");
    const current = u.roles.filter((r) => r.scopeType === "*").map((r) => r.role.key);
    const wanted = new Set(roleKeys);
    if (u.isPrimaryAdmin) wanted.add("primary_admin");
    else if (wanted.has("primary_admin")) throw forbidden("The Primary Admin role cannot be assigned. Use ownership transfer.");
    const added = [...wanted].filter((k) => !current.includes(k) && k !== "primary_admin");
    await assertCanGrant(ctx, tx, added);
    const removed = current.filter((k) => !wanted.has(k));
    if (removed.length) {
      const rr = await tx.role.findMany({ where: { key: { in: removed } }, select: { id: true } });
      await tx.userRole.deleteMany({ where: { userId: id, scopeType: "*", roleId: { in: rr.map((r) => r.id) } } });
    }
    if (added.length) {
      const ar = await tx.role.findMany({ where: { key: { in: added } }, select: { id: true } });
      await tx.userRole.createMany({ data: ar.map((r) => ({ userId: id, roleId: r.id })), skipDuplicates: true });
    }
    await tx.user.update({ where: { id }, data: { version: { increment: 1 } } });
    await auditIn(tx, ctx, { action: "user.roles_changed", module: "platform", entityType: "User", entityId: id, before: { roles: current }, after: { roles: [...wanted] } });
    return [...wanted];
  });
}

/** Deliberate hand-over of the protected owner account, re-authenticated by the current owner's password. */
export async function transferPrimaryAdmin(ctx: SecurityContext, toUserId: string, currentPassword: string) {
  if (!ctx.user.isPrimaryAdmin) throw forbidden("Only the Primary Admin can transfer ownership");
  const me = await db.user.findUniqueOrThrow({ where: { id: ctx.user.id } });
  if (!(await verifyPassword(me.passwordHash, currentPassword))) throw forbidden("Password confirmation failed");
  return transact(async (tx) => {
    const target = await tx.user.findFirst({ where: { id: toUserId, deletedAt: null, status: "ACTIVE" } });
    if (!target) throw notFound("Target user");
    if (target.id === me.id) throw validation("Choose a different user");
    await tx.$executeRaw`SELECT set_config('smartschool.allow_primary_admin_change', 'on', true)`;
    const ownerRole = await tx.role.findUniqueOrThrow({ where: { key: "primary_admin" } });
    await tx.user.update({ where: { id: me.id }, data: { isPrimaryAdmin: false, version: { increment: 1 } } });
    await tx.user.update({ where: { id: target.id }, data: { isPrimaryAdmin: true, userType: "ADMIN", version: { increment: 1 } } });
    await tx.userRole.deleteMany({ where: { userId: me.id, roleId: ownerRole.id } });
    await tx.userRole.createMany({ data: [{ userId: target.id, roleId: ownerRole.id }], skipDuplicates: true });
    await auditIn(tx, ctx, { action: "primary_admin.transferred", module: "platform", entityType: "User", entityId: target.id, before: { owner: me.id }, after: { owner: target.id } });
  });
}

// ───────────── Roles ─────────────

export async function listRoles() {
  const roles = await db.role.findMany({ include: { permissions: { include: { permission: { select: { key: true } } } }, _count: { select: { users: true } } }, orderBy: [{ isSystem: "desc" }, { name: "asc" }] });
  return roles.map((r) => ({ id: r.id, key: r.key, name: r.name, description: r.description, isSystem: r.isSystem, isProtected: r.isProtected, userCount: r._count.users, permissions: r.permissions.map((p) => p.permission.key).sort() }));
}

export async function listPermissions() {
  return db.permission.findMany({ orderBy: [{ module: "asc" }, { key: "asc" }], select: { key: true, module: true, description: true } });
}

const RoleInput = z.object({
  key: z.string().trim().toLowerCase().min(2).max(40).regex(/^[a-z0-9_]+$/),
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(200).optional(),
  permissions: z.array(z.string()).max(PERMISSIONS.length),
});

export async function createRole(ctx: SecurityContext, raw: z.infer<typeof RoleInput>) {
  const input = RoleInput.parse(raw);
  return transact(async (tx) => {
    if (await tx.role.findUnique({ where: { key: input.key } })) throw conflict("A role with that key already exists");
    await assertPermissionsHeld(ctx, tx, input.permissions);
    const role = await tx.role.create({ data: { key: input.key, name: input.name, description: input.description } });
    const perms = await tx.permission.findMany({ where: { key: { in: input.permissions } }, select: { id: true } });
    await tx.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })) });
    await auditIn(tx, ctx, { action: "role.create", module: "platform", entityType: "Role", entityId: role.id, after: { key: role.key, permissions: input.permissions } });
    return role;
  });
}

async function assertPermissionsHeld(ctx: SecurityContext, tx: Tx, keys: string[]) {
  const known = await tx.permission.findMany({ where: { key: { in: keys } }, select: { key: true } });
  if (known.length !== new Set(keys).size) throw validation("Unknown permission in list");
  if (ctx.user.isPrimaryAdmin) return;
  const missing = keys.filter((k) => !ctx.can(k));
  if (missing.length) throw forbidden("You cannot grant permissions you do not hold", { missing });
}

export async function setRolePermissions(ctx: SecurityContext, roleId: string, permissionKeys: string[]) {
  return transact(async (tx) => {
    const role = await tx.role.findUnique({ where: { id: roleId }, include: { permissions: { include: { permission: true } } } });
    if (!role) throw notFound("Role");
    if (role.isProtected) throw forbidden("The Primary Admin role always holds every permission and cannot be edited");
    await assertPermissionsHeld(ctx, tx, permissionKeys);
    const before = role.permissions.map((p) => p.permission.key).sort();
    await tx.rolePermission.deleteMany({ where: { roleId } });
    const perms = await tx.permission.findMany({ where: { key: { in: permissionKeys } }, select: { id: true } });
    await tx.rolePermission.createMany({ data: perms.map((p) => ({ roleId, permissionId: p.id })) });
    await auditIn(tx, ctx, { action: "role.permissions_changed", module: "platform", entityType: "Role", entityId: roleId, before: { permissions: before }, after: { permissions: [...permissionKeys].sort() } });
  });
}

export async function deleteRole(ctx: SecurityContext, roleId: string) {
  return transact(async (tx) => {
    const role = await tx.role.findUnique({ where: { id: roleId }, include: { _count: { select: { users: true } } } });
    if (!role) throw notFound("Role");
    if (role.isProtected || role.isSystem) throw forbidden("System roles cannot be deleted");
    if (role._count.users) throw conflict(`${role._count.users} user(s) still hold this role. Reassign them first.`);
    await tx.role.delete({ where: { id: roleId } });
    await auditIn(tx, ctx, { action: "role.delete", module: "platform", entityType: "Role", entityId: roleId, before: { key: role.key } });
  });
}
