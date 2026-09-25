import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/platform/db";
import * as bank from "@/modules/cbt/bank";
import * as exams from "@/modules/cbt/exams";
import * as att from "@/modules/cbt/attempts";
import { examAnalytics, studentProgress } from "@/modules/cbt/analytics";
import * as people from "@/modules/people/service";
import { hashPassword } from "@/platform/password";
import { ctxFor, seedAcademics } from "./fixtures";
import { resetDb } from "./helpers";

let S: Awaited<ReturnType<typeof seedAcademics>>;
let topicA: string, topicB: string;
let questionIds: string[] = [];
let students: { id: string; username: string; ctx: Awaited<ReturnType<typeof ctxFor>> }[] = [];

const opts = (correctIdx: number[], n = 4) => Array.from({ length: n }, (_, i) => ({ label: "ABCDEF"[i]!, text: `Option ${"ABCDEF"[i]}`, isCorrect: correctIdx.includes(i) }));
async function login(username: string) {
  const u = await db.user.findUniqueOrThrow({ where: { username } });
  await db.user.update({ where: { id: u.id }, data: { passwordHash: await hashPassword("Stud-pass-1"), mustChangePassword: false } });
  return ctxFor(username, "Stud-pass-1");
}
async function makeStudent(name: string, classId = S.jss1.id) {
  const r = await people.createStudent(S.admin, { firstName: name, lastName: "Learner", gender: "MALE", classId, createLogin: true });
  return { id: r.student.id, username: r.username!, ctx: await login(r.username!) };
}
async function examWith(over: Partial<Parameters<typeof exams.createExam>[1]> = {}, n = 6) {
  const e = await exams.createExam(S.admin, {
    title: "Maths CA test", kind: "SCHOOL", subjectId: S.math.id, classIds: [S.jss1.id], durationMinutes: 30, maxAttempts: 1,
    sections: [{ title: "Section A", questions: questionIds.slice(0, n).map((q) => ({ questionId: q, marks: 2 })) }], ...over,
  });
  await exams.setExamStatus(S.admin, e.id, "OPEN");
  return e;
}
async function answerKey(attemptId: string) {
  const a = await db.cBTAttempt.findUniqueOrThrow({ where: { id: attemptId } });
  const frozen = a.questionOrder as unknown as { questions: string[] };
  const eqs = await db.cBTExamQuestion.findMany({ where: { id: { in: frozen.questions } }, include: { question: { include: { options: true } } } });
  return { order: frozen.questions, correct: (id: string) => eqs.find((e) => e.id === id)!.question.options.filter((o) => o.isCorrect).map((o) => o.id), wrong: (id: string) => eqs.find((e) => e.id === id)!.question.options.filter((o) => !o.isCorrect).slice(0, 1).map((o) => o.id) };
}

beforeEach(async () => {
  await resetDb();
  S = await seedAcademics();
  topicA = (await bank.createTopic(S.admin, { subjectId: S.math.id, name: "Algebra" })).id;
  topicB = (await bank.createTopic(S.admin, { subjectId: S.math.id, name: "Geometry" })).id;
  questionIds = [];
  for (let i = 0; i < 24; i++) {
    questionIds.push((await bank.createQuestion(S.admin, { subjectId: S.math.id, topicId: i % 3 === 0 ? topicA : topicB, stem: `What is ${i} + ${i}?`, explanation: `Because ${i}+${i}=${2 * i}`, examBody: i < 16 ? "JAMB" : "INTERNAL", year: 2020 + (i % 3), options: opts([i % 4]) })).id);
  }
  students = [await makeStudent("Ada"), await makeStudent("Bola")];
});

describe("question bank", () => {
  it("validates answer keys by question type", async () => {
    const base = { subjectId: S.math.id, stem: "Pick one" };
    await expect(bank.createQuestion(S.admin, { ...base, options: opts([0, 1]) })).rejects.toThrow(/one option must be correct/i);
    await expect(bank.createQuestion(S.admin, { ...base, type: "MCQ_MULTIPLE", options: opts([]) })).rejects.toThrow();
    await expect(bank.createQuestion(S.admin, { ...base, type: "TRUE_FALSE", options: opts([0], 3) })).rejects.toThrow();
    await expect(bank.createQuestion(S.admin, { ...base, options: [{ label: "A", text: "x", isCorrect: true }, { label: "a", text: "y", isCorrect: false }] })).rejects.toThrow(/unique/);
    await expect(bank.createQuestion(S.admin, { ...base, type: "MCQ_MULTIPLE", options: opts([1, 2]) })).resolves.toBeTruthy();
  });
  it("topics must belong to the subject; lists filter", async () => {
    await expect(bank.createQuestion(S.admin, { subjectId: S.eng.id, topicId: topicA, stem: "Wrong topic", options: opts([0]) })).rejects.toThrow(/does not belong/);
    expect((await bank.listQuestions({ examBody: "JAMB", subjectId: S.math.id })).total).toBe(16);
    expect((await bank.listQuestions({ topicId: topicA })).total).toBe(8);
  });
  it("a question that has been answered can no longer be edited", async () => {
    const e = await examWith();
    const { attemptId } = await att.startAttempt(students[0]!.ctx, e.id);
    const k = await answerKey(attemptId);
    await att.saveAnswers(students[0]!.ctx, attemptId, { answers: [{ examQuestionId: k.order[0]!, selectedOptionIds: k.correct(k.order[0]!), clientSeq: 1 }] });
    const q = await db.cBTQuestion.findFirstOrThrow({ where: { examLinks: { some: { id: k.order[0]! } } } });
    await expect(bank.updateQuestion(S.admin, q.id, { version: q.version, subjectId: S.math.id, stem: "Changed", options: opts([1]) })).rejects.toThrow(/already been answered/);
  });
});

describe("starting an exam", () => {
  it("enforces class membership, open status, window and attempt limits", async () => {
    const e = await examWith();
    const outsider = await makeStudent("Outsider", S.jss2.id);
    await expect(att.startAttempt(outsider.ctx, e.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const draft = await exams.createExam(S.admin, { title: "Draft", classIds: [S.jss1.id], durationMinutes: 10, sections: [{ title: "A", questions: [{ questionId: questionIds[0]! }] }] });
    await expect(att.startAttempt(students[0]!.ctx, draft.id)).rejects.toMatchObject({ code: "EXAM_NOT_OPEN" });
    const future = await examWith({ title: "Later", opensAt: new Date(Date.now() + 3_600_000).toISOString(), closesAt: new Date(Date.now() + 7_200_000).toISOString() });
    await expect(att.startAttempt(students[0]!.ctx, future.id)).rejects.toMatchObject({ code: "EXAM_NOT_OPEN" });
    const { attemptId } = await att.startAttempt(students[0]!.ctx, e.id);
    await att.submitAttempt(students[0]!.ctx, attemptId);
    await expect(att.startAttempt(students[0]!.ctx, e.id)).rejects.toMatchObject({ code: "ATTEMPTS_EXHAUSTED" });
  });
  it("resumes the same attempt with the same deadline; racing double-starts create one attempt", async () => {
    const e = await examWith();
    const [a, b] = await Promise.all([att.startAttempt(students[0]!.ctx, e.id), att.startAttempt(students[0]!.ctx, e.id)]);
    expect(a.attemptId).toBe(b.attemptId);
    expect(await db.cBTAttempt.count({ where: { examId: e.id, studentId: students[0]!.id } })).toBe(1);
    const again = await att.startAttempt(students[0]!.ctx, e.id);
    expect(again.resumed).toBe(true);
    expect(again.deadlineAt.getTime()).toBe(a.deadlineAt.getTime());
  });
  it("the attempt deadline is capped by the exam window", async () => {
    const closes = new Date(Date.now() + 5 * 60_000);
    const e = await examWith({ durationMinutes: 60, closesAt: closes.toISOString() });
    const { deadlineAt } = await att.startAttempt(students[0]!.ctx, e.id);
    expect(deadlineAt.getTime()).toBe(closes.getTime());
  });
});

describe("the paper", () => {
  it("never leaks the answer key and is private to its student", async () => {
    const e = await examWith();
    const { attemptId } = await att.startAttempt(students[0]!.ctx, e.id);
    const paper = await att.getPaper(students[0]!.ctx, attemptId);
    expect(paper.questions).toHaveLength(6);
    expect(JSON.stringify(paper)).not.toMatch(/isCorrect|explanation|Because/);
    expect(paper.questions[0]!.options).toHaveLength(4);
    await expect(att.getPaper(students[1]!.ctx, attemptId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(att.saveAnswers(students[1]!.ctx, attemptId, { answers: [{ examQuestionId: paper.questions[0]!.examQuestionId, selectedOptionIds: [], clientSeq: 1 }] })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("shuffling is frozen per attempt: recovery shows the identical paper", async () => {
    const e = await examWith({ shuffleQuestions: true, shuffleOptions: true }, 10);
    const { attemptId } = await att.startAttempt(students[0]!.ctx, e.id);
    const p1 = await att.getPaper(students[0]!.ctx, attemptId);
    const p2 = await att.getPaper(students[0]!.ctx, attemptId);
    expect(p2.questions.map((q) => q.examQuestionId)).toEqual(p1.questions.map((q) => q.examQuestionId));
    expect(p2.questions.map((q) => q.options.map((o) => o.id))).toEqual(p1.questions.map((q) => q.options.map((o) => o.id)));
    const other = await att.getPaper(students[1]!.ctx, (await att.startAttempt(students[1]!.ctx, e.id)).attemptId);
    expect(other.questions.map((q) => q.examQuestionId)).not.toEqual(p1.questions.map((q) => q.examQuestionId));
  });
});

describe("autosave & recovery", () => {
  it("persists on every save and survives a 'refresh' (paper reload restores answers and flags)", async () => {
    const e = await examWith();
    const ctx = students[0]!.ctx;
    const { attemptId } = await att.startAttempt(ctx, e.id);
    const k = await answerKey(attemptId);
    const [q1, q2] = k.order as [string, string];
    await att.saveAnswers(ctx, attemptId, { answers: [{ examQuestionId: q1, selectedOptionIds: k.correct(q1), clientSeq: 1 }, { examQuestionId: q2, selectedOptionIds: [], flagged: true, clientSeq: 1 }] });
    const paper = await att.getPaper(ctx, attemptId);
    expect(paper.answers[q1]).toMatchObject({ selectedOptionIds: k.correct(q1) });
    expect(paper.answers[q2]).toMatchObject({ flagged: true, selectedOptionIds: [] });
  });
  it("older writes never overwrite newer ones (out-of-order / replayed autosaves)", async () => {
    const e = await examWith();
    const ctx = students[0]!.ctx;
    const { attemptId } = await att.startAttempt(ctx, e.id);
    const k = await answerKey(attemptId);
    const q = k.order[0]!;
    await att.saveAnswers(ctx, attemptId, { answers: [{ examQuestionId: q, selectedOptionIds: k.correct(q), clientSeq: 5 }] });
    const r = await att.saveAnswers(ctx, attemptId, { answers: [{ examQuestionId: q, selectedOptionIds: k.wrong(q), clientSeq: 3 }] });
    expect(r).toMatchObject({ accepted: 0, staleIgnored: 1 });
    expect((await att.getPaper(ctx, attemptId)).answers[q]!.selectedOptionIds).toEqual(k.correct(q));
  });
  it("rejects options that are not part of the question", async () => {
    const e = await examWith();
    const { attemptId } = await att.startAttempt(students[0]!.ctx, e.id);
    const k = await answerKey(attemptId);
    await expect(att.saveAnswers(students[0]!.ctx, attemptId, { answers: [{ examQuestionId: k.order[0]!, selectedOptionIds: ["00000000-0000-4000-8000-000000000000"], clientSeq: 1 }] })).rejects.toThrow(/invalid option/);
  });
});

describe("server-authoritative timing and offline sync", () => {
  async function overdueBy(attemptId: string, seconds: number) {
    await db.cBTAttempt.update({ where: { id: attemptId }, data: { deadlineAt: new Date(Date.now() - seconds * 1000) } });
  }
  it("accepts in-time answers that arrive late (offline), rejects answers made after the deadline, closes after the window", async () => {
    const e = await examWith();
    const ctx = students[0]!.ctx;
    const { attemptId } = await att.startAttempt(ctx, e.id);
    const k = await answerKey(attemptId);
    await overdueBy(attemptId, 120); // 2 minutes past the deadline → offline sync window (10 min)
    const inTime = new Date(Date.now() - 300_000).toISOString();
    const tooLate = new Date(Date.now() - 30_000).toISOString();
    const r = await att.saveAnswers(ctx, attemptId, { answers: [
      { examQuestionId: k.order[0]!, selectedOptionIds: k.correct(k.order[0]!), clientSeq: 1, answeredAt: inTime },
      { examQuestionId: k.order[1]!, selectedOptionIds: k.correct(k.order[1]!), clientSeq: 1, answeredAt: tooLate },
      { examQuestionId: k.order[2]!, selectedOptionIds: k.correct(k.order[2]!), clientSeq: 1 }, // no timestamp: cannot prove it was in time
    ] });
    expect(r).toMatchObject({ accepted: 1, rejectedLate: 2, status: "IN_PROGRESS" });
    expect(await db.auditLog.count({ where: { action: "cbt.offline_sync_after_deadline" } })).toBe(1);
    await overdueBy(attemptId, 20 * 60); // 20 minutes past → closed
    const closed = await att.saveAnswers(ctx, attemptId, { answers: [{ examQuestionId: k.order[3]!, selectedOptionIds: k.correct(k.order[3]!), clientSeq: 1, answeredAt: inTime }] });
    expect(closed).toMatchObject({ status: "SUBMITTED", accepted: 0 });
    const result = await db.cBTResult.findUniqueOrThrow({ where: { attemptId } });
    expect(Number(result.score)).toBe(2); // one correct answer × 2 marks was kept
    expect((await db.cBTAttempt.findUniqueOrThrow({ where: { id: attemptId } })).status).toBe("EXPIRED");
  });
  it("the sweep finalises abandoned attempts using whatever was saved (power cut)", async () => {
    const e = await examWith();
    const ctx = students[0]!.ctx;
    const { attemptId } = await att.startAttempt(ctx, e.id);
    const k = await answerKey(attemptId);
    await att.saveAnswers(ctx, attemptId, { answers: k.order.slice(0, 3).map((q, i) => ({ examQuestionId: q, selectedOptionIds: k.correct(q), clientSeq: i + 1 })) });
    expect(await att.finalizeOpenAttempts()).toBe(0); // deadline not reached
    await overdueBy(attemptId, 30 * 60);
    expect(await att.finalizeOpenAttempts()).toBe(1);
    expect(Number((await db.cBTResult.findUniqueOrThrow({ where: { attemptId } })).score)).toBe(6);
    expect(await att.finalizeOpenAttempts()).toBe(0);
  });
  it("closing an exam finalises attempts in progress", async () => {
    const e = await examWith();
    const { attemptId } = await att.startAttempt(students[0]!.ctx, e.id);
    await exams.setExamStatus(S.admin, e.id, "CLOSED");
    expect((await db.cBTAttempt.findUniqueOrThrow({ where: { id: attemptId } })).status).not.toBe("IN_PROGRESS");
    expect(await db.cBTResult.count({ where: { attemptId } })).toBe(1);
  });
});

describe("scoring and result visibility", () => {
  it("scores correctly and is idempotent", async () => {
    const e = await examWith({ showResultImmediately: true });
    const ctx = students[0]!.ctx;
    const { attemptId } = await att.startAttempt(ctx, e.id);
    const k = await answerKey(attemptId);
    const answers = k.order.map((q, i) => ({ examQuestionId: q, selectedOptionIds: i < 4 ? k.correct(q) : i === 4 ? k.wrong(q) : [], clientSeq: 1 }));
    const a = await att.submitAttempt(ctx, attemptId, { answers });
    expect(a).toMatchObject({ status: "SUBMITTED", resultAvailable: true, score: 8, totalMarks: 12, correct: 4, wrong: 1, unanswered: 1 });
    expect(await att.submitAttempt(ctx, attemptId)).toMatchObject({ score: 8 }); // resubmit = same result, no double scoring
    expect(await db.cBTResult.count({ where: { attemptId } })).toBe(1);
    const perf = await db.cBTTopicPerformance.findMany({ where: { studentId: students[0]!.id } });
    expect(perf.reduce((s, p) => s + p.attempted, 0)).toBe(5); // counted once, unanswered excluded
    expect(await db.syncQueue.count({ where: { entityType: "cbt_result" } })).toBe(1);
  });
  it("a submit racing the sweep / a second submit scores exactly once", async () => {
    const e = await examWith({ showResultImmediately: true });
    const ctx = students[0]!.ctx;
    const { attemptId } = await att.startAttempt(ctx, e.id);
    const k = await answerKey(attemptId);
    await att.saveAnswers(ctx, attemptId, { answers: k.order.map((q) => ({ examQuestionId: q, selectedOptionIds: k.correct(q), clientSeq: 1 })) });
    await Promise.all([att.submitAttempt(ctx, attemptId), att.submitAttempt(ctx, attemptId), att.finalizeOpenAttempts({ examId: e.id, force: true })]);
    expect(await db.cBTResult.count({ where: { attemptId } })).toBe(1);
    expect(Number((await db.cBTResult.findUniqueOrThrow({ where: { attemptId } })).score)).toBe(12);
    expect(await db.cBTTopicPerformance.aggregate({ where: { studentId: students[0]!.id }, _sum: { attempted: true } }).then((r) => r._sum.attempted)).toBe(6);
  });
  it("school exams hold results until the teacher publishes; review stays hidden", async () => {
    const e = await examWith({ showResultImmediately: false });
    const ctx = students[0]!.ctx;
    const { attemptId } = await att.startAttempt(ctx, e.id);
    const s = await att.submitAttempt(ctx, attemptId);
    expect(s).toMatchObject({ resultAvailable: false });
    expect(await db.domainEvent.count({ where: { type: "cbt.result_available" } })).toBe(0);
    await expect(att.publishExamResults(S.admin, e.id)).resolves.toEqual({ published: 1 });
    const mine = await att.getMyResult(ctx, attemptId);
    expect(mine).toMatchObject({ resultAvailable: true, review: null });
    expect(await db.domainEvent.count({ where: { type: "cbt.result_available" } })).toBe(1);
    const staff = await att.reviewAttempt(S.admin, attemptId);
    expect(staff.review).toHaveLength(6);
  });
  it("cannot publish while attempts are still running", async () => {
    const e = await examWith();
    await att.startAttempt(students[0]!.ctx, e.id);
    await expect(att.publishExamResults(S.admin, e.id)).rejects.toThrow(/still in progress/);
  });
});

describe("examination preparation engine (WAEC / NECO / JAMB / BECE share it)", () => {
  it("generates a private practice exam from the bank with instant feedback that locks answers", async () => {
    const ctx = students[0]!.ctx;
    const p = await exams.generatePractice(ctx, { examBody: "JAMB", subjectIds: [S.math.id], questionCount: 6, instantFeedback: true });
    expect(p.questions).toBe(6);
    const { attemptId } = await att.startAttempt(ctx, p.examId);
    const paper = await att.getPaper(ctx, attemptId);
    expect(paper.exam.instantFeedback).toBe(true);
    const q = paper.questions[0]!.examQuestionId;
    await att.saveAnswers(ctx, attemptId, { answers: [{ examQuestionId: q, selectedOptionIds: [paper.questions[0]!.options[0]!.id], clientSeq: 1 }] });
    const reveal = await att.revealAnswer(ctx, attemptId, q);
    expect(reveal.correctOptionIds).toHaveLength(1);
    expect(reveal.explanation).toMatch(/Because/);
    const late = await att.saveAnswers(ctx, attemptId, { answers: [{ examQuestionId: q, selectedOptionIds: reveal.correctOptionIds, clientSeq: 2 }] });
    expect(late.staleIgnored).toBe(1); // cannot change an answer after seeing the key
    const done = await att.submitAttempt(ctx, attemptId);
    expect(done).toMatchObject({ resultAvailable: true });
    const mine = await att.getMyResult(ctx, attemptId);
    expect(mine.review).toHaveLength(6); // practice: full review incl. explanations
    // private: another student cannot start it
    await expect(att.startAttempt(students[1]!.ctx, p.examId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("only uses questions of the requested body/year and reports shortages precisely", async () => {
    const ctx = students[0]!.ctx;
    const p = await exams.generatePractice(ctx, { examBody: "JAMB", subjectIds: [S.math.id], year: 2020, questionCount: 5, instantFeedback: false });
    const eqs = await db.cBTExamQuestion.findMany({ where: { examId: p.examId }, include: { question: true } });
    expect(eqs.every((e) => e.question.examBody === "JAMB" && e.question.year === 2020)).toBe(true);
    await expect(exams.generatePractice(ctx, { examBody: "WAEC", subjectIds: [S.math.id], questionCount: 10 })).rejects.toMatchObject({ code: "NOT_ENOUGH_QUESTIONS", details: { available: 0 } });
  });
  it("mock exams shuffle and use preset timing", async () => {
    const p = await exams.generatePractice(students[0]!.ctx, { examBody: "JAMB", mode: "MOCK", subjectIds: [S.math.id], questionCount: 8 });
    const exam = await db.cBTExam.findUniqueOrThrow({ where: { id: p.examId } });
    expect(exam).toMatchObject({ kind: "MOCK", shuffleQuestions: true });
    expect(p.durationMinutes).toBeGreaterThan(0);
  });
  it("weak-topic mode targets the topics the student is worst at", async () => {
    const ctx = students[0]!.ctx;
    await db.cBTTopicPerformance.createMany({ data: [{ studentId: students[0]!.id, topicId: topicA, attempted: 20, correct: 18 }, { studentId: students[0]!.id, topicId: topicB, attempted: 20, correct: 4 }] });
    const p = await exams.generatePractice(ctx, { examBody: "INTERNAL", subjectIds: [S.math.id], questionCount: 5, focusWeakTopics: true, instantFeedback: false });
    const eqs = await db.cBTExamQuestion.findMany({ where: { examId: p.examId }, include: { question: true } });
    expect(eqs.length).toBeGreaterThan(0);
    expect(eqs.every((e) => e.question.topicId === topicB)).toBe(true);
  });
});

describe("analytics", () => {
  it("summarises an exam and a student's progress", async () => {
    const e = await examWith({ showResultImmediately: true });
    const extra = [await makeStudent("Chi"), await makeStudent("Dayo")];
    const all = [...students, ...extra];
    for (const [i, s] of all.entries()) {
      const { attemptId } = await att.startAttempt(s.ctx, e.id);
      const k = await answerKey(attemptId);
      await att.submitAttempt(s.ctx, attemptId, { answers: k.order.map((q, qi) => ({ examQuestionId: q, selectedOptionIds: qi < 6 - i * 2 ? k.correct(q) : k.wrong(q), clientSeq: 1 })) });
    }
    const a = await examAnalytics(e.id);
    expect(a).toMatchObject({ attempts: 4, highest: 100, lowest: 0 });
    expect(a.average).toBeCloseTo(50, 0);
    expect(a.distribution.reduce((s, b) => s + b.count, 0)).toBe(4);
    expect(a.questions).toHaveLength(6);
    const prog = await studentProgress(students[0]!.ctx);
    expect(prog.recent).toHaveLength(1);
  });
});
