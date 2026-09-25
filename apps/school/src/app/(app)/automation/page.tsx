"use client";
import { useState } from "react";
import { api, useApi, useMutation } from "@/lib/api";
import { ago } from "@/lib/format";
import { Badge, Button, ConfirmDialog, DataState, Dialog, EmptyState, ErrorNote, Panel, PageHeader, SelectField, StatusBadge, Switch, TabPanel, Tabs, TextField, useToast } from "@/ui/kit";
import { Can } from "@/ui/session";
import { DataTable } from "@/ui/table";

interface Rule { id: string; name: string; description: string | null; isEnabled: boolean; isSystem: boolean; version: number; conditions: { field: string; op: string; value?: unknown }[]; triggers: { kind: string; eventType: string | null; schedule: unknown }[]; actions: { type: string; config: Record<string, unknown> }[]; _count: { executions: number } }
interface Exec { id: string; status: string; startedAt: string; error: string | null; rule: { name: string } }
const EVENTS = ["attendance.absent", "attendance.late", "payment.received", "payment.reversed", "invoice.issued", "invoice.overdue", "result.published", "admission.submitted", "admission.approved", "admission.rejected", "exam.scheduled", "cbt.result_available", "announcement.published"];
const OPS = [[">=", "is at least"], [">", "is more than"], ["<", "is less than"], ["=", "equals"], ["!=", "is not"], ["contains", "contains"]];
const ACTIONS = [["notify_guardians", "Notify the student's guardians"], ["notify_student", "Notify the student"], ["notify_role", "Notify everyone with a role"], ["create_announcement", "Post an announcement"]];
const ROLES = ["principal", "bursar", "registrar", "teacher"];

export default function Automation() {
  const q = useApi<{ rules: Rule[] }>("/automation/rules"); const ex = useApi<Exec[]>("/automation/executions"); const toast = useToast();
  const [tab, setTab] = useState<"rules" | "log">("rules"); const [open, setOpen] = useState(false); const [del, setDel] = useState<Rule | null>(null);
  const toggle = async (r: Rule, v: boolean) => { await api.post(`/automation/rules/${r.id}/enabled`, { enabled: v }); q.reload(); };
  const remove = useMutation(async () => { await api.del(`/automation/rules/${del!.id}`); toast.push("ok", "Rule deleted"); setDel(null); q.reload(); });
  const [f, setF] = useState({ name: "", event: "attendance.absent", field: "", op: ">=", value: "", action: "notify_guardians", template: "attendance.absent", role: "principal" });
  const create = useMutation(async () => {
    const cfg = f.action === "notify_role" ? { template: f.template, role: f.role } : f.action === "create_announcement" ? { title: f.name, body: f.template, roles: [] } : { template: f.template };
    await api.post("/automation/rules", { name: f.name, trigger: { kind: "EVENT", eventType: f.event }, conditions: f.field ? [{ field: f.field, op: f.op, value: isNaN(Number(f.value)) ? f.value : Number(f.value) }] : [], actions: [{ type: f.action, config: cfg }] }); toast.push("ok", "Rule created"); setOpen(false); q.reload();
  });
  return (<>
    <PageHeader title="Automation" description="When something happens, the school reacts on its own. Each rule: an event, optional conditions, then actions. Every run is logged." actions={<Can perm={["automation.manage"]}><Button icon="plus" onClick={() => setOpen(true)}>New rule</Button></Can>} />
    <Tabs label="Automation" value={tab} onChange={setTab} tabs={[{ id: "rules", label: "Rules" }, { id: "log", label: "Recent runs" }]} />
    <TabPanel id="rules" active={tab === "rules"}><DataState query={q}>{(d) => d.rules.length === 0 ? <Panel><EmptyState title="No rules" icon="bolt" /></Panel> : <ul className="space-y-3">{d.rules.map((r) => (
      <li key={r.id}><Panel><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="font-serif text-lg font-semibold">{r.name} {r.isSystem && <Badge>Built in</Badge>}</p>{r.description && <p className="text-ink-500">{r.description}</p>}
        <p className="mt-2 text-[0.9375rem]"><strong>When</strong> {r.triggers.map((t) => t.eventType ?? JSON.stringify(t.schedule)).join(", ")}{r.conditions.length > 0 && <> <strong>and</strong> {r.conditions.map((c) => `${c.field.replace("payload.", "")} ${c.op} ${String(c.value ?? "")}`).join(" and ")}</>} <strong>then</strong> {r.actions.map((a) => ACTIONS.find((x) => x[0] === a.type)?.[1] ?? a.type).join(", ")}</p><p className="mt-1 text-sm text-ink-500">{r._count.executions} run{r._count.executions === 1 ? "" : "s"}</p></div>
        <div className="flex items-center gap-3"><Can perm={["automation.manage"]}><Switch checked={r.isEnabled} label={`${r.name} enabled`} onChange={(v) => void toggle(r, v)} />{!r.isSystem && <Button size="sm" variant="ghost" icon="trash" onClick={() => setDel(r)}>Delete</Button>}</Can></div></div></Panel></li>))}</ul>}</DataState></TabPanel>
    <TabPanel id="log" active={tab === "log"}><DataState query={ex}>{(d) => d.length === 0 ? <Panel><EmptyState title="No runs yet" icon="bolt" /></Panel> : <DataTable compact rows={d} rowKey={(e) => e.id} rule={(e) => (e.status === "FAILED" ? "bad" : e.status === "SKIPPED" ? undefined : "ok")} columns={[{ key: "r", header: "Rule", cell: (e) => e.rule.name }, { key: "s", header: "Result", cell: (e) => <StatusBadge status={e.status} /> }, { key: "w", header: "When", cell: (e) => ago(e.startedAt) }, { key: "x", header: "Detail", cell: (e) => e.error ?? "" }]} />}</DataState></TabPanel>
    <Dialog open={open} onClose={() => setOpen(false)} wide title="New rule" footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={create.pending} disabled={f.name.length < 3 || !f.template} onClick={() => void create.run()}>Create rule</Button></>}>
      <div className="space-y-4"><TextField label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /><SelectField label="When this happens" value={f.event} onChange={(e) => setF({ ...f, event: e.target.value })}>{EVENTS.map((e) => <option key={e}>{e}</option>)}</SelectField>
        <fieldset className="space-y-2"><legend className="font-bold">Only if (optional)</legend><div className="grid gap-3 sm:grid-cols-3"><TextField label="Detail" value={f.field} onChange={(e) => setF({ ...f, field: e.target.value })} placeholder="payload.absenceCount" /><SelectField label="Comparison" value={f.op} onChange={(e) => setF({ ...f, op: e.target.value })}>{OPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</SelectField><TextField label="Value" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} /></div></fieldset>
        <div className="grid gap-4 sm:grid-cols-2"><SelectField label="Then" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })}>{ACTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</SelectField>{f.action === "notify_role" && <SelectField label="Role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</SelectField>}</div>
        <TextField label={f.action === "create_announcement" ? "Announcement text" : "Message template key"} value={f.template} onChange={(e) => setF({ ...f, template: e.target.value })} hint={f.action === "create_announcement" ? undefined : "Use one from Communication → Message wording, for example attendance.absent"} /><ErrorNote error={create.error} /></div></Dialog>
    <ConfirmDialog open={!!del} onClose={() => setDel(null)} title={`Delete "${del?.name}"?`} danger confirmLabel="Delete rule" pending={remove.pending} onConfirm={() => void remove.run()} body="The rule stops running. Its history is deleted with it." />
  </>);
}
