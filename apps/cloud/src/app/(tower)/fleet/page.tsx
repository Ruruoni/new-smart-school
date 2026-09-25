"use client";
import { Suspense, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ago, call, HEALTH_LABEL, healthOf, useAction, useApi, type Health } from "@/lib/api";
import { Badge, Button, Dialog, Field, Notice, Select, TextInput } from "@/ui/kit";
import { canSupport, useMe } from "../layout";
import { ControlPanel } from "./control";
import { HealthBoard } from "./health";
import type { Detail, Row } from "./types";

type Pane = "list" | "health" | "control";
const FILTERS: [string, string, (h: Health) => boolean][] = [["all", "All", () => true], ["attention", "Needs attention", (h) => h === "attention" || h === "critical"], ["silent", "Not reporting", (h) => h === "silent"], ["suspended", "Suspended", (h) => h === "suspended"]];

function Fleet() {
  const router = useRouter(); const sp = useSearchParams(); const me = useMe();
  const selected = sp.get("i");
  const list = useApi<Row[]>("installations", { refreshMs: 30_000 });
  const detail = useApi<Detail>(selected ? `installations/${selected}` : null, { refreshMs: 30_000 });
  const [q, setQ] = useState(""); const [filter, setFilter] = useState("all"); const [pane, setPane] = useState<Pane>("list");
  const [creating, setCreating] = useState(false);
  const rows = useMemo(() => {
    const f = FILTERS.find((x) => x[0] === filter)![2];
    return (list.data ?? []).map((r) => ({ r, h: healthOf(r) })).filter(({ r, h }) => f(h) && `${r.schoolName} ${r.code} ${r.state ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()));
  }, [list.data, q, filter]);
  const choose = (id: string) => { router.replace(`/fleet?i=${id}`); setPane("health"); };
  const counts = useMemo(() => { const c: Record<string, number> = {}; for (const r of list.data ?? []) c[healthOf(r)] = (c[healthOf(r)] ?? 0) + 1; return c; }, [list.data]);

  return (
    <>
      <div className="tabs" role="tablist" aria-label="Fleet sections">{(["list", "health", "control"] as const).map((p) => <button key={p} role="tab" aria-selected={pane === p} onClick={() => setPane(p)}>{p === "list" ? "Schools" : p === "health" ? "Health" : "Control"}</button>)}</div>
      <div className="tower" data-pane={pane}>
        <section className="col-list" aria-label="Installations">
          <div className="search">
            <label className="sr-only" htmlFor="fleet-search">Search schools</label>
            <TextInput id="fleet-search" type="search" placeholder="Search name, code or state" value={q} onChange={(e) => setQ(e.target.value)} />
            <div style={{ display: "flex", gap: ".5rem", marginTop: ".5rem" }}>
              <Select aria-label="Show" value={filter} onChange={(e) => setFilter(e.target.value)}>{FILTERS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}</Select>
              {canSupport(me) && <Button small onClick={() => setCreating(true)}>New school</Button>}
            </div>
            <p className="muted num" style={{ margin: ".5rem 0 0", fontSize: ".875rem" }}>{list.data?.length ?? 0} installation{list.data?.length === 1 ? "" : "s"}{counts.critical ? ` · ${counts.critical} critical` : ""}{counts.attention ? ` · ${counts.attention} need attention` : ""}</p>
          </div>
          {list.error ? <p className="empty" role="alert">{list.error.message}</p> : list.loading ? <p className="empty" aria-busy="true">Loading…</p> : rows.length === 0 ? <p className="empty">{list.data?.length ? "No school matches." : "No schools yet. Create the first installation to get a registration token."}</p> : (
            <ul className="strips">{rows.map(({ r, h }) => (
              <li key={r.id}><button className="strip" data-h={h} aria-current={r.id === selected} onClick={() => choose(r.id)}>
                <span className="nm">{r.schoolName}</span><Badge tone={h === "healthy" ? "ok" : h === "attention" ? "warn" : h === "critical" ? "bad" : h === "suspended" ? "violet" : undefined}>{HEALTH_LABEL[h]}</Badge>
                <span className="sub"><span className="mono">{r.code}</span><span>{r.status === "PENDING" ? "awaiting registration" : `seen ${ago(r.lastHeartbeatAt)}`}</span>{r.openAlerts > 0 && <span>{r.openAlerts} alert{r.openAlerts === 1 ? "" : "s"}</span>}{r.openConflicts > 0 && <span>{r.openConflicts} conflict{r.openConflicts === 1 ? "" : "s"}</span>}</span>
              </button></li>))}</ul>
          )}
        </section>

        <section className="col-health" aria-label="Health and sync">
          {!selected ? <p className="empty">Choose a school to see how it is doing.</p> : detail.error ? <Notice tone="bad">{detail.error.message}</Notice> : !detail.data ? <p className="empty" aria-busy="true">Loading…</p> : <HealthBoard d={detail.data} reload={() => { void detail.reload(); void list.reload(); }} />}
        </section>

        <section className="col-control" aria-label="Control panel">
          {selected && detail.data ? <ControlPanel d={detail.data} reload={() => { void detail.reload(); void list.reload(); }} /> : <p className="empty">Licence, feature flags and commands appear here.</p>}
        </section>
      </div>
      <CreateDialog open={creating} onClose={() => setCreating(false)} onCreated={(id) => { void list.reload(); choose(id); }} />
    </>
  );
}

function CreateDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [f, setF] = useState({ schoolName: "", state: "", contactName: "", contactEmail: "", contactPhone: "", plan: "standard", licenseDays: "365" });
  const [made, setMade] = useState<{ id: string; code: string; token: string } | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const create = useAction(async () => {
    const clean = Object.fromEntries(Object.entries(f).filter(([, v]) => v.trim() !== ""));
    const r = await call<{ installation: { id: string; code: string }; registrationToken: string }>("installations", "POST", { ...clean, licenseDays: Number(f.licenseDays) });
    setMade({ id: r.installation.id, code: r.installation.code, token: r.registrationToken });
  });
  const done = () => { const id = made?.id; setMade(null); setF({ schoolName: "", state: "", contactName: "", contactEmail: "", contactPhone: "", plan: "standard", licenseDays: "365" }); onClose(); if (id) onCreated(id); };
  return (
    <Dialog open={open} title={made ? "School created" : "New school installation"} onClose={made ? done : onClose} footer={made ? <Button onClick={done}>Done</Button> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={create.pending} disabled={f.schoolName.trim().length < 2} onClick={() => void create.run()}>Create installation</Button></>}>
      {made ? <>
        <p style={{ marginTop: 0 }}>Give the school this one-time token. They paste it under <strong>Cloud &amp; licence</strong> in their SmartSchool. It is <strong>shown only once</strong> and expires in 14 days.</p>
        <p className="muted" style={{ margin: "0 0 .3rem" }}>Installation code <span className="mono">{made.code}</span></p>
        <p className="token" data-testid="registration-token">{made.token}</p>
      </> : <>
        {create.error && <Notice tone="bad">{create.error}</Notice>}
        <Field label="School name"><TextInput value={f.schoolName} onChange={set("schoolName")} autoFocus /></Field>
        <Field label="State"><TextInput value={f.state} onChange={set("state")} /></Field>
        <Field label="Contact person"><TextInput value={f.contactName} onChange={set("contactName")} /></Field>
        <Field label="Contact email"><TextInput type="email" value={f.contactEmail} onChange={set("contactEmail")} /></Field>
        <Field label="Contact phone"><TextInput value={f.contactPhone} onChange={set("contactPhone")} /></Field>
        <Field label="Plan"><TextInput value={f.plan} onChange={set("plan")} /></Field>
        <Field label="Licence length (days)"><TextInput type="number" min={1} max={3650} value={f.licenseDays} onChange={set("licenseDays")} /></Field>
      </>}
    </Dialog>
  );
}

export default function FleetPage() { return <Suspense><Fleet /></Suspense>; }
