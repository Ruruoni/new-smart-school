import { z } from "zod";
import { db, transact, type Tx } from "@/platform/db";
import type { SecurityContext } from "@/platform/security/context";
import { auditIn } from "@/platform/security/interceptor";
import { enqueueSync } from "@/platform/sync/outbox";
import { SYNC_ENTITIES, isSyncEntity, type SyncEntityType } from "@/platform/sync/registry";
import { conflict, forbidden, notFound, validation } from "@/platform/errors";
import { uuid } from "@/platform/util";

/**
 * Sync conflicts are never resolved silently. The school is the authoritative copy of its own records, so:
 *   KEEP_LOCAL      – our data stands: bump the version above the cloud's and re-send it.
 *   ACCEPT_CLOUD    – only for reference data where restoring cloud values is safe; money, results, attendance,
 *                     exams and student records are NEVER overwritten from the cloud.
 *   MANUAL_RESOLVED – the admin corrected the record by hand (through the normal screens); we bump + re-send it.
 */
export const Resolution = z.object({ strategy: z.enum(["KEEP_LOCAL", "ACCEPT_CLOUD", "MANUAL_RESOLVED"]), note: z.string().trim().max(500).optional() });

/** Entities whose allow-listed fields may be restored from the cloud copy. */
export const SAFE_TO_ACCEPT_CLOUD: ReadonlySet<SyncEntityType> = new Set(["academic_year", "term", "school_class", "subject"]);

type Bumpable = { update(args: { where: { id: string }; data: { version: number } }): Promise<unknown>; findUnique(args: { where: { id: string } }): Promise<{ version: number } | null> };
const delegates = (tx: Tx): Record<SyncEntityType, Bumpable> => ({
  student: tx.studentProfile as never, enrollment: tx.enrollment as never, invoice: tx.invoice as never, payment: tx.payment as never, expense: tx.expense as never, report_card: tx.reportCard as never,
  attendance_log: tx.attendanceLog as never, cbt_result: undefined as never, admission_record: tx.admissionRecord as never, academic_year: tx.academicYear as never, term: tx.term as never, school_class: tx.schoolClass as never, subject: tx.subject as never,
});

async function bumpAndResend(tx: Tx, type: SyncEntityType, id: string, minVersion: number) {
  const d = delegates(tx)[type];
  if (!d) throw validation("This record type cannot be re-sent");
  const cur = await d.findUnique({ where: { id } });
  if (!cur) throw notFound("The record no longer exists locally");
  const next = Math.max(cur.version, minVersion) + 1;
  await d.update({ where: { id }, data: { version: next } });
  const row = await (d as unknown as { findUnique(a: unknown): Promise<Record<string, unknown> & { id: string }> }).findUnique({ where: { id } });
  await enqueueSync(tx, type, row);
  return next;
}

export async function resolveConflict(ctx: SecurityContext, conflictId: string, raw: z.input<typeof Resolution>) {
  const r = Resolution.parse(raw);
  return transact(async (tx) => {
    const c = await tx.syncConflict.findUnique({ where: { id: conflictId } });
    if (!c) throw notFound("Conflict");
    if (c.status !== "OPEN") throw conflict("This conflict is already resolved");
    if (!isSyncEntity(c.entityType)) throw validation("Unknown entity type");
    const type = c.entityType;
    let status: "RESOLVED_LOCAL" | "RESOLVED_CLOUD" | "RESOLVED_MERGED";
    let newVersion: number | null = null;

    if (r.strategy === "ACCEPT_CLOUD") {
      if (!SAFE_TO_ACCEPT_CLOUD.has(type)) throw forbidden(`${SYNC_ENTITIES[type].label} cannot be overwritten from the cloud copy. Keep the local record, or correct it in the app and choose "resolved manually".`);
      const payload = c.cloudPayload as Record<string, unknown>;
      const { id: _id, version: _v, ...fields } = payload;
      const d = delegates(tx)[type] as unknown as { update(a: unknown): Promise<unknown> };
      const data = Object.fromEntries(Object.entries(fields).filter(([k]) => (SYNC_ENTITIES[type].fields as readonly string[]).includes(k)).map(([k, v]) => [k, /(Date|At|On)$/.test(k) && typeof v === "string" ? new Date(v) : v]));
      await d.update({ where: { id: c.entityId }, data: { ...data, version: Math.max(c.cloudVersion, c.localVersion) + 1 } });
      status = "RESOLVED_CLOUD";
    } else {
      newVersion = await bumpAndResend(tx, type, c.entityId, Math.max(c.cloudVersion, c.localVersion));
      status = r.strategy === "KEEP_LOCAL" ? "RESOLVED_LOCAL" : "RESOLVED_MERGED";
    }
    await tx.syncConflict.update({ where: { id: c.id }, data: { status, resolvedById: ctx.user.id, resolvedAt: new Date(), resolution: { strategy: r.strategy, note: r.note ?? null, newVersion } } });
    if (c.queueId) await tx.syncQueue.updateMany({ where: { id: c.queueId, status: "CONFLICT" }, data: { status: "ACKED", ackedAt: new Date(), lastError: `Superseded by conflict resolution (${r.strategy})` } });
    await auditIn(tx, ctx, { action: "sync.conflict_resolved", module: "sync", entityType: c.entityType, entityId: c.entityId, before: { localVersion: c.localVersion, cloudVersion: c.cloudVersion }, after: { strategy: r.strategy, newVersion }, metadata: { note: r.note } });
    return { status, newVersion };
  });
}

export const listConflicts = (status: "OPEN" | "ALL" = "OPEN") =>
  db.syncConflict.findMany({ where: status === "OPEN" ? { status: "OPEN" } : {}, orderBy: { createdAt: "desc" }, take: 100 });

export const conflictId = uuid;
