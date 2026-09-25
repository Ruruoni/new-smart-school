import { randomUUID } from "node:crypto";
import { db } from "../db";
import { audit, auditStandalone, type AuditEntry } from "../audit";
import { AppError, featureDisabled, forbidden, licenseRestricted, moduleDisabled, toSafeError, unauthenticated, validation } from "../errors";
import { SESSION_COOKIE, validateSession } from "../auth/service";
import { currentLicense } from "../license";
import { isFeatureEnabled, isModuleEnabled, type FeatureKey } from "../features";
import type { ModuleKey } from "../rbac/catalog";
import { buildContext, type SecurityContext } from "./context";
import type { z } from "zod";
import type { Tx } from "../db";

/**
 * A business-policy check that runs after RBAC (e.g. the financial lockout). Policies are NOT permissions:
 * they depend on data (fees owed), not on who the user is. Implemented server-side, per request.
 */
export type Policy<I = unknown> = (ctx: SecurityContext, input: I) => Promise<void>;

export interface GuardOptions {
  /** Module that must be enabled + licensed. */
  module?: ModuleKey;
  feature?: FeatureKey;
  /** User needs ANY of these permissions (RBAC). Omit only for endpoints open to every signed-in user. */
  permission?: string | readonly string[];
  /** Declare a mutating operation explicitly; defaults to "method is not GET/HEAD". */
  write?: boolean;
  /** Allowed while the license is READ_ONLY / ADMIN_ONLY (license, backup, export, password-change routes). */
  licenseExempt?: boolean;
  /** Allowed while `mustChangePassword` is set. */
  allowPasswordChangePending?: boolean;
  policies?: readonly Policy<never>[];
}

export type RawRequest = { method: string; headers: Headers; url: string };

function cookieValue(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export function clientIp(h: Headers): string | null {
  // Behind the school's reverse proxy the first hop is authoritative; otherwise this is best-effort.
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
}

/** CSRF defence in depth on top of SameSite=Lax: mutating requests must originate from our own origin. */
export function assertSameOrigin(req: RawRequest) {
  const m = req.method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return;
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (origin) {
    let o: URL;
    try {
      o = new URL(origin);
    } catch {
      throw forbidden("Cross-origin request blocked");
    }
    if (host && o.host !== host) throw forbidden("Cross-origin request blocked");
    return;
  }
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw forbidden("Cross-origin request blocked");
}

const norm = (p: GuardOptions["permission"]): readonly string[] => (p === undefined ? [] : typeof p === "string" ? [p] : p);

/**
 * The single choke point every protected operation passes through. Order matters and is fixed:
 * authentication → installation → license mode → module → feature → RBAC → (caller runs policies).
 */
export async function authorize(opts: GuardOptions, req: RawRequest, requestId = randomUUID()): Promise<SecurityContext> {
  const method = req.method.toUpperCase();
  const isWrite = opts.write ?? !(method === "GET" || method === "HEAD");
  const ip = clientIp(req.headers);

  assertSameOrigin(req);

  // 1. Authentication
  const session = await validateSession(cookieValue(req.headers.get("cookie"), SESSION_COOKIE));
  if (!session) throw unauthenticated();
  const { user } = session;

  // 2. Installation context
  const inst = await db.schoolInstallation.findFirst({ select: { id: true, installationCode: true, schoolName: true } });
  if (!inst) throw new AppError("NOT_INSTALLED", "This school installation has not been set up yet", 503);

  // 3. License / operating mode
  const license = await currentLicense();
  if (!opts.licenseExempt) {
    if (license.mode === "ADMIN_ONLY" && !user.isPrimaryAdmin) {
      throw new AppError("INSTALLATION_SUSPENDED", license.message ?? "This installation is suspended", 503);
    }
    if (license.mode !== "FULL" && isWrite) throw licenseRestricted(license.message ?? undefined);
  }

  // 4–5. Module and feature availability
  if (opts.module && !(await isModuleEnabled(opts.module))) throw moduleDisabled(opts.module);
  if (opts.feature && !(await isFeatureEnabled(opts.feature))) throw featureDisabled(opts.feature);

  // Forced password change blocks everything else.
  if (user.mustChangePassword && !opts.allowPasswordChangePending) {
    throw new AppError("PASSWORD_CHANGE_REQUIRED", "You must change your password before continuing", 403);
  }

  // 6. RBAC — load grants
  const roles = await db.userRole.findMany({
    where: { userId: user.id },
    select: { scopeType: true, scopeId: true, role: { select: { permissions: { select: { permission: { select: { key: true } } } } } } },
  });
  const permissions = new Set<string>();
  const scoped = new Map<string, Set<string>>();
  for (const r of roles) {
    for (const rp of r.role.permissions) {
      const key = rp.permission.key;
      if (r.scopeType === "*") permissions.add(key);
      else (scoped.get(key) ?? scoped.set(key, new Set()).get(key)!).add(`${r.scopeType}:${r.scopeId}`);
    }
  }
  const ctx = buildContext({
    requestId, ip, sessionId: session.sessionId,
    user: { id: user.id, username: user.username, name: `${user.firstName} ${user.lastName}`, userType: user.userType, isPrimaryAdmin: user.isPrimaryAdmin, mustChangePassword: user.mustChangePassword },
    installation: { id: inst.id, code: inst.installationCode, schoolName: inst.schoolName },
    license, permissions, scopedPermissions: scoped,
  });

  const needed = norm(opts.permission);
  if (needed.length && !needed.some((p) => ctx.can(p) || ctx.scopedPermissions.has(p))) {
    await auditStandalone({ actorId: user.id, actorName: ctx.user.name, action: "security.denied", module: opts.module ?? "platform", metadata: { permission: needed, method, url: new URL(req.url).pathname }, ip });
    throw forbidden(undefined, { permission: needed });
  }
  return ctx;
}

export interface RouteHandlerCtx {
  params: Promise<Record<string, string | string[]>>;
}

/**
 * Wrap a Next.js route handler. The handler receives a fully-authorized context; its return value is
 * serialised as `{ data }` (or returned as-is when it is already a Response). Errors become safe JSON.
 */
export function secure<R>(
  opts: GuardOptions,
  handler: (a: { ctx: SecurityContext; req: Request; params: Record<string, string | string[]> }) => Promise<R | Response>,
) {
  return async (req: Request, routeCtx?: RouteHandlerCtx): Promise<Response> => {
    const requestId = randomUUID();
    try {
      const ctx = await authorize(opts, req, requestId);
      const params = routeCtx ? await routeCtx.params : {};
      for (const policy of opts.policies ?? []) await (policy as Policy<unknown>)(ctx, { req, params });
      const out = await handler({ ctx, req, params });
      const res = out instanceof Response ? out : Response.json({ data: out ?? null });
      res.headers.set("x-request-id", requestId);
      res.headers.set("cache-control", "no-store");
      return res;
    } catch (err) {
      const safe = toSafeError(err, requestId);
      return Response.json(safe.body, { status: safe.status, headers: { "x-request-id": requestId, "cache-control": "no-store" } });
    }
  };
}

/** Parse + validate a JSON body with zod, producing a 422 with field errors instead of a 500. */
export async function parseBody<S extends z.ZodType>(req: Request, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw validation("Request body must be valid JSON");
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw validation("Please correct the highlighted fields", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return r.data;
}

export function parseQuery<S extends z.ZodType>(req: Request, schema: S): z.infer<S> {
  const obj: Record<string, string> = {};
  new URL(req.url).searchParams.forEach((v, k) => (obj[k] = v));
  const r = schema.safeParse(obj);
  if (!r.success) throw validation("Invalid query parameters", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return r.data;
}

/** Convenience for handlers that audit inside their own transaction. */
export const auditIn = (tx: Tx, ctx: SecurityContext, e: Omit<AuditEntry, "actorId" | "actorName" | "ip">) =>
  audit(tx, { ...e, actorId: ctx.user.id, actorName: ctx.user.name, ip: ctx.ip });
