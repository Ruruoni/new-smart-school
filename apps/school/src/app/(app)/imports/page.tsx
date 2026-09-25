"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, useApi, useMutation } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { Button, DataState, EmptyState, ErrorNote, PageHeader, Panel, SelectField, StatusBadge } from "@/ui/kit";
import { DataTable } from "@/ui/table";
import { useSession } from "@/ui/session";
import { WorkerNotice } from "@/ui/worker-notice";

interface Kind { key: string; label: string; permission: string; columns: { key: string; label: string; required?: boolean; help?: string }[] }
interface Job { id: string; kind: string; status: string; totalRows: number; validRows: number; errorRows: number; duplicateRows: number; importedRows: number; createdAt: string }

function ImportsInner() {
  const router = useRouter(); const sp = useSearchParams(); const { can } = useSession();
  const kinds = useApi<Kind[]>("/imports/kinds"); const jobs = useApi<Job[]>("/imports");
  const allowed = kinds.data?.filter((k) => can(k.permission)) ?? [];
  const [kind, setKind] = useState(sp.get("kind") ?? ""); const [file, setFile] = useState<File | null>(null);
  useEffect(() => { if (!kind && allowed[0]) setKind(allowed[0].key); }, [kind, allowed]);
  const k = allowed.find((x) => x.key === kind);
  const upload = useMutation(async () => { const f = new FormData(); f.set("kind", kind); f.set("file", file!); const j = await api.post<{ id: string }>("/imports", f); router.push(`/imports/${j.id}`); });
  useEffect(() => { if (jobs.data?.some((j) => ["UPLOADED", "APPROVED", "PROCESSING"].includes(j.status))) { const t = setTimeout(jobs.reload, 2500); return () => clearTimeout(t); } }, [jobs]);
  return (<>
    <PageHeader title="Import from Excel" description="Bring in students, teachers or questions from a spreadsheet. You'll see exactly what will be imported — and what's wrong — before anything is saved." />
    <WorkerNotice waiting={!!jobs.data?.some((j) => ["UPLOADED", "APPROVED", "PROCESSING"].includes(j.status))} what="import" />
    <div className="mt-4 grid gap-6 lg:grid-cols-[24rem_1fr]">
      <Panel title="1. Choose and upload"><div className="space-y-4">
        <SelectField label="What are you importing?" value={kind} onChange={(e) => setKind(e.target.value)}>{allowed.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</SelectField>
        {kind && <a className="inline-flex items-center gap-2 font-bold text-brand-700 underline" href={`/api/imports/template/${kind}`}>Download the Excel template</a>}
        <label className="flex min-h-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-ink-300 p-4 text-center hover:border-brand-700 focus-within:outline-3 focus-within:outline-brand-500"><span className="font-bold">{file ? file.name : "Choose an .xlsx or .csv file"}</span><span className="text-sm text-ink-500">Up to 5,000 rows · 10 MB</span><input type="file" className="sr-only" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
        <ErrorNote error={upload.error} /><Button loading={upload.pending} disabled={!file || !kind} icon="upload" onClick={() => void upload.run()}>Upload and check</Button></div>
        {k && <details className="mt-4"><summary className="cursor-pointer font-bold">Columns in this template</summary><ul className="mt-2 space-y-1 text-[0.9375rem]">{k.columns.map((c) => <li key={c.key}><strong>{c.label}</strong>{c.required ? " *" : ""}{c.help ? <span className="text-ink-500"> — {c.help}</span> : null}</li>)}</ul></details>}</Panel>
      <Panel title="Recent imports" padded={false}><DataState query={jobs}>{(d) => d.length === 0 ? <EmptyState title="No imports yet" icon="upload" /> : <DataTable compact rows={d} rowKey={(j) => j.id} onRowClick={(j) => router.push(`/imports/${j.id}`)} columns={[{ key: "k", header: "Type", cell: (j) => j.kind.toLowerCase() }, { key: "d", header: "When", cell: (j) => dateTime(j.createdAt) }, { key: "r", header: "Rows", align: "right", cell: (j) => j.totalRows }, { key: "i", header: "Imported", align: "right", cell: (j) => j.importedRows }, { key: "s", header: "Status", cell: (j) => <StatusBadge status={j.status} /> }]} />}</DataState></Panel>
    </div></>);
}
export default function Imports() { return <Suspense><ImportsInner /></Suspense>; }
