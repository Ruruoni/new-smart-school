import { cookieShouldBeSecure } from "@smartschool/protocol";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { z } from "zod";
import { db } from "./db";
import { env } from "./env";
import { cloudAudit } from "./audit";
import { CloudError, badRequest, conflictErr, errorResponse, notFound } from "./errors";
import * as inst from "./installations";
import { acknowledgeAlert } from "./alerts";
import { resolveCloudConflicts, syncStats } from "./sync";
import { SESSION_COOKIE, authorizeOperator, createOperator, operatorLogin, operatorLogout } from "./operators";
import type { Operator, OperatorRole } from "@cloud/generated/prisma/client";

/**
 * The Developer Control Tower's own API (session-cookie authenticated operators; the schools use /api/v1 with signed requests).
 * Every route names the minimum role it needs. Every change is written to the append-only cloud audit log by the service it calls.
 */

const ipOf = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip") ?? null;
const ok = (data: unknown, status = 200, headers: Record<string, string> = {}) => Response.json({ data }, { status, headers: { "cache-control": "no-store", ...headers } });
const sessionCookie = (token: string, maxAgeSec: number, req: Request) => `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${cookieShouldBeSecure(env().SESSION_COOKIE_SECURE, req) ? "; Secure" : ""}`;

async function body<T = Record<string, unknown>>(req: Request): Promise<T> {
  try { return (await req.json()) as T; } catch { throw badRequest("Body must be JSON"); }
}
const uuid = z.string().uuid();
const actorOf = (op: Operator, req: Request) => ({ operatorId: op.id, operatorEmail: op.email, ip: ipOf(req) });

interface Ctx { req: Request; params: Record<string, string>; query: URLSearchParams; op: Operator }
interface Route { method: string; pattern: string[]; role: OperatorRole | null; run: (c: Ctx) => Promise<Response | unknown> }
const routes: Route[] = [];
const route = (method: string, path: string, role: OperatorRole | null, run: Route["run"]) => routes.push({ method, pattern: path.split("/").filter(Boolean), role, run });

// ───────── session ─────────
route("GET", "/me", "VIEWER", async ({ op }) => ({ id: op.id, email: op.email, name: op.name, role: op.role }));
route("GET", "/overview", "VIEWER", async () => {
  const [byStatus, alerts, conflicts, students, latest] = await Promise.all([
    db.installation.groupBy({ by: ["status"], _count: true }),
    db.alert.groupBy({ by: ["severity"], where: { resolvedAt: null }, _count: true }),
    db.cloudConflict.count({ where: { resolvedAt: null } }),
    db.installation.aggregate({ _sum: { studentCount: true }, where: { status: { in: ["ACTIVE", "SUSPENDED"] } } }),
    db.release.findFirst({ orderBy: { publishedAt: "desc" } }),
  ]);
  return { installations: Object.fromEntries(byStatus.map((s) => [s.status, s._count])), openAlerts: Object.fromEntries(alerts.map((a) => [a.severity, a._count])), openConflicts: conflicts, students: students._sum.studentCount ?? 0, latestVersion: latest?.version ?? null };
});

// ───────── installations ─────────
route("GET", "/installations", "VIEWER", async () => (await inst.listInstallations()).map((i) => {
  const { secretEnc: _s, featureOverrides: _f, lastMetrics: m, alerts, _count, ...rest } = i;
  const worst = alerts.some((a) => a.severity === "CRITICAL") ? "CRITICAL" : alerts.some((a) => a.severity === "WARNING") ? "WARNING" : alerts.length ? "INFO" : null;
  return { ...rest, openAlerts: alerts.length, worstAlert: worst, openConflicts: _count.conflicts, queuePending: (m as { queuePending?: number } | null)?.queuePending ?? null };
}));
route("POST", "/installations", "SUPPORT", async ({ req, op }) => {
  const r = await inst.createInstallation(actorOf(op, req), await body(req) as never);
  const { secretEnc: _s, ...safe } = r.installation;
  return Response.json({ data: { installation: safe, registrationToken: r.registrationToken } }, { status: 201, headers: { "cache-control": "no-store" } });
});
route("GET", "/installations/:id", "VIEWER", async ({ params }) => {
  const id = uuid.parse(params.id);
  const i = await inst.getInstallation(id); // 404 first, before anything else runs
  const [sync, backups, audit, flags, latest] = await Promise.all([
    syncStats(id),
    db.backupUpload.findMany({ where: { installationId: id }, orderBy: { receivedAt: "desc" }, take: 10, select: { id: true, fileName: true, sizeBytes: true, receivedAt: true, sha256: true } }),
    db.cloudAudit.findMany({ where: { installationId: id }, orderBy: { seq: "desc" }, take: 25 }),
    inst.effectiveFlags(i),
    db.release.findFirst({ orderBy: { publishedAt: "desc" } }),
  ]);
  const pendingToken = await db.registrationToken.findFirst({ where: { installationId: id, usedAt: null, expiresAt: { gt: new Date() } }, select: { expiresAt: true } });
  return { installation: i, sync, backups: backups.map((b) => ({ ...b, sizeBytes: Number(b.sizeBytes) })), audit: audit.map((a) => ({ ...a, seq: Number(a.seq) })), flags, latestVersion: latest?.version ?? null, registrationTokenExpiresAt: pendingToken?.expiresAt ?? null, moduleCatalogue: inst.MODULE_KEYS };
});
route("POST", "/installations/:id/token", "SUPPORT", async ({ req, params, op }) => ({ registrationToken: await inst.reissueRegistrationToken(actorOf(op, req), uuid.parse(params.id)) }));
route("PUT", "/installations/:id/license", "SUPER_ADMIN", async ({ req, params, op }) => { const { secretEnc: _s, ...a } = await inst.updateLicense(actorOf(op, req), uuid.parse(params.id), await body(req) as never); return a; });
route("PUT", "/installations/:id/flags", "SUPPORT", async ({ req, params, op }) => {
  const b = z.object({ key: z.string(), enabled: z.boolean().nullable() }).parse(await body(req));
  await inst.setFeatureOverride(actorOf(op, req), uuid.parse(params.id), b.key, b.enabled);
  return { ok: true };
});
route("POST", "/installations/:id/suspend", "SUPER_ADMIN", async ({ req, params, op }) => { await inst.suspendInstallation(actorOf(op, req), uuid.parse(params.id), z.object({ reason: z.string() }).parse(await body(req)).reason); return { ok: true }; });
route("POST", "/installations/:id/resume", "SUPER_ADMIN", async ({ req, params, op }) => { await inst.resumeInstallation(actorOf(op, req), uuid.parse(params.id)); return { ok: true }; });
route("POST", "/installations/:id/decommission", "SUPER_ADMIN", async ({ req, params, op }) => { await inst.decommissionInstallation(actorOf(op, req), uuid.parse(params.id), z.object({ reason: z.string() }).parse(await body(req)).reason); return { ok: true }; });
route("POST", "/installations/:id/commands", "SUPPORT", async ({ req, params, op }) => {
  const b = z.object({ cmd: z.enum(["MESSAGE", "REQUEST_BACKUP", "REQUEST_DIAGNOSTICS"]), text: z.string().trim().max(500).optional() }).parse(await body(req));
  if (b.cmd === "MESSAGE" && !b.text) throw badRequest("Write the message to show the school");
  const c = await inst.issueCommand(actorOf(op, req), uuid.parse(params.id), b.cmd, b.cmd === "MESSAGE" ? { text: b.text } : {});
  return { id: c.id, type: c.type, expiresAt: c.expiresAt };
});
route("PUT", "/installations/:id/notes", "SUPPORT", async ({ req, params, op }) => {
  const id = uuid.parse(params.id);
  const notes = z.object({ notes: z.string().max(4000) }).parse(await body(req)).notes;
  await db.installation.update({ where: { id }, data: { notes } }).catch(() => { throw notFound("Installation"); });
  await cloudAudit(db, { ...actorOf(op, req), action: "installation.notes", installationId: id });
  return { ok: true };
});

// ───────── alerts / conflicts ─────────
route("GET", "/alerts", "VIEWER", async ({ query }) => {
  const all = query.get("state") === "all";
  const rows = await db.alert.findMany({ where: all ? {} : { resolvedAt: null }, orderBy: [{ resolvedAt: { sort: "asc", nulls: "first" } }, { openedAt: "desc" }], take: 200, include: { installation: { select: { id: true, code: true, schoolName: true } } } });
  const rank = { CRITICAL: 0, WARNING: 1, INFO: 2 } as const;
  return rows.sort((a, b) => Number(!!a.resolvedAt) - Number(!!b.resolvedAt) || rank[a.severity] - rank[b.severity]);
});
route("POST", "/alerts/:id/ack", "SUPPORT", async ({ req, params, op }) => {
  const id = uuid.parse(params.id);
  const a = await db.alert.findUnique({ where: { id } });
  if (!a) throw notFound("Alert");
  await acknowledgeAlert(id);
  await cloudAudit(db, { ...actorOf(op, req), action: "alert.acknowledge", installationId: a.installationId, detail: { kind: a.kind } });
  return { ok: true };
});
route("GET", "/conflicts", "VIEWER", async () => db.cloudConflict.findMany({ where: { resolvedAt: null }, orderBy: { detectedAt: "desc" }, take: 200, include: { installation: { select: { id: true, code: true, schoolName: true } } } }));
route("POST", "/conflicts/:id/resolve", "SUPPORT", async ({ req, params, op }) => {
  const c = await db.cloudConflict.findUnique({ where: { id: uuid.parse(params.id) } });
  if (!c) throw notFound("Conflict");
  await resolveCloudConflicts(c.installationId, c.entityType, c.entityId);
  await cloudAudit(db, { ...actorOf(op, req), action: "conflict.resolve", installationId: c.installationId, detail: { entityType: c.entityType, entityId: c.entityId } });
  return { ok: true };
});

// ───────── global flags, releases ─────────
route("GET", "/flags", "VIEWER", async () => db.globalFlag.findMany({ orderBy: { key: "asc" } }));
route("PUT", "/flags", "SUPER_ADMIN", async ({ req, op }) => {
  const b = z.object({ key: z.string(), enabled: z.boolean(), description: z.string().max(200).optional() }).parse(await body(req));
  return inst.setGlobalFlag(actorOf(op, req), b.key, b.enabled, b.description);
});
route("GET", "/releases", "VIEWER", async () => db.release.findMany({ orderBy: { publishedAt: "desc" }, take: 50 }));
route("POST", "/releases", "SUPER_ADMIN", async ({ req, op }) => {
  const b = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/, "Use a version like 2.1.0"), notes: z.string().max(2000).optional(), mandatory: z.boolean().default(false) }).parse(await body(req));
  if (await db.release.findUnique({ where: { version: b.version } })) throw conflictErr(`Version ${b.version} is already published`);
  const r = await db.release.create({ data: b });
  await cloudAudit(db, { ...actorOf(op, req), action: "release.publish", detail: { version: b.version, mandatory: b.mandatory } });
  return Response.json({ data: r }, { status: 201 });
});

// ───────── operators, audit, backups ─────────
route("GET", "/operators", "SUPER_ADMIN", async () => (await db.operator.findMany({ orderBy: { createdAt: "asc" } })).map(({ passwordHash: _p, ...o }) => o));
route("POST", "/operators", "SUPER_ADMIN", async ({ req, op }) => {
  const { passwordHash: _p, ...o } = await createOperator(await body(req) as never, { operatorId: op.id, operatorEmail: op.email });
  return Response.json({ data: o }, { status: 201 });
});
route("POST", "/operators/:id/active", "SUPER_ADMIN", async ({ req, params, op }) => {
  const id = uuid.parse(params.id);
  const active = z.object({ active: z.boolean() }).parse(await body(req)).active;
  if (id === op.id) throw conflictErr("You cannot disable your own account");
  if (!active && (await db.operator.count({ where: { isActive: true, role: "SUPER_ADMIN", id: { not: id } } })) === 0 && (await db.operator.findUnique({ where: { id } }))?.role === "SUPER_ADMIN") throw conflictErr("At least one active super admin must remain");
  await db.operator.update({ where: { id }, data: { isActive: active } }).catch(() => { throw notFound("Operator"); });
  if (!active) await db.operatorSession.updateMany({ where: { operatorId: id, revokedAt: null }, data: { revokedAt: new Date() } });
  await cloudAudit(db, { ...actorOf(op, req), action: active ? "operator.enable" : "operator.disable", detail: { operatorId: id } });
  return { ok: true };
});
route("GET", "/audit", "VIEWER", async ({ query }) => {
  const installationId = query.get("installationId");
  const rows = await db.cloudAudit.findMany({ where: installationId ? { installationId: uuid.parse(installationId) } : {}, orderBy: { seq: "desc" }, take: Math.min(200, Number(query.get("limit") ?? 100)) });
  return rows.map((a) => ({ ...a, seq: Number(a.seq) }));
});
route("GET", "/backups/:id/download", "SUPER_ADMIN", async ({ req, params, op }) => {
  const b = await db.backupUpload.findUnique({ where: { id: uuid.parse(params.id) }, include: { installation: { select: { code: true } } } });
  if (!b) throw notFound("Backup");
  const size = (await stat(b.storagePath).catch(() => null))?.size;
  if (size === undefined) throw notFound("Backup file");
  await cloudAudit(db, { ...actorOf(op, req), action: "backup.download", installationId: b.installationId, detail: { backupId: b.id, fileName: b.fileName } });
  return new Response(Readable.toWeb(createReadStream(b.storagePath)) as never, { headers: { "content-type": "application/octet-stream", "content-length": String(size), "content-disposition": `attachment; filename="${b.fileName.replace(/[^A-Za-z0-9._-]/g, "_")}"`, "cache-control": "no-store" } });
});

function match(method: string, segs: string[]): { route: Route; params: Record<string, string> } | null {
  for (const r of routes) {
    if (r.method !== method || r.pattern.length !== segs.length) continue;
    const params: Record<string, string> = {};
    if (r.pattern.every((p, i) => (p.startsWith(":") ? ((params[p.slice(1)] = segs[i]!), true) : p === segs[i]))) return { route: r, params };
  }
  return null;
}

export async function handleOps(req: Request, segs: string[]): Promise<Response> {
  try {
    const method = req.method.toUpperCase();
    // Sign-in / sign-out are the only routes that do not need an existing session.
    if (method === "POST" && segs.join("/") === "login") {
      const origin = req.headers.get("origin"), host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
      if (origin && host && new URL(origin).host !== host) throw new CloudError("FORBIDDEN", "Cross-origin request blocked", 403);
      const b = z.object({ email: z.string().min(3).max(200), password: z.string().min(1).max(200) }).parse(await body(req));
      const r = await operatorLogin(b.email, b.password, ipOf(req));
      return ok({ id: r.operator.id, email: r.operator.email, name: r.operator.name, role: r.operator.role }, 200, { "set-cookie": sessionCookie(r.token, env().SESSION_TTL_HOURS * 3600, req) });
    }
    if (method === "POST" && segs.join("/") === "logout") {
      const raw = /(?:^|;\s*)ss_cloud_session=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
      if (raw) await operatorLogout(decodeURIComponent(raw));
      return ok({ ok: true }, 200, { "set-cookie": sessionCookie("", 0, req) });
    }
    const m = match(method, segs);
    if (!m) {
      // Unknown path or wrong method — but only reveal that to signed-in operators.
      await authorizeOperator(req, "VIEWER");
      throw notFound("Endpoint");
    }
    const op = await authorizeOperator(req, m.route.role ?? "VIEWER");
    const out = await m.route.run({ req, params: m.params, query: new URL(req.url).searchParams, op });
    return out instanceof Response ? out : ok(out);
  } catch (err) {
    return errorResponse(err);
  }
}

