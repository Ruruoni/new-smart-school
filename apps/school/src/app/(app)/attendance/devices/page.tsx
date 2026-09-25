"use client";
import { useState } from "react";
import { api, useApi, useMutation } from "@/lib/api";
import { ago } from "@/lib/format";
import { Button, DataState, Dialog, EmptyState, FormError, PageHeader, Panel, SelectField, StatusBadge, TextField, useToast } from "@/ui/kit";
import { DataTable } from "@/ui/table";

interface Device { id: string; name: string; kind: string; location: string | null; isActive: boolean; lastSeenAt: string | null }
const KINDS = [["QR_SCANNER", "QR scanner / tablet"], ["RFID_READER", "RFID reader (premium)"], ["FINGERPRINT_READER", "Fingerprint reader (premium)"], ["TABLET", "Shared tablet"]];

export default function Devices() {
  const q = useApi<Device[]>("/attendance/devices");
  const toast = useToast();
  const [open, setOpen] = useState(false); const [f, setF] = useState({ name: "", kind: "QR_SCANNER", location: "" }); const [key, setKey] = useState<string | null>(null);
  const add = useMutation(async () => { const r = await api.post<{ apiKey: string }>("/attendance/devices", { ...f, location: f.location || undefined }); setKey(r.apiKey); setOpen(false); q.reload(); });
  const toggle = async (d: Device) => { await api.post(`/attendance/devices/${d.id}/active`, { active: !d.isActive }); toast.push("ok", d.isActive ? "Scanner disabled" : "Scanner enabled"); q.reload(); };
  return (
    <>
      <PageHeader title="Attendance scanners" description="Gate scanners send student QR scans to the school server. Scans made while the network is down are sent when it returns." actions={<Button icon="plus" onClick={() => setOpen(true)}>Register scanner</Button>} />
      <DataState query={q}>{(d) => d.length === 0 ? <Panel><EmptyState title="No scanners registered" icon="qr">Register one to get its access key.</EmptyState></Panel> : <DataTable rows={d} rowKey={(x) => x.id} rule={(x) => (x.isActive ? "ok" : "bad")} columns={[{ key: "n", header: "Name", cell: (x) => <strong>{x.name}</strong> }, { key: "k", header: "Type", cell: (x) => KINDS.find((k) => k[0] === x.kind)?.[1] ?? x.kind }, { key: "l", header: "Location", cell: (x) => x.location ?? "—" }, { key: "s", header: "Last seen", cell: (x) => ago(x.lastSeenAt) }, { key: "a", header: "Status", cell: (x) => <StatusBadge status={x.isActive ? "ACTIVE" : "DISABLED"} /> }, { key: "x", header: "", cell: (x) => <Button size="sm" variant="secondary" onClick={() => void toggle(x)}>{x.isActive ? "Disable" : "Enable"}</Button> }]} />}</DataState>
      <Dialog open={open} onClose={() => setOpen(false)} title="Register a scanner" footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={add.pending} onClick={() => void add.run()} disabled={f.name.length < 2}>Register</Button></>}>
        <div className="space-y-4"><TextField label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Main gate" /><SelectField label="Type" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</SelectField><TextField label="Location" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /><FormError error={add.error} /></div>
      </Dialog>
      <Dialog open={!!key} onClose={() => setKey(null)} title="Scanner access key" footer={<Button onClick={() => setKey(null)}>I've saved it</Button>}>
        <p>Enter this key in the scanner's settings. It is shown only once and cannot be recovered — register a new scanner if it is lost.</p><p className="num mt-3 rounded bg-paper p-3 font-bold break-all select-all">{key}</p>
      </Dialog>
    </>
  );
}
