"use client";
import { useState } from "react";
import { ago, call, useAction, useApi, when } from "@/lib/api";
import { Badge, Button, Field, Notice, Select, TextInput } from "@/ui/kit";
import { canAdmin, useMe } from "../layout";

interface Op { id: string; email: string; name: string; role: "SUPER_ADMIN" | "SUPPORT" | "VIEWER"; isActive: boolean; lastLoginAt: string | null; createdAt: string }
const ROLE = { SUPER_ADMIN: "Super admin", SUPPORT: "Support", VIEWER: "Viewer" } as const;

export default function Operators() {
  const me = useMe(); const q = useApi<Op[]>(canAdmin(me) ? "operators" : null);
  const [f, setF] = useState({ email: "", name: "", password: "", role: "SUPPORT" });
  const add = useAction(async () => { await call("operators", "POST", f); setF({ email: "", name: "", password: "", role: "SUPPORT" }); await q.reload(); });
  const toggle = useAction(async (id: string, active: boolean) => { await call(`operators/${id}/active`, "POST", { active }); await q.reload(); });
  if (!canAdmin(me)) return <main className="page"><h1>Operators</h1><Notice tone="info">Only super admins manage operators.</Notice></main>;
  return (
    <main className="page">
      <h1>Operators</h1>
      <p className="lede">People who can sign in to this tower. Viewers watch, support staff operate schools, super admins also change licences, suspend schools and manage this list.</p>
      {toggle.error && <Notice tone="bad">{toggle.error}</Notice>}
      <div className="panel scroll-x"><table className="grid"><thead><tr><th>Name</th><th>Role</th><th>Last sign-in</th><th>Status</th><th /></tr></thead><tbody>{q.data?.map((o) => (
        <tr key={o.id}><td><strong>{o.name}</strong><br /><span className="muted">{o.email}</span></td><td>{ROLE[o.role]}</td><td title={when(o.lastLoginAt)}>{o.lastLoginAt ? ago(o.lastLoginAt) : "never"}</td><td><Badge tone={o.isActive ? "ok" : undefined}>{o.isActive ? "Active" : "Disabled"}</Badge></td>
          <td>{o.id !== me.id && <Button small variant="secondary" disabled={toggle.pending} onClick={() => void toggle.run(o.id, !o.isActive)}>{o.isActive ? "Disable" : "Enable"}</Button>}</td></tr>))}</tbody></table></div>
      <section className="panel" style={{ marginTop: "1.5rem", maxWidth: "32rem" }}><header><h2>Add an operator</h2></header><div className="body">{add.error && <Notice tone="bad">{add.error}</Notice>}
        <Field label="Name"><TextInput value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Email"><TextInput type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Role"><Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="VIEWER">Viewer</option><option value="SUPPORT">Support</option><option value="SUPER_ADMIN">Super admin</option></Select></Field>
        <Field label="Temporary password" hint="At least 12 characters. Share it privately."><TextInput type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        <Button loading={add.pending} disabled={!f.email || !f.name || f.password.length < 12} onClick={() => void add.run()}>Add operator</Button></div></section>
    </main>
  );
}
