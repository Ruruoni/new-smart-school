"use client";
import { useState } from "react";
import { api, useApi, useMutation } from "@/lib/api";
import { date, money, today } from "@/lib/format";
import { Button, DataState, Dialog, EmptyState, ErrorNote, Field, PageHeader, Panel, SelectField, StatusBadge, TextField, Textarea, useToast } from "@/ui/kit";
import { useReadOnly } from "@/ui/session";
import { DataTable } from "@/ui/table";

interface Exp { id: string; number: string; category: string; description: string; vendor: string | null; amount: string; paidOn: string; status: string }
const CATS = ["Salaries", "Utilities", "Maintenance", "Stationery", "Transport", "Events", "Fuel & power", "Other"];

export default function Expenses() {
  const q = useApi<Exp[]>("/finance/expenses"); const toast = useToast(); const ro = useReadOnly();
  const [open, setOpen] = useState(false); const [voidId, setVoidId] = useState<string | null>(null); const [reason, setReason] = useState("");
  const [f, setF] = useState({ category: "Utilities", description: "", vendor: "", amount: "", paidOn: today(), method: "CASH" });
  const add = useMutation(async () => { await api.post("/finance/expenses", { ...f, vendor: f.vendor || undefined, amount: Number(f.amount) }); toast.push("ok", "Expense recorded"); setOpen(false); setF({ ...f, description: "", vendor: "", amount: "" }); q.reload(); });
  const voidM = useMutation(async () => { await api.post(`/finance/expenses/${voidId}/void`, { reason }); toast.push("ok", "Expense voided"); setVoidId(null); setReason(""); q.reload(); });
  return (<>
    <PageHeader title="Expenses" description="Money the school spends. Voiding keeps the original entry on record." actions={<Button icon="plus" disabled={ro} onClick={() => setOpen(true)}>Record expense</Button>} />
    <DataState query={q}>{(d) => d.length === 0 ? <Panel><EmptyState title="No expenses recorded" icon="wallet" /></Panel> : <DataTable rows={d} rowKey={(e) => e.id} rule={(e) => (e.status === "VOIDED" ? "bad" : undefined)} columns={[{ key: "n", header: "No.", cell: (e) => <span className="num">{e.number}</span> }, { key: "d", header: "Date", cell: (e) => date(e.paidOn) }, { key: "c", header: "Category", cell: (e) => e.category }, { key: "x", header: "Description", cell: (e) => `${e.description}${e.vendor ? ` — ${e.vendor}` : ""}` }, { key: "a", header: "Amount", align: "right", cell: (e) => money(e.amount) }, { key: "s", header: "Status", cell: (e) => <StatusBadge status={e.status} /> }, { key: "v", header: "", cell: (e) => (e.status === "POSTED" ? <Button size="sm" variant="ghost" disabled={ro} onClick={() => setVoidId(e.id)}>Void</Button> : null) }]} />}</DataState>
    <Dialog open={open} onClose={() => setOpen(false)} title="Record an expense" footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={add.pending} disabled={!f.description || !(Number(f.amount) > 0)} onClick={() => void add.run()}>Save</Button></>}>
      <div className="space-y-4"><SelectField label="Category" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{CATS.map((c) => <option key={c}>{c}</option>)}</SelectField><TextField label="Description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} required /><TextField label="Paid to (optional)" value={f.vendor} onChange={(e) => setF({ ...f, vendor: e.target.value })} /><div className="grid gap-4 sm:grid-cols-2"><TextField label="Amount (₦)" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} required /><TextField label="Date paid" type="date" value={f.paidOn} max={today()} onChange={(e) => setF({ ...f, paidOn: e.target.value })} /></div><ErrorNote error={add.error} /></div>
    </Dialog>
    <Dialog open={!!voidId} onClose={() => setVoidId(null)} title="Void this expense?" footer={<><Button variant="secondary" onClick={() => setVoidId(null)}>Cancel</Button><Button variant="danger" loading={voidM.pending} disabled={reason.trim().length < 3} onClick={() => void voidM.run()}>Void</Button></>}><Field label="Reason" htmlFor="ev" required><Textarea id="ev" value={reason} onChange={(e) => setReason(e.target.value)} /></Field><div className="mt-3"><ErrorNote error={voidM.error} /></div></Dialog>
  </>);
}
