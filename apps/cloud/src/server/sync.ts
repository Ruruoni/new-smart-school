import { SYNC_ENTITIES, SyncBatch, isSyncEntity, unexpectedFields, type SyncRecord, type SyncResult } from "@smartschool/protocol";
import { db, transact, type Tx } from "./db";
import { badRequest } from "./errors";
import { payloadHash } from "./crypto";
import type { Installation } from "@cloud/generated/prisma/client";

/**
 * Idempotent, conflict-aware ingest of one batch from one school.
 *
 *  • every accepted key is recorded under a UNIQUE index, so a replay is provably a no-op;
 *  • a record with a HIGHER version replaces the stored one; a LOWER version is a stale/out-of-order resend (ignored);
 *  • the SAME version with DIFFERENT content means the two sides diverged (e.g. the school restored an old backup
 *    and edited again): for MANUAL entities that becomes a conflict for a human; for reference data the record with
 *    the later timestamp wins;
 *  • payloads containing fields outside the entity's allow-list are REJECTED — the cloud never stores extra data.
 */
export async function ingestBatch(inst: Installation, raw: unknown): Promise<{ results: SyncResult[] }> {
  const parsed = SyncBatch.safeParse(raw);
  if (!parsed.success) throw badRequest("Invalid sync batch", parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join("."), message: i.message })));
  if (parsed.data.installationCode !== inst.code) throw badRequest("Batch does not belong to this installation");
  const results: SyncResult[] = [];
  for (const rec of parsed.data.records) results.push(await ingestOne(inst.id, rec));
  await db.installation.update({ where: { id: inst.id }, data: { lastSyncAt: new Date() } });
  return { results };
}

async function ingestOne(installationId: string, rec: SyncRecord): Promise<SyncResult> {
  const key = rec.idempotencyKey;
  const reject = async (error: string): Promise<SyncResult> => {
    await db.syncIngest.upsert({ where: { installationId_idempotencyKey: { installationId, idempotencyKey: key } }, create: { installationId, idempotencyKey: key, outcome: "REJECTED" }, update: {} });
    return { idempotencyKey: key, status: "REJECTED", error };
  };
  if (!isSyncEntity(rec.entityType)) return reject(`Unknown entity type "${rec.entityType}"`);
  const extra = unexpectedFields(rec.entityType, rec.payload);
  if (extra.length) return reject(`Payload contains fields that are not shared: ${extra.join(", ")}`);
  if (rec.payload.id !== undefined && String(rec.payload.id) !== rec.entityId) return reject("Payload id does not match entityId");

  try {
    return await transact((tx) => applyRecord(tx, installationId, rec));
  } catch (err) {
    // Two workers racing on the same key: the unique index rejected one — it is a duplicate by definition.
    if ((err as { code?: string }).code === "P2002") return { idempotencyKey: key, status: "DUPLICATE" };
    throw err;
  }
}

async function applyRecord(tx: Tx, installationId: string, rec: SyncRecord): Promise<SyncResult> {
  const key = rec.idempotencyKey;
  const seen = await tx.syncIngest.findUnique({ where: { installationId_idempotencyKey: { installationId, idempotencyKey: key } } });
  if (seen) return { idempotencyKey: key, status: seen.outcome === "CONFLICT" ? "CONFLICT" : seen.outcome === "REJECTED" ? "REJECTED" : "DUPLICATE" };

  const type = rec.entityType as keyof typeof SYNC_ENTITIES;
  const policy = SYNC_ENTITIES[type].policy;
  const hash = payloadHash({ ...rec.payload, __deleted: rec.operation === "DELETE" });
  const recordedAt = new Date(rec.createdAt);
  const stored = await tx.syncedRecord.findUnique({ where: { installationId_entityType_entityId: { installationId, entityType: type, entityId: rec.entityId } } });
  const record = async (outcome: string) => void (await tx.syncIngest.create({ data: { installationId, idempotencyKey: key, outcome } }));
  const write = () => tx.syncedRecord.upsert({
    where: { installationId_entityType_entityId: { installationId, entityType: type, entityId: rec.entityId } },
    create: { installationId, entityType: type, entityId: rec.entityId, version: rec.entityVersion, payload: rec.payload as never, payloadHash: hash, deleted: rec.operation === "DELETE", recordedAt },
    update: { version: rec.entityVersion, payload: rec.payload as never, payloadHash: hash, deleted: rec.operation === "DELETE", recordedAt },
  });

  if (!stored || rec.entityVersion > stored.version) {
    await write();
    await record("ACKED");
    return { idempotencyKey: key, status: "ACKED", cloudVersion: rec.entityVersion };
  }
  if (rec.entityVersion < stored.version) {
    await record("DUPLICATE"); // stale, out-of-order resend: the cloud already holds something newer
    return { idempotencyKey: key, status: "DUPLICATE", cloudVersion: stored.version };
  }
  // Same version
  if (stored.payloadHash === hash) {
    await record("DUPLICATE");
    return { idempotencyKey: key, status: "DUPLICATE", cloudVersion: stored.version };
  }
  if (policy === "LAST_WRITE_WINS") {
    if (recordedAt >= stored.recordedAt) { await write(); await record("ACKED"); return { idempotencyKey: key, status: "ACKED", cloudVersion: rec.entityVersion }; }
    await record("DUPLICATE");
    return { idempotencyKey: key, status: "DUPLICATE", cloudVersion: stored.version };
  }
  // MANUAL: never overwrite silently.
  const openConflict = await tx.cloudConflict.findFirst({ where: { installationId, entityType: type, entityId: rec.entityId, resolvedAt: null }, select: { id: true } });
  if (openConflict) await tx.cloudConflict.update({ where: { id: openConflict.id }, data: { incomingVersion: rec.entityVersion, incomingPayload: rec.payload as never } });
  else await tx.cloudConflict.create({ data: { installationId, entityType: type, entityId: rec.entityId, incomingVersion: rec.entityVersion, storedVersion: stored.version, incomingPayload: rec.payload as never, storedPayload: stored.payload as never } });
  await record("CONFLICT");
  return { idempotencyKey: key, status: "CONFLICT", cloudVersion: stored.version, cloudPayload: stored.payload as Record<string, unknown> };
}

/** Called by an operator (or automatically) once the school has re-sent a higher version. */
export async function resolveCloudConflicts(installationId: string, entityType: string, entityId: string) {
  await db.cloudConflict.updateMany({ where: { installationId, entityType, entityId, resolvedAt: null }, data: { resolvedAt: new Date() } });
}

export async function syncStats(installationId: string) {
  const [records, byType] = await Promise.all([db.syncedRecord.count({ where: { installationId } }), db.syncedRecord.groupBy({ by: ["entityType"], where: { installationId }, _count: true })]);
  return { records, byType: byType.map((b) => ({ entityType: b.entityType, count: b._count })) };
}
