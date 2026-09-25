"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, qs, useApi, useMutation } from "@/lib/api";
import { date } from "@/lib/format";
import { Badge, Button, DataState, Dialog, EmptyState, ErrorNote, Field, PageHeader, Pagination, Panel, SearchBox, SelectField, StatusBadge, TextField, Textarea } from "@/ui/kit";
import { DataTable } from "@/ui/table";
import { ClassSelect } from "@/ui/pickers";

interface Note { id: string; title: string; topic: string; status: string; updatedAt: string; subject: { name: string }; class: { name: string }; _count: { attachments: number } }

export default function LessonNotes() {
  const router = useRouter();
  const [q, setQ] = useState(""); const [classId, setClassId] = useState(""); const [page, setPage] = useState(1); const [open, setOpen] = useState(false);
  const list = useApi<{ items: Note[]; total: number; page: number; pageSize: number }>(`/lesson-notes${qs({ q, classId, page })}`);
  const subjects = useApi<{ id: string; name: string }[]>("/academics/subjects"); const classes = useApi<{ id: string; name: string }[]>("/academics/classes");
  const [f, setF] = useState({ classId: "", subjectId: "", topic: "", title: "", body: "" });
  const create = useMutation(async () => { const n = await api.post<{ id: string }>("/lesson-notes", f); router.push(`/lesson-notes/${n.id}`); });
  return (<>
    <PageHeader title="Lesson notes" description="Write notes for the classes you teach, keep every version, and publish when ready for students and parents." actions={<Button icon="plus" onClick={() => setOpen(true)}>New note</Button>} />
    <div className="mb-4 flex flex-wrap items-center gap-3"><SearchBox value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Title or topic" label="Search notes" /><ClassSelect allowAll value={classId} onChange={(v) => { setClassId(v); setPage(1); }} /></div>
    <DataState query={list}>{(d) => d.items.length === 0 ? <Panel><EmptyState title="No lesson notes yet" icon="book">Create your first note for a class you teach.</EmptyState></Panel> : (<><DataTable rows={d.items} rowKey={(n) => n.id} onRowClick={(n) => router.push(`/lesson-notes/${n.id}`)} rule={(n) => (n.status === "PUBLISHED" ? "ok" : "warn")} columns={[{ key: "t", header: "Title", cell: (n) => <strong>{n.title}</strong> }, { key: "s", header: "Class · subject", cell: (n) => `${n.class.name} · ${n.subject.name}` }, { key: "o", header: "Topic", className: "hidden md:table-cell", cell: (n) => n.topic }, { key: "a", header: "Files", className: "hidden sm:table-cell", cell: (n) => (n._count.attachments ? <Badge icon="file">{n._count.attachments}</Badge> : "—") }, { key: "u", header: "Updated", cell: (n) => date(n.updatedAt) }, { key: "st", header: "Status", cell: (n) => <StatusBadge status={n.status} /> }]} /><Pagination page={d.page} pageSize={d.pageSize} total={d.total} onPage={setPage} /></>)}</DataState>
    <Dialog open={open} onClose={() => setOpen(false)} wide title="New lesson note" footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={create.pending} disabled={!f.classId || !f.subjectId || f.title.length < 3 || f.topic.length < 2 || !f.body} onClick={() => void create.run()}>Create</Button></>}>
      <div className="space-y-4"><div className="grid gap-4 sm:grid-cols-2"><SelectField label="Class" value={f.classId} onChange={(e) => setF({ ...f, classId: e.target.value })}><option value="">Choose…</option>{classes.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</SelectField><SelectField label="Subject" value={f.subjectId} onChange={(e) => setF({ ...f, subjectId: e.target.value })}><option value="">Choose…</option>{subjects.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</SelectField></div><TextField label="Topic" value={f.topic} onChange={(e) => setF({ ...f, topic: e.target.value })} /><TextField label="Title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /><Field label="Notes" htmlFor="nb"><Textarea id="nb" rows={8} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field><ErrorNote error={create.error} /></div></Dialog>
  </>);
}
