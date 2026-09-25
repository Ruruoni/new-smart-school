"use client";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useApi } from "@/lib/api";
import { Skeleton } from "./kit";

export interface Child { id: string; firstName: string; lastName: string; admissionNumber: string; class: string | null; relationship: string; canViewFinance: boolean; canViewResults: boolean }
const Ctx = createContext<{ children: Child[]; child: Child | null; select: (id: string) => void } | null>(null);
export const useChild = () => { const v = useContext(Ctx); if (!v) throw new Error("useChild outside provider"); return v; };

/** Parents with several children pick one; the choice is remembered on this device (a per-viewer convenience only). */
export function ChildProvider({ children: kids }: { children: ReactNode }) {
  const q = useApi<Child[]>("/me/children");
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => { try { setSel(localStorage.getItem("ss:child")); } catch { /* storage unavailable */ } }, []);
  const value = useMemo(() => {
    const list = q.data ?? [];
    const child = list.find((c) => c.id === sel) ?? list[0] ?? null;
    return { children: list, child, select: (id: string) => { setSel(id); try { localStorage.setItem("ss:child", id); } catch { /* ignore */ } } };
  }, [q.data, sel]);
  if (!q.data) return <div className="space-y-3 p-4"><Skeleton className="h-12 w-full" /><Skeleton className="h-32 w-full" /></div>;
  return <Ctx.Provider value={value}>{kids}</Ctx.Provider>;
}

/** Child chips — big touch targets, only shown when there is more than one child. */
export function ChildSelector() {
  const { children: list, child, select } = useChild();
  if (list.length < 2) return null;
  return (
    <div role="radiogroup" aria-label="Choose child" className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1">
      {list.map((c) => <button key={c.id} role="radio" aria-checked={child?.id === c.id} onClick={() => select(c.id)} className={`min-h-11 shrink-0 cursor-pointer rounded-full border-2 px-4 font-bold ${child?.id === c.id ? "border-brand-700 bg-brand-700 text-white" : "border-ink-300 bg-surface text-ink-800"}`}>{c.firstName}</button>)}
    </div>
  );
}
