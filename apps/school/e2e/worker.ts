import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { APP_ENV } from "./env";

export const WORKER_PID_FILE = ".data/e2e-worker.pid";
let child: ChildProcess | null = null;

/** Kills a whole process GROUP. `tsx` starts the real Node process as a child, so killing only the wrapper leaves the worker running (and beating). */
function killGroup(pid: number) { try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ } try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }

/**
 * Reaps a worker left behind by an earlier run (crash, Ctrl-C, killed test process). Only a process whose command line really is
 * this app's worker is touched — a recycled pid or someone's own `pnpm worker` is left alone.
 */
export function reapStaleWorker() {
  if (!existsSync(WORKER_PID_FILE)) return;
  const pid = Number(readFileSync(WORKER_PID_FILE, "utf8").trim());
  try {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
    if (pid > 1 && /workers\/main\.ts/.test(cmd) && /e2e-worker-marker/.test(cmd)) killGroup(pid);
  } catch { /* not running */ }
  rmSync(WORKER_PID_FILE, { force: true });
}

/** Starts the background worker (events, notifications, reports, imports…) once for the whole run. */
export async function ensureWorker(): Promise<void> {
  if (child) return;
  reapStaleWorker();
  // its own process group (detached), marked on the command line so it can be recognised safely later
  child = spawn("pnpm", ["exec", "tsx", "src/workers/main.ts", "e2e-worker-marker"], { env: { ...process.env, ...APP_ENV, WORKER_NAME: "e2e-worker" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  mkdirSync(".data", { recursive: true });
  writeFileSync(WORKER_PID_FILE, String(child.pid));
  const me = child;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("worker did not start")), 60_000);
    me.stdout!.on("data", (d) => { if (String(d).includes("started with")) { clearTimeout(t); resolve(); } });
    me.on("exit", (c) => { clearTimeout(t); if (child === me) reject(new Error(`worker exited early (${c})`)); });
  });
  const stopAtExit = () => { if (child?.pid) killGroup(child.pid); };
  process.once("exit", stopAtExit); process.once("SIGTERM", () => { stopAtExit(); process.exit(143); }); process.once("SIGINT", () => { stopAtExit(); process.exit(130); });
}

/** Stops the worker (as if the process crashed or nobody started it): the WHOLE process tree, and waits until it has gone. */
export async function stopWorker(): Promise<void> {
  const c = child;
  if (!c?.pid) return;
  child = null;
  const gone = new Promise<void>((resolve) => c.once("exit", () => resolve()));
  killGroup(c.pid);
  await gone;
  rmSync(WORKER_PID_FILE, { force: true });
}
