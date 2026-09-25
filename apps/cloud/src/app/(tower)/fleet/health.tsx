"use client";
import { ago, day, HEALTH_LABEL, healthOf, OFFLINE_AFTER_MS, useAction, call, when } from "@/lib/api";
import { Badge, Button, Notice, Stat } from "@/ui/kit";
import { canSupport, useMe } from "../layout";
import type { Detail } from "./types";

const HEALTH_TONE = { healthy: "ok", attention: "warn", critical: "bad", silent: undefined, suspended: "violet", waiting: undefined, retired: undefined } as const;
const size = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const dur = (s: number | null) => (s === null ? "—" : s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`);

export function HealthBoard({ d, reload }: { d: Detail; reload: () => void }) {
  const me = useMe(); const i = d.installation;
  const worst = i.alerts.some((a) => a.severity === "CRITICAL") ? "CRITICAL" : i.alerts.some((a) => a.severity === "WARNING") ? "WARNING" : i.alerts.length ? "INFO" : null;
  const h = healthOf({ status: i.status, lastHeartbeatAt: i.lastHeartbeatAt, worstAlert: worst });
  const m = i.lastMetrics;
  const beats = [...i.heartbeats].reverse();
  const maxQ = Math.max(1, ...beats.map((b) => b.metrics.queuePending));
  const ack = useAction(async (id: string) => { await call(`alerts/${id}/ack`, "POST", {}); reload(); });
  const outdated = d.latestVersion && i.appVersion && d.latestVersion !== i.appVersion;
  const backupStale = m && (!m.lastBackupAt || Date.now() - Date.parse(m.lastBackupAt) > 7 * 86_400_000);

  return (
    <div className="stack">
      <div>
        <div className="headline"><h2>{i.schoolName}</h2><Badge tone={HEALTH_TONE[h]}>{HEALTH_LABEL[h]}</Badge></div>
        <p className="muted" style={{ margin: 0 }}><span className="mono">{i.code}</span>{i.state ? ` · ${i.state}` : ""} · {i.plan} plan · {i.appVersion ? `v${i.appVersion}` : "no version reported"}{outdated ? <> · <Badge tone="warn">v{d.latestVersion} available</Badge></> : null}</p>
        <p className="muted" style={{ margin: 0 }}>Last heard from {ago(i.lastHeartbeatAt)} · last data sync {ago(i.lastSyncAt)} · licence ends {day(i.licenseExpiresAt)}</p>
      </div>

      {i.status === "SUSPENDED" && <Notice tone="info">Suspended {when(i.suspendedAt)}: “{i.suspendedReason}”. When the school next connects it switches to administrator-only mode. Its data stays intact and exportable.</Notice>}
      {h === "silent" && <Notice tone="info">This school has not reported for a while. Schools run normally offline, so silence alone never restricts them. It becomes a licence matter only if the licence itself expires.</Notice>}
      {i.status === "PENDING" && <Notice tone="info">Waiting for the school to register. Give them the registration token from the control panel{d.registrationTokenExpiresAt ? ` (valid until ${day(d.registrationTokenExpiresAt)})` : " (issue a new one — the last has expired)"}.</Notice>}

      {m && (
        <dl className="kpis" aria-label="Latest health report">
          <Stat label="Waiting to sync" value={m.queuePending} tone={m.queuePending > 1000 ? "bad" : m.queuePending > 200 ? "warn" : "ok"} hint="Changes made at the school that have not reached the cloud yet" />
          <Stat label="Oldest waiting" value={dur(m.oldestPendingAgeSec)} tone={(m.oldestPendingAgeSec ?? 0) > 6 * 3600 ? "warn" : undefined} />
          <Stat label="Failed sends" value={m.queueFailed} tone={m.queueFailed ? "warn" : "ok"} />
          <Stat label="Stuck (dead)" value={m.queueDead} tone={m.queueDead ? "bad" : "ok"} />
          <Stat label="Open conflicts" value={m.openConflicts} tone={m.openConflicts ? "warn" : "ok"} />
          <Stat label="Students" value={m.studentCount.toLocaleString("en-NG")} />
          <Stat label="Active users" value={m.activeUsers} />
          <Stat label="Last backup" value={m.lastBackupAt ? ago(m.lastBackupAt) : "None"} tone={backupStale ? "warn" : "ok"} />
          <Stat label="School database" value={m.dbOk ? "OK" : "Down"} tone={m.dbOk ? "ok" : "bad"} />
        </dl>
      )}

      {beats.length > 1 && (
        <section className="panel" aria-labelledby="hb"><header><h3 id="hb">Reports received (last {beats.length})</h3><span className="muted num">Bar height = changes waiting to sync</span></header>
          <div className="body"><div className="beats" role="img" aria-label={`Waiting-to-sync counts over the last ${beats.length} reports, latest ${beats.at(-1)!.metrics.queuePending}`}>{beats.map((b) => <i key={b.id} title={`${when(b.receivedAt)}: ${b.metrics.queuePending} waiting`} className={b.metrics.queuePending === 0 ? "zero" : b.metrics.queuePending > 200 ? "hi" : ""} style={{ height: `${Math.max(6, (b.metrics.queuePending / maxQ) * 100)}%` }} />)}</div>
            <p className="muted num" style={{ margin: ".4rem 0 0", display: "flex", justifyContent: "space-between" }}><span>{when(beats[0]!.receivedAt)}</span><span>{when(beats.at(-1)!.receivedAt)}</span></p></div></section>
      )}

      <section className="panel" aria-labelledby="al"><header><h3 id="al">Open alerts ({i.alerts.length})</h3></header>
        {i.alerts.length === 0 ? <p className="empty">Nothing needs attention.</p> : <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>{i.alerts.map((a) => (
          <li key={a.id} style={{ padding: ".7rem 1rem", borderBottom: "1px solid var(--line)", display: "flex", gap: ".75rem", alignItems: "flex-start", justifyContent: "space-between" }}>
            <div><Badge tone={a.severity === "CRITICAL" ? "bad" : a.severity === "WARNING" ? "warn" : undefined}>{a.severity[0] + a.severity.slice(1).toLowerCase()}</Badge> <strong>{a.kind.replace(/_/g, " ").toLowerCase()}</strong><br />{a.message}<br /><span className="muted">Opened {ago(a.openedAt)}{a.acknowledgedAt ? ` · acknowledged ${ago(a.acknowledgedAt)}` : ""}</span></div>
            {canSupport(me) && !a.acknowledgedAt && <Button small variant="secondary" loading={ack.pending} onClick={() => void ack.run(a.id)}>Acknowledge</Button>}
          </li>))}</ul>}
        {ack.error && <div className="body"><Notice tone="bad">{ack.error}</Notice></div>}
      </section>

      {m && (
        <div className="scroll-x"><section className="panel" aria-labelledby="wk"><header><h3 id="wk">Background workers</h3></header>
          {m.workers.length === 0 ? <p className="empty">No worker has reported. Reports, notifications and syncing depend on the worker running.</p> : <table className="grid"><thead><tr><th>Worker</th><th>Status</th><th>Last beat</th></tr></thead><tbody>{m.workers.map((w) => { const stale = Date.now() - Date.parse(w.lastBeatAt) > OFFLINE_AFTER_MS; return <tr key={w.name}><td className="mono">{w.name}</td><td><Badge tone={stale ? "bad" : w.status === "OK" ? "ok" : "warn"}>{stale ? "Stale" : w.status}</Badge></td><td>{ago(w.lastBeatAt)}</td></tr>; })}</tbody></table>}
        </section></div>
      )}
      {m && m.recentErrors.length > 0 && <section className="panel" aria-labelledby="er"><header><h3 id="er">Recent errors at the school</h3></header><ul className="body mono" style={{ margin: 0, paddingLeft: "1.6rem" }}>{m.recentErrors.map((e, k) => <li key={k}>{e}</li>)}</ul></section>}

      <section className="panel" aria-labelledby="sy"><header><h3 id="sy">Data received in the cloud</h3><span className="muted num">{d.sync.records.toLocaleString("en-NG")} records</span></header>
        {d.sync.byType.length === 0 ? <p className="empty">No records synced yet.</p> : <div className="scroll-x"><table className="grid"><thead><tr><th>Record type</th><th className="r">Count</th></tr></thead><tbody>{d.sync.byType.map((t) => <tr key={t.entityType}><td>{t.entityType}</td><td className="r num">{t.count.toLocaleString("en-NG")}</td></tr>)}</tbody></table></div>}
        {i.conflicts.length > 0 && <div className="body"><Notice tone="info">{i.conflicts.length} open sync conflict{i.conflicts.length === 1 ? "" : "s"}. Schools decide their own conflicts; cloud copies are replicas. <a href="/conflicts">See all conflicts</a>.</Notice></div>}
      </section>

      <section className="panel" aria-labelledby="bk"><header><h3 id="bk">Backups uploaded to the cloud</h3></header>
        {d.backups.length === 0 ? <p className="empty">No backup uploaded yet. Use “Request a backup” in the control panel.</p> : <div className="scroll-x"><table className="grid"><thead><tr><th>File</th><th className="r">Size</th><th>Received</th><th /></tr></thead><tbody>{d.backups.map((b) => <tr key={b.id}><td className="mono">{b.fileName}</td><td className="r num">{size(b.sizeBytes)}</td><td>{when(b.receivedAt)}</td><td>{me.role === "SUPER_ADMIN" && <a href={`/api/ops/backups/${b.id}/download`}>Download</a>}</td></tr>)}</tbody></table></div>}
      </section>

      <section className="panel" aria-labelledby="ac"><header><h3 id="ac">Recent activity on this installation</h3></header>
        {d.audit.length === 0 ? <p className="empty">Nothing recorded yet.</p> : <div className="scroll-x"><table className="grid"><thead><tr><th>When</th><th>Who</th><th>Action</th></tr></thead><tbody>{d.audit.map((a) => <tr key={a.id}><td className="num">{when(a.occurredAt)}</td><td>{a.operatorEmail ?? "system"}</td><td className="mono">{a.action}</td></tr>)}</tbody></table></div>}
      </section>
    </div>
  );
}
