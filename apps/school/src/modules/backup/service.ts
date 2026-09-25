import { createCipheriv, createDecipheriv, createHash, randomBytes, type CipherGCM } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { createGzip, createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { PassThrough, Readable, Transform } from "node:stream";
import { createInterface } from "node:readline";
import pg from "pg";
import { z } from "zod";
import { db, transact } from "@/platform/db";
import { env } from "@/platform/env";
import { audit } from "@/platform/audit";
import type { SecurityContext } from "@/platform/security/context";
import { auditIn } from "@/platform/security/interceptor";
import { verifyPassword } from "@/platform/password";
import { AppError, conflict, forbidden, notFound, validation } from "@/platform/errors";
import { invalidateLicenseCache } from "@/platform/license";

/**
 * Logical backups, deliberately separate from the sync queue (sync is replication of selected records, NOT a backup).
 *
 *  • One REPEATABLE READ snapshot ⇒ every table is captured at the same instant (no torn state across tables).
 *  • Format: gzip'd, AES-256-GCM-encrypted lines `table<TAB>row-as-json`. Rows stay raw JSON text end to end,
 *    so numerics/timestamps are restored bit-exact (no JS float round-trip).
 *  • A sidecar manifest records row counts, sha256 and the schema version; verification re-hashes the file, decrypts,
 *    counts every row, and proves the data loads into a scratch schema.
 *  • Restore is a guarded, audited, typed-confirmation operation that first takes a safety backup.
 */

const MAGIC = Buffer.from("SSBAKv1\0"); // 8 bytes
const TAG_LEN = 16;
const IV_LEN = 12;
const FORMAT = 1;

export interface Manifest {
  format: number;
  createdAt: string;
  installationCode: string | null;
  appVersion: string | null;
  schemaVersion: string;
  encrypted: boolean;
  tables: Record<string, number>;
  totalRows: number;
}

/** Backup history describes files on disk, not school data: it must survive a restore (otherwise the safety backup would be orphaned). */
const RESTORE_SKIP = new Set(["backup_records"]);

const backupDir = () => resolve(env().BACKUP_DIR);
const safeBackupPath = (name: string) => {
  const p = resolve(backupDir(), basename(name));
  if (!p.startsWith(backupDir() + sep)) throw new AppError("BAD_PATH", "Invalid backup path", 400);
  return p;
};
const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

function encKey(override?: Buffer) {
  const k = override ?? Buffer.from(env().APP_ENCRYPTION_KEY, "base64");
  if (k.length !== 32) throw new Error("Backup key must be 32 bytes");
  return k;
}

async function pgClient() {
  const c = new pg.Client({ connectionString: env().DATABASE_URL, options: "-c timezone=UTC" });
  await c.connect();
  return c;
}

async function listTables(c: pg.Client): Promise<string[]> {
  const r = await c.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY tablename`);
  return r.rows.map((x) => x.tablename);
}

export async function currentSchemaVersion(): Promise<string> {
  const r = await db.$queryRaw<{ migration_name: string }[]>`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC, migration_name DESC LIMIT 1`;
  return r[0]?.migration_name ?? "unknown";
}

// ───────────── Create ─────────────

export async function runBackup(ctx: SecurityContext | null, opts: { encrypt?: boolean; reason?: string } = {}) {
  const encrypt = opts.encrypt ?? true;
  await mkdir(backupDir(), { recursive: true, mode: 0o700 });
  const record = await db.backupRecord.create({ data: { kind: "LOCAL" } });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = `smartschool-${stamp}-${record.id.slice(0, 8)}.ssbak`;
  const path = safeBackupPath(file);
  const client = await pgClient();
  try {
    const inst = await db.schoolInstallation.findFirst({ select: { installationCode: true, appVersion: true } });
    const schemaVersion = await currentSchemaVersion();
    const tables: Record<string, number> = {};

    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const names = await listTables(client);

    const rows = new PassThrough();
    const gzip = createGzip({ level: 6 });
    const out = createWriteStream(path, { mode: 0o600 });
    const hash = createHash("sha256");
    let cipher: CipherGCM | null = null;
    const iv = randomBytes(IV_LEN);
    const head = new Transform({ transform(chunk, _e, cb) { hash.update(chunk); cb(null, chunk); } });
    let pipe: Promise<void>;
    if (encrypt) {
      cipher = createCipheriv("aes-256-gcm", encKey(), iv) as CipherGCM;
      head.write(Buffer.concat([MAGIC, iv]));
      pipe = pipeline(rows, gzip, cipher, head, out);
    } else {
      pipe = pipeline(rows, gzip, head, out);
    }
    const write = (s: string) => rows.write(s) || new Promise<void>((r) => rows.once("drain", r));

    await write(`#manifest\t${JSON.stringify({ format: FORMAT, createdAt: new Date().toISOString(), installationCode: inst?.installationCode ?? null, appVersion: inst?.appVersion ?? null, schemaVersion, encrypted: encrypt })}\n`);
    for (const t of names) {
      tables[t] = 0;
      await client.query(`DECLARE bk CURSOR FOR SELECT row_to_json(x)::text AS j FROM ${q(t)} x`);
      for (;;) {
        const r = await client.query<{ j: string }>("FETCH 2000 FROM bk");
        if (!r.rows.length) break;
        await write(r.rows.map((row) => `${t}\t${row.j}\n`).join(""));
        tables[t] += r.rows.length;
      }
      await client.query("CLOSE bk");
    }
    await client.query("COMMIT");
    rows.end();
    await pipe;
    if (cipher) {
      const tag = cipher.getAuthTag();
      await new Promise<void>((res, rej) => { const w = createWriteStream(path, { flags: "a", mode: 0o600 }); w.on("error", rej); w.end(tag, res); });
      hash.update(tag);
    }
    const size = (await stat(path)).size;
    const sha256 = hash.digest("hex");
    const manifest: Manifest = { format: FORMAT, createdAt: new Date().toISOString(), installationCode: inst?.installationCode ?? null, appVersion: inst?.appVersion ?? null, schemaVersion, encrypted: encrypt, tables, totalRows: Object.values(tables).reduce((a, b) => a + b, 0) };
    await writeFile(`${path}.manifest.json`, JSON.stringify({ ...manifest, sha256, size }, null, 2), { mode: 0o600 });
    await chmod(path, 0o600);
    const done = await db.backupRecord.update({ where: { id: record.id }, data: { status: "SUCCEEDED", path: file, sizeBytes: size, sha256, schemaVersion, finishedAt: new Date() } });
    await transact((tx) => (ctx ? auditIn(tx, ctx, { action: "backup.run", module: "backup", entityType: "BackupRecord", entityId: record.id, metadata: { size, rows: manifest.totalRows, reason: opts.reason } }) : audit(tx, { action: "backup.run", module: "backup", entityType: "BackupRecord", entityId: record.id, metadata: { size, rows: manifest.totalRows, reason: opts.reason ?? "scheduled" } })));
    return { record: done, manifest };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    await rm(path, { force: true });
    await db.backupRecord.update({ where: { id: record.id }, data: { status: "FAILED", error: (err as Error).message.slice(0, 500), finishedAt: new Date() } });
    throw err;
  } finally {
    await client.end();
  }
}

// ───────────── Read an archive (integrity-checked) ─────────────

async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), new Transform({ transform(c, _e, cb) { h.update(c); cb(); } }));
  return h.digest("hex");
}

/** Stream decoded lines `[table, jsonText]` from an archive. Throws if authentication (GCM tag) or gzip integrity fails. */
async function* readArchive(path: string, encrypted: boolean, keyOverride?: Buffer): AsyncGenerator<[string, string]> {
  let source: Readable;
  if (encrypted) {
    const size = (await stat(path)).size;
    if (size < MAGIC.length + IV_LEN + TAG_LEN) throw new AppError("BACKUP_CORRUPT", "The backup file is truncated", 422);
    const fh = await open(path, "r");
    const head = Buffer.alloc(MAGIC.length + IV_LEN), tag = Buffer.alloc(TAG_LEN);
    await fh.read(head, 0, head.length, 0);
    await fh.read(tag, 0, TAG_LEN, size - TAG_LEN);
    await fh.close();
    if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new AppError("BACKUP_CORRUPT", "Not a SmartSchool backup file", 422);
    const decipher = createDecipheriv("aes-256-gcm", encKey(keyOverride), head.subarray(MAGIC.length));
    decipher.setAuthTag(tag);
    source = createReadStream(path, { start: head.length, end: size - TAG_LEN - 1 }).pipe(decipher).pipe(createGunzip());
    source.on("error", () => undefined);
    decipher.on("error", (e) => source.destroy(e));
  } else {
    source = createReadStream(path).pipe(createGunzip());
  }
  try {
    for await (const line of createInterface({ input: source, crlfDelay: Infinity })) {
      if (!line) continue;
      const i = line.indexOf("\t");
      yield [line.slice(0, i), line.slice(i + 1)];
    }
  } catch (err) {
    throw new AppError("BACKUP_CORRUPT", `The backup could not be decoded (${(err as Error).message}). It may be damaged or encrypted with a different key.`, 422);
  }
}

async function readManifest(path: string) {
  try {
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(`${path}.manifest.json`, "utf8")) as Manifest & { sha256: string; size: number };
  } catch {
    throw new AppError("BACKUP_NO_MANIFEST", "The backup's manifest file is missing", 422);
  }
}

// ───────────── Verify ─────────────

export interface VerifyResult {
  ok: boolean;
  checks: { name: string; ok: boolean; detail?: string }[];
}

/**
 * Trust but verify: (1) file hash, (2) decrypt + decompress + count every row against the manifest,
 * (3) `deep`: load all rows into a scratch schema of the live structure — proves the backup is restorable.
 */
export async function verifyBackup(recordId: string, opts: { deep?: boolean; key?: Buffer } = {}): Promise<VerifyResult> {
  const rec = await db.backupRecord.findUnique({ where: { id: recordId } });
  if (!rec || !rec.path) throw notFound("Backup");
  const path = safeBackupPath(rec.path);
  const checks: VerifyResult["checks"] = [];
  const push = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });
  try {
    const manifest = await readManifest(path);
    const hash = await sha256File(path);
    push("file checksum", hash === manifest.sha256 && hash === rec.sha256, hash === manifest.sha256 ? undefined : "checksum differs from the manifest");
    const counts: Record<string, number> = {};
    let scratch: pg.Client | null = null;
    const schema = `verify_${randomBytes(4).toString("hex")}`;
    try {
      if (opts.deep) {
        scratch = await pgClient();
        await scratch.query(`CREATE SCHEMA ${q(schema)}`);
        for (const t of Object.keys(manifest.tables)) await scratch.query(`CREATE TABLE ${q(schema)}.${q(t)} (LIKE public.${q(t)} INCLUDING DEFAULTS)`);
      }
      const batch: Record<string, string[]> = {};
      const flush = async (t: string) => {
        if (scratch && batch[t]?.length) await scratch.query(`INSERT INTO ${q(schema)}.${q(t)} SELECT * FROM json_populate_recordset(null::public.${q(t)}, $1::json)`, [`[${batch[t]!.join(",")}]`]);
        batch[t] = [];
      };
      for await (const [t, json] of readArchive(path, manifest.encrypted, opts.key)) {
        if (t === "#manifest") continue;
        counts[t] = (counts[t] ?? 0) + 1;
        if (scratch) { (batch[t] ??= []).push(json); if (batch[t]!.length >= 500) await flush(t); }
      }
      for (const t of Object.keys(batch)) await flush(t);
      const bad = Object.entries(manifest.tables).filter(([t, n]) => (counts[t] ?? 0) !== n);
      push("decrypts and decompresses cleanly", true);
      push("row counts match the manifest", !bad.length, bad.map(([t, n]) => `${t}: expected ${n}, found ${counts[t] ?? 0}`).join("; ") || undefined);
      if (scratch) {
        const mismatched: string[] = [];
        for (const [t, n] of Object.entries(manifest.tables)) {
          const r = await scratch.query<{ c: string }>(`SELECT count(*)::text AS c FROM ${q(schema)}.${q(t)}`);
          if (Number(r.rows[0]!.c) !== n) mismatched.push(t);
        }
        push("loads into a scratch database schema", !mismatched.length, mismatched.join(", ") || undefined);
      }
    } finally {
      if (scratch) { await scratch.query(`DROP SCHEMA IF EXISTS ${q(schema)} CASCADE`).catch(() => undefined); await scratch.end(); }
    }
  } catch (err) {
    push("readable", false, err instanceof AppError ? err.message : (err as Error).message);
  }
  const ok = checks.every((c) => c.ok);
  if (ok) await db.backupRecord.update({ where: { id: recordId }, data: { verifiedAt: new Date() } });
  await transact((tx) => audit(tx, { action: ok ? "backup.verified" : "backup.verify_failed", module: "backup", entityType: "BackupRecord", entityId: recordId, metadata: { deep: !!opts.deep, checks } }));
  return { ok, checks };
}

// ───────────── Restore ─────────────

export const RestoreInput = z.object({ backupId: z.string().uuid(), confirm: z.string(), password: z.string().min(1) });

/**
 * Replace ALL data with the backup's contents. Guarded by: permission, the operator's password, typing
 * "RESTORE <installation code>", matching schema version, a successful verification, and an automatic safety
 * backup of the current state first. Runs in one transaction — a failed restore leaves the database untouched.
 */
export async function restoreBackup(ctx: SecurityContext, raw: z.input<typeof RestoreInput>, opts: { key?: Buffer } = {}) {
  const i = RestoreInput.parse(raw);
  const user = await db.user.findUniqueOrThrow({ where: { id: ctx.user.id } });
  if (!(await verifyPassword(user.passwordHash, i.password))) throw forbidden("Password confirmation failed");
  const rec = await db.backupRecord.findUnique({ where: { id: i.backupId } });
  if (!rec?.path || rec.status !== "SUCCEEDED") throw notFound("Backup");
  const path = safeBackupPath(rec.path);
  const manifest = await readManifest(path);
  const inst = await db.schoolInstallation.findFirst({ select: { installationCode: true } });
  const expected = `RESTORE ${manifest.installationCode ?? inst?.installationCode ?? ""}`;
  if (i.confirm.trim() !== expected) throw validation(`Type exactly "${expected}" to confirm`);
  const schema = await currentSchemaVersion();
  if (manifest.schemaVersion !== schema) throw conflict(`This backup was made with database version ${manifest.schemaVersion}, but this installation is at ${schema}. Restore with the matching application version, then upgrade.`);
  const check = await verifyBackup(i.backupId, { key: opts.key });
  if (!check.ok) throw new AppError("BACKUP_UNVERIFIED", "The backup failed verification and will not be restored", 422, check.checks);

  const safety = await runBackup(ctx, { reason: `pre-restore safety backup (restoring ${rec.id})` });

  const client = await pgClient();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica"); // defer FK/trigger checks while tables are refilled (needs the database owner/superuser)
    const tables = (await listTables(client)).filter((t) => !RESTORE_SKIP.has(t));
    await client.query(`TRUNCATE ${tables.map(q).join(", ")} RESTART IDENTITY CASCADE`);
    const batch: Record<string, string[]> = {};
    const flush = async (t: string) => {
      if (batch[t]?.length) await client.query(`INSERT INTO ${q(t)} SELECT * FROM json_populate_recordset(null::${q(t)}, $1::json)`, [`[${batch[t]!.join(",")}]`]);
      batch[t] = [];
    };
    for await (const [t, json] of readArchive(path, manifest.encrypted, opts.key)) {
      if (t === "#manifest" || RESTORE_SKIP.has(t)) continue;
      if (!tables.includes(t)) throw conflict(`The backup contains an unknown table "${t}"`);
      (batch[t] ??= []).push(json);
      if (batch[t]!.length >= 500) await flush(t);
    }
    for (const t of Object.keys(batch)) await flush(t);
    // Re-point every serial sequence past the restored maximum.
    const seqs = await client.query<{ table_name: string; column_name: string }>(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND column_default LIKE 'nextval(%'`);
    seqs.rows = seqs.rows.filter((r) => !RESTORE_SKIP.has(r.table_name));
    for (const s of seqs.rows) await client.query(`SELECT setval(pg_get_serial_sequence('public.${q(s.table_name)}', '${s.column_name}'), COALESCE((SELECT MAX(${q(s.column_name)}) FROM ${q(s.table_name)}), 0) + 1, false)`);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err instanceof AppError ? err : new AppError("RESTORE_FAILED", `Restore failed and was rolled back: ${(err as Error).message}`, 500);
  } finally {
    await client.end();
  }
  invalidateLicenseCache();
  // Written AFTER the restore, into the restored database, so the audit trail records who did it.
  await transact((tx) => audit(tx, { actorId: ctx.user.id, actorName: ctx.user.name, action: "backup.restored", module: "backup", entityType: "BackupRecord", entityId: rec.id, metadata: { safetyBackup: safety.record.id, rows: manifest.totalRows }, ip: ctx.ip }).catch(() => undefined));
  return { restoredRows: manifest.totalRows, safetyBackupId: safety.record.id };
}

// ───────────── Housekeeping ─────────────

export const listBackups = (take = 50) => db.backupRecord.findMany({ orderBy: { startedAt: "desc" }, take });

/** Keep the newest `keepDaily` backups plus the newest verified one; delete the rest (files + sidecars). */
export async function pruneBackups(keepDaily = 14): Promise<number> {
  const all = await db.backupRecord.findMany({ where: { status: "SUCCEEDED", path: { not: null } }, orderBy: { startedAt: "desc" } });
  const keep = new Set(all.slice(0, keepDaily).map((b) => b.id));
  const lastVerified = all.find((b) => b.verifiedAt);
  if (lastVerified) keep.add(lastVerified.id);
  let removed = 0;
  for (const b of all) {
    if (keep.has(b.id)) continue;
    const p = safeBackupPath(b.path!);
    await rm(p, { force: true });
    await rm(`${p}.manifest.json`, { force: true });
    await db.backupRecord.update({ where: { id: b.id }, data: { path: null, error: "pruned" } });
    removed += 1;
  }
  return removed;
}

export async function backupHealth() {
  const last = await db.backupRecord.findFirst({ where: { status: "SUCCEEDED" }, orderBy: { startedAt: "desc" } });
  const lastVerified = await db.backupRecord.findFirst({ where: { verifiedAt: { not: null } }, orderBy: { verifiedAt: "desc" } });
  const ageHours = last ? Math.round((Date.now() - last.startedAt.getTime()) / 3_600_000) : null;
  return { lastBackupAt: last?.startedAt ?? null, lastVerifiedAt: lastVerified?.verifiedAt ?? null, ageHours, stale: ageHours === null || ageHours > 36 };
}

export async function backupFileStream(recordId: string) {
  const rec = await db.backupRecord.findUnique({ where: { id: recordId } });
  if (!rec?.path) throw notFound("Backup");
  const p = safeBackupPath(rec.path);
  return { name: basename(p), size: (await stat(p)).size, stream: createReadStream(p) };
}

export async function diskUsage() {
  const files = await readdir(backupDir()).catch(() => []);
  let bytes = 0;
  for (const f of files) bytes += (await stat(join(backupDir(), f)).catch(() => ({ size: 0 }))).size;
  return { files: files.length, bytes };
}
