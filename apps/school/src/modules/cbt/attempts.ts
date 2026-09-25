import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, transact, Decimal, type Tx } from "@/platform/db";
import type { SecurityContext } from "@/platform/security/context";
import { auditIn } from "@/platform/security/interceptor";
import { audit } from "@/platform/audit";
import { enqueueSync } from "@/platform/sync/outbox";
import { publishEvent } from "@/platform/events";
import { getSetting } from "@/platform/settings";
import { AppError, conflict, forbidden, notFound, validation } from "@/platform/errors";
import { uuid } from "@/platform/util";
import type { Prisma } from "@/generated/prisma/client";
import { answerAcceptable, attemptDeadline, saveWindow, scoreAttempt, seedFrom, shuffled } from "./scoring";

interface FrozenOrder {
  questions: string[]; // examQuestionIds in the order this student sees them
  options: Record<string, string[]>; // examQuestionId → option ids in display order
  revealed: string[]; // practice: answers already revealed (locked)
}

const studentOf = async (ctx: SecurityContext) => {
  const s = await db.studentProfile.findFirst({ where: { userId: ctx.user.id, deletedAt: null, status: "ACTIVE" }, include: { enrollments: { where: { status: "ACTIVE" }, select: { classId: true } } } });
  if (!s) throw forbidden("Only active students can sit CBT exams");
  return s;
};

async function ownAttempt(ctx: SecurityContext, attemptId: string) {
  const s = await studentOf(ctx);
  const a = await db.cBTAttempt.findUnique({ where: { id: attemptId }, include: { exam: true } });
  if (!a || a.studentId !== s.id) throw notFound("Attempt"); // never reveal another student's attempt
  return { attempt: a, student: s };
}

// ───────────── Start / resume ─────────────

export async function startAttempt(ctx: SecurityContext, examId: string, clientSessionId?: string) {
  try {
    return await startOnce(ctx, examId, clientSessionId);
  } catch (err) {
    // Double-click / two tabs racing: the unique index rejected the second insert → resume the winner.
    if (String((err as { code?: string }).code) === "P2002" || String(err).includes("Unique constraint")) return startOnce(ctx, examId, clientSessionId);
    throw err;
  }
}

async function startOnce(ctx: SecurityContext, examId: string, clientSessionId?: string) {
  const student = await studentOf(ctx);
  const cfg = await getSetting("cbt.defaults");
  return transact(async (tx) => {
    const exam = await tx.cBTExam.findUnique({ where: { id: examId }, include: { questions: { orderBy: { sortOrder: "asc" }, include: { question: { include: { options: { orderBy: { sortOrder: "asc" } } } } } } } });
    if (!exam) throw notFound("Exam");
    const now = new Date();

    const running = await tx.cBTAttempt.findFirst({ where: { examId, studentId: student.id, status: "IN_PROGRESS" } });
    if (running) {
      const w = saveWindow(now, running.deadlineAt, cfg.graceSeconds, cfg.offlineSyncWindowMinutes);
      if (w !== "CLOSED") return { attemptId: running.id, resumed: true, deadlineAt: running.deadlineAt, serverNow: now };
      await finalizeAttemptTx(tx, running.id, "expired-on-resume");
    }

    if (exam.status !== "OPEN" && exam.status !== "SCHEDULED") throw new AppError("EXAM_NOT_OPEN", "This exam is not open", 409);
    if (exam.opensAt && exam.opensAt > now) throw new AppError("EXAM_NOT_OPEN", "This exam has not opened yet", 409, { opensAt: exam.opensAt });
    if (exam.closesAt && exam.closesAt < now) throw new AppError("EXAM_CLOSED", "This exam window has closed", 409);
    if (exam.kind === "SCHOOL") {
      if (!exam.classIds.some((c) => student.enrollments.some((e) => e.classId === c))) throw forbidden("This exam is not assigned to your class");
    } else if (exam.createdById && exam.createdById !== ctx.user.id) {
      throw notFound("Exam");
    }
    if (!exam.questions.length) throw validation("This exam has no questions");
    const used = await tx.cBTAttempt.count({ where: { examId, studentId: student.id } });
    if (used >= exam.maxAttempts) throw new AppError("ATTEMPTS_EXHAUSTED", "You have used all your attempts for this exam", 409);

    const id = randomUUID();
    const seed = seedFrom(id);
    const bySection = new Map<string | null, string[]>();
    for (const q of exam.questions) (bySection.get(q.sectionId) ?? bySection.set(q.sectionId, []).get(q.sectionId)!).push(q.id);
    const sectionIds = [...new Set(exam.questions.map((q) => q.sectionId))];
    const order: string[] = sectionIds.flatMap((sid) => (exam.shuffleQuestions ? shuffled(bySection.get(sid)!, seed) : bySection.get(sid)!));
    const options: FrozenOrder["options"] = {};
    for (const q of exam.questions) {
      const ids = q.question.options.map((o) => o.id);
      options[q.id] = exam.shuffleOptions && q.question.type !== "TRUE_FALSE" ? shuffled(ids, seedFrom(id + q.id)) : ids;
    }
    const frozen: FrozenOrder = { questions: order, options, revealed: [] };
    const attempt = await tx.cBTAttempt.create({
      data: { id, examId, studentId: student.id, attemptNumber: used + 1, startedAt: now, deadlineAt: attemptDeadline({ startedAt: now, durationMinutes: exam.durationMinutes, closesAt: exam.closesAt }), questionOrder: frozen as unknown as Prisma.InputJsonValue, clientSessionId },
    });
    await audit(tx, { actorId: ctx.user.id, actorName: ctx.user.name, action: "cbt.attempt_start", module: "cbt", entityType: "CBTAttempt", entityId: id, metadata: { examId, attemptNumber: attempt.attemptNumber }, ip: ctx.ip });
    return { attemptId: id, resumed: false, deadlineAt: attempt.deadlineAt, serverNow: now };
  });
}

// ───────────── Paper (never contains answers) ─────────────

export async function getPaper(ctx: SecurityContext, attemptId: string) {
  let { attempt } = await ownAttempt(ctx, attemptId);
  const cfg = await getSetting("cbt.defaults");
  const now = new Date();
  if (attempt.status === "IN_PROGRESS" && saveWindow(now, attempt.deadlineAt, cfg.graceSeconds, cfg.offlineSyncWindowMinutes) === "CLOSED") {
    await transact((tx) => finalizeAttemptTx(tx, attemptId, "expired-on-open"));
    attempt = (await db.cBTAttempt.findUniqueOrThrow({ where: { id: attemptId }, include: { exam: true } }));
  }
  const frozen = attempt.questionOrder as unknown as FrozenOrder;
  const eqs = await db.cBTExamQuestion.findMany({ where: { examId: attempt.examId }, include: { question: { include: { options: true } }, section: true } });
  const eqById = new Map(eqs.map((q) => [q.id, q]));
  const sections = await db.cBTExamSection.findMany({ where: { examId: attempt.examId }, orderBy: { sortOrder: "asc" } });
  const answers = await db.cBTAnswer.findMany({ where: { attemptId } });
  const config = (attempt.exam.config ?? {}) as { instantFeedback?: boolean };
  return {
    attempt: { id: attempt.id, status: attempt.status, startedAt: attempt.startedAt, deadlineAt: attempt.deadlineAt, serverNow: now, autosaveSeq: attempt.autosaveSeq },
    exam: { id: attempt.exam.id, title: attempt.exam.title, kind: attempt.exam.kind, durationMinutes: attempt.exam.durationMinutes, instantFeedback: !!config.instantFeedback, requireFullscreen: cfg.requireFullscreen && attempt.exam.kind === "SCHOOL", autosaveSeconds: cfg.autosaveSeconds },
    sections: sections.map((s) => ({ id: s.id, title: s.title, instructions: s.instructions })),
    questions: frozen.questions.map((id, idx) => {
      const q = eqById.get(id)!;
      const opts = new Map(q.question.options.map((o) => [o.id, o]));
      return {
        examQuestionId: id, number: idx + 1, sectionId: q.sectionId, type: q.question.type, stem: q.question.stem, marks: Number(q.marks),
        options: (frozen.options[id] ?? []).map((oid) => ({ id: oid, label: opts.get(oid)!.label, text: opts.get(oid)!.text })), // NOTE: isCorrect is never sent
        revealed: frozen.revealed.includes(id),
      };
    }),
    answers: Object.fromEntries(answers.map((a) => [a.examQuestionId, { selectedOptionIds: a.selectedOptionIds, flagged: a.flagged, visited: a.visited, clientSeq: a.clientSeq }])),
  };
}

// ───────────── Autosave ─────────────

export const SaveInput = z.object({
  clientSessionId: z.string().max(80).optional(),
  answers: z.array(z.object({
    examQuestionId: uuid,
    selectedOptionIds: z.array(uuid).max(6),
    flagged: z.boolean().default(false),
    visited: z.boolean().default(true),
    /// Monotonic per (attempt, question) on the client. Older writes never overwrite newer ones.
    clientSeq: z.number().int().min(0),
    /// When the student actually made this change on their device (used for offline replays).
    answeredAt: z.string().datetime().optional(),
  })).min(1).max(300),
});

export async function saveAnswers(ctx: SecurityContext, attemptId: string, raw: z.input<typeof SaveInput>) {
  const input = SaveInput.parse(raw);
  const { attempt } = await ownAttempt(ctx, attemptId);
  const cfg = await getSetting("cbt.defaults");
  const now = new Date();
  if (attempt.status !== "IN_PROGRESS") return { status: attempt.status, accepted: 0, staleIgnored: 0, rejectedLate: 0, deadlineAt: attempt.deadlineAt, serverNow: now };
  const window = saveWindow(now, attempt.deadlineAt, cfg.graceSeconds, cfg.offlineSyncWindowMinutes);
  if (window === "CLOSED") {
    await transact((tx) => finalizeAttemptTx(tx, attemptId, "expired-on-save"));
    return { status: "SUBMITTED" as const, accepted: 0, staleIgnored: 0, rejectedLate: input.answers.length, deadlineAt: attempt.deadlineAt, serverNow: now };
  }

  return transact(async (tx) => {
    const frozen = attempt.questionOrder as unknown as FrozenOrder;
    const valid = new Set(frozen.questions);
    const optionSets = new Map(Object.entries(frozen.options).map(([k, v]) => [k, new Set(v)]));
    const existing = new Map((await tx.cBTAnswer.findMany({ where: { attemptId } })).map((a) => [a.examQuestionId, a]));
    let accepted = 0, stale = 0, late = 0;
    for (const a of input.answers) {
      if (!valid.has(a.examQuestionId)) throw validation("Answer refers to a question that is not part of this attempt");
      const allowed = optionSets.get(a.examQuestionId)!;
      if (a.selectedOptionIds.some((o) => !allowed.has(o)) || new Set(a.selectedOptionIds).size !== a.selectedOptionIds.length) throw validation("Answer contains an invalid option");
      const answeredAt = a.answeredAt ? new Date(Math.min(new Date(a.answeredAt).getTime(), now.getTime())) : null;
      if (!answerAcceptable(window, answeredAt, attempt.deadlineAt, cfg.graceSeconds)) { late += 1; continue; }
      if (frozen.revealed.includes(a.examQuestionId)) { stale += 1; continue; } // practice: locked after reveal
      const cur = existing.get(a.examQuestionId);
      if (cur && a.clientSeq <= cur.clientSeq) { stale += 1; continue; }
      const data = { selectedOptionIds: a.selectedOptionIds, flagged: a.flagged, visited: a.visited, clientSeq: a.clientSeq, answeredAt: a.selectedOptionIds.length ? (answeredAt ?? now) : null };
      if (cur) await tx.cBTAnswer.update({ where: { id: cur.id }, data });
      else await tx.cBTAnswer.create({ data: { attemptId, examQuestionId: a.examQuestionId, ...data } });
      accepted += 1;
    }
    await tx.cBTAttempt.update({ where: { id: attemptId }, data: { autosaveSeq: { increment: 1 }, lastSavedAt: now, clientSessionId: input.clientSessionId ?? attempt.clientSessionId } });
    if (window === "OFFLINE_SYNC_ONLY" && accepted) await audit(tx, { actorId: ctx.user.id, actorName: ctx.user.name, action: "cbt.offline_sync_after_deadline", module: "cbt", entityType: "CBTAttempt", entityId: attemptId, metadata: { accepted, rejectedLate: late }, ip: ctx.ip });
    return { status: "IN_PROGRESS" as const, accepted, staleIgnored: stale, rejectedLate: late, deadlineAt: attempt.deadlineAt, serverNow: now };
  });
}

/** Practice only: reveal the key + explanation for one question, then lock that answer. */
export async function revealAnswer(ctx: SecurityContext, attemptId: string, examQuestionId: string) {
  const { attempt } = await ownAttempt(ctx, attemptId);
  const config = (attempt.exam.config ?? {}) as { instantFeedback?: boolean };
  if (attempt.exam.kind === "SCHOOL" || !config.instantFeedback) throw forbidden("Answers cannot be revealed during this exam");
  if (attempt.status !== "IN_PROGRESS") throw conflict("This attempt is finished");
  const frozen = attempt.questionOrder as unknown as FrozenOrder;
  if (!frozen.questions.includes(examQuestionId)) throw notFound("Question");
  const eq = await db.cBTExamQuestion.findUniqueOrThrow({ where: { id: examQuestionId }, include: { question: { include: { options: true } } } });
  if (!frozen.revealed.includes(examQuestionId)) {
    frozen.revealed.push(examQuestionId);
    await db.cBTAttempt.update({ where: { id: attemptId }, data: { questionOrder: frozen as unknown as Prisma.InputJsonValue } });
  }
  return { correctOptionIds: eq.question.options.filter((o) => o.isCorrect).map((o) => o.id), explanation: eq.question.explanation };
}

// ───────────── Finalise / score ─────────────

export async function submitAttempt(ctx: SecurityContext, attemptId: string, finalAnswers?: z.input<typeof SaveInput>) {
  const { attempt } = await ownAttempt(ctx, attemptId);
  if (attempt.status === "IN_PROGRESS" && finalAnswers?.answers?.length) await saveAnswers(ctx, attemptId, finalAnswers).catch((e) => { if (!(e instanceof AppError)) throw e; });
  const result = await transact((tx) => finalizeAttemptTx(tx, attemptId, "student-submit", ctx));
  return { status: "SUBMITTED" as const, ...visibleResult(result.result, result.exam) };
}

function visibleResult(r: { score: Decimal; totalMarks: Decimal; percentage: Decimal; passed: boolean; correctCount: number; wrongCount: number; unansweredCount: number; publishedAt: Date | null }, exam: { showResultImmediately: boolean; kind: string }) {
  const visible = !!r.publishedAt;
  return visible
    ? { resultAvailable: true as const, score: Number(r.score), totalMarks: Number(r.totalMarks), percentage: Number(r.percentage), passed: r.passed, correct: r.correctCount, wrong: r.wrongCount, unanswered: r.unansweredCount }
    : { resultAvailable: false as const, message: "Your answers have been submitted. Your teacher will publish the results." };
}

/**
 * Idempotent: locks the attempt row, so a submit racing an expiry sweep scores exactly once.
 * Returns the (existing or new) result.
 */
export async function finalizeAttemptTx(tx: Tx, attemptId: string, reason: string, ctx?: SecurityContext) {
  await tx.$queryRaw`SELECT id FROM cbt_attempts WHERE id = ${attemptId}::uuid FOR UPDATE`;
  const attempt = await tx.cBTAttempt.findUniqueOrThrow({ where: { id: attemptId }, include: { exam: true, answers: true, result: true } });
  if (attempt.status !== "IN_PROGRESS" && attempt.result) return { result: attempt.result, exam: attempt.exam, alreadyFinal: true };
  const eqs = await tx.cBTExamQuestion.findMany({ where: { examId: attempt.examId }, include: { question: { include: { options: true } } } });
  const outcome = scoreAttempt(
    eqs.map((q) => ({ examQuestionId: q.id, marks: Number(q.marks), topicId: q.question.topicId, correctOptionIds: q.question.options.filter((o) => o.isCorrect).map((o) => o.id) })),
    attempt.answers.map((a) => ({ examQuestionId: a.examQuestionId, selectedOptionIds: a.selectedOptionIds })),
  );
  const now = new Date();
  await tx.cBTAttempt.update({ where: { id: attemptId }, data: { status: now > attempt.deadlineAt ? "EXPIRED" : "SUBMITTED", submittedAt: now, version: { increment: 1 } } });
  const immediate = attempt.exam.showResultImmediately || attempt.exam.kind !== "SCHOOL";
  const result = await tx.cBTResult.create({
    data: {
      attemptId, score: outcome.score, totalMarks: outcome.totalMarks, percentage: outcome.percentage, passed: outcome.percentage >= Number(attempt.exam.passMark),
      correctCount: outcome.correctCount, wrongCount: outcome.wrongCount, unansweredCount: outcome.unansweredCount, breakdown: { byTopic: outcome.byTopic, perQuestion: outcome.perQuestion },
      publishedAt: immediate ? now : null,
    },
  });
  for (const [topicId, t] of Object.entries(outcome.byTopic)) {
    await tx.cBTTopicPerformance.upsert({ where: { studentId_topicId: { studentId: attempt.studentId, topicId } }, create: { studentId: attempt.studentId, topicId, attempted: t.attempted, correct: t.correct }, update: { attempted: { increment: t.attempted }, correct: { increment: t.correct } } });
  }
  await enqueueSync(tx, "cbt_result", result);
  if (immediate) await publishEvent(tx, "cbt.result_available", { studentId: attempt.studentId, examId: attempt.examId, title: attempt.exam.title, percentage: outcome.percentage });
  const meta = { examId: attempt.examId, reason, score: outcome.score, percentage: outcome.percentage };
  if (ctx) await auditIn(tx, ctx, { action: "cbt.attempt_submit", module: "cbt", entityType: "CBTAttempt", entityId: attemptId, metadata: meta });
  else await audit(tx, { action: "cbt.attempt_finalize", module: "cbt", entityType: "CBTAttempt", entityId: attemptId, metadata: meta });
  return { result, exam: attempt.exam, alreadyFinal: false };
}

/**
 * Sweep: finalise attempts whose deadline + offline-sync window has passed (power cut, closed laptop…),
 * scoring whatever was saved. With `force` (exam closed by staff) every in-progress attempt is finalised now.
 */
export async function finalizeOpenAttempts(opts: { examId?: string; force?: boolean } = {}): Promise<number> {
  const cfg = await getSetting("cbt.defaults");
  const cutoff = new Date(Date.now() - (cfg.offlineSyncWindowMinutes * 60_000 + cfg.graceSeconds * 1000));
  const due = await db.cBTAttempt.findMany({ where: { status: "IN_PROGRESS", ...(opts.examId ? { examId: opts.examId } : {}), ...(opts.force ? {} : { deadlineAt: { lt: cutoff } }) }, select: { id: true } });
  let n = 0;
  for (const a of due) {
    await transact((tx) => finalizeAttemptTx(tx, a.id, opts.force ? "exam-closed" : "deadline-passed"));
    n += 1;
  }
  return n;
}

// ───────────── Results ─────────────

export async function getMyResult(ctx: SecurityContext, attemptId: string) {
  const { attempt } = await ownAttempt(ctx, attemptId);
  if (attempt.status === "IN_PROGRESS") throw conflict("This attempt is still in progress");
  const result = await db.cBTResult.findUnique({ where: { attemptId } });
  if (!result) throw notFound("Result");
  const base = { attemptId, exam: { id: attempt.exam.id, title: attempt.exam.title, kind: attempt.exam.kind }, submittedAt: attempt.submittedAt, ...visibleResult(result, attempt.exam) };
  const config = (attempt.exam.config ?? {}) as { allowReview?: boolean };
  const allowReview = attempt.exam.kind !== "SCHOOL" || !!config.allowReview;
  if (!result.publishedAt || !allowReview) return { ...base, review: null };
  return { ...base, review: await buildReview(attemptId, attempt.examId) };
}

async function buildReview(attemptId: string, examId: string) {
  const attempt = await db.cBTAttempt.findUniqueOrThrow({ where: { id: attemptId }, include: { answers: true, result: true } });
  const frozen = attempt.questionOrder as unknown as FrozenOrder;
  const eqs = await db.cBTExamQuestion.findMany({ where: { examId }, include: { question: { include: { options: true, topic: { select: { name: true } } } } } });
  const byId = new Map(eqs.map((q) => [q.id, q]));
  const per = ((attempt.result?.breakdown ?? {}) as { perQuestion?: Record<string, string> }).perQuestion ?? {};
  return frozen.questions.map((id, idx) => {
    const q = byId.get(id)!;
    const ans = attempt.answers.find((a) => a.examQuestionId === id);
    return {
      number: idx + 1, stem: q.question.stem, topic: q.question.topic?.name ?? null, explanation: q.question.explanation, outcome: per[id] ?? "UNANSWERED", selectedOptionIds: ans?.selectedOptionIds ?? [],
      options: (frozen.options[id] ?? []).map((oid) => { const o = q.question.options.find((x) => x.id === oid)!; return { id: oid, label: o.label, text: o.text, isCorrect: o.isCorrect }; }),
    };
  });
}

export async function reviewAttempt(_ctx: SecurityContext, attemptId: string) {
  const a = await db.cBTAttempt.findUnique({ where: { id: attemptId }, include: { exam: true, student: { select: { firstName: true, lastName: true, admissionNumber: true } }, result: true } });
  if (!a) throw notFound("Attempt");
  return { attempt: { id: a.id, status: a.status, startedAt: a.startedAt, submittedAt: a.submittedAt, deadlineAt: a.deadlineAt, autosaves: a.autosaveSeq }, student: a.student, exam: { id: a.exam.id, title: a.exam.title }, result: a.result, review: a.status === "IN_PROGRESS" ? null : await buildReview(attemptId, a.examId) };
}

export async function publishExamResults(ctx: SecurityContext, examId: string) {
  return transact(async (tx) => {
    const exam = await tx.cBTExam.findUnique({ where: { id: examId } });
    if (!exam) throw notFound("Exam");
    if (await tx.cBTAttempt.count({ where: { examId, status: "IN_PROGRESS" } })) throw conflict("Some attempts are still in progress. Close the exam first.");
    const pending = await tx.cBTResult.findMany({ where: { publishedAt: null, attempt: { examId } }, include: { attempt: { select: { studentId: true } } } });
    const now = new Date();
    for (const r of pending) {
      await tx.cBTResult.update({ where: { id: r.id }, data: { publishedAt: now } });
      await publishEvent(tx, "cbt.result_available", { studentId: r.attempt.studentId, examId, title: exam.title, percentage: Number(r.percentage) });
    }
    await auditIn(tx, ctx, { action: "cbt.results_publish", module: "cbt", entityType: "CBTExam", entityId: examId, metadata: { published: pending.length } });
    return { published: pending.length };
  });
}
