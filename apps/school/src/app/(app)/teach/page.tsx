"use client";
import Link from "next/link";
import { useApi } from "@/lib/api";
import { ago } from "@/lib/format";
import { Badge, DataState, EmptyState, PageHeader, Panel } from "@/ui/kit";
import { Icon } from "@/ui/icons";
import { useSession } from "@/ui/session";

interface Overview {
  term: { name: string } | null;
  classSubjects: { id: string; class: string; section: string | null; subject: string; students: number; scoreEntry: { percent: number | null; locked: boolean; published: boolean }; classPerformance: { average: number | null; students: number } | null }[];
  today: { lessons: { id: string; period: number; start: string; end: string; subject: string; class: string; room: string | null }[]; rollCalls: { sectionId: string; classId: string; name: string; students: number; marked: number; taken: boolean }[] };
  exams: { id: string; title: string; closesAt: string | null; sitting: number }[];
}

/** Score-entry progress: a real progressbar (screen readers get the number), plus the word for its state. */
function Progress({ percent, label }: { percent: number; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-3 min-w-24 flex-1 overflow-hidden rounded-full bg-ink-100">
        <div className={`h-full ${percent === 100 ? "bg-leaf-700" : "bg-brand-700"}`} style={{ width: `${percent}%` }} />
      </div>
      <span className="num w-12 text-right font-bold">{percent}%</span>
    </div>
  );
}

export default function TeachHome() {
  const { me } = useSession();
  const q = useApi<Overview>("/teach/overview", { refreshMs: 60_000 });
  return (<>
    <PageHeader title={`Good day, ${me.user.name.split(" ")[0]}`} description={q.data?.term ? `${q.data.term.name} — what needs doing today.` : "Your classes and the things you do most."} />
    <DataState query={q}>{(o) => (
      <div className="space-y-6">
        {(o.today.rollCalls.length > 0 || o.today.lessons.length > 0 || o.exams.length > 0) && (
          <div className="grid gap-6 lg:grid-cols-3">
            {o.today.rollCalls.length > 0 && (
              <Panel title="Roll call today">
                <ul className="space-y-3">{o.today.rollCalls.map((r) => (
                  <li key={r.sectionId} className="flex items-center justify-between gap-3">
                    <span><strong>{r.name}</strong><span className="block text-ink-500">{r.students} students</span></span>
                    {r.taken ? <Badge tone="ok" icon="check">{r.marked} marked</Badge> : <Link className="inline-flex min-h-11 items-center rounded-md bg-brand-700 px-3 font-bold text-white hover:bg-brand-800" href={`/attendance?classId=${r.classId}`}>Take roll call</Link>}
                  </li>))}</ul>
              </Panel>
            )}
            {o.today.lessons.length > 0 && (
              <Panel title="Today's lessons" padded={false}>
                <ol className="divide-y divide-line">{o.today.lessons.map((l) => <li key={l.id} className="flex items-center gap-3 px-4 py-2.5"><span className="num w-24 shrink-0 font-bold text-ink-700">{l.start}–{l.end}</span><span><strong>{l.subject}</strong> · {l.class}{l.room ? ` · ${l.room}` : ""}</span></li>)}</ol>
              </Panel>
            )}
            {o.exams.length > 0 && (
              <Panel title="Exams open now" padded={false}>
                <ul className="divide-y divide-line">{o.exams.map((e) => <li key={e.id} className="px-4 py-3"><Link className="font-bold text-brand-700 underline" href={`/cbt/${e.id}`}>{e.title}</Link><p className="text-ink-500">{e.sitting} sitting now{e.closesAt ? ` · closes ${ago(e.closesAt) === "just now" ? "now" : new Date(e.closesAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}` : ""}</p></li>)}</ul>
              </Panel>
            )}
          </div>
        )}

        <Panel title="My classes and subjects" padded={false}>
          {o.classSubjects.length === 0 ? <EmptyState title="No subjects assigned yet" icon="school">The administrator assigns subjects under Classes &amp; subjects.</EmptyState> : (
            <ul className="divide-y divide-line">
              {o.classSubjects.map((c) => (
                <li key={c.id} className="grid gap-3 px-4 py-4 sm:grid-cols-[1fr_16rem_auto] sm:items-center">
                  <p><strong>{c.class}{c.section ? ` ${c.section}` : ""}</strong> — {c.subject}<span className="block text-ink-500">{c.students} students{c.classPerformance ? ` · class average ${c.classPerformance.average ?? "—"}%` : ""}</span></p>
                  <div>
                    <p className="mb-1 text-sm text-ink-500">{c.scoreEntry.published ? "Results published" : c.scoreEntry.locked ? "Scores locked" : "Scores entered this term"}</p>
                    {c.scoreEntry.percent !== null ? <Progress percent={c.scoreEntry.percent} label={`${c.class} ${c.subject} scores entered`} /> : <span className="text-ink-500">No students yet</span>}
                  </div>
                  <Link className="inline-flex min-h-11 items-center gap-1 font-bold text-brand-700 underline" href="/results/scores">{c.scoreEntry.percent === 100 ? "Review scores" : "Enter scores"}<Icon name="chevronRight" size={16} /></Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Quick actions"><ul className="grid gap-1 sm:grid-cols-2 lg:grid-cols-5">{[["/attendance", "Take attendance"], ["/results/scores", "Enter scores"], ["/lesson-notes", "Lesson notes"], ["/cbt", "CBT exams"], ["/timetable", "Timetable"]].map(([h, l]) => <li key={h}><Link href={h!} className="flex min-h-11 items-center font-bold text-brand-800 hover:underline">{l}</Link></li>)}</ul></Panel>
      </div>
    )}</DataState>
  </>);
}
