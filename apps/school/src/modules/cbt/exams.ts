import { z } from "zod";
import { db, transact, type Tx } from "@/platform/db";
import type { SecurityContext } from "@/platform/security/context";
import { auditIn } from "@/platform/security/interceptor";
import { AppError, conflict, forbidden, notFound, validation } from "@/platform/errors";
import { uuid } from "@/platform/util";
import { EXAM_PRESETS, shuffled, seedFrom } from "./scoring";
import { finalizeOpenAttempts } from "./attempts";

const body = z.enum(["INTERNAL", "WAEC", "NECO", "JAMB", "BECE"]);

export const ExamInput = z.object({
  title: z.string().trim().min(3).max(150),
  kind: z.enum(["SCHOOL", "PRACTICE", "MOCK"]).default("SCHOOL"),
  examBody: body.default("INTERNAL"),
  subjectId: uuid.nullable().optional(),
  classIds: z.array(uuid).default([]),
  durationMinutes: z.number().int().min(1).max(480),
  passMark: z.number().min(0).max(100).default(50),
  shuffleQuestions: z.boolean().default(false),
  shuffleOptions: z.boolean().default(false),
  maxAttempts: z.number().int().min(1).max(20).default(1),
  opensAt: z.string().datetime().nullable().optional(),
  closesAt: z.string().datetime().nullable().optional(),
  showResultImmediately: z.boolean().default(false),
  sections: z.array(z.object({ title: z.string().trim().min(1).max(100), instructions: z.string().max(1000).optional(), questions: z.array(z.object({ questionId: uuid, marks: z.number().min(0.25).max(100).default(1) })).min(1).max(300) })).min(1).max(12),
});

async function buildQuestionsTx(tx: Tx, examId: string, sections: z.infer<typeof ExamInput>["sections"]) {
  const allIds = sections.flatMap((s) => s.questions.map((q) => q.questionId));
  if (new Set(allIds).size !== allIds.length) throw validation("A question can only appear once in an exam");
  const found = await tx.cBTQuestion.findMany({ where: { id: { in: allIds }, isActive: true }, select: { id: true } });
  if (found.length !== allIds.length) throw validation("Some questions do not exist or have been retired");
  let order = 0;
  for (const [si, s] of sections.entries()) {
    const sec = await tx.cBTExamSection.create({ data: { examId, title: s.title, instructions: s.instructions, sortOrder: si } });
    await tx.cBTExamQuestion.createMany({ data: s.questions.map((q) => ({ examId, sectionId: sec.id, questionId: q.questionId, marks: q.marks, sortOrder: order++ })) });
  }
}

export async function createExam(ctx: SecurityContext, raw: z.input<typeof ExamInput>) {
  const i = ExamInput.parse(raw);
  if (i.opensAt && i.closesAt && new Date(i.opensAt) >= new Date(i.closesAt)) throw validation("The closing time must be after the opening time");
  return transact(async (tx) => {
    const { sections, opensAt, closesAt, ...rest } = i;
    const exam = await tx.cBTExam.create({ data: { ...rest, subjectId: rest.subjectId ?? null, opensAt: opensAt ? new Date(opensAt) : null, closesAt: closesAt ? new Date(closesAt) : null, createdById: ctx.user.id } });
    await buildQuestionsTx(tx, exam.id, sections);
    await auditIn(tx, ctx, { action: "cbt.exam_create", module: "cbt", entityType: "CBTExam", entityId: exam.id, after: { title: exam.title, kind: exam.kind, questions: sections.reduce((n, s) => n + s.questions.length, 0) } });
    return exam;
  });
}

/** Content is frozen once anyone has started: editing questions under a live exam would invalidate results. */
export async function replaceExamQuestions(ctx: SecurityContext, examId: string, sections: z.input<typeof ExamInput>["sections"]) {
  const parsed = ExamInput.shape.sections.parse(sections);
  return transact(async (tx) => {
    const exam = await tx.cBTExam.findUnique({ where: { id: examId } });
    if (!exam) throw notFound("Exam");
    if (exam.status !== "DRAFT") throw conflict("Only draft exams can be edited");
    if (await tx.cBTAttempt.count({ where: { examId } })) throw conflict("This exam already has attempts");
    await tx.cBTExamQuestion.deleteMany({ where: { examId } });
    await tx.cBTExamSection.deleteMany({ where: { examId } });
    await buildQuestionsTx(tx, examId, parsed);
    await tx.cBTExam.update({ where: { id: examId }, data: { version: { increment: 1 } } });
    await auditIn(tx, ctx, { action: "cbt.exam_questions_replace", module: "cbt", entityType: "CBTExam", entityId: examId });
  });
}

const NEXT: Record<string, string[]> = { DRAFT: ["SCHEDULED", "OPEN"], SCHEDULED: ["OPEN", "DRAFT", "CLOSED"], OPEN: ["CLOSED"], CLOSED: [] };

export async function setExamStatus(ctx: SecurityContext, examId: string, status: "DRAFT" | "SCHEDULED" | "OPEN" | "CLOSED") {
  const r = await transact(async (tx) => {
    const exam = await tx.cBTExam.findUnique({ where: { id: examId }, include: { _count: { select: { questions: true, attempts: true } } } });
    if (!exam) throw notFound("Exam");
    if (!NEXT[exam.status]!.includes(status)) throw conflict(`An exam that is ${exam.status.toLowerCase()} cannot become ${status.toLowerCase()}`);
    if (status !== "DRAFT" && status !== "CLOSED" && !exam._count.questions) throw validation("Add questions before scheduling or opening the exam");
    if (status === "DRAFT" && exam._count.attempts) throw conflict("Attempts exist; the exam cannot return to draft");
    const u = await tx.cBTExam.update({ where: { id: examId }, data: { status, version: { increment: 1 } } });
    if (status === "SCHEDULED") await tx.domainEvent.create({ data: { type: "exam.scheduled", payload: { examId, title: exam.title, opensAt: exam.opensAt?.toISOString() ?? null, classIds: exam.classIds } } });
    await auditIn(tx, ctx, { action: "cbt.exam_status", module: "cbt", entityType: "CBTExam", entityId: examId, before: { status: exam.status }, after: { status } });
    return u;
  });
  // Closing an exam finalises every attempt still in progress (submitted answers are scored as they stand).
  if (status === "CLOSED") await finalizeOpenAttempts({ examId, force: true });
  return r;
}

export async function listExams(ctx: SecurityContext, opts: { kind?: "SCHOOL" | "PRACTICE" | "MOCK"; status?: string } = {}) {
  return db.cBTExam.findMany({
    where: { ...(opts.kind ? { kind: opts.kind } : {}), ...(opts.status ? { status: opts.status as never } : {}) },
    include: { subject: { select: { name: true } }, _count: { select: { questions: true, attempts: true } } }, orderBy: { createdAt: "desc" }, take: 200,
  });
}

/** What a signed-in student may sit right now: their class's school exams plus public practice/mocks and their own. */
export async function availableExams(ctx: SecurityContext) {
  const student = await db.studentProfile.findUnique({ where: { userId: ctx.user.id }, include: { enrollments: { where: { status: "ACTIVE" }, select: { classId: true } } } });
  if (!student) throw forbidden("Only students can sit CBT exams");
  const classIds = student.enrollments.map((e) => e.classId);
  const now = new Date();
  const exams = await db.cBTExam.findMany({
    where: {
      status: { in: ["SCHEDULED", "OPEN"] },
      OR: [{ opensAt: null }, { opensAt: { lte: new Date(now.getTime() + 7 * 86_400_000) } }],
      AND: [{ OR: [{ closesAt: null }, { closesAt: { gte: now } }] }, { OR: [{ kind: "SCHOOL", classIds: { hasSome: classIds } }, { kind: { in: ["PRACTICE", "MOCK"] }, classIds: { equals: [] }, createdById: null }, { kind: { in: ["PRACTICE", "MOCK"] }, createdById: ctx.user.id }] }],
    },
    include: { subject: { select: { name: true } }, _count: { select: { questions: true } }, attempts: { where: { studentId: student.id }, select: { id: true, status: true, attemptNumber: true } } },
    orderBy: [{ opensAt: "asc" }, { createdAt: "desc" }],
  });
  return exams.map((e) => ({
    id: e.id, title: e.title, kind: e.kind, examBody: e.examBody, subject: e.subject?.name ?? null, durationMinutes: e.durationMinutes, questions: e._count.questions, opensAt: e.opensAt, closesAt: e.closesAt,
    canStartNow: (!e.opensAt || e.opensAt <= now) && (!e.closesAt || e.closesAt >= now) && e.attempts.filter((a) => a.status !== "IN_PROGRESS").length < e.maxAttempts,
    inProgressAttemptId: e.attempts.find((a) => a.status === "IN_PROGRESS")?.id ?? null, attemptsUsed: e.attempts.length, maxAttempts: e.maxAttempts,
  }));
}

// ───────────── Examination-preparation engine (WAEC / NECO / JAMB / BECE share this one code path) ─────────────

export const PracticeInput = z.object({
  examBody: body,
  mode: z.enum(["PRACTICE", "MOCK"]).default("PRACTICE"),
  subjectIds: z.array(uuid).min(1).max(6),
  topicIds: z.array(uuid).max(50).optional(),
  difficulty: z.enum(["EASY", "MEDIUM", "HARD"]).optional(),
  year: z.number().int().optional(),
  questionCount: z.number().int().min(5).max(120).optional(),
  timed: z.boolean().default(true),
  durationMinutes: z.number().int().min(5).max(240).optional(),
  /// Practise the student's weakest topics (from their history) instead of a fixed topic list.
  focusWeakTopics: z.boolean().default(false),
  /// Show the right answer and explanation after each question (practice only).
  instantFeedback: z.boolean().default(true),
});

/** Build a private PRACTICE/MOCK exam for the calling student from the shared question bank. */
export async function generatePractice(ctx: SecurityContext, raw: z.input<typeof PracticeInput>) {
  const i = PracticeInput.parse(raw);
  const student = await db.studentProfile.findUnique({ where: { userId: ctx.user.id } });
  if (!student) throw forbidden("Only students can create practice sessions");
  const preset = EXAM_PRESETS[i.examBody as keyof typeof EXAM_PRESETS];
  const perSubject = i.questionCount ?? (i.mode === "MOCK" && preset ? preset.questionsPerSubject : 20);

  return transact(async (tx) => {
    const subjects = await tx.subject.findMany({ where: { id: { in: i.subjectIds } }, select: { id: true, name: true } });
    if (subjects.length !== new Set(i.subjectIds).size) throw notFound("Subject");
    let topicIds = i.topicIds;
    if (i.focusWeakTopics) {
      const weak = await tx.cBTTopicPerformance.findMany({ where: { studentId: student.id, attempted: { gte: 3 }, topic: { subjectId: { in: i.subjectIds } } }, orderBy: { attempted: "desc" }, take: 50 });
      // Target topics the student is genuinely weak at (< 60% accuracy); if none qualify, drill the single weakest.
      const ranked = weak.map((w) => ({ id: w.topicId, acc: w.correct / w.attempted })).sort((a, b) => a.acc - b.acc);
      const below = ranked.filter((r) => r.acc < 0.6).slice(0, 5);
      const chosen = below.length ? below : ranked.slice(0, 1);
      if (chosen.length) topicIds = chosen.map((r) => r.id);
    }
    const sections: z.infer<typeof ExamInput>["sections"] = [];
    const seed = seedFrom(`${student.id}:${Date.now()}`);
    for (const subj of subjects) {
      const pool = await tx.cBTQuestion.findMany({
        where: { isActive: true, subjectId: subj.id, examBody: i.examBody, ...(topicIds?.length ? { topicId: { in: topicIds } } : {}), ...(i.difficulty ? { difficulty: i.difficulty } : {}), ...(i.year ? { year: i.year } : {}) },
        select: { id: true },
      });
      if (pool.length < Math.min(5, perSubject)) throw new AppError("NOT_ENOUGH_QUESTIONS", `Only ${pool.length} matching ${subj.name} question(s) are available for ${i.examBody}. Try fewer filters.`, 409, { subject: subj.name, available: pool.length });
      const chosen = shuffled(pool, seed).slice(0, perSubject);
      sections.push({ title: subj.name, instructions: undefined, questions: chosen.map((q) => ({ questionId: q.id, marks: 1 })) });
    }
    const totalQ = sections.reduce((n, s) => n + s.questions.length, 0);
    const minutes = i.timed ? (i.durationMinutes ?? (i.mode === "MOCK" && preset && subjects.length >= 1 ? Math.round((preset.minutesPerMock * totalQ) / (preset.questionsPerSubject * Math.max(1, preset.subjectsPerMock))) : Math.max(10, Math.ceil(totalQ * 1.2)))) : 240;
    const exam = await tx.cBTExam.create({
      data: {
        title: `${preset?.label ?? i.examBody} ${i.mode === "MOCK" ? "mock exam" : "practice"} — ${subjects.map((s) => s.name).join(", ")}`, kind: i.mode, examBody: i.examBody, subjectId: subjects.length === 1 ? subjects[0]!.id : null,
        classIds: [], durationMinutes: Math.min(minutes, 480), passMark: 50, shuffleQuestions: i.mode === "MOCK", shuffleOptions: false, maxAttempts: 1, showResultImmediately: true, status: "OPEN",
        config: { instantFeedback: i.mode === "PRACTICE" && i.instantFeedback, timed: i.timed, studentId: student.id, weakTopicMode: i.focusWeakTopics }, createdById: ctx.user.id,
      },
    });
    await buildQuestionsTx(tx, exam.id, sections);
    await auditIn(tx, ctx, { action: "examprep.generate", module: "examprep", entityType: "CBTExam", entityId: exam.id, metadata: { examBody: i.examBody, mode: i.mode, questions: totalQ } });
    return { examId: exam.id, title: exam.title, questions: totalQ, durationMinutes: exam.durationMinutes };
  });
}
