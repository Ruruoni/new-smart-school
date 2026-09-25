import { z } from "zod";
import { RegisterRequest, type RegisterResponse } from "@smartschool/protocol";
import { db, transact } from "./db";
import { cloudAudit } from "./audit";
import { decryptSecret, encryptSecret, randomToken, sha256 } from "./crypto";
import { badRequest, conflictErr, notFound, unauthorized } from "./errors";
import { signLicense } from "./signing";
import { SIG_HEADERS, verifySignature } from "@smartschool/protocol";
import type { Installation } from "@cloud/generated/prisma/client";

export interface Actor { operatorId?: string | null; operatorEmail?: string | null; ip?: string | null }

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = () => "SS-" + [...Buffer.from(randomToken(8))].slice(0, 6).map((b) => ALPHABET[b % ALPHABET.length]).join("");

export const MODULE_KEYS = ["students", "staff", "academics", "results", "admissions", "finance", "attendance", "timetable", "lessonnotes", "cbt", "examprep", "communication", "automation", "analytics", "reports", "imports", "sync", "backup"] as const;

export const CreateInstallation = z.object({
  schoolName: z.string().trim().min(2).max(160),
  state: z.string().trim().max(80).optional(),
  contactName: z.string().trim().max(120).optional(),
  contactEmail: z.string().email().optional(),
  contactPhone: z.string().trim().max(30).optional(),
  plan: z.string().trim().min(2).max(40).default("standard"),
  modules: z.array(z.enum(MODULE_KEYS)).default([...MODULE_KEYS]),
  licenseDays: z.number().int().min(1).max(3650).default(365),
});

/** Operator creates the installation record and gets a ONE-TIME registration token to give to the school. */
export async function createInstallation(actor: Actor, raw: z.input<typeof CreateInstallation>) {
  const i = CreateInstallation.parse(raw);
  return transact(async (tx) => {
    let code = newCode();
    while (await tx.installation.findUnique({ where: { code } })) code = newCode();
    const inst = await tx.installation.create({ data: { code, schoolName: i.schoolName, state: i.state, contactName: i.contactName, contactEmail: i.contactEmail, contactPhone: i.contactPhone, plan: i.plan, modules: i.modules, licenseExpiresAt: new Date(Date.now() + i.licenseDays * 86_400_000) } });
    const token = await issueRegistrationTokenTx(tx, inst, actor);
    await cloudAudit(tx, { ...actor, action: "installation.create", installationId: inst.id, detail: { code, schoolName: i.schoolName, plan: i.plan } });
    return { installation: inst, registrationToken: token };
  });
}

async function issueRegistrationTokenTx(tx: Parameters<Parameters<typeof transact>[0]>[0], inst: Installation, actor: Actor) {
  const raw = `SSR-${inst.code}-${randomToken(18)}`;
  await tx.registrationToken.create({ data: { tokenHash: sha256(raw), installationId: inst.id, expiresAt: new Date(Date.now() + 14 * 86_400_000), createdById: actor.operatorId ?? null } });
  return raw;
}

export async function reissueRegistrationToken(actor: Actor, installationId: string) {
  return transact(async (tx) => {
    const inst = await tx.installation.findUnique({ where: { id: installationId } });
    if (!inst) throw notFound("Installation");
    if (inst.status === "DECOMMISSIONED") throw conflictErr("This installation was decommissioned");
    await tx.registrationToken.updateMany({ where: { installationId, usedAt: null }, data: { expiresAt: new Date() } });
    const token = await issueRegistrationTokenTx(tx, inst, actor);
    await cloudAudit(tx, { ...actor, action: "installation.reissue_token", installationId });
    return token;
  });
}

/** School presents its one-time token; the cloud binds identity, issues the shared secret and the first license. */
export async function registerInstallation(raw: unknown, ip: string | null): Promise<RegisterResponse> {
  const p = RegisterRequest.safeParse(raw);
  if (!p.success) throw badRequest("Invalid registration request");
  const tok = await db.registrationToken.findUnique({ where: { tokenHash: sha256(p.data.registrationToken) }, include: { installation: true } });
  if (!tok || tok.usedAt || tok.expiresAt < new Date()) throw unauthorized("That registration token is invalid, used or expired");
  if (tok.installation.status === "DECOMMISSIONED") throw unauthorized("This installation was decommissioned");
  const secret = randomToken(32);
  return transact(async (tx) => {
    const claimed = await tx.registrationToken.updateMany({ where: { id: tok.id, usedAt: null }, data: { usedAt: new Date() } });
    if (!claimed.count) throw unauthorized("That registration token was already used");
    const now = new Date();
    const inst = await tx.installation.update({
      where: { id: tok.installationId },
      data: { secretEnc: encryptSecret(secret), status: tok.installation.status === "SUSPENDED" ? "SUSPENDED" : "ACTIVE", registeredAt: now, licenseIssuedAt: tok.installation.licenseIssuedAt ?? now, appVersion: p.data.appVersion, schemaVersion: p.data.schemaVersion, lastIp: ip, ...(p.data.schoolName ? { schoolName: p.data.schoolName } : {}) },
    });
    await cloudAudit(tx, { action: "installation.registered", installationId: inst.id, detail: { appVersion: p.data.appVersion }, ip });
    return { installationCode: inst.code, secret, licenseToken: await licenseTokenFor(inst) };
  });
}

/** The license the school should hold right now (stable `iat`, so an unchanged license yields an identical token). */
export async function licenseTokenFor(inst: Installation): Promise<string | null> {
  if (!inst.licenseExpiresAt) return null;
  const flags = await effectiveFlags(inst);
  return signLicense({
    code: inst.code, plan: inst.plan, modules: inst.modules, features: Object.fromEntries(flags.map((f) => [f.key, f.enabled])), graceDays: inst.graceDays,
    status: inst.status === "SUSPENDED" ? "SUSPENDED" : "ACTIVE", expiresAt: inst.licenseExpiresAt, issuedAt: inst.licenseIssuedAt ?? inst.registeredAt ?? new Date(0),
  });
}

/** Global flags with per-installation overrides on top. */
export async function effectiveFlags(inst: Pick<Installation, "featureOverrides">) {
  const globals = await db.globalFlag.findMany();
  const overrides = (inst.featureOverrides ?? {}) as Record<string, boolean>;
  const out = new Map(globals.map((g) => [g.key, g.enabled]));
  for (const [k, v] of Object.entries(overrides)) out.set(k, !!v);
  return [...out.entries()].map(([key, enabled]) => ({ key, enabled }));
}

// ───────────── Authenticating a school's signed request ─────────────

export async function authenticateInstallation(req: Request, rawBody: string, opts: { allow?: ("ACTIVE" | "SUSPENDED")[] } = {}): Promise<Installation> {
  const code = req.headers.get(SIG_HEADERS.installation);
  const ts = req.headers.get(SIG_HEADERS.timestamp);
  const sig = req.headers.get(SIG_HEADERS.signature);
  if (!code || !ts || !sig) throw unauthorized("Missing signature headers");
  const inst = await db.installation.findUnique({ where: { code } });
  // Same answer for "unknown installation" and "bad signature": do not reveal which codes exist.
  if (!inst?.secretEnc || !verifySignature(decryptSecret(inst.secretEnc), ts, rawBody, sig)) throw unauthorized("Invalid signature");
  if (!(opts.allow ?? ["ACTIVE", "SUSPENDED"]).includes(inst.status as never)) throw unauthorized(`Installation is ${inst.status.toLowerCase()}`);
  return inst;
}

// ───────────── Operator actions ─────────────

export const LicenseUpdate = z.object({ plan: z.string().trim().min(2).max(40).optional(), modules: z.array(z.enum(MODULE_KEYS)).optional(), expiresAt: z.string().datetime().optional(), graceDays: z.number().int().min(0).max(365).optional() });

export async function updateLicense(actor: Actor, installationId: string, raw: z.input<typeof LicenseUpdate>) {
  const i = LicenseUpdate.parse(raw);
  return transact(async (tx) => {
    const before = await tx.installation.findUnique({ where: { id: installationId } });
    if (!before) throw notFound("Installation");
    const after = await tx.installation.update({ where: { id: installationId }, data: { ...(i.plan ? { plan: i.plan } : {}), ...(i.modules ? { modules: i.modules } : {}), ...(i.expiresAt ? { licenseExpiresAt: new Date(i.expiresAt) } : {}), ...(i.graceDays !== undefined ? { graceDays: i.graceDays } : {}), licenseIssuedAt: new Date() } });
    await cloudAudit(tx, { ...actor, action: "license.update", installationId, detail: { before: { plan: before.plan, modules: before.modules, expiresAt: before.licenseExpiresAt }, after: { plan: after.plan, modules: after.modules, expiresAt: after.licenseExpiresAt } } });
    return after;
  });
}

export async function setFeatureOverride(actor: Actor, installationId: string, key: string, enabled: boolean | null) {
  if (!/^[a-z]+\.[a-z_]+$/.test(key)) throw badRequest("Invalid feature key");
  return transact(async (tx) => {
    const inst = await tx.installation.findUnique({ where: { id: installationId } });
    if (!inst) throw notFound("Installation");
    const overrides = { ...((inst.featureOverrides ?? {}) as Record<string, boolean>) };
    if (enabled === null) delete overrides[key]; else overrides[key] = enabled;
    const after = await tx.installation.update({ where: { id: installationId }, data: { featureOverrides: overrides, licenseIssuedAt: new Date() } });
    await cloudAudit(tx, { ...actor, action: "feature.override", installationId, detail: { key, enabled } });
    return after;
  });
}

export async function setGlobalFlag(actor: Actor, key: string, enabled: boolean, description?: string) {
  if (!/^[a-z]+\.[a-z_]+$/.test(key)) throw badRequest("Invalid feature key");
  return transact(async (tx) => {
    const f = await tx.globalFlag.upsert({ where: { key }, create: { key, enabled, description }, update: { enabled, ...(description ? { description } : {}) } });
    // Licenses embed flags: re-stamp so schools notice the change on their next heartbeat.
    await tx.installation.updateMany({ where: { status: { in: ["ACTIVE", "SUSPENDED"] } }, data: { licenseIssuedAt: new Date() } });
    await cloudAudit(tx, { ...actor, action: "feature.global", detail: { key, enabled } });
    return f;
  });
}

/**
 * Controlled remote disable. Requires a reason; the school drops into ADMIN_ONLY (data stays readable/exportable,
 * only the Primary Admin can sign in). Takes effect only when the school next receives this signed license — an
 * outage or silence never triggers it.
 */
export async function suspendInstallation(actor: Actor, installationId: string, reason: string) {
  if (reason.trim().length < 5) throw badRequest("A reason of at least 5 characters is required");
  return transact(async (tx) => {
    const inst = await tx.installation.findUnique({ where: { id: installationId } });
    if (!inst) throw notFound("Installation");
    if (inst.status === "SUSPENDED") throw conflictErr("Already suspended");
    if (inst.status !== "ACTIVE") throw conflictErr(`Cannot suspend a ${inst.status.toLowerCase()} installation`);
    const after = await tx.installation.update({ where: { id: installationId }, data: { status: "SUSPENDED", suspendedAt: new Date(), suspendedReason: reason, licenseIssuedAt: new Date() } });
    await cloudAudit(tx, { ...actor, action: "installation.suspend", installationId, detail: { reason } });
    return after;
  });
}

export async function resumeInstallation(actor: Actor, installationId: string) {
  return transact(async (tx) => {
    const inst = await tx.installation.findUnique({ where: { id: installationId } });
    if (!inst) throw notFound("Installation");
    if (inst.status !== "SUSPENDED") throw conflictErr("Installation is not suspended");
    const after = await tx.installation.update({ where: { id: installationId }, data: { status: "ACTIVE", suspendedAt: null, suspendedReason: null, licenseIssuedAt: new Date() } });
    await cloudAudit(tx, { ...actor, action: "installation.resume", installationId });
    return after;
  });
}

export async function decommissionInstallation(actor: Actor, installationId: string, reason: string) {
  if (reason.trim().length < 5) throw badRequest("A reason is required");
  return transact(async (tx) => {
    const after = await tx.installation.update({ where: { id: installationId }, data: { status: "DECOMMISSIONED", secretEnc: null } }).catch(() => { throw notFound("Installation"); });
    await cloudAudit(tx, { ...actor, action: "installation.decommission", installationId, detail: { reason } });
    return after;
  });
}

export async function listInstallations() {
  return db.installation.findMany({ orderBy: { schoolName: "asc" }, include: { alerts: { where: { resolvedAt: null }, select: { severity: true, kind: true } }, _count: { select: { conflicts: { where: { resolvedAt: null } } } } } });
}

export async function getInstallation(id: string) {
  const i = await db.installation.findUnique({ where: { id }, include: { alerts: { where: { resolvedAt: null }, orderBy: { openedAt: "desc" } }, heartbeats: { orderBy: { receivedAt: "desc" }, take: 30 }, commands: { orderBy: { issuedAt: "desc" }, take: 10 }, conflicts: { where: { resolvedAt: null }, take: 20 } } });
  if (!i) throw notFound("Installation");
  const { secretEnc: _s, ...safe } = i;
  return safe;
}

/** Issue a one-shot command (banner message, backup request…). Delivered on the school's next heartbeat, re-sent until acknowledged. */
export async function issueCommand(actor: Actor, installationId: string, cmd: "MESSAGE" | "REQUEST_BACKUP" | "REQUEST_DIAGNOSTICS", args: Record<string, unknown> = {}) {
  return transact(async (tx) => {
    const inst = await tx.installation.findUnique({ where: { id: installationId } });
    if (!inst || inst.status === "DECOMMISSIONED") throw notFound("Installation");
    const c = await tx.command.create({ data: { installationId, type: cmd, args: args as never, expiresAt: new Date(Date.now() + 7 * 86_400_000), issuedById: actor.operatorId ?? null } });
    await cloudAudit(tx, { ...actor, action: `command.${cmd.toLowerCase()}`, installationId, detail: { commandId: c.id, args } });
    return c;
  });
}
