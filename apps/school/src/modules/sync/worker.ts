import { SyncAck, backoffSeconds, MAX_BATCH, MAX_SYNC_RETRIES, type SyncBatch } from "@smartschool/protocol";
import { db, transact } from "@/platform/db";
import { audit } from "@/platform/audit";
import { publishEvent } from "@/platform/events";
import type { Prisma } from "@/generated/prisma/client";
import { CloudRejected, CloudUnreachable, cloudConfig, signedPost, type CloudConfig } from "./client";

export interface PushReport {
  configured: boolean;
  sent: number;
  acked: number;
  duplicates: number;
  conflicts: number;
  rejected: number;
  failedNetwork: boolean;
  authRejected: boolean;
}

const emptyReport = (configured: boolean): PushReport => ({ configured, sent: 0, acked: 0, duplicates: 0, conflicts: 0, rejected: 0, failedNetwork: false, authRejected: false });

/** IN_FLIGHT rows left by a crash mid-request go back to the queue. The cloud's idempotency makes re-sending safe. */
export async function recoverStuckInFlight(olderThanMinutes = 5) {
  return (await db.syncQueue.updateMany({ where: { status: "IN_FLIGHT", lastAttemptAt: { lt: new Date(Date.now() - olderThanMinutes * 60_000) } }, data: { status: "PENDING" } })).count;
}

async function claimBatch(limit: number) {
  const claimed = await db.$queryRaw<{ id: string }[]>`
    UPDATE sync_queue SET status = 'IN_FLIGHT', "lastAttemptAt" = (now() AT TIME ZONE 'UTC')
    WHERE id IN (SELECT id FROM sync_queue WHERE status IN ('PENDING','FAILED') AND "nextAttemptAt" <= (now() AT TIME ZONE 'UTC') ORDER BY seq ASC LIMIT ${limit} FOR UPDATE SKIP LOCKED)
    RETURNING id`;
  if (!claimed.length) return [];
  return db.syncQueue.findMany({ where: { id: { in: claimed.map((c) => c.id) } }, orderBy: { seq: "asc" } });
}

/** Push ONE batch. Returns null when there was nothing due. */
export async function pushBatch(cfg: CloudConfig): Promise<PushReport | null> {
  const rows = await claimBatch(MAX_BATCH);
  if (!rows.length) return null;
  const report = emptyReport(true);
  report.sent = rows.length;
  const batch: SyncBatch = {
    installationCode: cfg.code, sentAt: new Date().toISOString(),
    records: rows.map((r) => ({ idempotencyKey: r.idempotencyKey, entityType: r.entityType, entityId: r.entityId, operation: r.operation, entityVersion: r.entityVersion, payload: r.payload as Record<string, unknown>, createdAt: r.createdAt.toISOString() })),
  };

  const failAll = async (message: string, delaySec: (retry: number) => number) => {
    for (const r of rows) {
      const retry = r.retryCount + 1;
      await db.syncQueue.update({ where: { id: r.id }, data: { status: retry >= MAX_SYNC_RETRIES ? "DEAD" : "FAILED", retryCount: retry, lastError: message.slice(0, 500), nextAttemptAt: new Date(Date.now() + delaySec(retry) * 1000) } });
    }
  };

  let ack: SyncAck;
  try {
    ack = SyncAck.parse(await signedPost(cfg, "/api/v1/sync/batch", batch));
  } catch (err) {
    if (err instanceof CloudUnreachable) { report.failedNetwork = true; await failAll(`Cloud unreachable: ${err.message}`, (n) => backoffSeconds(n - 1)); return report; }
    if (err instanceof CloudRejected && (err.status === 401 || err.status === 403)) { report.authRejected = true; await failAll(`Cloud rejected credentials: ${err.message}`, () => 3600); return report; }
    if (err instanceof CloudRejected) { await failAll(`Cloud error ${err.status}: ${err.message}`, (n) => backoffSeconds(n - 1)); return report; }
    await failAll(`Unexpected response: ${(err as Error).message}`, (n) => backoffSeconds(n - 1));
    return report;
  }

  const byKey = new Map(ack.results.map((r) => [r.idempotencyKey, r]));
  for (const r of rows) {
    const res = byKey.get(r.idempotencyKey);
    if (!res) { // the cloud did not answer for this record: treat as a failed attempt
      await db.syncQueue.update({ where: { id: r.id }, data: { status: "FAILED", retryCount: r.retryCount + 1, lastError: "No result returned by the cloud", nextAttemptAt: new Date(Date.now() + backoffSeconds(r.retryCount) * 1000) } });
      continue;
    }
    if (res.status === "ACKED" || res.status === "DUPLICATE") {
      await db.syncQueue.update({ where: { id: r.id }, data: { status: "ACKED", ackedAt: new Date(), lastError: null } });
      res.status === "ACKED" ? report.acked++ : report.duplicates++;
    } else if (res.status === "CONFLICT") {
      report.conflicts++;
      await transact(async (tx) => {
        await tx.syncQueue.update({ where: { id: r.id }, data: { status: "CONFLICT", lastError: "Conflict: the cloud holds different data for the same version" } });
        const open = await tx.syncConflict.findFirst({ where: { entityType: r.entityType, entityId: r.entityId, status: "OPEN" } });
        if (open) return;
        await tx.syncConflict.create({ data: { queueId: r.id, entityType: r.entityType, entityId: r.entityId, localVersion: r.entityVersion, cloudVersion: res.cloudVersion ?? r.entityVersion, localPayload: r.payload as Prisma.InputJsonValue, cloudPayload: (res.cloudPayload ?? {}) as Prisma.InputJsonValue } });
        await publishEvent(tx, "sync.conflict_detected", { entityType: r.entityType, entityId: r.entityId });
        await audit(tx, { action: "sync.conflict_detected", module: "sync", entityType: r.entityType, entityId: r.entityId, metadata: { localVersion: r.entityVersion, cloudVersion: res.cloudVersion } });
      });
    } else {
      report.rejected++;
      const retry = r.retryCount + 1;
      // REJECTED means the payload itself is unacceptable: retrying the identical record can never succeed → dead-letter it.
      await db.syncQueue.update({ where: { id: r.id }, data: { status: "DEAD", retryCount: retry, lastError: (res.error ?? "Rejected by the cloud").slice(0, 500) } });
    }
  }
  return report;
}

/** Push until the queue is drained or `maxBatches` reached. Never throws on network trouble. */
export async function pushAll(opts: { maxBatches?: number } = {}): Promise<PushReport> {
  const cfg = await cloudConfig();
  if (!cfg) return emptyReport(false);
  await recoverStuckInFlight();
  const total = emptyReport(true);
  for (let i = 0; i < (opts.maxBatches ?? 10); i++) {
    const r = await pushBatch(cfg);
    if (!r) break;
    total.sent += r.sent; total.acked += r.acked; total.duplicates += r.duplicates; total.conflicts += r.conflicts; total.rejected += r.rejected;
    total.failedNetwork ||= r.failedNetwork; total.authRejected ||= r.authRejected;
    if (r.failedNetwork || r.authRejected) break; // don't hammer an unreachable/refusing cloud
  }
  return total;
}

export async function syncOverview() {
  const [byStatus, oldest, lastAck, conflicts] = await Promise.all([
    db.syncQueue.groupBy({ by: ["status"], _count: true }),
    db.syncQueue.findFirst({ where: { status: { in: ["PENDING", "FAILED", "IN_FLIGHT"] } }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
    db.syncQueue.findFirst({ where: { status: "ACKED" }, orderBy: { ackedAt: "desc" }, select: { ackedAt: true } }),
    db.syncConflict.count({ where: { status: "OPEN" } }),
  ]);
  const n = (s: string) => byStatus.find((b) => b.status === s)?._count ?? 0;
  const cfg = await db.schoolInstallation.findFirst({ select: { cloudUrl: true, cloudSecretEnc: true, registeredAt: true } });
  return {
    registered: !!cfg?.cloudSecretEnc, registeredAt: cfg?.registeredAt ?? null,
    pending: n("PENDING"), inFlight: n("IN_FLIGHT"), failed: n("FAILED"), dead: n("DEAD"), conflict: n("CONFLICT"), acked: n("ACKED"),
    oldestPendingAgeSec: oldest ? Math.round((Date.now() - oldest.createdAt.getTime()) / 1000) : null, lastSyncAt: lastAck?.ackedAt ?? null, openConflicts: conflicts,
  };
}

/** Housekeeping: acknowledged rows older than `days` are deleted (the cloud is the record of what was sent). */
export async function purgeAckedQueue(days = 30) {
  return (await db.syncQueue.deleteMany({ where: { status: "ACKED", ackedAt: { lt: new Date(Date.now() - days * 86_400_000) } } })).count;
}

/** Re-queue dead-lettered rows after an operator fixed the cause. */
export async function requeueDead() {
  return (await db.syncQueue.updateMany({ where: { status: "DEAD" }, data: { status: "PENDING", retryCount: 0, nextAttemptAt: new Date(), lastError: null } })).count;
}
