"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api, useApi, useMutation } from "@/lib/api";
import { Button, Checkbox, ErrorNote, Panel, SelectField, Skeleton } from "@/ui/kit";

interface Cfg { presets: { body: string; label: string; questionsPerSubject: number; minutesPerMock: number; subjectsPerMock: number }[]; bank: { subjectId: string; subject: string; examBody: string; count: number }[]; subjects: { id: string; name: string }[] }

export default function Practice() {
  const router = useRouter();
  const cfg = useApi<Cfg>("/prep/config");
  const [body, setBody] = useState("JAMB"); const [mode, setMode] = useState<"PRACTICE" | "MOCK">("PRACTICE"); const [subs, setSubs] = useState<string[]>([]); const [n, setN] = useState(20);
  const [timed, setTimed] = useState(true); const [weak, setWeak] = useState(false); const [feedback, setFeedback] = useState(true);
  const available = useMemo(() => { const m = new Map<string, number>(); for (const b of cfg.data?.bank ?? []) if (b.examBody === body) m.set(b.subjectId, (m.get(b.subjectId) ?? 0) + b.count); return m; }, [cfg.data, body]);
  const options = cfg.data?.subjects.filter((s) => available.has(s.id)) ?? [];
  const go = useMutation(async () => { const r = await api.post<{ examId: string }>("/prep/generate", { examBody: body, mode, subjectIds: subs, questionCount: mode === "MOCK" ? undefined : n, timed, focusWeakTopics: weak, instantFeedback: feedback }); const s = await api.post<{ attemptId: string }>(`/exam/${r.examId}/start`, {}); router.push(`/exam/${s.attemptId}`); });
  if (!cfg.data) return <div className="space-y-3"><Skeleton className="h-10 w-full" /><Skeleton className="h-40 w-full" /></div>;
  const preset = cfg.data.presets.find((p) => p.body === body);
  return (
    <div className="space-y-5"><div><h1 className="font-serif text-2xl font-semibold">Exam practice</h1><p className="text-ink-500">Practise past-question style papers for WAEC, NECO, JAMB and BECE — the same way the real exam works.</p></div>
      <Panel><div className="space-y-4">
        <div role="radiogroup" aria-label="Exam" className="flex flex-wrap gap-2">{cfg.data.presets.map((p) => <button key={p.body} role="radio" aria-checked={body === p.body} onClick={() => { setBody(p.body); setSubs([]); }} className={`min-h-11 cursor-pointer rounded-full border-2 px-4 font-bold ${body === p.body ? "border-brand-700 bg-brand-700 text-white" : "border-ink-300 bg-surface"}`}>{p.body}</button>)}</div>
        <SelectField label="Type" value={mode} onChange={(e) => setMode(e.target.value as never)}><option value="PRACTICE">Practice — see the answer after each question</option><option value="MOCK">Mock exam — timed, like the real thing</option></SelectField>
        <fieldset><legend className="mb-2 font-bold">Subjects {mode === "MOCK" && preset && preset.subjectsPerMock > 1 ? `(choose up to ${preset.subjectsPerMock})` : ""}</legend>
          {options.length === 0 ? <p className="text-ink-500">No {body} questions have been added yet. Ask your teacher.</p> : <div className="grid gap-2 sm:grid-cols-2">{options.map((s) => <Checkbox key={s.id} label={`${s.name} — ${available.get(s.id)} questions`} checked={subs.includes(s.id)} onChange={(e) => setSubs(e.target.checked ? [...subs, s.id].slice(0, mode === "MOCK" ? preset?.subjectsPerMock ?? 1 : 6) : subs.filter((x) => x !== s.id))} />)}</div>}</fieldset>
        {mode === "PRACTICE" && <><SelectField label="Number of questions" value={n} onChange={(e) => setN(Number(e.target.value))}>{[10, 20, 30, 40, 60].map((x) => <option key={x}>{x}</option>)}</SelectField><Checkbox label="Focus on my weakest topics" hint="Uses your practice history" checked={weak} onChange={(e) => setWeak(e.target.checked)} /><Checkbox label="Show the answer after each question" checked={feedback} onChange={(e) => setFeedback(e.target.checked)} /></>}
        <Checkbox label="Timed" hint={mode === "MOCK" && preset ? `Mock: about ${preset.minutesPerMock} minutes` : undefined} checked={timed || mode === "MOCK"} disabled={mode === "MOCK"} onChange={(e) => setTimed(e.target.checked)} />
        <ErrorNote error={go.error} /><Button loading={go.pending} disabled={subs.length === 0} onClick={() => void go.run()}>Start</Button></div></Panel></div>
  );
}
