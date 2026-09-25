"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, useApi, useMutation } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { Button, Checkbox, DataState, Dialog, EmptyState, ErrorNote, PageHeader, Panel, SelectField, StatusBadge, TextField } from "@/ui/kit";
import { Can } from "@/ui/session";
import { DataTable } from "@/ui/table";

interface Exam { id: string; title: string; kind: string; examBody: string; status: string; durationMinutes: number; opensAt: string | null; classIds: string[]; subject: { name: string } | null; _count: { questions: number; attempts: number } }
interface Q { id: string; stem: string; difficulty: string; topic: { name: string } | null }

export default function CbtHome() {
  const router = useRouter();
  const q = useApi<Exam[]>("/cbt/exams?kind=SCHOOL");
  const [open, setOpen] = useState(false);
  return (<>
    <PageHeader title="CBT exams" description="Computer-based tests taken on school devices over the school network. Answers are saved on the student's device as they go, so a Wi-Fi drop never loses an exam." actions={<Can perm={["cbt.create_exam"]}><Button icon="plus" onClick={() => setOpen(true)}>New exam</Button></Can>} />
    <DataState query={q}>{(d) => d.length === 0 ? <Panel><EmptyState title="No exams yet" icon="grid">Build one from the question bank, choose the classes, and open it when ready.</EmptyState></Panel> : <DataTable rows={d} rowKey={(e) => e.id} onRowClick={(e) => router.push(`/cbt/${e.id}`)} rule={(e) => (e.status === "OPEN" ? "ok" : e.status === "CLOSED" ? undefined : "warn")} columns={[{ key: "t", header: "Exam", cell: (e) => <strong>{e.title}</strong> }, { key: "s", header: "Subject", className: "hidden sm:table-cell", cell: (e) => e.subject?.name ?? "—" }, { key: "q", header: "Questions", align: "right", cell: (e) => e._count.questions }, { key: "d", header: "Minutes", align: "right", className: "hidden md:table-cell", cell: (e) => e.durationMinutes }, { key: "a", header: "Attempts", align: "right", cell: (e) => e._count.attempts }, { key: "o", header: "Opens", className: "hidden md:table-cell", cell: (e) => (e.opensAt ? dateTime(e.opensAt) : "Manual") }, { key: "st", header: "Status", cell: (e) => <StatusBadge status={e.status} /> }]} />}</DataState>
    <NewExam open={open} onClose={() => setOpen(false)} onCreated={(id) => router.push(`/cbt/${id}`)} />
  </>);
}

function NewExam({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const subjects = useApi<{ id: string; name: string }[]>(open ? "/academics/subjects" : null); const classes = useApi<{ id: string; name: string }[]>(open ? "/academics/classes" : null);
  const [f, setF] = useState({ title: "", subjectId: "", durationMinutes: 45, passMark: 50, maxAttempts: 1, shuffleQuestions: true, shuffleOptions: false, showResultImmediately: false, opensAt: "", closesAt: "", classIds: [] as string[] });
  const bank = useApi<{ items: Q[] }>(open && f.subjectId ? `/cbt/questions?subjectId=${f.subjectId}&examBody=INTERNAL&pageSize=100` : null);
  const [picked, setPicked] = useState<string[]>([]); const [random, setRandom] = useState(20);
  const pool = bank.data?.items ?? [];
  const create = useMutation(async () => {
    const ids = picked.length ? picked : [...pool].sort(() => Math.random() - 0.5).slice(0, random).map((x) => x.id);
    const e = await api.post<{ id: string }>("/cbt/exams", { title: f.title, kind: "SCHOOL", examBody: "INTERNAL", subjectId: f.subjectId, classIds: f.classIds, durationMinutes: f.durationMinutes, passMark: f.passMark, maxAttempts: f.maxAttempts, shuffleQuestions: f.shuffleQuestions, shuffleOptions: f.shuffleOptions, showResultImmediately: f.showResultImmediately, opensAt: f.opensAt ? new Date(f.opensAt).toISOString() : null, closesAt: f.closesAt ? new Date(f.closesAt).toISOString() : null, sections: [{ title: "Section A", questions: ids.map((questionId) => ({ questionId, marks: 1 })) }] });
    onCreated(e.id);
  });
  return (
    <Dialog open={open} onClose={onClose} wide title="New CBT exam" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={create.pending} disabled={f.title.length < 3 || !f.subjectId || f.classIds.length === 0 || (!picked.length && pool.length === 0)} onClick={() => void create.run()}>Create draft</Button></>}>
      <div className="space-y-4"><TextField label="Title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="JSS 1 Mathematics — CA 1" required />
        <div className="grid gap-4 sm:grid-cols-2"><SelectField label="Subject" value={f.subjectId} onChange={(e) => { setF({ ...f, subjectId: e.target.value }); setPicked([]); }}><option value="">Choose…</option>{subjects.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</SelectField><TextField label="Minutes" type="number" min={1} value={f.durationMinutes} onChange={(e) => setF({ ...f, durationMinutes: Number(e.target.value) })} /></div>
        <fieldset><legend className="mb-2 font-bold">Classes taking this exam</legend><div className="grid gap-2 sm:grid-cols-3">{classes.data?.map((c) => <Checkbox key={c.id} label={c.name} checked={f.classIds.includes(c.id)} onChange={(e) => setF({ ...f, classIds: e.target.checked ? [...f.classIds, c.id] : f.classIds.filter((x) => x !== c.id) })} />)}</div></fieldset>
        <div className="grid gap-4 sm:grid-cols-2"><TextField label="Opens (optional)" type="datetime-local" value={f.opensAt} onChange={(e) => setF({ ...f, opensAt: e.target.value })} /><TextField label="Closes (optional)" type="datetime-local" value={f.closesAt} onChange={(e) => setF({ ...f, closesAt: e.target.value })} /></div>
        <div className="grid gap-2 sm:grid-cols-2"><Checkbox label="Shuffle questions" checked={f.shuffleQuestions} onChange={(e) => setF({ ...f, shuffleQuestions: e.target.checked })} /><Checkbox label="Shuffle options" checked={f.shuffleOptions} onChange={(e) => setF({ ...f, shuffleOptions: e.target.checked })} /><Checkbox label="Show results as soon as they finish" checked={f.showResultImmediately} onChange={(e) => setF({ ...f, showResultImmediately: e.target.checked })} /></div>
        {f.subjectId && <fieldset><legend className="mb-1 font-bold">Questions</legend>{pool.length === 0 ? <p className="text-amber-700">The bank has no school questions for this subject yet. Add some under Question bank.</p> : <><p className="mb-2 text-ink-500">{pool.length} available. Tick specific questions, or leave all unticked and pick {random} at random.</p><TextField label="Random questions" type="number" min={1} max={pool.length} value={random} onChange={(e) => setRandom(Number(e.target.value))} className="mb-2 max-w-40" /><ul className="max-h-48 divide-y divide-line overflow-y-auto rounded border border-line">{pool.map((x) => <li key={x.id} className="px-3 py-1.5"><Checkbox label={x.stem.slice(0, 110)} checked={picked.includes(x.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, x.id] : picked.filter((y) => y !== x.id))} /></li>)}</ul></>}</fieldset>}
        <ErrorNote error={create.error} /></div>
    </Dialog>
  );
}
