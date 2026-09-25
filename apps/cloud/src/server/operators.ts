import { hash, verify } from "@node-rs/argon2";
import { z } from "zod";
import { db } from "./db";
import { env } from "./env";
import { cloudAudit } from "./audit";
import { randomToken, sha256 } from "./crypto";
import { CloudError, conflictErr, forbidden, unauthorized } from "./errors";
import type { Operator, OperatorRole } from "@cloud/generated/prisma/client";

export const SESSION_COOKIE = "ss_cloud_session";
const OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export async function createOperator(input: { email: string; name: string; password: string; role: OperatorRole }, actor?: { operatorId?: string; operatorEmail?: string }) {
  const i = z.object({ email: z.string().email().toLowerCase(), name: z.string().min(2).max(80), password: z.string().min(12, "Use at least 12 characters"), role: z.enum(["SUPER_ADMIN", "SUPPORT", "VIEWER"]) }).parse(input);
  if (await db.operator.findUnique({ where: { email: i.email } })) throw conflictErr("An operator with that email exists");
  const op = await db.operator.create({ data: { email: i.email, name: i.name, role: i.role, passwordHash: await hash(i.password, OPTS) } });
  await cloudAudit(db, { ...actor, action: "operator.create", detail: { email: i.email, role: i.role } });
  return op;
}

let dummy: Promise<string> | undefined;
const dummyHash = () => (dummy ??= hash(randomToken(16), OPTS));

export async function operatorLogin(email: string, password: string, ip: string | null) {
  const op = await db.operator.findUnique({ where: { email: email.trim().toLowerCase() } });
  const now = new Date();
  if (!op || !op.isActive) { await verify(await dummyHash(), password).catch(() => false); await cloudAudit(db, { action: "operator.login_failed", detail: { email }, ip }); throw unauthorized("Incorrect email or password"); }
  if (op.lockedUntil && op.lockedUntil > now) throw new CloudError("LOCKED", "Too many attempts. Try again later.", 429);
  if (!(await verify(op.passwordHash, password).catch(() => false))) {
    const failed = op.failedLogins + 1;
    await db.operator.update({ where: { id: op.id }, data: { failedLogins: failed >= 5 ? 0 : failed, lockedUntil: failed >= 5 ? new Date(now.getTime() + 15 * 60_000) : null } });
    await cloudAudit(db, { operatorId: op.id, operatorEmail: op.email, action: failed >= 5 ? "operator.locked" : "operator.login_failed", ip });
    throw unauthorized("Incorrect email or password");
  }
  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + env().SESSION_TTL_HOURS * 3_600_000);
  await db.$transaction([
    db.operator.update({ where: { id: op.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: now } }),
    db.operatorSession.create({ data: { operatorId: op.id, tokenHash: sha256(token), expiresAt } }),
  ]);
  await cloudAudit(db, { operatorId: op.id, operatorEmail: op.email, action: "operator.login", ip });
  return { token, expiresAt, operator: op };
}

export async function operatorFromToken(token: string | undefined | null): Promise<Operator | null> {
  if (!token) return null;
  const s = await db.operatorSession.findUnique({ where: { tokenHash: sha256(token) }, include: { operator: true } });
  if (!s || s.revokedAt || s.expiresAt <= new Date() || !s.operator.isActive) return null;
  return s.operator;
}

export async function operatorLogout(token: string) {
  await db.operatorSession.updateMany({ where: { tokenHash: sha256(token), revokedAt: null }, data: { revokedAt: new Date() } });
}

const RANK: Record<OperatorRole, number> = { VIEWER: 1, SUPPORT: 2, SUPER_ADMIN: 3 };
export function requireRole(op: Operator | null, min: OperatorRole): Operator {
  if (!op) throw unauthorized();
  if (RANK[op.role] < RANK[min]) throw forbidden(`This action needs the ${min.replace("_", " ").toLowerCase()} role`);
  return op;
}

function cookieValue(header: string | null, name: string) {
  for (const part of (header ?? "").split(";")) { const i = part.indexOf("="); if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim()); }
  return undefined;
}

/** Operator API guard: session cookie + same-origin check for mutations + minimum role. */
export async function authorizeOperator(req: Request, min: OperatorRole = "VIEWER"): Promise<Operator> {
  const m = req.method.toUpperCase();
  if (m !== "GET" && m !== "HEAD") {
    const origin = req.headers.get("origin"), host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    if (origin && host && new URL(origin).host !== host) throw forbidden("Cross-origin request blocked");
  }
  return requireRole(await operatorFromToken(cookieValue(req.headers.get("cookie"), SESSION_COOKIE)), min);
}
