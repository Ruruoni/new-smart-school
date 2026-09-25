"use client";
import { useState } from "react";
import { api, useApi, useMutation } from "@/lib/api";
import { date } from "@/lib/format";
import { Button, Checkbox, DataState, Dialog, EmptyState, FormError, PageHeader, Panel, SelectField, TextField, Textarea, Field, useToast } from "@/ui/kit";
import { Can, useSession } from "@/ui/session";

interface Announcement { id: string; title: string; body: string; publishedAt: string | null; audience: { roles?: string[]; classIds?: string[] } }
const ROLES = ["TEACHER", "STAFF", "PARENT", "STUDENT"];

export default function Announcements() {
  const list = useApi<Announcement[]>("/announcements");
  const classes = useApi<{ id: string; name: string }[]>("/academics/classes");
  const { can } = useSession();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ title: "", body: "", roles: [] as string[], classId: "" });
  const create = useMutation(async () => {
    await api.post("/announcements", { title: f.title, body: f.body, audience: { roles: f.roles, classIds: f.classId ? [f.classId] : [] } });
    toast.push("ok", "Published — recipients have been notified.");
    setOpen(false); setF({ title: "", body: "", roles: [], classId: "" }); list.reload();
  });
  return (
    <>
      <PageHeader title="Announcements" description="News from the school. Everything published here also appears in people's notification bell." actions={<Can perm={["announcements.manage"]}><Button icon="plus" onClick={() => setOpen(true)}>New announcement</Button></Can>} />
      <DataState query={list}>{(items) => items.length === 0 ? <Panel><EmptyState title="No announcements yet" icon="bell">{can("announcements.manage") ? "Publish one to notify parents, students or staff." : "Check back soon."}</EmptyState></Panel> : (
        <ul className="space-y-3">{items.map((a) => (
          <li key={a.id}><Panel><div className="flex items-start justify-between gap-3"><h2 className="font-serif text-xl font-semibold">{a.title}</h2><span className="shrink-0 text-sm text-ink-500">{date(a.publishedAt)}</span></div><p className="mt-2 max-w-[70ch] whitespace-pre-line text-ink-800">{a.body}</p></Panel></li>
        ))}</ul>
      )}</DataState>
      <Dialog open={open} onClose={() => setOpen(false)} title="New announcement" wide footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={create.pending} onClick={() => void create.run()} disabled={f.title.length < 3 || f.body.length < 3}>Publish</Button></>}>
        <div className="space-y-4">
          <TextField label="Title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required />
          <Field label="Message" htmlFor="ann-body" required><Textarea id="ann-body" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} rows={5} /></Field>
          <fieldset><legend className="mb-2 font-bold">Who should see it?</legend><p className="mb-2 text-sm text-ink-500">Leave everything unticked to send it to the whole school.</p>
            <div className="grid gap-2 sm:grid-cols-2">{ROLES.map((r) => <Checkbox key={r} label={r === "STAFF" ? "Non-teaching staff" : r[0] + r.slice(1).toLowerCase() + "s"} checked={f.roles.includes(r)} onChange={(e) => setF({ ...f, roles: e.target.checked ? [...f.roles, r] : f.roles.filter((x) => x !== r) })} />)}</div>
          </fieldset>
          <SelectField label="Or one class (students and their parents)" value={f.classId} onChange={(e) => setF({ ...f, classId: e.target.value })}><option value="">All classes</option>{classes.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</SelectField>
          <FormError error={create.error} />
        </div>
      </Dialog>
    </>
  );
}
