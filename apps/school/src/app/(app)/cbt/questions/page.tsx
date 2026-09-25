"use client";
import { useState } from "react";
import Link from "next/link";
import { api, qs, useApi, useMutation } from "@/lib/api";
import { Badge, Button, DataState, Dialog, EmptyState, ErrorNote, Field, PageHeader, Pagination, Panel, SearchBox, Select, SelectField, TextField, Textarea, useToast } from "@/ui/kit";
import { DataTable } from "@/ui/table";

interface Q { id: string; stem: string; difficulty: string; examBody: string; year: number | null; type: string; subject: { name: string }; topic: { name: string } | null; options: { label: string; isCorrect: boolean }[] }
const BODIES = ["INTERNAL", "WAEC", "NECO", "JAMB", "BECE"];

export default function QuestionBank() {
  const [subjectId, setSubjectId] = useState(""); const [examBody, setBody] = useState(""); const [q, setQ] = useState(""); const [page, setPage] = useState(1); const [open, setOpen] = useState(false);
  const subjects = useApi<{ id: string; name: string }[]>("/academics/subjects");
  const list = useApi<{ items: Q[]; total: number; page: number; pageSize: number }>(`/cbt/questions${qs({ subjectId, examBody, q, page })}`);
  return (<>
    <PageHeader title="Question bank" description="One bank serves school tests and WAEC, NECO, JAMB and BECE practice. Questions already answered in an exam are locked — retire and replace instead of editing." actions={<><Link href="/imports?kind=QUESTIONS"><Button variant="secondary" icon="upload">Import from Excel</Button></Link><Button icon="plus" onClick={() => setOpen(true)}>New question</Button></>} />
    <div className="mb-4 flex flex-wrap items-center gap-3"><SearchBox value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Search question text" label="Search questions" /><Select aria-label="Subject" className="w-auto" value={subjectId} onChange={(e) => { setSubjectId(e.target.value); setPage(1); }}><option value="">All subjects</option>{subjects.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select><Select aria-label="Exam" className="w-auto" value={examBody} onChange={(e) => { setBody(e.target.value); setPage(1); }}><option value="">All exams</option>{BODIES.map((b) => <option key={b} value={b}>{b === "INTERNAL" ? "School" : b}</option>)}</Select></div>
    <DataState query={list}>{(d) => d.items.length === 0 ? <Panel><EmptyState title="No questions found" icon="book" /></Panel> : (<><DataTable rows={d.items} rowKey={(x) => x.id} columns={[{ key: "s", header: "Question", cell: (x) => x.stem.slice(0, 150) }, { key: "u", header: "Subject", className: "hidden md:table-cell", cell: (x) => `${x.subject.name}${x.topic ? ` — ${x.topic.name}` : ""}` }, { key: "b", header: "Exam", cell: (x) => <Badge tone={x.examBody === "INTERNAL" ? "neutral" : "brand"}>{x.examBody === "INTERNAL" ? "School" : x.examBody}{x.year ? ` ${x.year}` : ""}</Badge> }, { key: "d", header: "Level", className: "hidden sm:table-cell", cell: (x) => x.difficulty.toLowerCase() }, { key: "k", header: "Key", cell: (x) => x.options.filter((o) => o.isCorrect).map((o) => o.label).join(", ") }]} /><Pagination page={d.page} pageSize={d.pageSize} total={d.total} onPage={setPage} /></>)}</DataState>
    <NewQuestion open={open} onClose={() => setOpen(false)} onDone={() => { setOpen(false); list.reload(); }} />
  </>);
}

function NewQuestion({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const subjects = useApi<{ id: string; name: string }[]>(open ? "/academics/subjects" : null); const toast = useToast();
  const [f, setF] = useState({ subjectId: "", topicId: "", examBody: "INTERNAL", year: "", difficulty: "MEDIUM", stem: "", explanation: "" });
  const topics = useApi<{ id: string; name: string }[]>(open && f.subjectId ? `/cbt/topics?subjectId=${f.subjectId}` : null);
  const [opts, setOpts] = useState([{ text: "", ok: true }, { text: "", ok: false }, { text: "", ok: false }, { text: "", ok: false }]); const [multi, setMulti] = useState(false);
  const save = useMutation(async () => {
    const options = opts.filter((o) => o.text.trim()).map((o, i) => ({ label: "ABCDEF"[i]!, text: o.text, isCorrect: o.ok }));
    await api.post("/cbt/questions", { subjectId: f.subjectId, topicId: f.topicId || null, examBody: f.examBody, year: f.year ? Number(f.year) : null, difficulty: f.difficulty, type: multi ? "MCQ_MULTIPLE" : "MCQ_SINGLE", stem: f.stem, explanation: f.explanation || undefined, options });
    toast.push("ok", "Question added"); setF({ ...f, stem: "", explanation: "" }); setOpts(opts.map((o, i) => ({ text: "", ok: i === 0 }))); onDone();
  });
  return <Dialog open={open} onClose={onClose} wide title="New question" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.pending} disabled={!f.subjectId || f.stem.length < 3 || opts.filter((o) => o.text.trim()).length < 2} onClick={() => void save.run()}>Save question</Button></>}>
    <div className="space-y-4"><div className="grid gap-4 sm:grid-cols-2"><SelectField label="Subject" value={f.subjectId} onChange={(e) => setF({ ...f, subjectId: e.target.value, topicId: "" })}><option value="">Choose…</option>{subjects.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</SelectField><SelectField label="Topic" value={f.topicId} onChange={(e) => setF({ ...f, topicId: e.target.value })}><option value="">None</option>{topics.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</SelectField></div>
      <div className="grid gap-4 sm:grid-cols-3"><SelectField label="Exam" value={f.examBody} onChange={(e) => setF({ ...f, examBody: e.target.value })}>{BODIES.map((b) => <option key={b} value={b}>{b === "INTERNAL" ? "School" : b}</option>)}</SelectField><TextField label="Year (past questions)" type="number" value={f.year} onChange={(e) => setF({ ...f, year: e.target.value })} /><SelectField label="Difficulty" value={f.difficulty} onChange={(e) => setF({ ...f, difficulty: e.target.value })}>{["EASY", "MEDIUM", "HARD"].map((d) => <option key={d} value={d}>{d[0] + d.slice(1).toLowerCase()}</option>)}</SelectField></div>
      <Field label="Question" htmlFor="qs" required><Textarea id="qs" value={f.stem} onChange={(e) => setF({ ...f, stem: e.target.value })} /></Field>
      <fieldset><legend className="mb-2 font-bold">Options — mark the correct {multi ? "answers" : "answer"}</legend><div className="space-y-2">{opts.map((o, i) => <div key={i} className="flex items-center gap-2"><input aria-label={`Option ${"ABCD"[i]} is correct`} type={multi ? "checkbox" : "radio"} name="correct" className="size-5 accent-brand-700" checked={o.ok} onChange={(e) => setOpts(opts.map((x, j) => (multi ? (j === i ? { ...x, ok: e.target.checked } : x) : { ...x, ok: j === i })))} /><strong className="w-6">{"ABCD"[i]}</strong><input aria-label={`Option ${"ABCD"[i]} text`} className="min-h-11 flex-1 rounded-md border border-ink-300 px-3" value={o.text} onChange={(e) => setOpts(opts.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} /></div>)}</div><label className="mt-2 flex min-h-11 items-center gap-2"><input type="checkbox" className="size-5 accent-brand-700" checked={multi} onChange={(e) => { setMulti(e.target.checked); setOpts(opts.map((o, i) => ({ ...o, ok: i === 0 }))); }} />More than one correct answer</label></fieldset>
      <Field label="Explanation (shown to students after practice)" htmlFor="ex"><Textarea id="ex" value={f.explanation} onChange={(e) => setF({ ...f, explanation: e.target.value })} /></Field><ErrorNote error={save.error} /></div>
  </Dialog>;
}
