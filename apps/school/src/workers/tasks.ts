import { db, transact } from "@/platform/db";
import { audit } from "@/platform/audit";
import { publishEvent } from "@/platform/events";
import { enqueueJob, recoverStaleJobs } from "@/platform/jobs";
import { getSetting } from "@/platform/settings";
import { markAbsentees, localParts } from "@/modules/attendance/service";
import { finalizeOpenAttempts } from "@/modules/cbt/attempts";
import { pruneBackups, runBackup, verifyBackup } from "@/modules/backup/service";
import { purgeAckedQueue } from "@/modules/sync/worker";
import { backupAndUpload } from "@/modules/sync/heartbeat";
import { cloudConfig } from "@/modules/sync/client";
import { runScheduledRules } from "@/modules/automation/engine";
import type { Task } from "./scheduler";

const DAY = 86_400_000;

/** Emit `invoice.overdue` once per invoice per week so reminders nag politely instead of flooding. */
export async function scanOverdueInvoices(now = new Date()): Promise<number> {
  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const overdue = await db.invoice.findMany({ where: { status: { in: ["ISSUED", "PARTIALLY_PAID"] }, studentId: { not: null }, dueDate: { lt: today } }, select: { id: true, number: true, studentId: true, total: true, amountPaid: true, dueDate: true } });
  let emitted = 0;
  for (const inv of overdue) {
    const recent = await db.domainEvent.findFirst({ where: { type: "invoice.overdue", payload: { path: ["invoiceId"], equals: inv.id }, occurredAt: { gt: new Date(now.getTime() - 7 * DAY) } }, select: { id: true } });
    if (recent) continue;
    await transact((tx) => publishEvent(tx, "invoice.overdue", { invoiceId: inv.id, invoice: inv.number, studentId: inv.studentId, balance: inv.total.minus(inv.amountPaid).toFixed(2), dueDate: inv.dueDate?.toISOString().slice(0, 10), number: inv.number }));
    emitted += 1;
  }
  return emitted;
}

/** After the school's absence cutoff, everyone with no mark is marked absent (which triggers guardian notifications). */
export async function autoMarkAbsentees(now = new Date()) {
  const tz = (await db.schoolInstallation.findFirst({ select: { timezone: true } }))?.timezone ?? "Africa/Lagos";
  const { date, minutes } = localParts(now, tz);
  const policy = await getSetting("attendance.policy");
  const [h, m] = policy.absentAfter.split(":").map(Number);
  if (minutes < h! * 60 + m!) return { marked: 0, skipped: "before cutoff" };
  const dow = ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
  if (dow > 5) return { marked: 0, skipped: "weekend" };
  // Only on days the school has taken attendance at all (avoids marking the whole school absent on a public holiday).
  const any = await db.attendanceLog.count({ where: { date: new Date(`${date}T00:00:00Z`), session: "DAY", studentId: { not: null } } });
  if (!any) return { marked: 0, skipped: "no attendance recorded today" };
  return markAbsentees(null, { date });
}

export async function maintenance(now = new Date()) {
  const out: Record<string, number> = {};
  out.expiredSessions = (await db.session.deleteMany({ where: { OR: [{ expiresAt: { lt: now } }, { revokedAt: { lt: new Date(now.getTime() - 30 * DAY) } }] } })).count;
  out.syncPurged = await purgeAckedQueue(30);
  out.eventsPurged = (await db.domainEvent.deleteMany({ where: { processedAt: { lt: new Date(now.getTime() - 90 * DAY) }, executions: { none: { status: "FAILED" } } } })).count;
  out.jobsPurged = (await db.backgroundJob.deleteMany({ where: { status: "SUCCEEDED", finishedAt: { lt: new Date(now.getTime() - 14 * DAY) } } })).count;
  // Temporary-password files are only meant to be handed over once.
  const creds = await db.fileAsset.updateMany({ where: { ownerType: "IMPORT_CREDENTIALS", deletedAt: null, createdAt: { lt: new Date(now.getTime() - 7 * DAY) } }, data: { deletedAt: now } });
  out.credentialFilesRetired = creds.count;
  out.backupsPruned = await pruneBackups(14);
  await transact((tx) => audit(tx, { action: "maintenance.run", module: "platform", metadata: out }));
  return out;
}

export async function nightlyBackup() {
  // Registered schools also ship the (already encrypted) archive to the cloud; otherwise it stays local.
  const id = (await cloudConfig()) ? (await backupAndUpload("nightly")).backupId : (await runBackup(null, { reason: "nightly" })).record.id;
  const check = await verifyBackup(id, { deep: new Date().getUTCDay() === 0 }); // deep restore-test every Sunday
  return { id, verified: check.ok };
}

export const TASKS: Task[] = [
  { name: "cbt.finalize_attempts", schedule: { everyMs: 60_000 }, run: () => finalizeOpenAttempts() },
  { name: "jobs.recover_stale", schedule: { everyMs: 5 * 60_000 }, run: () => recoverStaleJobs() },
  { name: "automation.scheduled_rules", schedule: { everyMs: 60_000 }, run: (n) => runScheduledRules(n) },
  { name: "analytics.refresh", schedule: { everyMs: 10 * 60_000 }, run: () => enqueueJob(db, "analytics", "analytics.refresh_all", {}, { dedupeKey: "analytics.refresh_all" }) },
  { name: "attendance.auto_absentees", schedule: { everyMs: 15 * 60_000 }, run: (n) => autoMarkAbsentees(n) },
  { name: "finance.overdue_scan", schedule: { dailyAt: "07:00" }, run: (n) => scanOverdueInvoices(n) },
  { name: "backup.nightly", schedule: { dailyAt: "02:00" }, run: () => nightlyBackup() },
  { name: "maintenance.daily", schedule: { dailyAt: "03:30" }, run: (n) => maintenance(n) },
];
