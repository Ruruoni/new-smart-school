import { SIG_HEADERS, signBody } from "@smartschool/protocol";
import { db } from "@/platform/db";
import { decryptSecret } from "@/platform/crypto";
import { env } from "@/platform/env";

export class CloudUnreachable extends Error {}
export class CloudRejected extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

export interface CloudConfig {
  url: string;
  code: string;
  secret: string;
}

/** Null when this installation has not been registered with a control plane (fully offline school). */
export async function cloudConfig(): Promise<CloudConfig | null> {
  const inst = await db.schoolInstallation.findFirst({ select: { installationCode: true, cloudSecretEnc: true, cloudUrl: true } });
  const url = inst?.cloudUrl || env().CLOUD_URL;
  if (!inst?.cloudSecretEnc || !url) return null;
  return { url: url.replace(/\/$/, ""), code: inst.installationCode, secret: decryptSecret(inst.cloudSecretEnc) };
}

const TIMEOUT_MS = 20_000;

async function fetchJson(url: string, init: RequestInit): Promise<{ status: number; json: Record<string, unknown> }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json };
  } catch (err) {
    throw new CloudUnreachable((err as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

/** Signed POST to the control plane. Network failures → CloudUnreachable (retryable); 4xx/5xx → CloudRejected. */
export async function signedPost<T>(cfg: CloudConfig, path: string, payload: unknown): Promise<T> {
  const body = JSON.stringify(payload);
  const ts = String(Date.now());
  const { status, json } = await fetchJson(`${cfg.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", [SIG_HEADERS.installation]: cfg.code, [SIG_HEADERS.timestamp]: ts, [SIG_HEADERS.signature]: signBody(cfg.secret, ts, body) },
    body,
  });
  if (status >= 200 && status < 300) return json as T;
  const e = (json.error ?? {}) as { code?: string; message?: string };
  throw new CloudRejected(status, e.message ?? `Cloud returned ${status}`, e.code);
}

/** Unauthenticated registration call (the one-time token is the credential). */
export async function postRegistration<T>(url: string, payload: unknown): Promise<T> {
  const { status, json } = await fetchJson(`${url.replace(/\/$/, "")}/api/v1/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  if (status >= 200 && status < 300) return json as T;
  const e = (json.error ?? {}) as { code?: string; message?: string };
  throw new CloudRejected(status, e.message ?? `Cloud returned ${status}`, e.code);
}

export async function signedUpload(cfg: CloudConfig, path: string, opts: { stream: ReadableStream; sha256: string; name: string; size: number }): Promise<Record<string, unknown>> {
  const ts = String(Date.now());
  const { status, json } = await fetchJson(`${cfg.url}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream", "content-length": String(opts.size), [SIG_HEADERS.installation]: cfg.code, [SIG_HEADERS.timestamp]: ts, [SIG_HEADERS.signature]: signBody(cfg.secret, ts, `${opts.sha256}|${opts.name}|${opts.size}`), "x-backup-sha256": opts.sha256, "x-backup-name": opts.name },
    body: opts.stream,
    // @ts-expect-error Node's fetch requires duplex for streamed request bodies
    duplex: "half",
  });
  if (status >= 200 && status < 300) return json;
  throw new CloudRejected(status, String((json.error as { message?: string } | undefined)?.message ?? `Cloud returned ${status}`));
}
