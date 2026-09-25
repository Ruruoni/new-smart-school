"use client";
import { useState } from "react";
import Link from "next/link";
import { api, qs, useApi, useMutation } from "@/lib/api";
import { date, money } from "@/lib/format";
import { Button, DataState, Dialog, EmptyState, ErrorNote, Field, PageHeader, Pagination, Panel, SearchBox, SelectField, Stat, StatusBadge, TextField, Textarea, useToast, Tabs, TabPanel, Checkbox } from "@/ui/kit";
import { Can, useReadOnly, useSession } from "@/ui/session";
import { DataTable } from "@/ui/table";
import { TermSelect, ClassSelect } from "@/ui/pickers";

interface Summary { billed: string; discounts: string; netRevenue: string; expenses: string; cashCollected: string; outstanding: string; collectionRate: number | null }
interface Payment { id: string; studentId: string | null; receiptNumber: string; amount: string; method: string; status: string; receivedAt: string; payerName: string | null; student: { firstName: string; lastName: string; admissionNumber: string } | null }
type Tab = "payments" | "fees" | "policy";

export default function Finance() {
  const { can } = useSession();
  const sum = useApi<Summary>(can("finance.reports") ? "/finance/summary" : null);
  const [tab, setTab] = useState<Tab>("payments");
  const [record, setRecord] = useState(false);
  const readOnly = useReadOnly();
  const [page, setPage] = useState(1);
  const pays = useApi<{ items: Payment[]; total: number; page: number; pageSize: number }>(`/finance/payments${qs({ page })}`);
  const [reverse, setReverse] = useState<Payment | null>(null);
  return (
    <>
      <PageHeader title="Fees and payments" description="Invoices, receipts and balances. Nothing here is ever edited or deleted — corrections are recorded as reversals." actions={<Can perm={["finance.create_payment"]}><Button icon="plus" disabled={readOnly} onClick={() => setRecord(true)}>Record payment</Button></Can>} />
      {sum.data && <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4"><Stat label="Billed this year" value={money(sum.data.billed, true)} note={`${money(sum.data.discounts, true)} in discounts`} /><Stat label="Collected" value={money(sum.data.cashCollected, true)} note={sum.data.collectionRate != null ? `${sum.data.collectionRate}% of billed` : undefined} tone="ok" /><Stat label="Outstanding" value={money(sum.data.outstanding, true)} tone={Number(sum.data.outstanding) > 0 ? "bad" : "ok"} /><Stat label="Expenses" value={money(sum.data.expenses, true)} /></div>}
      <Tabs label="Finance sections" value={tab} onChange={setTab} tabs={[{ id: "payments", label: "Payments" }, ...(can("finance.manage_fees") || can("finance.create_invoice") ? [{ id: "fees" as Tab, label: "Fees & billing" }] : []), ...(can("finance.configure_lockout") ? [{ id: "policy" as Tab, label: "Result lockout" }] : [])]} />
      <TabPanel id="payments" active={tab === "payments"}>
        <DataState query={pays}>{(d) => d.items.length === 0 ? <Panel><EmptyState title="No payments recorded" icon="wallet" /></Panel> : (<>
          <DataTable caption="Payments" rows={d.items} rowKey={(p) => p.id} rule={(p) => (p.status === "REVERSED" ? "bad" : "ok")} columns={[
            { key: "r", header: "Receipt", cell: (p) => <span className="num font-bold">{p.receiptNumber}</span> }, { key: "d", header: "Date", cell: (p) => date(p.receivedAt) },
            { key: "s", header: "Paid by / for", cell: (p) => (p.student ? <Link className="text-brand-800 hover:underline" href={`/students/${p.studentId}`}>{p.student.firstName} {p.student.lastName}</Link> : p.payerName ?? "—") },
            { key: "m", header: "Method", className: "hidden md:table-cell", cell: (p) => p.method.replace("_", " ").toLowerCase() }, { key: "a", header: "Amount", align: "right", cell: (p) => money(p.amount) }, { key: "st", header: "Status", cell: (p) => <StatusBadge status={p.status} /> },
            { key: "x", header: "", cell: (p) => p.status === "POSTED" && can("finance.reverse_payment") ? <Button size="sm" variant="ghost" disabled={readOnly} onClick={() => setReverse(p)}>Reverse</Button> : null },
          ]} />
          <Pagination page={d.page} pageSize={d.pageSize} total={d.total} onPage={setPage} /></>
        )}</DataState>
      </TabPanel>
      <TabPanel id="fees" active={tab === "fees"}><FeesAndBilling /></TabPanel>
      <TabPanel id="policy" active={tab === "policy"}><LockoutPolicy /></TabPanel>
      <RecordPayment open={record} onClose={() => setRecord(false)} onDone={() => { setRecord(false); pays.reload(); sum.reload(); }} />
      <ReverseDialog payment={reverse} onClose={() => setReverse(null)} onDone={() => { setReverse(null); pays.reload(); sum.reload(); }} />
    </>
  );
}

function ReverseDialog({ payment, onClose, onDone }: { payment: Payment | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState(""); const toast = useToast();
  const run = useMutation(async () => { await api.post(`/finance/payments/${payment!.id}/reverse`, { reason }); toast.push("ok", "Payment reversed — the original stays on record"); setReason(""); onDone(); });
  return <Dialog open={!!payment} onClose={onClose} title={`Reverse receipt ${payment?.receiptNumber ?? ""}?`} footer={<><Button variant="secondary" onClick={onClose}>Keep payment</Button><Button variant="danger" loading={run.pending} disabled={reason.trim().length < 3} onClick={() => void run.run()}>Reverse payment</Button></>}>
    <p className="mb-3 text-ink-700">{payment && money(payment.amount)} will be taken off the student's account and the invoices it paid will show as owing again. The receipt is kept, marked as reversed.</p>
    <Field label="Reason" htmlFor="rev" required><Textarea id="rev" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: cheque bounced" /></Field><div className="mt-3"><ErrorNote error={run.error} /></div>
  </Dialog>;
}

function RecordPayment({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState(""); const [sid, setSid] = useState<{ id: string; name: string } | null>(null);
  const [amount, setAmount] = useState(""); const [method, setMethod] = useState("CASH"); const [ref, setRef] = useState(""); const [key] = useState(() => crypto.randomUUID());
  const found = useApi<{ items: { id: string; firstName: string; lastName: string; admissionNumber: string }[] }>(q.length >= 2 && !sid ? `/students${qs({ q, pageSize: 6 })}` : null);
  const st = useApi<{ outstanding: string; credit: string; invoices: { id: string; number: string; status: string; total: string; amountPaid: string }[] }>(sid ? `/finance/students/${sid.id}/statement` : null);
  const [receipt, setReceipt] = useState<{ receiptNumber: string; allocated: number } | null>(null);
  const pay = useMutation(async () => { const r = await api.post<{ payment: { receiptNumber: string; allocations: unknown[] }; duplicate: boolean }>("/finance/payments", { studentId: sid?.id, amount: Number(amount), method, reference: ref || undefined, idempotencyKey: key }); toast.push("ok", `Receipt ${r.payment.receiptNumber} issued`); setReceipt({ receiptNumber: r.payment.receiptNumber, allocated: r.payment.allocations.length }); });
  const reset = () => { setSid(null); setQ(""); setAmount(""); setRef(""); setReceipt(null); onClose(); if (receipt) onDone(); };
  return (
    <Dialog open={open} onClose={reset} title={receipt ? "Payment recorded" : "Record a payment"} wide footer={receipt ? <Button onClick={reset}>Done</Button> : <><Button variant="secondary" onClick={reset}>Cancel</Button><Button loading={pay.pending} disabled={!sid || !(Number(amount) > 0)} onClick={() => void pay.run()}>Record payment</Button></>}>
      {receipt ? <div className="space-y-3"><p className="font-serif text-2xl">Receipt <span className="num">{receipt.receiptNumber}</span></p><p className="text-ink-700">{receipt.allocated ? `Applied to ${receipt.allocated} invoice${receipt.allocated === 1 ? "" : "s"}, oldest first.` : "No open invoices — the amount is held as credit and is applied automatically to the next invoice."}</p></div> : (
        <div className="space-y-4">
          {!sid ? <><div><SearchBox value={q} onChange={setQ} placeholder="Student name or admission number" label="Find student" />{found.data && <ul className="mt-2 divide-y divide-line rounded border border-line">{found.data.items.length === 0 && <li className="p-3 text-ink-500">No match.</li>}{found.data.items.map((s) => <li key={s.id}><button className="flex min-h-11 w-full cursor-pointer items-center justify-between px-3 text-left hover:bg-brand-50" onClick={() => setSid({ id: s.id, name: `${s.firstName} ${s.lastName}` })}><strong>{s.lastName}, {s.firstName}</strong><span className="num text-ink-500">{s.admissionNumber}</span></button></li>)}</ul>}</div></> : (
            <div className="rounded border border-line bg-paper p-3"><div className="flex items-center justify-between"><strong className="font-serif text-lg">{sid.name}</strong><button className="cursor-pointer text-sm font-bold text-brand-700 underline" onClick={() => setSid(null)}>Change</button></div>
              {st.data && <p className="num mt-1">Owes <strong className={Number(st.data.outstanding) > 0 ? "text-pen-700" : "text-leaf-700"}>{money(st.data.outstanding)}</strong>{Number(st.data.credit) > 0 && <> · credit {money(st.data.credit)}</>}</p>}</div>)}
          <div className="grid gap-4 sm:grid-cols-2"><TextField label="Amount (₦)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required /><SelectField label="Method" value={method} onChange={(e) => setMethod(e.target.value)}>{[["CASH", "Cash"], ["BANK_TRANSFER", "Bank transfer"], ["POS", "POS"], ["CHEQUE", "Cheque"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</SelectField></div>
          <TextField label="Reference" value={ref} onChange={(e) => setRef(e.target.value)} hint="Bank teller number, POS slip…" />
          <ErrorNote error={pay.error} />
        </div>)}
    </Dialog>
  );
}

function FeesAndBilling() {
  const { can } = useSession(); const toast = useToast();
  const fees = useApi<{ id: string; name: string; version: number; isActive: boolean; class: { name: string } | null; term: { name: string } | null; items: { id: string; name: string; amount: string; isOptional: boolean }[] }[]>("/finance/fee-structures");
  const [termId, setTermId] = useState(""); const [classId, setClassId] = useState("");
  const bill = useMutation(async () => { const r = await api.post<{ created: number; skipped: { reason: string }[] }>("/finance/invoices/generate-class", { classId, termId }); toast.push(r.created ? "ok" : "info", `${r.created} invoice${r.created === 1 ? "" : "s"} issued${r.skipped.length ? `, ${r.skipped.length} skipped (${[...new Set(r.skipped.map((s) => s.reason))][0]})` : ""}`); });
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-6">
      {can("finance.create_invoice") && <Panel title="Bill a class"><p className="mb-3 text-ink-700">Issues one invoice per enrolled student from the matching fee structures, applying any discounts and scholarships. Students already billed this term are skipped.</p><div className="flex flex-wrap items-center gap-3"><TermSelect value={termId} onChange={setTermId} /><ClassSelect value={classId} onChange={setClassId} /><Button loading={bill.pending} disabled={!termId || !classId} onClick={() => void bill.run()}>Issue invoices</Button></div><div className="mt-3"><ErrorNote error={bill.error} /></div></Panel>}
      <Panel title="Fee structures" actions={can("finance.manage_fees") && <Button size="sm" icon="plus" onClick={() => setOpen(true)}>New fee structure</Button>} padded={false}>
        <DataState query={fees}>{(d) => d.length === 0 ? <EmptyState title="No fee structures" icon="wallet">Create one for each class and term, listing tuition and other charges.</EmptyState> : <DataTable rows={d} rowKey={(f) => f.id} columns={[{ key: "n", header: "Name", cell: (f) => <strong>{f.name}</strong> }, { key: "t", header: "Applies to", cell: (f) => `${f.class?.name ?? "All classes"} · ${f.term?.name ?? "Any term"}` }, { key: "i", header: "Items", cell: (f) => f.items.map((i) => `${i.name} ${money(i.amount, true)}${i.isOptional ? " (optional)" : ""}`).join(", ") }, { key: "s", header: "Total", align: "right", cell: (f) => money(f.items.filter((i) => !i.isOptional).reduce((s, i) => s + Number(i.amount), 0), true) }]} />}</DataState>
      </Panel>
      <NewFeeStructure open={open} onClose={() => setOpen(false)} onDone={() => { setOpen(false); fees.reload(); }} />
    </div>
  );
}

function NewFeeStructure({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(""); const [termId, setTermId] = useState(""); const [classId, setClassId] = useState("");
  const [items, setItems] = useState([{ name: "Tuition", amount: "", isOptional: false }]);
  const save = useMutation(async () => { await api.post("/finance/fee-structures", { name, termId: termId || null, classId: classId || null, items: items.filter((i) => i.name && i.amount).map((i) => ({ name: i.name, amount: Number(i.amount), isOptional: i.isOptional })) }); onDone(); });
  return <Dialog open={open} onClose={onClose} wide title="New fee structure" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.pending} disabled={name.length < 2 || !items.some((i) => i.name && Number(i.amount) > 0)} onClick={() => void save.run()}>Save</Button></>}>
    <div className="space-y-4"><TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="JSS 1 — First term" required />
      <div className="flex flex-wrap gap-3"><Field label="Term (optional)" htmlFor="fs-term"><TermSelect value={termId} onChange={setTermId} /></Field><Field label="Class (optional)" htmlFor="fs-class"><ClassSelect value={classId} onChange={setClassId} allowAll /></Field></div>
      <fieldset><legend className="mb-2 font-bold">Charges</legend><div className="space-y-2">{items.map((it, i) => <div key={i} className="grid grid-cols-[1fr_9rem_auto] items-center gap-2"><input aria-label="Item name" className="min-h-11 rounded-md border border-ink-300 px-3" value={it.name} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="Item" /><input aria-label="Amount" inputMode="decimal" className="num min-h-11 rounded-md border border-ink-300 px-3 text-right" value={it.amount} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} placeholder="₦" /><Checkbox label="Optional" checked={it.isOptional} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, isOptional: e.target.checked } : x)))} /></div>)}</div><Button variant="ghost" size="sm" icon="plus" className="mt-2" onClick={() => setItems([...items, { name: "", amount: "", isOptional: false }])}>Add charge</Button></fieldset>
      <ErrorNote error={save.error} /></div>
  </Dialog>;
}

function LockoutPolicy() {
  const q = useApi<{ enabled: boolean; graceDays: number; minimumOutstanding: number; message: string }>("/settings/policies/finance.lockout");
  const toast = useToast();
  const [v, setV] = useState<{ enabled: boolean; graceDays: number; minimumOutstanding: number; message: string } | null>(null);
  const cur = v ?? q.data;
  const save = useMutation(async () => { await api.put("/settings/policies/finance.lockout", cur); toast.push("ok", "Policy saved"); setV(null); q.reload(); });
  return <DataState query={q}>{() => cur && (
    <Panel title="Hold results back for unpaid fees"><div className="max-w-xl space-y-4">
      <p className="text-ink-700">When switched on, parents and students cannot open report cards while a student has overdue fees. The school server enforces this — hiding a button would not be enough. Staff are never affected.</p>
      <Checkbox label="Hold results back when fees are overdue" checked={cur.enabled} onChange={(e) => setV({ ...cur, enabled: e.target.checked })} />
      <div className="grid gap-4 sm:grid-cols-2"><TextField label="Grace period (days after due date)" type="number" min={0} value={cur.graceDays} onChange={(e) => setV({ ...cur, graceDays: Number(e.target.value) })} /><TextField label="Ignore balances up to (₦)" type="number" min={0} value={cur.minimumOutstanding} onChange={(e) => setV({ ...cur, minimumOutstanding: Number(e.target.value) })} /></div>
      <Field label="Message shown to parents" htmlFor="lm"><Textarea id="lm" value={cur.message} onChange={(e) => setV({ ...cur, message: e.target.value })} placeholder="Please visit the bursary to settle outstanding fees." /></Field>
      <ErrorNote error={save.error} /><Button loading={save.pending} disabled={!v} onClick={() => void save.run()}>Save policy</Button></div></Panel>
  )}</DataState>;
}
