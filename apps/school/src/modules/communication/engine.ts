import { db, type Tx } from "@/platform/db";
import type { Prisma, NotificationChannel } from "@/generated/prisma/client";
import { getSetting } from "@/platform/settings";
import { isFeatureEnabled } from "@/platform/features";
import { renderTemplate } from "./templates";

export interface Recipient {
  userId?: string;
  name?: string;
  email?: string | null;
  phone?: string | null;
}

/** Variables available to every template, built from the event payload + school + student context. */
export async function buildVars(tx: Tx | typeof db, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const school = await tx.schoolInstallation.findFirst({ select: { schoolName: true } });
  const vars: Record<string, unknown> = { ...payload, school: school?.schoolName ?? "School" };
  const studentId = typeof payload.studentId === "string" ? payload.studentId : undefined;
  if (studentId) {
    const s = await tx.studentProfile.findUnique({ where: { id: studentId }, include: { enrollments: { where: { status: "ACTIVE" }, include: { class: { select: { name: true } } }, take: 1 } } });
    if (s) {
      vars.student = `${s.firstName} ${s.lastName}`;
      vars.studentFirstName = s.firstName;
      vars.admissionNumber = s.admissionNumber;
      vars.class = s.enrollments[0]?.class.name ?? "";
    }
  }
  if (typeof payload.termId === "string") vars.term = (await tx.term.findUnique({ where: { id: payload.termId }, select: { name: true } }))?.name ?? "";
  if (typeof payload.paymentId === "string" && !vars.receipt) vars.receipt = payload.receiptNumber;
  if (typeof payload.invoiceId === "string" && !vars.invoice) vars.invoice = payload.number;
  return vars;
}

export async function guardianRecipients(tx: Tx | typeof db, studentId: string, need: "finance" | "results" | "general" = "general"): Promise<Recipient[]> {
  const links = await tx.guardianRelationship.findMany({
    where: { studentId, ...(need === "finance" ? { canViewFinance: true } : need === "results" ? { canViewResults: true } : {}) },
    include: { parent: { include: { user: { select: { id: true, email: true, phone: true, status: true } } } } },
  });
  return links.filter((l) => l.parent.user.status === "ACTIVE").map((l) => ({ userId: l.parent.userId, name: `${l.parent.firstName} ${l.parent.lastName}`, email: l.parent.email ?? l.parent.user.email, phone: l.parent.phone ?? l.parent.user.phone }));
}

export async function usersWithRole(tx: Tx | typeof db, roleKey: string): Promise<Recipient[]> {
  const users = await tx.user.findMany({ where: { deletedAt: null, status: "ACTIVE", roles: { some: { role: { key: roleKey } } } }, select: { id: true, firstName: true, lastName: true, email: true, phone: true } });
  return users.map((u) => ({ userId: u.id, name: `${u.firstName} ${u.lastName}`, email: u.email, phone: u.phone }));
}

export async function studentRecipient(tx: Tx | typeof db, studentId: string): Promise<Recipient[]> {
  const s = await tx.studentProfile.findUnique({ where: { id: studentId }, include: { user: { select: { id: true, status: true } } } });
  return s?.user && s.user.status === "ACTIVE" ? [{ userId: s.user.id, name: `${s.firstName} ${s.lastName}` }] : [];
}

async function templateFor(tx: Tx | typeof db, key: string, channel: NotificationChannel) {
  return (await tx.notificationTemplate.findUnique({ where: { key_channel: { key, channel } } })) ?? (await tx.notificationTemplate.findUnique({ where: { key_channel: { key, channel: "IN_APP" } } }));
}

export interface SendSpec {
  templateKey: string;
  vars: Record<string, unknown>;
  recipients: Recipient[];
  /** Overrides the school policy's channel list (e.g. admission mail to an applicant has no user account). */
  channels?: NotificationChannel[];
  /** Idempotency for retried automation runs: same (dedupeKey, recipient, channel) is sent once. */
  dedupeKey?: string;
  type?: string;
  data?: Record<string, unknown>;
}

/**
 * The single place notifications are created. In-app notifications are written immediately; email/SMS/WhatsApp
 * become QUEUED delivery rows that the delivery worker sends whenever a provider is reachable — so events that
 * happen offline are never lost.
 */
export async function sendNotification(tx: Tx, spec: SendSpec): Promise<{ inApp: number; queued: number; skippedDuplicates: number }> {
  const policy = await getSetting("notifications.policy", tx);
  const channels = spec.channels ?? (policy.channels as NotificationChannel[]);
  const smsOk = await isFeatureEnabled("communication.sms");
  const waOk = await isFeatureEnabled("communication.whatsapp");
  let inApp = 0, queued = 0, dup = 0;
  const seen = new Set<string>();

  for (const r of spec.recipients) {
    const dedupeBase = spec.dedupeKey ? `${spec.dedupeKey}|${r.userId ?? r.email ?? r.phone}` : null;
    for (const channel of channels) {
      if (channel === "SMS" && !smsOk) continue;
      if (channel === "WHATSAPP" && !waOk) continue;
      const to = channel === "EMAIL" ? r.email : channel === "IN_APP" ? r.userId : r.phone;
      if (!to) continue;
      const key = `${channel}|${to}`;
      if (seen.has(key)) continue; // same phone on two guardians → one SMS
      seen.add(key);
      const tpl = await templateFor(tx, spec.templateKey, channel);
      if (!tpl?.isActive) continue;
      const body = renderTemplate(tpl.body, spec.vars);
      const subject = tpl.subject ? renderTemplate(tpl.subject, spec.vars) : null;
      const dedupe = dedupeBase ? `${dedupeBase}|${channel}` : null;

      if (channel === "IN_APP") {
        if (dedupe && (await tx.notification.findFirst({ where: { userId: r.userId!, data: { path: ["dedupe"], equals: dedupe } }, select: { id: true } }))) { dup += 1; continue; }
        await tx.notification.create({ data: { userId: r.userId!, type: spec.type ?? spec.templateKey, title: subject ?? spec.templateKey, body, data: { ...(spec.data ?? {}), ...(dedupe ? { dedupe } : {}) } as Prisma.InputJsonValue } });
        inApp += 1;
      } else {
        if (dedupe && (await tx.notificationDelivery.findFirst({ where: { channel, recipient: to, providerRef: `dedupe:${dedupe}` }, select: { id: true } }))) { dup += 1; continue; }
        await tx.notificationDelivery.create({ data: { channel, recipient: to, subject, body, providerRef: dedupe ? `dedupe:${dedupe}` : null } });
        queued += 1;
      }
    }
  }
  return { inApp, queued, skippedDuplicates: dup };
}

// ───────────── In-app inbox ─────────────

export const unreadCount = (userId: string) => db.notification.count({ where: { userId, readAt: null } });

export async function listNotifications(userId: string, opts: { unreadOnly?: boolean; take?: number } = {}) {
  return db.notification.findMany({ where: { userId, ...(opts.unreadOnly ? { readAt: null } : {}) }, orderBy: { createdAt: "desc" }, take: opts.take ?? 30 });
}

export async function markRead(userId: string, ids: string[] | "all") {
  const r = await db.notification.updateMany({ where: { userId, readAt: null, ...(ids === "all" ? {} : { id: { in: ids } }) }, data: { readAt: new Date() } });
  return r.count;
}
