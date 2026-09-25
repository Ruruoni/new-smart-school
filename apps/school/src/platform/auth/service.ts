import { db, transact } from "../db";
import { env } from "../env";
import { randomToken, sha256 } from "../crypto";
import { hashPassword, verifyPassword, assertPasswordPolicy } from "../password";
import { audit, auditStandalone } from "../audit";
import { AppError, unauthenticated, rateLimited } from "../errors";
import type { User } from "@/generated/prisma/client";

export const SESSION_COOKIE = "ss_session";
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const IDLE_MINUTES = 240;

// A valid argon2 hash of a random string: verifying against it makes "unknown user" take as long as "wrong password".
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hashPassword(randomToken(16)));

export interface SessionInfo {
  sessionId: string;
  user: User;
}

// Cheap per-IP throttle in front of the per-account lockout (protects against password spraying).
const ipHits = new Map<string, { count: number; resetAt: number }>();
function throttleIp(ip: string | null | undefined) {
  if (!ip) return;
  const now = Date.now();
  const cur = ipHits.get(ip);
  if (!cur || cur.resetAt < now) {
    ipHits.set(ip, { count: 1, resetAt: now + 60_000 });
    return;
  }
  cur.count += 1;
  if (cur.count > 30) throw rateLimited(Math.ceil((cur.resetAt - now) / 1000));
}
export function resetLoginThrottle() {
  ipHits.clear();
}

export async function login(input: { username: string; password: string; ip?: string | null; userAgent?: string | null }) {
  throttleIp(input.ip);
  const username = input.username.trim().toLowerCase();
  const user = await db.user.findFirst({ where: { username, deletedAt: null } });
  const now = new Date();

  if (!user) {
    await verifyPassword(await getDummyHash(), input.password);
    await auditStandalone({ action: "auth.login_failed", module: "platform", metadata: { username, reason: "unknown_user" }, ip: input.ip });
    throw new AppError("INVALID_CREDENTIALS", "Incorrect username or password", 401);
  }
  if (user.lockedUntil && user.lockedUntil > now) {
    await auditStandalone({ actorId: user.id, action: "auth.login_blocked", module: "platform", metadata: { reason: "locked" }, ip: input.ip });
    throw rateLimited(Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 1000));
  }
  const ok = await verifyPassword(user.passwordHash, input.password);
  if (!ok) {
    const failed = user.failedLoginCount + 1;
    const lock = failed >= MAX_FAILED;
    await transact(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { failedLoginCount: lock ? 0 : failed, lockedUntil: lock ? new Date(now.getTime() + LOCK_MINUTES * 60_000) : null },
      });
      await audit(tx, { actorId: user.id, action: lock ? "auth.account_locked" : "auth.login_failed", module: "platform", metadata: { failed }, ip: input.ip });
    });
    throw new AppError("INVALID_CREDENTIALS", "Incorrect username or password", 401);
  }
  if (user.status !== "ACTIVE") {
    await auditStandalone({ actorId: user.id, action: "auth.login_blocked", module: "platform", metadata: { reason: user.status }, ip: input.ip });
    throw new AppError("ACCOUNT_DISABLED", "This account is not active. Contact the school administrator.", 403);
  }

  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + env().SESSION_TTL_HOURS * 3_600_000);
  await transact(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now } });
    await tx.session.create({ data: { userId: user.id, tokenHash: sha256(token), expiresAt, ip: input.ip ?? null, userAgent: input.userAgent?.slice(0, 300) ?? null } });
    await audit(tx, { actorId: user.id, actorName: `${user.firstName} ${user.lastName}`, action: "auth.login", module: "platform", ip: input.ip });
  });
  return { token, expiresAt, user, mustChangePassword: user.mustChangePassword };
}

/** Resolve a cookie token to a live session + active user, or null. Slides `lastSeenAt` at most once a minute. */
export async function validateSession(token: string | undefined | null): Promise<SessionInfo | null> {
  if (!token) return null;
  const now = new Date();
  const s = await db.session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!s || s.revokedAt || s.expiresAt <= now) return null;
  if (now.getTime() - s.lastSeenAt.getTime() > IDLE_MINUTES * 60_000) return null;
  if (s.user.status !== "ACTIVE" || s.user.deletedAt) return null;
  if (now.getTime() - s.lastSeenAt.getTime() > 60_000) {
    await db.session.update({ where: { id: s.id }, data: { lastSeenAt: now } }).catch(() => undefined);
  }
  return { sessionId: s.id, user: s.user };
}

export async function logout(token: string | undefined | null, actor?: { id: string; ip?: string | null }) {
  if (!token) return;
  await transact(async (tx) => {
    const r = await tx.session.updateMany({ where: { tokenHash: sha256(token), revokedAt: null }, data: { revokedAt: new Date() } });
    if (r.count && actor) await audit(tx, { actorId: actor.id, action: "auth.logout", module: "platform", ip: actor.ip });
  });
}

export async function revokeAllSessions(tx: Parameters<typeof audit>[0], userId: string) {
  await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function changeOwnPassword(userId: string, currentPassword: string, newPassword: string, ip?: string | null) {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw unauthenticated();
  if (!(await verifyPassword(user.passwordHash, currentPassword))) throw new AppError("INVALID_CREDENTIALS", "Current password is incorrect", 400);
  assertPasswordPolicy(newPassword);
  const passwordHash = await hashPassword(newPassword);
  await transact(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { passwordHash, mustChangePassword: false, passwordChangedAt: new Date(), version: { increment: 1 } } });
    await revokeAllSessions(tx, userId);
    await audit(tx, { actorId: userId, action: "auth.password_changed", module: "platform", ip });
  });
}
