import { z } from "zod";
import { db, transact, type Tx } from "@/platform/db";
import type { SecurityContext } from "@/platform/security/context";
import { auditIn } from "@/platform/security/interceptor";
import { publishEvent } from "@/platform/events";
import { notFound, validation } from "@/platform/errors";
import { uuid } from "@/platform/util";
import { buildVars, sendNotification, type Recipient } from "./engine";

export const AnnouncementInput = z.object({
  title: z.string().trim().min(3).max(150),
  body: z.string().trim().min(3).max(4000),
  audience: z.object({
    roles: z.array(z.enum(["ADMIN", "TEACHER", "STAFF", "PARENT", "STUDENT"])).default([]),
    classIds: z.array(uuid).default([]),
  }).default({ roles: [], classIds: [] }),
  expiresAt: z.string().datetime().nullable().optional(),
  publishNow: z.boolean().default(true),
});

/** Everyone the audience selects: by user type and/or by class (students + their guardians). Empty audience = the whole school. */
export async function resolveAudience(tx: Tx | typeof db, audience: { roles?: string[]; classIds?: string[] }): Promise<Recipient[]> {
  const roles = audience.roles ?? [];
  const classIds = audience.classIds ?? [];
  const byId = new Map<string, Recipient>();
  const add = (r: Recipient) => { if (r.userId) byId.set(r.userId, r); };
  if (!roles.length && !classIds.length) {
    for (const u of await tx.user.findMany({ where: { deletedAt: null, status: "ACTIVE" }, select: { id: true, firstName: true, lastName: true, email: true, phone: true } })) add({ userId: u.id, name: `${u.firstName} ${u.lastName}`, email: u.email, phone: u.phone });
    return [...byId.values()];
  }
  if (roles.length) {
    for (const u of await tx.user.findMany({ where: { deletedAt: null, status: "ACTIVE", userType: { in: roles as never } }, select: { id: true, firstName: true, lastName: true, email: true, phone: true } })) add({ userId: u.id, name: `${u.firstName} ${u.lastName}`, email: u.email, phone: u.phone });
  }
  if (classIds.length) {
    const enrollments = await tx.enrollment.findMany({ where: { classId: { in: classIds }, status: "ACTIVE" }, select: { student: { select: { userId: true, firstName: true, lastName: true, guardians: { select: { parent: { select: { userId: true, firstName: true, lastName: true, phone: true, email: true } } } } } } } });
    for (const e of enrollments) {
      if (e.student.userId) add({ userId: e.student.userId, name: `${e.student.firstName} ${e.student.lastName}` });
      for (const g of e.student.guardians) add({ userId: g.parent.userId, name: `${g.parent.firstName} ${g.parent.lastName}`, email: g.parent.email, phone: g.parent.phone });
    }
  }
  return [...byId.values()];
}

export async function createAnnouncement(ctx: SecurityContext, raw: z.input<typeof AnnouncementInput>) {
  const i = AnnouncementInput.parse(raw);
  return transact(async (tx) => {
    const a = await tx.announcement.create({ data: { title: i.title, body: i.body, audience: i.audience, expiresAt: i.expiresAt ? new Date(i.expiresAt) : null, createdById: ctx.user.id, publishedAt: i.publishNow ? new Date() : null } });
    if (i.publishNow) await fanOut(tx, a);
    await auditIn(tx, ctx, { action: i.publishNow ? "announcement.publish" : "announcement.create", module: "communication", entityType: "Announcement", entityId: a.id, after: { title: a.title, audience: i.audience } });
    return a;
  });
}

export async function publishAnnouncement(ctx: SecurityContext, id: string) {
  return transact(async (tx) => {
    const a = await tx.announcement.findUnique({ where: { id } });
    if (!a) throw notFound("Announcement");
    if (a.publishedAt) throw validation("Announcement is already published");
    const u = await tx.announcement.update({ where: { id }, data: { publishedAt: new Date(), version: { increment: 1 } } });
    await fanOut(tx, u);
    await auditIn(tx, ctx, { action: "announcement.publish", module: "communication", entityType: "Announcement", entityId: id });
    return u;
  });
}

async function fanOut(tx: Tx, a: { id: string; title: string; body: string; audience: unknown }) {
  const recipients = await resolveAudience(tx, (a.audience ?? {}) as { roles?: string[]; classIds?: string[] });
  const vars = await buildVars(tx, { title: a.title, body: a.body });
  await sendNotification(tx, { templateKey: "announcement.published", vars, recipients, type: "announcement", dedupeKey: `announcement:${a.id}`, data: { announcementId: a.id } });
  await publishEvent(tx, "announcement.published", { announcementId: a.id, title: a.title });
}

/** Announcements visible to the caller (their user type / their children's classes), newest first. */
export async function listAnnouncementsFor(userId: string, userType: string) {
  const now = new Date();
  const all = await db.announcement.findMany({ where: { publishedAt: { not: null, lte: now }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, orderBy: { publishedAt: "desc" }, take: 100 });
  const classIds = await myClassIds(userId, userType);
  return all.filter((a) => {
    const aud = (a.audience ?? {}) as { roles?: string[]; classIds?: string[] };
    const r = aud.roles ?? [], c = aud.classIds ?? [];
    if (!r.length && !c.length) return true;
    return r.includes(userType) || c.some((id) => classIds.includes(id));
  });
}

async function myClassIds(userId: string, userType: string): Promise<string[]> {
  if (userType === "STUDENT") {
    const e = await db.enrollment.findMany({ where: { status: "ACTIVE", student: { userId } }, select: { classId: true } });
    return e.map((x) => x.classId);
  }
  if (userType === "PARENT") {
    const e = await db.enrollment.findMany({ where: { status: "ACTIVE", student: { guardians: { some: { parent: { userId } } } } }, select: { classId: true } });
    return e.map((x) => x.classId);
  }
  return [];
}
