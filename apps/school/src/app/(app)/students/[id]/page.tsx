"use client";
import { use, useState } from "react";
import { api, useApi, useMutation } from "@/lib/api";
import { date, dateTime, fullName, money, ordinal, pct } from "@/lib/format";
import { Badge, Button, ConfirmDialog, DataState, Dialog, EmptyState, ErrorNote, PageHeader, Panel, Select, StatusBadge, TabPanel, Tabs, TextField, useToast, Field, Textarea } from "@/ui/kit";
import { Can, useSession } from "@/ui/session";
import { DataTable } from "@/ui/table";
import { QrCode } from "@/ui/qr";

interface Student {
  id: string; admissionNumber: string; firstName: string; middleName: string | null; lastName: string; gender: string; dateOfBirth: string | null; stateOfOrigin: string | null; lga: string | null; religion: string | null; bloodGroup: string | null; genotype: string | null; address: string | null; phone: string | null; medicalNotes: string | null; status: string; version: number;
  guardians: { id: string; relationship: string; isPrimary: boolean; parent: { id: string; firstName: string; lastName: string; phone: string | null; email: string | null } }[];
  enrollments: { id: string; status: string; class: { name: string }; section: { name: string } | null; academicYear: { name: string } }[];
  statusHistory: { id: string; fromStatus: string | null; toStatus: string; reason: string | null; changedAt: string }[];
}
type Tab = "profile" | "attendance" | "results" | "fees" | "cbt";

export default function StudentDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const s = useApi<Student>(`/students/${id}`);
  const { can, hasModule } = useSession();
  const [tab, setTab] = useState<Tab>("profile");
  const [dlg, setDlg] = useState<"status" | "archive" | "qr" | null>(null);
  const toast = useToast();
  const [status, setStatus] = useState("SUSPENDED"); const [reason, setReason] = useState("");
  const change = useMutation(async () => { await api.post(`/students/${id}/status`, { status, reason: reason || undefined }); toast.push("ok", "Status updated"); setDlg(null); s.reload(); });
  const archive = useMutation(async () => { await api.del(`/students/${id}`); toast.push("ok", "Student archived"); history.back(); });

  const tabs: { id: Tab; label: string }[] = [{ id: "profile", label: "Profile" }, ...(hasModule("attendance") ? [{ id: "attendance" as Tab, label: "Attendance" }] : []), ...(hasModule("results") && can("results.view") ? [{ id: "results" as Tab, label: "Results" }] : []), ...(hasModule("finance") && can("finance.view") ? [{ id: "fees" as Tab, label: "Fees" }] : []), ...(hasModule("cbt") && can("cbt.review_attempt") ? [{ id: "cbt" as Tab, label: "CBT & practice" }] : [])];

  return (
    <DataState query={s}>{(st) => (
      <>
        <PageHeader title={fullName(st)} description={`${st.admissionNumber} · ${st.enrollments[0] ? `${st.enrollments[0].class.name}${st.enrollments[0].section ? ` ${st.enrollments[0].section.name}` : ""}` : "Not enrolled"}`}
          actions={<><StatusBadge status={st.status} /><Button variant="secondary" icon="qr" onClick={() => setDlg("qr")}>ID card</Button><Can perm={["students.edit"]}><Button variant="secondary" onClick={() => setDlg("status")}>Change status</Button></Can><Can perm={["students.delete"]}><Button variant="ghost" icon="trash" onClick={() => setDlg("archive")}>Archive</Button></Can></>} />
        <Tabs tabs={tabs} value={tab} onChange={setTab} label="Student record" />
        <TabPanel id="profile" active={tab === "profile"}>
          <div className="grid gap-6 lg:grid-cols-2">
            <Panel title="Details"><dl className="grid grid-cols-[9rem_1fr] gap-x-4 gap-y-2">
              {[["Sex", st.gender === "MALE" ? "Male" : "Female"], ["Date of birth", date(st.dateOfBirth)], ["State of origin", st.stateOfOrigin], ["LGA", st.lga], ["Religion", st.religion], ["Blood group / genotype", [st.bloodGroup, st.genotype].filter(Boolean).join(" / ") || null], ["Address", st.address], ["Phone", st.phone]].map(([k, v]) => <div key={k as string} className="contents"><dt className="text-ink-500">{k}</dt><dd>{(v as string) || "—"}</dd></div>)}
            </dl>{st.medicalNotes && <p className="mt-3 rounded bg-amber-100 p-3 text-amber-700"><strong>Medical note:</strong> {st.medicalNotes}</p>}</Panel>
            <Panel title="Parents and guardians" padded={false}>{st.guardians.length === 0 ? <EmptyState title="No guardian linked" icon="users">Add one so the family can use the parent portal.</EmptyState> : (
              <DataTable compact rows={st.guardians} rowKey={(g) => g.id} columns={[{ key: "n", header: "Name", cell: (g) => <>{g.parent.firstName} {g.parent.lastName}{g.isPrimary && <Badge tone="brand"> Primary</Badge>}</> }, { key: "r", header: "Relationship", cell: (g) => g.relationship }, { key: "p", header: "Phone", cell: (g) => <span className="num">{g.parent.phone ?? "—"}</span> }]} />)}</Panel>
            <Panel title="Enrollment" padded={false} className="lg:col-span-2"><DataTable compact rows={st.enrollments} rowKey={(e) => e.id} columns={[{ key: "y", header: "Year", cell: (e) => e.academicYear.name }, { key: "c", header: "Class", cell: (e) => `${e.class.name}${e.section ? ` ${e.section.name}` : ""}` }, { key: "s", header: "Status", cell: (e) => <StatusBadge status={e.status} /> }]} /></Panel>
            <Panel title="Status history" padded={false} className="lg:col-span-2"><DataTable compact rows={st.statusHistory} rowKey={(h) => h.id} columns={[{ key: "d", header: "When", cell: (h) => dateTime(h.changedAt) }, { key: "t", header: "Change", cell: (h) => <>{h.fromStatus ? <><StatusBadge status={h.fromStatus} /> → </> : null}<StatusBadge status={h.toStatus} /></> }, { key: "r", header: "Reason", cell: (h) => h.reason ?? "—" }]} /></Panel>
          </div>
        </TabPanel>
        <TabPanel id="attendance" active={tab === "attendance"}><AttendanceTab id={id} /></TabPanel>
        <TabPanel id="results" active={tab === "results"}><ResultsTab id={id} /></TabPanel>
        <TabPanel id="fees" active={tab === "fees"}><FeesTab id={id} /></TabPanel>
        <TabPanel id="cbt" active={tab === "cbt"}><CbtTab id={id} /></TabPanel>

        <Dialog open={dlg === "status"} onClose={() => setDlg(null)} title="Change status" footer={<><Button variant="secondary" onClick={() => setDlg(null)}>Cancel</Button><Button loading={change.pending} onClick={() => void change.run()}>Save</Button></>}>
          <div className="space-y-4"><Field label="New status" htmlFor="st"><Select id="st" value={status} onChange={(e) => setStatus(e.target.value)}>{["ACTIVE", "SUSPENDED", "WITHDRAWN", "TRANSFERRED", "GRADUATED"].filter((x) => x !== st.status).map((x) => <option key={x} value={x}>{x[0] + x.slice(1).toLowerCase()}</option>)}</Select></Field>
            <Field label="Reason" htmlFor="rs"><Textarea id="rs" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Recorded in the student's history" /></Field><ErrorNote error={change.error} /></div>
        </Dialog>
        <ConfirmDialog open={dlg === "archive"} onClose={() => setDlg(null)} title="Archive this student?" danger confirmLabel="Archive" pending={archive.pending} onConfirm={() => void archive.run()} body="The record is hidden from lists and the student can no longer sign in. Their history (results, payments, attendance) is kept."><ErrorNote error={archive.error} /></ConfirmDialog>
        <Dialog open={dlg === "qr"} onClose={() => setDlg(null)} title="Attendance ID card" footer={<Button icon="print" onClick={() => window.print()}>Print</Button>}><IdCard id={id} name={fullName(st)} adm={st.admissionNumber} cls={st.enrollments[0]?.class.name ?? ""} /></Dialog>
      </>
    )}</DataState>
  );
}

function IdCard({ id, name, adm, cls }: { id: string; name: string; adm: string; cls: string }) {
  const q = useApi<{ token: string }>(`/students/${id}/qr`);
  return <div className="mx-auto flex w-64 flex-col items-center gap-3 rounded-lg border-2 border-ink-900 p-4 text-center"><p className="font-serif text-lg font-semibold">{name}</p><p className="num text-ink-700">{adm}</p><p className="text-ink-700">{cls}</p>{q.data ? <QrCode value={q.data.token} size={176} /> : <p className="text-ink-500">Generating…</p>}<p className="text-sm text-ink-500">Scan at the gate to mark attendance</p></div>;
}

function AttendanceTab({ id }: { id: string }) {
  const q = useApi<{ rows: { date: string; status: string; checkedInAt: string | null; method: string }[]; summary: { present: number; late: number; absent: number; excused: number; total: number; rate: number | null } }>(`/attendance/students/${id}`);
  return <DataState query={q}>{(d) => (
    <div className="space-y-4"><p className="num text-lg">Attendance rate <strong>{pct(d.summary.rate)}</strong> · {d.summary.present} present · {d.summary.late} late · {d.summary.absent} absent · {d.summary.excused} excused</p>
      {d.rows.length === 0 ? <Panel><EmptyState title="No attendance recorded" icon="check" /></Panel> : <DataTable compact rows={d.rows} rowKey={(r) => r.date} rule={(r) => (r.status === "ABSENT" ? "bad" : r.status === "LATE" ? "warn" : "ok")} columns={[{ key: "d", header: "Date", cell: (r) => date(r.date) }, { key: "s", header: "Status", cell: (r) => <StatusBadge status={r.status} /> }, { key: "m", header: "Recorded by", cell: (r) => r.method.toLowerCase() }, { key: "t", header: "Arrival", cell: (r) => (r.checkedInAt ? dateTime(r.checkedInAt) : "—") }]} />}</div>
  )}</DataState>;
}

function ResultsTab({ id }: { id: string }) {
  const q = useApi<{ termId: string; average: string; position: number | null; classSize: number | null; status: string; term: { name: string; academicYear: { name: string } } }[]>(`/results/students/${id}/terms`);
  return <DataState query={q}>{(d) => d.length === 0 ? <Panel><EmptyState title="No results yet" icon="target" /></Panel> : <DataTable rows={d} rowKey={(r) => r.termId} columns={[{ key: "t", header: "Term", cell: (r) => `${r.term.academicYear.name} · ${r.term.name}` }, { key: "a", header: "Average", align: "right", cell: (r) => pct(Number(r.average)) }, { key: "p", header: "Position", cell: (r) => (r.position ? `${ordinal(r.position)} of ${r.classSize}` : "—") }, { key: "s", header: "Status", cell: (r) => <StatusBadge status={r.status} /> }, { key: "x", header: "", cell: (r) => <a className="font-bold text-brand-700 underline" href={`/api/results/students/${id}/report-card.pdf?termId=${r.termId}`}>Report card (PDF)</a> }]} />}</DataState>;
}

function FeesTab({ id }: { id: string }) {
  const q = useApi<{ outstanding: string; credit: string; invoices: { id: string; number: string; status: string; total: string; amountPaid: string; dueDate: string | null; term: { name: string } | null }[]; payments: { id: string; receiptNumber: string; amount: string; method: string; status: string; receivedAt: string }[] }>(`/finance/students/${id}/statement`);
  return <DataState query={q}>{(d) => (
    <div className="space-y-6"><p className="num text-lg">Outstanding <strong className={Number(d.outstanding) > 0 ? "text-pen-700" : "text-leaf-700"}>{money(d.outstanding)}</strong>{Number(d.credit) > 0 && <> · Credit on account <strong>{money(d.credit)}</strong></>}</p>
      <Panel title="Invoices" padded={false}>{d.invoices.length === 0 ? <EmptyState title="No invoices" icon="wallet" /> : <DataTable compact rows={d.invoices} rowKey={(i) => i.id} rule={(i) => (i.status === "PAID" ? "ok" : i.dueDate && new Date(i.dueDate) < new Date() && i.status !== "VOID" ? "bad" : "warn")} columns={[{ key: "n", header: "Invoice", cell: (i) => <span className="num">{i.number}</span> }, { key: "t", header: "Term", cell: (i) => i.term?.name ?? "—" }, { key: "d", header: "Due", cell: (i) => date(i.dueDate) }, { key: "a", header: "Total", align: "right", cell: (i) => money(i.total) }, { key: "p", header: "Paid", align: "right", cell: (i) => money(i.amountPaid) }, { key: "s", header: "Status", cell: (i) => <StatusBadge status={i.status} /> }]} />}</Panel>
      <Panel title="Payments" padded={false}>{d.payments.length === 0 ? <EmptyState title="No payments yet" icon="wallet" /> : <DataTable compact rows={d.payments} rowKey={(p) => p.id} rule={(p) => (p.status === "REVERSED" ? "bad" : "ok")} columns={[{ key: "r", header: "Receipt", cell: (p) => <span className="num">{p.receiptNumber}</span> }, { key: "d", header: "Date", cell: (p) => date(p.receivedAt) }, { key: "m", header: "Method", cell: (p) => p.method.replace("_", " ").toLowerCase() }, { key: "a", header: "Amount", align: "right", cell: (p) => money(p.amount) }, { key: "s", header: "Status", cell: (p) => <StatusBadge status={p.status} /> }]} />}</Panel></div>
  )}</DataState>;
}

function CbtTab({ id }: { id: string }) {
  const q = useApi<{ recent: { attemptId: string; title: string; examBody: string; percentage: number }[]; weakTopics: { topic: string; subject: string; accuracy: number; attempted: number }[] }>(`/cbt/students/${id}/progress`);
  return <DataState query={q}>{(d) => (
    <div className="grid gap-6 lg:grid-cols-2"><Panel title="Recent results" padded={false}>{d.recent.length === 0 ? <EmptyState title="No CBT results" icon="grid" /> : <DataTable compact rows={d.recent} rowKey={(r) => r.attemptId} columns={[{ key: "t", header: "Exam", cell: (r) => r.title }, { key: "p", header: "Score", align: "right", cell: (r) => pct(r.percentage) }]} />}</Panel>
      <Panel title="Topics to revise" padded={false}>{d.weakTopics.length === 0 ? <EmptyState title="Not enough practice yet" icon="target" /> : <DataTable compact rows={d.weakTopics} rowKey={(r) => r.topic} rule={(r) => (r.accuracy < 50 ? "bad" : "warn")} columns={[{ key: "t", header: "Topic", cell: (r) => `${r.subject} — ${r.topic}` }, { key: "a", header: "Accuracy", align: "right", cell: (r) => pct(r.accuracy, 0) }]} />}</Panel></div>
  )}</DataState>;
}
