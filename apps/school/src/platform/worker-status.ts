import { db } from "./db";

/** The worker beats every 30 s; three missed beats means it is not running. */
export const WORKER_ALIVE_SECONDS = 90;

export interface WorkerStatus {
  alive: boolean;
  lastBeatAt: string | null;
  workers: { name: string; status: string; lastBeatAt: string; alive: boolean }[];
}

/**
 * Is a background worker actually running? A job in the queue proves nothing about that: if the worker process is
 * down, jobs (reports, imports, notifications, backups…) wait forever. Callers use this to tell the person what is
 * happening instead of leaving them looking at "Queued", and to fall back to inline work where that is cheap and safe.
 */
export async function workerStatus(now = Date.now()): Promise<WorkerStatus> {
  const rows = await db.workerHeartbeat.findMany({ orderBy: { lastBeatAt: "desc" } });
  const workers = rows.map((w) => ({ name: w.name, status: w.status, lastBeatAt: w.lastBeatAt.toISOString(), alive: w.status !== "STOPPED" && now - w.lastBeatAt.getTime() < WORKER_ALIVE_SECONDS * 1000 }));
  return { alive: workers.some((w) => w.alive), lastBeatAt: workers[0]?.lastBeatAt ?? null, workers };
}

export const workerAlive = async (now = Date.now()) => (await workerStatus(now)).alive;
