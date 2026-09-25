import { db } from "@/platform/db";
import { localParts } from "@/modules/attendance/service";

export type Schedule = { everyMs: number } | { dailyAt: string; /** ISO weekdays 1–7; omit for every day */ days?: number[] };

export interface Task {
  name: string;
  schedule: Schedule;
  run: (now: Date) => Promise<unknown>;
}

const KEY = (name: string) => `scheduler.lastRun.${name}`;

export async function lastRun(name: string): Promise<Date | null> {
  const row = await db.systemSetting.findUnique({ where: { key: KEY(name) } });
  const v = (row?.value as { at?: string } | undefined)?.at;
  return v ? new Date(v) : null;
}

async function markRun(name: string, at: Date) {
  await db.systemSetting.upsert({ where: { key: KEY(name) }, create: { key: KEY(name), value: { at: at.toISOString() } }, update: { value: { at: at.toISOString() } } });
}

const isoDow = (date: string) => ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

/**
 * Pure due-check. Daily tasks run once per school-local day, at or after their time — including "catch-up" after
 * the server was off at that moment (a power cut at 02:00 does not skip the night's backup).
 */
export function isDue(schedule: Schedule, last: Date | null, now: Date, timezone: string): boolean {
  if ("everyMs" in schedule) return !last || now.getTime() - last.getTime() >= schedule.everyMs;
  const { date, minutes } = localParts(now, timezone);
  if (schedule.days && !schedule.days.includes(isoDow(date))) return false;
  const [h, m] = schedule.dailyAt.split(":").map(Number);
  if (minutes < h! * 60 + m!) return false;
  return !last || localParts(last, timezone).date !== date;
}

export interface TaskResult {
  name: string;
  ok: boolean;
  error?: string;
}

/** Run whatever is due. A failing task is logged and retried next tick; it never blocks the others. */
export async function runDueTasks(tasks: readonly Task[], now = new Date()): Promise<TaskResult[]> {
  const tz = (await db.schoolInstallation.findFirst({ select: { timezone: true } }))?.timezone ?? "Africa/Lagos";
  const out: TaskResult[] = [];
  for (const t of tasks) {
    const last = await lastRun(t.name);
    if (!isDue(t.schedule, last, now, tz)) continue;
    // Claim BEFORE running so two workers (or a restart mid-run) never double-run a daily task.
    await markRun(t.name, now);
    try {
      await t.run(now);
      out.push({ name: t.name, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] task ${t.name} failed:`, message);
      // Un-claim so it is retried on the next tick.
      await db.systemSetting.update({ where: { key: KEY(t.name) }, data: { value: { at: last?.toISOString() ?? new Date(0).toISOString(), lastError: message.slice(0, 300) } } }).catch(() => undefined);
      out.push({ name: t.name, ok: false, error: message });
    }
  }
  return out;
}
