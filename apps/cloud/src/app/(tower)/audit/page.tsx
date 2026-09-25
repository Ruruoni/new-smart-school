"use client";
import { useApi, when } from "@/lib/api";
import { Notice } from "@/ui/kit";

interface A { id: string; seq: number; occurredAt: string; operatorEmail: string | null; action: string; installationId: string | null; detail: unknown; ip: string | null }

export default function Audit() {
  const q = useApi<A[]>("audit?limit=200", { refreshMs: 60_000 });
  return (
    <main className="page">
      <h1>Audit log</h1>
      <p className="lede">Every sign-in and every change an operator makes, newest first. This log cannot be edited or deleted.</p>
      {q.error ? <Notice tone="bad">{q.error.message}</Notice> : !q.data ? <p aria-busy="true" className="muted">Loading…</p> : (
        <div className="panel scroll-x"><table className="grid"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th><th>From</th></tr></thead><tbody>{q.data.map((a) => (
          <tr key={a.id}><td className="num">{when(a.occurredAt)}</td><td>{a.operatorEmail ?? <span className="muted">system</span>}</td><td className="mono">{a.action}</td><td className="mono" style={{ overflowWrap: "anywhere", maxWidth: "28rem" }}>{a.detail ? JSON.stringify(a.detail) : ""}</td><td className="mono">{a.ip ?? ""}</td></tr>))}</tbody></table></div>
      )}
    </main>
  );
}
