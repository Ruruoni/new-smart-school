"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { qs, useApi } from "@/lib/api";
import { date, money } from "@/lib/format";
import { DataState, EmptyState, PageHeader, Pagination, Panel, SearchBox, Select, StatusBadge } from "@/ui/kit";
import { DataTable } from "@/ui/table";

interface Inv { id: string; number: string; status: string; total: string; amountPaid: string; dueDate: string | null; student: { firstName: string; lastName: string; admissionNumber: string } | null }

export default function Invoices() {
  const router = useRouter();
  const [q, setQ] = useState(""); const [status, setStatus] = useState(""); const [overdue, setOverdue] = useState(false); const [page, setPage] = useState(1);
  const list = useApi<{ items: Inv[]; total: number; page: number; pageSize: number }>(`/finance/invoices${qs({ q, status, overdue: overdue ? 1 : undefined, page })}`);
  return (
    <>
      <PageHeader title="Invoices" description="Every invoice issued to students and applicants." />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SearchBox value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Invoice number or student" label="Search invoices" />
        <Select aria-label="Status" className="w-auto" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">Any status</option>{["ISSUED", "PARTIALLY_PAID", "PAID", "VOID", "DRAFT"].map((s) => <option key={s} value={s}>{s.replace("_", " ").toLowerCase().replace(/^./, (c) => c.toUpperCase())}</option>)}</Select>
        <label className="flex min-h-11 cursor-pointer items-center gap-2"><input type="checkbox" className="size-5 accent-brand-700" checked={overdue} onChange={(e) => { setOverdue(e.target.checked); setPage(1); }} />Overdue only</label>
      </div>
      <DataState query={list}>{(d) => d.items.length === 0 ? <Panel><EmptyState title="No invoices found" icon="file" /></Panel> : (<>
        <DataTable caption="Invoices" rows={d.items} rowKey={(i) => i.id} onRowClick={(i) => router.push(`/finance/invoices/${i.id}`)} rule={(i) => (i.status === "PAID" ? "ok" : i.status === "VOID" ? undefined : i.dueDate && new Date(i.dueDate) < new Date() ? "bad" : "warn")} columns={[
          { key: "n", header: "Invoice", cell: (i) => <Link href={`/finance/invoices/${i.id}`} className="num font-bold text-brand-800 hover:underline">{i.number}</Link> },
          { key: "s", header: "Student", cell: (i) => (i.student ? `${i.student.lastName}, ${i.student.firstName}` : "Application fee") },
          { key: "d", header: "Due", className: "hidden sm:table-cell", cell: (i) => date(i.dueDate) },
          { key: "t", header: "Total", align: "right", cell: (i) => money(i.total) }, { key: "p", header: "Balance", align: "right", cell: (i) => money(Number(i.total) - Number(i.amountPaid)) },
          { key: "st", header: "Status", cell: (i) => <StatusBadge status={i.status} /> },
        ]} />
        <Pagination page={d.page} pageSize={d.pageSize} total={d.total} onPage={setPage} /></>
      )}</DataState>
    </>
  );
}
