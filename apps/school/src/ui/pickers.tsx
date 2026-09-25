"use client";
import { useEffect } from "react";
import { useApi } from "@/lib/api";
import { Select } from "./kit";

interface Year { id: string; name: string; isCurrent: boolean; terms: { id: string; name: string; isCurrent: boolean }[] }

/** Term picker that defaults to the current term. */
export function TermSelect({ value, onChange, label = "Term" }: { value: string; onChange: (id: string) => void; label?: string }) {
  const q = useApi<Year[]>("/academics/years");
  const terms = q.data?.flatMap((y) => y.terms.map((t) => ({ id: t.id, label: `${y.name} · ${t.name}`, current: t.isCurrent }))) ?? [];
  useEffect(() => { if (!value && terms.length) onChange((terms.find((t) => t.current) ?? terms[0]!).id); }, [value, terms.length]); // eslint-disable-line react-hooks/exhaustive-deps
  return <Select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="w-auto min-w-52">{terms.length === 0 && <option value="">No terms yet</option>}{terms.map((t) => <option key={t.id} value={t.id}>{t.label}{t.current ? " (current)" : ""}</option>)}</Select>;
}

export function ClassSelect({ value, onChange, label = "Class", allowAll }: { value: string; onChange: (id: string) => void; label?: string; allowAll?: boolean }) {
  const q = useApi<{ id: string; name: string }[]>("/academics/classes");
  useEffect(() => { if (!value && !allowAll && q.data?.length) onChange(q.data[0]!.id); }, [value, allowAll, q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  return <Select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="w-auto min-w-40">{allowAll && <option value="">All classes</option>}{q.data?.length === 0 && <option value="">No classes yet</option>}{q.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>;
}
