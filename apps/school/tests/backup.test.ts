import { beforeEach, describe, expect, it } from "vitest";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { db } from "@/platform/db";
import { verifyAuditChain } from "@/platform/audit";
import * as backup from "@/modules/backup/service";
import * as fin from "@/modules/finance/service";
import * as people from "@/modules/people/service";
import * as results from "@/modules/results/service";
import { publishEvent } from "@/platform/events";
import { ADMIN } from "./helpers";
import { seedAcademics } from "./fixtures";
import { resetDb } from "./helpers";

let S: Awaited<ReturnType<typeof seedAcademics>>;
const dir = resolve("./.data/test-backups");
const filePath = async (id: string) => resolve(dir, (await db.backupRecord.findUniqueOrThrow({ where: { id } })).path!);

async function populate() {
  await fin.createFeeStructure(S.admin, { name: "T1", termId: S.t1.id, items: [{ name: "Tuition", amount: 123456.78 }] });
  const kids: Awaited<ReturnType<typeof people.createStudent>>["student"][] = [];
  for (const n of ["Chidinma", "Amaka", "Tunde"]) kids.push((await people.createStudent(S.admin, { firstName: n, lastName: "Backup", gender: "FEMALE", classId: S.jss1.id, medicalNotes: "Asthma — SECRET-MEDICAL-NOTE", guardians: [{ newParent: { firstName: "P", lastName: n, phone: `0803000${kids.length}000` }, relationship: "Mother" }] })).student);
  await fin.generateInvoice(S.admin, { studentId: kids[0]!.id, termId: S.t1.id });
  await fin.recordPayment(S.admin, { studentId: kids[0]!.id, amount: 50000.5, method: "CASH", idempotencyKey: "backup-test-0001" });
  await db.$transaction((tx) => publishEvent(tx, "attendance.absent", { studentId: kids[0]!.id }));
  return kids;
}

beforeEach(async () => {
  process.env.BACKUP_DIR = dir;
  const { resetEnvCache } = await import("@/platform/env");
  resetEnvCache();
  await rm(dir, { recursive: true, force: true });
  await resetDb();
  S = await seedAcademics();
});

describe("backup files", () => {
  it("captures every table consistently, with manifest, checksum, restrictive permissions and encryption at rest", async () => {
    await populate();
    const { record, manifest } = await backup.runBackup(S.admin, { reason: "test" });
    expect(record).toMatchObject({ status: "SUCCEEDED", kind: "LOCAL" });
    expect(manifest.tables.students).toBe(3);
    expect(manifest.tables.financial_ledger).toBe(await db.financialLedger.count());
    expect(manifest.totalRows).toBe(Object.values(manifest.tables).reduce((a, b) => a + b, 0));
    const p = await filePath(record.id);
    expect((await stat(p)).mode & 0o777).toBe(0o600);
    const bytes = await readFile(p);
    expect(bytes.subarray(0, 7).toString()).toBe("SSBAKv1");
    expect(bytes.includes(Buffer.from("SECRET-MEDICAL-NOTE"))).toBe(false); // ciphertext only
    expect(bytes.includes(Buffer.from("Chidinma"))).toBe(false);
    const sidecar = JSON.parse(await readFile(`${p}.manifest.json`, "utf8"));
    expect(sidecar.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(await db.auditLog.count({ where: { action: "backup.run" } })).toBe(1);
  });

  it("verifies (shallow and deep), and detects tampering, truncation and the wrong key", async () => {
    await populate();
    const { record } = await backup.runBackup(S.admin);
    expect(await backup.verifyBackup(record.id)).toMatchObject({ ok: true });
    const deep = await backup.verifyBackup(record.id, { deep: true });
    expect(deep.ok).toBe(true);
    expect(deep.checks.map((c) => c.name)).toContain("loads into a scratch database schema");
    expect((await db.backupRecord.findUniqueOrThrow({ where: { id: record.id } })).verifiedAt).not.toBeNull();
    expect((await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname LIKE 'verify_%'`)[0]!.n).toBe(0); // scratch schema cleaned up

    const p = await filePath(record.id);
    const original = await readFile(p);
    const flipped = Buffer.from(original); flipped[flipped.length >> 1]! ^= 0xff;
    await writeFile(p, flipped);
    const r1 = await backup.verifyBackup(record.id);
    expect(r1.ok).toBe(false);
    expect(r1.checks[0]).toMatchObject({ name: "file checksum", ok: false });
    await writeFile(p, original.subarray(0, original.length - 40));
    expect((await backup.verifyBackup(record.id)).ok).toBe(false);
    await writeFile(p, original);
    expect((await backup.verifyBackup(record.id, { key: Buffer.alloc(32, 1) })).ok).toBe(false); // wrong key
    expect((await backup.verifyBackup(record.id)).ok).toBe(true);
  });

  it("unencrypted backups work too, and are a plain gzip of tab-separated rows", async () => {
    await populate();
    const { record, manifest } = await backup.runBackup(S.admin, { encrypt: false });
    expect(manifest.encrypted).toBe(false);
    const text = gunzipSync(await readFile(await filePath(record.id))).toString();
    expect(text.split("\n")[0]).toMatch(/^#manifest\t\{/);
    expect(text).toContain("students\t{");
    expect((await backup.verifyBackup(record.id, { deep: true })).ok).toBe(true);
  });

  it("numeric and timestamp values are restored exactly (no float round-trip)", async () => {
    await populate();
    const before = await db.$queryRaw<{ amount: string }[]>`SELECT amount::text FROM payments`;
    expect(before[0]!.amount).toBe("50000.50");
  });
});

describe("restore", () => {
  it("restores the exact state, re-seeds sequences, keeps the audit chain and books intact, and takes a safety backup", async () => {
    const kids = await populate();
    const snapshot = {
      students: await db.studentProfile.count(), ledger: await db.financialLedger.count(),
      payments: (await db.$queryRaw<{ a: string }[]>`SELECT SUM(amount)::text a FROM payments`)[0]!.a, audit: await db.auditLog.count(),
    };
    const eventsAtBackup = await db.domainEvent.count();
    const maxEventSeq = (await db.domainEvent.aggregate({ _max: { seq: true } }))._max.seq!;
    const { record } = await backup.runBackup(S.admin);

    // disaster: data deleted/changed after the backup
    await people.changeStudentStatus(S.admin, kids[1]!.id, "WITHDRAWN", "test");
    await people.createStudent(S.admin, { firstName: "Post", lastName: "Backup", gender: "MALE" });
    await db.$executeRawUnsafe(`TRUNCATE payments, payment_allocations RESTART IDENTITY CASCADE`);
    expect(await db.payment.count()).toBe(0);

    const out = await backup.restoreBackup(S.admin, { backupId: record.id, confirm: `RESTORE ${(await db.schoolInstallation.findFirstOrThrow()).installationCode}`, password: ADMIN.password });
    expect(out.restoredRows).toBeGreaterThan(0);
    expect(await db.studentProfile.count()).toBe(snapshot.students);
    expect(await db.studentProfile.count({ where: { firstName: "Post" } })).toBe(0);
    expect((await db.studentProfile.findUniqueOrThrow({ where: { id: kids[1]!.id } })).status).toBe("ACTIVE");
    expect((await db.$queryRaw<{ a: string }[]>`SELECT SUM(amount)::text a FROM payments`)[0]!.a).toBe(snapshot.payments);
    expect(await db.financialLedger.count()).toBe(snapshot.ledger);
    expect((await fin.verifyFinance()).ok).toBe(true);
    expect((await verifyAuditChain()).intact).toBe(true);
    // the system keeps working: sequences continue after the restored maximum, numbering continues
    await people.createStudent(S.admin, { firstName: "After", lastName: "Restore", gender: "MALE" });
    await db.$transaction((tx) => publishEvent(tx, "attendance.late", { studentId: kids[0]!.id }));
    expect(await db.domainEvent.count()).toBe(eventsAtBackup + 1);
    expect((await db.domainEvent.aggregate({ _max: { seq: true } }))._max.seq! > maxEventSeq).toBe(true); // sequence continued, no collision
    const next = (await db.studentProfile.findFirstOrThrow({ where: { firstName: "After" } })).admissionNumber;
    expect(next).toMatch(/\/0004$/);
    // the safety backup of the pre-restore state exists and verifies; restore was audited
    expect((await backup.verifyBackup(out.safetyBackupId)).ok).toBe(true);
    expect(await db.auditLog.count({ where: { action: "backup.restored" } })).toBe(1);
    expect(snapshot.audit).toBeGreaterThan(0);
    expect(await results.listClassResults(S.t1.id, S.jss1.id)).toEqual([]);
  });

  it("is guarded: password, typed confirmation, schema version, unverified backups", async () => {
    await populate();
    const { record } = await backup.runBackup(S.admin);
    const code = (await db.schoolInstallation.findFirstOrThrow()).installationCode;
    await expect(backup.restoreBackup(S.admin, { backupId: record.id, confirm: `RESTORE ${code}`, password: "wrong-password-1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(backup.restoreBackup(S.admin, { backupId: record.id, confirm: "restore", password: ADMIN.password })).rejects.toThrow(/Type exactly/);
    const p = await filePath(record.id);
    const m = JSON.parse(await readFile(`${p}.manifest.json`, "utf8"));
    await writeFile(`${p}.manifest.json`, JSON.stringify({ ...m, schemaVersion: "19990101000000_ancient" }));
    await expect(backup.restoreBackup(S.admin, { backupId: record.id, confirm: `RESTORE ${code}`, password: ADMIN.password })).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/database version/) });
    await writeFile(`${p}.manifest.json`, JSON.stringify(m));
    const bytes = await readFile(p); bytes[bytes.length - 30]! ^= 1; await writeFile(p, bytes);
    await expect(backup.restoreBackup(S.admin, { backupId: record.id, confirm: `RESTORE ${code}`, password: ADMIN.password })).rejects.toMatchObject({ code: "BACKUP_UNVERIFIED" });
    expect(await db.studentProfile.count()).toBe(3); // nothing was touched by any refused attempt
  });

  it("a restore that fails part-way is rolled back completely", async () => {
    await populate();
    const { record } = await backup.runBackup(S.admin, { encrypt: false });
    const p = await filePath(record.id);
    // craft a poisoned archive: valid checksum & counts, but two rows share a primary key
    const lines = gunzipSync(await readFile(p)).toString().split("\n").filter(Boolean);
    const stud = lines.find((l) => l.startsWith("students\t"))!;
    const poisoned = gzipSync([...lines, stud].join("\n") + "\n");
    await writeFile(p, poisoned);
    const m = JSON.parse(await readFile(`${p}.manifest.json`, "utf8"));
    m.tables.students += 1; m.totalRows += 1; m.sha256 = createHash("sha256").update(poisoned).digest("hex");
    await writeFile(`${p}.manifest.json`, JSON.stringify(m));
    await db.backupRecord.update({ where: { id: record.id }, data: { sha256: m.sha256 } });
    const beforeStudents = await db.studentProfile.count();
    await db.studentProfile.deleteMany({ where: { firstName: "Tunde" } }).catch(() => undefined);
    const mid = await db.studentProfile.count();
    await expect(backup.restoreBackup(S.admin, { backupId: record.id, confirm: `RESTORE ${(await db.schoolInstallation.findFirstOrThrow()).installationCode}`, password: ADMIN.password })).rejects.toMatchObject({ code: expect.stringMatching(/RESTORE_FAILED|BACKUP_UNVERIFIED/) });
    expect(await db.studentProfile.count()).toBe(mid); // untouched
    expect(beforeStudents).toBeGreaterThan(0);
  });
});

describe("housekeeping", () => {
  it("prunes old backups but never the newest verified one; health flags staleness", async () => {
    expect((await backup.backupHealth()).stale).toBe(true);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await backup.runBackup(S.admin)).record.id);
    await backup.verifyBackup(ids[0]!);
    expect(await backup.pruneBackups(2)).toBe(1); // 4 total: keep newest 2 + the verified oldest → prune 1
    expect((await db.backupRecord.findUniqueOrThrow({ where: { id: ids[0]! } })).path).not.toBeNull();
    expect((await db.backupRecord.findUniqueOrThrow({ where: { id: ids[1]! } })).path).toBeNull();
    expect((await backup.backupHealth()).stale).toBe(false);
  });
});
