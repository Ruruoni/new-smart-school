import { db } from "@/platform/db";
import type { SecurityContext } from "@/platform/security/context";
import { notFound } from "@/platform/errors";
import { histogram, itemAnalysis, weakTopics } from "./scoring";

export async function examAnalytics(examId: string) {
  const exam = await db.cBTExam.findUnique({ where: { id: examId }, include: { questions: { include: { question: { select: { stem: true, topic: { select: { name: true } } } } }, orderBy: { sortOrder: "asc" } } } });
  if (!exam) throw notFound("Exam");
  const results = await db.cBTResult.findMany({ where: { attempt: { examId } }, include: { attempt: { select: { id: true, studentId: true, startedAt: true, submittedAt: true } } } });
  const pct = results.map((r) => Number(r.percentage));
  const avg = pct.length ? Math.round((pct.reduce((s, v) => s + v, 0) / pct.length) * 100) / 100 : null;
  const sorted = [...pct].sort((a, b) => a - b);
  const median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2) : null;
  const items = itemAnalysis(exam.questions.map((q) => q.id), results.map((r) => ({ attemptId: r.attemptId, percentage: Number(r.percentage), perQuestion: ((r.breakdown as { perQuestion?: Record<string, "CORRECT" | "WRONG" | "UNANSWERED"> }).perQuestion ?? {}) })));
  const durations = results.filter((r) => r.attempt.submittedAt).map((r) => (r.attempt.submittedAt!.getTime() - r.attempt.startedAt.getTime()) / 60_000);
  return {
    exam: { id: exam.id, title: exam.title, kind: exam.kind, questions: exam.questions.length },
    attempts: results.length, average: avg, median, highest: sorted.length ? sorted[sorted.length - 1] : null, lowest: sorted.length ? sorted[0] : null,
    passRate: results.length ? Math.round((results.filter((r) => r.passed).length / results.length) * 1000) / 10 : null,
    avgMinutes: durations.length ? Math.round((durations.reduce((s, v) => s + v, 0) / durations.length) * 10) / 10 : null,
    distribution: histogram(pct),
    questions: items.map((it, i) => ({ ...it, number: i + 1, stem: exam.questions[i]!.question.stem.slice(0, 120), topic: exam.questions[i]!.question.topic?.name ?? null })),
    mostMissed: [...items].map((it, i) => ({ number: i + 1, difficulty: it.difficulty })).filter((x) => x.difficulty < 0.5).sort((a, b) => a.difficulty - b.difficulty).slice(0, 5),
  };
}

/** Student-facing progress: recent results by exam body and weakest topics with names. */
export async function studentProgress(ctx: SecurityContext, studentId?: string) {
  const student = studentId
    ? await db.studentProfile.findUnique({ where: { id: studentId } })
    : await db.studentProfile.findUnique({ where: { userId: ctx.user.id } });
  if (!student) throw notFound("Student");
  const results = await db.cBTResult.findMany({ where: { attempt: { studentId: student.id }, publishedAt: { not: null } }, include: { attempt: { select: { submittedAt: true, exam: { select: { title: true, kind: true, examBody: true } } } } }, orderBy: { createdAt: "desc" }, take: 50 });
  const perf = await db.cBTTopicPerformance.findMany({ where: { studentId: student.id }, include: { topic: { select: { name: true, subject: { select: { name: true } } } } } });
  const weak = weakTopics(perf.map((p) => ({ topicId: p.topicId, attempted: p.attempted, correct: p.correct })), 5).map((w) => ({ ...w, topic: perf.find((p) => p.topicId === w.topicId)!.topic.name, subject: perf.find((p) => p.topicId === w.topicId)!.topic.subject.name }));
  const byBody: Record<string, { attempts: number; average: number }> = {};
  for (const r of results) {
    const b = r.attempt.exam.examBody;
    const cur = (byBody[b] ??= { attempts: 0, average: 0 });
    cur.average = (cur.average * cur.attempts + Number(r.percentage)) / (cur.attempts + 1);
    cur.attempts += 1;
  }
  return {
    recent: results.slice(0, 10).map((r) => ({ attemptId: r.attemptId, title: r.attempt.exam.title, kind: r.attempt.exam.kind, examBody: r.attempt.exam.examBody, percentage: Number(r.percentage), at: r.attempt.submittedAt })),
    byExamBody: Object.fromEntries(Object.entries(byBody).map(([k, v]) => [k, { attempts: v.attempts, average: Math.round(v.average * 10) / 10 }])),
    weakTopics: weak.slice(0, 8), strongTopics: [...weak].reverse().slice(0, 5).filter((t) => t.accuracy >= 70),
  };
}

export async function examResultsTable(examId: string) {
  return db.cBTResult.findMany({ where: { attempt: { examId } }, include: { attempt: { select: { student: { select: { firstName: true, lastName: true, admissionNumber: true } }, submittedAt: true, status: true } } }, orderBy: { percentage: "desc" } });
}
