import { z } from "zod";
import { db, transact, type Tx } from "@/platform/db";
import type { Prisma } from "@/generated/prisma/client";
import { publishEvent, type DomainEventType } from "@/platform/events";
import { audit } from "@/platform/audit";
import { backoffSeconds } from "@smartschool/protocol";
import { buildVars, guardianRecipients, sendNotification, studentRecipient, usersWithRole, type Recipient } from "@/modules/communication/engine";
import { evalAll, validateConditions, type Condition } from "./conditions";
import { safeGet } from "@/platform/util";

const MAX_EVENT_ATTEMPTS = 6;
const MAX_CHAIN_DEPTH = 3;

// ───────────── Actions ─────────────

export const ActionSchemas = {
  /** Notify the guardians of payload.studentId. */
  notify_guardians: z.object({ template: z.string(), need: z.enum(["general", "finance", "results"]).default("general"), channels: z.array(z.enum(["IN_APP", "EMAIL", "SMS", "WHATSAPP"])).optional() }),
  notify_student: z.object({ template: z.string() }),
  notify_role: z.object({ template: z.string(), role: z.string() }),
  notify_user: z.object({ template: z.string(), userId: z.string().uuid() }),
  /** Message to a contact that has no user account yet (e.g. an admission applicant's guardian). */
  queue_message: z.object({ template: z.string(), channels: z.array(z.enum(["EMAIL", "SMS", "WHATSAPP"])).min(1), phoneField: z.string().default("payload.guardianPhone"), emailField: z.string().default("payload.guardianEmail") }),
  create_announcement: z.object({ title: z.string(), body: z.string(), roles: z.array(z.string()).default([]) }),
  emit_event: z.object({ type: z.string(), payload: z.record(z.string(), z.unknown()).default({}) }),
} as const;
export type ActionType = keyof typeof ActionSchemas;
export const ACTION_TYPES = Object.keys(ActionSchemas) as ActionType[];

export interface EventCtx {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

async function runAction(tx: Tx, type: string, rawConfig: unknown, ev: EventCtx, ruleId: string): Promise<string> {
  if (!(type in ActionSchemas)) throw new Error(`Unknown action type "${type}"`);
  const cfg = ActionSchemas[type as ActionType].parse(rawConfig ?? {}) as Record<string, unknown>;
  const vars = await buildVars(tx, ev.payload);
  const dedupeKey = `rule:${ruleId}:event:${ev.id}`;
  const studentId = typeof ev.payload.studentId === "string" ? ev.payload.studentId : undefined;

  const send = async (recipients: Recipient[], channels?: never) => {
    const r = await sendNotification(tx, { templateKey: cfg.template as string, vars, recipients, channels, dedupeKey, type: ev.type, data: { eventId: ev.id } });
    return `${r.inApp} in-app, ${r.queued} queued, ${r.skippedDuplicates} duplicate(s) skipped`;
  };

  switch (type) {
    case "notify_guardians": {
      if (!studentId) return "skipped: event has no studentId";
      const recipients = await guardianRecipients(tx, studentId, cfg.need as "general");
      const r = await sendNotification(tx, { templateKey: cfg.template as string, vars, recipients, channels: cfg.channels as never, dedupeKey, type: ev.type, data: { eventId: ev.id, studentId } });
      return `${recipients.length} guardian(s): ${r.inApp} in-app, ${r.queued} queued, ${r.skippedDuplicates} duplicate(s) skipped`;
    }
    case "notify_student": return studentId ? send(await studentRecipient(tx, studentId)) : "skipped: event has no studentId";
    case "notify_role": return send(await usersWithRole(tx, cfg.role as string));
    case "notify_user": {
      const u = await tx.user.findUnique({ where: { id: cfg.userId as string }, select: { id: true, firstName: true, lastName: true, email: true, phone: true } });
      return u ? send([{ userId: u.id, name: `${u.firstName} ${u.lastName}`, email: u.email, phone: u.phone }]) : "skipped: user not found";
    }
    case "queue_message": {
      const ctx = { event: { type: ev.type }, payload: ev.payload };
      const get = (path: string) => safeGet(ctx, path);
      const phone = get(cfg.phoneField as string), email = get(cfg.emailField as string);
      const r = await sendNotification(tx, { templateKey: cfg.template as string, vars, recipients: [{ phone: typeof phone === "string" ? phone : null, email: typeof email === "string" ? email : null }], channels: cfg.channels as never, dedupeKey, type: ev.type });
      return `${r.queued} queued, ${r.skippedDuplicates} duplicate(s) skipped`;
    }
    case "create_announcement": {
      const existing = await tx.announcement.findFirst({ where: { audience: { path: ["dedupe"], equals: dedupeKey } } });
      if (existing) return "skipped: already created";
      await tx.announcement.create({ data: { title: cfg.title as string, body: cfg.body as string, audience: { roles: cfg.roles, dedupe: dedupeKey } as Prisma.InputJsonValue, publishedAt: new Date() } });
      return "announcement created";
    }
    case "emit_event": {
      const depth = Number(ev.payload._depth ?? 0);
      if (depth >= MAX_CHAIN_DEPTH) throw new Error("Automation chain too deep — possible loop");
      await publishEvent(tx, cfg.type as DomainEventType, { ...(cfg.payload as object), _depth: depth + 1, _origin: ev.id });
      return `event ${cfg.type as string} emitted`;
    }
  }
  return "no-op";
}

// ───────────── Event processing ─────────────

export interface RuleRunSummary {
  matched: number;
  succeeded: number;
  skipped: number;
  failed: number;
}

/** Run every enabled rule triggered by this event. One rule failing never blocks the others. */
export async function runRulesForEvent(ev: EventCtx): Promise<RuleRunSummary> {
  const triggers = await db.automationTrigger.findMany({ where: { kind: "EVENT", eventType: ev.type, rule: { isEnabled: true } }, include: { rule: { include: { actions: { orderBy: { sortOrder: "asc" } } } } } });
  const sum: RuleRunSummary = { matched: 0, succeeded: 0, skipped: 0, failed: 0 };
  for (const t of triggers) {
    const rule = t.rule;
    const prior = await db.automationExecution.findUnique({ where: { ruleId_eventId: { ruleId: rule.id, eventId: ev.id } } });
    if (prior && prior.status !== "FAILED") continue; // idempotent: already handled this event
    sum.matched += 1;
    const log: { at: string; step: string; result: string }[] = [];
    const startedAt = new Date();
    try {
      const conds = validateConditions(rule.conditions);
      const check = evalAll(conds, { event: { type: ev.type, id: ev.id }, payload: ev.payload });
      if (!check.ok) {
        await record(prior?.id, rule.id, ev.id, "SKIPPED", startedAt, [{ at: new Date().toISOString(), step: "conditions", result: `not met: ${check.failed!.field} ${check.failed!.op} ${JSON.stringify(check.failed!.value)}` }]);
        sum.skipped += 1;
        continue;
      }
      // Actions run atomically per rule: a failure in action 2 rolls back action 1's notifications so the retry is clean.
      await transact(async (tx) => {
        for (const a of rule.actions) {
          const result = await runAction(tx, a.type, a.config, ev, rule.id);
          log.push({ at: new Date().toISOString(), step: a.type, result });
        }
      });
      await record(prior?.id, rule.id, ev.id, "SUCCEEDED", startedAt, log);
      sum.succeeded += 1;
    } catch (err) {
      const message = (err as Error).message.slice(0, 500);
      log.push({ at: new Date().toISOString(), step: "error", result: message });
      await record(prior?.id, rule.id, ev.id, "FAILED", startedAt, log, message);
      sum.failed += 1;
    }
  }
  return sum;
}

async function record(priorId: string | undefined, ruleId: string, eventId: string, status: "SUCCEEDED" | "SKIPPED" | "FAILED", startedAt: Date, log: unknown[], error?: string) {
  const data = { status, startedAt, finishedAt: new Date(), log: log as Prisma.InputJsonValue, error: error ?? null };
  if (priorId) await db.automationExecution.update({ where: { id: priorId }, data });
  else await db.automationExecution.create({ data: { ruleId, eventId, ...data } });
}

/**
 * Event dispatcher: claims unprocessed domain events (SKIP LOCKED → safe with many workers), runs the rules,
 * and retries failures with back-off. Events that keep failing are parked (processedAt set, lastError kept)
 * so one poison event can never block the queue.
 */
export async function processPendingEvents(limit = 50): Promise<{ processed: number; failed: number; parked: number }> {
  const claimed = await db.$queryRaw<{ id: string }[]>`
    UPDATE domain_events SET attempts = attempts + 1
    WHERE id IN (SELECT id FROM domain_events WHERE "processedAt" IS NULL AND "nextAttemptAt" <= (now() AT TIME ZONE 'UTC') ORDER BY seq ASC LIMIT ${limit} FOR UPDATE SKIP LOCKED)
    RETURNING id`;
  const out = { processed: 0, failed: 0, parked: 0 };
  if (!claimed.length) return out;
  const events = await db.domainEvent.findMany({ where: { id: { in: claimed.map((c) => c.id) } }, orderBy: { seq: "asc" } });
  for (const e of events) {
    try {
      const r = await runRulesForEvent({ id: e.id, type: e.type, payload: (e.payload ?? {}) as Record<string, unknown> });
      if (r.failed) throw new Error(`${r.failed} rule(s) failed`);
      await db.domainEvent.update({ where: { id: e.id }, data: { processedAt: new Date(), lastError: null } });
      out.processed += 1;
    } catch (err) {
      const message = (err as Error).message.slice(0, 500);
      if (e.attempts >= MAX_EVENT_ATTEMPTS) {
        await db.domainEvent.update({ where: { id: e.id }, data: { processedAt: new Date(), lastError: `PARKED: ${message}` } });
        await transact((tx) => audit(tx, { action: "event.parked", module: "automation", entityType: "DomainEvent", entityId: e.id, metadata: { type: e.type, error: message } }));
        out.parked += 1;
      } else {
        await db.domainEvent.update({ where: { id: e.id }, data: { lastError: message, nextAttemptAt: new Date(Date.now() + backoffSeconds(e.attempts - 1) * 1000) } });
        out.failed += 1;
      }
    }
  }
  return out;
}

// ───────────── Scheduled rules ─────────────

export const ScheduleSchema = z.union([z.object({ everyMinutes: z.number().int().min(5).max(10080) }), z.object({ dailyAt: z.string().regex(/^\d{2}:\d{2}$/) })]);

export function isScheduleDue(schedule: z.infer<typeof ScheduleSchema>, lastFiredAt: Date | null, now: Date, localMinutes: number, localDate: string, lastLocalDate: string | null): boolean {
  if ("everyMinutes" in schedule) return !lastFiredAt || now.getTime() - lastFiredAt.getTime() >= schedule.everyMinutes * 60_000;
  const [h, m] = schedule.dailyAt.split(":").map(Number);
  return localMinutes >= h! * 60 + m! && lastLocalDate !== localDate;
}

/** Fire due SCHEDULE triggers by emitting a synthetic `schedule.tick`-style run of the rule's actions. */
export async function runScheduledRules(now = new Date()): Promise<number> {
  const inst = await db.schoolInstallation.findFirst({ select: { timezone: true } });
  const tz = inst?.timezone ?? "Africa/Lagos";
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  const localDate = `${g("year")}-${g("month")}-${g("day")}`, localMinutes = Number(g("hour")) * 60 + Number(g("minute"));
  const triggers = await db.automationTrigger.findMany({ where: { kind: "SCHEDULE", rule: { isEnabled: true } }, include: { rule: { include: { actions: { orderBy: { sortOrder: "asc" } } } } } });
  let fired = 0;
  for (const t of triggers) {
    const sch = ScheduleSchema.safeParse(t.schedule);
    if (!sch.success) continue;
    const lastLocal = t.lastFiredAt ? new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(t.lastFiredAt) : null;
    if (!isScheduleDue(sch.data, t.lastFiredAt, now, localMinutes, localDate, lastLocal)) continue;
    const claimed = await db.automationTrigger.updateMany({ where: { id: t.id, lastFiredAt: t.lastFiredAt }, data: { lastFiredAt: now } }); // optimistic claim: two workers can't both fire it
    if (!claimed.count) continue;
    const evId = `${t.id}:${now.toISOString()}`;
    try {
      await transact(async (tx) => {
        for (const a of t.rule.actions) await runAction(tx, a.type, a.config, { id: evId, type: "schedule", payload: { scheduled: true, date: localDate } }, t.rule.id);
      });
      await db.automationExecution.create({ data: { ruleId: t.rule.id, status: "SUCCEEDED", finishedAt: new Date(), log: [{ at: now.toISOString(), step: "schedule", result: "fired" }] } });
    } catch (err) {
      await db.automationExecution.create({ data: { ruleId: t.rule.id, status: "FAILED", finishedAt: new Date(), error: (err as Error).message.slice(0, 500), log: [] } });
    }
    fired += 1;
  }
  return fired;
}

// ───────────── Default rules ─────────────

interface DefaultRule {
  name: string;
  description: string;
  event: string;
  conditions?: Condition[];
  actions: { type: ActionType; config: Record<string, unknown> }[];
}

export const DEFAULT_RULES: DefaultRule[] = [
  { name: "Notify guardians of absence", description: "When a student is marked absent, notify their guardians.", event: "attendance.absent", actions: [{ type: "notify_guardians", config: { template: "attendance.absent" } }] },
  { name: "Repeated absence alert", description: "When a student's absences this term reach the threshold, alert the principal.", event: "attendance.absent", conditions: [{ field: "payload.absenceCount", op: ">=", value: 3 }], actions: [{ type: "notify_role", config: { template: "attendance.repeated_absence", role: "principal" } }] },
  { name: "Notify guardians of lateness", description: "Tell guardians when a student arrives late.", event: "attendance.late", actions: [{ type: "notify_guardians", config: { template: "attendance.late" } }] },
  { name: "Payment receipt", description: "Confirm received payments to guardians.", event: "payment.received", actions: [{ type: "notify_guardians", config: { template: "payment.received", need: "finance" } }] },
  { name: "Invoice issued", description: "Tell guardians when a new invoice is issued.", event: "invoice.issued", actions: [{ type: "notify_guardians", config: { template: "invoice.issued", need: "finance" } }] },
  { name: "Fees overdue reminder", description: "Remind guardians of overdue invoices.", event: "invoice.overdue", actions: [{ type: "notify_guardians", config: { template: "invoice.overdue", need: "finance" } }] },
  { name: "Results published", description: "Notify guardians when results are published.", event: "result.published", actions: [{ type: "notify_guardians", config: { template: "result.published", need: "results" } }] },
  { name: "Admission received", description: "Acknowledge a new application by SMS/email.", event: "admission.submitted", actions: [{ type: "queue_message", config: { template: "admission.submitted", channels: ["EMAIL", "SMS"] } }] },
  { name: "Admission approved", description: "Tell the applicant's guardian the offer.", event: "admission.approved", actions: [{ type: "queue_message", config: { template: "admission.approved", channels: ["EMAIL", "SMS"] } }] },
  { name: "Admission declined", description: "Tell the applicant's guardian the decision.", event: "admission.rejected", actions: [{ type: "queue_message", config: { template: "admission.rejected", channels: ["EMAIL", "SMS"] } }] },
  { name: "CBT result available", description: "Notify students and guardians when a CBT result is published.", event: "cbt.result_available", actions: [{ type: "notify_student", config: { template: "cbt.result_available" } }, { type: "notify_guardians", config: { template: "cbt.result_available", need: "results" } }] },
];

export async function seedDefaultRules(tx: Tx) {
  for (const r of DEFAULT_RULES) {
    if (await tx.automationRule.findUnique({ where: { name: r.name } })) continue;
    await tx.automationRule.create({
      data: {
        name: r.name, description: r.description, isSystem: true, conditions: (r.conditions ?? []) as unknown as Prisma.InputJsonValue,
        triggers: { create: [{ kind: "EVENT", eventType: r.event }] },
        actions: { create: r.actions.map((a, i) => ({ type: a.type, config: a.config as Prisma.InputJsonValue, sortOrder: i })) },
      },
    });
  }
}
