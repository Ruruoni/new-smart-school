import { beforeEach, describe, expect, it } from "vitest";
import { SYNC_ENTITIES, signBody, verifySignature } from "@smartschool/protocol";
import { db, transact } from "@cloud/server/db";
import { alertFindings, detectOffline } from "@cloud/server/alerts";
import * as inst from "@cloud/server/installations";
import { ingestBatch } from "@cloud/server/sync";
import { authorizeOperator, createOperator, operatorFromToken, operatorLogin, operatorLogout, requireRole } from "@cloud/server/operators";
import { verifyOwnToken } from "@cloud/server/signing";
import { decryptSecret, encryptSecret, payloadHash } from "@cloud/server/crypto";
import { processHeartbeat } from "@cloud/server/heartbeat";

const actor = { operatorEmail: "ops@x.ng" };
async function reset() {
  const rows = await db.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await db.$executeRawUnsafe(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
}
const metrics = (over = {}) => ({ queuePending: 0, queueFailed: 0, queueDead: 0, openConflicts: 0, oldestPendingAgeSec: null, lastSyncAt: null, dbOk: true, workers: [{ name: "main", lastBeatAt: new Date().toISOString(), status: "OK" }], recentErrors: [], activeUsers: 1, studentCount: 10, lastBackupAt: new Date().toISOString(), ...over });
const batch = (code: string, records: object[]) => ({ installationCode: code, sentAt: new Date().toISOString(), records });
const rec = (id: string, version: number, payload: object, key = `student:${id}:v${version}:UPSERT`, entityType = "student", createdAt = new Date().toISOString()) => ({ idempotencyKey: key, entityType, entityId: id, operation: "UPSERT", entityVersion: version, payload: { id, version, ...payload }, createdAt });

beforeEach(reset);

describe("crypto & protocol", () => {
  it("secrets round-trip and tampering is detected", () => {
    const blob = encryptSecret("top-secret");
    expect(decryptSecret(blob)).toBe("top-secret");
    expect(() => decryptSecret(blob.slice(0, -3) + "AAA")).toThrow();
    expect(payloadHash({ a: 1, b: { c: 2, d: 3 } })).toBe(payloadHash({ b: { d: 3, c: 2 }, a: 1 }));
  });
  it("request signatures bind the timestamp and body, and expire", () => {
    const now = Date.now(), ts = String(now), sig = signBody("s3cret", ts, '{"a":1}');
    expect(verifySignature("s3cret", ts, '{"a":1}', sig, now)).toBe(true);
    expect(verifySignature("s3cret", ts, '{"a":2}', sig, now)).toBe(false);
    expect(verifySignature("other", ts, '{"a":1}', sig, now)).toBe(false);
    expect(verifySignature("s3cret", ts, '{"a":1}', sig, now + 6 * 60_000)).toBe(false); // replay after the window
  });
});

describe("installations & licensing", () => {
  it("creates unique codes and one-time tokens; the license is deterministic until terms change", async () => {
    const a = await inst.createInstallation(actor, { schoolName: "School A", modules: ["students", "finance"] });
    const b = await inst.createInstallation(actor, { schoolName: "School B" });
    expect(a.installation.code).not.toBe(b.installation.code);
    expect(a.registrationToken).toMatch(new RegExp(`^SSR-${a.installation.code}-`));
    expect(await db.registrationToken.count({ where: { tokenHash: a.registrationToken } })).toBe(0); // only the hash is stored
    const reg = await inst.registerInstallation({ registrationToken: a.registrationToken, schoolName: "School A", appVersion: "2.0.0", schemaVersion: "x" }, "1.2.3.4");
    const t1 = await inst.licenseTokenFor((await db.installation.findUniqueOrThrow({ where: { code: reg.installationCode } })));
    const t2 = await inst.licenseTokenFor((await db.installation.findUniqueOrThrow({ where: { code: reg.installationCode } })));
    expect(t1).toBe(t2); // same terms → identical token (schools store nothing new)
    const claims = await verifyOwnToken(t1!);
    expect(claims).toMatchObject({ sub: reg.installationCode, plan: "standard", status: "ACTIVE" });
    await inst.updateLicense(actor, a.installation.id, { plan: "premium" });
    expect(await inst.licenseTokenFor(await db.installation.findUniqueOrThrow({ where: { id: a.installation.id } }))).not.toBe(t1);
  });
  it("suspend requires a reason and is only valid from ACTIVE; every operator action is audited and audit is append-only", async () => {
    const { installation, registrationToken } = await inst.createInstallation(actor, { schoolName: "School S" });
    await expect(inst.suspendInstallation(actor, installation.id, "x")).rejects.toThrow(/reason/);
    await expect(inst.suspendInstallation(actor, installation.id, "Not yet registered")).rejects.toThrow(/pending/);
    await inst.registerInstallation({ registrationToken, schoolName: "School S", appVersion: "1", schemaVersion: "1" }, null);
    await inst.suspendInstallation(actor, installation.id, "Unpaid invoices");
    await expect(inst.suspendInstallation(actor, installation.id, "again please")).rejects.toThrow(/Already suspended/);
    const audit = await db.cloudAudit.findMany({ orderBy: { seq: "asc" } });
    expect(audit.map((a) => a.action)).toEqual(["installation.create", "installation.registered", "installation.suspend"]);
    await expect(db.cloudAudit.update({ where: { id: audit[0]!.id }, data: { action: "x" } })).rejects.toThrow(/append-only/);
    await expect(db.$executeRawUnsafe(`DELETE FROM cloud_audit`)).rejects.toThrow(/append-only/);
  });
  it("decommissioned installations lose their secret and can no longer authenticate", async () => {
    const { installation, registrationToken } = await inst.createInstallation(actor, { schoolName: "School D" });
    const reg = await inst.registerInstallation({ registrationToken, schoolName: "School D", appVersion: "1", schemaVersion: "1" }, null);
    await inst.decommissionInstallation(actor, installation.id, "Contract ended");
    const body = "{}", ts = String(Date.now());
    const r = new Request("http://x/api", { method: "POST", headers: { "x-ss-installation": reg.installationCode, "x-ss-timestamp": ts, "x-ss-signature": signBody(reg.secret, ts, body) }, body });
    await expect(inst.authenticateInstallation(r, body)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
  it("unknown installation and wrong signature give the same answer", async () => {
    const body = "{}", ts = String(Date.now());
    const mk = (code: string, sig: string) => new Request("http://x/api", { method: "POST", headers: { "x-ss-installation": code, "x-ss-timestamp": ts, "x-ss-signature": sig }, body });
    const a = await inst.authenticateInstallation(mk("SS-NOPE", "0".repeat(64)), body).catch((e) => e);
    expect(a.message).toBe("Invalid signature");
  });
});

describe("sync ingest rules", () => {
  async function registered() {
    const { installation, registrationToken } = await inst.createInstallation(actor, { schoolName: "Sync" });
    await inst.registerInstallation({ registrationToken, schoolName: "Sync", appVersion: "1", schemaVersion: "1" }, null);
    return db.installation.findUniqueOrThrow({ where: { id: installation.id } });
  }
  it("higher version replaces, lower is stale, same+same is duplicate", async () => {
    const i = await registered();
    const id = "11111111-1111-4111-8111-111111111111";
    const r1 = await ingestBatch(i, batch(i.code, [rec(id, 1, { firstName: "A" }), rec(id, 3, { firstName: "C" }), rec(id, 2, { firstName: "B" }), rec(id, 3, { firstName: "C" }, "key-other-001")]));
    expect(r1.results.map((r) => r.status)).toEqual(["ACKED", "ACKED", "DUPLICATE", "DUPLICATE"]);
    expect((await db.syncedRecord.findFirstOrThrow()).payload).toMatchObject({ firstName: "C", version: 3 });
  });
  it("reference data is last-write-wins; money/students raise conflicts", async () => {
    const i = await registered();
    const sid = "22222222-2222-4222-8222-222222222222", pid = "33333333-3333-4333-8333-333333333333";
    const older = new Date(Date.now() - 60_000).toISOString(), newer = new Date().toISOString();
    await ingestBatch(i, batch(i.code, [rec(sid, 1, { code: "MTH", name: "Maths" }, "key-subject-01", "subject", older), rec(pid, 1, { amount: "100.00" }, "key-payment-01", "payment")]));
    const r = await ingestBatch(i, batch(i.code, [rec(sid, 1, { code: "MTH", name: "Mathematics" }, "key-subject-02", "subject", newer), rec(pid, 1, { amount: "999.00" }, "key-payment-02", "payment")]));
    expect(r.results.map((x) => x.status)).toEqual(["ACKED", "CONFLICT"]); // LWW applied for subject; payment diverged → human
    expect((await db.syncedRecord.findFirstOrThrow({ where: { entityType: "subject" } })).payload).toMatchObject({ name: "Mathematics" });
    expect((await db.syncedRecord.findFirstOrThrow({ where: { entityType: "payment" } })).payload).toMatchObject({ amount: "100.00" });
    // the older subject write arriving afterwards loses
    const late = await ingestBatch(i, batch(i.code, [rec(sid, 1, { code: "MTH", name: "Old name" }, "key-subject-03", "subject", older)]));
    expect(late.results[0]!.status).toBe("DUPLICATE");
  });
  it("rejects unknown entity types, foreign ids and non-listed fields; validates batch size/shape; other schools' batches", async () => {
    const i = await registered();
    const id = "44444444-4444-4444-8444-444444444444";
    const r = await ingestBatch(i, batch(i.code, [rec(id, 1, { firstName: "X", ssn: "1" }, "key-alpha-001"), rec(id, 1, {}, "key-beta-0001", "secret_table"), { ...rec(id, 1, { firstName: "Y" }, "key-gamma-001"), entityId: "someone-else" }]));
    expect(r.results.map((x) => x.status)).toEqual(["REJECTED", "REJECTED", "REJECTED"]);
    expect(await db.syncedRecord.count()).toBe(0);
    await expect(ingestBatch(i, batch(i.code, []))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(ingestBatch(i, batch("SS-OTHER", [rec(id, 1, {})]))).rejects.toMatchObject({ message: /does not belong/ });
    await expect(ingestBatch(i, { installationCode: i.code, sentAt: "now", records: [{}] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(Object.keys(SYNC_ENTITIES).length).toBeGreaterThan(10);
  });
  it("concurrent identical batches are safe (idempotency under a race)", async () => {
    const i = await registered();
    const id = "55555555-5555-4555-8555-555555555555";
    const b = batch(i.code, [rec(id, 1, { firstName: "Race" }, "race-key-0001")]);
    const results = await Promise.all(Array.from({ length: 6 }, () => ingestBatch(i, b)));
    const statuses = results.map((r) => r.results[0]!.status);
    expect(statuses.filter((s) => s === "ACKED")).toHaveLength(1);
    expect(statuses.filter((s) => s === "DUPLICATE")).toHaveLength(5);
    expect(await db.syncedRecord.count()).toBe(1);
    expect(await db.syncIngest.count()).toBe(1);
  });
});

describe("alerts", () => {
  const base = { licenseExpiresAt: new Date(Date.now() + 200 * 86_400_000), graceDays: 30, appVersion: "2.0.0" };
  const kinds = (m: object, i = base, o = {}) => alertFindings(i, metrics(m) as never, o).map((f) => f.kind).sort();
  it("healthy school → no alerts", () => expect(kinds({})).toEqual([]));
  it("each failure mode maps to the right alert and severity", () => {
    expect(kinds({ dbOk: false })).toContain("DB_DOWN");
    expect(alertFindings(base, metrics({ queueDead: 2 }) as never).find((f) => f.kind === "SYNC_FAILURES")?.severity).toBe("CRITICAL");
    expect(kinds({ queuePending: 900 })).toContain("SYNC_BACKLOG");
    expect(kinds({ openConflicts: 1 })).toContain("OPEN_CONFLICTS");
    expect(kinds({ workers: [] })).toContain("WORKER_DOWN");
    expect(kinds({ workers: [{ name: "w", lastBeatAt: new Date(Date.now() - 3_600_000).toISOString(), status: "OK" }] })).toContain("WORKER_DOWN");
    expect(kinds({ lastBackupAt: null })).toContain("BACKUP_STALE");
    expect(kinds({}, { ...base, licenseExpiresAt: new Date(Date.now() + 5 * 86_400_000) })).toContain("LICENSE_EXPIRING");
    expect(alertFindings({ ...base, licenseExpiresAt: new Date(Date.now() - 86_400_000) }, metrics() as never).find((f) => f.kind === "LICENSE_EXPIRING")?.severity).toBe("CRITICAL");
    expect(kinds({}, base, { latestVersion: "2.1.0" })).toContain("VERSION_OUTDATED");
  });
  it("heartbeat opens, updates and resolves alerts; offline sweep never suspends anything", async () => {
    const { installation, registrationToken } = await inst.createInstallation(actor, { schoolName: "School H" });
    await inst.registerInstallation({ registrationToken, schoolName: "School H", appVersion: "2.0.0", schemaVersion: "1" }, null);
    const i = await db.installation.findUniqueOrThrow({ where: { id: installation.id } });
    const hb = (m: object) => processHeartbeat(i, { installationCode: i.code, sentAt: new Date().toISOString(), appVersion: "2.0.0", schemaVersion: "1", enabledModules: [], metrics: metrics(m), licenseStatus: "ACTIVE", appliedCommandIds: [] }, null);
    await hb({ openConflicts: 2 });
    expect(await db.alert.count({ where: { kind: "OPEN_CONFLICTS", resolvedAt: null } })).toBe(1);
    await hb({ openConflicts: 3 });
    expect((await db.alert.findFirstOrThrow({ where: { kind: "OPEN_CONFLICTS" } })).message).toMatch(/3 unresolved/);
    await hb({ openConflicts: 0 });
    expect(await db.alert.count({ where: { kind: "OPEN_CONFLICTS", resolvedAt: null } })).toBe(0);
    await db.installation.update({ where: { id: i.id }, data: { lastHeartbeatAt: new Date(Date.now() - 3_600_000) } });
    expect(await detectOffline()).toBe(1);
    expect(await detectOffline()).toBe(0); // one open OFFLINE alert, no duplicates
    expect((await db.installation.findUniqueOrThrow({ where: { id: i.id } })).status).toBe("ACTIVE");
  });
});

describe("operators", () => {
  it("login, session, logout, lockout, roles", async () => {
    await createOperator({ email: "Boss@X.ng", name: "Boss", password: "correct-horse-battery", role: "SUPER_ADMIN" });
    await createOperator({ email: "view@x.ng", name: "Viewer", password: "correct-horse-battery", role: "VIEWER" });
    await expect(createOperator({ email: "weak@x.ng", name: "Weak", password: "short", role: "VIEWER" })).rejects.toThrow();
    const s = await operatorLogin("boss@x.ng", "correct-horse-battery", null);
    expect((await operatorFromToken(s.token))?.email).toBe("boss@x.ng");
    expect((await db.operatorSession.findFirstOrThrow()).tokenHash).not.toBe(s.token);
    await operatorLogout(s.token);
    expect(await operatorFromToken(s.token)).toBeNull();
    for (let i = 0; i < 5; i++) await operatorLogin("boss@x.ng", "wrong-password-1", null).catch(() => undefined);
    await expect(operatorLogin("boss@x.ng", "correct-horse-battery", null)).rejects.toMatchObject({ code: "LOCKED" });
    const v = await operatorLogin("view@x.ng", "correct-horse-battery", null);
    const viewer = await operatorFromToken(v.token);
    expect(() => requireRole(viewer, "SUPPORT")).toThrow(/support role/);
    expect(requireRole(viewer, "VIEWER")).toBeTruthy();
    const mk = (method: string, headers: Record<string, string> = {}) => new Request("http://cloud.local/api/x", { method, headers: { host: "cloud.local", cookie: `ss_cloud_session=${v.token}`, ...headers } });
    await expect(authorizeOperator(mk("POST", { origin: "http://evil.example" }), "VIEWER")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(authorizeOperator(mk("GET"), "SUPER_ADMIN")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await authorizeOperator(mk("POST", { origin: "http://cloud.local" }), "VIEWER")).email).toBe("view@x.ng");
    expect(transact).toBeTruthy();
  });
});
