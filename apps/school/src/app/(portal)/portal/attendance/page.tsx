"use client";
import { useApi } from "@/lib/api";
import { date, pct } from "@/lib/format";
import { DataState, EmptyState, Panel, StatusBadge } from "@/ui/kit";
import { ChildSelector, useChild } from "@/ui/children";

export default function PortalAttendance() {
  const { child } = useChild();
  const q = useApi<{ rows: { date: string; status: string; checkedInAt: string | null }[]; summary: { present: number; late: number; absent: number; excused: number; total: number; rate: number | null } }>(child ? `/attendance/students/${child.id}` : null);
  if (!child) return null;
  return (
    <div className="space-y-4"><ChildSelector />
      <DataState query={q}>{(d) => (<>
        <div className="grid grid-cols-4 gap-2 text-center">{[["Rate", pct(d.summary.rate, 0)], ["Present", d.summary.present], ["Late", d.summary.late], ["Absent", d.summary.absent]].map(([k, v]) => <div key={k as string} className="rounded-lg border border-line bg-surface p-2"><p className="text-sm text-ink-500">{k}</p><p className="num font-serif text-xl font-semibold">{v}</p></div>)}</div>
        {d.rows.length === 0 ? <Panel><EmptyState title="No attendance recorded yet" icon="check" /></Panel> : <Panel padded={false}><ul className="divide-y divide-line">{d.rows.slice(0, 60).map((r) => <li key={r.date} className="flex items-center justify-between px-4 py-3" style={{ boxShadow: `inset 3px 0 0 ${r.status === "ABSENT" ? "var(--rule-bad)" : r.status === "LATE" ? "var(--rule-warn)" : "var(--rule-ok)"}` }}><span>{date(r.date)}</span><StatusBadge status={r.status} /></li>)}</ul></Panel>}</>
      )}</DataState></div>
  );
}
