"use client";
import { useState } from "react";
import { api, useApi } from "@/lib/api";
import { ago, int, money, pct } from "@/lib/format";
import { Button, DataState, EmptyState, PageHeader, Panel, Stat, TabPanel, Tabs } from "@/ui/kit";
import { useSession } from "@/ui/session";
import { DataTable } from "@/ui/table";
import { Bars, Line } from "@/ui/charts";

interface Snap<T> { data: T; computedAt: string; stale: boolean }
type Tab = "academic" | "finance" | "attendance" | "cbt";

export default function Analytics() {
  const { hasModule, can } = useSession();
  const tabs: { id: Tab; label: string }[] = [...(hasModule("results") ? [{ id: "academic" as Tab, label: "Academic" }] : []), ...(hasModule("finance") && can("finance.reports") ? [{ id: "finance" as Tab, label: "Finance" }] : []), ...(hasModule("attendance") ? [{ id: "attendance" as Tab, label: "Attendance" }] : []), ...(hasModule("cbt") ? [{ id: "cbt" as Tab, label: "CBT & exam prep" }] : [])];
  const [tab, setTab] = useState<Tab>(tabs[0]?.id ?? "academic");
  return (<><PageHeader title="Analytics" description="Summaries are prepared in the background so these pages stay fast, even for a large school." />
    <Tabs label="Analytics" value={tab} onChange={setTab} tabs={tabs} />
    <TabPanel id="academic" active={tab === "academic"}><Academic /></TabPanel><TabPanel id="finance" active={tab === "finance"}><Finance /></TabPanel><TabPanel id="attendance" active={tab === "attendance"}><Attendance /></TabPanel><TabPanel id="cbt" active={tab === "cbt"}><Cbt /></TabPanel></>);
}

function Fresh<T>({ q, dataset, children }: { q: ReturnType<typeof useApi<Snap<T>>>; dataset: string; children: (d: T) => React.ReactNode }) {
  return <DataState query={q}>{(s) => (<div className="space-y-6">{children(s.data)}<p className="flex items-center gap-3 text-sm text-ink-500">Updated {ago(s.computedAt)}<Button size="sm" variant="ghost" icon="refresh" onClick={async () => { await api.post(`/analytics/${dataset}/refresh`); q.reload(); }}>Refresh now</Button></p></div>)}</DataState>;
}

function Academic() {
  const q = useApi<Snap<{ term: { name: string } | null; classes: { class: string; students: number; average: number; highest: number; lowest: number }[]; subjects: { subject: string; average: number; results: number; passRate: number | null }[]; gradeDistribution: { grade: string; count: number }[]; trend: { term: string; class: string; average: number }[]; topStudents: { name: string; admissionNumber: string; average: number; position: number | null }[] }>>("/analytics/academic.performance");
  return <Fresh q={q} dataset="academic.performance">{(d) => !d.term || d.classes.length === 0 ? <Panel><EmptyState title="No processed results yet" icon="target">Process a class's results to see performance here.</EmptyState></Panel> : (<>
    <div className="grid gap-6 lg:grid-cols-2"><Panel title={`Class averages — ${d.term.name}`}><Bars data={d.classes.map((c) => ({ label: c.class, value: c.average }))} format={(v) => pct(v, 1)} max={100} /></Panel><Panel title="Grade distribution"><Bars data={d.gradeDistribution.map((g) => ({ label: g.grade, value: g.count }))} format={(v) => int(v)} tone="brand" /></Panel></div>
    <Panel title="Subjects" padded={false}><DataTable compact rows={d.subjects} rowKey={(s) => s.subject} columns={[{ key: "s", header: "Subject", cell: (s) => <strong>{s.subject}</strong> }, { key: "r", header: "Results", align: "right", cell: (s) => s.results }, { key: "a", header: "Average", align: "right", cell: (s) => pct(s.average) }, { key: "p", header: "Pass rate", align: "right", cell: (s) => pct(s.passRate) }]} /></Panel>
    <div className="grid gap-6 lg:grid-cols-2"><Panel title="Top students" padded={false}><DataTable compact rows={d.topStudents} rowKey={(s) => s.admissionNumber} columns={[{ key: "p", header: "#", cell: (s) => s.position ?? "" }, { key: "n", header: "Student", cell: (s) => s.name }, { key: "a", header: "Average", align: "right", cell: (s) => pct(s.average) }]} /></Panel>
      <Panel title="Average by term">{d.trend.length < 2 ? <p className="text-ink-500">Trends appear after two terms are processed.</p> : <Line data={[...new Set(d.trend.map((t) => t.term))].map((term) => ({ label: term, value: d.trend.filter((t) => t.term === term).reduce((s, t, _, a) => s + t.average / a.length, 0) }))} />}</Panel></div></>)}</Fresh>;
}

function Finance() {
  const q = useApi<Snap<{ summary: { billed: string; cashCollected: string; outstanding: string; expenses: string; collectionRate: number | null }; monthly: { month: string; collected: number; billed: number }[]; aging: { bucket: string; amount: number; invoices: number }[]; debtors: { name: string; admissionNumber: string; owed: number; oldestDue: string | null }[]; methods: { method: string; amount: number }[]; collectionByClass: { class: string; billed: number; paid: number; rate: number | null }[]; expensesByCategory: { category: string; amount: number }[] }>>("/analytics/finance.overview");
  return <Fresh q={q} dataset="finance.overview">{(d) => (<>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><Stat label="Billed" value={money(d.summary.billed, true)} /><Stat label="Collected" value={money(d.summary.cashCollected, true)} tone="ok" /><Stat label="Outstanding" value={money(d.summary.outstanding, true)} tone="bad" /><Stat label="Collection rate" value={pct(d.summary.collectionRate)} /></div>
    <div className="grid gap-6 lg:grid-cols-2"><Panel title="Collected each month"><Line data={d.monthly.map((m) => ({ label: m.month.slice(2), value: m.collected }))} format={(v) => money(v, true)} /></Panel><Panel title="Who owes, by how long"><Bars data={d.aging.map((a) => ({ label: a.bucket === "current" ? "Not yet due" : `${a.bucket} days`, value: a.amount }))} format={(v) => money(v, true)} tone="bad" /></Panel></div>
    <div className="grid gap-6 lg:grid-cols-2"><Panel title="Collection by class"><Bars data={d.collectionByClass.map((c) => ({ label: c.class, value: c.rate ?? 0 }))} format={(v) => pct(v, 0)} max={100} /></Panel><Panel title="Spending by category"><Bars data={d.expensesByCategory.map((c) => ({ label: c.category, value: c.amount }))} format={(v) => money(v, true)} /></Panel></div>
    <Panel title="Largest balances" padded={false}><DataTable compact rows={d.debtors} rowKey={(x) => x.admissionNumber} columns={[{ key: "n", header: "Student", cell: (x) => <strong>{x.name}</strong> }, { key: "a", header: "Adm. no.", cell: (x) => <span className="num">{x.admissionNumber}</span> }, { key: "d", header: "Oldest due", cell: (x) => x.oldestDue ?? "—" }, { key: "o", header: "Owes", align: "right", cell: (x) => money(x.owed) }]} /></Panel></>)}</Fresh>;
}

function Attendance() {
  const q = useApi<Snap<{ days: number; daily: { date: string; rate: number | null }[]; byWeekday: { day: string; absenceRate: number | null }[]; byClass: { class: string; rate: number | null; lateRate: number | null }[]; chronicAbsentees: { name: string; admissionNumber: string; absences: number }[] }>>("/analytics/attendance.overview");
  return <Fresh q={q} dataset="attendance.overview">{(d) => d.daily.length === 0 ? <Panel><EmptyState title="No attendance recorded" icon="check" /></Panel> : (<>
    <div className="grid gap-6 lg:grid-cols-2"><Panel title={`Daily attendance rate, last ${d.days} days`}><Line data={d.daily.map((x) => ({ label: x.date.slice(5), value: x.rate ?? 0 }))} format={(v) => pct(v, 0)} /></Panel><Panel title="Absence by weekday"><Bars data={d.byWeekday.map((w) => ({ label: w.day, value: w.absenceRate ?? 0 }))} format={(v) => pct(v, 1)} tone="bad" /></Panel></div>
    <div className="grid gap-6 lg:grid-cols-2"><Panel title="Attendance by class"><Bars data={d.byClass.map((c) => ({ label: c.class, value: c.rate ?? 0 }))} format={(v) => pct(v, 1)} max={100} /></Panel><Panel title="Repeated absences" padded={false}>{d.chronicAbsentees.length === 0 ? <p className="p-4 text-ink-500">No student has 3 or more absences.</p> : <DataTable compact rows={d.chronicAbsentees} rowKey={(x) => x.admissionNumber} rule={() => "bad"} columns={[{ key: "n", header: "Student", cell: (x) => x.name }, { key: "a", header: "Absences", align: "right", cell: (x) => x.absences }]} />}</Panel></div></>)}</Fresh>;
}

function Cbt() {
  const q = useApi<Snap<{ weakestTopics: { topic: string; subject: string; accuracy: number; attempted: number }[]; schoolExams: { exam: string; attempts: number; average: number }[]; examPrep: { examBody: string; sessions: number; average: number }[] }>>("/analytics/cbt.overview");
  return <Fresh q={q} dataset="cbt.overview">{(d) => (<div className="grid gap-6 lg:grid-cols-2"><Panel title="Weakest topics across the school" padded={false}>{d.weakestTopics.length === 0 ? <p className="p-4 text-ink-500">Needs more practice data.</p> : <DataTable compact rows={d.weakestTopics} rowKey={(t) => t.topic + t.subject} columns={[{ key: "t", header: "Topic", cell: (t) => `${t.subject} — ${t.topic}` }, { key: "a", header: "Accuracy", align: "right", cell: (t) => pct(t.accuracy, 0) }, { key: "n", header: "Answers", align: "right", cell: (t) => t.attempted }]} />}</Panel>
    <div className="space-y-6"><Panel title="Recent school exams" padded={false}>{d.schoolExams.length === 0 ? <p className="p-4 text-ink-500">No exams yet.</p> : <DataTable compact rows={d.schoolExams} rowKey={(e) => e.exam} columns={[{ key: "e", header: "Exam", cell: (e) => e.exam }, { key: "n", header: "Attempts", align: "right", cell: (e) => e.attempts }, { key: "a", header: "Average", align: "right", cell: (e) => pct(e.average) }]} />}</Panel>
      <Panel title="Exam practice by exam body" padded={false}>{d.examPrep.length === 0 ? <p className="p-4 text-ink-500">No practice sessions yet.</p> : <DataTable compact rows={d.examPrep} rowKey={(e) => e.examBody} columns={[{ key: "e", header: "Exam", cell: (e) => e.examBody }, { key: "n", header: "Sessions", align: "right", cell: (e) => e.sessions }, { key: "a", header: "Average", align: "right", cell: (e) => pct(e.average) }]} />}</Panel></div></div>)}</Fresh>;
}
