"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { qs, useApi } from "@/lib/api";
import { date } from "@/lib/format";
import { DataState, EmptyState, PageHeader, Pagination, Panel, SearchBox, StatusBadge, Tabs } from "@/ui/kit";
import { DataTable } from "@/ui/table";

interface App { id: string; applicationNumber: string; status: string; firstName: string; lastName: string; guardianName: string; guardianPhone: string; submittedAt: string | null }

export default function Admissions() {
  const router = useRouter();
  const [status, setStatus] = useState(""); const [q, setQ] = useState(""); const [page, setPage] = useState(1);
  const list = useApi<{ items: App[]; total: number; page: number; pageSize: number }>(`/admissions${qs({ status, q, page, pageSize: 25 })}`);
  const tabs = [["", "All"], ["SUBMITTED", "New"], ["UNDER_REVIEW", "In review"], ["VERIFIED", "Verified"], ["APPROVED", "Approved"], ["ENROLLED", "Enrolled"], ["REJECTED", "Declined"]] as const;
  return (<>
    <PageHeader title="Admissions" description="Applications from the public admissions page. Review documents, decide, then enrol approved children." />
    <Tabs label="Application status" value={status as never} onChange={(v) => { setStatus(v as string); setPage(1); }} tabs={tabs.map(([id, label]) => ({ id: id as never, label }))} />
    <div className="mb-4"><SearchBox value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Name, application number or phone" label="Search applications" /></div>
    <DataState query={list}>{(d) => d.items.length === 0 ? <Panel><EmptyState title="No applications here" icon="file">Share your school's admissions page (/apply) with parents.</EmptyState></Panel> : (<>
      <DataTable rows={d.items} rowKey={(a) => a.id} onRowClick={(a) => router.push(`/admissions/${a.id}`)} rule={(a) => (a.status === "SUBMITTED" ? "warn" : a.status === "REJECTED" ? "bad" : a.status === "ENROLLED" || a.status === "APPROVED" ? "ok" : "info")} columns={[{ key: "n", header: "Application", cell: (a) => <span className="num font-bold">{a.applicationNumber}</span> }, { key: "a", header: "Applicant", cell: (a) => `${a.lastName}, ${a.firstName}` }, { key: "g", header: "Guardian", className: "hidden md:table-cell", cell: (a) => `${a.guardianName} · ${a.guardianPhone}` }, { key: "d", header: "Submitted", className: "hidden sm:table-cell", cell: (a) => date(a.submittedAt) }, { key: "s", header: "Status", cell: (a) => <StatusBadge status={a.status} /> }]} />
      <Pagination page={d.page} pageSize={d.pageSize} total={d.total} onPage={setPage} /></>)}</DataState>
  </>);
}
