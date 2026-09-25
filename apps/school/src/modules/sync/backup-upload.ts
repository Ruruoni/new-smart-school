import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { db } from "@/platform/db";
import { env } from "@/platform/env";
import { audit } from "@/platform/audit";
import { transact } from "@/platform/db";
import { CloudRejected, CloudUnreachable, cloudConfig, signedUpload } from "./client";

/** Cloud copy of an (already encrypted) backup archive. Streamed, checksummed; a failure just leaves the local backup in place. */
export async function uploadBackupToCloud(recordId: string): Promise<{ ok: true; cloudId: string } | { ok: false; reason: string }> {
  const cfg = await cloudConfig();
  if (!cfg) return { ok: false, reason: "not registered with a cloud" };
  const rec = await db.backupRecord.findUnique({ where: { id: recordId } });
  if (!rec?.path || rec.status !== "SUCCEEDED" || !rec.sha256) return { ok: false, reason: "backup is not available" };
  const root = resolve(env().BACKUP_DIR);
  const path = resolve(root, rec.path);
  if (!path.startsWith(root + sep)) return { ok: false, reason: "invalid backup path" };
  const size = (await stat(path)).size;
  try {
    const res = await signedUpload(cfg, "/api/v1/backups", { stream: Readable.toWeb(createReadStream(path)) as ReadableStream, sha256: rec.sha256, name: rec.path, size });
    await transact(async (tx) => {
      await tx.backupRecord.create({ data: { kind: "CLOUD", status: "SUCCEEDED", path: rec.path, sizeBytes: rec.sizeBytes, sha256: rec.sha256, schemaVersion: rec.schemaVersion, verifiedAt: new Date(), finishedAt: new Date() } });
      await audit(tx, { action: "backup.cloud_upload", module: "backup", entityType: "BackupRecord", entityId: recordId, metadata: { size } });
    });
    return { ok: true, cloudId: String(res.id) };
  } catch (err) {
    return { ok: false, reason: err instanceof CloudUnreachable ? "cloud unreachable" : err instanceof CloudRejected ? `cloud rejected the upload (${err.status}): ${err.message}` : (err as Error).message };
  }
}
