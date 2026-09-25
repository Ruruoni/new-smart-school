import { db } from "@/platform/db";
import { enabledModules } from "@/platform/features";
import type { SecurityContext } from "@/platform/security/context";

const num = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);

/**
 * The teacher's home: real workload, computed live from the same tables the score-entry grid and roll call write to.
 * Everything is scoped to the signed-in teacher's own class-subjects / form sections / lessons / exams.
 *  - scoreEntry: how much of this term's score sheet is filled (students × components), whether it is locked/published
 *  - classPerformance: the average of the processed results for the class-subject (once results have been processed)
 *  - today: today's lessons (active timetable) and whether roll call has been taken for the sections they are form teacher of
 *  - exams: CBT exams they created that are open, and how many students are sitting them right now
 */
export async function teacherOverview(ctx: SecurityContext) {
  const modules = new Set<string>(await enabledModules());
  const teacher = await db.teacherProfile.findUnique({ where: { userId: ctx.user.id }, select: { id: true } });
  const term = await db.term.findFirst({ where: { isCurrent: true }, select: { id: true, name: true } });
  if (!teacher) return { term, classSubjects: [], today: { lessons: [], rollCalls: [] }, exams: [] };

  const todayDate = new Date(new Date().toISOString().slice(0, 10));
  const dow = ((new Date().getDay() + 6) % 7) + 1;

  const [classSubjects, scheme, sections, lessons, exams] = await Promise.all([
    db.classSubject.findMany({ where: { teacherId: teacher.id }, include: { class: { select: { name: true, level: true } }, section: { select: { name: true } }, subject: { select: { name: true } } }, orderBy: [{ class: { level: "asc" } }, { subject: { name: "asc" } }] }),
    db.gradingScheme.findFirst({ where: { isDefault: true }, select: { components: { select: { id: true } } } }),
    modules.has("attendance") ? db.section.findMany({ where: { formTeacherId: teacher.id }, include: { class: { select: { name: true } } } }) : [],
    modules.has("timetable") ? db.timetableSlot.findMany({ where: { teacherId: teacher.id, dayOfWeek: dow, timetable: { status: "ACTIVE", term: { isCurrent: true } } }, include: { subject: { select: { name: true } }, class: { select: { name: true } }, room: { select: { name: true } } }, orderBy: { periodIndex: "asc" } }) : [],
    modules.has("cbt") ? db.cBTExam.findMany({ where: { createdById: ctx.user.id, status: "OPEN" }, select: { id: true, title: true, closesAt: true, _count: { select: { attempts: { where: { status: "IN_PROGRESS" } } } } }, orderBy: { createdAt: "desc" }, take: 5 }) : [],
  ]);
  const components = scheme?.components.length ?? 0;

  // A fixed number of queries however many class-subjects/sections the teacher has (no per-item round trips).
  const csIds = classSubjects.map((c) => c.id);
  const classIds = [...new Set(classSubjects.map((c) => c.classId))];
  const [rosters, assessments, averages, published] = await Promise.all([
    classIds.length ? db.enrollment.groupBy({ by: ["classId", "sectionId"], where: { classId: { in: classIds }, status: "ACTIVE", student: { status: "ACTIVE", deletedAt: null } }, _count: true }) : [],
    term && csIds.length ? db.assessment.findMany({ where: { classSubjectId: { in: csIds }, termId: term.id }, select: { classSubjectId: true, status: true, _count: { select: { scores: { where: { OR: [{ score: { not: null } }, { isAbsent: true }] } } } } } }) : [],
    term && csIds.length ? db.examResult.groupBy({ by: ["classSubjectId"], where: { classSubjectId: { in: csIds }, termId: term.id }, _avg: { percentage: true }, _count: true }) : [],
    term && csIds.length ? db.examResult.groupBy({ by: ["classSubjectId"], where: { classSubjectId: { in: csIds }, termId: term.id, status: "PUBLISHED" }, _count: true }) : [],
  ]);
  const perSubject = classSubjects.map((cs) => {
    // a subject taught to one section counts that section's students; otherwise the whole class
    const students = rosters.filter((r) => r.classId === cs.classId && (!cs.sectionId || r.sectionId === cs.sectionId)).reduce((n, r) => n + r._count, 0);
    const mine = assessments.filter((a) => a.classSubjectId === cs.id);
    const filled = mine.reduce((n, a) => n + a._count.scores, 0);
    const expected = students * components;
    const avg = averages.find((x) => x.classSubjectId === cs.id);
    return {
      id: cs.id, class: cs.class.name, section: cs.section?.name ?? null, subject: cs.subject.name, students,
      scoreEntry: { percent: expected ? Math.min(100, Math.round((filled / expected) * 100)) : null, locked: components > 0 && mine.length >= components && mine.every((a) => a.status === "LOCKED"), published: (published.find((x) => x.classSubjectId === cs.id)?._count ?? 0) > 0 },
      classPerformance: avg && avg._count > 0 ? { average: num(avg._avg.percentage), students: avg._count } : null,
    };
  });

  const sectionIds = sections.map((x) => x.id);
  const sectionStudents = sectionIds.length ? await db.enrollment.findMany({ where: { sectionId: { in: sectionIds }, status: "ACTIVE" }, select: { sectionId: true, studentId: true } }) : [];
  const marked = sectionStudents.length ? await db.attendanceLog.findMany({ where: { studentId: { in: sectionStudents.map((e) => e.studentId) }, date: todayDate, session: "DAY" }, select: { studentId: true } }) : [];
  const markedIds = new Set(marked.map((m) => m.studentId));
  const rollCalls = sections.map((sec) => {
    const ids = sectionStudents.filter((e) => e.sectionId === sec.id).map((e) => e.studentId);
    const n = ids.filter((id) => markedIds.has(id)).length;
    return { sectionId: sec.id, classId: sec.classId, name: `${sec.class.name} ${sec.name}`, students: ids.length, marked: n, taken: n > 0 };
  });

  return {
    term,
    classSubjects: perSubject,
    today: { lessons: lessons.map((l) => ({ id: l.id, period: l.periodIndex, start: l.startTime, end: l.endTime, subject: l.subject.name, class: l.class.name, room: l.room?.name ?? null })), rollCalls },
    exams: exams.map((e) => ({ id: e.id, title: e.title, closesAt: e.closesAt, sitting: e._count.attempts })),
  };
}
