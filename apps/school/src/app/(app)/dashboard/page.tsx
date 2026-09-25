"use client";
import Link from "next/link";
import { useApi } from "@/lib/api";
import { int, money, pct } from "@/lib/format";
import { Button, DataState, PageHeader, Panel, Stat, Badge } from "@/ui/kit";
import { Can, useSession } from "@/ui/session";
import { Icon } from "@/ui/icons";
import { DataTable } from "@/ui/table";
import { DashboardLive } from "@/ui/dashboard-live";

interface Kpis {
  term: { name: string; year: string } | null;
  enrollment: { total: number; male: number; female: number; byClass: { class: string; count: number }[] };
  staff: { teachers: number; nonTeaching: number };
  admissions: Record<string, number>;
  finance: { billed: string; cashCollected: string; outstanding: string; expenses: string; collectionRate: number | null };
  attendance: { rate: number | null; absent: number; late: number; marks: number } | null;
  academics: { processed: number; published: number; average: number | null } | null;
  cbt: { attempts: number; averagePercentage: number | null };
}
interface Snap<T> { data: T; computedAt: string; stale: boolean }

export default function Dashboard() {
  const { me, can, hasModule } = useSession();
  const q = useApi<Snap<Kpis>>(can("analytics.view") ? "/analytics/management.kpis" : null, { refreshMs: 30_000 });
  const noAnalytics = !can("analytics.view");
  return (
    <>
      <PageHeader title={`Welcome, ${me.user.name.split(" ")[0]}`} description={q.data?.data.term ? `${q.data.data.term.year} · ${q.data.data.term.name}` : "Here's what needs your attention."}
        actions={<Can perm={["analytics.view"]} module="analytics"><Link href="/analytics"><Button variant="secondary" icon="chart">Full analytics</Button></Link></Can>} />
      <div className="mb-6"><DashboardLive /></div>
      {noAnalytics ? <QuickLinks /> : (
        <DataState query={q}>{({ data: k, computedAt }) => (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Active students" value={int(k.enrollment.total)} note={`${k.enrollment.male} boys · ${k.enrollment.female} girls`} />
              {hasModule("attendance") && <Stat label="Attendance this term" value={pct(k.attendance?.rate)} note={k.attendance ? `${int(k.attendance.absent)} absences recorded` : "No records yet"} tone={k.attendance?.rate != null && k.attendance.rate < 85 ? "warn" : undefined} />}
              {hasModule("finance") && can("finance.reports") && <Stat label="Fees outstanding" value={money(k.finance.outstanding, true)} note={k.finance.collectionRate != null ? `${k.finance.collectionRate}% collected` : undefined} tone={Number(k.finance.outstanding) > 0 ? "bad" : "ok"} />}
              {hasModule("results") && <Stat label="Average score" value={pct(k.academics?.average)} note={k.academics ? `${k.academics.published}/${k.academics.processed} report cards published` : "Not processed yet"} />}
            </div>
            <div className="grid gap-6 lg:grid-cols-3">
              <Panel title="Students by class" className="lg:col-span-2" padded={false}>
                <DataTable compact rows={k.enrollment.byClass} rowKey={(r) => r.class} columns={[{ key: "c", header: "Class", cell: (r) => r.class }, { key: "n", header: "Students", align: "right", cell: (r) => int(r.count) }, { key: "b", header: "Share", className: "hidden sm:table-cell", cell: (r) => <div className="h-2 w-full min-w-24 rounded bg-ink-100"><div className="h-2 rounded bg-brand-700" style={{ width: `${k.enrollment.total ? (r.count / k.enrollment.total) * 100 : 0}%` }} /></div> }]} />
              </Panel>
              <div className="space-y-6">
                <Can perm={["admissions.view"]} module="admissions"><Panel title="Admissions pipeline">
                  <ul className="space-y-2">{Object.entries(k.admissions).map(([s, n]) => <li key={s} className="flex items-center justify-between"><span>{s.replace("_", " ").toLowerCase().replace(/^./, (c) => c.toUpperCase())}</span><Badge tone={s === "SUBMITTED" ? "warn" : "neutral"}>{n}</Badge></li>)}{Object.keys(k.admissions).length === 0 && <li className="text-ink-500">No applications yet.</li>}</ul>
                  <Link href="/admissions" className="mt-3 inline-flex items-center gap-1 font-bold text-brand-700 underline">Review applications<Icon name="chevronRight" size={16} /></Link>
                </Panel></Can>
                <Panel title="Staff"><p className="num text-ink-700">{k.staff.teachers} teachers · {k.staff.nonTeaching} non-teaching staff</p>{hasModule("cbt") && <p className="num mt-2 text-ink-700">{k.cbt.attempts} CBT attempts{k.cbt.averagePercentage != null ? ` · ${k.cbt.averagePercentage}% average` : ""}</p>}</Panel>
              </div>
            </div>
            <p className="text-sm text-ink-500">These figures refresh by themselves every 30 seconds. Last calculated {new Date(computedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}.</p>
          </div>
        )}</DataState>
      )}
    </>
  );
}

function QuickLinks() {
  const { can, hasModule } = useSession();
  const links = [
    { href: "/students", label: "Students", perm: ["students.view"], mod: "students" }, { href: "/attendance", label: "Take attendance", perm: ["attendance.record", "attendance.record_any"], mod: "attendance" },
    { href: "/finance", label: "Fees & payments", perm: ["finance.view"], mod: "finance" }, { href: "/admissions", label: "Admissions", perm: ["admissions.view"], mod: "admissions" },
  ].filter((l) => can(...l.perm) && hasModule(l.mod));
  return <div className="grid gap-3 sm:grid-cols-2">{links.map((l) => <Link key={l.href} href={l.href} className="rounded-(--radius-panel) border border-line bg-surface p-5 font-serif text-lg font-semibold hover:border-brand-700">{l.label}</Link>)}{links.length === 0 && <p className="text-ink-500">Nothing has been assigned to you yet. Ask the school administrator for access.</p>}</div>;
}
