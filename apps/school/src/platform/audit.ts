import { createHash } from "node:crypto";
import type { Tx } from "./db";
import { db } from "./db";
import type { Prisma } from "@/generated/prisma/client";

export interface AuditEntry {
  actorId?: string | null;
  actorName?: string | null;
  action: string; // "student.update", "payment.reverse", "auth.login_failed"
  module: string;
  entityType?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

/** Key-sorted JSON so the hash is stable even though PostgreSQL jsonb does not preserve key order. */
export function canonical(v: unknown): string {
  if (v === undefined || v === null) return "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object" && !(v instanceof Date)) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v instanceof Date ? v.toISOString() : v);
}

const json = (v: unknown): Prisma.InputJsonValue | undefined =>
  v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue);

function chainHash(prev: string | null, at: Date, actorId: string | null, action: string, module: string, entityType: string | null, entityId: string | null, before: unknown, after: unknown): string {
  return createHash("sha256").update(canonical([prev, at.toISOString(), actorId, action, module, entityType, entityId, before, after])).digest("hex");
}

/**
 * Append an audit record inside the caller's transaction (so the audit row commits or rolls back with
 * the change it describes). Rows are hash-chained; an advisory lock serialises chain extension.
 */
export async function audit(tx: Tx, e: AuditEntry): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('smartschool.audit_chain'))`;
  const last = await tx.auditLog.findFirst({ orderBy: { seq: "desc" }, select: { hash: true } });
  const occurredAt = new Date();
  const prevHash = last?.hash ?? null;
  const hash = chainHash(prevHash, occurredAt, e.actorId ?? null, e.action, e.module, e.entityType ?? null, e.entityId ?? null, json(e.before) ?? null, json(e.after) ?? null);
  await tx.auditLog.create({
    data: {
      occurredAt,
      actorId: e.actorId ?? null,
      actorName: e.actorName ?? null,
      action: e.action,
      module: e.module,
      entityType: e.entityType,
      entityId: e.entityId,
      before: json(e.before),
      after: json(e.after),
      metadata: json(e.metadata),
      ip: e.ip ?? null,
      prevHash,
      hash,
    },
  });
}

/** Audit outside any business transaction (login failures, denied requests). Never throws into the caller. */
export async function auditStandalone(e: AuditEntry): Promise<void> {
  try {
    await db.$transaction((tx) => audit(tx, e));
  } catch (err) {
    console.error("audit write failed", err);
  }
}

/** Recompute the chain; returns the first broken seq or null when intact. */
export async function verifyAuditChain(): Promise<{ intact: boolean; brokenAtSeq?: string; checked: number }> {
  const rows = await db.auditLog.findMany({ orderBy: { seq: "asc" } });
  let prev: string | null = null;
  for (const r of rows) {
    const expected: string = chainHash(prev, r.occurredAt, r.actorId, r.action, r.module, r.entityType, r.entityId, r.before, r.after);
    if (r.prevHash !== prev || r.hash !== expected) return { intact: false, brokenAtSeq: r.seq.toString(), checked: rows.length };
    prev = r.hash;
  }
  return { intact: true, checked: rows.length };
}

export interface AuditQuery {
  page?: number;
  pageSize?: number;
  module?: string;
  action?: string;
  actorId?: string;
  entityType?: string;
  entityId?: string;
  from?: string;
  to?: string;
}

/** Paged audit search for the admin UI. Returns raw before/after JSON — callers must hold `audit.view`. */
export async function listAuditLogs(q: AuditQuery) {
  const page = Math.max(1, q.page ?? 1), pageSize = Math.min(100, q.pageSize ?? 50);
  const where: Prisma.AuditLogWhereInput = {
    ...(q.module ? { module: q.module } : {}), ...(q.action ? { action: { startsWith: q.action } } : {}), ...(q.actorId ? { actorId: q.actorId } : {}),
    ...(q.entityType ? { entityType: q.entityType } : {}), ...(q.entityId ? { entityId: q.entityId } : {}),
    ...(q.from || q.to ? { occurredAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(`${q.to}T23:59:59.999Z`) } : {}) } } : {}),
  };
  const [rows, total] = await Promise.all([db.auditLog.findMany({ where, orderBy: { seq: "desc" }, skip: (page - 1) * pageSize, take: pageSize }), db.auditLog.count({ where })]);
  return { items: rows.map((r) => ({ ...r, seq: r.seq.toString() })), total, page, pageSize };
}
