"use client";
import { useState } from "react";
import { call, day, useAction, useApi } from "@/lib/api";
import { Badge, Button, Field, Notice, TextArea, TextInput } from "@/ui/kit";
import { canAdmin, useMe } from "../layout";

interface Rel { id: string; version: string; notes: string | null; mandatory: boolean; publishedAt: string }
interface Flag { key: string; enabled: boolean; description: string | null }

export default function Releases() {
  const me = useMe(); const admin = canAdmin(me);
  const rel = useApi<Rel[]>("releases"); const flags = useApi<Flag[]>("flags");
  const [version, setVersion] = useState(""); const [notes, setNotes] = useState(""); const [mandatory, setMandatory] = useState(false);
  const publish = useAction(async () => { await call("releases", "POST", { version, notes: notes || undefined, mandatory }); setVersion(""); setNotes(""); setMandatory(false); await rel.reload(); });
  const [key, setKey] = useState(""); const [desc, setDesc] = useState("");
  const setFlag = useAction(async (k: string, enabled: boolean, description?: string) => { await call("flags", "PUT", { key: k, enabled, description }); setKey(""); setDesc(""); await flags.reload(); });
  return (
    <main className="page">
      <h1>Releases &amp; flags</h1>
      <p className="lede">Publishing a release lets the tower flag schools still on an older version. Global flags apply to every school unless a school has its own override on its control panel.</p>
      <div style={{ display: "grid", gap: "1.5rem", gridTemplateColumns: "repeat(auto-fit, minmax(20rem, 1fr))", alignItems: "start" }}>
        <section className="panel"><header><h2>Releases</h2></header>
          {rel.data?.length === 0 && <p className="empty">No releases published yet.</p>}
          {rel.data?.map((r) => <div key={r.id} style={{ padding: ".7rem 1rem", borderBottom: "1px solid var(--line)" }}><strong className="mono">v{r.version}</strong> {r.mandatory && <Badge tone="warn">Mandatory</Badge>} <span className="muted">{day(r.publishedAt)}</span>{r.notes && <p style={{ margin: ".25rem 0 0" }}>{r.notes}</p>}</div>)}
          {admin && <div className="body"><h3 style={{ fontSize: "1rem", marginBottom: ".6rem" }}>Publish a release</h3>{publish.error && <Notice tone="bad">{publish.error}</Notice>}
            <Field label="Version" hint="For example 2.1.0"><TextInput value={version} onChange={(e) => setVersion(e.target.value)} /></Field>
            <Field label="What changed"><TextArea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
            <label className="check"><input type="checkbox" checked={mandatory} onChange={(e) => setMandatory(e.target.checked)} />Mandatory update</label>
            <Button loading={publish.pending} disabled={!version} onClick={() => void publish.run()}>Publish</Button></div>}
        </section>
        <section className="panel"><header><h2>Global feature flags</h2></header>
          {flags.data?.length === 0 && <p className="empty">No flags defined yet.</p>}
          {flags.data?.map((f) => <div key={f.key} className="flagrow" style={{ padding: ".6rem 1rem" }}><span><span className="mono">{f.key}</span>{f.description && <><br /><span className="muted">{f.description}</span></>}</span>
            <Button small variant={f.enabled ? undefined : "secondary"} disabled={!admin || setFlag.pending} aria-pressed={f.enabled} onClick={() => void setFlag.run(f.key, !f.enabled)}>{f.enabled ? "On" : "Off"}</Button></div>)}
          {admin && <div className="body"><h3 style={{ fontSize: "1rem", marginBottom: ".6rem" }}>Add or change a flag</h3>{setFlag.error && <Notice tone="bad">{setFlag.error}</Notice>}
            <Field label="Key" hint="module.feature, lower case"><TextInput value={key} onChange={(e) => setKey(e.target.value)} /></Field>
            <Field label="Description"><TextInput value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
            <Button loading={setFlag.pending} disabled={!key} onClick={() => void setFlag.run(key, true, desc || undefined)}>Add and turn on</Button></div>}
          {!admin && <p className="body muted">Only super admins change global flags.</p>}
        </section>
      </div>
    </main>
  );
}
