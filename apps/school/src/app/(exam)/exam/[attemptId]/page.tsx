"use client";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, api } from "@/lib/api";
import * as store from "@/lib/exam-store";
import { clockOffset, formatClock, mergeAnswers, progress, questionState, QSTATE_LABEL, remainingSeconds, syncDelayMs, timeWarning, toggleOption, type LocalAnswer } from "@/lib/exam-logic";
import { Button, Dialog } from "@/ui/kit";
import { Icon } from "@/ui/icons";

interface Paper {
  attempt: { id: string; status: string; startedAt: string; deadlineAt: string; serverNow: string };
  exam: { id: string; title: string; kind: string; durationMinutes: number; instantFeedback: boolean; requireFullscreen: boolean; autosaveSeconds: number };
  sections: { id: string; title: string; instructions: string | null }[];
  questions: { examQuestionId: string; number: number; sectionId: string | null; type: string; stem: string; marks: number; options: { id: string; label: string; text: string }[]; revealed: boolean }[];
  answers: Record<string, { selectedOptionIds: string[]; flagged: boolean; visited: boolean; clientSeq: number }>;
}
type Net = "online" | "offline";
type Finished = { resultAvailable: boolean; score?: number; totalMarks?: number; percentage?: number; passed?: boolean; message?: string };

export default function ExamRoom({ params }: { params: Promise<{ attemptId: string }> }) {
  const { attemptId } = use(params);
  const router = useRouter();
  const [paper, setPaper] = useState<Paper | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, LocalAnswer>>({});
  const [idx, setIdx] = useState(0);
  const [net, setNet] = useState<Net>("online");
  const [pending, setPending] = useState(0);
  const [offset, setOffset] = useState(0);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [finished, setFinished] = useState<Finished | null>(null);
  const [fsLost, setFsLost] = useState(false);
  const [reveal, setReveal] = useState<Record<string, { correct: string[]; explanation: string | null }>>({});
  const seq = useRef<Record<string, number>>({});
  const failures = useRef(0);
  const syncing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishedRef = useRef(false);

  // ── Load: server first, IndexedDB as the fallback; then merge server answers with anything only this device has ──
  useEffect(() => {
    let live = true;
    (async () => {
      let p: Paper | null = null;
      try { p = await api.get<Paper>(`/exam/attempts/${attemptId}/paper`); await store.savePaper(attemptId, p); setOffset(clockOffset(Date.parse(p.attempt.serverNow), Date.now())); }
      catch (e) {
        if (e instanceof ApiError && e.status !== 0 && e.status !== 401) { if (live) setLoadErr(e.message); return; }
        p = await store.loadPaper<Paper>(attemptId); if (p) setNet("offline");
        if (!p && live) { setLoadErr("This exam can't be opened while the school server is unreachable. Reconnect to the Wi-Fi and try again."); return; }
      }
      if (!live || !p) return;
      if (p.attempt.status !== "IN_PROGRESS") { finishedRef.current = true; try { setFinished(await api.get<Finished>(`/exam/attempts/${attemptId}/result`)); } catch { setFinished({ resultAvailable: false, message: "Your exam has been submitted." }); } return; }
      const merged = mergeAnswers(p.answers, await store.loadAnswers(attemptId));
      for (const [id, a] of Object.entries(merged)) seq.current[id] = a.clientSeq;
      setPaper(p); setAnswers(merged); setPending(Object.values(merged).filter((a) => a.dirty).length);
      const first = p.questions.findIndex((q) => !merged[q.examQuestionId]?.selectedOptionIds.length);
      setIdx(Math.max(0, first));
    })();
    return () => { live = false; };
  }, [attemptId]);

  const deadlineMs = paper ? Date.parse(paper.attempt.deadlineAt) : 0;
  const total = paper ? Math.max(0, Math.round((deadlineMs - Date.parse(paper.attempt.startedAt)) / 1000)) : 0;

  // ── Sync: flush dirty answers; never blocks the student, retries with back-off, tolerates any outage ──
  const flush = useCallback(async () => {
    if (syncing.current || !paper || finishedRef.current) return;
    const dirty = await store.dirtyAnswers(attemptId);
    if (!dirty.length) { setPending(0); return; }
    syncing.current = true;
    const sent: Record<string, number> = {};
    for (const d of dirty) sent[d.examQuestionId] = d.clientSeq;
    try {
      const r = await api.post<{ status: string; serverNow: string }>(`/exam/attempts/${attemptId}/save`, { answers: dirty.map((d) => ({ examQuestionId: d.examQuestionId, selectedOptionIds: d.selectedOptionIds, flagged: d.flagged, visited: d.visited, clientSeq: d.clientSeq, answeredAt: d.answeredAt ?? undefined })) });
      await store.markSynced(attemptId, sent);
      failures.current = 0; setNet("online"); setOffset(clockOffset(Date.parse(r.serverNow), Date.now()));
      setPending((await store.dirtyAnswers(attemptId)).length);
      if (r.status !== "IN_PROGRESS") { finishedRef.current = true; setFinished(await api.get<Finished>(`/exam/attempts/${attemptId}/result`).catch((): Finished => ({ resultAvailable: false, message: "Your exam was submitted." }))); await store.clearAttempt(attemptId); }
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) { failures.current += 1; setNet("offline"); }
      else if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 401) { failures.current = 0; } // rejected by the server: not a network problem
      else failures.current += 1;
    } finally { syncing.current = false; }
  }, [attemptId, paper]);

  const scheduleFlush = useCallback((delay = 1200) => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => void flush(), delay); }, [flush]);
  // periodic + retry loop (also retries after failures)
  useEffect(() => {
    if (!paper) return;
    const t = setInterval(() => { if (pending > 0 || failures.current > 0) void flush(); }, Math.max(2000, syncDelayMs(failures.current) || paper.exam.autosaveSeconds * 1000));
    const online = () => void flush();
    window.addEventListener("online", online);
    return () => { clearInterval(t); window.removeEventListener("online", online); };
  }, [paper, pending, flush]);

  // ── Answer changes: persist to the device FIRST, then sync ──
  const update = useCallback(async (qid: string, patch: Partial<Pick<LocalAnswer, "selectedOptionIds" | "flagged" | "visited">>) => {
    const cur = answers[qid] ?? { examQuestionId: qid, selectedOptionIds: [], flagged: false, visited: false, clientSeq: 0, answeredAt: null, dirty: false };
    const next: LocalAnswer = { ...cur, ...patch, clientSeq: (seq.current[qid] ?? cur.clientSeq) + 1, answeredAt: new Date(Date.now() + offset).toISOString(), dirty: true };
    seq.current[qid] = next.clientSeq;
    setAnswers((a) => ({ ...a, [qid]: next }));
    await store.putAnswer(attemptId, next);
    setPending((await store.dirtyAnswers(attemptId)).length);
    scheduleFlush();
  }, [answers, attemptId, offset, scheduleFlush]);

  const q = paper?.questions[idx];
  // mark visited on navigation
  useEffect(() => { if (q && !answers[q.examQuestionId]?.visited) void update(q.examQuestionId, { visited: true }); }, [q?.examQuestionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Submit ──
  const submit = useCallback(async () => {
    if (submitting || finishedRef.current) return;
    setSubmitting(true); setConfirm(false);
    if (timer.current) clearTimeout(timer.current);
    await flush();
    try {
      const r = await api.post<Finished>(`/exam/attempts/${attemptId}/submit`);
      finishedRef.current = true; setFinished(r); await store.clearAttempt(attemptId);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    } catch (e) {
      setSubmitting(false);
      if (e instanceof ApiError && e.status === 0) setNet("offline");
    }
  }, [attemptId, flush, submitting]);

  // ── Timer (server clock) + auto-submit at zero ──
  useEffect(() => {
    if (!paper) return;
    const tick = () => setRemaining(remainingSeconds(deadlineMs, Date.now(), offset));
    tick(); const t = setInterval(tick, 500);
    return () => clearInterval(t);
  }, [paper, deadlineMs, offset]);
  useEffect(() => { if (remaining === 0 && paper && !finishedRef.current) void submit(); }, [remaining, paper, submit]);
  // if the submit could not reach the server, keep trying until it does (answers are safe on this device)
  useEffect(() => { if (remaining === 0 && !finished && !submitting && paper) { const t = setInterval(() => void submit(), 5000); return () => clearInterval(t); } }, [remaining, finished, submitting, paper, submit]);

  // ── Full-screen guard & tab warning ──
  useEffect(() => {
    if (!paper?.exam.requireFullscreen) return;
    const h = () => setFsLost(!document.fullscreenElement && !finishedRef.current);
    document.addEventListener("fullscreenchange", h); return () => document.removeEventListener("fullscreenchange", h);
  }, [paper]);
  useEffect(() => { const h = (e: BeforeUnloadEvent) => { if (!finishedRef.current) { e.preventDefault(); e.returnValue = ""; } }; window.addEventListener("beforeunload", h); return () => window.removeEventListener("beforeunload", h); }, []);
  const enterFs = () => void document.documentElement.requestFullscreen?.().then(() => setFsLost(false)).catch(() => setFsLost(false));

  // ── Keyboard: ←/→ move, A–E choose, F flag ──
  useEffect(() => {
    if (!q || finished) return;
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "TEXTAREA" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "ArrowRight") setIdx((i) => Math.min(paper!.questions.length - 1, i + 1));
      else if (e.key === "ArrowLeft") setIdx((i) => Math.max(0, i - 1));
      else if (e.key.toLowerCase() === "f") void update(q.examQuestionId, { flagged: !answers[q.examQuestionId]?.flagged });
      else { const opt = q.options.find((o) => o.label.toLowerCase() === e.key.toLowerCase()); if (opt && !q.revealed) void update(q.examQuestionId, { selectedOptionIds: toggleOption(answers[q.examQuestionId]?.selectedOptionIds ?? [], opt.id, q.type === "MCQ_MULTIPLE") }); }
    };
    window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h);
  }, [q, answers, paper, update, finished]);

  const states = useMemo(() => (paper ? paper.questions.map((x) => questionState(answers[x.examQuestionId])) : []), [paper, answers]);
  const prog = progress(states);
  const warn = remaining === null ? null : timeWarning(remaining, total);

  const check = async () => { if (!q) return; await flush(); const r = await api.post<{ correctOptionIds: string[]; explanation: string | null }>(`/exam/attempts/${attemptId}/reveal`, { examQuestionId: q.examQuestionId }); setReveal((x) => ({ ...x, [q.examQuestionId]: { correct: r.correctOptionIds, explanation: r.explanation } })); };

  if (loadErr) return <Screen><h1 className="font-serif text-2xl font-semibold">We couldn't open your exam</h1><p className="mt-2 text-ink-700">{loadErr}</p><Button className="mt-4" onClick={() => location.reload()}>Try again</Button></Screen>;
  if (finished) return <Screen>
    <h1 className="font-serif text-3xl font-semibold">{finished.resultAvailable ? "Exam submitted" : "Your answers are in"}</h1>
    {finished.resultAvailable ? <div className="mt-4 space-y-2"><p className="num font-serif text-5xl font-semibold">{finished.percentage}%</p><p className="num text-lg">{finished.score} out of {finished.totalMarks} marks · {finished.passed ? "Pass" : "Below the pass mark"}</p></div> : <p className="mt-3 max-w-[50ch] text-lg text-ink-700">{finished.message ?? "Your teacher will publish the results."}</p>}
    <div className="mt-6 flex flex-wrap gap-2"><Button onClick={() => router.replace("/student")}>Back to my exams</Button>{finished.resultAvailable && paper?.exam.kind !== "SCHOOL" && <Button variant="secondary" onClick={() => router.replace(`/student/results/${attemptId}`)}>Review answers</Button>}</div>
  </Screen>;
  if (!paper || !q) return <Screen><p className="text-ink-500" aria-busy="true">Opening your exam…</p></Screen>;

  const a = answers[q.examQuestionId];
  const sec = paper.sections.find((s) => s.id === q.sectionId);
  const rv = reveal[q.examQuestionId];
  const showSecHeader = sec && (idx === 0 || paper.questions[idx - 1]?.sectionId !== q.sectionId);

  return (
    <div className="min-h-dvh bg-paper">
      <header className="on-dark sticky top-0 z-30 flex flex-wrap items-center gap-3 bg-ink-900 px-4 py-2.5 text-white">
        <div className="min-w-0 flex-1"><p className="truncate font-serif text-lg font-semibold">{paper.exam.title}</p><p className="num text-sm text-ink-300">Question {q.number} of {paper.questions.length} · {prog.answered} answered</p></div>
        <span role="status" aria-live="polite" className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-bold ${net === "offline" ? "bg-amber-100 text-amber-700" : pending > 0 ? "bg-ink-700 text-ink-100" : "bg-leaf-100 text-leaf-700"}`}><Icon name={net === "offline" ? "cloudOff" : pending > 0 ? "refresh" : "check"} size={16} />{net === "offline" ? "Offline — answers safe on this device" : pending > 0 ? "Saving…" : "Saved"}</span>
        <div aria-label="Time remaining" role="timer" className={`num rounded-md px-4 py-1.5 font-serif text-2xl font-semibold ${warn ? "animate-pulse bg-pen-700 text-white" : "bg-ink-800 text-white"}`}>{remaining === null ? "--:--" : formatClock(remaining)}</div>
      </header>
      {warn && warn !== "expired" && <p role="alert" className="bg-amber-100 px-4 py-2 text-center font-bold text-amber-700">{warn === "1min" ? "One minute left — your exam will submit automatically." : warn === "5min" ? "5 minutes left." : "10 minutes left."}</p>}
      {remaining === 0 && <p role="alert" className="bg-pen-100 px-4 py-2 text-center font-bold text-pen-700">Time is up. {net === "offline" ? "Your answers will be sent as soon as the connection returns — stay on this page." : "Submitting your answers…"}</p>}

      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-6 lg:grid-cols-[1fr_18rem]">
        <main className="min-w-0">
          {showSecHeader && <div className="mb-4 rounded-lg border-l-4 border-brand-700 bg-brand-50 p-4"><p className="font-serif text-xl font-semibold">{sec!.title}</p>{sec!.instructions && <p className="mt-1 text-ink-700">{sec!.instructions}</p>}</div>}
          <article className="rounded-(--radius-panel) border border-line bg-surface p-5 sm:p-7" aria-labelledby="q-stem">
            <div className="mb-3 flex items-center justify-between gap-3"><p className="num font-bold text-ink-500">Question {q.number} <span className="font-normal">· {q.marks} mark{q.marks === 1 ? "" : "s"}</span></p>
              <button onClick={() => void update(q.examQuestionId, { flagged: !a?.flagged })} aria-pressed={!!a?.flagged} className={`inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-md border-2 px-3 font-bold ${a?.flagged ? "border-[#f5b301] bg-[#f5b301] text-[#2b1d00]" : "border-ink-300 bg-surface text-ink-700 hover:bg-ink-100"}`}><Icon name="flag" size={18} />{a?.flagged ? "Flagged" : "Flag for review"}</button></div>
            <p id="q-stem" className="text-xl leading-relaxed whitespace-pre-line">{q.stem}</p>
            {q.type === "MCQ_MULTIPLE" && <p className="mt-2 font-bold text-ink-500">Choose all that apply.</p>}
            <ul className="mt-5 space-y-3" role={q.type === "MCQ_MULTIPLE" ? "group" : "radiogroup"} aria-labelledby="q-stem">
              {q.options.map((o) => {
                const on = a?.selectedOptionIds.includes(o.id);
                const isCorrect = rv?.correct.includes(o.id);
                return (
                  <li key={o.id}><button role={q.type === "MCQ_MULTIPLE" ? "checkbox" : "radio"} aria-checked={!!on} disabled={q.revealed || !!rv} onClick={() => void update(q.examQuestionId, { selectedOptionIds: toggleOption(a?.selectedOptionIds ?? [], o.id, q.type === "MCQ_MULTIPLE") })}
                    className={`flex min-h-14 w-full cursor-pointer items-start gap-4 rounded-lg border-2 px-4 py-3 text-left text-lg transition-colors ${rv ? (isCorrect ? "border-leaf-700 bg-leaf-100" : on ? "border-pen-700 bg-pen-100" : "border-line bg-surface") : on ? "border-brand-700 bg-brand-50" : "border-line bg-surface hover:border-ink-400"}`}>
                    <span className={`num flex size-8 shrink-0 items-center justify-center rounded-full border-2 font-bold ${on ? "border-brand-700 bg-brand-700 text-white" : "border-ink-300"}`}>{o.label}</span><span className="pt-0.5">{o.text}</span></button></li>
                );
              })}
            </ul>
            {paper.exam.instantFeedback && (rv ? <div className="mt-4 rounded-lg bg-paper p-4"><p className="font-bold">{rv.correct.length && a?.selectedOptionIds.length && rv.correct.every((c) => a.selectedOptionIds.includes(c)) && a.selectedOptionIds.length === rv.correct.length ? "Correct" : "Not quite"}</p>{rv.explanation && <p className="mt-1 text-ink-700">{rv.explanation}</p>}</div> : <Button variant="secondary" className="mt-4" disabled={!a?.selectedOptionIds.length} onClick={() => void check()}>Check my answer</Button>)}
          </article>
          <nav aria-label="Question navigation" className="mt-4 flex items-center justify-between gap-2"><Button variant="secondary" icon="chevronLeft" disabled={idx === 0} onClick={() => setIdx(idx - 1)}>Previous</Button>{idx < paper.questions.length - 1 ? <Button onClick={() => setIdx(idx + 1)}>Next<Icon name="chevronRight" size={18} /></Button> : <Button onClick={() => setConfirm(true)}>Finish exam</Button>}</nav>
        </main>
        <aside aria-label="Question map" className="lg:sticky lg:top-24 lg:self-start">
          <div className="rounded-(--radius-panel) border border-line bg-surface p-4">
            <p className="mb-3 font-serif text-lg font-semibold">Question map</p>
            <div className="qmap flex flex-wrap gap-2">{paper.questions.map((x, i) => <button key={x.examQuestionId} data-s={states[i]} aria-current={i === idx} aria-label={`Question ${x.number}, ${QSTATE_LABEL[states[i]!]}`} onClick={() => setIdx(i)}>{x.number}</button>)}</div>
            <ul className="mt-4 space-y-1.5 text-sm text-ink-700"><li className="flex items-center gap-2"><span className="size-4 rounded bg-leaf-700" />Answered</li><li className="flex items-center gap-2"><span className="size-4 rounded bg-[#f5b301]" />Flagged for review (a green base means it is also answered)</li><li className="flex items-center gap-2"><span className="size-4 rounded border-2 border-ink-300 bg-white" />Seen, not answered</li><li className="flex items-center gap-2"><span className="size-4 rounded bg-ink-100" />Not visited</li></ul>
            <Button className="mt-4 w-full" variant="secondary" onClick={() => setConfirm(true)}>Finish exam</Button>
          </div>
        </aside>
      </div>

      <Dialog open={confirm} onClose={() => setConfirm(false)} title="Finish and submit?" footer={<><Button variant="secondary" onClick={() => setConfirm(false)}>Keep working</Button><Button loading={submitting} onClick={() => void submit()}>Submit exam</Button></>}>
        <p className="num text-lg">You have answered <strong>{prog.answered}</strong> of <strong>{prog.total}</strong> questions.</p>
        {prog.unanswered > 0 && <p className="mt-2 font-bold text-amber-700">{prog.unanswered} question{prog.unanswered === 1 ? " is" : "s are"} still blank.</p>}{prog.flagged > 0 && <p className="mt-1 font-bold text-amber-700">{prog.flagged} flagged for review.</p>}
        <p className="mt-3 text-ink-700">You can't change your answers after submitting.{net === "offline" ? " You're offline: your answers are safe on this device and will be sent when the connection returns." : ""}</p>
      </Dialog>
      {fsLost && !finished && <div role="alertdialog" aria-modal="true" aria-label="Return to full screen" className="fixed inset-0 z-[90] grid place-items-center bg-ink-950/90 p-6 text-center text-white"><div className="max-w-md"><h2 className="font-serif text-3xl font-semibold">Return to full screen</h2><p className="mt-3 text-lg text-ink-200">This exam runs in full screen. The clock keeps running.</p><Button className="mt-6" onClick={enterFs}>Continue exam</Button></div></div>}
    </div>
  );
}

function Screen({ children }: { children: React.ReactNode }) { return <main className="mx-auto grid min-h-dvh max-w-xl content-center px-6 py-10">{children}</main>; }
