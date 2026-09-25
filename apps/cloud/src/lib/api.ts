"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public requestId?: string) { super(message); }
}

/** What to say when the server answered with an error but no usable body (a crash before the API could respond, or a proxy in front of it). */
function fallbackMessage(status: number): string {
  if (status === 502 || status === 503 || status === 504) return "The Control Tower isn't responding properly right now. Try again in a minute; if it persists, check its server log.";
  if (status >= 500) return `The Control Tower hit a problem and gave no details (error ${status}). Its server log has the reason.`;
  return "Something went wrong";
}

/** Calls the Control Tower API. A 401 sends the operator to sign in again. */
export async function call<T = unknown>(path: string, method = "GET", data?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/ops/${path}`, { method, credentials: "same-origin", headers: data !== undefined ? { "content-type": "application/json" } : undefined, body: data !== undefined ? JSON.stringify(data) : undefined });
  } catch { throw new ApiError(0, "NETWORK", "Can't reach the Control Tower. Check your connection."); }
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && path !== "login" && typeof window !== "undefined") window.dispatchEvent(new Event("tower:unauthenticated"));
    throw new ApiError(res.status, json?.error?.code ?? (res.status >= 500 ? "SERVER_ERROR" : "ERROR"), json?.error?.message ?? fallbackMessage(res.status), json?.error?.requestId ?? res.headers.get("x-request-id") ?? undefined);
  }
  return json.data as T;
}

export function useApi<T>(path: string | null, opts: { refreshMs?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) { setData(null); setLoading(false); return; }
    const n = ++seq.current;
    try { const d = await call<T>(path); if (n === seq.current) { setData(d); setError(null); } }
    catch (e) { if (n === seq.current) setError(e as ApiError); }
    finally { if (n === seq.current) setLoading(false); }
  }, [path]);
  useEffect(() => { setLoading(!!path); void load(); }, [load, path]);
  useEffect(() => {
    if (!opts.refreshMs || !path) return;
    const t = setInterval(() => { if (!document.hidden) void load(); }, opts.refreshMs);
    return () => clearInterval(t);
  }, [load, opts.refreshMs, path]);
  return { data, error, loading, reload: load };
}

/** Runs one action at a time, exposing pending/error for the button that triggered it. */
export function useAction<A extends unknown[], R>(fn: (...a: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const run = useCallback(async (...a: A): Promise<R | undefined> => {
    if (busy.current) return undefined;
    busy.current = true; setPending(true); setError(null);
    try { return await fn(...a); } catch (e) { setError((e as Error).message); return undefined; } finally { busy.current = false; setPending(false); }
  }, [fn]);
  return { run, pending, error, clear: () => setError(null) };
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
export const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—");
export const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("en-GB", { dateStyle: "medium" }) : "—");

export type Health = "healthy" | "attention" | "critical" | "silent" | "suspended" | "waiting" | "retired";
export const HEALTH_LABEL: Record<Health, string> = { healthy: "Healthy", attention: "Needs attention", critical: "Critical", silent: "Not reporting", suspended: "Suspended", waiting: "Not registered yet", retired: "Decommissioned" };
export const OFFLINE_AFTER_MS = 15 * 60_000;
export function healthOf(i: { status: string; lastHeartbeatAt: string | null; worstAlert: string | null }, now = Date.now()): Health {
  if (i.status === "DECOMMISSIONED") return "retired";
  if (i.status === "PENDING") return "waiting";
  if (i.status === "SUSPENDED") return "suspended";
  if (i.worstAlert === "CRITICAL") return "critical";
  if (!i.lastHeartbeatAt || now - Date.parse(i.lastHeartbeatAt) > OFFLINE_AFTER_MS) return "silent";
  if (i.worstAlert === "WARNING") return "attention";
  return "healthy";
}
