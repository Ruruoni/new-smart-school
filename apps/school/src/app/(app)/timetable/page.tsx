"use client";
import { useMemo, useState } from "react";
import { api, useApi, useMutation } from "@/lib/api";
import { Badge, Button, DataState, Dialog, EmptyState, ErrorNote, PageHeader, Panel, Select, SelectField, TextField, useToast } from "@/ui/kit";
import { Can } from "@/ui/session";
import { ClassSelect, TermSelect } from "@/ui/pickers";

interface TT { id: string; name: string; status: string; term: { name: string }; _count: { slots: number } }
interface Slot { id: string; dayOfWeek: number; periodIndex: number; startTime: string; endTime: string; subject: { name: string; code: string }; teacher: { user: { firstName: string; lastName: string } }; room: { name: string } | null; class: { name: string } }
const DAYS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DEFAULT_PERIODS = [["08:00", "08:40"], ["08:40", "09:20"], ["09:20", "10:00"], ["10:20", "11:00"], ["11:00", "11:40"], ["11:40", "12:20"], ["12:20", "13:00"], ["13:40", "14:20"]];

export default function Timetable() {
  const list = useApi<TT[]>("/timetable"); const toast = useToast();
  const [id, setId] = useState(""); const tid = id || list.data?.find((t) => t.status === "ACTIVE")?.id || list.data?.[0]?.id || "";
  const [classId, setClassId] = useState("");
  const slots = useApi<Slot[]>(tid && classId ? `/timetable/${tid}/slots?classId=${classId}` : null);
  const [dlg, setDlg] = useState<"new" | "gen" | null>(null); const [nt, setNt] = useState({ termId: "", name: "Master timetable" }); const [periods, setPeriods] = useState(6); const [per, setPer] = useState(3);
  const create = useMutation(async () => { const t = await api.post<{ id: string }>("/timetable", nt); toast.push("ok", "Timetable created"); setDlg(null); setId(t.id); list.reload(); });
  const gen = useMutation(async () => { const r = await api.post<{ placed: number; unplaced: { class?: string; subject?: string; missing: number; reason: string }[] }>("/timetable/generate", { timetableId: tid, periods: DEFAULT_PERIODS.slice(0, periods).map(([start, end]) => ({ start, end })), defaultPeriodsPerWeek: per, replaceExisting: true }); setResult(r); slots.reload(); list.reload(); });
  const [result, setResult] = useState<{ placed: number; unplaced: { class?: string; subject?: string; missing: number; reason: string }[] } | null>(null);
  const activate = async () => { await api.post(`/timetable/${tid}/activate`); toast.push("ok", "Timetable is now active"); list.reload(); };
  const grid = useMemo(() => { const m = new Map<string, Slot>(); for (const s of slots.data ?? []) m.set(`${s.dayOfWeek}:${s.periodIndex}`, s); return m; }, [slots.data]);
  const maxP = Math.max(0, ...(slots.data ?? []).map((s) => s.periodIndex)) + 1;
  return (<>
    <PageHeader title="Timetable" description="Teachers, rooms and classes can never be double-booked — the school server refuses a clash, and generation avoids them." actions={<Can perm={["timetable.manage"]}><Button icon="plus" onClick={() => setDlg("new")}>New timetable</Button></Can>} />
    <DataState query={list}>{(d) => d.length === 0 ? <Panel><EmptyState title="No timetable yet" icon="calendar">Create one for a term, then generate a draft from your class-subject assignments.</EmptyState></Panel> : (<>
      <div className="mb-4 flex flex-wrap items-center gap-3"><Select aria-label="Timetable" className="w-auto min-w-56" value={tid} onChange={(e) => setId(e.target.value)}>{d.map((t) => <option key={t.id} value={t.id}>{t.name} — {t.term.name} ({t.status.toLowerCase()})</option>)}</Select><ClassSelect value={classId} onChange={setClassId} />
        <Can perm={["timetable.manage"]}><Button variant="secondary" onClick={() => setDlg("gen")}>Generate draft</Button>{d.find((t) => t.id === tid)?.status !== "ACTIVE" && <Button variant="secondary" onClick={() => void activate()}>Make active</Button>}</Can></div>
      <DataState query={slots}>{(s) => s.length === 0 ? <Panel><EmptyState title="No lessons for this class" icon="calendar">Generate a draft, or add lessons one by one.</EmptyState></Panel> : (
        <div className="overflow-x-auto rounded-(--radius-panel) border border-line bg-surface"><table className="register"><thead><tr><th>Period</th>{[1, 2, 3, 4, 5].map((d) => <th key={d}>{DAYS[d]}</th>)}</tr></thead><tbody>{Array.from({ length: maxP }, (_, p) => (
          <tr key={p}><td className="whitespace-nowrap"><strong className="num">{p + 1}</strong><span className="block text-sm text-ink-500">{[...grid.values()].find((x) => x.periodIndex === p)?.startTime}</span></td>{[1, 2, 3, 4, 5].map((d) => { const x = grid.get(`${d}:${p}`); return <td key={d} className="min-w-32 align-top">{x ? <div><p className="font-bold">{x.subject.name}</p><p className="text-sm text-ink-500">{x.teacher.user.firstName[0]}. {x.teacher.user.lastName}{x.room ? ` · ${x.room.name}` : ""}</p></div> : <span className="text-ink-300">—</span>}</td>; })}</tr>))}</tbody></table></div>
      )}</DataState></>)}</DataState>
    <Dialog open={dlg === "new"} onClose={() => setDlg(null)} title="New timetable" footer={<><Button variant="secondary" onClick={() => setDlg(null)}>Cancel</Button><Button loading={create.pending} disabled={!nt.termId} onClick={() => void create.run()}>Create</Button></>}><div className="space-y-4"><div><p className="mb-1.5 font-bold">Term</p><TermSelect value={nt.termId} onChange={(v) => setNt({ ...nt, termId: v })} /></div><TextField label="Name" value={nt.name} onChange={(e) => setNt({ ...nt, name: e.target.value })} /><ErrorNote error={create.error} /></div></Dialog>
    <Dialog open={dlg === "gen"} onClose={() => setDlg(null)} title="Generate a draft" footer={<><Button variant="secondary" onClick={() => setDlg(null)}>Close</Button><Button loading={gen.pending} onClick={() => void gen.run()}>Generate (replaces lessons)</Button></>}><div className="space-y-4"><p className="text-ink-700">Places every class-subject that has a teacher, without clashes. Anything that cannot fit is listed so you can adjust.</p><div className="grid gap-4 sm:grid-cols-2"><SelectField label="Periods per day" value={periods} onChange={(e) => setPeriods(Number(e.target.value))}>{[4, 5, 6, 7, 8].map((n) => <option key={n}>{n}</option>)}</SelectField><SelectField label="Lessons per subject per week" value={per} onChange={(e) => setPer(Number(e.target.value))}>{[1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}</SelectField></div><ErrorNote error={gen.error} />{result && <div role="status" className="rounded bg-paper p-3"><p className="font-bold">Placed {result.placed} lessons.</p>{result.unplaced.length > 0 && <><p className="mt-2 font-bold text-amber-700">Could not place:</p><ul className="text-[0.9375rem]">{result.unplaced.slice(0, 10).map((u, i) => <li key={i}>{u.class} {u.subject}: {u.missing} lesson(s) — {u.reason}</li>)}</ul></>}<Badge tone="ok" icon="check">Done</Badge></div>}</div></Dialog>
  </>);
}
