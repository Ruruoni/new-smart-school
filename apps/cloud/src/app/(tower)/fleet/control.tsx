"use client";
import { useEffect, useState } from "react";
import { call, day, useAction, when } from "@/lib/api";
import { Button, Dialog, Field, Notice, Select, TextArea, TextInput } from "@/ui/kit";
import { canAdmin, canSupport, useMe } from "../layout";
import type { Detail } from "./types";

export function ControlPanel({ d, reload }: { d: Detail; reload: () => void }) {
  const me = useMe(); const i = d.installation;
  const support = canSupport(me), admin = canAdmin(me);
  const live = i.status === "ACTIVE" || i.status === "SUSPENDED" || i.status === "PENDING";

  // ── registration token (shown once) ──
  const [token, setToken] = useState<string | null>(null);
  const issue = useAction(async () => { setToken((await call<{ registrationToken: string }>(`installations/${i.id}/token`, "POST", {})).registrationToken); reload(); });

  // ── licence ──
  const [plan, setPlan] = useState(i.plan); const [exp, setExp] = useState((i.licenseExpiresAt ?? "").slice(0, 10)); const [grace, setGrace] = useState(String(i.graceDays)); const [mods, setMods] = useState<string[]>(i.modules);
  useEffect(() => { setPlan(i.plan); setExp((i.licenseExpiresAt ?? "").slice(0, 10)); setGrace(String(i.graceDays)); setMods(i.modules); setToken(null); }, [i.id, i.plan, i.licenseExpiresAt, i.graceDays, i.modules]);
  const [saved, setSaved] = useState<string | null>(null);
  const saveLic = useAction(async () => { await call(`installations/${i.id}/license`, "PUT", { plan, modules: mods, graceDays: Number(grace), ...(exp ? { expiresAt: `${exp}T23:59:59.000Z` } : {}) }); setSaved("Licence saved. The school receives it on its next check-in."); reload(); });

  // ── flags ──
  const [newKey, setNewKey] = useState("");
  const flag = useAction(async (key: string, v: "" | "on" | "off") => { await call(`installations/${i.id}/flags`, "PUT", { key, enabled: v === "" ? null : v === "on" }); reload(); });
  const flagKeys = [...new Set([...d.flags.map((f) => f.key), ...Object.keys(i.featureOverrides)])].sort();

  // ── commands ──
  const [msg, setMsg] = useState(""); const [sent, setSent] = useState<string | null>(null);
  const cmd = useAction(async (c: "MESSAGE" | "REQUEST_BACKUP" | "REQUEST_DIAGNOSTICS") => { await call(`installations/${i.id}/commands`, "POST", { cmd: c, ...(c === "MESSAGE" ? { text: msg } : {}) }); setSent(c === "MESSAGE" ? "Message queued. It appears as a banner after the school's next check-in." : c === "REQUEST_BACKUP" ? "Backup requested. The school runs it and uploads the encrypted file." : "Diagnostics requested."); if (c === "MESSAGE") setMsg(""); reload(); });

  // ── notes ──
  const [notes, setNotes] = useState(i.notes ?? ""); useEffect(() => setNotes(i.notes ?? ""), [i.id, i.notes]);
  const saveNotes = useAction(async () => { await call(`installations/${i.id}/notes`, "PUT", { notes }); reload(); });

  // ── suspend / resume / decommission ──
  const [dlg, setDlg] = useState<null | "suspend" | "decommission">(null); const [reason, setReason] = useState(""); const [confirmCode, setConfirmCode] = useState("");
  const close = () => { setDlg(null); setReason(""); setConfirmCode(""); };
  const suspend = useAction(async () => { await call(`installations/${i.id}/suspend`, "POST", { reason }); close(); reload(); });
  const resume = useAction(async () => { await call(`installations/${i.id}/resume`, "POST", {}); reload(); });
  const decom = useAction(async () => { await call(`installations/${i.id}/decommission`, "POST", { reason }); close(); reload(); });

  return (
    <div>
      <h2 style={{ fontSize: "1.25rem", marginBottom: ".75rem" }}>Control panel</h2>
      {!support && <Notice tone="info">Your role can view this installation but not change it.</Notice>}

      <details className="ctl" open={i.status === "PENDING"}><summary>Registration</summary><div>
        <p className="muted" style={{ marginTop: 0 }}>{i.registeredAt ? `Registered ${when(i.registeredAt)}${i.lastIp ? ` from ${i.lastIp}` : ""}.` : "Not registered yet."} A token works once and expires after 14 days; a new token cancels the old one.</p>
        {token && <><p><strong>Copy this now. It is shown only once.</strong></p><p className="token" data-testid="registration-token">{token}</p></>}
        {issue.error && <Notice tone="bad">{issue.error}</Notice>}
        {support && i.status !== "DECOMMISSIONED" && <Button variant="secondary" loading={issue.pending} onClick={() => void issue.run()}>{i.registeredAt ? "Issue a re-registration token" : "Issue a new token"}</Button>}
      </div></details>

      <details className="ctl" open><summary>Licence</summary><div>
        <fieldset disabled={!admin} style={{ border: 0, padding: 0, margin: 0 }}>
          <Field label="Plan"><TextInput value={plan} onChange={(e) => setPlan(e.target.value)} /></Field>
          <Field label="Licence ends" hint="After this date the school gets its grace period, then switches to read-only. Data is never locked away."><TextInput type="date" value={exp} onChange={(e) => setExp(e.target.value)} /></Field>
          <Field label="Grace days after expiry"><TextInput type="number" min={0} max={365} value={grace} onChange={(e) => setGrace(e.target.value)} /></Field>
          <p style={{ fontWeight: 700, margin: "0 0 .3rem" }}>Modules included</p>
          {d.moduleCatalogue.map((k) => <label key={k} className="check"><input type="checkbox" checked={mods.includes(k)} onChange={(e) => setMods((m) => (e.target.checked ? [...m, k] : m.filter((x) => x !== k)))} />{k}</label>)}
        </fieldset>
        {saveLic.error && <Notice tone="bad">{saveLic.error}</Notice>}{saved && !saveLic.error && <Notice tone="ok">{saved}</Notice>}
        {admin ? <Button loading={saveLic.pending} onClick={() => { setSaved(null); void saveLic.run(); }}>Save licence</Button> : <p className="muted">Only super admins change licences.</p>}
      </div></details>

      <details className="ctl"><summary>Feature flags</summary><div>
        <p className="muted" style={{ marginTop: 0 }}>“Follow default” uses the global setting. On or Off overrides it for this school only.</p>
        {flagKeys.length === 0 && <p className="muted">No flags defined yet. Add one below or under Releases &amp; flags.</p>}
        {flagKeys.map((k) => { const eff = d.flags.find((f) => f.key === k)?.enabled ?? false; const ov = k in i.featureOverrides ? (i.featureOverrides[k] ? "on" : "off") : "";
          return <div key={k} className="flagrow"><span><span className="mono">{k}</span><br /><span className="muted">Currently {eff ? "on" : "off"}</span></span>
            <Select aria-label={`${k} for this school`} disabled={!support || flag.pending} value={ov} onChange={(e) => void flag.run(k, e.target.value as "" | "on" | "off")}><option value="">Follow default</option><option value="on">On</option><option value="off">Off</option></Select></div>; })}
        {flag.error && <Notice tone="bad">{flag.error}</Notice>}
        {support && <div style={{ display: "flex", gap: ".5rem", marginTop: ".75rem" }}><TextInput aria-label="New flag key" placeholder="module.feature" value={newKey} onChange={(e) => setNewKey(e.target.value)} /><Button variant="secondary" disabled={!newKey} onClick={() => { void flag.run(newKey, "on").then(() => setNewKey("")); }}>Turn on</Button></div>}
      </div></details>

      <details className="ctl" open><summary>Talk to the school</summary><div>
        {i.status === "PENDING" ? <p className="muted">Available once the school has registered.</p> : <>
          <Field label="Message shown to the school's administrators" hint="Up to 500 characters. Delivered on the next check-in."><TextArea maxLength={500} value={msg} onChange={(e) => setMsg(e.target.value)} disabled={!support} /></Field>
          {cmd.error && <Notice tone="bad">{cmd.error}</Notice>}{sent && !cmd.error && <Notice tone="ok">{sent}</Notice>}
          {support && <div style={{ display: "flex", flexWrap: "wrap", gap: ".5rem" }}><Button loading={cmd.pending} disabled={!msg.trim()} onClick={() => { setSent(null); void cmd.run("MESSAGE"); }}>Send message</Button><Button variant="secondary" disabled={cmd.pending} onClick={() => { setSent(null); void cmd.run("REQUEST_BACKUP"); }}>Request a backup</Button><Button variant="secondary" disabled={cmd.pending} onClick={() => { setSent(null); void cmd.run("REQUEST_DIAGNOSTICS"); }}>Request diagnostics</Button></div>}
          {i.commands.length > 0 && <table className="grid" style={{ marginTop: ".9rem" }}><thead><tr><th>Sent</th><th>Command</th><th>Delivered</th></tr></thead><tbody>{i.commands.map((c) => <tr key={c.id}><td className="num">{when(c.issuedAt)}</td><td>{c.type.replace(/_/g, " ").toLowerCase()}</td><td>{c.deliveredAt ? when(c.deliveredAt) : new Date(c.expiresAt) < new Date() ? "Expired" : "Waiting"}</td></tr>)}</tbody></table>}
        </>}
      </div></details>

      <details className="ctl"><summary>Contact &amp; notes</summary><div>
        <p style={{ marginTop: 0 }}>{[i.contactName, i.contactPhone, i.contactEmail].filter(Boolean).join(" · ") || <span className="muted">No contact recorded.</span>}</p>
        <Field label="Internal notes (never shown to the school)"><TextArea value={notes} maxLength={4000} onChange={(e) => setNotes(e.target.value)} disabled={!support} /></Field>
        {saveNotes.error && <Notice tone="bad">{saveNotes.error}</Notice>}{support && <Button variant="secondary" loading={saveNotes.pending} onClick={() => void saveNotes.run()}>Save notes</Button>}
      </div></details>

      {admin && live && (
        <details className="ctl danger"><summary>Suspend or retire</summary><div>
          {i.status === "SUSPENDED" ? <>
            <p>Suspended {when(i.suspendedAt)}: “{i.suspendedReason}”.</p>
            {resume.error && <Notice tone="bad">{resume.error}</Notice>}<Button loading={resume.pending} onClick={() => void resume.run()}>Resume this school</Button>
          </> : i.status === "ACTIVE" ? <>
            <p className="muted" style={{ marginTop: 0 }}>Suspending switches the school to administrator-only mode the next time it connects. Its data stays intact and exportable, and it never happens because of an outage.</p>
            <Button variant="danger" onClick={() => setDlg("suspend")}>Suspend this school…</Button>
          </> : null}
          <hr style={{ margin: "1rem 0", border: 0, borderTop: "1px solid var(--line)" }} />
          <p className="muted" style={{ marginTop: 0 }}>Decommissioning ends the school's connection to the cloud for good. Use it when a school stops using SmartSchool.</p>
          <Button variant="danger" onClick={() => setDlg("decommission")}>Decommission…</Button>
        </div></details>
      )}

      <Dialog open={dlg === "suspend"} title={`Suspend ${i.schoolName}?`} onClose={close} footer={<><Button variant="secondary" onClick={close}>Cancel</Button><Button variant="danger" loading={suspend.pending} disabled={reason.trim().length < 5} onClick={() => void suspend.run()}>Suspend school</Button></>}>
        <p style={{ marginTop: 0 }}>Teachers, parents and students will lose access the next time the school connects. The principal keeps administrator access and all data stays exportable.</p>
        <Field label="Reason (recorded in the audit log)"><TextArea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>{suspend.error && <Notice tone="bad">{suspend.error}</Notice>}
      </Dialog>
      <Dialog open={dlg === "decommission"} title={`Decommission ${i.schoolName}?`} onClose={close} footer={<><Button variant="secondary" onClick={close}>Cancel</Button><Button variant="danger" loading={decom.pending} disabled={reason.trim().length < 5 || confirmCode !== i.code} onClick={() => void decom.run()}>Decommission</Button></>}>
        <p style={{ marginTop: 0 }}>This cannot be undone. The school's secret is destroyed and it can no longer register, sync or send heartbeats.</p>
        <Field label="Reason"><TextArea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <Field label={`Type the code ${i.code} to confirm`}><TextInput value={confirmCode} onChange={(e) => setConfirmCode(e.target.value)} autoComplete="off" /></Field>{decom.error && <Notice tone="bad">{decom.error}</Notice>}
      </Dialog>
      <p className="muted" style={{ fontSize: ".875rem" }}>Licence issued {day(i.licenseIssuedAt)} · schema {i.schemaVersion ?? "—"}</p>
    </div>
  );
}
