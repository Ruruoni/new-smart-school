"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, useApi, useMutation } from "@/lib/api";
import { today } from "@/lib/format";
import { Badge, Button, DataState, EmptyState, ErrorNote, PageHeader, Panel, TextField, useToast } from "@/ui/kit";
import { ClassSelect } from "@/ui/pickers";
import { Can, useSession } from "@/ui/session";
import { Icon } from "@/ui/icons";

type St = "PRESENT" | "LATE" | "ABSENT" | "EXCUSED";
interface Row { studentId: string; admissionNumber: string; firstName: string; lastName: string; mark: { status: St; method: string; checkedInAt: string | null } | null }
const OPTIONS: { s: St; label: string; key: string; on: string }[] = [
  { s: "PRESENT", label: "Present", key: "P", on: "bg-leaf-700 text-white border-leaf-700" }, { s: "LATE", label: "Late", key: "L", on: "bg-[#d98a00] text-white border-[#d98a00]" },
  { s: "ABSENT", label: "Absent", key: "A", on: "bg-pen-700 text-white border-pen-700" }, { s: "EXCUSED", label: "Excused", key: "E", on: "bg-sky-700 text-white border-sky-700" },
];

export default function Attendance() {
  const [classId, setClassId] = useState(""); const [date, setDate] = useState(today());
  // deep link from the teacher home: /attendance?classId=…
  useEffect(() => { const c = new URLSearchParams(window.location.search).get("classId"); if (c) setClassId(c); }, []);
  const q = useApi<Row[]>(classId ? `/attendance/sheet?classId=${classId}&date=${date}` : null);
  return (
    <>
      <PageHeader title="Attendance" description="Mark today's roll call. Press P, L, A or E to set the highlighted student and move to the next." actions={<Can perm={["attendance.devices"]}><a href="/attendance/devices"><Button variant="secondary" icon="qr">Scanners</Button></a></Can>} />
      <div className="mb-4 flex flex-wrap items-end gap-3"><ClassSelect value={classId} onChange={setClassId} /><TextField label="Date" type="date" max={today()} value={date} onChange={(e) => setDate(e.target.value)} className="w-44" /></div>
      <DataState query={q}>{(rows) => <Roll key={`${classId}:${date}`} rows={rows} classId={classId} date={date} reload={q.reload} />}</DataState>
    </>
  );
}

function Roll({ rows, classId, date, reload }: { rows: Row[]; classId: string; date: string; reload: () => void }) {
  const toast = useToast();
  const { me } = useSession();
  const [marks, setMarks] = useState<Record<string, St | undefined>>(() => Object.fromEntries(rows.map((r) => [r.studentId, r.mark?.status])));
  const [cursor, setCursor] = useState(0);
  const [saved, setSaved] = useState(true);
  const refs = useRef<(HTMLLIElement | null)[]>([]);
  const set = (id: string, s: St) => { setMarks((m) => ({ ...m, [id]: s })); setSaved(false); };
  const counts = useMemo(() => { const c = { PRESENT: 0, LATE: 0, ABSENT: 0, EXCUSED: 0, none: 0 }; for (const r of rows) { const m = marks[r.studentId]; if (m) c[m]++; else c.none++; } return c; }, [marks, rows]);
  useEffect(() => { refs.current[cursor]?.scrollIntoView({ block: "nearest" }); }, [cursor]);
  useEffect(() => { const h = (e: BeforeUnloadEvent) => { if (!saved) { e.preventDefault(); e.returnValue = ""; } }; window.addEventListener("beforeunload", h); return () => window.removeEventListener("beforeunload", h); }, [saved]);

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const opt = OPTIONS.find((o) => o.key.toLowerCase() === e.key.toLowerCase());
    if (opt && rows[cursor]) { e.preventDefault(); set(rows[cursor]!.studentId, opt.s); setCursor((c) => Math.min(rows.length - 1, c + 1)); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(rows.length - 1, c + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
  };

  const save = useMutation(async () => {
    const entries = rows.filter((r) => marks[r.studentId]).map((r) => ({ studentId: r.studentId, status: marks[r.studentId]! }));
    if (!entries.length) return;
    const r = await api.post<{ total: number; changed: number }>("/attendance/record", { classId, date, entries });
    toast.push("ok", r.changed ? `Saved — ${r.changed} mark${r.changed === 1 ? "" : "s"} updated` : "Already up to date");
    setSaved(true); reload();
  });
  const allPresent = () => { setMarks(Object.fromEntries(rows.map((r) => [r.studentId, marks[r.studentId] ?? "PRESENT"]))); setSaved(false); };

  if (!rows.length) return <Panel><EmptyState title="No students in this class" icon="users">Enrol students first, or pick another class.</EmptyState></Panel>;
  return (
    <Panel padded={false}>
      <div className="sticky top-14 z-20 flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface px-4 py-3 lg:top-14">
        <p className="num flex flex-wrap items-center gap-2 text-[0.9375rem]"><Badge tone="ok">{counts.PRESENT} present</Badge><Badge tone="warn">{counts.LATE} late</Badge><Badge tone="bad">{counts.ABSENT} absent</Badge><Badge tone="info">{counts.EXCUSED} excused</Badge>{counts.none > 0 && <Badge>{counts.none} not marked</Badge>}</p>
        <div className="flex gap-2"><Button variant="secondary" size="sm" onClick={allPresent}>Mark the rest present</Button><Button size="sm" icon="check" loading={save.pending} onClick={() => void save.run()} disabled={saved}>{saved ? "Saved" : "Save attendance"}</Button></div>
      </div>
      {save.error && <div className="p-3"><ErrorNote error={save.error} /></div>}
      <ul role="listbox" aria-label="Students" tabIndex={0} onKeyDown={onKey} className="focus:outline-offset-[-3px]">
        {rows.map((r, i) => {
          const m = marks[r.studentId];
          return (
            <li key={r.studentId} ref={(el) => { refs.current[i] = el; }} role="option" aria-selected={i === cursor} onClick={() => setCursor(i)}
              className={`flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2 ${i === cursor ? "bg-brand-50" : ""}`} style={{ boxShadow: `inset 3px 0 0 ${m === "ABSENT" ? "var(--rule-bad)" : m === "LATE" ? "var(--rule-warn)" : m === "PRESENT" ? "var(--rule-ok)" : m === "EXCUSED" ? "var(--rule-info)" : "transparent"}` }}>
              <span className="num w-8 text-ink-500">{i + 1}</span>
              <span className="min-w-40 flex-1"><span className="font-bold">{r.lastName}, {r.firstName}</span><span className="num ml-2 text-sm text-ink-500">{r.admissionNumber}</span>{r.mark?.method && r.mark.method !== "MANUAL" && <Badge tone="brand" icon="qr">{r.mark.method.toLowerCase()}</Badge>}</span>
              <div role="radiogroup" aria-label={`Attendance for ${r.firstName} ${r.lastName}`} className="flex gap-1.5">
                {OPTIONS.map((o) => <button key={o.s} type="button" role="radio" aria-checked={m === o.s} onClick={() => { set(r.studentId, o.s); setCursor(i); }} className={`min-h-11 min-w-11 cursor-pointer rounded-md border-2 px-3 font-bold transition-colors ${m === o.s ? o.on : "border-ink-200 bg-surface text-ink-700 hover:border-ink-400"}`}><span className="sr-only">{o.label}</span><span aria-hidden>{o.key}</span></button>)}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="border-t border-line px-4 py-2 text-sm text-ink-500"><Icon name="info" size={14} className="mr-1 inline" />Marks recorded by QR scanners at the gate appear here automatically. {me.user.userType === "TEACHER" ? "You can only mark classes you teach or are form teacher of." : ""}</p>
    </Panel>
  );
}
