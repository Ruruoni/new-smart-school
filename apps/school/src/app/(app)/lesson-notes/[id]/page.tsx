"use client";
import { use, useEffect, useState } from "react";
import { api, useApi, useMutation } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { Button, DataState, ErrorNote, Field, PageHeader, Panel, StatusBadge, TextField, Textarea, useToast } from "@/ui/kit";

interface Note { id: string; title: string; topic: string; body: string; status: string; version: number; currentVersion: number; subject: { name: string }; class: { name: string }; attachments: { id: string; file: { id: string; originalName: string; sizeBytes: number } }[]; versions: { versionNo: number; title: string; createdAt: string }[] }

export default function NoteEditor({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const q = useApi<Note>(`/lesson-notes/${id}`); const toast = useToast();
  const [t, setT] = useState(""); const [topic, setTopic] = useState(""); const [b, setB] = useState(""); const [dirty, setDirty] = useState(false);
  useEffect(() => { if (q.data && !dirty) { setT(q.data.title); setTopic(q.data.topic); setB(q.data.body); } }, [q.data, dirty]);
  const save = useMutation(async () => { await api.patch(`/lesson-notes/${id}`, { version: q.data!.version, title: t, topic, body: b }); setDirty(false); toast.push("ok", "Saved as a new version"); q.reload(); });
  const pub = useMutation(async (v: boolean) => { await api.post(`/lesson-notes/${id}/publish`, { published: v }); toast.push("ok", v ? "Published — students and parents can read it" : "Moved back to draft"); q.reload(); });
  const restore = useMutation(async (n: number) => { await api.post(`/lesson-notes/${id}/restore`, { versionNo: n }); setDirty(false); q.reload(); });
  const attach = useMutation(async (file: File) => { const f = new FormData(); f.set("file", file); await api.post(`/lesson-notes/${id}/attachments`, f); toast.push("ok", "File attached"); q.reload(); });
  useEffect(() => { const h = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } }; window.addEventListener("beforeunload", h); return () => window.removeEventListener("beforeunload", h); }, [dirty]);
  return <DataState query={q}>{(n) => (<>
    <PageHeader title={n.title} description={`${n.class.name} · ${n.subject.name} · version ${n.currentVersion}`} actions={<><StatusBadge status={n.status} /><Button variant="secondary" loading={pub.pending} onClick={() => void pub.run(n.status !== "PUBLISHED")}>{n.status === "PUBLISHED" ? "Unpublish" : "Publish"}</Button><Button loading={save.pending} disabled={!dirty} onClick={() => void save.run()}>Save</Button></>} />
    <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
      <Panel><div className="space-y-4"><TextField label="Title" value={t} onChange={(e) => { setT(e.target.value); setDirty(true); }} /><TextField label="Topic" value={topic} onChange={(e) => { setTopic(e.target.value); setDirty(true); }} /><Field label="Notes" htmlFor="body"><Textarea id="body" rows={18} className="leading-relaxed" value={b} onChange={(e) => { setB(e.target.value); setDirty(true); }} /></Field><ErrorNote error={save.error ?? pub.error} /></div></Panel>
      <div className="space-y-6"><Panel title="Attachments">{n.attachments.length === 0 ? <p className="text-ink-500">No files.</p> : <ul className="mb-3 space-y-1">{n.attachments.map((a) => <li key={a.id}><a className="font-bold text-brand-700 underline" href={`/api/files/${a.file.id}`} target="_blank" rel="noreferrer">{a.file.originalName}</a> <span className="text-sm text-ink-500">{Math.round(a.file.sizeBytes / 1024)} KB</span></li>)}</ul>}<label className="inline-flex min-h-11 cursor-pointer items-center rounded-md border border-ink-300 bg-surface px-4 font-bold hover:bg-ink-100 focus-within:outline-3 focus-within:outline-brand-500">Attach file<input type="file" className="sr-only" accept="application/pdf,image/png,image/jpeg,.docx,.xlsx" onChange={(e) => e.target.files?.[0] && void attach.run(e.target.files[0])} /></label><ErrorNote error={attach.error} /></Panel>
        <Panel title="Version history" padded={false}><ul className="divide-y divide-line">{n.versions.map((v) => <li key={v.versionNo} className="flex items-center justify-between px-4 py-2"><span><strong className="num">v{v.versionNo}</strong> <span className="text-sm text-ink-500">{dateTime(v.createdAt)}</span></span>{v.versionNo !== n.currentVersion && <Button size="sm" variant="ghost" onClick={() => void restore.run(v.versionNo)}>Restore</Button>}</li>)}</ul></Panel></div>
    </div></>)}</DataState>;
}
