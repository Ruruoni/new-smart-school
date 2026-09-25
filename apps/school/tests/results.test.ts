import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/platform/db";
import * as results from "@/modules/results/service";
import * as people from "@/modules/people/service";
import * as academics from "@/modules/academics/service";
import * as fin from "@/modules/finance/service";
import { setSetting } from "@/platform/settings";
import { hashPassword } from "@/platform/password";
import { teacherOverview } from "@/modules/results/teacher-overview";
import { ctxFor, seedAcademics } from "./fixtures";
import { makeUser, resetDb } from "./helpers";

let S: Awaited<ReturnType<typeof seedAcademics>>;
let csMath: string, csEng: string;
let kids: string[] = [];
let ca1: string, ca2: string, exam: string;
let teacher: Awaited<ReturnType<typeof people.createTeacher>>;

async function scoreAll(classSubjectId: string, values: [number, number, number][]) {
  const entries = kids.flatMap((studentId, i) => [
    { studentId, typeId: ca1, score: values[i]![0] }, { studentId, typeId: ca2, score: values[i]![1] }, { studentId, typeId: exam, score: values[i]![2] },
  ]);
  return results.saveScores(S.admin, { classSubjectId, termId: S.t1.id, entries });
}

beforeEach(async () => {
  await resetDb();
  S = await seedAcademics();
  teacher = await people.createTeacher(S.admin, { firstName: "Mr", lastName: "Bello" });
  csMath = (await academics.assignClassSubject(S.admin, { classId: S.jss1.id, subjectId: S.math.id, teacherId: teacher.teacher.id })).id;
  csEng = (await academics.assignClassSubject(S.admin, { classId: S.jss1.id, subjectId: S.eng.id })).id;
  kids = [];
  for (const n of ["Ada", "Bola", "Chi", "Dayo"]) kids.push((await people.createStudent(S.admin, { firstName: n, lastName: "Pupil", gender: "FEMALE", classId: S.jss1.id, guardians: n === "Ada" ? [{ newParent: { firstName: "Mum", lastName: "Pupil", phone: "08099999999" }, relationship: "Mother" }] : [] })).student.id);
  const sheet = await results.getScoreSheet(S.admin, csMath, S.t1.id);
  [ca1, ca2, exam] = sheet.components.map((c) => c.id) as [string, string, string];
});

describe("score entry", () => {
  it("builds a roster sheet and saves scores with per-cell validation", async () => {
    const r = await results.saveScores(S.admin, { classSubjectId: csMath, termId: S.t1.id, entries: [
      { studentId: kids[0]!, typeId: ca1, score: 18 },
      { studentId: kids[0]!, typeId: ca2, score: 25 }, // over max 20
      { studentId: kids[0]!, typeId: exam, score: 55.555 }, // >2dp
      { studentId: "00000000-0000-4000-8000-000000000000", typeId: ca1, score: 5 }, // not in class
    ] });
    expect(r.saved).toHaveLength(1);
    expect(r.rejected.map((x) => x.reason)).toEqual(["Score cannot exceed 20", "At most 2 decimal places", "Student is not in this class"]);
    const sheet = await results.getScoreSheet(S.admin, csMath, S.t1.id);
    expect(sheet.rows).toHaveLength(4);
    expect(sheet.rows.find((x) => x.studentId === kids[0])!.scores[ca1]).toMatchObject({ score: 18, version: 1 });
  });

  it("detects concurrent edits instead of overwriting", async () => {
    await results.saveScores(S.admin, { classSubjectId: csMath, termId: S.t1.id, entries: [{ studentId: kids[0]!, typeId: ca1, score: 10 }] });
    await results.saveScores(S.admin, { classSubjectId: csMath, termId: S.t1.id, entries: [{ studentId: kids[0]!, typeId: ca1, score: 12, version: 1 }] });
    const stale = await results.saveScores(S.admin, { classSubjectId: csMath, termId: S.t1.id, entries: [{ studentId: kids[0]!, typeId: ca1, score: 19, version: 1 }] });
    expect(stale.conflicts).toEqual([{ studentId: kids[0], typeId: ca1, currentScore: 12, currentVersion: 2 }]);
    expect((await results.getScoreSheet(S.admin, csMath, S.t1.id)).rows.find((r) => r.studentId === kids[0])!.scores[ca1]!.score).toBe(12);
  });

  it("teachers can only enter scores for their own class subjects", async () => {
    await db.user.update({ where: { id: teacher.teacher.userId }, data: { passwordHash: await hashPassword("Teach-pass-1"), mustChangePassword: false } });
    const t = await ctxFor(teacher.username, "Teach-pass-1");
    await expect(results.saveScores(t, { classSubjectId: csMath, termId: S.t1.id, entries: [{ studentId: kids[0]!, typeId: ca1, score: 5 }] })).resolves.toBeTruthy();
    await expect(results.saveScores(t, { classSubjectId: csEng, termId: S.t1.id, entries: [{ studentId: kids[0]!, typeId: ca1, score: 5 }] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(results.getScoreSheet(t, csEng, S.t1.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("locked columns reject edits; only result editors may unlock", async () => {
    await results.setAssessmentsLocked(S.admin, csMath, S.t1.id, true);
    const r = await results.saveScores(S.admin, { classSubjectId: csMath, termId: S.t1.id, entries: [{ studentId: kids[0]!, typeId: ca1, score: 5 }] });
    expect(r.rejected[0]!.reason).toMatch(/locked/);
    await results.setAssessmentsLocked(S.admin, csMath, S.t1.id, false);
    expect((await results.saveScores(S.admin, { classSubjectId: csMath, termId: S.t1.id, entries: [{ studentId: kids[0]!, typeId: ca1, score: 5 }] })).saved).toHaveLength(1);
  });
});

describe("processing", () => {
  const marks: [number, number, number][] = [[18, 19, 55], [15, 15, 40], [15, 15, 40], [5, 5, 20]]; // 92, 70, 70, 30

  it("computes totals, grades, tied positions and averages; rerun is idempotent", async () => {
    await scoreAll(csMath, marks);
    const sum = await results.processResults(S.admin, { termId: S.t1.id, classId: S.jss1.id, allowIncomplete: true });
    expect(sum.subjectResults).toBe(4);
    const rows = await db.examResult.findMany({ where: { classSubjectId: csMath }, orderBy: { total: "desc" } });
    expect(rows.map((r) => [Number(r.total), r.grade, r.subjectPosition])).toEqual([[92, "A1", 1], [70, "B2", 2], [70, "B2", 2], [30, "F9", 4]]);
    expect(Number(rows[0]!.classAverage)).toBe(65.5);
    const cards = await db.reportCard.findMany({ orderBy: { position: "asc" } });
    expect(cards.map((c) => c.position)).toEqual([1, 2, 2, 4]);
    expect(cards[0]!.classSize).toBe(4);
    await results.processResults(S.admin, { termId: S.t1.id, classId: S.jss1.id, allowIncomplete: true });
    expect(await db.examResult.count()).toBe(4);
    expect(await db.reportCard.count()).toBe(4);
  });

  it("refuses to process incomplete score sheets unless explicitly allowed", async () => {
    await results.saveScores(S.admin, { classSubjectId: csMath, termId: S.t1.id, entries: [{ studentId: kids[0]!, typeId: ca1, score: 10 }] });
    await expect(results.processResults(S.admin, { termId: S.t1.id, classId: S.jss1.id })).rejects.toMatchObject({ code: "INCOMPLETE_SCORES" });
    expect(await db.examResult.count()).toBe(0); // all-or-nothing
  });

  it("uses cumulative average across the year's terms", async () => {
    await scoreAll(csMath, marks);
    await results.processResults(S.admin, { termId: S.t1.id, classId: S.jss1.id, allowIncomplete: true });
    // second term
    const sheet2 = await results.getScoreSheet(S.admin, csMath, S.t2.id);
    const [c1, c2, ex] = sheet2.components.map((c) => c.id) as [string, string, string];
    await results.saveScores(S.admin, { classSubjectId: csMath, termId: S.t2.id, entries: kids.flatMap((studentId) => [{ studentId, typeId: c1, score: 20 }, { studentId, typeId: c2, score: 20 }, { studentId, typeId: ex, score: 60 }]) });
    await results.processResults(S.admin, { termId: S.t2.id, classId: S.jss1.id, allowIncomplete: true });
    const ada = await db.reportCard.findFirstOrThrow({ where: { studentId: kids[0], termId: S.t2.id } });
    expect(Number(ada.average)).toBe(100);
    expect(Number(ada.cumulativeAverage)).toBe(96); // (92 + 100) / 2
  });
});

describe("publication", () => {
  async function processAll() {
    await scoreAll(csMath, [[18, 19, 55], [15, 15, 40], [15, 15, 40], [5, 5, 20]]);
    await results.processResults(S.admin, { termId: S.t1.id, classId: S.jss1.id, allowIncomplete: true });
  }
  async function parentCtx() {
    const u = await db.user.findFirstOrThrow({ where: { userType: "PARENT" } });
    await db.user.update({ where: { id: u.id }, data: { passwordHash: await hashPassword("Parent-pass-1"), mustChangePassword: false } });
    return ctxFor(u.username, "Parent-pass-1");
  }

  it("publishes atomically, queues sync + notification events, and freezes scores", async () => {
    await processAll();
    const r = await results.publishResults(S.admin, { termId: S.t1.id, classId: S.jss1.id });
    expect(r.reportCards).toBe(4);
    expect(await db.reportCard.count({ where: { status: "PUBLISHED" } })).toBe(4);
    expect(await db.syncQueue.count({ where: { entityType: "report_card" } })).toBe(4);
    expect(await db.domainEvent.count({ where: { type: "result.published" } })).toBe(4);
    const edit = await results.saveScores(S.admin, { classSubjectId: csMath, termId: S.t1.id, entries: [{ studentId: kids[0]!, typeId: ca1, score: 1 }] });
    expect(edit.rejected[0]!.reason).toMatch(/published/);
    // reprocessing never disturbs published rows
    const again = await results.processResults(S.admin, { termId: S.t1.id, classId: S.jss1.id, allowIncomplete: true }).catch((e) => e);
    expect(again.message ?? "").toMatch(/no scores to process/);
    expect(await db.reportCard.count({ where: { status: "PUBLISHED" } })).toBe(4);
  });

  it("parents only ever see published results of their own child", async () => {
    await processAll();
    const parent = await parentCtx();
    await expect(results.getReportCard(parent, kids[0]!, S.t1.id)).rejects.toMatchObject({ code: "NOT_FOUND" }); // draft is invisible
    await results.publishResults(S.admin, { termId: S.t1.id, classId: S.jss1.id });
    const rc = await results.getReportCard(parent, kids[0]!, S.t1.id);
    expect(rc.card.average).toBe(92);
    expect(rc.subjects[0]).toMatchObject({ subject: "Mathematics", grade: "A1", total: 92 });
    await expect(results.getReportCard(parent, kids[1]!, S.t1.id)).rejects.toMatchObject({ code: "NOT_FOUND" }); // someone else's child
  });

  it("financial lockout blocks family access to published results, server-side, and lifts on payment", async () => {
    await processAll();
    await results.publishResults(S.admin, { termId: S.t1.id, classId: S.jss1.id });
    await fin.createFeeStructure(S.admin, { name: "T1", termId: S.t1.id, items: [{ name: "Tuition", amount: 50000 }] });
    await fin.generateInvoice(S.admin, { studentId: kids[0]!, termId: S.t1.id, dueDate: "2020-01-01" });
    await db.$transaction((tx) => setSetting(tx, "finance.lockout", { enabled: true, graceDays: 0, minimumOutstanding: 0, message: "Pay at bursary" }));
    const parent = await parentCtx();
    await expect(results.getReportCard(parent, kids[0]!, S.t1.id)).rejects.toMatchObject({ code: "FINANCIAL_LOCKOUT", details: { outstanding: "50000.00" } });
    await expect(results.getReportCard(S.admin, kids[0]!, S.t1.id)).resolves.toBeTruthy(); // staff unaffected
    await fin.recordPayment(S.admin, { studentId: kids[0]!, amount: 50000, method: "CASH", idempotencyKey: "pay-lockout-0001" });
    await expect(results.getReportCard(parent, kids[0]!, S.t1.id)).resolves.toBeTruthy();
  });

  it("withdrawing hides results from families and allows reprocessing", async () => {
    await processAll();
    await results.publishResults(S.admin, { termId: S.t1.id, classId: S.jss1.id });
    await results.withdrawResults(S.admin, { termId: S.t1.id, classId: S.jss1.id, reason: "Score error found" });
    const parent = await parentCtx();
    await expect(results.getReportCard(parent, kids[0]!, S.t1.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await results.saveScores(S.admin, { classSubjectId: csMath, termId: S.t1.id, entries: [{ studentId: kids[3]!, typeId: exam, score: 30 }] });
    await results.processResults(S.admin, { termId: S.t1.id, classId: S.jss1.id, allowIncomplete: true });
    expect((await db.examResult.findFirstOrThrow({ where: { studentId: kids[3], classSubjectId: csMath } })).status).toBe("DRAFT");
  });
});

describe("promotion", () => {
  it("previews decisions from published averages and applies them into next year", async () => {
    await scoreAll(csMath, [[18, 19, 55], [15, 15, 40], [8, 8, 20], [1, 1, 5]]); // 92, 70, 36, 7
    await results.processResults(S.admin, { termId: S.t1.id, classId: S.jss1.id, allowIncomplete: true });
    await results.publishResults(S.admin, { termId: S.t1.id, classId: S.jss1.id });
    const preview = await results.previewPromotions(S.admin, { classId: S.jss1.id, academicYearId: S.year.id });
    expect(preview.students.map((s) => s.decision).sort()).toEqual(["PROMOTED", "PROMOTED", "REPEATED", "REPEATED"]);
    const next = await academics.createAcademicYear(S.admin, { name: "2026/2027", startDate: "2026-09-01", endDate: "2027-07-31" });
    const sum = await results.applyPromotions(S.admin, { classId: S.jss1.id, academicYearId: S.year.id, nextAcademicYearId: next.id, decisions: preview.students.map((s) => ({ studentId: s.studentId, decision: s.decision as never })) });
    expect(sum).toMatchObject({ promoted: 2, repeated: 2 });
    const moved = await db.enrollment.findFirstOrThrow({ where: { studentId: kids[0], academicYearId: next.id } });
    expect(moved.classId).toBe(S.jss2.id);
    const stayed = await db.enrollment.findFirstOrThrow({ where: { studentId: kids[3], academicYearId: next.id } });
    expect(stayed.classId).toBe(S.jss1.id);
    expect((await db.enrollment.findFirstOrThrow({ where: { studentId: kids[0], academicYearId: S.year.id } })).status).toBe("COMPLETED");
  });
  it("rejects promotion of a class with no next class and graduates instead", async () => {
    const next = await academics.createAcademicYear(S.admin, { name: "2026/2027", startDate: "2026-09-01", endDate: "2027-07-31" });
    const s = (await people.createStudent(S.admin, { firstName: "Senior", lastName: "One", gender: "MALE", classId: S.ss1.id })).student;
    await expect(results.applyPromotions(S.admin, { classId: S.ss1.id, academicYearId: S.year.id, nextAcademicYearId: next.id, decisions: [{ studentId: s.id, decision: "PROMOTED" }] })).rejects.toThrow(/no next class/);
    await results.applyPromotions(S.admin, { classId: S.ss1.id, academicYearId: S.year.id, nextAcademicYearId: next.id, decisions: [{ studentId: s.id, decision: "GRADUATED" }] });
    expect((await db.studentProfile.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("GRADUATED");
  });
});

describe("teacher home (live workload)", () => {
  const asTeacher = async () => {
    const u = await db.user.findUniqueOrThrow({ where: { username: teacher.username } });
    await db.user.update({ where: { id: u.id }, data: { passwordHash: await hashPassword("Pass-word-9"), mustChangePassword: false } });
    return ctxFor(teacher.username, "Pass-word-9");
  };

  it("shows only the teacher's own class-subjects, with score-entry progress that moves as scores are entered", async () => {
    const ctx = await asTeacher();
    let o = await teacherOverview(ctx);
    expect(o.classSubjects.map((c) => c.subject)).toEqual(["Mathematics"]); // English belongs to nobody yet: not theirs
    expect(o.classSubjects[0]).toMatchObject({ class: "JSS 1", students: 4, scoreEntry: { percent: 0, locked: false, published: false }, classPerformance: null });

    // 4 students × 3 components = 12 cells; enter 6 of them
    await results.saveScores(S.admin, { classSubjectId: csMath, termId: S.t1.id, entries: kids.slice(0, 2).flatMap((studentId) => [{ studentId, typeId: ca1, score: 15 }, { studentId, typeId: ca2, score: 16 }, { studentId, typeId: exam, score: 50 }]) });
    o = await teacherOverview(ctx);
    expect(o.classSubjects[0]!.scoreEntry.percent).toBe(50);

    await scoreAll(csMath, [[15, 16, 50], [10, 10, 30], [12, 14, 40], [18, 19, 58]]);
    expect((await teacherOverview(ctx)).classSubjects[0]!.scoreEntry.percent).toBe(100);

    // after processing, the class average appears; after publishing it is flagged
    await results.processResults(S.admin, { termId: S.t1.id, classId: S.jss1.id, allowIncomplete: true });
    o = await teacherOverview(ctx);
    expect(o.classSubjects[0]!.classPerformance).toMatchObject({ students: 4, average: expect.any(Number) });
    expect(o.classSubjects[0]!.classPerformance!.average).toBeGreaterThan(50);
    expect(o.classSubjects[0]!.scoreEntry.published).toBe(false);
  });

  it("someone who is not a teacher gets an empty, harmless overview; a form teacher sees today's roll-call state", async () => {
    expect(await teacherOverview(S.admin)).toMatchObject({ classSubjects: [], today: { lessons: [], rollCalls: [] } });
    const sec = await academics.createSection(S.admin, { classId: S.jss1.id, name: "Form", capacity: 20 });
    await db.section.update({ where: { id: sec.id }, data: { formTeacherId: teacher.teacher.id } });
    const st = await people.createStudent(S.admin, { firstName: "Roll", lastName: "Call", gender: "MALE", classId: S.jss1.id, sectionId: sec.id });
    const ctx = await asTeacher();
    expect((await teacherOverview(ctx)).today.rollCalls).toEqual([expect.objectContaining({ name: "JSS 1 Form", students: 1, marked: 0, taken: false })]);
    await db.attendanceLog.create({ data: { studentId: st.student.id, date: new Date(new Date().toISOString().slice(0, 10)), session: "DAY", status: "PRESENT" } });
    expect((await teacherOverview(ctx)).today.rollCalls[0]).toMatchObject({ marked: 1, taken: true });
  });
});
