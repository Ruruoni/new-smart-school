"use client";
import { useApi } from "@/lib/api";
import { Icon } from "./icons";

export interface WorkerStatus { alive: boolean; lastBeatAt: string | null }

/** Is the background worker running? Polls only while something is waiting on it. */
export function useWorkerStatus(waiting: boolean) {
  const q = useApi<WorkerStatus>(waiting ? "/system/worker" : null, { refreshMs: 20_000 });
  return q.data;
}

/**
 * Work handed to the background worker (reports, imports…) just sits in the queue if the worker process is down.
 * Say so plainly instead of leaving the person watching "Waiting" forever.
 */
export function WorkerNotice({ waiting, what }: { waiting: boolean; what: string }) {
  const w = useWorkerStatus(waiting);
  if (!waiting || !w || w.alive) return null;
  return (
    <p role="status" className="flex items-start gap-2 rounded-lg border-2 border-amber-700 bg-amber-100 px-4 py-3 text-amber-700">
      <Icon name="alert" size={20} className="mt-0.5 shrink-0" />
      <span><strong>The background worker isn't running.</strong> Your {what} can't be prepared until it starts — nothing is lost, and it will continue by itself once it does. Ask whoever looks after the school server to start the worker (see <em>Troubleshooting</em> in the documentation).</span>
    </p>
  );
}
