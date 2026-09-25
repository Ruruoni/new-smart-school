"use client";
import { useState } from "react";
import Link from "next/link";
import { ago, call, useAction, useApi } from "@/lib/api";
import { Badge, Button, Notice, Select } from "@/ui/kit";
import { canSupport, useMe } from "../layout";

interface A { id: string; kind: string; severity: "INFO" | "WARNING" | "CRITICAL"; message: string; openedAt: string; resolvedAt: string | null; acknowledgedAt: string | null; installation: { id: string; code: string; schoolName: string } }

export default function Alerts() {
  const me = useMe(); const [state, setState] = useState("open");
  const q = useApi<A[]>(`alerts?state=${state}`, { refreshMs: 30_000 });
  const ack = useAction(async (id: string) => { await call(`alerts/${id}/ack`, "POST", {}); await q.reload(); });
  return (
    <main className="page">
      <h1>Alerts</h1>
      <p className="lede">Problems the schools report or that the tower notices. Most-severe first. Alerts clear themselves when the cause goes away.</p>
      <div style={{ maxWidth: "14rem", marginBottom: "1rem" }}><Select aria-label="Show" value={state} onChange={(e) => setState(e.target.value)}><option value="open">Open alerts</option><option value="all">Open and resolved</option></Select></div>
      {ack.error && <Notice tone="bad">{ack.error}</Notice>}
      {q.error ? <Notice tone="bad">{q.error.message}</Notice> : !q.data ? <p aria-busy="true" className="muted">Loading…</p> : q.data.length === 0 ? <div className="panel"><p className="empty">Nothing needs attention.</p></div> : (
        <div className="panel scroll-x"><table className="grid"><thead><tr><th>Severity</th><th>School</th><th>Problem</th><th>Opened</th><th /></tr></thead><tbody>{q.data.map((a) => (
          <tr key={a.id}><td><Badge tone={a.resolvedAt ? "ok" : a.severity === "CRITICAL" ? "bad" : a.severity === "WARNING" ? "warn" : undefined}>{a.resolvedAt ? "Resolved" : a.severity[0] + a.severity.slice(1).toLowerCase()}</Badge></td>
            <td><Link href={`/fleet?i=${a.installation.id}`}>{a.installation.schoolName}</Link><br /><span className="mono muted">{a.installation.code}</span></td>
            <td><strong>{a.kind.replace(/_/g, " ").toLowerCase()}</strong><br />{a.message}</td><td>{ago(a.openedAt)}{a.acknowledgedAt && <><br /><span className="muted">acknowledged</span></>}</td>
            <td>{canSupport(me) && !a.resolvedAt && !a.acknowledgedAt && <Button small variant="secondary" disabled={ack.pending} onClick={() => void ack.run(a.id)}>Acknowledge</Button>}</td></tr>))}</tbody></table></div>
      )}
    </main>
  );
}
