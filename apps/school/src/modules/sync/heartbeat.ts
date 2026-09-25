import { CommandClaims, HeartbeatResponse, RegisterResponse, type HeartbeatRequest } from "@smartschool/protocol";
import { importSPKI, jwtVerify } from "jose";
import { db, transact, type Tx } from "@/platform/db";
import { env } from "@/platform/env";
import { audit } from "@/platform/audit";
import { encryptSecret } from "@/platform/crypto";
import { invalidateLicenseCache, storeLicense, verifyLicenseToken, currentLicense } from "@/platform/license";
import { enabledModules } from "@/platform/features";
import { currentSchemaVersion, runBackup, backupHealth } from "@/modules/backup/service";
import { enqueueJob } from "@/platform/jobs";
import type { SecurityContext } from "@/platform/security/context";
import { auditIn } from "@/platform/security/interceptor";
import { forbidden, validation } from "@/platform/errors";
import { CloudRejected, CloudUnreachable, cloudConfig, postRegistration, signedPost } from "./client";
import { syncOverview } from "./worker";

// ───────────── Registration ─────────────

/**
 * Bind this installation to the control plane using the one-time token the operator gave the school.
 * The cloud assigns the definitive installation code and a shared secret (stored encrypted here).
 */
export async function registerWithCloud(ctx: SecurityContext, input: { cloudUrl: string; registrationToken: string }) {
  if (!ctx.user.isPrimaryAdmin && !ctx.can("settings.edit")) throw forbidden();
  const url = input.cloudUrl.trim().replace(/\/$/, "");
  if (!/^https?:\/\//.test(url)) throw validation("Enter the full cloud address, e.g. https://cloud.example.com");
  const inst = await db.schoolInstallation.findFirstOrThrow();
  let res: RegisterResponse;
  try {
    res = RegisterResponse.parse(await postRegistration(url, { registrationToken: input.registrationToken.trim(), schoolName: inst.schoolName, appVersion: inst.appVersion, schemaVersion: await currentSchemaVersion() }));
  } catch (err) {
    if (err instanceof CloudUnreachable) throw new (await import("@/platform/errors")).AppError("CLOUD_UNREACHABLE", "The cloud could not be reached. Check the address and the internet connection.", 502);
    if (err instanceof CloudRejected) throw new (await import("@/platform/errors")).AppError("REGISTRATION_REJECTED", err.message, 400);
    throw err;
  }
  await transact(async (tx) => {
    await tx.schoolInstallation.update({ where: { id: inst.id }, data: { installationCode: res.installationCode, cloudSecretEnc: encryptSecret(res.secret), cloudUrl: url, registeredAt: new Date(), version: { increment: 1 } } });
    await auditIn(tx, ctx, { action: "cloud.register", module: "sync", entityType: "SchoolInstallation", entityId: inst.id, after: { installationCode: res.installationCode, cloudUrl: url } });
  });
  if (res.licenseToken) await applyLicenseToken(res.licenseToken, res.installationCode);
  return { installationCode: res.installationCode };
}

async function applyLicenseToken(token: string, code: string) {
  try {
    const claims = await verifyLicenseToken(token, code);
    const cur = await db.license.findFirst({ where: { isActive: true } });
    if (cur?.token === token) { await db.license.update({ where: { id: cur.id }, data: { lastVerifiedAt: new Date() } }); return false; }
    await transact((tx) => storeLicense(tx, token, claims));
    await transact((tx) => audit(tx, { action: "license.updated", module: "platform", metadata: { plan: claims.plan, status: claims.status, expiresAt: new Date(claims.exp * 1000).toISOString() } }));
    return true;
  } catch (err) {
    // A token we cannot verify is IGNORED: it never grants or removes anything. The previous license stays in force.
    await transact((tx) => audit(tx, { action: "license.rejected", module: "platform", metadata: { reason: (err as Error).message.slice(0, 200) } }));
    return false;
  }
}

// ───────────── Metrics ─────────────

export async function collectMetrics(): Promise<HeartbeatRequest["metrics"]> {
  const [ov, workers, students, backup] = await Promise.all([syncOverview(), db.workerHeartbeat.findMany(), db.studentProfile.count({ where: { deletedAt: null, status: "ACTIVE" } }), backupHealth()]);
  let dbOk = true;
  try { await db.$queryRaw`SELECT 1`; } catch { dbOk = false; }
  const recent = await db.auditLog.findMany({ where: { action: { in: ["sync.conflict_detected", "event.parked", "backup.verify_failed"] }, occurredAt: { gt: new Date(Date.now() - 86_400_000) } }, orderBy: { occurredAt: "desc" }, take: 10, select: { action: true, occurredAt: true } });
  return {
    queuePending: ov.pending + ov.inFlight, queueFailed: ov.failed, queueDead: ov.dead, openConflicts: ov.openConflicts, oldestPendingAgeSec: ov.oldestPendingAgeSec,
    lastSyncAt: ov.lastSyncAt?.toISOString() ?? null, dbOk,
    workers: workers.map((w) => ({ name: w.name, lastBeatAt: w.lastBeatAt.toISOString(), status: w.status })),
    recentErrors: recent.map((r) => `${r.occurredAt.toISOString()} ${r.action}`), activeUsers: await db.session.count({ where: { revokedAt: null, expiresAt: { gt: new Date() }, lastSeenAt: { gt: new Date(Date.now() - 15 * 60_000) } } }),
    studentCount: students, lastBackupAt: backup.lastBackupAt?.toISOString() ?? null,
  };
}

// ───────────── Signed commands ─────────────

const APPLIED_KEY = "cloud.appliedCommands";

async function appliedCommands(): Promise<string[]> {
  return ((await db.systemSetting.findUnique({ where: { key: APPLIED_KEY } }))?.value as string[] | undefined) ?? [];
}
const rememberApplied = async (tx: Tx, ids: string[]) => {
  const merged = [...new Set([...(((await tx.systemSetting.findUnique({ where: { key: APPLIED_KEY } }))?.value as string[] | undefined) ?? []), ...ids])].slice(-200);
  await tx.systemSetting.upsert({ where: { key: APPLIED_KEY }, create: { key: APPLIED_KEY, value: merged }, update: { value: merged } });
};

async function verifyCommand(token: string, code: string) {
  const b64 = env().CLOUD_PUBLIC_KEY;
  if (!b64) throw new Error("CLOUD_PUBLIC_KEY is not configured");
  const key = await importSPKI(Buffer.from(b64, "base64").toString("utf8"), "EdDSA");
  const { payload } = await jwtVerify(token, key, { issuer: "smartschool-cloud", subject: code, algorithms: ["EdDSA"] });
  return CommandClaims.parse(payload);
}

/** Apply each signed command exactly once (jti recorded); unsigned/forged/expired/foreign commands are dropped and audited. */
export async function applyCommands(tokens: string[], code: string): Promise<string[]> {
  const done = new Set(await appliedCommands());
  const applied: string[] = [];
  for (const token of tokens) {
    let cmd;
    try { cmd = await verifyCommand(token, code); }
    catch (err) { await transact((tx) => audit(tx, { action: "command.rejected", module: "sync", metadata: { reason: (err as Error).message.slice(0, 200) } })); continue; }
    if (done.has(cmd.jti)) { applied.push(cmd.jti); continue; } // already applied: just re-acknowledge
    try {
      await transact(async (tx) => {
        if (cmd.cmd === "MESSAGE") {
          const value = { text: String(cmd.args.text ?? "").slice(0, 500), at: new Date().toISOString(), id: cmd.jti };
          await tx.systemSetting.upsert({ where: { key: "cloud.message" }, create: { key: "cloud.message", value }, update: { value } });
        } else if (cmd.cmd === "REQUEST_BACKUP") {
          await enqueueJob(tx, "backups", "backup.run_and_upload", { reason: "cloud request", commandId: cmd.jti }, { dedupeKey: "backup.run_and_upload" });
        } else if (cmd.cmd === "REQUEST_DIAGNOSTICS") {
          await tx.systemSetting.upsert({ where: { key: "cloud.diagnosticsRequested" }, create: { key: "cloud.diagnosticsRequested", value: { at: new Date().toISOString() } }, update: { value: { at: new Date().toISOString() } } });
        }
        await rememberApplied(tx, [cmd.jti]);
        await audit(tx, { action: `command.${cmd.cmd.toLowerCase()}`, module: "sync", metadata: { commandId: cmd.jti } });
      });
      applied.push(cmd.jti);
    } catch (err) {
      await transact((tx) => audit(tx, { action: "command.failed", module: "sync", metadata: { commandId: cmd.jti, error: (err as Error).message.slice(0, 200) } }));
    }
  }
  return applied;
}

/** Cloud-controlled flags override local toggles; flags the cloud stops controlling return to local control. */
async function applyFlags(flags: { key: string; enabled: boolean }[]) {
  await transact(async (tx) => {
    for (const f of flags) await tx.featureFlag.upsert({ where: { key: f.key }, create: { key: f.key, enabled: f.enabled, module: f.key.split(".")[0], source: "CLOUD" }, update: { enabled: f.enabled, source: "CLOUD" } });
    await tx.featureFlag.updateMany({ where: { source: "CLOUD", key: { notIn: flags.map((f) => f.key) } }, data: { source: "LOCAL" } });
  });
  invalidateLicenseCache();
}

// ───────────── Heartbeat ─────────────

export interface HeartbeatOutcome {
  ok: boolean;
  configured: boolean;
  reason?: string;
  licenseChanged?: boolean;
  commandsApplied?: number;
  latestVersion?: string | null;
}

let pendingAcks: string[] = [];

/** One call home. Failure is normal (offline) and changes nothing locally: silence never degrades the school. */
export async function sendHeartbeat(): Promise<HeartbeatOutcome> {
  const cfg = await cloudConfig();
  if (!cfg) return { ok: false, configured: false, reason: "not registered" };
  const inst = await db.schoolInstallation.findFirstOrThrow({ select: { appVersion: true } });
  const license = await currentLicense();
  const diag = await db.systemSetting.findUnique({ where: { key: "cloud.diagnosticsRequested" } });
  const req: HeartbeatRequest = {
    installationCode: cfg.code, sentAt: new Date().toISOString(), appVersion: inst.appVersion, schemaVersion: await currentSchemaVersion(),
    enabledModules: await enabledModules(), metrics: await collectMetrics(), licenseStatus: license.status,
    appliedCommandIds: [...new Set([...pendingAcks, ...(await appliedCommands()).slice(-20)])].slice(0, 100),
    ...(diag ? { diagnostics: await diagnosticsBundle() } : {}),
  };
  let res: HeartbeatResponse;
  try {
    res = HeartbeatResponse.parse(await signedPost(cfg, "/api/v1/heartbeat", req));
  } catch (err) {
    return { ok: false, configured: true, reason: err instanceof CloudUnreachable ? "unreachable" : err instanceof CloudRejected ? `rejected (${err.status})` : (err as Error).message };
  }
  if (diag) await db.systemSetting.delete({ where: { key: "cloud.diagnosticsRequested" } }).catch(() => undefined);
  const licenseChanged = res.licenseToken ? await applyLicenseToken(res.licenseToken, cfg.code) : false;
  await applyFlags(res.flags);
  const applied = await applyCommands(res.commands, cfg.code);
  pendingAcks = applied;
  return { ok: true, configured: true, licenseChanged, commandsApplied: applied.length, latestVersion: res.latestVersion };
}

async function diagnosticsBundle() {
  const [ov, backup] = await Promise.all([syncOverview(), backupHealth()]);
  return { node: process.version, uptimeSec: Math.round(process.uptime()), memoryMb: Math.round(process.memoryUsage().rss / 1e6), sync: ov, backup, generatedAt: new Date().toISOString() };
}

/** Called after a REQUEST_BACKUP command or on schedule: backup then (if registered) upload the encrypted archive. */
export async function backupAndUpload(reason: string) {
  const { record } = await runBackup(null, { reason });
  const { uploadBackupToCloud } = await import("./backup-upload");
  const uploaded = await uploadBackupToCloud(record.id).catch((err) => ({ ok: false as const, reason: (err as Error).message }));
  return { backupId: record.id, uploaded };
}
