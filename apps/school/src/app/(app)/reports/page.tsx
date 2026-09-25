"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api, useApi, useMutation } from "@/lib/api";
import { dateTime, today } from "@/lib/format";
import { Badge, Button, DataState, EmptyState, ErrorNote, PageHeader, Panel, SelectField, TextField } from "@/ui/kit";
import { ClassSelect, TermSelect } from "@/ui/pickers";
import { DataTable } from "@/ui/table";
import { WorkerNotice } from "@/ui/worker-notice";

/** Plain words for the export lifecycle: requested/queued → preparing → ready, or failed with a reason. */
const EXPORT_LABEL: Record<string, string> = { QUEUED: "Waiting to start", RUNNING: "Preparing", SUCCEEDED: "Ready", FAILED: "Failed" };

interface Avail { available: { kind: string; label: string; formats: string[] }[]; mine: { id: string; kind: string; format: string; status: string; createdAt: string; error: string | null }[] }
interface Prev { title: string; subtitle?: string; columns: { key: string; label: string; format?: string }[]; rows: Record<string, unknown>[]; summary?: { label: string; value: string }[] }

function ReportsInner() {
  const sp = useSearchParams();
  const q = useApi<Avail>("/reports");
  const [kind, setKind] = useState(sp.get("kind") ?? ""); const [format, setFormat] = useState("PDF");
  const [p, setP] = useState<Record<string, string>>({ termId: sp.get("termId") ?? "", classId: sp.get("classId") ?? "", from: today().slice(0, 8) + "01", to: today(), status: "ACTIVE", examId: "", minBalance: "0" });
  const set = (k: string) => (v: string) => setP((s) => ({ ...s, [k]: v }));
  useEffect(() => { if (!kind && q.data?.available[0]) setKind(q.data.available[0].kind); }, [kind, q.data]);
  const def = q.data?.available.find((a) => a.kind === kind);
  const params = (): Record<string, unknown> => {
    switch (kind) {
      case "STUDENT_LIST": return { classId: p.classId || undefined, status: p.status };
      case "CLASS_RESULTS": case "REPORT_CARD": return { termId: p.termId, classId: p.classId };
      case "ATTENDANCE": return { classId: p.classId, from: p.from, to: p.to };
      case "FINANCE_SUMMARY": return { from: p.from, to: p.to };
      case "DEBTORS": return { minBalance: Number(p.minBalance) };
      case "CBT_RESULTS": return { examId: p.examId };
      case "SUBJECT_PERFORMANCE": return { termId: p.termId || undefined };
      default: return {};
    }
  };
  const [prev, setPrev] = useState<Prev | null>(null);
  const preview = useMutation(async () => { setPrev(await api.post<Prev>("/reports/preview", { kind, params: params() })); });
  const request = useMutation(async () => { await api.post("/reports", { kind, format, params: params() }); setPrev(null); q.reload(); });
  // poll queued/running exports
  useEffect(() => { if (q.data?.mine.some((m) => ["QUEUED", "RUNNING"].includes(m.status))) { const t = setTimeout(q.reload, 2500); return () => clearTimeout(t); } }, [q]);
  const needs = { term: ["CLASS_RESULTS", "REPORT_CARD", "SUBJECT_PERFORMANCE"].includes(kind), cls: ["CLASS_RESULTS", "REPORT_CARD", "ATTENDANCE", "STUDENT_LIST"].includes(kind), range: ["ATTENDANCE", "FINANCE_SUMMARY"].includes(kind) };
  const waiting = !!q.data?.mine.some((m) => m.status === "QUEUED" || m.status === "RUNNING");
  return (<>
    <PageHeader title="Reports" description="Preview on screen, print, or download as PDF, Excel or CSV. Big reports are prepared in the background — you can keep working." />
    <div className="grid gap-6 lg:grid-cols-[22rem_1fr]">
      <Panel title="Choose a report"><div className="space-y-4">
        <SelectField label="Report" value={kind} onChange={(e) => { setKind(e.target.value); setPrev(null); }}>{q.data?.available.map((a) => <option key={a.kind} value={a.kind}>{a.label}</option>)}</SelectField>
        {needs.term && <div><p className="mb-1.5 font-bold">Term</p><TermSelect value={p.termId ?? ""} onChange={set("termId")} /></div>}
        {needs.cls && <div><p className="mb-1.5 font-bold">Class</p><ClassSelect allowAll={kind === "STUDENT_LIST"} value={p.classId ?? ""} onChange={set("classId")} /></div>}
        {needs.range && <div className="grid grid-cols-2 gap-3"><TextField label="From" type="date" value={p.from} onChange={(e) => set("from")(e.target.value)} /><TextField label="To" type="date" value={p.to} onChange={(e) => set("to")(e.target.value)} /></div>}
        {kind === "STUDENT_LIST" && <SelectField label="Status" value={p.status} onChange={(e) => set("status")(e.target.value)}>{["ACTIVE", "SUSPENDED", "WITHDRAWN", "TRANSFERRED", "GRADUATED"].map((s) => <option key={s} value={s}>{s[0] + s.slice(1).toLowerCase()}</option>)}</SelectField>}
        {kind === "DEBTORS" && <TextField label="Only balances above (₦)" type="number" value={p.minBalance} onChange={(e) => set("minBalance")(e.target.value)} />}
        {kind === "CBT_RESULTS" && <TextField label="Exam ID" value={p.examId} onChange={(e) => set("examId")(e.target.value)} hint="Open the exam and copy the ID from the address bar" />}
        <SelectField label="Download as" value={format} onChange={(e) => setFormat(e.target.value)}>{(def?.formats ?? ["PDF"]).map((f) => <option key={f} value={f}>{f === "XLSX" ? "Excel" : f}</option>)}</SelectField>
        <ErrorNote error={preview.error ?? request.error} />
        <div className="flex flex-wrap gap-2">{kind !== "REPORT_CARD" && <Button variant="secondary" loading={preview.pending} onClick={() => void preview.run()}>Preview</Button>}<Button icon="download" loading={request.pending} onClick={() => void request.run()}>Prepare {format === "XLSX" ? "Excel" : format}</Button></div>
      </div></Panel>
      <div className="space-y-6 min-w-0">
        {prev && <Panel title={prev.title} actions={<Button size="sm" variant="secondary" icon="print" onClick={() => window.print()}>Print</Button>} padded={false}><div className="overflow-x-auto"><table className="register compact"><thead><tr>{prev.columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead><tbody>{prev.rows.slice(0, 200).map((r, i) => <tr key={i}>{prev.columns.map((c) => <td key={c.key} className={c.format === "money" || c.format === "percent" || c.format === "integer" ? "right num" : ""}>{fmtCell(r[c.key], c.format)}</td>)}</tr>)}</tbody></table></div>{prev.summary && <dl className="grid grid-cols-[1fr_auto] gap-1 border-t border-line p-4">{prev.summary.map((s) => <div key={s.label} className="contents"><dt className="text-ink-500">{s.label}</dt><dd className="num font-bold">{s.value}</dd></div>)}</dl>}</Panel>}
        <WorkerNotice waiting={waiting} what="report" />
        <Panel title="My recent reports" padded={false}><DataState query={q}>{(d) => d.mine.length === 0 ? <EmptyState title="Nothing prepared yet" icon="print" /> : <DataTable compact rows={d.mine} rowKey={(m) => m.id} columns={[{ key: "k", header: "Report", cell: (m) => `${m.kind.replace(/_/g, " ").toLowerCase()} (${m.format})` }, { key: "d", header: "Requested", cell: (m) => dateTime(m.createdAt) }, { key: "s", header: "Status", cell: (m) => <span className="inline-flex flex-wrap items-center gap-2"><Badge tone={m.status === "SUCCEEDED" ? "ok" : m.status === "FAILED" ? "bad" : "warn"}>{EXPORT_LABEL[m.status] ?? m.status}</Badge>{m.status === "RUNNING" && <span className="text-sm text-ink-500">Preparing…</span>}</span> }, { key: "x", header: "", cell: (m) => (m.status === "SUCCEEDED" ? <a className="font-bold text-brand-700 underline" href={`/api/reports/${m.id}/download`}>Download</a> : m.error ? <span className={m.status === "FAILED" ? "text-pen-700" : "text-amber-700"}>{m.error}</span> : null) }]} />}</DataState></Panel>
      </div>
    </div></>);
}
function fmtCell(v: unknown, f?: string) { if (v === null || v === undefined) return ""; if (f === "money") return `₦${Number(v).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`; if (f === "percent") return `${Number(v).toFixed(1)}%`; if (f === "date") return new Date(String(v)).toLocaleDateString("en-GB", { timeZone: "UTC" }); return String(v); }
export default function Reports() { return <Suspense><ReportsInner /></Suspense>; }
