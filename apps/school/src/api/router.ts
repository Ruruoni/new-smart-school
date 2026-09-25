import { randomUUID } from "node:crypto";
import { secure, type GuardOptions } from "@/platform/security/interceptor";
import type { SecurityContext } from "@/platform/security/context";
import { AppError, toSafeError } from "@/platform/errors";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface HandlerArgs {
  ctx: SecurityContext;
  req: Request;
  params: Record<string, string>;
  url: URL;
  query: URLSearchParams;
}

export interface PublicArgs {
  req: Request;
  params: Record<string, string>;
  url: URL;
  ip: string | null;
}

export type RouteDef =
  | { method: Method; path: string; guard: GuardOptions; handler: (a: HandlerArgs) => Promise<unknown> }
  | { method: Method; path: string; guard: "public"; handler: (a: PublicArgs) => Promise<unknown> };

/** Declarative route helpers: every protected route MUST state its guard, so nothing is accidentally unprotected. */
export const route = (method: Method, path: string, guard: GuardOptions, handler: (a: HandlerArgs) => Promise<unknown>): RouteDef => ({ method, path, guard, handler });
export const publicRoute = (method: Method, path: string, handler: (a: PublicArgs) => Promise<unknown>): RouteDef => ({ method, path, guard: "public", handler });

interface Compiled {
  def: RouteDef;
  segments: string[];
  run: (req: Request, params: Record<string, string>) => Promise<Response>;
}

function compile(def: RouteDef): Compiled {
  const segments = def.path.split("/").filter(Boolean);
  if (def.guard === "public") {
    const h = def.handler;
    return {
      def, segments,
      run: async (req, params) => {
        const requestId = randomUUID();
        try {
          const out = await h({ req, params, url: new URL(req.url), ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip") ?? null });
          const res = out instanceof Response ? out : Response.json({ data: out ?? null });
          res.headers.set("cache-control", "no-store");
          res.headers.set("x-request-id", requestId);
          return res;
        } catch (err) {
          const safe = toSafeError(err, requestId);
          return Response.json(safe.body, { status: safe.status, headers: { "x-request-id": requestId, "cache-control": "no-store" } });
        }
      },
    };
  }
  const h = def.handler;
  const guarded = secure(def.guard, async ({ ctx, req, params }) => h({ ctx, req, params: params as Record<string, string>, url: new URL(req.url), query: new URL(req.url).searchParams }));
  return { def, segments, run: (req, params) => guarded(req, { params: Promise.resolve(params) }) };
}

const hasNul = (s: string) => s.includes("\u0000");
function badAddress(): Response {
  const requestId = randomUUID();
  const safe = toSafeError(new AppError("VALIDATION", "The address contains characters that are not allowed", 422), requestId);
  return Response.json(safe.body, { status: safe.status, headers: { "x-request-id": requestId, "cache-control": "no-store" } });
}

export function createRouter(defs: RouteDef[]) {
  const table = defs.map(compile);
  // Fail fast on ambiguous duplicates at start-up rather than at 2am in production.
  const seen = new Set<string>();
  for (const d of defs) { const k = `${d.method} ${d.path}`; if (seen.has(k)) throw new Error(`Duplicate route ${k}`); seen.add(k); }

  return async function handle(req: Request, pathSegments: string[]): Promise<Response> {
    const method = req.method.toUpperCase();
    let pathMatched = false;
    for (const r of table) {
      if (r.segments.length !== pathSegments.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < r.segments.length; i++) {
        const seg = r.segments[i]!;
        if (seg.startsWith(":")) { try { params[seg.slice(1)] = decodeURIComponent(pathSegments[i]!); } catch { return badAddress(); } }
        else if (seg !== pathSegments[i]) { ok = false; break; }
      }
      if (!ok) continue;
      pathMatched = true;
      if (r.def.method !== method) continue;
      // PostgreSQL cannot store NUL characters; refuse them up front (in the address or the query string) instead of failing deep inside a query.
      if (Object.values(params).some(hasNul) || [...new URL(req.url).searchParams].some(([k, v]) => hasNul(k) || hasNul(v))) return badAddress();
      return r.run(req, params);
    }
    const requestId = randomUUID();
    const err = pathMatched ? new AppError("METHOD_NOT_ALLOWED", "Method not allowed", 405) : new AppError("NOT_FOUND", "Endpoint not found", 404);
    const safe = toSafeError(err, requestId);
    return Response.json(safe.body, { status: safe.status });
  };
}

// ── input helpers ──
export async function json<T = unknown>(req: Request): Promise<T> {
  let body: unknown;
  let text: string;
  try { text = await req.text(); body = JSON.parse(text); } catch { throw new AppError("VALIDATION", "Request body must be valid JSON", 422); }
  if (/\\u0000/i.test(text)) throw new AppError("VALIDATION", "Text contains characters that cannot be stored", 422); // NUL in any string
  // Every endpoint takes an object. Rejecting null / arrays / scalars here means no service ever destructures a non-object.
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new AppError("VALIDATION", "Request body must be a JSON object", 422);
  return body as T;
}

export const MAX_UPLOAD = 12 * 1024 * 1024;
export async function readUpload(req: Request, field = "file") {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_UPLOAD + 100_000) throw new AppError("FILE_TOO_LARGE", "File is too large", 413);
  let form: FormData;
  try { form = await req.formData(); } catch { throw new AppError("VALIDATION", "Expected a multipart file upload", 422); }
  const f = form.get(field);
  if (!(f instanceof File)) throw new AppError("VALIDATION", "No file was uploaded", 422);
  if (f.size > MAX_UPLOAD) throw new AppError("FILE_TOO_LARGE", "File is too large", 413);
  return { file: { data: Buffer.from(await f.arrayBuffer()), originalName: f.name, declaredMime: f.type || null }, form };
}

export const asInt = (v: string | null, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d; };
export const pick = (q: URLSearchParams) => Object.fromEntries(q.entries());
