"use client";
import Link from "next/link";
import { call, useAction, useApi, when } from "@/lib/api";
import { Button, Notice } from "@/ui/kit";
import { canSupport, useMe } from "../layout";

interface C { id: string; entityType: string; entityId: string; incomingVersion: number; storedVersion: number; detectedAt: string; incomingPayload: Record<string, unknown>; storedPayload: Record<string, unknown>; installation: { id: string; code: string; schoolName: string } }

export default function Conflicts() {
  const me = useMe(); const q = useApi<C[]>("conflicts", { refreshMs: 30_000 });
  const resolve = useAction(async (id: string) => { await call(`conflicts/${id}/resolve`, "POST", {}); await q.reload(); });
  const diff = (a: Record<string, unknown>, b: Record<string, unknown>) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]) && !["version", "updatedAt"].includes(k));
  return (
    <main className="page">
      <h1>Sync conflicts</h1>
      <p className="lede">A conflict means the cloud already holds a newer version of a record than the one a school sent. The school's own database is the source of truth, so the school decides which version wins. Mark a conflict resolved here once it is dealt with.</p>
      {resolve.error && <Notice tone="bad">{resolve.error}</Notice>}
      {q.error ? <Notice tone="bad">{q.error.message}</Notice> : !q.data ? <p aria-busy="true" className="muted">Loading…</p> : q.data.length === 0 ? <div className="panel"><p className="empty">No open conflicts.</p></div> : (
        <div className="panel scroll-x"><table className="grid"><thead><tr><th>School</th><th>Record</th><th>Differences</th><th>Detected</th><th /></tr></thead><tbody>{q.data.map((c) => {
          const fields = diff(c.incomingPayload, c.storedPayload);
          return <tr key={c.id}><td><Link href={`/fleet?i=${c.installation.id}`}>{c.installation.schoolName}</Link></td>
            <td>{c.entityType}<br /><span className="mono muted">{c.entityId.slice(0, 8)}</span><br /><span className="muted">school v{c.incomingVersion} · cloud v{c.storedVersion}</span></td>
            <td>{fields.length === 0 ? <span className="muted">Same content</span> : <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>{fields.slice(0, 6).map((k) => <li key={k}><strong>{k}</strong>: <span className="mono">{JSON.stringify(c.storedPayload[k]) ?? "—"}</span> → <span className="mono">{JSON.stringify(c.incomingPayload[k]) ?? "—"}</span></li>)}</ul>}</td>
            <td>{when(c.detectedAt)}</td><td>{canSupport(me) && <Button small variant="secondary" disabled={resolve.pending} onClick={() => void resolve.run(c.id)}>Mark resolved</Button>}</td></tr>;
        })}</tbody></table></div>
      )}
    </main>
  );
}
