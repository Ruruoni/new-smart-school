/** Structured, safe-to-show errors. Anything that is not an AppError is reported as a generic 500. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/**
 * The server cannot run because its configuration is incomplete or invalid (missing/invalid environment variables).
 * `issues` name the variables and the problem for the SERVER LOG only; the message shown to people is deliberately generic
 * (it must not teach an anonymous visitor which settings exist) but tells them where the real answer is.
 */
export class ConfigError extends AppError {
  constructor(public readonly issues: string[]) {
    super("SERVER_MISCONFIGURED", "This server isn't set up correctly yet. Please tell whoever installed it to check the server's log for the exact problem.", 503);
    this.name = "ConfigError";
  }
}

export const unauthenticated = (msg = "Please sign in to continue") => new AppError("UNAUTHENTICATED", msg, 401);
export const forbidden = (msg = "You do not have permission to do that", details?: unknown) =>
  new AppError("FORBIDDEN", msg, 403, details);
export const notFound = (what = "Resource") => new AppError("NOT_FOUND", `${what} was not found`, 404);
export const conflict = (msg: string, details?: unknown) => new AppError("CONFLICT", msg, 409, details);
export const validation = (msg: string, details?: unknown) => new AppError("VALIDATION", msg, 422, details);
export const moduleDisabled = (module: string) =>
  new AppError("MODULE_DISABLED", `The ${module} module is not enabled for this school`, 403, { module });
export const featureDisabled = (feature: string) =>
  new AppError("FEATURE_DISABLED", `This feature is not available (${feature})`, 403, { feature });
export const licenseRestricted = (msg = "This school's license does not allow that action") =>
  new AppError("LICENSE_RESTRICTED", msg, 402);
export const financialLockout = (details: unknown) =>
  new AppError(
    "FINANCIAL_LOCKOUT",
    "Results are unavailable until outstanding school fees are settled. Please contact the bursar.",
    403,
    details,
  );
export const rateLimited = (retryAfterSec: number) =>
  new AppError("RATE_LIMITED", "Too many attempts. Please wait and try again.", 429, { retryAfterSec });
export const staleWrite = (entity: string, currentVersion: number) =>
  new AppError("STALE_WRITE", `${entity} was changed by someone else. Reload and try again.`, 409, { currentVersion });

import { ZodError } from "zod";
import { classifyInfrastructureError, redactSecrets, type InfrastructureCode } from "@smartschool/protocol";

export interface SafeError {
  status: number;
  body: { error: { code: string; message: string; details?: unknown; requestId: string } };
}

/** Convert anything thrown into a response body that never leaks internals. */
export { redactSecrets, classifyInfrastructureError, type InfrastructureCode };

const lastLogged = new Map<string, number>();
/**
 * A server that is misconfigured or has lost its database fails the SAME way on every request and every health poll. Log the full
 * detail once per `windowMs` per distinct problem and stay quiet in between, so the one useful line isn't buried under thousands.
 * Returns whether the caller should log.
 */
export function shouldLogRepeated(key: string, windowMs = 30_000, now = Date.now()): boolean {
  const last = lastLogged.get(key);
  if (last !== undefined && now - last < windowMs) return false;
  lastLogged.set(key, now);
  return true;
}

/** One JSON line per server-side error, with the request id that the user was shown, so "Reference: 1a2b3c4d" finds it. */
export function logServerError(requestId: string, err: unknown, extra: Record<string, unknown> = {}) {
  const e = err instanceof Error ? err : new Error(String(err));
  console.error(JSON.stringify({ level: "error", time: new Date().toISOString(), requestId, error: e.name, code: (e as { code?: string }).code, message: redactSecrets(e.message).slice(0, 1500), ...(e instanceof ConfigError ? { issues: e.issues } : {}), ...extra, stack: redactSecrets(String(e.stack ?? "")).split("\n").slice(0, 8).join("\n") }));
}

export function toSafeError(err: unknown, requestId: string, log: (e: unknown) => void = (e) => logServerError(requestId, e)): SafeError {
  if (err instanceof AppError) {
    if (err instanceof ConfigError ? shouldLogRepeated("config") : err.status >= 500) log(err);
    return { status: err.status, body: { error: { code: err.code, message: err.message, details: err.details, requestId } } };
  }
  const infra = classifyInfrastructureError(err);
  if (infra) {
    if (shouldLogRepeated(`infra:${infra.code}`)) log(err);
    return { status: 503, body: { error: { code: infra.code, message: infra.message, requestId } } };
  }
  if (err instanceof ZodError) {
    return { status: 422, body: { error: { code: "VALIDATION", message: "Please correct the highlighted fields", details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })), requestId } } };
  }
  // Prisma refused the arguments themselves (e.g. a required id was missing from the request): that is a bad request, not a server fault.
  if ((err as { name?: string } | null)?.name === "PrismaClientValidationError") {
    return { status: 422, body: { error: { code: "VALIDATION", message: "Some required information is missing or invalid", requestId } } };
  }
  const prisma = err as { code?: string; meta?: { target?: unknown } };
  if (prisma?.code === "P2002") return { status: 409, body: { error: { code: "CONFLICT", message: "That record already exists", requestId } } };
  // A malformed id (e.g. "abc" where a UUID is required) can never match a record.
  if (prisma?.code === "P2007") { // the database rejected a value's format
    const isUuid = /type uuid/i.test(String((err as Error).message));
    return isUuid ? { status: 404, body: { error: { code: "NOT_FOUND", message: "Record not found", requestId } } } : { status: 422, body: { error: { code: "VALIDATION", message: "Some information is not in a valid format", requestId } } };
  }
  if (prisma?.code === "P2023") return { status: 404, body: { error: { code: "NOT_FOUND", message: "Record not found", requestId } } };
  if (prisma?.code === "P2025") return { status: 404, body: { error: { code: "NOT_FOUND", message: "Record not found", requestId } } };
  if (prisma?.code === "P2003") return { status: 409, body: { error: { code: "CONFLICT", message: "This record is still in use by other records", requestId } } };
  log(err);
  return {
    status: 500,
    body: { error: { code: "INTERNAL", message: "Something went wrong. Please try again.", requestId } },
  };
}
