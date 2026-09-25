"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, useApi, useMutation } from "@/lib/api";
import { Button, Checkbox, Dialog, FormError, PageHeader, Panel, SelectField, TextField, useToast } from "@/ui/kit";

interface Created { student: { id: string; admissionNumber: string }; username?: string; initialPassword?: string; guardianCredentials: { username: string; initialPassword: string }[] }

export default function NewStudent() {
  const router = useRouter();
  const toast = useToast();
  const classes = useApi<{ id: string; name: string; sections: { id: string; name: string }[] }[]>("/academics/classes");
  const [f, setF] = useState({ firstName: "", middleName: "", lastName: "", gender: "FEMALE", dateOfBirth: "", stateOfOrigin: "", lga: "", religion: "", address: "", classId: "", sectionId: "", createLogin: false, g: { name: "", relationship: "Mother", phone: "", email: "" } });
  const [created, setCreated] = useState<Created | null>(null);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((s) => ({ ...s, [k]: e.target.value }));
  const sections = classes.data?.find((c) => c.id === f.classId)?.sections ?? [];

  const save = useMutation(async () => {
    const [gFirst, ...gRest] = f.g.name.trim().split(/\s+/);
    const body = {
      firstName: f.firstName, middleName: f.middleName || undefined, lastName: f.lastName, gender: f.gender, dateOfBirth: f.dateOfBirth || undefined, stateOfOrigin: f.stateOfOrigin || undefined, lga: f.lga || undefined, religion: f.religion || undefined, address: f.address || undefined,
      classId: f.classId || undefined, sectionId: f.sectionId || null, createLogin: f.createLogin,
      guardians: f.g.name && f.g.phone ? [{ newParent: { firstName: gFirst, lastName: gRest.join(" ") || f.lastName, phone: f.g.phone, email: f.g.email || undefined }, relationship: f.g.relationship, isPrimary: true }] : [],
    };
    const r = await api.post<Created>("/students", body);
    toast.push("ok", `Added ${f.firstName} ${f.lastName} (${r.student.admissionNumber})`);
    setCreated(r);
  });
  const fe = save.error?.fieldErrors() ?? {};

  return (
    <>
      <PageHeader title="Add a student" description="Admissions normally create students automatically. Use this for transfers and walk-ins." />
      <form onSubmit={(e) => { e.preventDefault(); void save.run(); }} className="grid gap-6 lg:grid-cols-2">
        <Panel title="Student">
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2"><TextField label="First name" value={f.firstName} onChange={set("firstName")} error={fe.firstName} required /><TextField label="Last name" value={f.lastName} onChange={set("lastName")} error={fe.lastName} required /></div>
            <div className="grid gap-4 sm:grid-cols-2"><TextField label="Middle name" value={f.middleName} onChange={set("middleName")} /><SelectField label="Sex" value={f.gender} onChange={set("gender")}><option value="FEMALE">Female</option><option value="MALE">Male</option></SelectField></div>
            <TextField label="Date of birth" type="date" value={f.dateOfBirth} onChange={set("dateOfBirth")} error={fe.dateOfBirth} />
            <div className="grid gap-4 sm:grid-cols-2"><TextField label="State of origin" value={f.stateOfOrigin} onChange={set("stateOfOrigin")} /><TextField label="LGA" value={f.lga} onChange={set("lga")} /></div>
            <TextField label="Home address" value={f.address} onChange={set("address")} />
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField label="Class" value={f.classId} onChange={(e) => setF({ ...f, classId: e.target.value, sectionId: "" })}><option value="">Not enrolled yet</option>{classes.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</SelectField>
              <SelectField label="Section" value={f.sectionId} onChange={set("sectionId")} disabled={!sections.length}><option value="">No section</option>{sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</SelectField>
            </div>
            <Checkbox label="Create a login for this student" hint="Needed for CBT exams and exam practice." checked={f.createLogin} onChange={(e) => setF({ ...f, createLogin: e.target.checked })} />
          </div>
        </Panel>
        <Panel title="Parent or guardian">
          <div className="space-y-4">
            <p className="text-ink-500">A parent account is created automatically so they can follow results, attendance and fees on their phone.</p>
            <TextField label="Full name" value={f.g.name} onChange={(e) => setF({ ...f, g: { ...f.g, name: e.target.value } })} />
            <div className="grid gap-4 sm:grid-cols-2"><SelectField label="Relationship" value={f.g.relationship} onChange={(e) => setF({ ...f, g: { ...f.g, relationship: e.target.value } })}>{["Mother", "Father", "Guardian", "Uncle", "Aunt", "Sibling"].map((r) => <option key={r}>{r}</option>)}</SelectField><TextField label="Phone" type="tel" value={f.g.phone} onChange={(e) => setF({ ...f, g: { ...f.g, phone: e.target.value } })} hint="08031234567" /></div>
            <TextField label="Email" type="email" value={f.g.email} onChange={(e) => setF({ ...f, g: { ...f.g, email: e.target.value } })} />
          </div>
        </Panel>
        <div className="space-y-3 lg:col-span-2"><FormError error={save.error && Object.keys(fe).length === 0 ? save.error : null} /><div className="flex gap-2"><Button type="submit" loading={save.pending}>Save student</Button><Button variant="secondary" onClick={() => router.back()}>Cancel</Button></div></div>
      </form>
      <Dialog open={!!created} onClose={() => router.push(created ? `/students/${created.student.id}` : "/students")} title="Student added" footer={<><Button variant="secondary" icon="print" onClick={() => window.print()}>Print</Button><Button onClick={() => router.push(`/students/${created!.student.id}`)}>Open record</Button></>}>
        {created && <div className="space-y-4">
          <p>Admission number <strong className="num">{created.student.admissionNumber}</strong>.</p>
          {(created.username || created.guardianCredentials.length > 0) && <>
            <p className="text-ink-700">Give these temporary passwords to the people below. They must change them the first time they sign in, and this is the only time they are shown.</p>
            <ul className="space-y-2">
              {created.username && <li className="rounded border border-line bg-paper p-3"><p className="font-bold">Student</p><p className="num">Username <strong>{created.username}</strong> · Password <strong>{created.initialPassword}</strong></p></li>}
              {created.guardianCredentials.map((g) => <li key={g.username} className="rounded border border-line bg-paper p-3"><p className="font-bold">Parent</p><p className="num">Username <strong>{g.username}</strong> · Password <strong>{g.initialPassword}</strong></p></li>)}
            </ul></>}
        </div>}
      </Dialog>
    </>
  );
}
