"use client";
import { api, useApi } from "@/lib/api";
import { Badge, DataState, ErrorNote, PageHeader, Panel, Switch, useToast } from "@/ui/kit";
import { useSession } from "@/ui/session";
import { useState } from "react";
import type { ApiError } from "@/lib/api";
import { DataTable } from "@/ui/table";

interface M { modules: { key: string; isCore: boolean; licensed: boolean; enabled: boolean; localEnabled: boolean }[]; flags: { key: string; enabled: boolean; source: string; locked: boolean }[]; license: { status: string; mode: string; plan: string; message: string | null } }
const LABEL: Record<string, string> = { platform: "Platform core", students: "Students", staff: "Teachers & staff", academics: "Classes & subjects", results: "Results", admissions: "Admissions", finance: "Fees & payments", attendance: "Attendance", timetable: "Timetable", lessonnotes: "Lesson notes", cbt: "CBT exams", examprep: "Exam practice (WAEC/NECO/JAMB/BECE)", communication: "Communication", automation: "Automation", analytics: "Analytics", reports: "Reports", imports: "Excel imports", sync: "Cloud sync", backup: "Backup" };

export default function Modules() {
  const q = useApi<M>("/settings/modules"); const toast = useToast(); const { reload } = useSession(); const [err, setErr] = useState<ApiError | null>(null);
  const toggle = async (path: string, enabled: boolean) => { setErr(null); try { await api.put(path, { enabled }); toast.push("ok", "Updated"); q.reload(); reload(); } catch (e) { setErr(e as ApiError); } };
  return (<><PageHeader title="Modules and features" description="Switch parts of the system on or off for this school. Turning a module off hides it and stops it working on the server for everyone — no data is deleted." />
    <ErrorNote error={err} />
    <DataState query={q}>{(d) => (<div className="space-y-6">
      <Panel title="Modules" padded={false}><DataTable rows={d.modules} rowKey={(m) => m.key} rule={(m) => (!m.licensed ? "bad" : m.enabled ? "ok" : "warn")} columns={[{ key: "n", header: "Module", cell: (m) => <strong>{LABEL[m.key] ?? m.key}</strong> }, { key: "l", header: "Licence", cell: (m) => (m.licensed ? <Badge tone="ok">Included</Badge> : <Badge tone="bad">Not in your licence</Badge>) }, { key: "s", header: "On / off", cell: (m) => (m.isCore ? <span className="text-ink-500">Always on</span> : <Switch checked={m.localEnabled && m.licensed} disabled={!m.licensed} label={`${LABEL[m.key] ?? m.key} enabled`} onChange={(v) => void toggle(`/settings/modules/${m.key}`, v)} />) }]} /></Panel>
      <Panel title="Features" padded={false}><DataTable rows={d.flags} rowKey={(f) => f.key} columns={[{ key: "n", header: "Feature", cell: (f) => <span className="num font-bold">{f.key}</span> }, { key: "c", header: "Controlled by", cell: (f) => (f.locked ? <Badge tone="info">Your licence</Badge> : "This school") }, { key: "s", header: "On / off", cell: (f) => <Switch checked={f.enabled} disabled={f.locked} label={`${f.key} enabled`} onChange={(v) => void toggle(`/settings/features/${f.key}`, v)} /> }]} /></Panel></div>)}</DataState></>);
}
