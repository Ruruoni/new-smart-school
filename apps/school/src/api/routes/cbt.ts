import { z } from "zod";
import * as bank from "@/modules/cbt/bank";
import * as exams from "@/modules/cbt/exams";
import * as att from "@/modules/cbt/attempts";
import { examAnalytics, examResultsTable, studentProgress } from "@/modules/cbt/analytics";
import { EXAM_PRESETS } from "@/modules/cbt/scoring";
import { db } from "@/platform/db";
import { uuid } from "@/platform/util";
import { json, route, type RouteDef } from "../router";

const C = { module: "cbt" as const };
const P = { module: "examprep" as const };

export const cbtRoutes: RouteDef[] = [
  // ── question bank ──
  route("GET", "/cbt/questions", { ...C, permission: "cbt.questions" }, async ({ query }) => bank.listQuestions(Object.fromEntries(query.entries()) as never)),
  route("POST", "/cbt/questions", { ...C, permission: "cbt.questions" }, async ({ ctx, req }) => bank.createQuestion(ctx, (await json(req)) as never)),
  route("PUT", "/cbt/questions/:id", { ...C, permission: "cbt.questions" }, async ({ ctx, req, params }) => bank.updateQuestion(ctx, params.id!, (await json(req)) as never)),
  route("POST", "/cbt/questions/:id/retire", { ...C, permission: "cbt.questions" }, async ({ ctx, req, params }) => { await bank.retireQuestion(ctx, params.id!, z.object({ active: z.boolean() }).parse(await json(req)).active); return { ok: true }; }),
  route("GET", "/cbt/topics", { ...C, permission: ["cbt.questions", "cbt.create_exam"] }, async ({ query }) => bank.listTopics(uuid.parse(query.get("subjectId")))),
  route("POST", "/cbt/topics", { ...C, permission: "cbt.questions" }, async ({ ctx, req }) => bank.createTopic(ctx, (await json(req)) as never)),
  route("GET", "/cbt/bank-stats", { ...C, permission: ["cbt.questions", "cbt.create_exam"] }, async ({ query }) => bank.bankStats({ examBody: query.get("examBody") ?? undefined, subjectId: query.get("subjectId") ?? undefined })),

  // ── exams (staff) ──
  route("GET", "/cbt/exams", { ...C, permission: "cbt.view" }, async ({ ctx, query }) => exams.listExams(ctx, { kind: (query.get("kind") as never) ?? undefined, status: query.get("status") ?? undefined })),
  route("POST", "/cbt/exams", { ...C, permission: "cbt.create_exam" }, async ({ ctx, req }) => exams.createExam(ctx, (await json(req)) as never)),
  route("GET", "/cbt/exams/:id", { ...C, permission: "cbt.view" }, async ({ params }) => db.cBTExam.findUnique({ where: { id: params.id! }, include: { sections: { orderBy: { sortOrder: "asc" } }, questions: { orderBy: { sortOrder: "asc" }, include: { question: { select: { stem: true, difficulty: true, topic: { select: { name: true } } } } } } } })),
  route("PUT", "/cbt/exams/:id/questions", { ...C, permission: "cbt.create_exam" }, async ({ ctx, req, params }) => { await exams.replaceExamQuestions(ctx, params.id!, (await json<{ sections: never }>(req)).sections); return { ok: true }; }),
  route("POST", "/cbt/exams/:id/status", { ...C, permission: "cbt.start_exam" }, async ({ ctx, req, params }) => exams.setExamStatus(ctx, params.id!, z.object({ status: z.enum(["DRAFT", "SCHEDULED", "OPEN", "CLOSED"]) }).parse(await json(req)).status)),
  route("GET", "/cbt/exams/:id/analytics", { ...C, permission: "cbt.review_attempt" }, async ({ params }) => examAnalytics(params.id!)),
  route("GET", "/cbt/exams/:id/results", { ...C, permission: "cbt.review_attempt" }, async ({ params }) => examResultsTable(params.id!)),
  route("POST", "/cbt/exams/:id/publish", { ...C, permission: "cbt.publish_result" }, async ({ ctx, params }) => att.publishExamResults(ctx, params.id!)),
  route("GET", "/cbt/attempts/:id/review", { ...C, permission: "cbt.review_attempt" }, async ({ ctx, params }) => att.reviewAttempt(ctx, params.id!)),

  // ── student exam room (server-authoritative timer; the paper never contains the key) ──
  route("GET", "/exam/available", { ...C, permission: "cbt.take" }, async ({ ctx }) => exams.availableExams(ctx)),
  route("POST", "/exam/:examId/start", { ...C, permission: "cbt.take" }, async ({ ctx, req, params }) => att.startAttempt(ctx, params.examId!, (await json<{ clientSessionId?: string }>(req).catch((): { clientSessionId?: string } => ({}))).clientSessionId)),
  route("GET", "/exam/attempts/:id/paper", { ...C, permission: "cbt.take" }, async ({ ctx, params }) => att.getPaper(ctx, params.id!)),
  route("POST", "/exam/attempts/:id/save", { ...C, permission: "cbt.take" }, async ({ ctx, req, params }) => att.saveAnswers(ctx, params.id!, (await json(req)) as never)),
  route("POST", "/exam/attempts/:id/reveal", { ...P, permission: "examprep.practice" }, async ({ ctx, req, params }) => att.revealAnswer(ctx, params.id!, z.object({ examQuestionId: uuid }).parse(await json(req)).examQuestionId)),
  route("POST", "/exam/attempts/:id/submit", { ...C, permission: "cbt.take" }, async ({ ctx, req, params }) => att.submitAttempt(ctx, params.id!, (await json(req).catch(() => undefined)) as never)),
  route("GET", "/exam/attempts/:id/result", { ...C, permission: "cbt.take" }, async ({ ctx, params }) => att.getMyResult(ctx, params.id!)),
  route("GET", "/exam/history", { ...C, permission: "cbt.take" }, async ({ ctx }) => {
    const s = await db.studentProfile.findUnique({ where: { userId: ctx.user.id }, select: { id: true } });
    return db.cBTAttempt.findMany({ where: { studentId: s?.id ?? "00000000-0000-4000-8000-000000000000" }, orderBy: { startedAt: "desc" }, take: 50, select: { id: true, status: true, startedAt: true, submittedAt: true, exam: { select: { title: true, kind: true, examBody: true } }, result: { select: { publishedAt: true, percentage: true } } } })
      .then((rows) => rows.map((r) => ({ ...r, result: r.result?.publishedAt ? { percentage: Number(r.result.percentage) } : null })));
  }),

  // ── examination preparation (WAEC / NECO / JAMB / BECE — one engine) ──
  route("GET", "/prep/config", { ...P, permission: "examprep.practice" }, async () => ({
    presets: Object.values(EXAM_PRESETS), bank: await bank.bankStats(), subjects: await db.subject.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  })),
  route("GET", "/prep/topics", { ...P, permission: "examprep.practice" }, async ({ query }) => bank.listTopics(uuid.parse(query.get("subjectId")))),
  route("POST", "/prep/generate", { ...P, permission: "examprep.practice" }, async ({ ctx, req }) => exams.generatePractice(ctx, (await json(req)) as never)),
  route("GET", "/prep/progress", { ...P, permission: "examprep.practice" }, async ({ ctx }) => studentProgress(ctx)),
  route("GET", "/cbt/students/:id/progress", { ...C, permission: "cbt.review_attempt" }, async ({ ctx, params }) => studentProgress(ctx, params.id!)),
];
