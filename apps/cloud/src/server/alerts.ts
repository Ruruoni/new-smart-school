import type { HeartbeatRequest } from "@smartschool/protocol";
import { db } from "./db";
import type { AlertSeverity, Installation } from "@cloud/generated/prisma/client";

export const OFFLINE_AFTER_MINUTES = 15;

interface Finding { kind: string; severity: AlertSeverity; message: string }

/** Pure: heartbeat metrics + installation state → the alerts that should currently be open. */
export function alertFindings(inst: Pick<Installation, "licenseExpiresAt" | "graceDays" | "appVersion">, m: HeartbeatRequest["metrics"], opts: { latestVersion?: string | null; now?: Date } = {}): Finding[] {
  const now = opts.now ?? new Date();
  const out: Finding[] = [];
  if (!m.dbOk) out.push({ kind: "DB_DOWN", severity: "CRITICAL", message: "The school's database health check is failing." });
  if (m.queueDead > 0) out.push({ kind: "SYNC_FAILURES", severity: "CRITICAL", message: `${m.queueDead} sync record(s) permanently failed and need attention.` });
  else if (m.queueFailed >= 10) out.push({ kind: "SYNC_FAILURES", severity: "WARNING", message: `${m.queueFailed} sync record(s) are failing and being retried.` });
  if (m.queuePending >= 500 || (m.oldestPendingAgeSec ?? 0) > 6 * 3600) out.push({ kind: "SYNC_BACKLOG", severity: (m.oldestPendingAgeSec ?? 0) > 24 * 3600 ? "CRITICAL" : "WARNING", message: `Sync backlog: ${m.queuePending} pending, oldest ${Math.round((m.oldestPendingAgeSec ?? 0) / 60)} min old.` });
  if (m.openConflicts > 0) out.push({ kind: "OPEN_CONFLICTS", severity: "WARNING", message: `${m.openConflicts} unresolved sync conflict(s).` });
  const staleWorkers = m.workers.filter((w) => now.getTime() - new Date(w.lastBeatAt).getTime() > 10 * 60_000);
  if (staleWorkers.length) out.push({ kind: "WORKER_DOWN", severity: "CRITICAL", message: `Background worker(s) not responding: ${staleWorkers.map((w) => w.name).join(", ")}.` });
  else if (!m.workers.length) out.push({ kind: "WORKER_DOWN", severity: "WARNING", message: "No background worker has reported in." });
  if (!m.lastBackupAt || now.getTime() - new Date(m.lastBackupAt).getTime() > 48 * 3600_000) out.push({ kind: "BACKUP_STALE", severity: "WARNING", message: m.lastBackupAt ? "The last successful backup is more than 48 hours old." : "No backup has ever completed." });
  if (inst.licenseExpiresAt) {
    const days = Math.ceil((inst.licenseExpiresAt.getTime() - now.getTime()) / 86_400_000);
    if (days <= 0) out.push({ kind: "LICENSE_EXPIRING", severity: "CRITICAL", message: `License expired ${-days} day(s) ago (grace ${inst.graceDays} days).` });
    else if (days <= 30) out.push({ kind: "LICENSE_EXPIRING", severity: days <= 7 ? "CRITICAL" : "WARNING", message: `License expires in ${days} day(s).` });
  }
  if (opts.latestVersion && inst.appVersion && inst.appVersion !== opts.latestVersion) out.push({ kind: "VERSION_OUTDATED", severity: "INFO", message: `Running ${inst.appVersion}; ${opts.latestVersion} is available.` });
  return out;
}

/** Open new alerts, keep existing ones, resolve those that cleared. One open alert per (installation, kind). */
export async function evaluateAlerts(inst: Installation, m: HeartbeatRequest["metrics"]) {
  const latest = (await db.release.findFirst({ orderBy: { publishedAt: "desc" } }))?.version ?? null;
  const findings = alertFindings(inst, m, { latestVersion: latest });
  const open = await db.alert.findMany({ where: { installationId: inst.id, resolvedAt: null } });
  const wanted = new Map(findings.map((f) => [f.kind, f]));
  for (const f of findings) {
    const cur = open.find((a) => a.kind === f.kind);
    if (!cur) await db.alert.create({ data: { installationId: inst.id, ...f } }).catch(() => undefined);
    else if (cur.message !== f.message || cur.severity !== f.severity) await db.alert.update({ where: { id: cur.id }, data: { message: f.message, severity: f.severity } });
  }
  for (const a of open) if (!wanted.has(a.kind) && a.kind !== "OFFLINE") await db.alert.update({ where: { id: a.id }, data: { resolvedAt: new Date() } });
  // A heartbeat proves the school is online again.
  await db.alert.updateMany({ where: { installationId: inst.id, kind: "OFFLINE", resolvedAt: null }, data: { resolvedAt: new Date() } });
}

/** Run periodically by the cloud: installations that stopped calling home get an OFFLINE alert (never a lock-out). */
export async function detectOffline(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - OFFLINE_AFTER_MINUTES * 60_000);
  const stale = await db.installation.findMany({ where: { status: { in: ["ACTIVE", "SUSPENDED"] }, registeredAt: { not: null }, OR: [{ lastHeartbeatAt: { lt: cutoff } }, { lastHeartbeatAt: null }] }, select: { id: true, lastHeartbeatAt: true } });
  let opened = 0;
  for (const s of stale) {
    const hours = s.lastHeartbeatAt ? Math.round((now.getTime() - s.lastHeartbeatAt.getTime()) / 3_600_000) : null;
    const sev: AlertSeverity = hours !== null && hours >= 24 ? "CRITICAL" : "WARNING";
    const msg = hours === null ? "The installation has never reported in." : `No heartbeat for ${hours >= 1 ? `${hours} h` : `${Math.round((now.getTime() - s.lastHeartbeatAt!.getTime()) / 60_000)} min`} — it may be offline (schools work normally offline).`;
    const existing = await db.alert.findFirst({ where: { installationId: s.id, kind: "OFFLINE", resolvedAt: null } });
    if (existing) { if (existing.message !== msg || existing.severity !== sev) await db.alert.update({ where: { id: existing.id }, data: { message: msg, severity: sev } }); }
    else { await db.alert.create({ data: { installationId: s.id, kind: "OFFLINE", severity: sev, message: msg } }).catch(() => undefined); opened += 1; }
  }
  return opened;
}

export async function acknowledgeAlert(id: string) {
  await db.alert.update({ where: { id }, data: { acknowledgedAt: new Date() } });
}
