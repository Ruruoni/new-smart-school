"use client";
import { useState } from "react";
import { api, useApi, useMutation } from "@/lib/api";
import { ago } from "@/lib/format";
import { Badge, Button, Checkbox, DataState, EmptyState, ErrorNote, Field, PageHeader, Panel, SelectField, StatusBadge, TabPanel, Tabs, TextField, Textarea, useToast } from "@/ui/kit";
import { DataTable } from "@/ui/table";
import { useSession } from "@/ui/session";

type Tab = "queue" | "providers" | "templates" | "policy";
interface Del { overview: { channel: string; status: string; count: number }[]; recent: { id: string; channel: string; recipient: string; status: string; attempts: number; lastError: string | null; createdAt: string; sentAt: string | null }[] }
interface Prov { email: { host: string; port: number; secure: boolean; user?: string; from: string } | null; sms: { url: string; from: string } | null; whatsapp: { url: string; from: string } | null }
interface Tpl { id: string; key: string; channel: string; subject: string | null; body: string; isActive: boolean }

export default function Communication() {
  const [tab, setTab] = useState<Tab>("queue");
  return (<><PageHeader title="Communication" description="Messages to parents and staff. In-app notifications always work; email, SMS and WhatsApp are queued and sent whenever a provider is reachable — so nothing is lost when the internet is down." />
    <Tabs label="Communication" value={tab} onChange={setTab} tabs={[{ id: "queue", label: "Delivery queue" }, { id: "providers", label: "Providers" }, { id: "templates", label: "Message wording" }, { id: "policy", label: "Channels" }]} />
    <TabPanel id="queue" active={tab === "queue"}><Queue /></TabPanel><TabPanel id="providers" active={tab === "providers"}><Providers /></TabPanel><TabPanel id="templates" active={tab === "templates"}><Templates /></TabPanel><TabPanel id="policy" active={tab === "policy"}><Channels /></TabPanel></>);
}

function Queue() {
  const q = useApi<Del>("/communication/deliveries"); const toast = useToast();
  const requeue = async () => { const r = await api.post<{ requeued: number }>("/communication/deliveries/requeue"); toast.push("ok", `${r.requeued} message(s) queued again`); q.reload(); };
  return <DataState query={q}>{(d) => (<div className="space-y-4">
    <div className="flex flex-wrap items-center gap-2">{d.overview.length === 0 ? <span className="text-ink-500">No messages yet.</span> : d.overview.map((o) => <Badge key={o.channel + o.status} tone={o.status === "SENT" ? "ok" : o.status === "DEAD" ? "bad" : "warn"}>{o.channel.toLowerCase()} · {o.status.toLowerCase()} · {o.count}</Badge>)}{d.overview.some((o) => o.status === "DEAD") && <Button size="sm" variant="secondary" onClick={() => void requeue()}>Retry failed</Button>}</div>
    {d.recent.length === 0 ? <Panel><EmptyState title="Nothing queued" icon="mail" /></Panel> : <DataTable compact rows={d.recent} rowKey={(x) => x.id} rule={(x) => (x.status === "SENT" ? "ok" : x.status === "DEAD" ? "bad" : "warn")} columns={[{ key: "c", header: "Channel", cell: (x) => x.channel.toLowerCase() }, { key: "r", header: "To", cell: (x) => x.recipient }, { key: "s", header: "Status", cell: (x) => <StatusBadge status={x.status} /> }, { key: "a", header: "Tries", align: "right", cell: (x) => x.attempts }, { key: "e", header: "Note", className: "hidden md:table-cell", cell: (x) => x.lastError ?? (x.sentAt ? `Sent ${ago(x.sentAt)}` : "") }]} />}</div>)}</DataState>;
}

function Providers() {
  const q = useApi<Prov>("/communication/providers"); const toast = useToast();
  const [email, setEmail] = useState({ host: "", port: "587", secure: false, user: "", password: "", from: "" }); const [sms, setSms] = useState({ url: "", apiKey: "", from: "" }); const [wa, setWa] = useState({ url: "https://graph.facebook.com/v19.0", apiKey: "", from: "" });
  const [test, setTest] = useState({ channel: "", to: "" }); const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  // Only the sections that were filled in are sent; the others keep what is already saved.
  const save = useMutation(async () => {
    const body: Record<string, unknown> = {};
    if (email.host) body.email = { host: email.host, port: Number(email.port), secure: email.secure, user: email.user || undefined, password: email.password || undefined, from: email.from };
    if (sms.url) body.sms = sms;
    if (wa.url && wa.apiKey) body.whatsapp = wa;
    if (Object.keys(body).length === 0) throw new Error("Fill in at least one provider to save.");
    await api.put("/communication/providers", body); toast.push("ok", "Providers saved (secrets are stored encrypted)"); q.reload();
  });
  const remove = useMutation(async (ch: "email" | "sms" | "whatsapp") => { await api.put("/communication/providers", { [ch]: null }); toast.push("ok", "Provider removed"); q.reload(); });
  const send = useMutation(async (channel: string) => {
    setResult(null);
    const r = await api.post<{ ok: boolean; error?: string; provider?: string }>("/communication/providers/test", { channel, to: test.to });
    setResult({ ok: r.ok, text: r.ok ? "Sent. Check that the message arrived." : r.error ?? "The provider refused the message." });
  });
  const Configured = ({ text, ch }: { text: string; ch: "email" | "sms" | "whatsapp" }) => <div className="flex items-center justify-between gap-2 rounded bg-leaf-100 p-2 text-leaf-700"><span>{text}</span><Button size="sm" variant="secondary" loading={remove.pending} onClick={() => void remove.run(ch)}>Remove</Button></div>;
  return <DataState query={q}>{(d) => { const channels = [d.email && ["EMAIL", "Email"], d.sms && ["SMS", "SMS"], d.whatsapp && ["WHATSAPP", "WhatsApp"]].filter(Boolean) as string[][]; return (<div className="grid gap-6 lg:grid-cols-2">
    <Panel title="Email (SMTP)"><div className="space-y-4">{d.email && <Configured ch="email" text={`Configured: ${d.email.host}:${d.email.port} as ${d.email.from}`} />}<div className="grid gap-4 sm:grid-cols-[1fr_6rem]"><TextField label="Server" value={email.host} onChange={(e) => setEmail({ ...email, host: e.target.value })} placeholder="smtp.example.com" /><TextField label="Port" value={email.port} onChange={(e) => setEmail({ ...email, port: e.target.value })} /></div><div className="grid gap-4 sm:grid-cols-2"><TextField label="Username" value={email.user} onChange={(e) => setEmail({ ...email, user: e.target.value })} /><TextField label="Password" type="password" value={email.password} onChange={(e) => setEmail({ ...email, password: e.target.value })} /></div><TextField label="Send from" value={email.from} onChange={(e) => setEmail({ ...email, from: e.target.value })} placeholder="School <office@school.ng>" /><Checkbox label="Use SSL/TLS (port 465)" checked={email.secure} onChange={(e) => setEmail({ ...email, secure: e.target.checked })} /></div></Panel>
    <Panel title="SMS gateway"><div className="space-y-4">{d.sms && <Configured ch="sms" text={`Configured: ${d.sms.url}`} />}<TextField label="Gateway address" value={sms.url} onChange={(e) => setSms({ ...sms, url: e.target.value })} placeholder="https://api.example.com/sms/send" /><TextField label="API key" type="password" value={sms.apiKey} onChange={(e) => setSms({ ...sms, apiKey: e.target.value })} /><TextField label="Sender name" value={sms.from} onChange={(e) => setSms({ ...sms, from: e.target.value })} placeholder="SCHOOL" /><p className="text-sm text-ink-500">SMS is a premium feature: it must be enabled for your licence.</p></div></Panel>
    <Panel title="WhatsApp (Cloud API)"><div className="space-y-4">{d.whatsapp && <Configured ch="whatsapp" text={`Configured: ${d.whatsapp.url}`} />}<TextField label="API address" value={wa.url} onChange={(e) => setWa({ ...wa, url: e.target.value })} /><TextField label="Access token" type="password" value={wa.apiKey} onChange={(e) => setWa({ ...wa, apiKey: e.target.value })} /><TextField label="Phone number ID" value={wa.from} onChange={(e) => setWa({ ...wa, from: e.target.value })} hint="From your WhatsApp Business account." /></div></Panel>
    <Panel title="Send a test message"><div className="space-y-4">{channels.length === 0 ? <p className="text-ink-700">Save a provider first, then test it here.</p> : <><SelectField label="Channel" value={test.channel || channels[0]![0]} onChange={(e) => setTest({ ...test, channel: e.target.value })}>{channels.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</SelectField><TextField label="Send to" value={test.to} onChange={(e) => setTest({ ...test, to: e.target.value })} hint="An email address, or a phone number such as 0803 123 4567." /><Button variant="secondary" loading={send.pending} disabled={!test.to.trim()} onClick={() => void send.run(test.channel || channels[0]![0]!)}>Send test message</Button></>}<ErrorNote error={send.error} />{result && <p role={result.ok ? "status" : "alert"} className={`rounded p-2 font-bold ${result.ok ? "bg-leaf-100 text-leaf-700" : "bg-pen-100 text-pen-700"}`}>{result.text}</p>}</div></Panel>
    <div className="lg:col-span-2 space-y-3"><ErrorNote error={save.error} /><Button loading={save.pending} onClick={() => void save.run()}>Save providers</Button><p className="text-sm text-ink-500">Only the sections you fill in are changed. Use <strong>Remove</strong> on a configured provider to switch it off.</p></div></div>); }}</DataState>;
}

function Templates() {
  const q = useApi<Tpl[]>("/communication/templates"); const [key, setKey] = useState(""); const [edit, setEdit] = useState<Tpl | null>(null); const toast = useToast();
  const save = useMutation(async () => { await api.put(`/communication/templates/${edit!.id}`, { subject: edit!.subject, body: edit!.body, isActive: edit!.isActive }); toast.push("ok", "Wording saved"); setEdit(null); q.reload(); });
  return <DataState query={q}>{(d) => { const keys = [...new Set(d.map((t) => t.key))]; const k = key || keys[0]!; return (<div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
    <ul className="space-y-1">{keys.map((x) => <li key={x}><button className={`min-h-11 w-full cursor-pointer rounded-md px-3 text-left ${x === k ? "bg-brand-100 font-bold text-brand-800" : "hover:bg-ink-100"}`} onClick={() => { setKey(x); setEdit(null); }}>{x}</button></li>)}</ul>
    <div className="space-y-4">{d.filter((t) => t.key === k).map((t) => (<Panel key={t.id} title={t.channel === "IN_APP" ? "In-app" : t.channel[0] + t.channel.slice(1).toLowerCase()} actions={<Button size="sm" variant="secondary" onClick={() => setEdit(edit?.id === t.id ? null : t)}>{edit?.id === t.id ? "Cancel" : "Edit"}</Button>}>
      {edit?.id === t.id ? <div className="space-y-3">{t.channel !== "SMS" && t.channel !== "WHATSAPP" && <TextField label="Subject" value={edit.subject ?? ""} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} />}<Field label="Message" htmlFor={`b-${t.id}`} hint="Use {{student}}, {{class}}, {{date}}, {{amount}}, {{school}} and similar placeholders."><Textarea id={`b-${t.id}`} rows={4} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></Field><Checkbox label="Send this message" checked={edit.isActive} onChange={(e) => setEdit({ ...edit, isActive: e.target.checked })} /><ErrorNote error={save.error} /><Button loading={save.pending} onClick={() => void save.run()}>Save</Button></div> : <div><p className="text-ink-700">{t.body}</p>{!t.isActive && <Badge tone="warn">Switched off</Badge>}</div>}</Panel>))}</div></div>); }}</DataState>;
}

function Channels() {
  const q = useApi<{ channels: string[]; absenceThreshold: number }>("/settings/policies/notifications.policy"); const { me } = useSession(); const toast = useToast();
  const [v, setV] = useState<{ channels: string[]; absenceThreshold: number } | null>(null); const cur = v ?? q.data;
  const save = useMutation(async () => { await api.put("/settings/policies/notifications.policy", cur); toast.push("ok", "Saved"); setV(null); q.reload(); });
  return <DataState query={q}>{() => cur && <Panel title="Where should guardians be notified?"><div className="max-w-lg space-y-4"><p className="text-ink-700">Choose the channels used for attendance, fees and results messages. Email and SMS only go out once a provider is set up.</p>{[["IN_APP", "In the app (always available)"], ["EMAIL", "Email"], ["SMS", "SMS"], ["WHATSAPP", "WhatsApp"]].map(([c, l]) => <Checkbox key={c} label={l!} checked={cur.channels.includes(c!)} disabled={c === "IN_APP" && cur.channels.length === 1} onChange={(e) => setV({ ...cur, channels: e.target.checked ? [...cur.channels, c!] : cur.channels.filter((x) => x !== c) })} />)}<TextField label="Alert the principal after this many absences in a term" type="number" min={1} value={cur.absenceThreshold} onChange={(e) => setV({ ...cur, absenceThreshold: Number(e.target.value) })} hint="Edit the “Repeated absence alert” rule under Automation to change who is told." /><ErrorNote error={save.error} /><Button loading={save.pending} disabled={!v} onClick={() => void save.run()}>Save</Button>{me.license.plan === "trial" && <p className="text-sm text-ink-500">SMS and WhatsApp need a licence that includes them.</p>}</div></Panel>}</DataState>;
}
