"use client";
import { useRouter } from "next/navigation";
import { api, useApi, useMutation } from "@/lib/api";
import { dateTime, pct } from "@/lib/format";
import { Badge, Button, DataState, EmptyState, ErrorNote, Panel, StatusBadge } from "@/ui/kit";

interface Avail { id: string; title: string; kind: string; examBody: string; subject: string | null; durationMinutes: number; questions: number; opensAt: string | null; closesAt: string | null; canStartNow: boolean; inProgressAttemptId: string | null; attemptsUsed: number; maxAttempts: number }
interface Hist { id: string; status: string; startedAt: string; exam: { title: string; kind: string }; result: { percentage: number } | null }

export default function StudentHome() {
  const router = useRouter();
  const av = useApi<Avail[]>("/exam/available"); const hist = useApi<Hist[]>("/exam/history");
  const start = useMutation(async (id: string) => {
    const r = await api.post<{ attemptId: string }>(`/exam/${id}/start`, { clientSessionId: crypto.randomUUID() });
    try { await document.documentElement.requestFullscreen?.(); } catch { /* the room offers a button if the browser refuses */ }
    router.push(`/exam/${r.attemptId}`);
  });
  return (
    <div className="space-y-6">
      <div><h1 className="font-serif text-2xl font-semibold">My exams</h1><p className="text-ink-500">Exams open here at the time your teacher sets. Your answers are saved as you go — even if the Wi-Fi drops.</p></div>
      <ErrorNote error={start.error} />
      <DataState query={av}>{(d) => d.length === 0 ? <Panel><EmptyState title="No exams right now" icon="grid">When a teacher schedules one for your class it appears here.</EmptyState></Panel> : (
        <ul className="space-y-3">{d.map((e) => (
          <li key={e.id} className="rounded-(--radius-panel) border border-line bg-surface p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-serif text-lg font-semibold">{e.title}</p><p className="num text-ink-500">{e.questions} questions · {e.durationMinutes} min{e.opensAt ? ` · opens ${dateTime(e.opensAt)}` : ""}</p></div><div className="flex items-center gap-2">{e.kind !== "SCHOOL" && <Badge tone="brand">{e.examBody === "INTERNAL" ? "Practice" : e.examBody}</Badge>}{e.inProgressAttemptId ? <Button onClick={() => router.push(`/exam/${e.inProgressAttemptId}`)}>Continue exam</Button> : <Button loading={start.pending} disabled={!e.canStartNow} onClick={() => void start.run(e.id)}>{e.canStartNow ? "Start exam" : e.attemptsUsed >= e.maxAttempts ? "Completed" : "Not open yet"}</Button>}</div></div></li>
        ))}</ul>
      )}</DataState>
      <Panel title="My results" padded={false}><DataState query={hist}>{(d) => d.length === 0 ? <p className="p-4 text-ink-500">You haven't taken any exams yet.</p> : <ul className="divide-y divide-line">{d.map((h) => <li key={h.id} className="flex items-center justify-between gap-3 px-4 py-3"><div><p className="font-bold">{h.exam.title}</p><p className="text-sm text-ink-500">{dateTime(h.startedAt)}</p></div>{h.status === "IN_PROGRESS" ? <StatusBadge status="IN_PROGRESS" /> : h.result ? <button className="num cursor-pointer text-lg font-bold text-brand-800 underline" onClick={() => router.push(`/student/results/${h.id}`)}>{pct(h.result.percentage, 0)}</button> : <Badge tone="warn">Awaiting results</Badge>}</li>)}</ul>}</DataState></Panel>
    </div>
  );
}
