"use client";
import { useApi } from "@/lib/api";
import { DataState, EmptyState, Panel } from "@/ui/kit";

interface Mine {
  kind: "student" | "teacher"; title: string; timetable: { name: string; term: string } | null;
  days: { day: number; slots: { id: string; period: number; start: string; end: string; subject: string; teacher: string | null; class: string | null; room: string | null }[] }[];
}
const DAY = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** A phone-friendly, day-by-day timetable ("today" first and marked). `studentId` is only needed by a parent choosing a child. */
export function MyTimetable({ studentId }: { studentId?: string }) {
  const q = useApi<Mine>(`/timetable/mine${studentId ? `?studentId=${studentId}` : ""}`);
  const today = ((new Date().getDay() + 6) % 7) + 1; // Mon=1 … Sun=7
  return (
    <DataState query={q}>{(m) => {
      if (m.days.length === 0) return <Panel><EmptyState title={m.timetable ? "No lessons on the timetable" : "The timetable hasn't been published yet"} icon="calendar">{m.timetable ? "Nothing is scheduled for you in this term's timetable." : "It will appear here as soon as the school activates this term's timetable."}</EmptyState></Panel>;
      const ordered = [...m.days].sort((a, b) => ((a.day - today + 7) % 7) - ((b.day - today + 7) % 7));
      return (
        <div className="space-y-4">
          <p className="text-ink-500">{m.title} · {m.timetable!.term}</p>
          {ordered.map((d) => (
            <Panel key={d.day} title={d.day === today ? `${DAY[d.day]} (today)` : DAY[d.day]} padded={false} className={d.day === today ? "border-2 border-brand-700" : ""}>
              <ol className="divide-y divide-line">
                {d.slots.map((s) => (
                  <li key={s.id} className="flex items-center gap-4 px-4 py-3">
                    <span className="num w-24 shrink-0 font-bold text-ink-700">{s.start}–{s.end}</span>
                    <span className="min-w-0"><span className="block font-bold">{s.subject}</span><span className="block text-ink-500">{[s.class, s.teacher, s.room].filter(Boolean).join(" · ")}</span></span>
                  </li>
                ))}
              </ol>
            </Panel>
          ))}
        </div>
      );
    }}</DataState>
  );
}
