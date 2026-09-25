"use client";
import { useState } from "react";
import { ApiError, useApi } from "@/lib/api";
import { money, ordinal, pct } from "@/lib/format";
import { DataState, EmptyState, ErrorNote, Panel, Select } from "@/ui/kit";
import { ChildSelector, useChild } from "@/ui/children";
import { Icon } from "@/ui/icons";

interface Terms { termId: string; average: string; position: number | null; classSize: number | null; term: { name: string; academicYear: { name: string } } }
interface Card { class: string; card: { average: number; totalScore: number; position: number | null; classSize: number | null; cumulativeAverage: number | null; teacherRemark: string | null; principalRemark: string | null; term: { name: string } }; subjects: { subject: string; caTotal: number; exam: number; total: number; grade: string; remark: string | null; position: number | null }[] }

export default function PortalResults() {
  const { child } = useChild();
  const [termId, setTermId] = useState("");
  const terms = useApi<Terms[]>(child?.canViewResults ? `/results/students/${child.id}/terms` : null);
  const tid = termId || terms.data?.[0]?.termId || "";
  const card = useApi<Card>(child && tid ? `/results/students/${child.id}/report-card?termId=${tid}` : null);
  if (!child) return null;
  if (!child.canViewResults) return <Panel><EmptyState title="Results aren't shared with you" icon="lock">The school has set this account not to view results.</EmptyState></Panel>;
  const locked = card.error instanceof ApiError && card.error.code === "FINANCIAL_LOCKOUT";
  return (
    <div className="space-y-4">
      <ChildSelector />
      <DataState query={terms}>{(t) => t.length === 0 ? <Panel><EmptyState title="No results published yet" icon="target">You'll get a notification when the school publishes them.</EmptyState></Panel> : (
        <><Select aria-label="Term" value={tid} onChange={(e) => setTermId(e.target.value)}>{t.map((x) => <option key={x.termId} value={x.termId}>{x.term.academicYear.name} · {x.term.name}</option>)}</Select>
          {locked ? <LockedNotice details={(card.error as ApiError).details as { outstanding: string; message: string | null; invoices: { number: string; balance: string }[] }} /> : card.error ? <ErrorNote error={card.error} onRetry={card.reload} /> : card.data && <CardView c={card.data} childId={child.id} termId={tid} />}</>
      )}</DataState>
    </div>
  );
}

function LockedNotice({ details }: { details: { outstanding: string; message: string | null; invoices: { number: string; balance: string }[] } }) {
  return (
    <div role="alert" className="rounded-(--radius-panel) border-2 border-pen-700 bg-pen-100 p-5"><div className="flex items-center gap-2 font-serif text-xl font-semibold text-pen-700"><Icon name="lock" />Results are on hold</div>
      <p className="mt-2 text-ink-800">{details?.message || "Outstanding school fees must be paid before results can be viewed."}</p>
      <p className="num mt-3 text-lg">Amount owing: <strong>{money(details?.outstanding)}</strong></p>
      <ul className="mt-2 space-y-1">{details?.invoices?.map((i) => <li key={i.number} className="num text-ink-700">{i.number} — {money(i.balance)}</li>)}</ul>
      <p className="mt-3 text-ink-700">Please pay at the school bursary, or contact the school. Results appear here as soon as the payment is recorded.</p></div>
  );
}

function CardView({ c, childId, termId }: { c: Card; childId: string; termId: string }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2 text-center"><div className="rounded-lg border border-line bg-surface p-3"><p className="text-sm text-ink-500">Average</p><p className="num font-serif text-2xl font-semibold">{pct(c.card.average)}</p></div><div className="rounded-lg border border-line bg-surface p-3"><p className="text-sm text-ink-500">Position</p><p className="num font-serif text-2xl font-semibold">{c.card.position ? ordinal(c.card.position) : "—"}</p><p className="text-sm text-ink-500">of {c.card.classSize}</p></div><div className="rounded-lg border border-line bg-surface p-3"><p className="text-sm text-ink-500">Year so far</p><p className="num font-serif text-2xl font-semibold">{pct(c.card.cumulativeAverage)}</p></div></div>
      <Panel title="Subjects" padded={false}><ul className="divide-y divide-line">{c.subjects.map((s) => <li key={s.subject} className="flex items-center gap-3 px-4 py-3"><div className="min-w-0 flex-1"><p className="font-bold">{s.subject}</p><p className="num text-sm text-ink-500">CA {s.caTotal} · Exam {s.exam}{s.position ? ` · ${ordinal(s.position)} in class` : ""}</p></div><p className="num text-lg font-bold">{s.total}</p><span className="w-11 rounded-md bg-brand-100 py-1 text-center font-bold text-brand-800">{s.grade}</span></li>)}</ul></Panel>
      {(c.card.teacherRemark || c.card.principalRemark) && <Panel title="Remarks">{c.card.teacherRemark && <p className="mb-2"><strong>Class teacher:</strong> {c.card.teacherRemark}</p>}{c.card.principalRemark && <p><strong>Principal:</strong> {c.card.principalRemark}</p>}</Panel>}
      <a href={`/api/results/students/${childId}/report-card.pdf?termId=${termId}`} className="inline-flex min-h-11 items-center gap-2 rounded-md bg-brand-700 px-4 font-bold text-white"><Icon name="download" size={18} />Download report card (PDF)</a>
    </div>
  );
}
