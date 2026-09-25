"use client";
import { useState } from "react";
import Link from "next/link";
import { api, useApi, useMutation } from "@/lib/api";
import { ordinal, pct } from "@/lib/format";
import { Badge, Button, ConfirmDialog, DataState, Dialog, EmptyState, ErrorNote, Field, PageHeader, Panel, StatusBadge, Tabs, TabPanel, Textarea, useToast } from "@/ui/kit";
import { ClassSelect, TermSelect } from "@/ui/pickers";
import { Can } from "@/ui/session";
import { DataTable } from "@/ui/table";

interface Card { id: string; studentId: string; average: string; totalScore: string; position: number | null; classSize: number | null; status: string; version: number; teacherRemark: string | null; principalRemark: string | null; student: { firstName: string; lastName: string; admissionNumber: string } }
interface Summary { students: number; subjectResults: number; skippedPublished: number; incomplete: { studentId: string; student: string; subject: string; missing: string[] }[] }
type Tab = "class" | "promotion" | "grading";

export default function Results() {
  const [termId, setTermId] = useState(""); const [classId, setClassId] = useState(""); const [tab, setTab] = useState<Tab>("class");
  return (
    <>
      <PageHeader title="Results" description="Process scores into subject results and report cards, review them, then publish to parents." />
      <div className="mb-4 flex flex-wrap items-center gap-3"><TermSelect value={termId} onChange={setTermId} /><ClassSelect value={classId} onChange={setClassId} /></div>
      <Tabs label="Results sections" value={tab} onChange={setTab} tabs={[{ id: "class", label: "Class results" }, { id: "promotion", label: "Promotion" }, { id: "grading", label: "Grading scheme" }]} />
      <TabPanel id="class" active={tab === "class"}>{termId && classId ? <ClassResults termId={termId} classId={classId} /> : null}</TabPanel>
      <TabPanel id="promotion" active={tab === "promotion"}><Can perm={["promotion.manage"]} fallback={<p className="text-ink-500">You don't have access to promotions.</p>}>{classId ? <Promotion classId={classId} /> : null}</Can></TabPanel>
      <TabPanel id="grading" active={tab === "grading"}><Grading /></TabPanel>
    </>
  );
}

function ClassResults({ termId, classId }: { termId: string; classId: string }) {
  const q = useApi<Card[]>(`/results/class?termId=${termId}&classId=${classId}`);
  const toast = useToast();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [dlg, setDlg] = useState<"publish" | "withdraw" | "incomplete" | null>(null);
  const [reason, setReason] = useState("");
  const processM = useMutation(async (allowIncomplete: boolean) => {
    try { const r = await api.post<Summary>("/results/process", { termId, classId, allowIncomplete }); setSummary(r); toast.push("ok", `Processed ${r.students} students, ${r.subjectResults} subject results`); q.reload(); }
    catch (e) { if ((e as { code?: string }).code === "INCOMPLETE_SCORES") { setDlg("incomplete"); setSummary({ students: 0, subjectResults: 0, skippedPublished: 0, incomplete: ((e as { details?: { incomplete: Summary["incomplete"] } }).details?.incomplete) ?? [] }); return; } throw e; }
  });
  const publish = useMutation(async () => { const r = await api.post<{ reportCards: number }>("/results/publish", { termId, classId }); toast.push("ok", `Published ${r.reportCards} report cards — parents have been notified`); setDlg(null); q.reload(); });
  const withdraw = useMutation(async () => { await api.post("/results/withdraw", { termId, classId, reason }); toast.push("ok", "Results withdrawn"); setDlg(null); setReason(""); q.reload(); });
  const drafts = q.data?.filter((c) => c.status !== "PUBLISHED").length ?? 0; const published = q.data?.filter((c) => c.status === "PUBLISHED").length ?? 0;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 no-print">
        <Can perm={["results.process"]}><Button icon="refresh" loading={processM.pending} onClick={() => void processM.run(false)}>Process results</Button></Can>
        <Can perm={["results.publish"]}><Button variant="secondary" icon="send" disabled={drafts === 0} onClick={() => setDlg("publish")}>Publish {drafts ? `(${drafts})` : ""}</Button><Button variant="secondary" disabled={published === 0} onClick={() => setDlg("withdraw")}>Withdraw published</Button></Can>
        <Link href={`/reports?kind=REPORT_CARD&termId=${termId}&classId=${classId}`}><Button variant="secondary" icon="print">Print report cards</Button></Link>
      </div>
      <ErrorNote error={processM.error} />
      {summary && summary.students > 0 && <p role="status" className="rounded bg-leaf-100 px-3 py-2 text-leaf-700">Processed {summary.students} students. {summary.skippedPublished > 0 && `${summary.skippedPublished} already published were left untouched.`}{summary.incomplete.length > 0 && ` ${summary.incomplete.length} score sheets were incomplete.`}</p>}
      <DataState query={q}>{(cards) => cards.length === 0 ? <Panel><EmptyState title="Nothing processed yet" icon="target">Once teachers have entered scores, choose Process results to calculate totals, grades and positions.</EmptyState></Panel> : (
        <DataTable caption="Class results" rows={cards} rowKey={(c) => c.id} rule={(c) => (c.status === "PUBLISHED" ? "ok" : "warn")} columns={[
          { key: "p", header: "Position", cell: (c) => (c.position ? ordinal(c.position) : "—") },
          { key: "n", header: "Student", cell: (c) => <strong>{c.student.lastName}, {c.student.firstName}</strong> },
          { key: "a", header: "Admission no.", className: "hidden md:table-cell", cell: (c) => <span className="num">{c.student.admissionNumber}</span> },
          { key: "t", header: "Total", align: "right", cell: (c) => c.totalScore },
          { key: "v", header: "Average", align: "right", cell: (c) => pct(Number(c.average), 2) },
          { key: "s", header: "Status", cell: (c) => <StatusBadge status={c.status} /> },
          { key: "x", header: "", cell: (c) => <div className="flex gap-3"><Remarks card={c} onSaved={q.reload} /><a className="font-bold text-brand-700 underline" href={`/api/results/students/${c.studentId}/report-card.pdf?termId=${termId}`}>PDF</a></div> },
        ]} />
      )}</DataState>
      <ConfirmDialog open={dlg === "publish"} onClose={() => setDlg(null)} title="Publish these results?" confirmLabel="Publish to parents" pending={publish.pending} onConfirm={() => void publish.run()} body={`${drafts} report card${drafts === 1 ? "" : "s"} will become visible to parents and students, and guardians will be notified. Scores are frozen until you withdraw them.`}><ErrorNote error={publish.error} /></ConfirmDialog>
      <ConfirmDialog open={dlg === "withdraw"} onClose={() => setDlg(null)} title="Withdraw published results?" danger confirmLabel="Withdraw" pending={withdraw.pending} onConfirm={() => void withdraw.run()} body="Parents will no longer see them. You can correct scores and publish again."><div className="mt-3"><Field label="Reason (recorded in the audit log)" htmlFor="wr"><Textarea id="wr" value={reason} onChange={(e) => setReason(e.target.value)} /></Field><ErrorNote error={withdraw.error} /></div></ConfirmDialog>
      <Dialog open={dlg === "incomplete"} onClose={() => setDlg(null)} title="Some score sheets are incomplete" wide footer={<><Button variant="secondary" onClick={() => setDlg(null)}>Go back and fix</Button><Button onClick={() => { setDlg(null); void processM.run(true); }}>Process anyway (blank scores count as 0)</Button></>}>
        <p className="mb-3 text-ink-700">These students are missing scores. Processing anyway treats a missing score as zero.</p>
        <ul className="max-h-64 space-y-1 overflow-y-auto">{summary?.incomplete.slice(0, 40).map((i, k) => <li key={k}><strong>{i.student}</strong>, {i.subject} — missing {i.missing.join(", ")}</li>)}</ul>
      </Dialog>
    </div>
  );
}

function Remarks({ card, onSaved }: { card: Card; onSaved: () => void }) {
  const [open, setOpen] = useState(false); const [t, setT] = useState(card.teacherRemark ?? ""); const [p, setP] = useState(card.principalRemark ?? "");
  const save = useMutation(async () => { await api.patch(`/results/report-cards/${card.id}/remarks`, { version: card.version, teacherRemark: t || null, principalRemark: p || null }); setOpen(false); onSaved(); });
  if (card.status === "PUBLISHED") return null;
  return (<><button className="cursor-pointer font-bold text-brand-700 underline" onClick={() => setOpen(true)}>Remarks</button>
    <Dialog open={open} onClose={() => setOpen(false)} title={`Remarks — ${card.student.firstName} ${card.student.lastName}`} footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={save.pending} onClick={() => void save.run()}>Save</Button></>}>
      <div className="space-y-4"><Field label="Class teacher's remark" htmlFor="tr"><Textarea id="tr" value={t} onChange={(e) => setT(e.target.value)} maxLength={500} /></Field><Field label="Principal's remark" htmlFor="pr"><Textarea id="pr" value={p} onChange={(e) => setP(e.target.value)} maxLength={500} /></Field><ErrorNote error={save.error} /></div>
    </Dialog></>);
}

interface Preview { class: string; nextClass: string | null; minimumAverage: number; students: { studentId: string; name: string; admissionNumber: string; average: number | null; decision: string | null; reason: string }[] }
function Promotion({ classId }: { classId: string }) {
  const years = useApi<{ id: string; name: string; isCurrent: boolean }[]>("/academics/years");
  const [yearId, setYearId] = useState(""); const [nextId, setNextId] = useState("");
  const q = useApi<Preview>(yearId ? `/results/promotion/preview?classId=${classId}&academicYearId=${yearId}` : null);
  const [choice, setChoice] = useState<Record<string, string>>({}); const toast = useToast();
  const apply = useMutation(async () => {
    const decisions = (q.data?.students ?? []).filter((s) => choice[s.studentId] ?? s.decision).map((s) => ({ studentId: s.studentId, decision: choice[s.studentId] ?? s.decision }));
    const r = await api.post<{ promoted: number; repeated: number; graduated: number }>("/results/promotion/apply", { classId, academicYearId: yearId, nextAcademicYearId: nextId, decisions });
    toast.push("ok", `${r.promoted} promoted, ${r.repeated} repeating, ${r.graduated} graduated`); q.reload();
  });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Year just ended" htmlFor="py"><select id="py" className="min-h-11 rounded-md border border-ink-300 bg-surface px-3" value={yearId} onChange={(e) => setYearId(e.target.value)}><option value="">Choose…</option>{years.data?.map((y) => <option key={y.id} value={y.id}>{y.name}</option>)}</select></Field>
        <Field label="Move students into" htmlFor="pn"><select id="pn" className="min-h-11 rounded-md border border-ink-300 bg-surface px-3" value={nextId} onChange={(e) => setNextId(e.target.value)}><option value="">Choose…</option>{years.data?.filter((y) => y.id !== yearId).map((y) => <option key={y.id} value={y.id}>{y.name}</option>)}</select></Field>
      </div>
      {q.data && <p className="text-ink-700">{q.data.class} → {q.data.nextClass ?? "graduation"} · minimum average {q.data.minimumAverage}%. Suggestions come from published results; you can change any decision.</p>}
      <DataState query={q}>{(d) => (<>
        <DataTable rows={d.students} rowKey={(s) => s.studentId} rule={(s) => ((choice[s.studentId] ?? s.decision) === "REPEATED" ? "bad" : s.decision ? "ok" : "warn")} columns={[{ key: "n", header: "Student", cell: (s) => <strong>{s.name}</strong> }, { key: "a", header: "Year average", align: "right", cell: (s) => (s.average === null ? "—" : pct(s.average, 2)) }, { key: "d", header: "Decision", cell: (s) => <select aria-label={`Decision for ${s.name}`} className="min-h-11 rounded-md border border-ink-300 bg-surface px-2" value={choice[s.studentId] ?? s.decision ?? ""} onChange={(e) => setChoice({ ...choice, [s.studentId]: e.target.value })}><option value="">No decision</option>{["PROMOTED", "REPEATED", "GRADUATED", "WITHDRAWN"].map((x) => <option key={x} value={x}>{x[0] + x.slice(1).toLowerCase()}</option>)}</select> }, { key: "r", header: "Why", className: "hidden md:table-cell", cell: (s) => <span className="text-ink-500">{s.reason}</span> }]} />
        <Button loading={apply.pending} disabled={!nextId} onClick={() => void apply.run()} icon="check">Apply promotions</Button><ErrorNote error={apply.error} />
      </>)}</DataState>
    </div>
  );
}

interface Grade { scheme: { name: string; positionMethod: string }; bands: { grade: string; minScore: number; maxScore: number; remark: string | null; isPass: boolean }[]; components: { code: string; name: string; maxScore: number; isExam: boolean }[]; problems: string[] }
function Grading() {
  const q = useApi<Grade>("/results/grading");
  return <DataState query={q}>{(g) => (
    <div className="grid gap-6 lg:grid-cols-2">
      <Panel title="Score columns" padded={false}><DataTable compact rows={g.components} rowKey={(c) => c.code} columns={[{ key: "n", header: "Column", cell: (c) => `${c.name} (${c.code})` }, { key: "m", header: "Out of", align: "right", cell: (c) => c.maxScore }, { key: "e", header: "Type", cell: (c) => (c.isExam ? <Badge tone="brand">Exam</Badge> : "Continuous assessment") }]} /></Panel>
      <Panel title="Grade bands" padded={false}><DataTable compact rows={g.bands} rowKey={(b) => b.grade} rule={(b) => (b.isPass ? undefined : "bad")} columns={[{ key: "g", header: "Grade", cell: (b) => <strong>{b.grade}</strong> }, { key: "r", header: "Score range", cell: (b) => `${b.minScore} – ${b.maxScore}` }, { key: "m", header: "Remark", cell: (b) => b.remark ?? "—" }]} /></Panel>
      <p className="text-ink-500 lg:col-span-2">Positions use “{g.scheme.positionMethod === "DENSE" ? "dense" : "standard competition"}” ranking. Each school's grading is its own: to change bands or columns, ask an administrator with the grading permission (changes are blocked once results are published).</p>
    </div>
  )}</DataState>;
}
