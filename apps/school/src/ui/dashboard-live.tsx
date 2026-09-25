"use client";
import Link from "next/link";
import { useApi } from "@/lib/api";
import { ago, dateTime } from "@/lib/format";
import { Badge, Panel, Stat } from "@/ui/kit";
import { Icon } from "@/ui/icons";

interface Overview {
  generatedAt: string;
  live: { examsInProgress: number };
  attention: { key: string; label: string; count: number; href: string; tone: "bad" | "warn" | "info" }[];
  system: {
    worker: { alive: boolean; lastBeatAt: string | null };
    cloud: { registered: boolean; lastSyncAt: string | null };
    sync: { pending: number; failed: number; dead: number; openConflicts: number; oldestPendingAgeSec: number | null };
    jobs: { waiting: number; running: number; failed: number };
    messages: { waiting: number; failed: number };
    backup: { lastBackupAt: string | null; lastVerifiedAt: string | null; stale: boolean };
    license: { plan: string; status: string; expiresAt: string } | null;
  } | null;
  activity: { id: string; occurredAt: string; actorName: string | null; action: string; module: string }[] | null;
}

const ACTION_WORDS = (a: string) => a.replace(/[._]/g, " ").replace(/^./, (c) => c.toUpperCase());

/**
 * What is true right now: things waiting on a person, the health of the machinery behind the school, and recent activity.
 * Fetched fresh every 30 s (paused when the tab is hidden or offline). The server includes only the sections this user
 * may see and whose module is enabled — this component just renders what it is given.
 */
export function DashboardLive() {
  const q = useApi<Overview>("/dashboard/overview", { refreshMs: 30_000 });
  if (q.error && !q.data) return <p role="alert" className="rounded bg-pen-100 p-3 text-pen-700">Live status is unavailable right now ({q.error.message}).</p>;
  if (!q.data) return <div aria-busy="true" className="h-24 animate-pulse rounded-(--radius-panel) bg-ink-100" />;
  const { attention, system, activity, live } = q.data;
  return (
    <div className="space-y-6" data-testid="dashboard-live">
      <Panel title="Needs attention" actions={<span className="text-sm text-ink-500">Updated {ago(q.data.generatedAt)}</span>}>
        {attention.length === 0 && live.examsInProgress === 0 ? (
          <p className="flex items-center gap-2 text-leaf-700"><Icon name="check" size={18} />Nothing is waiting on you right now.</p>
        ) : (
          <ul className="space-y-2">
            {live.examsInProgress > 0 && <li className="flex items-center justify-between gap-3"><span><span className="num font-bold">{live.examsInProgress}</span> {live.examsInProgress === 1 ? "student is" : "students are"} sitting an exam right now</span><Link href="/cbt" className="font-bold text-brand-700 underline">Monitor</Link></li>}
            {attention.map((a) => (
              <li key={a.key} className="flex items-center justify-between gap-3">
                <span className="flex items-start gap-2">{a.tone === "bad" ? <Icon name="alert" size={18} className="mt-1 shrink-0 text-pen-700" /> : null}<span>{a.key === "worker" ? "" : <span className="num font-bold">{a.count}</span>} {a.label}</span></span>
                <Link href={a.href} className="shrink-0 font-bold text-brand-700 underline">Open</Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className="grid gap-6 lg:grid-cols-3">
        {system && (
          <section className="lg:col-span-2" aria-label="System health">
            <h2 className="mb-3 font-serif text-lg font-semibold">System health</h2>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              <Stat label="Background worker" value={system.worker.alive ? "Running" : "Stopped"} tone={system.worker.alive ? "ok" : "bad"} note={system.worker.lastBeatAt ? `last seen ${ago(system.worker.lastBeatAt)}` : "never started"} />
              <Stat label="Cloud connection" value={system.cloud.registered ? (system.sync.oldestPendingAgeSec !== null && system.sync.oldestPendingAgeSec > 3600 ? "Behind" : "Connected") : "Standalone"} tone={system.cloud.registered ? (system.sync.oldestPendingAgeSec !== null && system.sync.oldestPendingAgeSec > 3600 ? "warn" : "ok") : undefined} note={system.cloud.registered ? (system.cloud.lastSyncAt ? `last sync ${ago(system.cloud.lastSyncAt)}` : "no sync yet") : "works fully offline"} />
              <Stat label="Waiting to sync" value={system.sync.pending} tone={system.sync.dead || system.sync.openConflicts ? "bad" : system.sync.failed ? "warn" : undefined} note={system.sync.openConflicts ? `${system.sync.openConflicts} conflict${system.sync.openConflicts === 1 ? "" : "s"}` : system.sync.dead ? `${system.sync.dead} stuck` : undefined} />
              <Stat label="Background jobs" value={system.jobs.waiting + system.jobs.running} tone={system.jobs.failed ? "bad" : undefined} note={system.jobs.failed ? `${system.jobs.failed} failed` : `${system.jobs.running} running now`} />
              <Stat label="Messages" value={system.messages.waiting} tone={system.messages.failed ? "warn" : undefined} note={system.messages.failed ? `${system.messages.failed} failed` : "waiting to be sent"} />
              <Stat label="Last backup" value={system.backup.lastBackupAt ? ago(system.backup.lastBackupAt) : "None"} tone={system.backup.stale ? "warn" : "ok"} note={system.backup.lastVerifiedAt ? `verified ${ago(system.backup.lastVerifiedAt)}` : "not verified yet"} />
            </div>
            {system.license && <p className="mt-3 text-sm text-ink-500">Licence: <Badge tone={system.license.status === "ACTIVE" ? "ok" : "warn"}>{system.license.status.toLowerCase()}</Badge> {system.license.plan} plan, ends {new Date(system.license.expiresAt).toLocaleDateString("en-GB", { dateStyle: "medium" })}</p>}
          </section>
        )}
        {activity && (
          <Panel title="Recent activity" padded={false} className={system ? "" : "lg:col-span-3"}>
            {activity.length === 0 ? <p className="p-4 text-ink-500">Nothing has happened yet.</p> : (
              <ul className="divide-y divide-line">
                {activity.map((a) => <li key={a.id} className="px-4 py-2.5"><p className="font-bold">{ACTION_WORDS(a.action)}</p><p className="text-sm text-ink-500">{a.actorName ?? "System"} · {ago(a.occurredAt)}<span className="sr-only"> ({dateTime(a.occurredAt)})</span></p></li>)}
              </ul>
            )}
            <div className="border-t border-line px-4 py-2.5"><Link href="/admin/audit" className="font-bold text-brand-700 underline">Full audit log</Link></div>
          </Panel>
        )}
      </div>
    </div>
  );
}
