import { db, type Tx } from "./db";
import type { Prisma } from "@/generated/prisma/client";
import { backoffSeconds } from "@smartschool/protocol";
import { ZodError } from "zod";
import { AppError } from "./errors";

/**
 * Durable job queue on PostgreSQL. Rows survive restarts and power loss; workers claim with
 * FOR UPDATE SKIP LOCKED so several workers never run the same job; failures retry with back-off.
 */
export type JobQueue = "imports" | "reports" | "analytics" | "maintenance" | "backups";

export async function enqueueJob(tx: Tx | typeof db, queue: JobQueue, type: string, payload: Record<string, unknown> = {}, opts: { runAt?: Date; dedupeKey?: string; maxAttempts?: number } = {}): Promise<string | null> {
  if (opts.dedupeKey) {
    // A dedupe key blocks a second QUEUED/RUNNING job with the same key; finished jobs release it.
    const existing = await tx.backgroundJob.findUnique({ where: { dedupeKey: opts.dedupeKey } });
    if (existing && (existing.status === "QUEUED" || existing.status === "RUNNING")) return null;
    if (existing) await tx.backgroundJob.update({ where: { id: existing.id }, data: { dedupeKey: null } });
  }
  const j = await tx.backgroundJob.create({ data: { queue, type, payload: payload as Prisma.InputJsonValue, runAt: opts.runAt ?? new Date(), dedupeKey: opts.dedupeKey, maxAttempts: opts.maxAttempts ?? 5 } });
  return j.id;
}

export interface ClaimedJob {
  id: string;
  queue: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

export async function claimJobs(queue: JobQueue, workerId: string, limit = 5): Promise<ClaimedJob[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    UPDATE background_jobs SET status = 'RUNNING', "lockedAt" = (now() AT TIME ZONE 'UTC'), "lockedBy" = ${workerId}, attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM background_jobs WHERE queue = ${queue} AND status = 'QUEUED' AND "runAt" <= (now() AT TIME ZONE 'UTC')
      ORDER BY "runAt" ASC LIMIT ${limit} FOR UPDATE SKIP LOCKED)
    RETURNING id`;
  if (!rows.length) return [];
  const jobs = await db.backgroundJob.findMany({ where: { id: { in: rows.map((r) => r.id) } } });
  return jobs.map((j) => ({ id: j.id, queue: j.queue, type: j.type, payload: j.payload as Record<string, unknown>, attempts: j.attempts, maxAttempts: j.maxAttempts }));
}

export async function completeJob(id: string) {
  await db.backgroundJob.update({ where: { id }, data: { status: "SUCCEEDED", finishedAt: new Date(), lockedAt: null, lockedBy: null, lastError: null, dedupeKey: null } });
}

/** Throw this from a job handler when retrying can never help (bad input, missing record, not permitted). */
export class PermanentJobError extends Error {}

/**
 * A failure is permanent when repeating the job would fail the same way: the handler says so, or it is a client-class
 * AppError (validation, not found, forbidden). Timeouts (408), rate limits (429) and conflicts (409 — a stale write or
 * "already running" can clear by itself) are transient and keep their retries.
 */
export function isPermanentFailure(err: unknown): boolean {
  if (err instanceof PermanentJobError || err instanceof ZodError) return true; // a malformed payload will be malformed on every retry
  return err instanceof AppError && err.status >= 400 && err.status < 500 && ![408, 409, 429].includes(err.status);
}

/** Is this the job's last attempt (out of retries, or a failure retrying can't fix)? Handlers use it to decide whether to show "failed" or "retrying". */
export const isFinalAttempt = (job: { attempts: number; maxAttempts: number }, err: unknown) => isPermanentFailure(err) || job.attempts >= job.maxAttempts;

export async function failJob(job: ClaimedJob, err: unknown) {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
  const dead = isFinalAttempt(job, err);
  await db.backgroundJob.update({
    where: { id: job.id },
    data: { status: dead ? "DEAD" : "QUEUED", lastError: message, lockedAt: null, lockedBy: null, runAt: new Date(Date.now() + backoffSeconds(job.attempts - 1) * 1000), ...(dead ? { finishedAt: new Date(), dedupeKey: null } : {}) },
  });
}

/** Return jobs whose worker died mid-run (lock older than `staleMinutes`) to the queue. */
export async function recoverStaleJobs(staleMinutes = 15): Promise<number> {
  const r = await db.backgroundJob.updateMany({ where: { status: "RUNNING", lockedAt: { lt: new Date(Date.now() - staleMinutes * 60_000) } }, data: { status: "QUEUED", lockedAt: null, lockedBy: null } });
  return r.count;
}

export type JobHandler = (job: ClaimedJob) => Promise<void>;

/** Run one polling pass for a queue; returns how many jobs ran. */
export async function runQueueOnce(queue: JobQueue, workerId: string, handlers: Record<string, JobHandler>, limit = 5): Promise<number> {
  const jobs = await claimJobs(queue, workerId, limit);
  for (const job of jobs) {
    const h = handlers[job.type];
    try {
      if (!h) throw new Error(`No handler registered for job type "${job.type}"`);
      await h(job);
      await completeJob(job.id);
    } catch (err) {
      await failJob(job, err);
    }
  }
  return jobs.length;
}
