import "dotenv/config";
import { hostname } from "node:os";
import { db } from "@/platform/db";
import { runQueueOnce, type JobHandler } from "@/platform/jobs";
import { processPendingEvents } from "@/modules/automation/engine";
import { deliverPending } from "@/modules/communication/delivery";
import { importJobHandlers } from "@/modules/imports/service";
import { reportJobHandlers } from "@/modules/reports/service";
import { analyticsJobHandlers } from "@/modules/analytics/service";
import { pushAll } from "@/modules/sync/worker";
import { backupAndUpload, sendHeartbeat } from "@/modules/sync/heartbeat";
import { ensureDefaults } from "@/bootstrap";
import { runDueTasks } from "./scheduler";
import { TASKS } from "./tasks";

const WORKER = process.env.WORKER_NAME ?? `main@${hostname()}`;
const backupHandlers: Record<string, JobHandler> = { "backup.run_and_upload": async (job) => void (await backupAndUpload(String(job.payload.reason ?? "job"))) };

type Loop = { name: string; everyMs: number; run: () => Promise<unknown>; busy: boolean };

/**
 * One supervisor process, several independent loops. Each loop is re-entrancy-guarded and isolated: an error in one
 * (e.g. the cloud being unreachable) is logged and never stops the others. All state lives in PostgreSQL, so a
 * crash or power cut loses nothing — the next start simply carries on.
 */
async function main() {
  await ensureDefaults();
  const loops: Loop[] = [
    { name: "events", everyMs: 3_000, run: () => processPendingEvents(50), busy: false },
    { name: "delivery", everyMs: 10_000, run: () => deliverPending(25), busy: false },
    { name: "imports", everyMs: 3_000, run: () => runQueueOnce("imports", WORKER, importJobHandlers as never), busy: false },
    { name: "reports", everyMs: 3_000, run: () => runQueueOnce("reports", WORKER, reportJobHandlers as never), busy: false },
    { name: "analytics", everyMs: 5_000, run: () => runQueueOnce("analytics", WORKER, analyticsJobHandlers as never), busy: false },
    { name: "backups", everyMs: 10_000, run: () => runQueueOnce("backups", WORKER, backupHandlers, 1), busy: false },
    { name: "sync", everyMs: 15_000, run: () => pushAll(), busy: false },
    { name: "heartbeat", everyMs: 60_000, run: () => sendHeartbeat(), busy: false },
    { name: "scheduler", everyMs: 20_000, run: () => runDueTasks(TASKS), busy: false },
    { name: "beat", everyMs: 30_000, run: () => db.workerHeartbeat.upsert({ where: { name: WORKER }, create: { name: WORKER, meta: { pid: process.pid } }, update: { lastBeatAt: new Date(), status: "OK", meta: { pid: process.pid } } }), busy: false },
  ];
  const timers = loops.map((l) => setInterval(async () => {
    if (l.busy) return;
    l.busy = true;
    try { await l.run(); } catch (err) { console.error(`[worker:${l.name}]`, err instanceof Error ? err.message : err); } finally { l.busy = false; }
  }, l.everyMs));
  await loops.find((l) => l.name === "beat")!.run();
  console.log(`[worker] ${WORKER} started with ${loops.length} loops`);

  const stop = async (sig: string) => {
    console.log(`[worker] ${sig} received, finishing current work…`);
    timers.forEach(clearInterval);
    const deadline = Date.now() + 20_000;
    while (loops.some((l) => l.busy) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
    await db.workerHeartbeat.update({ where: { name: WORKER }, data: { status: "STOPPED" } }).catch(() => undefined);
    await db.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

main().catch((err) => {
  // A configuration problem is the installer's to fix: name what is wrong (never the values) instead of dumping a stack.
  if (Array.isArray((err as { issues?: unknown })?.issues)) {
    console.error("[worker] fatal: the worker is not configured correctly:");
    for (const i of (err as { issues: string[] }).issues) console.error(`  - ${i}`);
    console.error("[worker] Set these in the environment (see docs/deployment.md). Exiting.");
    process.exit(78);
  }
  console.error("[worker] fatal", err);
  process.exit(1);
});
