"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, useApi } from "@/lib/api";
import { Badge, Button, DataState, EmptyState, ErrorNote, PageHeader, Panel, Select } from "@/ui/kit";
import { Icon } from "@/ui/icons";
import { TermSelect } from "@/ui/pickers";
import { useSession } from "@/ui/session";
import { gradeFor, type GradeBand } from "@/modules/results/engine";

interface Sheet {
  classSubject: { id: string; subject: string; class: string; section: string | null };
  term: { id: string; name: string };
  locked: boolean; published: boolean;
  components: { id: string; code: string; name: string; maxScore: number; isExam: boolean }[];
  rows: { studentId: string; admissionNumber: string; firstName: string; lastName: string; scores: Record<string, { score: number | null; isAbsent: boolean; version: number }> }[];
}
interface Grading { bands: GradeBand[] }
interface CS { id: string; class: { name: string }; section: { name: string } | null; subject: { name: string } }

type CellState = "idle" | "saving" | "saved" | "error" | "conflict";
interface Cell { text: string; absent: boolean; version: number; state: CellState; msg?: string; server?: { score: number | null; version: number } }
const key = (s: string, t: string) => `${s}:${t}`;

export default function ScoreEntry() {
  const { me } = useSession();
  const list = useApi<CS[]>("/academics/my-class-subjects");
  const [csId, setCsId] = useState(""); const [termId, setTermId] = useState("");
  useEffect(() => { if (!csId && list.data?.length) setCsId(list.data[0]!.id); }, [csId, list.data]);
  const sheet = useApi<Sheet>(csId && termId ? `/results/sheet?classSubjectId=${csId}&termId=${termId}` : null);
  const grading = useApi<Grading>("/results/grading");
  return (
    <>
      <PageHeader title="Score entry" description="Type scores straight into the grid. Every cell saves automatically; Enter moves down, Tab moves across, and typing A marks a student absent." />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select aria-label="Class and subject" value={csId} onChange={(e) => setCsId(e.target.value)} className="w-auto min-w-64">{list.data?.length === 0 && <option value="">No subjects assigned to you</option>}{list.data?.map((c) => <option key={c.id} value={c.id}>{c.class.name}{c.section ? ` ${c.section.name}` : ""} — {c.subject.name}</option>)}</Select>
        <TermSelect value={termId} onChange={setTermId} />
      </div>
      {list.data?.length === 0 ? <Panel><EmptyState title="No subjects assigned yet" icon="edit">{me.user.userType === "TEACHER" ? "Ask the administrator to assign your subjects under Classes & subjects." : "Assign class subjects first."}</EmptyState></Panel> : (
        <DataState query={sheet}>{(s) => <Grid key={`${s.classSubject.id}:${s.term.id}`} sheet={s} bands={grading.data?.bands ?? []} />}</DataState>
      )}
    </>
  );
}

function Grid({ sheet, bands }: { sheet: Sheet; bands: GradeBand[] }) {
  const [cells, setCells] = useState<Record<string, Cell>>(() => {
    const m: Record<string, Cell> = {};
    for (const r of sheet.rows) for (const c of sheet.components) { const v = r.scores[c.id]!; m[key(r.studentId, c.id)] = { text: v.isAbsent ? "ABS" : v.score === null ? "" : String(v.score), absent: v.isAbsent, version: v.version, state: "idle" }; }
    return m;
  });
  const [locked, setLocked] = useState(sheet.locked);
  const [banner, setBanner] = useState<ApiError | null>(null);
  const dirty = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef(false);
  const cellsRef = useRef(cells); cellsRef.current = cells;
  const readOnly = locked || sheet.published;
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});

  const flush = useCallback(async () => {
    if (inflight.current || dirty.current.size === 0) return;
    inflight.current = true;
    const keys = [...dirty.current]; dirty.current.clear();
    const entries = keys.map((k) => { const [studentId, typeId] = k.split(":") as [string, string]; const c = cellsRef.current[k]!; const num = c.absent || c.text.trim() === "" ? null : Number(c.text); return { studentId, typeId, score: num, isAbsent: c.absent, version: c.version }; });
    setCells((cs) => { const n = { ...cs }; for (const k of keys) n[k] = { ...n[k]!, state: "saving" }; return n; });
    try {
      const r = await api.post<{ saved: { studentId: string; typeId: string; version: number }[]; conflicts: { studentId: string; typeId: string; currentScore: number | null; currentVersion: number }[]; rejected: { studentId: string; typeId: string; reason: string }[] }>("/results/scores", { classSubjectId: sheet.classSubject.id, termId: sheet.term.id, entries });
      setBanner(null);
      setCells((cs) => {
        const n = { ...cs };
        for (const s of r.saved) { const k = key(s.studentId, s.typeId); if (n[k]) n[k] = { ...n[k]!, version: s.version, state: dirty.current.has(k) ? "idle" : "saved" }; }
        for (const c of r.conflicts) { const k = key(c.studentId, c.typeId); n[k] = { ...n[k]!, state: "conflict", msg: `Changed by someone else to ${c.currentScore ?? "blank"}`, server: { score: c.currentScore, version: c.currentVersion } }; }
        for (const x of r.rejected) { const k = key(x.studentId, x.typeId); n[k] = { ...n[k]!, state: "error", msg: x.reason }; }
        return n;
      });
      setTimeout(() => setCells((cs) => { const n = { ...cs }; for (const k of Object.keys(n)) if (n[k]!.state === "saved") n[k] = { ...n[k]!, state: "idle" }; return n; }), 1500);
    } catch (e) {
      // Network/server trouble: keep the values, mark them for retry — nothing typed is ever thrown away.
      for (const k of keys) dirty.current.add(k);
      setCells((cs) => { const n = { ...cs }; for (const k of keys) n[k] = { ...n[k]!, state: "idle" }; return n; });
      setBanner(e as ApiError);
      timer.current = setTimeout(() => void flush(), 5000);
    } finally { inflight.current = false; if (dirty.current.size && !timer.current) timer.current = setTimeout(() => { timer.current = null; void flush(); }, 700); }
  }, [sheet.classSubject.id, sheet.term.id]);

  const schedule = () => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => { timer.current = null; void flush(); }, 700); };
  useEffect(() => { const h = (e: BeforeUnloadEvent) => { if (dirty.current.size || inflight.current) { e.preventDefault(); e.returnValue = ""; } }; window.addEventListener("beforeunload", h); return () => window.removeEventListener("beforeunload", h); }, []);

  const edit = (studentId: string, typeId: string, raw: string, max: number) => {
    const k = key(studentId, typeId);
    const t = raw.trim();
    const isAbs = /^a(bs)?$/i.test(t);
    let state: CellState = "idle"; let msg: string | undefined;
    if (!isAbs && t !== "") {
      const n = Number(t);
      if (!Number.isFinite(n) || n < 0) { state = "error"; msg = "Enter a number"; }
      else if (n > max) { state = "error"; msg = `Maximum is ${max}`; }
      else if (Math.round(n * 100) / 100 !== n) { state = "error"; msg = "At most 2 decimals"; }
    }
    setCells((cs) => ({ ...cs, [k]: { ...cs[k]!, text: isAbs ? "ABS" : raw, absent: isAbs, state, msg } }));
    if (state !== "error") { dirty.current.add(k); schedule(); }
  };

  const move = (e: React.KeyboardEvent, ri: number, ci: number) => {
    const at = (r: number, c: number) => inputs.current[`${sheet.rows[r]?.studentId}:${sheet.components[c]?.id}`];
    let target: HTMLInputElement | null | undefined;
    if (e.key === "Enter" || e.key === "ArrowDown") target = at(ri + (e.shiftKey ? -1 : 1), ci);
    else if (e.key === "ArrowUp") target = at(ri - 1, ci);
    else if (e.key === "ArrowRight" && (e.currentTarget as HTMLInputElement).selectionStart === (e.currentTarget as HTMLInputElement).value.length) target = at(ri, ci + 1);
    else if (e.key === "ArrowLeft" && (e.currentTarget as HTMLInputElement).selectionStart === 0) target = at(ri, ci - 1);
    else return;
    e.preventDefault(); target?.focus(); target?.select();
  };

  const resolveConflict = (k: string, useServer: boolean) => setCells((cs) => {
    const c = cs[k]!; const sv = c.server!;
    const n = { ...cs, [k]: { ...c, version: sv.version, state: "idle" as CellState, msg: undefined, server: undefined, ...(useServer ? { text: sv.score === null ? "" : String(sv.score), absent: false } : {}) } };
    if (!useServer) { dirty.current.add(k); schedule(); }
    return n;
  });

  const totals = useMemo(() => sheet.rows.map((r) => {
    let total = 0, any = false, bad = false;
    for (const c of sheet.components) { const cell = cells[key(r.studentId, c.id)]!; if (cell.absent) any = true; else if (cell.text.trim() !== "") { const n = Number(cell.text); if (Number.isFinite(n)) { total += Math.min(n, c.maxScore); any = true; } else bad = true; } }
    const max = sheet.components.reduce((s, c) => s + c.maxScore, 0);
    const pct = max ? (total / max) * 100 : 0;
    return { total: Math.round(total * 100) / 100, grade: any && !bad ? gradeFor(pct, bands)?.grade ?? "" : "", any };
  }), [cells, sheet, bands]);

  const pending = Object.values(cells).filter((c) => c.state === "saving").length + dirty.current.size;
  const lock = async (v: boolean) => { try { await api.post("/results/lock", { classSubjectId: sheet.classSubject.id, termId: sheet.term.id, locked: v }); setLocked(v); } catch (e) { setBanner(e as ApiError); } };

  return (
    <Panel padded={false}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <p className="font-serif text-lg font-semibold">{sheet.classSubject.class}{sheet.classSubject.section ? ` ${sheet.classSubject.section}` : ""} — {sheet.classSubject.subject} <span className="font-sans text-base font-normal text-ink-500">· {sheet.term.name}</span></p>
        <div className="flex items-center gap-2" aria-live="polite">
          {pending > 0 ? <Badge tone="warn" icon="refresh">Saving…</Badge> : banner ? <Badge tone="bad" icon="cloudOff">Unsaved — retrying</Badge> : <Badge tone="ok" icon="check">All changes saved</Badge>}
          {sheet.published ? <Badge tone="info" icon="lock">Published</Badge> : <Button size="sm" variant="secondary" icon={locked ? "unlock" : "lock"} onClick={() => void lock(!locked)}>{locked ? "Unlock scores" : "Lock scores"}</Button>}
        </div>
      </div>
      {banner && <div className="px-4 pt-3"><ErrorNote error={banner} /></div>}
      {sheet.published && <p className="border-b border-line bg-sky-100 px-4 py-2 text-sky-700"><Icon name="info" size={16} className="mr-1 inline" />Results are published, so scores are frozen. Withdraw them from the Results page to make corrections.</p>}
      {sheet.rows.length === 0 ? <EmptyState title="No students in this class" icon="users">Enroll students in this class first.</EmptyState> : (
        <div className="max-h-[70vh] overflow-auto">
          <table className="sheet w-full" aria-label="Score sheet">
            <thead><tr><th scope="col">Student</th>{sheet.components.map((c) => <th key={c.id} scope="col" className="text-right whitespace-nowrap">{c.name}<span className="block text-sm font-normal text-ink-500">out of {c.maxScore}</span></th>)}<th scope="col" className="text-right">Total</th><th scope="col" className="text-center">Grade</th></tr></thead>
            <tbody>
              {sheet.rows.map((r, ri) => (
                <tr key={r.studentId}>
                  <th scope="row"><span className="font-bold">{r.lastName}, {r.firstName}</span><span className="num ml-2 text-sm text-ink-500">{r.admissionNumber}</span></th>
                  {sheet.components.map((c, ci) => {
                    const k = key(r.studentId, c.id); const cell = cells[k]!;
                    return (
                      <td key={c.id} data-state={cell.state === "idle" ? undefined : cell.state} title={cell.msg}>
                        <input ref={(el) => { inputs.current[k] = el; }} className="cell" inputMode="decimal" autoComplete="off" value={cell.text} disabled={readOnly}
                          aria-label={`${r.firstName} ${r.lastName}, ${c.name}, out of ${c.maxScore}`} aria-invalid={cell.state === "error" || undefined}
                          onChange={(e) => edit(r.studentId, c.id, e.target.value, c.maxScore)} onKeyDown={(e) => move(e, ri, ci)} onFocus={(e) => e.currentTarget.select()} />
                        {cell.state === "conflict" && <div className="bg-pen-100 px-1.5 pb-1 text-sm"><p className="font-bold text-pen-700">{cell.msg}</p><div className="flex gap-3"><button className="cursor-pointer py-1 font-bold underline" onClick={() => resolveConflict(k, true)}>Use theirs</button><button className="cursor-pointer py-1 font-bold underline" onClick={() => resolveConflict(k, false)}>Keep mine</button></div></div>}
                        {cell.state === "error" && <p className="bg-pen-100 px-1.5 pb-1 text-sm font-bold text-pen-700">{cell.msg}</p>}
                      </td>
                    );
                  })}
                  <td className="num px-3 text-right font-bold">{totals[ri]!.any ? totals[ri]!.total : "—"}</td>
                  <td className="px-3 text-center font-bold">{totals[ri]!.grade || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="border-t border-line px-4 py-2 text-sm text-ink-500">Total and grade here are a preview. The official result is calculated when results are processed.</p>
    </Panel>
  );
}
