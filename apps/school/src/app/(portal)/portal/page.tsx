"use client";
import Link from "next/link";
import { useApi } from "@/lib/api";
import { date, money, pct } from "@/lib/format";
import { DataState, EmptyState, Panel } from "@/ui/kit";
import { ChildSelector, useChild } from "@/ui/children";
import { Icon } from "@/ui/icons";

export default function PortalHome() {
  const { child } = useChild();
  const ann = useApi<{ id: string; title: string; body: string; publishedAt: string | null }[]>("/announcements");
  if (!child) return <Panel><EmptyState title="No children linked yet" icon="users">Ask the school office to link your child to your account.</EmptyState></Panel>;
  return (
    <div className="space-y-5">
      <ChildSelector />
      <div><h1 className="font-serif text-2xl font-semibold">{child.firstName} {child.lastName}</h1><p className="text-ink-500">{child.class ?? "Not enrolled"} · {child.admissionNumber}</p></div>
      <FeeCard id={child.id} allowed={child.canViewFinance} />
      <AttendanceCard id={child.id} />
      <Link href="/portal/results" className="flex min-h-14 items-center justify-between rounded-(--radius-panel) border border-line bg-surface p-4 font-serif text-lg font-semibold hover:border-brand-700"><span className="flex items-center gap-3"><Icon name="target" />Latest results</span><Icon name="chevronRight" /></Link>
      <Panel title="From the school"><DataState query={ann}>{(d) => d.length === 0 ? <p className="text-ink-500">No announcements.</p> : <ul className="space-y-3">{d.slice(0, 3).map((a) => <li key={a.id}><p className="font-bold">{a.title}</p><p className="text-ink-700 line-clamp-3">{a.body}</p><p className="text-sm text-ink-500">{date(a.publishedAt)}</p></li>)}</ul>}</DataState></Panel>
    </div>
  );
}

function FeeCard({ id, allowed }: { id: string; allowed: boolean }) {
  const q = useApi<{ outstanding: string; credit: string }>(allowed ? `/finance/students/${id}/statement` : null);
  const lock = useApi<{ locked: boolean; outstanding: string; message: string | null }>(allowed ? `/finance/students/${id}/lockout` : null);
  if (!allowed || !q.data) return null;
  const owes = Number(q.data.outstanding) > 0;
  return (
    <Link href="/portal/fees" className={`block rounded-(--radius-panel) border-2 p-4 ${owes ? "border-pen-700 bg-pen-100" : "border-leaf-700 bg-leaf-100"}`}>
      <p className="text-ink-700">School fees</p><p className="num font-serif text-3xl font-semibold">{owes ? money(q.data.outstanding) : "Fully paid"}</p>
      {owes && <p className="mt-1 font-bold text-pen-700">{lock.data?.locked ? "Results are on hold until fees are settled." : "Outstanding balance"}</p>}
    </Link>
  );
}

function AttendanceCard({ id }: { id: string }) {
  const q = useApi<{ summary: { rate: number | null; absent: number; late: number; total: number } }>(`/attendance/students/${id}`);
  if (!q.data) return null;
  const s = q.data.summary;
  return <Link href="/portal/attendance" className="block rounded-(--radius-panel) border border-line bg-surface p-4"><p className="text-ink-500">Attendance</p><p className="num font-serif text-3xl font-semibold">{pct(s.rate)}</p><p className="text-ink-700">{s.total ? `${s.absent} absent · ${s.late} late in ${s.total} days` : "No attendance recorded yet"}</p></Link>;
}
