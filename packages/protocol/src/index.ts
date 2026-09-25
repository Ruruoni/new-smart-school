/**
 * SmartSchool sync / control-plane wire protocol, shared by the school instance and the cloud.
 * Local school → cloud: incremental, idempotent record batches + heartbeats.
 * Cloud → local: signed license/command tokens returned on heartbeat (never pushed over an open port).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export * from "./entities";

// ───────────── Sync records ─────────────

export const SyncOperation = z.enum(["UPSERT", "DELETE"]);

export const SyncRecord = z.object({
  /// Stable across retries. The cloud treats a repeat as "already applied".
  idempotencyKey: z.string().min(8).max(200),
  entityType: z.string().min(1).max(64),
  entityId: z.string().min(1).max(64),
  operation: SyncOperation,
  entityVersion: z.number().int().min(1),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});
export type SyncRecord = z.infer<typeof SyncRecord>;

export const MAX_BATCH = 200;

export const SyncBatch = z.object({
  installationCode: z.string().min(3).max(64),
  sentAt: z.string().datetime(),
  records: z.array(SyncRecord).min(1).max(MAX_BATCH),
});
export type SyncBatch = z.infer<typeof SyncBatch>;

export const SyncResultStatus = z.enum(["ACKED", "DUPLICATE", "CONFLICT", "REJECTED"]);
export const SyncResult = z.object({
  idempotencyKey: z.string(),
  status: SyncResultStatus,
  cloudVersion: z.number().int().optional(),
  cloudPayload: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
});
export type SyncResult = z.infer<typeof SyncResult>;
export const SyncAck = z.object({ results: z.array(SyncResult) });
export type SyncAck = z.infer<typeof SyncAck>;

// ───────────── Heartbeat / control plane ─────────────

export const HeartbeatRequest = z.object({
  installationCode: z.string(),
  sentAt: z.string().datetime(),
  appVersion: z.string(),
  schemaVersion: z.string(),
  enabledModules: z.array(z.string()),
  metrics: z.object({
    queuePending: z.number().int().min(0),
    queueFailed: z.number().int().min(0),
    queueDead: z.number().int().min(0),
    openConflicts: z.number().int().min(0),
    oldestPendingAgeSec: z.number().min(0).nullable(),
    lastSyncAt: z.string().datetime().nullable(),
    dbOk: z.boolean(),
    workers: z.array(z.object({ name: z.string(), lastBeatAt: z.string().datetime(), status: z.string() })),
    recentErrors: z.array(z.string()).max(20),
    activeUsers: z.number().int().min(0),
    studentCount: z.number().int().min(0),
    lastBackupAt: z.string().datetime().nullable(),
  }),
  licenseStatus: z.string().nullable(),
  diagnostics: z.record(z.string(), z.unknown()).optional(),
  /// Command ids (JWS jti) this school has applied since its last successful heartbeat.
  appliedCommandIds: z.array(z.string()).max(100).default([]),
});
export type HeartbeatRequest = z.infer<typeof HeartbeatRequest>;

export const HeartbeatResponse = z.object({
  serverTime: z.string().datetime(),
  /// Compact Ed25519 JWS license token; verified locally against the embedded public key.
  licenseToken: z.string().nullable(),
  /// Cloud-controlled flags: winning over local toggles.
  flags: z.array(z.object({ key: z.string(), enabled: z.boolean() })),
  /// Signed one-shot commands (JWS). Each is independently verified by the school.
  commands: z.array(z.string()),
  /// Newest cloud release the school may upgrade to (informational).
  latestVersion: z.string().nullable(),
});
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

// ───────────── Signed claims (JWS payloads) ─────────────

export const LicenseClaims = z.object({
  iss: z.literal("smartschool-cloud"),
  sub: z.string(), // installationCode
  plan: z.string(),
  modules: z.array(z.string()),
  features: z.record(z.string(), z.boolean()).default({}),
  graceDays: z.number().int().min(0).default(30),
  status: z.enum(["ACTIVE", "SUSPENDED"]).default("ACTIVE"),
  iat: z.number(),
  exp: z.number(),
});
export type LicenseClaims = z.infer<typeof LicenseClaims>;

/**
 * Suspension/resumption and module entitlements travel inside the signed LICENSE token (status/modules), not as
 * commands, so there is exactly one mechanism and it is verifiable offline. Commands are one-shot actions.
 */
export const CommandType = z.enum([
  "MESSAGE", // banner shown to the Primary Admin
  "REQUEST_BACKUP", // run a backup now (and upload it if cloud backup is enabled)
  "REQUEST_DIAGNOSTICS", // include a diagnostics bundle in the next heartbeat
]);
export const CommandClaims = z.object({
  iss: z.literal("smartschool-cloud"),
  sub: z.string(), // installationCode
  jti: z.string(), // command id — recorded by the school so a replay is ignored
  cmd: CommandType,
  args: z.record(z.string(), z.unknown()).default({}),
  iat: z.number(),
  exp: z.number(),
});
export type CommandClaims = z.infer<typeof CommandClaims>;

// ───────────── Request signing (installation ↔ cloud) ─────────────

export const SIG_HEADERS = {
  installation: "x-ss-installation",
  timestamp: "x-ss-timestamp",
  signature: "x-ss-signature",
} as const;

export const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export function signBody(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function verifySignature(secret: string, timestamp: string, body: string, signature: string, now = Date.now()): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_CLOCK_SKEW_MS) return false;
  const expected = Buffer.from(signBody(secret, timestamp, body));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Retry back-off used by the sync worker: 5s, 15s, 1m, 5m, 15m, 1h (capped). */
export function backoffSeconds(retryCount: number): number {
  const steps = [5, 15, 60, 300, 900, 3600];
  return steps[Math.min(retryCount, steps.length - 1)]!;
}

export const MAX_SYNC_RETRIES = 12;

// ───────────── Registration ─────────────

export const RegisterRequest = z.object({
  registrationToken: z.string().min(16).max(200),
  schoolName: z.string().min(2).max(160),
  appVersion: z.string(),
  schemaVersion: z.string(),
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

export const RegisterResponse = z.object({
  installationCode: z.string(),
  /// Shared HMAC secret for signing subsequent requests. Shown once; the school stores it encrypted.
  secret: z.string(),
  licenseToken: z.string().nullable(),
});
export type RegisterResponse = z.infer<typeof RegisterResponse>;

export * from "./diagnostics";
