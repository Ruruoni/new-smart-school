import { z } from "zod";
import { db, transact, type Tx } from "@/platform/db";
import type { SecurityContext } from "@/platform/security/context";
import { auditIn } from "@/platform/security/interceptor";
import { conflict, notFound, validation } from "@/platform/errors";
import { assertUpdated, asPage, ilike, skipTake, uuid } from "@/platform/util";

const option = z.object({ label: z.string().trim().min(1).max(4), text: z.string().trim().min(1).max(500), isCorrect: z.boolean() });

/** Question text is plain text on purpose: it is rendered escaped everywhere, so there is no HTML to sanitise. */
export const QuestionInput = z
  .object({
    subjectId: uuid,
    topicId: uuid.nullable().optional(),
    examBody: z.enum(["INTERNAL", "WAEC", "NECO", "JAMB", "BECE"]).default("INTERNAL"),
    year: z.number().int().min(1970).max(2100).nullable().optional(),
    difficulty: z.enum(["EASY", "MEDIUM", "HARD"]).default("MEDIUM"),
    type: z.enum(["MCQ_SINGLE", "MCQ_MULTIPLE", "TRUE_FALSE"]).default("MCQ_SINGLE"),
    stem: z.string().trim().min(3).max(4000),
    explanation: z.string().trim().max(4000).optional(),
    options: z.array(option).min(2).max(6),
  })
  .superRefine((q, ctx) => {
    const correct = q.options.filter((o) => o.isCorrect).length;
    const labels = q.options.map((o) => o.label.toUpperCase());
    if (new Set(labels).size !== labels.length) ctx.addIssue({ code: "custom", message: "Option labels must be unique", path: ["options"] });
    if (q.type === "MCQ_SINGLE" && correct !== 1) ctx.addIssue({ code: "custom", message: "Exactly one option must be correct", path: ["options"] });
    if (q.type === "MCQ_MULTIPLE" && correct < 1) ctx.addIssue({ code: "custom", message: "Select at least one correct option", path: ["options"] });
    if (q.type === "TRUE_FALSE" && (q.options.length !== 2 || correct !== 1)) ctx.addIssue({ code: "custom", message: "True/False needs exactly two options with one correct", path: ["options"] });
  });

async function assertTopic(tx: Tx, subjectId: string, topicId?: string | null) {
  if (!topicId) return;
  const t = await tx.cBTTopic.findUnique({ where: { id: topicId } });
  if (!t || t.subjectId !== subjectId) throw validation("Topic does not belong to that subject");
}

export async function createQuestionTx(tx: Tx, ctx: SecurityContext, raw: z.input<typeof QuestionInput>, opts: { audit?: boolean } = {}) {
  const i = QuestionInput.parse(raw);
  if (!(await tx.subject.findUnique({ where: { id: i.subjectId } }))) throw notFound("Subject");
  await assertTopic(tx, i.subjectId, i.topicId);
  const { options, ...q } = i;
  const created = await tx.cBTQuestion.create({
    data: { ...q, topicId: q.topicId ?? null, year: q.year ?? null, createdById: ctx.user.id, options: { create: options.map((o, idx) => ({ label: o.label.toUpperCase(), text: o.text, isCorrect: o.isCorrect, sortOrder: idx })) } },
    include: { options: true },
  });
  if (opts.audit !== false) await auditIn(tx, ctx, { action: "cbt.question_create", module: "cbt", entityType: "CBTQuestion", entityId: created.id, after: { subjectId: i.subjectId, examBody: i.examBody, type: i.type } });
  return created;
}

export const createQuestion = (ctx: SecurityContext, raw: z.input<typeof QuestionInput>) => transact((tx) => createQuestionTx(tx, ctx, raw));

/** Bulk insert (all-or-nothing) used by the import pipeline. */
export async function createQuestionsBulk(ctx: SecurityContext, rows: z.input<typeof QuestionInput>[]) {
  const parsed = rows.map((r, idx) => {
    const p = QuestionInput.safeParse(r);
    if (!p.success) throw validation(`Question ${idx + 1}: ${p.error.issues[0]?.message}`, { index: idx });
    return p.data;
  });
  return transact(async (tx) => {
    let count = 0;
    for (const i of parsed) {
      await assertTopic(tx, i.subjectId, i.topicId);
      const { options, ...q } = i;
      await tx.cBTQuestion.create({ data: { ...q, topicId: q.topicId ?? null, year: q.year ?? null, createdById: ctx.user.id, options: { create: options.map((o, idx) => ({ label: o.label.toUpperCase(), text: o.text, isCorrect: o.isCorrect, sortOrder: idx })) } } });
      count += 1;
    }
    await auditIn(tx, ctx, { action: "cbt.questions_bulk_create", module: "cbt", metadata: { count } });
    return { count };
  }, { timeoutMs: 60_000 });
}

export async function updateQuestion(ctx: SecurityContext, id: string, raw: z.input<typeof QuestionInput> & { version: number }) {
  const { version, ...rest } = raw;
  const i = QuestionInput.parse(rest);
  return transact(async (tx) => {
    const before = await tx.cBTQuestion.findUnique({ where: { id }, include: { options: true } });
    if (!before) throw notFound("Question");
    const used = await tx.cBTAnswer.count({ where: { examQuestion: { questionId: id } } });
    if (used) throw conflict("This question has already been answered in an exam. Retire it and create a corrected copy instead.");
    await assertTopic(tx, i.subjectId, i.topicId);
    const { options, ...q } = i;
    const r = await tx.cBTQuestion.updateMany({ where: { id, version }, data: { ...q, topicId: q.topicId ?? null, year: q.year ?? null, version: { increment: 1 } } });
    assertUpdated(r.count, "Question", before.version);
    await tx.cBTQuestionOption.deleteMany({ where: { questionId: id } });
    await tx.cBTQuestionOption.createMany({ data: options.map((o, idx) => ({ questionId: id, label: o.label.toUpperCase(), text: o.text, isCorrect: o.isCorrect, sortOrder: idx })) });
    await auditIn(tx, ctx, { action: "cbt.question_update", module: "cbt", entityType: "CBTQuestion", entityId: id });
    return tx.cBTQuestion.findUniqueOrThrow({ where: { id }, include: { options: true } });
  });
}

export async function retireQuestion(ctx: SecurityContext, id: string, active = false) {
  return transact(async (tx) => {
    const r = await tx.cBTQuestion.updateMany({ where: { id }, data: { isActive: active, version: { increment: 1 } } });
    if (!r.count) throw notFound("Question");
    await auditIn(tx, ctx, { action: active ? "cbt.question_restore" : "cbt.question_retire", module: "cbt", entityType: "CBTQuestion", entityId: id });
  });
}

export const QuestionQuery = z.object({
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
  subjectId: uuid.optional(), topicId: uuid.optional(), examBody: z.enum(["INTERNAL", "WAEC", "NECO", "JAMB", "BECE"]).optional(),
  year: z.coerce.number().int().optional(), difficulty: z.enum(["EASY", "MEDIUM", "HARD"]).optional(), q: z.string().trim().max(100).optional(),
  active: z.enum(["true", "false"]).default("true"),
});

export async function listQuestions(raw: z.input<typeof QuestionQuery>) {
  const q = QuestionQuery.parse(raw);
  const where = {
    isActive: q.active === "true",
    ...(q.subjectId ? { subjectId: q.subjectId } : {}), ...(q.topicId ? { topicId: q.topicId } : {}), ...(q.examBody ? { examBody: q.examBody } : {}),
    ...(q.year ? { year: q.year } : {}), ...(q.difficulty ? { difficulty: q.difficulty } : {}), ...(q.q ? { stem: ilike(q.q) } : {}),
  };
  const [items, total] = await Promise.all([
    db.cBTQuestion.findMany({ where, include: { options: { orderBy: { sortOrder: "asc" } }, subject: { select: { name: true } }, topic: { select: { name: true } } }, orderBy: { createdAt: "desc" }, ...skipTake(q) }),
    db.cBTQuestion.count({ where }),
  ]);
  return asPage(items, total, q);
}

export async function createTopic(ctx: SecurityContext, raw: { subjectId: string; name: string; parentId?: string | null; examBody?: "INTERNAL" | "WAEC" | "NECO" | "JAMB" | "BECE" | null }) {
  const i = z.object({ subjectId: uuid, name: z.string().trim().min(2).max(100), parentId: uuid.nullable().optional(), examBody: z.enum(["INTERNAL", "WAEC", "NECO", "JAMB", "BECE"]).nullable().optional() }).parse(raw);
  return transact(async (tx) => {
    if (i.parentId) {
      const p = await tx.cBTTopic.findUnique({ where: { id: i.parentId } });
      if (!p || p.subjectId !== i.subjectId) throw validation("Parent topic must belong to the same subject");
    }
    const existing = await tx.cBTTopic.findFirst({ where: { subjectId: i.subjectId, parentId: i.parentId ?? null, name: i.name } });
    if (existing) throw conflict("That topic already exists");
    const t = await tx.cBTTopic.create({ data: { subjectId: i.subjectId, name: i.name, parentId: i.parentId ?? null, examBody: i.examBody ?? null } });
    await auditIn(tx, ctx, { action: "cbt.topic_create", module: "cbt", entityType: "CBTTopic", entityId: t.id, after: t });
    return t;
  });
}

export async function listTopics(subjectId: string) {
  return db.cBTTopic.findMany({ where: { subjectId }, orderBy: [{ parentId: "asc" }, { name: "asc" }], include: { _count: { select: { questions: true } } } });
}

/** Question availability per body/subject — drives the practice builder ("42 questions available"). */
export async function bankStats(filter: { examBody?: string; subjectId?: string } = {}) {
  const g = await db.cBTQuestion.groupBy({ by: ["subjectId", "examBody", "difficulty"], where: { isActive: true, ...(filter.examBody ? { examBody: filter.examBody as never } : {}), ...(filter.subjectId ? { subjectId: filter.subjectId } : {}) }, _count: true });
  const subjects = await db.subject.findMany({ where: { id: { in: [...new Set(g.map((x) => x.subjectId))] } }, select: { id: true, name: true } });
  return g.map((x) => ({ subjectId: x.subjectId, subject: subjects.find((s) => s.id === x.subjectId)?.name ?? "", examBody: x.examBody, difficulty: x.difficulty, count: x._count }));
}
