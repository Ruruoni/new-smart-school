import { z } from "zod";
import { db, transact } from "@/platform/db";
import type { SecurityContext } from "@/platform/security/context";
import { auditIn } from "@/platform/security/interceptor";
import { conflict, forbidden, notFound, validation } from "@/platform/errors";
import { assertUpdated } from "@/platform/util";
import type { Prisma } from "@/generated/prisma/client";
import { ACTION_TYPES, ActionSchemas, ScheduleSchema, type ActionType } from "./engine";
import { validateConditions } from "./conditions";

export const RuleInput = z.object({
  name: z.string().trim().min(3).max(100),
  description: z.string().trim().max(300).optional(),
  isEnabled: z.boolean().default(true),
  conditions: z.array(z.object({ field: z.string(), op: z.string(), value: z.unknown().optional() })).default([]),
  trigger: z.union([z.object({ kind: z.literal("EVENT"), eventType: z.string().min(3).max(60) }), z.object({ kind: z.literal("SCHEDULE"), schedule: ScheduleSchema })]),
  actions: z.array(z.object({ type: z.enum(ACTION_TYPES as [ActionType, ...ActionType[]]), config: z.record(z.string(), z.unknown()).default({}) })).min(1).max(10),
});

function validateRule(i: z.infer<typeof RuleInput>) {
  let conditions;
  try { conditions = validateConditions(i.conditions); } catch (e) { throw validation((e as Error).message); }
  for (const a of i.actions) {
    const r = ActionSchemas[a.type].safeParse(a.config);
    if (!r.success) throw validation(`Action "${a.type}": ${r.error.issues[0]?.path.join(".")} ${r.error.issues[0]?.message}`);
  }
  return conditions;
}

export async function createRule(ctx: SecurityContext, raw: z.input<typeof RuleInput>) {
  const i = RuleInput.parse(raw);
  const conditions = validateRule(i);
  return transact(async (tx) => {
    if (await tx.automationRule.findUnique({ where: { name: i.name } })) throw conflict("A rule with that name already exists");
    const rule = await tx.automationRule.create({
      data: {
        name: i.name, description: i.description, isEnabled: i.isEnabled, conditions: conditions as unknown as Prisma.InputJsonValue,
        triggers: { create: [i.trigger.kind === "EVENT" ? { kind: "EVENT", eventType: i.trigger.eventType } : { kind: "SCHEDULE", schedule: i.trigger.schedule }] },
        actions: { create: i.actions.map((a, idx) => ({ type: a.type, config: a.config as Prisma.InputJsonValue, sortOrder: idx })) },
      },
    });
    await auditIn(tx, ctx, { action: "automation.rule_create", module: "automation", entityType: "AutomationRule", entityId: rule.id, after: { name: rule.name } });
    return rule;
  });
}

export async function updateRule(ctx: SecurityContext, id: string, raw: z.input<typeof RuleInput> & { version: number }) {
  const { version, ...rest } = raw;
  const i = RuleInput.parse(rest);
  const conditions = validateRule(i);
  return transact(async (tx) => {
    const before = await tx.automationRule.findUnique({ where: { id } });
    if (!before) throw notFound("Rule");
    const r = await tx.automationRule.updateMany({ where: { id, version }, data: { name: i.name, description: i.description, isEnabled: i.isEnabled, conditions: conditions as unknown as Prisma.InputJsonValue, version: { increment: 1 } } });
    assertUpdated(r.count, "Rule", before.version);
    await tx.automationTrigger.deleteMany({ where: { ruleId: id } });
    await tx.automationAction.deleteMany({ where: { ruleId: id } });
    await tx.automationTrigger.create({ data: { ruleId: id, ...(i.trigger.kind === "EVENT" ? { kind: "EVENT" as const, eventType: i.trigger.eventType } : { kind: "SCHEDULE" as const, schedule: i.trigger.schedule }) } });
    await tx.automationAction.createMany({ data: i.actions.map((a, idx) => ({ ruleId: id, type: a.type, config: a.config as Prisma.InputJsonValue, sortOrder: idx })) });
    await auditIn(tx, ctx, { action: "automation.rule_update", module: "automation", entityType: "AutomationRule", entityId: id, before: { name: before.name, enabled: before.isEnabled }, after: { name: i.name, enabled: i.isEnabled } });
  });
}

export async function setRuleEnabled(ctx: SecurityContext, id: string, enabled: boolean) {
  return transact(async (tx) => {
    const r = await tx.automationRule.updateMany({ where: { id }, data: { isEnabled: enabled, version: { increment: 1 } } });
    if (!r.count) throw notFound("Rule");
    await auditIn(tx, ctx, { action: enabled ? "automation.rule_enable" : "automation.rule_disable", module: "automation", entityType: "AutomationRule", entityId: id });
  });
}

export async function deleteRule(ctx: SecurityContext, id: string) {
  return transact(async (tx) => {
    const r = await tx.automationRule.findUnique({ where: { id } });
    if (!r) throw notFound("Rule");
    if (r.isSystem) throw forbidden("Built-in rules can be disabled or edited but not deleted");
    await tx.automationRule.delete({ where: { id } });
    await auditIn(tx, ctx, { action: "automation.rule_delete", module: "automation", entityType: "AutomationRule", entityId: id, before: { name: r.name } });
  });
}

export const listRules = () => db.automationRule.findMany({ include: { triggers: true, actions: { orderBy: { sortOrder: "asc" } }, _count: { select: { executions: true } } }, orderBy: [{ isSystem: "desc" }, { name: "asc" }] });

export const listExecutions = (ruleId?: string, take = 50) =>
  db.automationExecution.findMany({ where: ruleId ? { ruleId } : {}, include: { rule: { select: { name: true } } }, orderBy: { startedAt: "desc" }, take });
