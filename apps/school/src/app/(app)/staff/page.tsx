"use client";
import { useState } from "react";
import { api, qs, useApi, useMutation } from "@/lib/api";
import { Button, DataState, Dialog, EmptyState, ErrorNote, PageHeader, Pagination, Panel, SearchBox, StatusBadge, TabPanel, Tabs, TextField, useToast } from "@/ui/kit";
import { Can } from "@/ui/session";
import { DataTable } from "@/ui/table";

interface Person { id: string; staffNumber: string; qualification?: string | null; specialization?: string | null; department?: string | null; position?: string | null; user: { firstName: string; lastName: string; email: string | null; phone: string | null; status: string } }
type Kind = "teachers" | "staff";

export default function Staff() {
  const [tab, setTab] = useState<Kind>("teachers"); const [q, setQ] = useState(""); const [page, setPage] = useState(1); const toast = useToast();
  const list = useApi<{ items: Person[]; total: number; page: number; pageSize: number }>(`/${tab}${qs({ q, page })}`);
  const [open, setOpen] = useState(false); const [f, setF] = useState({ firstName: "", lastName: "", phone: "", email: "", qualification: "", specialization: "", department: "", position: "" });
  const [cred, setCred] = useState<{ username: string; initialPassword: string } | null>(null);
  const add = useMutation(async () => { const body = Object.fromEntries(Object.entries(f).filter(([, v]) => v)); const r = await api.post<{ username: string; initialPassword: string }>(`/${tab}`, body); setCred(r); setOpen(false); toast.push("ok", "Added"); list.reload(); });
  return (<>
    <PageHeader title="Teachers and staff" description="Each person gets a sign-in with a temporary password they must change at first login." actions={<Can perm={["teachers.manage"]}><Button icon="plus" onClick={() => setOpen(true)}>Add {tab === "teachers" ? "teacher" : "staff member"}</Button></Can>} />
    <Tabs label="People" value={tab} onChange={(v) => { setTab(v); setPage(1); }} tabs={[{ id: "teachers", label: "Teachers" }, { id: "staff", label: "Non-teaching staff" }]} />
    <div className="mb-4"><SearchBox value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Name or staff number" label="Search" /></div>
    <TabPanel id={tab} active><DataState query={list}>{(d) => d.items.length === 0 ? <Panel><EmptyState title="Nobody here yet" icon="user" /></Panel> : (<><DataTable rows={d.items} rowKey={(p) => p.id} columns={[{ key: "n", header: "Name", cell: (p) => <strong>{p.user.lastName}, {p.user.firstName}</strong> }, { key: "s", header: "Staff no.", cell: (p) => <span className="num">{p.staffNumber}</span> }, { key: "d", header: tab === "teachers" ? "Specialisation" : "Department", cell: (p) => (tab === "teachers" ? p.specialization : p.department) ?? "—" }, { key: "c", header: "Contact", className: "hidden md:table-cell", cell: (p) => p.user.phone ?? p.user.email ?? "—" }, { key: "st", header: "Status", cell: (p) => <StatusBadge status={p.user.status} /> }]} /><Pagination page={d.page} pageSize={d.pageSize} total={d.total} onPage={setPage} /></>)}</DataState></TabPanel>
    <Dialog open={open} onClose={() => setOpen(false)} title={`Add ${tab === "teachers" ? "a teacher" : "a staff member"}`} footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={add.pending} disabled={!f.firstName || !f.lastName} onClick={() => void add.run()}>Add</Button></>}>
      <div className="space-y-4"><div className="grid gap-4 sm:grid-cols-2"><TextField label="First name" value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} required /><TextField label="Last name" value={f.lastName} onChange={(e) => setF({ ...f, lastName: e.target.value })} required /></div><div className="grid gap-4 sm:grid-cols-2"><TextField label="Phone" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /><TextField label="Email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
        {tab === "teachers" ? <div className="grid gap-4 sm:grid-cols-2"><TextField label="Qualification" value={f.qualification} onChange={(e) => setF({ ...f, qualification: e.target.value })} /><TextField label="Specialisation" value={f.specialization} onChange={(e) => setF({ ...f, specialization: e.target.value })} /></div> : <div className="grid gap-4 sm:grid-cols-2"><TextField label="Department" value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} /><TextField label="Position" value={f.position} onChange={(e) => setF({ ...f, position: e.target.value })} /></div>}<ErrorNote error={add.error} /></div>
    </Dialog>
    <Dialog open={!!cred} onClose={() => setCred(null)} title="Sign-in details" footer={<Button onClick={() => setCred(null)}>Done</Button>}>{cred && <div className="space-y-3"><p>Give these to the new user. The password is temporary and shown only now.</p><p className="num rounded border border-line bg-paper p-3">Username <strong>{cred.username}</strong><br />Password <strong>{cred.initialPassword}</strong></p></div>}</Dialog>
  </>);
}
