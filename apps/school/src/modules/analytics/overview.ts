import { db } from "@/platform/db";
import { enabledModules } from "@/platform/features";
import type { SecurityContext } from "@/platform/security/context";
import { workerStatus } from "@/platform/worker-status";
import { syncOverview } from "@/modules/sync/worker";
import { backupHealth } from "@/modules/backup/service";

export interface AttentionItem { key: string; label: string; count: number; href: string; tone: "bad" | "warn" | "info" }

/**
 * The admin dashboard's LIVE panel: things waiting on a person, and the health of the machinery behind the school
 * (worker, sync, queues, backups, licence). Every query here is a cheap indexed count, run fresh on each request, so what
 * you see is what is true now — unlike the KPI snapshots. Each section is included only if the caller may see it AND the
 * module behind it is enabled; the server decides, not the page.
 */
export async function dashboardOverview(ctx: SecurityContext) {
  const modules = new Set<string>(await enabledModules());
  const may = (module: string | null, ...perms: string[]) => (module === null || modules.has(module)) && perms.some((p) => ctx.can(p));
  const today = new Date(new Date().toISOString().slice(0, 10));
  const term = await db.term.findFirst({ where: { isCurrent: true }, select: { id: true } });

  const [admissions, drafts, overdue, live, failedMsgs, conflicts, system, activity] = await Promise.all([
    may("admissions", "admissions.view") ? db.admissionRecord.count({ where: { status: { in: ["SUBMITTED", "UNDER_REVIEW"] } } }) : 0,
    may("results", "results.publish") && term ? db.reportCard.count({ where: { termId: term.id, status: { not: "PUBLISHED" } } }) : 0,
    may("finance", "finance.view") ? db.invoice.count({ where: { status: { in: ["ISSUED", "PARTIALLY_PAID"] }, dueDate: { lt: today } } }) : 0,
    may("cbt", "cbt.review_attempt") ? db.cBTAttempt.count({ where: { status: "IN_PROGRESS", deadlineAt: { gt: new Date() } } }) : 0,
    may("communication", "notifications.manage") ? db.notificationDelivery.count({ where: { status: { in: ["FAILED", "DEAD"] } } }) : 0,
    may(null, "sync.view", "sync.resolve_conflicts") ? db.syncConflict.count({ where: { status: "OPEN" } }) : 0,
    ctx.can("license.view") || ctx.can("sync.view") ? systemHealth() : null,
    ctx.can("audit.view") ? recentActivity() : null,
  ]);

  const attention: AttentionItem[] = [
    { key: "admissions", label: "Applications waiting for review", count: admissions, href: "/admissions", tone: "info" as const },
    { key: "drafts", label: "Report cards processed but not yet published", count: drafts, href: "/results", tone: "info" as const },
    { key: "overdue", label: "Invoices past their due date", count: overdue, href: "/finance/invoices", tone: "warn" as const },
    { key: "messages", label: "Messages that could not be delivered", count: failedMsgs, href: "/communication", tone: "warn" as const },
    { key: "conflicts", label: "Sync conflicts to resolve", count: conflicts, href: "/admin/sync", tone: "bad" as const },
  ].filter((i) => i.count > 0);
  if (system) {
    if (!system.worker.alive) attention.unshift({ key: "worker", label: "The background worker is not running — reports, imports, messages and backups are waiting", count: 1, href: "/admin/sync", tone: "bad" });
    if (system.backup.stale) attention.push({ key: "backup", label: system.backup.lastBackupAt ? "No backup in the last day and a half" : "No backup has been taken yet", count: 1, href: "/admin/backup", tone: "warn" });
    if (system.sync.dead > 0) attention.push({ key: "syncdead", label: "Changes that could not be sent to the cloud", count: system.sync.dead, href: "/admin/sync", tone: "warn" });
  }
  return { generatedAt: new Date().toISOString(), live: { examsInProgress: live }, attention, system, activity };
}

async function systemHealth() {
  const [worker, sync, backup, license, jobs, deliveries] = await Promise.all([
    workerStatus(), syncOverview(), backupHealth(),
    db.license.findFirst({ where: { isActive: true }, select: { plan: true, status: true, expiresAt: true } }),
    db.backgroundJob.groupBy({ by: ["status"], where: { status: { in: ["QUEUED", "RUNNING", "DEAD"] } }, _count: true }),
    db.notificationDelivery.groupBy({ by: ["status"], where: { status: { in: ["QUEUED", "FAILED", "DEAD"] } }, _count: true }),
  ]);
  const jobCount = (s: string) => jobs.find((j) => j.status === s)?._count ?? 0;
  const deliveryCount = (s: string) => deliveries.find((d) => d.status === s)?._count ?? 0;
  return {
    worker: { alive: worker.alive, lastBeatAt: worker.lastBeatAt },
    cloud: { registered: sync.registered, lastSyncAt: sync.lastSyncAt },
    sync: { pending: sync.pending + sync.inFlight, failed: sync.failed, dead: sync.dead, openConflicts: sync.openConflicts, oldestPendingAgeSec: sync.oldestPendingAgeSec },
    jobs: { waiting: jobCount("QUEUED"), running: jobCount("RUNNING"), failed: jobCount("DEAD") },
    messages: { waiting: deliveryCount("QUEUED"), failed: deliveryCount("FAILED") + deliveryCount("DEAD") },
    backup: { lastBackupAt: backup.lastBackupAt, lastVerifiedAt: backup.lastVerifiedAt, stale: backup.stale },
    license: license ? { plan: license.plan, status: license.status, expiresAt: license.expiresAt } : null,
  };
}

async function recentActivity() {
  const rows = await db.auditLog.findMany({ orderBy: { occurredAt: "desc" }, take: 10, select: { id: true, occurredAt: true, actorName: true, action: true, module: true, entityType: true } });
  return rows.map((r) => ({ ...r, occurredAt: r.occurredAt.toISOString() }));
}
