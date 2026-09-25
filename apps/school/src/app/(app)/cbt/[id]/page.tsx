"use client";
import { use, useState } from "react";
import { api, useApi, useMutation } from "@/lib/api";
import { dateTime, pct } from "@/lib/format";
import { Badge, Button, ConfirmDialog, DataState, EmptyState, ErrorNote, PageHeader, Panel, Stat, StatusBadge, TabPanel, Tabs, useToast } from "@/ui/kit";
import { Can } from "@/ui/session";
import { DataTable } from "@/ui/table";

interface Exam { id: string; title: string; status: string; kind: string; durationMinutes: number; passMark: string; opensAt: string | null; closesAt: string | null; showResultImmediately: boolean; questions: { id: string; question: { stem: string; difficulty: string; topic: { name: string } | null } }[] }
interface An { attempts: number; average: number | null; median: number | null; highest: number | null; lowest: number | null; passRate: number | null; avgMinutes: number | null; distribution: { from: number; to: number; count: number }[]; questions: { examQuestionId: string; number: number; stem: string; difficulty: number; discrimination: number | null; flags: string[]; topic: string | null }[] }
interface Res { id: string; attemptId: string; score: string; totalMarks: string; percentage: string; passed: boolean; publishedAt: string | null; attempt: { student: { firstName: string; lastName: string; admissionNumber: string }; status: string } }
type Tab = "questions" | "results" | "analysis";

export default function ExamDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const q = useApi<Exam>(`/cbt/exams/${id}`); const toast = useToast(); const [tab, setTab] = useState<Tab>("questions"); const [dlg, setDlg] = useState<string | null>(null);
  const status = useMutation(async (s: string) => { await api.post(`/cbt/exams/${id}/status`, { status: s }); toast.push("ok", `Exam is now ${s.toLowerCase()}`); setDlg(null); q.reload(); });
  const publish = useMutation(async () => { const r = await api.post<{ published: number }>(`/cbt/exams/${id}/publish`); toast.push("ok", `Published ${r.published} result(s)`); q.reload(); });
  return <DataState query={q}>{(e) => (<>
    <PageHeader title={e.title} description={`${e.questions.length} questions · ${e.durationMinutes} minutes · pass mark ${Number(e.passMark)}%${e.opensAt ? ` · opens ${dateTime(e.opensAt)}` : ""}`} actions={<><StatusBadge status={e.status} />
      <Can perm={["cbt.start_exam"]}>{e.status === "DRAFT" && <><Button variant="secondary" onClick={() => void status.run("SCHEDULED")}>Schedule</Button><Button onClick={() => void status.run("OPEN")}>Open now</Button></>}{e.status === "SCHEDULED" && <Button onClick={() => void status.run("OPEN")}>Open now</Button>}{["OPEN", "SCHEDULED"].includes(e.status) && <Button variant="danger" onClick={() => setDlg("close")}>Close exam</Button>}</Can>
      <Can perm={["cbt.publish_result"]}>{e.status === "CLOSED" && !e.showResultImmediately && <Button loading={publish.pending} onClick={() => void publish.run()}>Publish results</Button>}</Can></>} />
    <ErrorNote error={status.error ?? publish.error} />
    <Tabs label="Exam" value={tab} onChange={setTab} tabs={[{ id: "questions", label: "Questions" }, { id: "results", label: "Results" }, { id: "analysis", label: "Item analysis" }]} />
    <TabPanel id="questions" active={tab === "questions"}><DataTable compact rows={e.questions} rowKey={(x) => x.id} columns={[{ key: "n", header: "#", cell: (_x) => "" , className: "w-0" }, { key: "s", header: "Question", cell: (x) => x.question.stem.slice(0, 140) }, { key: "t", header: "Topic", className: "hidden md:table-cell", cell: (x) => x.question.topic?.name ?? "—" }, { key: "d", header: "Difficulty", cell: (x) => x.question.difficulty.toLowerCase() }]} /></TabPanel>
    <TabPanel id="results" active={tab === "results"}><Results id={id} /></TabPanel><TabPanel id="analysis" active={tab === "analysis"}><Analysis id={id} /></TabPanel>
    <ConfirmDialog open={dlg === "close"} onClose={() => setDlg(null)} title="Close this exam?" danger confirmLabel="Close exam" pending={status.pending} onConfirm={() => void status.run("CLOSED")} body="Anyone still writing is submitted immediately with the answers saved so far. Nobody can start it afterwards." />
  </>)}</DataState>;
}

function Results({ id }: { id: string }) {
  const q = useApi<Res[]>(`/cbt/exams/${id}/results`);
  return <DataState query={q}>{(d) => d.length === 0 ? <Panel><EmptyState title="No submissions yet" icon="grid" /></Panel> : <DataTable rows={d} rowKey={(r) => r.id} rule={(r) => (r.passed ? "ok" : "bad")} columns={[{ key: "n", header: "Student", cell: (r) => <strong>{r.attempt.student.lastName}, {r.attempt.student.firstName}</strong> }, { key: "a", header: "Adm. no.", className: "hidden md:table-cell", cell: (r) => <span className="num">{r.attempt.student.admissionNumber}</span> }, { key: "s", header: "Score", align: "right", cell: (r) => `${Number(r.score)} / ${Number(r.totalMarks)}` }, { key: "p", header: "%", align: "right", cell: (r) => pct(Number(r.percentage)) }, { key: "r", header: "Result", cell: (r) => <Badge tone={r.passed ? "ok" : "bad"}>{r.passed ? "Pass" : "Fail"}</Badge> }, { key: "v", header: "Visible to student", cell: (r) => (r.publishedAt ? "Yes" : "Not yet") }]} />}</DataState>;
}

function Analysis({ id }: { id: string }) {
  const q = useApi<An>(`/cbt/exams/${id}/analytics`);
  return <DataState query={q}>{(a) => a.attempts === 0 ? <Panel><EmptyState title="No attempts to analyse" icon="chart" /></Panel> : (
    <div className="space-y-6"><div className="grid grid-cols-2 gap-3 lg:grid-cols-5"><Stat label="Attempts" value={a.attempts} /><Stat label="Average" value={pct(a.average)} /><Stat label="Highest / lowest" value={`${a.highest ?? "—"} / ${a.lowest ?? "—"}`} /><Stat label="Pass rate" value={pct(a.passRate)} /><Stat label="Avg time" value={a.avgMinutes ? `${a.avgMinutes} min` : "—"} /></div>
      <Panel title="Score distribution"><div className="flex h-40 items-end gap-2" role="img" aria-label="Histogram of scores">{a.distribution.map((b) => { const max = Math.max(1, ...a.distribution.map((x) => x.count)); return <div key={b.from} className="flex flex-1 flex-col items-center gap-1"><span className="num text-sm">{b.count}</span><div className="w-full rounded-t bg-brand-700" style={{ height: `${(b.count / max) * 100}%`, minHeight: b.count ? 4 : 0 }} /><span className="num text-xs text-ink-500">{b.from}</span></div>; })}</div></Panel>
      <Panel title="Question quality" padded={false}><DataTable compact rows={a.questions} rowKey={(x) => x.examQuestionId} rule={(x) => (x.flags.length ? "warn" : undefined)} columns={[{ key: "n", header: "#", cell: (x) => x.number }, { key: "s", header: "Question", cell: (x) => x.stem }, { key: "d", header: "Got it right", align: "right", cell: (x) => pct(x.difficulty * 100, 0) }, { key: "x", header: "Separates strong/weak", align: "right", className: "hidden md:table-cell", cell: (x) => (x.discrimination === null ? "—" : x.discrimination.toFixed(2)) }, { key: "f", header: "Note", cell: (x) => x.flags.map((f) => ({ VERY_HARD: "Very hard — check the key", VERY_EASY: "Very easy", LOW_DISCRIMINATION: "Doesn't separate students" }[f] ?? f)).join("; ") }]} /></Panel></div>
  )}</DataState>;
}
