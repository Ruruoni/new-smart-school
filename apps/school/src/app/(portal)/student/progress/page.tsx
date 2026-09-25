"use client";
import { useApi } from "@/lib/api";
import { pct } from "@/lib/format";
import { DataState, EmptyState, Panel } from "@/ui/kit";

interface P { recent: { attemptId: string; title: string; examBody: string; percentage: number }[]; byExamBody: Record<string, { attempts: number; average: number }>; weakTopics: { topic: string; subject: string; accuracy: number; attempted: number }[]; strongTopics: { topic: string; subject: string; accuracy: number }[] }

export default function Progress() {
  const q = useApi<P>("/prep/progress");
  return <DataState query={q}>{(d) => (
    <div className="space-y-5"><h1 className="font-serif text-2xl font-semibold">My progress</h1>
      {Object.keys(d.byExamBody).length > 0 && <div className="grid grid-cols-2 gap-2">{Object.entries(d.byExamBody).map(([k, v]) => <div key={k} className="rounded-lg border border-line bg-surface p-3"><p className="text-ink-500">{k === "INTERNAL" ? "School exams" : k}</p><p className="num font-serif text-2xl font-semibold">{pct(v.average, 0)}</p><p className="text-sm text-ink-500">{v.attempts} attempt{v.attempts === 1 ? "" : "s"}</p></div>)}</div>}
      <Panel title="Topics to revise" padded={false}>{d.weakTopics.length === 0 ? <EmptyState title="Keep practising" icon="target">Once you've answered a few questions per topic, your weakest topics show up here.</EmptyState> : <ul className="divide-y divide-line">{d.weakTopics.map((t) => <li key={t.topic} className="px-4 py-3"><div className="flex justify-between"><p className="font-bold">{t.subject} — {t.topic}</p><p className="num font-bold text-pen-700">{pct(t.accuracy, 0)}</p></div><div className="mt-1 h-2 rounded bg-ink-100"><div className="h-2 rounded bg-pen-700" style={{ width: `${t.accuracy}%` }} /></div></li>)}</ul>}</Panel>
      {d.strongTopics.length > 0 && <Panel title="Your strengths"><ul className="space-y-1">{d.strongTopics.map((t) => <li key={t.topic} className="flex justify-between"><span>{t.subject} — {t.topic}</span><strong className="num text-leaf-700">{pct(t.accuracy, 0)}</strong></li>)}</ul></Panel>}
    </div>
  )}</DataState>;
}
