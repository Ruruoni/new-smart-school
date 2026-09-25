"use client";
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { api, useApi, useMutation } from "@/lib/api";
import { Button, Checkbox, DataState, ErrorNote, PageHeader, Panel, Stat, StatusBadge, useToast } from "@/ui/kit";
import { DataTable } from "@/ui/table";
import { WorkerNotice } from "@/ui/worker-notice";

interface Prev { job: { id: string; kind: string; label: string; status: string; totalRows: number; validRows: number; errorRows: number; duplicateRows: number; importedRows: number; report: { error?: string; credentialsFileId?: string; imported?: number; skipped?: number } | null }; sample: { rowNumber: number; normalized: Record<string, unknown> }[]; errors: { id: string; rowNumber: number; field: string | null; code: string; message: string }[]; errorTotal: number }

export default function ImportJob({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params); const q = useApi<Prev>(`/imports/${id}`); const toast = useToast(); const [skip, setSkip] = useState(false);
  useEffect(() => { if (q.data && ["UPLOADED", "APPROVED", "PROCESSING"].includes(q.data.job.status)) { const t = setTimeout(q.reload, 2000); return () => clearTimeout(t); } }, [q]);
  const approve = useMutation(async () => { await api.post(`/imports/${id}/approve`, { skipInvalidRows: skip }); toast.push("ok", "Importing…"); q.reload(); });
  const cancel = useMutation(async () => { await api.post(`/imports/${id}/cancel`); q.reload(); });
  const resume = useMutation(async () => { await api.post(`/imports/${id}/resume`); q.reload(); });
  return <DataState query={q}>{({ job, sample, errors, errorTotal }) => {
    const bad = job.errorRows + job.duplicateRows;
    return (<>
      <PageHeader title={job.label} description={`Import ${id.slice(0, 8)}`} actions={<StatusBadge status={job.status} />} />
      <WorkerNotice waiting={["UPLOADED", "APPROVED", "PROCESSING"].includes(job.status)} what="import" />
      {["UPLOADED", "APPROVED", "PROCESSING"].includes(job.status) && <p role="status" className="mb-4 rounded bg-sky-100 p-3 text-sky-700">Working on it — this page updates by itself.</p>}
      {job.status === "FAILED" && <div className="mb-4 space-y-3"><p role="alert" className="rounded bg-pen-100 p-3 font-bold text-pen-700">{job.report?.error ?? "The import failed."}</p>{job.validRows > 0 && job.importedRows > 0 && <Button variant="secondary" loading={resume.pending} onClick={() => void resume.run()}>Continue where it stopped</Button>}</div>}
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4"><Stat label="Rows in file" value={job.totalRows} /><Stat label="Ready to import" value={job.validRows} tone="ok" /><Stat label="Have problems" value={job.errorRows} tone={job.errorRows ? "bad" : undefined} /><Stat label="Already exist" value={job.duplicateRows} tone={job.duplicateRows ? "warn" : undefined} /></div>
      {job.status === "COMPLETED" && <div className="mb-6 rounded-lg border-2 border-leaf-700 bg-leaf-100 p-4"><p className="font-serif text-xl font-semibold">Imported {job.importedRows} row{job.importedRows === 1 ? "" : "s"}</p>{job.report?.credentialsFileId && <p className="mt-2">New accounts were created. <a className="font-bold text-brand-800 underline" href={`/api/files/${job.report.credentialsFileId}`}>Download the temporary passwords</a> — hand them out, then delete the file. It is removed automatically after 7 days.</p>}<Link className="mt-2 inline-block font-bold text-brand-800 underline" href="/imports">Back to imports</Link></div>}
      {job.status === "PREVIEW" && <Panel title="2. Review and approve"><div className="space-y-3"><p className="text-ink-700">Nothing has been saved yet. {job.validRows} row{job.validRows === 1 ? "" : "s"} can be imported{bad ? `; ${bad} will be skipped.` : "."}</p>{bad > 0 && <Checkbox label={`Import the ${job.validRows} good rows and skip the ${bad} with problems`} hint="Or fix the spreadsheet and upload it again." checked={skip} onChange={(e) => setSkip(e.target.checked)} />}<ErrorNote error={approve.error} /><div className="flex gap-2"><Button loading={approve.pending} disabled={job.validRows === 0 || (bad > 0 && !skip)} onClick={() => void approve.run()}>Import {job.validRows} row{job.validRows === 1 ? "" : "s"}</Button><Button variant="secondary" loading={cancel.pending} onClick={() => void cancel.run()}>Cancel import</Button></div></div></Panel>}
      {errorTotal > 0 && <Panel title={`Problems found (${errorTotal})`} className="mt-6" actions={<a className="font-bold text-brand-700 underline" href={`/api/imports/${id}/errors.csv`}>Download as CSV</a>} padded={false}><DataTable compact rows={errors} rowKey={(e) => e.id} rule={() => "bad"} columns={[{ key: "r", header: "Row", align: "right", cell: (e) => e.rowNumber }, { key: "f", header: "Column", cell: (e) => e.field ?? "—" }, { key: "m", header: "Problem", cell: (e) => e.message }]} /></Panel>}
      {sample.length > 0 && <Panel title="Sample of rows that will be imported" className="mt-6" padded={false}><div className="overflow-x-auto"><DataTable compact rows={sample} rowKey={(s) => String(s.rowNumber)} columns={[{ key: "r", header: "Row", align: "right", cell: (s) => s.rowNumber }, ...Object.keys(sample[0]!.normalized).filter((k) => !["password", "classId", "sectionId"].includes(k)).slice(0, 7).map((k) => ({ key: k, header: k, cell: (s: { normalized: Record<string, unknown> }) => String(s.normalized[k] ?? "") }))]} /></div></Panel>}
    </>);
  }}</DataState>;
}
