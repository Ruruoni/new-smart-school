"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown, public requestId?: string) {
    super(message);
  }
  /** Field-level messages from a 422 (path → message). */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    if (Array.isArray(this.details)) for (const d of this.details as { path?: string; message?: string }[]) if (d?.path && d.message && !out[d.path]) out[d.path] = d.message;
    return out;
  }
}

type Body = unknown | FormData;

/**
 * What to say when the server answered with an error but no usable body (a crash before the API could respond, or a proxy in
 * front of it). "Something went wrong" tells nobody anything; say what is known and who can fix it.
 */
function fallbackMessage(status: number): string {
  if (status === 502 || status === 503 || status === 504) return "The school server isn't responding properly right now. Please try again in a minute; if it keeps happening, tell whoever looks after the server.";
  if (status >= 500) return `The school server hit a problem and gave no details (error ${status}). Please tell whoever looks after the server — the reason is in the server's log.`;
  if (status === 404) return "That page or action doesn't exist on this server.";
  return "Something went wrong. Please try again.";
}

async function request<T>(method: string, path: string, body?: Body, init?: { signal?: AbortSignal }): Promise<T> {
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      headers: body !== undefined && !isForm ? { "content-type": "application/json" } : undefined,
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
      signal: init?.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(0, "NETWORK", "Cannot reach the school server. Check your Wi-Fi connection and try again.");
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  const payload = ct.includes("json") ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    const e = payload?.error;
    if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/auth/") && !path.startsWith("/public/")) window.dispatchEvent(new CustomEvent("ss:unauthenticated"));
    if (e?.code === "PASSWORD_CHANGE_REQUIRED" && typeof window !== "undefined") window.dispatchEvent(new CustomEvent("ss:password-change"));
    throw new ApiError(res.status, e?.code ?? (res.status >= 500 ? "SERVER_ERROR" : "ERROR"), e?.message ?? fallbackMessage(res.status), e?.details, e?.requestId ?? res.headers.get("x-request-id") ?? undefined);
  }
  return (payload && "data" in payload ? payload.data : payload) as T;
}

export const api = {
  get: <T,>(path: string, init?: { signal?: AbortSignal }) => request<T>("GET", path, undefined, init),
  post: <T,>(path: string, body?: Body) => request<T>("POST", path, body ?? {}),
  put: <T,>(path: string, body?: Body) => request<T>("PUT", path, body ?? {}),
  patch: <T,>(path: string, body?: Body) => request<T>("PATCH", path, body ?? {}),
  del: <T,>(path: string) => request<T>("DELETE", path),
};

export interface QueryState<T> {
  data: T | undefined;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

/** Fetch a path (null = skip). Cancels stale requests, keeps previous data while reloading (no flicker). */
export function useApi<T>(path: string | null, opts: { refreshMs?: number } = {}): QueryState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [tick, setTick] = useState(0);
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (path === null) { setLoading(false); return; }
    const ctrl = new AbortController();
    if (last.current !== path) setData(undefined);
    last.current = path;
    setLoading(true);
    api.get<T>(path, { signal: ctrl.signal })
      .then((d) => { setData(d); setError(null); })
      .catch((e) => { if ((e as Error).name !== "AbortError") setError(e as ApiError); })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  // Optional live refresh. It pauses while the tab is hidden or the device is offline (no wasted requests on a weak network),
  // and catches up immediately when the person comes back to the tab.
  const { refreshMs } = opts;
  useEffect(() => {
    if (!refreshMs || path === null) return;
    const due = () => { if (!document.hidden && navigator.onLine) setTick((t) => t + 1); };
    const t = setInterval(due, refreshMs);
    document.addEventListener("visibilitychange", due);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", due); };
  }, [refreshMs, path]);
  return { data, error, loading, reload };
}

export interface MutationState<A extends unknown[], R> {
  run: (...args: A) => Promise<R | undefined>;
  pending: boolean;
  error: ApiError | null;
  reset: () => void;
}

/** Wrap an async action: tracks pending/error and prevents double submission. */
export function useMutation<A extends unknown[], R>(fn: (...args: A) => Promise<R>): MutationState<A, R> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const busy = useRef(false);
  const run = useCallback(async (...args: A) => {
    if (busy.current) return undefined;
    busy.current = true; setPending(true); setError(null);
    try { return await fn(...args); }
    catch (e) { setError(e instanceof ApiError ? e : new ApiError(0, "ERROR", (e as Error).message)); return undefined; }
    finally { busy.current = false; setPending(false); }
  }, [fn]);
  return { run, pending, error, reset: () => setError(null) };
}

export const qs = (o: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};
