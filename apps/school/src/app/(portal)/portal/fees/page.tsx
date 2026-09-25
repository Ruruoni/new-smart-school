"use client";
import { useApi } from "@/lib/api";
import { date, money } from "@/lib/format";
import { DataState, EmptyState, Panel, StatusBadge } from "@/ui/kit";
import { ChildSelector, useChild } from "@/ui/children";

export default function PortalFees() {
  const { child } = useChild();
  const q = useApi<{ outstanding: string; credit: string; invoices: { id: string; number: string; status: string; total: string; amountPaid: string; dueDate: string | null; term: { name: string } | null }[]; payments: { id: string; receiptNumber: string; amount: string; receivedAt: string; status: string }[] }>(child?.canViewFinance ? `/finance/students/${child.id}/statement` : null);
  if (!child) return null;
  if (!child.canViewFinance) return <Panel><EmptyState title="Fees aren't shared with you" icon="lock">The school has set this account not to view fees.</EmptyState></Panel>;
  return (
    <div className="space-y-4"><ChildSelector />
      <DataState query={q}>{(d) => (<>
        <div className={`rounded-(--radius-panel) border-2 p-4 ${Number(d.outstanding) > 0 ? "border-pen-700 bg-pen-100" : "border-leaf-700 bg-leaf-100"}`}><p className="text-ink-700">Balance owing</p><p className="num font-serif text-3xl font-semibold">{money(d.outstanding)}</p>{Number(d.credit) > 0 && <p className="num text-ink-700">Credit on account: {money(d.credit)}</p>}</div>
        <Panel title="Invoices" padded={false}>{d.invoices.length === 0 ? <EmptyState title="No invoices yet" icon="wallet" /> : <ul className="divide-y divide-line">{d.invoices.map((i) => <li key={i.id} className="px-4 py-3"><div className="flex items-center justify-between gap-2"><p className="num font-bold">{i.number}</p><StatusBadge status={i.status} /></div><p className="text-ink-500">{i.term?.name ?? ""} · due {date(i.dueDate)}</p><p className="num">{money(i.amountPaid)} paid of {money(i.total)}</p></li>)}</ul>}</Panel>
        <Panel title="Payments received" padded={false}>{d.payments.length === 0 ? <EmptyState title="No payments yet" icon="wallet" /> : <ul className="divide-y divide-line">{d.payments.map((p) => <li key={p.id} className="flex items-center justify-between px-4 py-3"><div><p className="num font-bold">{p.receiptNumber}</p><p className="text-sm text-ink-500">{date(p.receivedAt)}</p></div><p className="num font-bold">{money(p.amount)}</p></li>)}</ul>}</Panel></>
      )}</DataState></div>
  );
}
