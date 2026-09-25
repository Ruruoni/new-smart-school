import { ZodError } from "zod";
import { classifyInfrastructureError, redactSecrets } from "@smartschool/protocol";
export class CloudError extends Error {
  constructor(public code: string, message: string, public status = 400, public details?: unknown) { super(message); }
}
/** The Control Tower cannot run: its configuration is incomplete or invalid. `issues` (names + problems, never values) go to the log only. */
export class CloudConfigError extends CloudError {
  constructor(public readonly issues: string[]) {
    super("SERVER_MISCONFIGURED", "The Control Tower isn't set up correctly yet. Whoever runs it should check its server log for the exact problem.", 503);
  }
}

export const unauthorized = (m = "Unauthorized") => new CloudError("UNAUTHORIZED", m, 401);
export const forbidden = (m = "Forbidden") => new CloudError("FORBIDDEN", m, 403);
export const notFound = (w = "Resource") => new CloudError("NOT_FOUND", `${w} was not found`, 404);
export const conflictErr = (m: string) => new CloudError("CONFLICT", m, 409);
export const badRequest = (m: string, details?: unknown) => new CloudError("BAD_REQUEST", m, 400, details);

const lastLogged = new Map<string, number>();
/** Log the full detail once per `windowMs` per distinct problem: a broken server fails identically on every request and health poll. */
export function shouldLogRepeated(key: string, windowMs = 30_000, now = Date.now()): boolean {
  const last = lastLogged.get(key);
  if (last !== undefined && now - last < windowMs) return false;
  lastLogged.set(key, now);
  return true;
}

/** One JSON line per server-side error; the request id in it is the one shown to the person, so a reported reference finds this line. */
export function logServerError(requestId: string, err: unknown, extra: Record<string, unknown> = {}) {
  const e = err instanceof Error ? err : new Error(String(err));
  console.error(JSON.stringify({ level: "error", time: new Date().toISOString(), requestId, error: e.name, code: (e as { code?: string }).code, message: redactSecrets(e.message).slice(0, 1500), ...(e instanceof CloudConfigError ? { issues: e.issues } : {}), ...extra, stack: redactSecrets(String(e.stack ?? "")).split("\n").slice(0, 8).join("\n") }));
}

export function errorResponse(err: unknown): Response {
  const requestId = crypto.randomUUID();
  const h = { "x-request-id": requestId, "cache-control": "no-store" };
  if (err instanceof CloudError) {
    if (err instanceof CloudConfigError ? shouldLogRepeated("config") : err.status >= 500) logServerError(requestId, err);
    return Response.json({ error: { code: err.code, message: err.message, details: err.details, requestId: err.status >= 500 ? requestId : undefined } }, { status: err.status, headers: h });
  }
  const infra = classifyInfrastructureError(err);
  if (infra) { if (shouldLogRepeated(`infra:${infra.code}`)) logServerError(requestId, err); return Response.json({ error: { code: infra.code, message: infra.message, requestId } }, { status: 503, headers: h }); }
  if ((err as { code?: string } | null)?.code === "P2025") return Response.json({ error: { code: "NOT_FOUND", message: "That record was not found" } }, { status: 404 });
  if (err instanceof ZodError) return Response.json({ error: { code: "BAD_REQUEST", message: err.issues[0]?.message ?? "Invalid request", details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } }, { status: 400 });
  logServerError(requestId, err);
  return Response.json({ error: { code: "INTERNAL", message: "Something went wrong", requestId } }, { status: 500, headers: h });
}
