import { z } from "zod";
import { db, transact, Decimal, type Tx } from "@/platform/db";
import type { SecurityContext } from "@/platform/security/context";
import { auditIn } from "@/platform/security/interceptor";
import { assertCanAccessStudent, assertTeachesClassSubject } from "@/platform/security/scope";
import { enqueueSync } from "@/platform/sync/outbox";
import { publishEvent } from "@/platform/events";
import { AppError, conflict, notFound, validation } from "@/platform/errors";
import { getSetting } from "@/platform/settings";
import { assertUpdated, uuid } from "@/platform/util";
import { assertResultsAccessible } from "@/modules/finance/lockout";
import { average, computeSubject, decidePromotion, gradeFor, rank, round2, type Component, type GradeBand, type ScoreEntry } from "./engine";

// ───────────── Configuration ─────────────

export async function loadScheme(tx: Pick<Tx, "gradingScheme"> = db) {
  const scheme = await tx.gradingScheme.findFirst({ where: { isDefault: true }, include: { rules: true, components: { orderBy: { sortOrder: "asc" } } } });
  if (!scheme) throw new AppError("NO_GRADING_SCHEME", "No default grading scheme is configured", 409);
  const bands: GradeBand[] = scheme.rules.map((r) => ({ grade: r.grade, minScore: Number(r.minScore), maxScore: Number(r.maxScore), remark: r.remark, gradePoint: r.gradePoint === null ? null : Number(r.gradePoint), isPass: r.isPass }));
  const components: (Component & { name: string })[] = scheme.components.map((c) => ({ id: c.id, code: c.code, name: c.name, maxScore: Number(c.maxScore), isExam: c.isExam }));
  return { scheme, bands, components };
}

// ───────────── Score entry (teacher grid) ─────────────

interface RosterRow {
  studentId: string;
  admissionNumber: string;
  firstName: string;
  lastName: string;
}

async function classSubjectRoster(tx: Pick<Tx, "enrollment">, cs: { classId: string; sectionId: string | null }, academicYearId: string): Promise<RosterRow[]> {
  const rows = await tx.enrollment.findMany({
    where: { classId: cs.classId, academicYearId, status: "ACTIVE", student: { status: "ACTIVE", deletedAt: null }, ...(cs.sectionId ? { sectionId: cs.sectionId } : {}) },
    select: { student: { select: { id: true, admissionNumber: true, firstName: true, lastName: true } } },
  });
  return rows.map((r) => ({ studentId: r.student.id, admissionNumber: r.student.admissionNumber, firstName: r.student.firstName, lastName: r.student.lastName })).sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
}

async function ensureAssessments(tx: Tx, classSubjectId: string, termId: string, components: Component[]) {
  const existing = await tx.assessment.findMany({ where: { classSubjectId, termId } });
  const byType = new Map(existing.map((a) => [a.typeId, a]));
  for (const c of components) {
    if (byType.has(c.id)) continue;
    byType.set(c.id, await tx.assessment.create({ data: { classSubjectId, termId, typeId: c.id, title: c.code, maxScore: c.maxScore } }));
  }
  return byType;
}

export async function getScoreSheet(ctx: SecurityContext, classSubjectId: string, termId: string) {
  await assertTeachesClassSubject(ctx, classSubjectId, "assessments.enter_any");
  return transact(async (tx) => {
    const cs = await tx.classSubject.findUnique({ where: { id: classSubjectId }, include: { subject: true, class: true, section: true } });
    const term = await tx.term.findUnique({ where: { id: termId } });
    const { components } = await loadScheme(tx);
    if (!cs) throw notFound("Class subject");
    if (!term) throw notFound("Term");
    const assessments = await ensureAssessments(tx, classSubjectId, termId, components);
    const roster = await classSubjectRoster(tx, cs, term.academicYearId);
    const scores = await tx.assessmentScore.findMany({ where: { assessmentId: { in: [...assessments.values()].map((a) => a.id) }, studentId: { in: roster.map((r) => r.studentId) } } });
    const published = await tx.examResult.count({ where: { classSubjectId, termId, status: "PUBLISHED" } });
    return {
      classSubject: { id: cs.id, subject: cs.subject.name, class: cs.class.name, section: cs.section?.name ?? null },
      term: { id: term.id, name: term.name },
      locked: [...assessments.values()].every((a) => a.status === "LOCKED"),
      published: published > 0,
      components: components.map((c) => ({ id: c.id, code: c.code, name: c.name, maxScore: c.maxScore, isExam: c.isExam })),
      rows: roster.map((r) => ({
        ...r,
        scores: Object.fromEntries(components.map((c) => {
          const a = assessments.get(c.id)!;
          const s = scores.find((x) => x.assessmentId === a.id && x.studentId === r.studentId);
          return [c.id, s ? { score: s.score === null ? null : Number(s.score), isAbsent: s.isAbsent, version: s.version } : { score: null, isAbsent: false, version: 0 }];
        })),
      })),
    };
  });
}

export const ScoreEntryInput = z.object({
  studentId: uuid,
  typeId: uuid,
  score: z.number().min(0).nullable(),
  isAbsent: z.boolean().default(false),
  /// The version the client last saw (0 = never saved). Used to detect concurrent edits.
  version: z.number().int().min(0).optional(),
});
export const SaveScoresInput = z.object({ classSubjectId: uuid, termId: uuid, entries: z.array(ScoreEntryInput).min(1).max(500) });

export interface SaveScoresResult {
  saved: { studentId: string; typeId: string; version: number }[];
  conflicts: { studentId: string; typeId: string; currentScore: number | null; currentVersion: number }[];
  rejected: { studentId: string; typeId: string; reason: string }[];
}

/**
 * Autosave endpoint for the spreadsheet grid. Each cell is validated independently, so one bad cell never
 * discards a whole page of typing; concurrent edits are surfaced as conflicts, never silently overwritten.
 */
export async function saveScores(ctx: SecurityContext, raw: z.input<typeof SaveScoresInput>): Promise<SaveScoresResult> {
  const i = SaveScoresInput.parse(raw);
  await assertTeachesClassSubject(ctx, i.classSubjectId, "assessments.enter_any");
  return transact(async (tx) => {
    const cs = await tx.classSubject.findUnique({ where: { id: i.classSubjectId } });
    const term = await tx.term.findUnique({ where: { id: i.termId } });
    const { components } = await loadScheme(tx);
    if (!cs) throw notFound("Class subject");
    if (!term) throw notFound("Term");
    const assessments = await ensureAssessments(tx, i.classSubjectId, i.termId, components);
    const compById = new Map(components.map((c) => [c.id, c]));
    const roster = new Set((await classSubjectRoster(tx, cs, term.academicYearId)).map((r) => r.studentId));
    const publishedStudents = new Set((await tx.examResult.findMany({ where: { classSubjectId: i.classSubjectId, termId: i.termId, status: "PUBLISHED" }, select: { studentId: true } })).map((r) => r.studentId));
    const out: SaveScoresResult = { saved: [], conflicts: [], rejected: [] };
    const changes: unknown[] = [];

    for (const e of i.entries) {
      const comp = compById.get(e.typeId);
      const a = comp ? assessments.get(e.typeId) : undefined;
      const rej = (reason: string) => out.rejected.push({ studentId: e.studentId, typeId: e.typeId, reason });
      if (!comp || !a) { rej("Unknown score column"); continue; }
      if (a.status === "LOCKED") { rej("Scores for this column are locked"); continue; }
      if (!roster.has(e.studentId)) { rej("Student is not in this class"); continue; }
      if (publishedStudents.has(e.studentId)) { rej("Results are published; withdraw them before editing"); continue; }
      if (e.score !== null && e.score > comp.maxScore) { rej(`Score cannot exceed ${comp.maxScore}`); continue; }
      if (e.score !== null && Math.round(e.score * 100) / 100 !== e.score) { rej("At most 2 decimal places"); continue; }
      const cur = await tx.assessmentScore.findUnique({ where: { assessmentId_studentId: { assessmentId: a.id, studentId: e.studentId } } });
      const score = e.isAbsent ? null : e.score;
      if (cur) {
        if (e.version !== undefined && e.version !== cur.version) {
          out.conflicts.push({ studentId: e.studentId, typeId: e.typeId, currentScore: cur.score === null ? null : Number(cur.score), currentVersion: cur.version });
          continue;
        }
        if ((cur.score === null ? null : Number(cur.score)) === score && cur.isAbsent === e.isAbsent) {
          out.saved.push({ studentId: e.studentId, typeId: e.typeId, version: cur.version });
          continue;
        }
        const u = await tx.assessmentScore.update({ where: { id: cur.id }, data: { score, isAbsent: e.isAbsent, enteredById: ctx.user.id, version: { increment: 1 } } });
        changes.push({ s: e.studentId, t: comp.code, from: cur.score === null ? null : Number(cur.score), to: score, absent: e.isAbsent });
        out.saved.push({ studentId: e.studentId, typeId: e.typeId, version: u.version });
      } else {
        if (e.version !== undefined && e.version > 0) {
          out.conflicts.push({ studentId: e.studentId, typeId: e.typeId, currentScore: null, currentVersion: 0 });
          continue;
        }
        const u = await tx.assessmentScore.create({ data: { assessmentId: a.id, studentId: e.studentId, score, isAbsent: e.isAbsent, enteredById: ctx.user.id } });
        changes.push({ s: e.studentId, t: comp.code, from: null, to: score, absent: e.isAbsent });
        out.saved.push({ studentId: e.studentId, typeId: e.typeId, version: u.version });
      }
    }
    if (changes.length) {
      await auditIn(tx, ctx, { action: "scores.save", module: "results", entityType: "ClassSubject", entityId: i.classSubjectId, metadata: { termId: i.termId, changed: changes.length }, after: { changes } });
    }
    return out;
  });
}

export async function setAssessmentsLocked(ctx: SecurityContext, classSubjectId: string, termId: string, locked: boolean) {
  await assertTeachesClassSubject(ctx, classSubjectId, "assessments.enter_any");
  return transact(async (tx) => {
    // Unlocking is a privileged correction; locking is something a teacher does when done.
    if (!locked && !ctx.can("results.edit")) throw new AppError("FORBIDDEN", "Only result editors can unlock scores", 403);
    const r = await tx.assessment.updateMany({ where: { classSubjectId, termId }, data: { status: locked ? "LOCKED" : "OPEN" } });
    await auditIn(tx, ctx, { action: locked ? "scores.lock" : "scores.unlock", module: "results", entityType: "ClassSubject", entityId: classSubjectId, metadata: { termId, assessments: r.count } });
    return r.count;
  });
}

// ───────────── Processing ─────────────

export const ProcessInput = z.object({ termId: uuid, classId: uuid, allowIncomplete: z.boolean().default(false) });

export interface ProcessSummary {
  students: number;
  subjectResults: number;
  skippedPublished: number;
  incomplete: { studentId: string; student: string; subject: string; missing: string[] }[];
}

/**
 * Compute every subject result and report card for a class in a term, inside ONE transaction: either the whole
 * class is (re)processed or nothing changes. Published rows are never touched.
 */
export async function processResults(ctx: SecurityContext, raw: z.input<typeof ProcessInput>): Promise<ProcessSummary> {
  const i = ProcessInput.parse(raw);
  return transact(async (tx) => {
    const term = await tx.term.findUnique({ where: { id: i.termId }, include: { academicYear: true } });
    if (!term) throw notFound("Term");
    const cls = await tx.schoolClass.findUnique({ where: { id: i.classId } });
    if (!cls) throw notFound("Class");
    const { scheme, bands, components } = await loadScheme(tx);
    const policy = await getSetting("results.policy", tx);

    const enrollments = await tx.enrollment.findMany({ where: { classId: i.classId, academicYearId: term.academicYearId, status: "ACTIVE", student: { status: "ACTIVE", deletedAt: null } }, select: { studentId: true, sectionId: true, student: { select: { firstName: true, lastName: true } } } });
    const classSubjects = await tx.classSubject.findMany({ where: { classId: i.classId }, include: { subject: { select: { name: true, isCompulsory: true } } } });
    const assessments = await tx.assessment.findMany({ where: { termId: i.termId, classSubjectId: { in: classSubjects.map((c) => c.id) } }, include: { scores: true } });
    const existing = await tx.examResult.findMany({ where: { termId: i.termId, classSubjectId: { in: classSubjects.map((c) => c.id) } } });
    const existingCards = await tx.reportCard.findMany({ where: { termId: i.termId, classId: i.classId } });
    const publishedStudents = new Set([...existing.filter((r) => r.status === "PUBLISHED").map((r) => r.studentId), ...existingCards.filter((c) => c.status === "PUBLISHED").map((c) => c.studentId)]);

    const summary: ProcessSummary = { students: 0, subjectResults: 0, skippedPublished: publishedStudents.size, incomplete: [] };
    type Row = { studentId: string; classSubjectId: string; comp: ReturnType<typeof computeSubject>; grade: GradeBand | null; percentage: number };
    const rows: Row[] = [];

    for (const en of enrollments) {
      if (publishedStudents.has(en.studentId)) continue;
      for (const cs of classSubjects) {
        if (cs.sectionId && cs.sectionId !== en.sectionId) continue;
        const asmts = assessments.filter((a) => a.classSubjectId === cs.id);
        const scoreMap = new Map<string, ScoreEntry>();
        let any = false;
        for (const a of asmts) {
          const s = a.scores.find((x) => x.studentId === en.studentId);
          if (s) { scoreMap.set(a.typeId, { score: s.score === null ? null : Number(s.score), isAbsent: s.isAbsent }); any = true; }
        }
        if (!any) {
          if (cs.subject.isCompulsory) summary.incomplete.push({ studentId: en.studentId, student: `${en.student.lastName}, ${en.student.firstName}`, subject: cs.subject.name, missing: components.map((c) => c.code) });
          continue; // not offered / nothing entered
        }
        const comp = computeSubject(components, scoreMap);
        if (comp.missing.length) summary.incomplete.push({ studentId: en.studentId, student: `${en.student.lastName}, ${en.student.firstName}`, subject: cs.subject.name, missing: comp.missing });
        rows.push({ studentId: en.studentId, classSubjectId: cs.id, comp, grade: gradeFor(comp.percentage, bands), percentage: comp.percentage });
      }
    }
    if (summary.incomplete.length && !i.allowIncomplete) {
      throw new AppError("INCOMPLETE_SCORES", `${summary.incomplete.length} score sheet(s) are incomplete. Complete them or process with "allow incomplete".`, 409, { incomplete: summary.incomplete.slice(0, 50), total: summary.incomplete.length });
    }
    if (!rows.length) throw validation("There are no scores to process for this class and term");

    // Subject positions + class averages
    const bySubject = new Map<string, Row[]>();
    for (const r of rows) (bySubject.get(r.classSubjectId) ?? bySubject.set(r.classSubjectId, []).get(r.classSubjectId)!).push(r);
    const existingByKey = new Map(existing.map((r) => [`${r.studentId}:${r.classSubjectId}`, r]));
    for (const [csId, list] of bySubject) {
      const pos = rank(list.map((r) => ({ id: r.studentId, value: r.percentage })), scheme.positionMethod as never);
      const avg = average(list.map((r) => r.percentage));
      for (const r of list) {
        const data = {
          caTotal: r.comp.caTotal, examScore: r.comp.examScore, total: r.comp.total, percentage: r.percentage, grade: r.grade?.grade ?? "-", remark: r.grade?.remark ?? null,
          subjectPosition: policy.showPositions ? pos.get(r.studentId) ?? null : null, classAverage: avg, breakdown: r.comp.breakdown, status: "DRAFT" as const, publishedAt: null, publishedById: null,
        };
        const prev = existingByKey.get(`${r.studentId}:${csId}`);
        if (prev) await tx.examResult.update({ where: { id: prev.id }, data: { ...data, version: { increment: 1 } } });
        else await tx.examResult.create({ data: { studentId: r.studentId, termId: i.termId, classSubjectId: csId, ...data } });
        summary.subjectResults += 1;
      }
    }

    // Report cards
    const byStudent = new Map<string, Row[]>();
    for (const r of rows) (byStudent.get(r.studentId) ?? byStudent.set(r.studentId, []).get(r.studentId)!).push(r);
    const averages = [...byStudent.entries()].map(([studentId, list]) => ({ studentId, total: list.reduce((s, r) => s + Math.round(r.comp.total * 100), 0) / 100, avg: average(list.map((r) => r.percentage)), count: list.length }));
    const positions = rank(averages.map((a) => ({ id: a.studentId, value: a.avg })), scheme.positionMethod as never);
    const earlierTerms = await tx.term.findMany({ where: { academicYearId: term.academicYearId, sequence: { lt: term.sequence } }, select: { id: true } });
    const priorCards = await tx.reportCard.findMany({ where: { termId: { in: earlierTerms.map((t) => t.id) }, studentId: { in: averages.map((a) => a.studentId) } }, select: { studentId: true, average: true } });
    const cardByStudent = new Map(existingCards.map((c) => [c.studentId, c]));

    for (const a of averages) {
      const prior = priorCards.filter((p) => p.studentId === a.studentId).map((p) => Number(p.average));
      const cumulative = policy.cumulativeAcrossTerms ? average([...prior, a.avg]) : null;
      const attendance = await attendanceSummary(tx, a.studentId, term.startDate, term.endDate);
      const data = { classId: i.classId, totalScore: a.total, average: a.avg, position: policy.showPositions ? positions.get(a.studentId) ?? null : null, classSize: averages.length, subjectsCount: a.count, cumulativeAverage: cumulative, attendanceSummary: attendance, status: "DRAFT" as const, publishedAt: null, publishedById: null };
      const prev = cardByStudent.get(a.studentId);
      if (prev) await tx.reportCard.update({ where: { id: prev.id }, data: { ...data, version: { increment: 1 } } });
      else await tx.reportCard.create({ data: { studentId: a.studentId, termId: i.termId, ...data } });
      summary.students += 1;
    }
    await auditIn(tx, ctx, { action: "results.process", module: "results", entityType: "SchoolClass", entityId: i.classId, metadata: { termId: i.termId, ...summary, incomplete: summary.incomplete.length } });
    return summary;
  }, { timeoutMs: 60_000 });
}

async function attendanceSummary(tx: Tx, studentId: string, from: Date, to: Date) {
  const g = await tx.attendanceLog.groupBy({ by: ["status"], where: { studentId, date: { gte: from, lte: to }, session: "DAY" }, _count: true });
  const n = (s: string) => g.find((x) => x.status === s)?._count ?? 0;
  const present = n("PRESENT") + n("LATE");
  const total = present + n("ABSENT") + n("EXCUSED");
  return { present: n("PRESENT"), late: n("LATE"), absent: n("ABSENT"), excused: n("EXCUSED"), daysRecorded: total, rate: total ? round2((present / total) * 100) : null };
}

export async function setRemarks(ctx: SecurityContext, reportCardId: string, raw: { version: number; teacherRemark?: string | null; principalRemark?: string | null }) {
  const { version, ...patch } = z.object({ version: z.number().int(), teacherRemark: z.string().max(500).nullable().optional(), principalRemark: z.string().max(500).nullable().optional() }).parse(raw);
  return transact(async (tx) => {
    const c = await tx.reportCard.findUnique({ where: { id: reportCardId } });
    if (!c) throw notFound("Report card");
    if (c.status === "PUBLISHED") throw conflict("Withdraw the published result before editing remarks");
    const r = await tx.reportCard.updateMany({ where: { id: reportCardId, version }, data: { ...patch, version: { increment: 1 } } });
    assertUpdated(r.count, "Report card", c.version);
    await auditIn(tx, ctx, { action: "report_card.remarks", module: "results", entityType: "ReportCard", entityId: reportCardId, before: { t: c.teacherRemark, p: c.principalRemark }, after: patch });
  });
}

// ───────────── Publication ─────────────

export async function publishResults(ctx: SecurityContext, raw: { termId: string; classId: string }) {
  const i = z.object({ termId: uuid, classId: uuid }).parse(raw);
  return transact(async (tx) => {
    const cards = await tx.reportCard.findMany({ where: { termId: i.termId, classId: i.classId, status: { in: ["DRAFT", "WITHDRAWN"] } } });
    if (!cards.length) throw validation("Nothing to publish. Process results first.");
    const now = new Date();
    const studentIds = cards.map((c) => c.studentId);
    const results = await tx.examResult.updateMany({
      where: { termId: i.termId, studentId: { in: studentIds }, status: { in: ["DRAFT", "WITHDRAWN"] }, classSubject: { classId: i.classId } },
      data: { status: "PUBLISHED", publishedAt: now, publishedById: ctx.user.id },
    });
    await tx.reportCard.updateMany({ where: { id: { in: cards.map((c) => c.id) } }, data: { status: "PUBLISHED", publishedAt: now, publishedById: ctx.user.id, version: { increment: 1 } } });
    const published = await tx.reportCard.findMany({ where: { id: { in: cards.map((c) => c.id) } } });
    for (const c of published) {
      await enqueueSync(tx, "report_card", c);
      await publishEvent(tx, "result.published", { studentId: c.studentId, termId: i.termId, classId: i.classId, average: Number(c.average), position: c.position });
    }
    await auditIn(tx, ctx, { action: "results.publish", module: "results", entityType: "SchoolClass", entityId: i.classId, metadata: { termId: i.termId, reportCards: cards.length, subjectResults: results.count } });
    return { reportCards: cards.length, subjectResults: results.count };
  }, { timeoutMs: 60_000 });
}

export async function withdrawResults(ctx: SecurityContext, raw: { termId: string; classId: string; reason: string }) {
  const i = z.object({ termId: uuid, classId: uuid, reason: z.string().trim().min(3).max(300) }).parse(raw);
  return transact(async (tx) => {
    const cards = await tx.reportCard.findMany({ where: { termId: i.termId, classId: i.classId, status: "PUBLISHED" } });
    if (!cards.length) throw validation("There are no published results to withdraw");
    await tx.examResult.updateMany({ where: { termId: i.termId, studentId: { in: cards.map((c) => c.studentId) }, status: "PUBLISHED", classSubject: { classId: i.classId } }, data: { status: "WITHDRAWN" } });
    await tx.reportCard.updateMany({ where: { id: { in: cards.map((c) => c.id) } }, data: { status: "WITHDRAWN", version: { increment: 1 } } });
    for (const c of await tx.reportCard.findMany({ where: { id: { in: cards.map((c) => c.id) } } })) await enqueueSync(tx, "report_card", c);
    await auditIn(tx, ctx, { action: "results.withdraw", module: "results", entityType: "SchoolClass", entityId: i.classId, metadata: { termId: i.termId, reason: i.reason, reportCards: cards.length } });
    return { reportCards: cards.length };
  });
}

// ───────────── Reading results ─────────────

export async function getReportCard(ctx: SecurityContext, studentId: string, termId: string) {
  await assertCanAccessStudent(ctx, studentId, "results");
  await assertResultsAccessible(ctx, studentId); // financial lockout — enforced here, not just in the route
  const viewerIsFamily = ctx.user.userType === "PARENT" || ctx.user.userType === "STUDENT";
  const statusFilter = viewerIsFamily || !ctx.can("results.view") ? { status: "PUBLISHED" as const } : {};
  const [card, { bands }] = await Promise.all([
    db.reportCard.findFirst({ where: { studentId, termId, ...statusFilter }, include: { term: { include: { academicYear: true } }, student: { select: { firstName: true, middleName: true, lastName: true, admissionNumber: true, gender: true } } } }),
    loadScheme(),
  ]);
  if (!card) throw notFound("Report card");
  const cls = await db.schoolClass.findUnique({ where: { id: card.classId }, select: { name: true } });
  const subjects = await db.examResult.findMany({ where: { studentId, termId, ...statusFilter }, include: { classSubject: { include: { subject: { select: { name: true, code: true } } } } }, orderBy: { classSubject: { subject: { name: "asc" } } } });
  const branding = await getSetting("branding");
  const school = await db.schoolInstallation.findFirstOrThrow({ select: { schoolName: true, address: true, motto: true, logoFileId: true, phone: true, email: true } });
  return {
    school, branding, class: cls?.name ?? "", card: { ...card, average: Number(card.average), totalScore: Number(card.totalScore), cumulativeAverage: card.cumulativeAverage === null ? null : Number(card.cumulativeAverage) },
    subjects: subjects.map((s) => ({ subject: s.classSubject.subject.name, code: s.classSubject.subject.code, caTotal: Number(s.caTotal), exam: Number(s.examScore), total: Number(s.total), percentage: Number(s.percentage), grade: s.grade, remark: s.remark, position: s.subjectPosition, classAverage: s.classAverage === null ? null : Number(s.classAverage), breakdown: s.breakdown })),
    gradeKey: [...bands].sort((a, b) => b.minScore - a.minScore).map((b) => ({ grade: b.grade, range: `${b.minScore}–${b.maxScore}`, remark: b.remark })),
  };
}

export async function listClassResults(termId: string, classId: string) {
  return db.reportCard.findMany({ where: { termId, classId }, include: { student: { select: { firstName: true, lastName: true, admissionNumber: true } } }, orderBy: [{ position: "asc" }, { student: { lastName: "asc" } }] });
}

/** Terms a family viewer may open (published only). */
export async function listStudentTerms(ctx: SecurityContext, studentId: string) {
  await assertCanAccessStudent(ctx, studentId, "results");
  const family = ctx.user.userType === "PARENT" || ctx.user.userType === "STUDENT";
  return db.reportCard.findMany({ where: { studentId, ...(family ? { status: "PUBLISHED" as const } : {}) }, select: { termId: true, average: true, position: true, classSize: true, status: true, term: { select: { name: true, academicYear: { select: { name: true } } } } }, orderBy: { term: { startDate: "desc" } } });
}

// ───────────── Promotion ─────────────

export async function previewPromotions(ctx: SecurityContext, raw: { classId: string; academicYearId: string }) {
  const i = z.object({ classId: uuid, academicYearId: uuid }).parse(raw);
  const policy = await getSetting("results.policy");
  const cls = await db.schoolClass.findUnique({ where: { id: i.classId }, include: { nextClass: true } });
  if (!cls) throw notFound("Class");
  const enrollments = await db.enrollment.findMany({ where: { classId: i.classId, academicYearId: i.academicYearId, status: "ACTIVE", student: { deletedAt: null, status: "ACTIVE" } }, include: { student: { select: { id: true, firstName: true, lastName: true, admissionNumber: true } } } });
  const cards = await db.reportCard.findMany({ where: { studentId: { in: enrollments.map((e) => e.studentId) }, term: { academicYearId: i.academicYearId }, status: "PUBLISHED" }, select: { studentId: true, average: true } });
  return {
    class: cls.name, nextClass: cls.nextClass?.name ?? null, minimumAverage: policy.promotionMinimumAverage,
    students: enrollments.map((e) => {
      const avgs = cards.filter((c) => c.studentId === e.studentId).map((c) => Number(c.average));
      if (!avgs.length) return { studentId: e.studentId, name: `${e.student.firstName} ${e.student.lastName}`, admissionNumber: e.student.admissionNumber, average: null, decision: null, reason: "No published results this year" };
      const avg = average(avgs);
      const d = decidePromotion({ average: avg, minimumAverage: policy.promotionMinimumAverage, isTerminalClass: !cls.nextClassId });
      return { studentId: e.studentId, name: `${e.student.firstName} ${e.student.lastName}`, admissionNumber: e.student.admissionNumber, average: avg, decision: d.decision, reason: d.reason };
    }),
  };
}

export const ApplyPromotionInput = z.object({
  classId: uuid,
  academicYearId: uuid,
  /// The academic year students move into (must already exist).
  nextAcademicYearId: uuid,
  decisions: z.array(z.object({ studentId: uuid, decision: z.enum(["PROMOTED", "REPEATED", "GRADUATED", "WITHDRAWN"]), reason: z.string().max(200).optional() })).min(1).max(1000),
});

export async function applyPromotions(ctx: SecurityContext, raw: z.input<typeof ApplyPromotionInput>) {
  const i = ApplyPromotionInput.parse(raw);
  return transact(async (tx) => {
    const cls = await tx.schoolClass.findUnique({ where: { id: i.classId } });
    if (!cls) throw notFound("Class");
    if (i.nextAcademicYearId === i.academicYearId) throw validation("Choose the next academic year");
    const summary = { promoted: 0, repeated: 0, graduated: 0, withdrawn: 0 };
    for (const d of i.decisions) {
      const en = await tx.enrollment.findUnique({ where: { studentId_academicYearId: { studentId: d.studentId, academicYearId: i.academicYearId } } });
      if (!en || en.classId !== i.classId) throw validation("A student in the list is not enrolled in this class for that year");
      if (d.decision === "PROMOTED" && !cls.nextClassId) throw validation(`${cls.name} has no next class; use GRADUATED`);
      const toClassId = d.decision === "PROMOTED" ? cls.nextClassId : d.decision === "REPEATED" ? cls.id : null;
      await tx.promotionRecord.upsert({
        where: { studentId_academicYearId: { studentId: d.studentId, academicYearId: i.academicYearId } },
        create: { studentId: d.studentId, fromEnrollmentId: en.id, toClassId, academicYearId: i.academicYearId, decision: d.decision, basis: { reason: d.reason ?? null }, decidedById: ctx.user.id },
        update: { toClassId, decision: d.decision, basis: { reason: d.reason ?? null }, decidedById: ctx.user.id, decidedAt: new Date() },
      });
      await tx.enrollment.update({ where: { id: en.id }, data: { status: d.decision === "WITHDRAWN" ? "WITHDRAWN" : "COMPLETED", version: { increment: 1 } } });
      if (toClassId) {
        const row = await tx.enrollment.upsert({
          where: { studentId_academicYearId: { studentId: d.studentId, academicYearId: i.nextAcademicYearId } },
          create: { studentId: d.studentId, classId: toClassId, academicYearId: i.nextAcademicYearId },
          update: { classId: toClassId, status: "ACTIVE", version: { increment: 1 } },
        });
        await enqueueSync(tx, "enrollment", row);
      }
      if (d.decision === "GRADUATED" || d.decision === "WITHDRAWN") {
        const s = await tx.studentProfile.update({ where: { id: d.studentId }, data: { status: d.decision === "GRADUATED" ? "GRADUATED" : "WITHDRAWN", version: { increment: 1 } } });
        await tx.studentStatusHistory.create({ data: { studentId: d.studentId, toStatus: s.status, reason: `Year-end ${d.decision.toLowerCase()}`, changedById: ctx.user.id } });
        await enqueueSync(tx, "student", s);
      }
      summary[d.decision === "PROMOTED" ? "promoted" : d.decision === "REPEATED" ? "repeated" : d.decision === "GRADUATED" ? "graduated" : "withdrawn"] += 1;
    }
    await auditIn(tx, ctx, { action: "promotion.apply", module: "results", entityType: "SchoolClass", entityId: i.classId, metadata: { academicYearId: i.academicYearId, ...summary } });
    return summary;
  }, { timeoutMs: 60_000 });
}
