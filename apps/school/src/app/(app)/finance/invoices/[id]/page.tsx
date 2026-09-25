"use client";
import { use, useState } from "react";
import { api, useApi, useMutation } from "@/lib/api";
import { date, dateTime, money } from "@/lib/format";
import { Button, DataState, Dialog, ErrorNote, Field, PageHeader, Panel, StatusBadge, Textarea, useToast } from "@/ui/kit";
import { Can, useReadOnly } from "@/ui/session";
import { DataTable } from "@/ui/table";

interface Inv { id: string; number: string; status: string; subtotal: string; discountTotal: string; total: string; amountPaid: string; dueDate: string | null; issuedAt: string | null; voidReason: string | null; student: { firstName: string; lastName: string; admissionNumber: string } | null; term: { name: string } | null; items: { id: string; description: string; kind: string; amount: string }[]; allocations: { id: string; amount: string; payment: { receiptNumber: string; receivedAt: string; method: string; status: string } }[] }

export default function InvoiceDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const q = useApi<Inv>(`/finance/invoices/${id}`);
  const toast = useToast(); const ro = useReadOnly();
  const [dlg, setDlg] = useState<"void" | null>(null); const [reason, setReason] = useState("");
  const issue = useMutation(async () => { await api.post(`/finance/invoices/${id}/issue`); toast.push("ok", "Invoice issued"); q.reload(); });
  const voidM = useMutation(async () => { await api.post(`/finance/invoices/${id}/void`, { reason }); toast.push("ok", "Invoice voided"); setDlg(null); q.reload(); });
  return <DataState query={q}>{(inv) => (
    <>
      <PageHeader title={`Invoice ${inv.number}`} description={inv.student ? `${inv.student.firstName} ${inv.student.lastName} · ${inv.student.admissionNumber}${inv.term ? ` · ${inv.term.name}` : ""}` : "Application fee"}
        actions={<><StatusBadge status={inv.status} />{inv.status === "DRAFT" && <Can perm={["finance.create_invoice"]}><Button loading={issue.pending} disabled={ro} onClick={() => void issue.run()}>Issue invoice</Button></Can>}{["ISSUED", "DRAFT"].includes(inv.status) && Number(inv.amountPaid) === 0 && <Can perm={["finance.void_invoice"]}><Button variant="danger" disabled={ro} onClick={() => setDlg("void")}>Void</Button></Can>}<Button variant="secondary" icon="print" onClick={() => window.print()}>Print</Button></>} />
      <ErrorNote error={issue.error} />
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Panel title="Charges" padded={false}><DataTable compact rows={inv.items} rowKey={(i) => i.id} columns={[{ key: "d", header: "Description", cell: (i) => i.description }, { key: "a", header: "Amount", align: "right", cell: (i) => <span className={Number(i.amount) < 0 ? "text-leaf-700" : ""}>{money(i.amount)}</span> }]} />
          <dl className="num ml-auto grid max-w-xs grid-cols-2 gap-1 p-4 text-right"><dt>Subtotal</dt><dd>{money(inv.subtotal)}</dd><dt>Discounts</dt><dd>−{money(inv.discountTotal)}</dd><dt className="font-bold">Total</dt><dd className="font-bold">{money(inv.total)}</dd><dt>Paid</dt><dd>{money(inv.amountPaid)}</dd><dt className="font-bold">Balance</dt><dd className={`font-bold ${Number(inv.total) - Number(inv.amountPaid) > 0 ? "text-pen-700" : "text-leaf-700"}`}>{money(Number(inv.total) - Number(inv.amountPaid))}</dd></dl></Panel>
        <div className="space-y-6"><Panel title="Dates"><dl className="grid grid-cols-2 gap-1"><dt className="text-ink-500">Issued</dt><dd>{inv.issuedAt ? dateTime(inv.issuedAt) : "—"}</dd><dt className="text-ink-500">Due</dt><dd>{date(inv.dueDate)}</dd></dl>{inv.voidReason && <p className="mt-3 rounded bg-pen-100 p-2 text-pen-700">Voided: {inv.voidReason}</p>}</Panel>
          <Panel title="Payments applied" padded={false}>{inv.allocations.length === 0 ? <p className="p-4 text-ink-500">No payments yet.</p> : <DataTable compact rows={inv.allocations} rowKey={(a) => a.id} rule={(a) => (a.payment.status === "REVERSED" ? "bad" : "ok")} columns={[{ key: "r", header: "Receipt", cell: (a) => <span className="num">{a.payment.receiptNumber}</span> }, { key: "a", header: "Amount", align: "right", cell: (a) => money(a.amount) }]} />}</Panel></div>
      </div>
      <Dialog open={dlg === "void"} onClose={() => setDlg(null)} title="Void this invoice?" footer={<><Button variant="secondary" onClick={() => setDlg(null)}>Keep invoice</Button><Button variant="danger" loading={voidM.pending} disabled={reason.trim().length < 3} onClick={() => void voidM.run()}>Void invoice</Button></>}>
        <p className="mb-3 text-ink-700">The student will no longer owe it, and the term can be billed again. The invoice stays on record.</p><Field label="Reason" htmlFor="vr" required><Textarea id="vr" value={reason} onChange={(e) => setReason(e.target.value)} /></Field><div className="mt-3"><ErrorNote error={voidM.error} /></div>
      </Dialog>
    </>
  )}</DataState>;
}
