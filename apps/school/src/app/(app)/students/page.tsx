"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { qs, useApi } from "@/lib/api";
import { date, fullName } from "@/lib/format";
import { Button, DataState, EmptyState, PageHeader, Pagination, SearchBox, Select, StatusBadge, Panel } from "@/ui/kit";
import { Can } from "@/ui/session";
import { DataTable } from "@/ui/table";

interface Row { id: string; admissionNumber: string; firstName: string; middleName: string | null; lastName: string; gender: string; status: string; dateOfBirth: string | null; enrollments: { class: { id: string; name: string }; section: { name: string } | null }[] }
interface Page { items: Row[]; total: number; page: number; pageSize: number }

export default function Students() {
  const router = useRouter();
  const [q, setQ] = useState(""); const [classId, setClassId] = useState(""); const [status, setStatus] = useState("ACTIVE"); const [page, setPage] = useState(1);
  const classes = useApi<{ id: string; name: string }[]>("/academics/classes");
  const list = useApi<Page>(`/students${qs({ q, classId, status, page, pageSize: 25 })}`);
  return (
    <>
      <PageHeader title="Students" description="Everyone enrolled at the school. Search by name or admission number." actions={<Can perm={["students.create"]}><Link href="/students/new"><Button icon="plus">Add student</Button></Link></Can>} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SearchBox value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Name or admission number" label="Search students" />
        <Select aria-label="Class" className="w-auto min-w-40" value={classId} onChange={(e) => { setClassId(e.target.value); setPage(1); }}><option value="">All classes</option>{classes.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
        <Select aria-label="Status" className="w-auto min-w-40" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>{["ACTIVE", "SUSPENDED", "WITHDRAWN", "TRANSFERRED", "GRADUATED", ""].map((s) => <option key={s} value={s}>{s ? s[0] + s.slice(1).toLowerCase() : "Any status"}</option>)}</Select>
      </div>
      <DataState query={list}>{(d) => d.items.length === 0 ? <Panel><EmptyState title="No students found" icon="users">Try a different search or filter.</EmptyState></Panel> : (
        <>
          <DataTable caption="Students" rows={d.items} rowKey={(r) => r.id} onRowClick={(r) => router.push(`/students/${r.id}`)} rule={(r) => (r.status === "SUSPENDED" ? "warn" : r.status === "WITHDRAWN" ? "bad" : undefined)}
            columns={[
              { key: "n", header: "Name", cell: (r) => <Link href={`/students/${r.id}`} className="font-bold text-brand-800 hover:underline">{r.lastName}, {r.firstName}{r.middleName ? ` ${r.middleName[0]}.` : ""}</Link> },
              { key: "a", header: "Admission no.", className: "whitespace-nowrap", cell: (r) => <span className="num">{r.admissionNumber}</span> },
              { key: "c", header: "Class", cell: (r) => r.enrollments[0] ? `${r.enrollments[0].class.name}${r.enrollments[0].section ? ` ${r.enrollments[0].section.name}` : ""}` : <span className="text-ink-500">Not enrolled</span> },
              { key: "g", header: "Sex", className: "hidden sm:table-cell", cell: (r) => (r.gender === "MALE" ? "M" : "F") },
              { key: "d", header: "Date of birth", className: "hidden md:table-cell", cell: (r) => date(r.dateOfBirth) },
              { key: "s", header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
            ]} />
          <Pagination page={d.page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
        </>
      )}</DataState>
    </>
  );
}
void fullName;
