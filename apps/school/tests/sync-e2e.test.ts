import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { SignJWT, generateKeyPair } from "jose";
import { db } from "@/platform/db";
import { resetEnvCache } from "@/platform/env";
import { invalidateLicenseCache } from "@/platform/license";
import { authorize } from "@/platform/security/interceptor";
import * as people from "@/modules/people/service";
import * as academics from "@/modules/academics/service";
import * as backup from "@/modules/backup/service";
import * as fin from "@/modules/finance/service";
import { pushAll, purgeAckedQueue, requeueDead, syncOverview } from "@/modules/sync/worker";
import { registerWithCloud, sendHeartbeat, applyCommands, backupAndUpload } from "@/modules/sync/heartbeat";
import { resolveConflict, listConflicts } from "@/modules/sync/conflicts";
import { uploadBackupToCloud } from "@/modules/sync/backup-upload";
import { enqueueSync } from "@/platform/sync/outbox";
import { getFlagSource } from "./sync-helpers";
import * as cloudInst from "@cloud/server/installations";
import { detectOffline } from "@cloud/server/alerts";
import { signCommand } from "@cloud/server/signing";
import { startCloud, resetCloudDb, cloudDb } from "./cloud-harness";
import { ctxFor, seedAcademics } from "./fixtures";
import { makeUser, req, resetDb, sessionFor } from "./helpers";

let cloud: Awaited<ReturnType<typeof startCloud>>;
let S: Awaited<ReturnType<typeof seedAcademics>>;
const operator = { operatorEmail: "ops@smartschool.ng" };

async function register() {
  const { registrationToken } = await cloudInst.createInstallation(operator, { schoolName: "Greenfield College", plan: "standard", modules: ["students", "finance", "cbt", "attendance"] });
  const admin = await ctxFor("owner", "Owner-pass-123");
  const r = await registerWithCloud(admin, { cloudUrl: cloud.url, registrationToken });
  return { code: r.installationCode, token: registrationToken };
}
const makeKid = (n: string) => people.createStudent(S.admin, { firstName: n, lastName: "Sync", gender: "MALE", classId: S.jss1.id, medicalNotes: "PRIVATE-MEDICAL" });
const dueNow = () => db.syncQueue.updateMany({ where: { status: { in: ["FAILED", "PENDING"] } }, data: { nextAttemptAt: new Date(0) } });

beforeAll(async () => { cloud = await startCloud(); });
afterAll(async () => { await cloud.close(); });
beforeEach(async () => {
  process.env.BACKUP_DIR = "./.data/test-backups";
  resetEnvCache();
  await rm("./.data/test-backups", { recursive: true, force: true });
  await rm("./.data/test-cloud-backups", { recursive: true, force: true });
  await resetCloudDb();
  await resetDb();
  cloud.setOnline(true);
  cloud.setTamper(null);
  S = await seedAcademics();
});

describe("registration", () => {
  it("binds the school to the cloud: adopts the cloud's code, stores the secret encrypted, installs a verified license", async () => {
    const { code } = await register();
    const inst = await db.schoolInstallation.findFirstOrThrow();
    expect(inst.installationCode).toBe(code);
    expect(inst.cloudUrl).toBe(cloud.url);
    expect(inst.cloudSecretEnc).toMatch(/^v1\./);
    const lic = await db.license.findFirstOrThrow({ where: { isActive: true } });
    expect(lic).toMatchObject({ plan: "standard", status: "ACTIVE" });
    expect(lic.modules.sort()).toEqual(["attendance", "cbt", "finance", "students"]);
    const c = await cloudDb.installation.findUniqueOrThrow({ where: { code } });
    expect(c.status).toBe("ACTIVE");
    expect(c.secretEnc).not.toContain(inst.cloudSecretEnc!.split(".")[3]!); // stored encrypted independently on each side
    expect(await db.auditLog.count({ where: { action: "cloud.register" } })).toBe(1);
  });
  it("tokens are single-use, expire, and bad ones are refused", async () => {
    const { token } = await register();
    const admin = await ctxFor("owner", "Owner-pass-123");
    await expect(registerWithCloud(admin, { cloudUrl: cloud.url, registrationToken: token })).rejects.toMatchObject({ code: "REGISTRATION_REJECTED" });
    await expect(registerWithCloud(admin, { cloudUrl: cloud.url, registrationToken: "SSR-XXXX-not-a-real-token-at-all" })).rejects.toMatchObject({ code: "REGISTRATION_REJECTED" });
    await expect(registerWithCloud(admin, { cloudUrl: "http://127.0.0.1:1", registrationToken: token })).rejects.toMatchObject({ code: "CLOUD_UNREACHABLE" });
    const { registrationToken: t2 } = await cloudInst.createInstallation(operator, { schoolName: "Other" });
    await cloudDb.registrationToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(registerWithCloud(admin, { cloudUrl: cloud.url, registrationToken: t2 })).rejects.toMatchObject({ code: "REGISTRATION_REJECTED" });
  });
  it("unregistered schools simply do not sync (fully offline operation)", async () => {
    await makeKid("Solo");
    expect(await pushAll()).toMatchObject({ configured: false, sent: 0 });
    expect(await sendHeartbeat()).toMatchObject({ ok: false, configured: false });
    expect((await syncOverview()).pending).toBeGreaterThan(0);
  });
});

describe("push", () => {
  beforeEach(async () => { await register(); });

  it("sends only allow-listed fields, incrementally, and acknowledges", async () => {
    const kid = (await makeKid("Chidi")).student;
    const before = await db.syncQueue.count({ where: { status: "PENDING" } });
    const r = await pushAll();
    expect(r).toMatchObject({ configured: true, acked: before, conflicts: 0, rejected: 0 });
    expect(await db.syncQueue.count({ where: { status: "ACKED" } })).toBe(before);
    const rec = await cloudDb.syncedRecord.findFirstOrThrow({ where: { entityType: "student", entityId: kid.id } });
    expect(rec.payload).toMatchObject({ id: kid.id, firstName: "Chidi", admissionNumber: kid.admissionNumber });
    expect(JSON.stringify(rec.payload)).not.toContain("PRIVATE-MEDICAL"); // never leaves the school
    expect(JSON.stringify(rec.payload)).not.toContain("medicalNotes");
    // incremental: a second run sends nothing
    expect(await pushAll()).toMatchObject({ sent: 0 });
    await makeKid("Amaka");
    expect((await pushAll()).acked).toBeGreaterThan(0);
  });

  it("is idempotent: replaying already-acknowledged records changes nothing on the cloud", async () => {
    await makeKid("Replay");
    await pushAll();
    const cloudBefore = await cloudDb.syncedRecord.count();
    const ingestBefore = await cloudDb.syncIngest.count();
    await db.syncQueue.updateMany({ where: { status: "ACKED" }, data: { status: "PENDING", nextAttemptAt: new Date(0), ackedAt: null } });
    const r = await pushAll();
    expect(r.duplicates).toBe(r.sent);
    expect(r.acked).toBe(0);
    expect(await cloudDb.syncedRecord.count()).toBe(cloudBefore);
    expect(await cloudDb.syncIngest.count()).toBe(ingestBefore);
  });

  it("survives an outage: school keeps working, records queue with back-off, and everything arrives when the internet returns", async () => {
    cloud.setOnline(false);
    const kid = (await makeKid("Offline")).student; // normal operation continues
    await fin.createFeeStructure(S.admin, { name: "T1", termId: S.t1.id, items: [{ name: "Tuition", amount: 5000 }] });
    await fin.generateInvoice(S.admin, { studentId: kid.id, termId: S.t1.id });
    const r1 = await pushAll();
    expect(r1.failedNetwork).toBe(true);
    const failed = await db.syncQueue.findMany({ where: { status: "FAILED" } });
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((f) => f.retryCount === 1 && f.nextAttemptAt.getTime() > Date.now() && f.lastError?.includes("unreachable"))).toBe(true);
    expect((await pushAll()).sent).toBe(0); // not due: no hammering
    await dueNow();
    expect((await pushAll()).failedNetwork).toBe(true);
    expect((await db.syncQueue.findFirstOrThrow({ where: { status: "FAILED" } })).retryCount).toBe(2);
    cloud.setOnline(true);
    await dueNow();
    const back = await pushAll();
    expect(back.failedNetwork).toBe(false);
    expect(await db.syncQueue.count({ where: { status: { not: "ACKED" } } })).toBe(0);
    expect(await cloudDb.syncedRecord.count({ where: { entityType: "invoice" } })).toBe(1);
  });

  it("retries exhausted → dead-letter, then requeue after the problem is fixed", async () => {
    await makeKid("Dead");
    cloud.setOnline(false);
    for (let i = 0; i < 13; i++) { await dueNow(); await pushAll(); }
    expect(await db.syncQueue.count({ where: { status: "DEAD" } })).toBeGreaterThan(0);
    cloud.setOnline(true);
    expect(await requeueDead()).toBeGreaterThan(0);
    await pushAll();
    expect(await db.syncQueue.count({ where: { status: { not: "ACKED" } } })).toBe(0);
  });

  it("out-of-order delivery never downgrades the cloud copy", async () => {
    const kid = (await makeKid("Order")).student;
    await pushAll();
    await people.updateStudent(S.admin, kid.id, { version: kid.version, address: "x", firstName: "Order2" });
    await pushAll();
    const cur = await cloudDb.syncedRecord.findFirstOrThrow({ where: { entityId: kid.id } });
    expect(cur).toMatchObject({ version: 2 });
    // an old v1 record arrives late (fresh idempotency key, e.g. after a queue rebuild)
    await db.syncQueue.create({ data: { entityType: "student", entityId: kid.id, operation: "UPSERT", entityVersion: 1, idempotencyKey: `late-${kid.id}`, payload: { id: kid.id, firstName: "Old", version: 1 } } });
    const r = await pushAll();
    expect(r.duplicates).toBe(1);
    expect((await cloudDb.syncedRecord.findFirstOrThrow({ where: { entityId: kid.id } })).payload).toMatchObject({ firstName: "Order2", version: 2 });
  });

  it("the cloud refuses payloads that carry fields outside the allow-list (dead-lettered, never stored)", async () => {
    const kid = (await makeKid("Leak")).student;
    await pushAll();
    await db.syncQueue.create({ data: { entityType: "student", entityId: kid.id, operation: "UPSERT", entityVersion: 9, idempotencyKey: `leak-${kid.id}`, payload: { id: kid.id, firstName: "Leak", version: 9, medicalNotes: "secret" } } });
    const r = await pushAll();
    expect(r.rejected).toBe(1);
    const row = await db.syncQueue.findFirstOrThrow({ where: { idempotencyKey: `leak-${kid.id}` } });
    expect(row).toMatchObject({ status: "DEAD" });
    expect(row.lastError).toMatch(/not shared: medicalNotes/);
    expect((await cloudDb.syncedRecord.findFirstOrThrow({ where: { entityId: kid.id } })).version).toBe(1);
  });

  it("rejected credentials back off for an hour instead of hammering the cloud", async () => {
    await makeKid("Auth");
    cloud.setTamper((r) => { const h = new Headers(r.headers); h.set("x-ss-signature", "0".repeat(64)); return new Request(r, { headers: h, duplex: "half" } as RequestInit); });
    const r = await pushAll();
    expect(r.authRejected).toBe(true);
    const f = await db.syncQueue.findFirstOrThrow({ where: { status: "FAILED" } });
    expect(f.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);
    expect(f.lastError).toMatch(/rejected credentials/);
  });

  it("purges old acknowledged rows only", async () => {
    await makeKid("Purge");
    await pushAll();
    await db.syncQueue.updateMany({ where: { status: "ACKED" }, data: { ackedAt: new Date(Date.now() - 40 * 86_400_000) } });
    const removed = await purgeAckedQueue(30);
    expect(removed).toBeGreaterThan(0);
    expect(await db.syncQueue.count()).toBe(0);
  });
});

describe("conflicts (never overwritten silently)", () => {
  beforeEach(async () => { await register(); });

  async function diverge() {
    const kid = (await makeKid("Diverge")).student;
    await pushAll(); // cloud now has v1
    // e.g. the school restored an OLD backup and edited again: same version number, different content
    await db.syncQueue.create({ data: { entityType: "student", entityId: kid.id, operation: "UPSERT", entityVersion: 1, idempotencyKey: `div-${kid.id}`, payload: { id: kid.id, admissionNumber: kid.admissionNumber, firstName: "Different", lastName: "Sync", gender: "MALE", status: "ACTIVE", version: 1 } } });
    return kid;
  }

  it("same version + different content → conflict on both sides; cloud copy untouched; event + audit", async () => {
    const kid = await diverge();
    const r = await pushAll();
    expect(r.conflicts).toBe(1);
    const local = await db.syncConflict.findFirstOrThrow();
    expect(local).toMatchObject({ entityType: "student", entityId: kid.id, status: "OPEN", localVersion: 1, cloudVersion: 1 });
    expect(local.cloudPayload).toMatchObject({ firstName: "Diverge" });
    expect(await db.syncQueue.count({ where: { status: "CONFLICT" } })).toBe(1);
    expect(await cloudDb.cloudConflict.count({ where: { resolvedAt: null } })).toBe(1);
    expect((await cloudDb.syncedRecord.findFirstOrThrow({ where: { entityId: kid.id } })).payload).toMatchObject({ firstName: "Diverge" }); // NOT overwritten
    expect(await db.domainEvent.count({ where: { type: "sync.conflict_detected" } })).toBe(1);
    expect((await syncOverview()).openConflicts).toBe(1);
    // re-sending does not pile up duplicate conflicts
    await db.syncQueue.updateMany({ where: { status: "CONFLICT" }, data: { status: "PENDING" } });
    await pushAll();
    expect(await db.syncConflict.count({ where: { status: "OPEN" } })).toBe(1);
  });

  it("KEEP_LOCAL bumps the version above the cloud's and the cloud then accepts it", async () => {
    const kid = await diverge();
    await pushAll();
    const c = await db.syncConflict.findFirstOrThrow();
    const out = await resolveConflict(S.admin, c.id, { strategy: "KEEP_LOCAL", note: "Local is right" });
    expect(out).toMatchObject({ status: "RESOLVED_LOCAL", newVersion: 2 });
    expect((await db.studentProfile.findUniqueOrThrow({ where: { id: kid.id } })).version).toBe(2);
    await pushAll();
    expect((await cloudDb.syncedRecord.findFirstOrThrow({ where: { entityId: kid.id } })).version).toBe(2);
    expect(await db.syncQueue.count({ where: { status: { in: ["CONFLICT", "PENDING", "FAILED"] } } })).toBe(0);
    await expect(resolveConflict(S.admin, c.id, { strategy: "KEEP_LOCAL" })).rejects.toThrow(/already resolved/);
    expect((await db.auditLog.findFirstOrThrow({ where: { action: "sync.conflict_resolved" } })).metadata).toMatchObject({ note: "Local is right" });
    expect(await listConflicts("OPEN")).toHaveLength(0);
  });

  it("financial and student records can never be overwritten from the cloud copy", async () => {
    await diverge();
    await pushAll();
    const c = await db.syncConflict.findFirstOrThrow();
    await expect(resolveConflict(S.admin, c.id, { strategy: "ACCEPT_CLOUD" })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/cannot be overwritten/) });
    expect((await db.syncConflict.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("OPEN");
  });

  it("reference data may be restored from the cloud copy (subject rename)", async () => {
    const subj = await academics.createSubject(S.admin, { code: "GEO", name: "Geography" });
    await pushAll();
    await db.syncQueue.create({ data: { entityType: "subject", entityId: subj.id, operation: "UPSERT", entityVersion: 1, idempotencyKey: `s-${subj.id}`, payload: { id: subj.id, code: "GEO", name: "Geog (restored old)", isActive: true, version: 1 } } });
    await cloudDb.syncedRecord.updateMany({ where: { entityId: subj.id }, data: { recordedAt: new Date(Date.now() + 60_000) } }); // cloud copy is newer
    const r = await pushAll();
    expect(r.duplicates + r.conflicts).toBeGreaterThan(0);
    // LAST_WRITE_WINS: the cloud already holds the newer write → the older one is ignored, no conflict raised
    expect(await db.syncConflict.count()).toBe(0);
  });
});

describe("heartbeat, license and commands", () => {
  let code: string;
  beforeEach(async () => { ({ code } = await register()); });
  const inst = () => cloudDb.installation.findUniqueOrThrow({ where: { code } });

  it("reports health to the control tower and raises the right alerts", async () => {
    await makeKid("Health");
    const hb = await sendHeartbeat();
    expect(hb).toMatchObject({ ok: true, configured: true });
    const i = await inst();
    expect(i.lastHeartbeatAt).not.toBeNull();
    expect(i.appVersion).toBe("2.0.0");
    expect(i.studentCount).toBe(1);
    expect(i.lastMetrics).toMatchObject({ queuePending: expect.any(Number), dbOk: true });
    const kinds = (await cloudDb.alert.findMany({ where: { installationId: i.id, resolvedAt: null } })).map((a) => a.kind).sort();
    expect(kinds).toContain("BACKUP_STALE");
    expect(kinds).toContain("WORKER_DOWN");
    expect(await cloudDb.heartbeatLog.count()).toBe(1);
  });

  it("offline detection is an alert, never a lock-out; a heartbeat clears it", async () => {
    await sendHeartbeat();
    await cloudDb.installation.update({ where: { code }, data: { lastHeartbeatAt: new Date(Date.now() - 30 * 3_600_000) } });
    expect(await detectOffline()).toBe(1);
    expect((await cloudDb.alert.findFirstOrThrow({ where: { kind: "OFFLINE", resolvedAt: null } })).severity).toBe("CRITICAL");
    expect((await inst()).status).toBe("ACTIVE"); // nothing was disabled
    await sendHeartbeat();
    expect(await cloudDb.alert.count({ where: { kind: "OFFLINE", resolvedAt: null } })).toBe(0);
  });

  it("controlled remote disable: suspended → admin-only (data stays reachable), resumed → normal; requires a reason", async () => {
    const c = await inst();
    await makeUser({ username: "teacher1", roles: ["teacher"] });
    const teacherCookie = await sessionFor("teacher1");
    const ownerCookie = await sessionFor("owner", "Owner-pass-123");
    expect((await authorize({ permission: "students.view" }, req("/x", { cookie: teacherCookie }))).user.username).toBe("teacher1");

    await expect(cloudInst.suspendInstallation(operator, c.id, "no")).rejects.toThrow(/reason/);
    await cloudInst.suspendInstallation(operator, c.id, "Unpaid subscription");
    // Nothing changes until the school hears about it…
    invalidateLicenseCache();
    expect((await authorize({}, req("/x", { cookie: teacherCookie }))).user.username).toBe("teacher1");
    await sendHeartbeat();
    invalidateLicenseCache();
    await expect(authorize({}, req("/x", { cookie: teacherCookie }))).rejects.toMatchObject({ code: "INSTALLATION_SUSPENDED" });
    expect((await authorize({}, req("/x", { cookie: ownerCookie }))).user.isPrimaryAdmin).toBe(true); // admin can still export/back up
    await expect(authorize({ write: true }, req("/x", { cookie: ownerCookie, method: "POST", body: {} }))).rejects.toMatchObject({ code: "LICENSE_RESTRICTED" });
    expect((await authorize({ licenseExempt: true }, req("/x", { cookie: ownerCookie, method: "POST", body: {} }))).user.username).toBe("owner");

    await cloudInst.resumeInstallation(operator, c.id);
    await sendHeartbeat();
    invalidateLicenseCache();
    expect((await authorize({}, req("/x", { cookie: teacherCookie }))).user.username).toBe("teacher1");
    expect((await cloudDb.cloudAudit.findMany({ where: { action: { startsWith: "installation." } }, orderBy: { seq: "asc" } })).map((a) => a.action)).toEqual(expect.arrayContaining(["installation.suspend", "installation.resume"]));
  });

  it("an outage never degrades the school: with the cloud down, the license and modes stay exactly as they were", async () => {
    await sendHeartbeat();
    cloud.setOnline(false);
    const hb = await sendHeartbeat();
    expect(hb).toMatchObject({ ok: false, reason: "unreachable" });
    invalidateLicenseCache();
    const ownerCookie = await sessionFor("owner", "Owner-pass-123");
    expect((await authorize({ write: true }, req("/x", { cookie: ownerCookie, method: "POST", body: {} }))).user.username).toBe("owner");
    expect((await db.license.findFirstOrThrow({ where: { isActive: true } })).status).toBe("ACTIVE");
  });

  it("license changes and cloud feature flags flow down; local admins cannot override cloud-controlled flags", async () => {
    const c = await inst();
    await cloudInst.updateLicense(operator, c.id, { plan: "premium", modules: ["students", "finance", "cbt", "attendance", "communication"] });
    await cloudInst.setGlobalFlag(operator, "communication.sms", true, "SMS add-on");
    await cloudInst.setFeatureOverride(operator, c.id, "attendance.rfid", true);
    const hb = await sendHeartbeat();
    expect(hb.licenseChanged).toBe(true);
    expect(await db.license.count()).toBe(2); // history kept
    expect((await db.license.findFirstOrThrow({ where: { isActive: true } })).plan).toBe("premium");
    expect(await getFlagSource("communication.sms")).toMatchObject({ enabled: true, source: "CLOUD" });
    expect(await getFlagSource("attendance.rfid")).toMatchObject({ enabled: true, source: "CLOUD" });
    const { setFeatureFlag } = await import("@/modules/settings/service");
    await expect(setFeatureFlag(S.admin, "communication.sms", false)).rejects.toMatchObject({ code: "FORBIDDEN" });
    // an unchanged license does not create new rows
    expect((await sendHeartbeat()).licenseChanged).toBe(false);
    expect(await db.license.count()).toBe(2);
    // cloud releases control → local admin regains it
    await cloudInst.setGlobalFlag(operator, "communication.sms", false);
    await cloudDb.globalFlag.delete({ where: { key: "communication.sms" } });
    await cloudInst.setFeatureOverride(operator, c.id, "attendance.rfid", null);
    await sendHeartbeat();
    expect((await getFlagSource("communication.sms")).source).toBe("LOCAL");
  });

  it("signed commands run exactly once and are acknowledged; forged, foreign and expired commands are dropped", async () => {
    const c = await inst();
    const cmd = await cloudInst.issueCommand(operator, c.id, "MESSAGE", { text: "Maintenance tonight" });
    const hb = await sendHeartbeat();
    expect(hb.commandsApplied).toBe(1);
    expect((await db.systemSetting.findUniqueOrThrow({ where: { key: "cloud.message" } })).value).toMatchObject({ text: "Maintenance tonight" });
    await sendHeartbeat(); // acks the command
    expect((await cloudDb.command.findUniqueOrThrow({ where: { id: cmd.id } })).deliveredAt).not.toBeNull();
    expect((await sendHeartbeat()).commandsApplied).toBe(0);

    const before = await db.auditLog.count({ where: { action: "command.rejected" } });
    const evil = await generateKeyPair("EdDSA");
    const forged = await new SignJWT({ iss: "smartschool-cloud", sub: code, jti: "00000000-0000-4000-8000-0000000000aa", cmd: "MESSAGE", args: { text: "pwned" }, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 }).setProtectedHeader({ alg: "EdDSA" }).sign(evil.privateKey);
    const otherSchool = await signCommand({ code: "SS-OTHER", id: "00000000-0000-4000-8000-0000000000bb", cmd: "MESSAGE", args: { text: "wrong school" }, expiresAt: new Date(Date.now() + 600_000) });
    const expired = await signCommand({ code, id: "00000000-0000-4000-8000-0000000000cc", cmd: "MESSAGE", args: { text: "old" }, expiresAt: new Date(Date.now() - 600_000) });
    expect(await applyCommands([forged, otherSchool, expired, "garbage"], code)).toEqual([]);
    expect(await db.auditLog.count({ where: { action: "command.rejected" } })).toBe(before + 4);
    expect((await db.systemSetting.findUniqueOrThrow({ where: { key: "cloud.message" } })).value).toMatchObject({ text: "Maintenance tonight" });
  });

  it("REQUEST_BACKUP command queues a backup job (de-duplicated)", async () => {
    const c = await inst();
    await cloudInst.issueCommand(operator, c.id, "REQUEST_BACKUP");
    await sendHeartbeat();
    expect(await db.backgroundJob.count({ where: { type: "backup.run_and_upload", status: "QUEUED" } })).toBe(1);
  });
});

describe("cloud backup copy", () => {
  beforeEach(async () => { await register(); await makeKid("Backup"); });

  it("uploads the encrypted archive with checksum verification; a corrupt upload is refused", async () => {
    const { uploaded, backupId } = await backupAndUpload("test");
    expect(uploaded).toMatchObject({ ok: true });
    const up = await cloudDb.backupUpload.findFirstOrThrow();
    const local = await db.backupRecord.findFirstOrThrow({ where: { id: backupId } });
    expect(up.sha256).toBe(local.sha256);
    expect(Number(up.sizeBytes)).toBe(Number(local.sizeBytes));
    expect(await db.backupRecord.count({ where: { kind: "CLOUD" } })).toBe(1);
    // corrupt the checksum the school claims
    await db.backupRecord.update({ where: { id: backupId }, data: { sha256: "a".repeat(64) } });
    const bad = await uploadBackupToCloud(backupId);
    expect(bad).toMatchObject({ ok: false, reason: expect.stringMatching(/checksum/i) });
    expect(await cloudDb.backupUpload.count()).toBe(1);
    expect(backup).toBeTruthy();
    expect(enqueueSync).toBeTruthy();
  });
  it("cloud offline → upload fails softly and the local backup remains", async () => {
    const { record } = await backup.runBackup(S.admin);
    cloud.setOnline(false);
    expect(await uploadBackupToCloud(record.id)).toMatchObject({ ok: false, reason: "cloud unreachable" });
    expect((await db.backupRecord.findUniqueOrThrow({ where: { id: record.id } })).status).toBe("SUCCEEDED");
  });
});
