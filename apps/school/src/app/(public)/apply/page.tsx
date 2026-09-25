"use client";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { api, useApi, useMutation } from "@/lib/api";
import { Badge, Button, DataState, ErrorNote, FormError, SelectField, TabPanel, Tabs, TextField, StatusBadge } from "@/ui/kit";
import { money } from "@/lib/format";

interface Info { open: boolean; applicationFee: number; requiredDocuments: string[]; instructions: string; school: { schoolName: string; motto: string | null; address: string | null; phone: string | null } | null; classes: { id: string; name: string }[] }
interface Submitted { applicationNumber: string; accessCode: string; applicationFee: { total: string } | null; requiredDocuments: string[] }
const DOC_LABEL: Record<string, string> = { BIRTH_CERTIFICATE: "Birth certificate", PASSPORT_PHOTO: "Passport photograph", PREVIOUS_RESULT: "Previous school result", TRANSFER_LETTER: "Transfer letter", OTHER: "Other document" };

export default function Apply() {
  const info = useApi<Info>("/public/admissions");
  const [tab, setTab] = useState<"apply" | "status">("apply");
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <header className="mb-6 border-b-2 border-ink-900 pb-4"><p className="text-ink-500">Admissions</p><h1 className="font-serif text-[2rem] leading-tight font-semibold">{info.data?.school?.schoolName ?? "School admissions"}</h1>{info.data?.school?.motto && <p className="mt-1 text-ink-700 italic">“{info.data.school.motto}”</p>}<p className="mt-2 text-ink-500">{[info.data?.school?.address, info.data?.school?.phone].filter(Boolean).join(" · ")}</p></header>
      <DataState query={info}>{(i) => !i.open ? <div className="rounded-lg border border-line bg-surface p-6"><h2 className="font-serif text-2xl">Applications are closed</h2><p className="mt-2 text-ink-700">The school is not accepting applications right now. Please check back later or contact the school office.</p></div> : (
        <><Tabs label="Admissions" value={tab} onChange={setTab} tabs={[{ id: "apply", label: "Apply for a place" }, { id: "status", label: "Check my application" }]} />
          <TabPanel id="apply" active={tab === "apply"}><ApplyForm info={i} /></TabPanel><TabPanel id="status" active={tab === "status"}><StatusCheck /></TabPanel></>
      )}</DataState>
      <p className="mt-10 text-center text-sm text-ink-500">Already a student or parent? <Link className="font-bold text-brand-700 underline" href="/login">Sign in</Link></p>
    </div>
  );
}

function ApplyForm({ info }: { info: Info }) {
  const [f, setF] = useState({ firstName: "", middleName: "", lastName: "", gender: "FEMALE", dateOfBirth: "", stateOfOrigin: "", lga: "", religion: "", address: "", previousSchool: "", desiredClassId: "", guardianName: "", guardianRelationship: "Mother", guardianPhone: "", guardianEmail: "", guardianAddress: "" });
  const [done, setDone] = useState<Submitted | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((s) => ({ ...s, [k]: e.target.value }));
  const submit = useMutation(async () => { const body = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== "")); setDone(await api.post<Submitted>("/public/admissions/apply", body)); window.scrollTo({ top: 0 }); });
  const fe = submit.error?.fieldErrors() ?? {};
  if (done) return <Documents sub={done} />;
  return (
    <form onSubmit={(e: FormEvent) => { e.preventDefault(); void submit.run(); }} className="space-y-8">
      {info.instructions && <p className="rounded-lg bg-brand-50 p-4 text-ink-800 whitespace-pre-line">{info.instructions}</p>}
      {info.applicationFee > 0 && <p className="rounded-lg bg-amber-100 p-4 text-amber-700">An application fee of <strong>{money(info.applicationFee, true)}</strong> applies. Pay at the school office and quote your application number.</p>}
      <fieldset className="space-y-4"><legend className="mb-1 font-serif text-xl font-semibold">About the child</legend>
        <div className="grid gap-4 sm:grid-cols-2"><TextField label="First name" value={f.firstName} onChange={set("firstName")} error={fe.firstName} required /><TextField label="Last name" value={f.lastName} onChange={set("lastName")} error={fe.lastName} required /></div>
        <div className="grid gap-4 sm:grid-cols-3"><TextField label="Middle name" value={f.middleName} onChange={set("middleName")} /><SelectField label="Sex" value={f.gender} onChange={set("gender")}><option value="FEMALE">Female</option><option value="MALE">Male</option></SelectField><TextField label="Date of birth" type="date" value={f.dateOfBirth} onChange={set("dateOfBirth")} error={fe.dateOfBirth} required /></div>
        <div className="grid gap-4 sm:grid-cols-2"><TextField label="State of origin" value={f.stateOfOrigin} onChange={set("stateOfOrigin")} /><TextField label="LGA" value={f.lga} onChange={set("lga")} /></div>
        <SelectField label="Class applying for" value={f.desiredClassId} onChange={set("desiredClassId")}><option value="">Not sure yet</option>{info.classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</SelectField>
        <TextField label="Previous school" value={f.previousSchool} onChange={set("previousSchool")} />
        <TextField label="Home address" value={f.address} onChange={set("address")} />
      </fieldset>
      <fieldset className="space-y-4"><legend className="mb-1 font-serif text-xl font-semibold">Parent or guardian</legend>
        <TextField label="Full name" value={f.guardianName} onChange={set("guardianName")} error={fe.guardianName} required />
        <div className="grid gap-4 sm:grid-cols-2"><SelectField label="Relationship" value={f.guardianRelationship} onChange={set("guardianRelationship")}>{["Mother", "Father", "Guardian", "Uncle", "Aunt", "Sibling"].map((r) => <option key={r}>{r}</option>)}</SelectField><TextField label="Phone" type="tel" value={f.guardianPhone} onChange={set("guardianPhone")} error={fe.guardianPhone} hint="We send updates here by SMS" required /></div>
        <TextField label="Email (optional)" type="email" value={f.guardianEmail} onChange={set("guardianEmail")} error={fe.guardianEmail} />
      </fieldset>
      <FormError error={submit.error && Object.keys(fe).length === 0 ? submit.error : null} />
      <Button type="submit" loading={submit.pending} className="w-full sm:w-auto">Submit application</Button>
    </form>
  );
}

function Documents({ sub }: { sub: Submitted }) {
  const [uploaded, setUploaded] = useState<Record<string, string>>({});
  const [err, setErr] = useState<Record<string, string>>({});
  const upload = async (kind: string, file: File) => {
    setErr((e) => ({ ...e, [kind]: "" }));
    const form = new FormData(); form.set("applicationNumber", sub.applicationNumber); form.set("accessCode", sub.accessCode); form.set("kind", kind); form.set("file", file);
    try { const r = await api.post<{ fileName: string }>("/public/admissions/documents", form); setUploaded((u) => ({ ...u, [kind]: r.fileName })); }
    catch (e) { setErr((x) => ({ ...x, [kind]: (e as Error).message })); }
  };
  return (
    <div className="space-y-6">
      <div className="rounded-lg border-2 border-ink-900 bg-surface p-5"><h2 className="font-serif text-2xl font-semibold">Application received</h2>
        <p className="mt-2 text-ink-700">Write these down — you need both to check progress or add documents later. The access code is shown only now.</p>
        <dl className="mt-3 grid grid-cols-[10rem_1fr] gap-y-2"><dt className="text-ink-500">Application number</dt><dd className="num text-xl font-bold">{sub.applicationNumber}</dd><dt className="text-ink-500">Access code</dt><dd className="num text-xl font-bold tracking-widest">{sub.accessCode}</dd></dl>
        {sub.applicationFee && <p className="mt-3 text-amber-700">Application fee: <strong>{money(sub.applicationFee.total, true)}</strong> — pay at the school office; review starts once it is paid.</p>}
        <Button variant="secondary" icon="print" className="mt-4 no-print" onClick={() => window.print()}>Print this page</Button></div>
      <div><h3 className="font-serif text-xl font-semibold">Upload documents</h3><p className="mb-3 text-ink-500">PDF, JPG or PNG, up to 5 MB each. You can also do this later.</p>
        <ul className="space-y-3">{sub.requiredDocuments.concat(["PREVIOUS_RESULT"].filter((d) => !sub.requiredDocuments.includes(d))).map((k) => (
          <li key={k} className="rounded-lg border border-line bg-surface p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-bold">{DOC_LABEL[k] ?? k}{sub.requiredDocuments.includes(k) ? "" : " (optional)"}</p>{uploaded[k] && <p className="text-leaf-700">Uploaded: {uploaded[k]}</p>}{err[k] && <p role="alert" className="font-bold text-pen-700">{err[k]}</p>}</div>
            <label className="inline-flex min-h-11 cursor-pointer items-center rounded-md border border-ink-300 bg-surface px-4 font-bold hover:bg-ink-100 focus-within:outline-3 focus-within:outline-brand-500">{uploaded[k] ? "Replace" : "Choose file"}<input type="file" className="sr-only" accept={k === "PASSPORT_PHOTO" ? "image/png,image/jpeg,image/webp" : "application/pdf,image/png,image/jpeg"} onChange={(e) => e.target.files?.[0] && void upload(k, e.target.files[0])} /></label></div></li>
        ))}</ul></div>
    </div>
  );
}

function StatusCheck() {
  const [n, setN] = useState(""); const [c, setC] = useState("");
  const [res, setRes] = useState<{ applicant: string; status: string; decisionNote: string | null; missingDocuments: string[]; documents: { id: string; kind: string; verified: boolean }[]; fee: { invoice: string; status: string; total: string; paid: string } | null } | null>(null);
  const look = useMutation(async () => setRes(await api.post("/public/admissions/status", { applicationNumber: n.trim(), accessCode: c.trim() })));
  return (
    <div className="space-y-6"><form onSubmit={(e) => { e.preventDefault(); void look.run(); }} className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"><TextField label="Application number" value={n} onChange={(e) => setN(e.target.value)} placeholder="APP/2026/00001" required /><TextField label="Access code" value={c} onChange={(e) => setC(e.target.value)} autoCapitalize="characters" required /><Button type="submit" loading={look.pending}>Check</Button></form>
      <ErrorNote error={look.error?.status === 404 ? Object.assign(new Error("We couldn't find that application. Check the number and access code."), {}) : look.error} />
      {res && <div className="rounded-lg border border-line bg-surface p-5"><p className="font-serif text-xl font-semibold">{res.applicant}</p><p className="mt-1">Status: <StatusBadge status={res.status} /></p>{res.decisionNote && <p className="mt-3 rounded bg-paper p-3">{res.decisionNote}</p>}{res.fee && <p className="mt-3">Application fee: <StatusBadge status={res.fee.status} /> ({money(res.fee.paid)} of {money(res.fee.total)})</p>}{res.missingDocuments.length > 0 && <p className="mt-3 text-amber-700">Still needed: {res.missingDocuments.map((d) => DOC_LABEL[d] ?? d).join(", ")}</p>}<ul className="mt-3 flex flex-wrap gap-2">{res.documents.map((d) => <li key={d.id}><Badge tone={d.verified ? "ok" : "warn"} icon={d.verified ? "check" : "clock"}>{DOC_LABEL[d.kind] ?? d.kind}</Badge></li>)}</ul></div>}
    </div>
  );
}
