import { z } from "zod";
import { db, transact } from "@/platform/db";
import type { SecurityContext } from "@/platform/security/context";
import { auditIn } from "@/platform/security/interceptor";
import { enqueueSync } from "@/platform/sync/outbox";
import { conflict, notFound, validation } from "@/platform/errors";
import { assertUpdated, isoDate, toDate, uuid } from "@/platform/util";

// ───────────── Academic years & terms ─────────────

export const YearInput = z.object({ name: z.string().trim().min(4).max(20), startDate: isoDate, endDate: isoDate });
export const TermInput = z.object({ academicYearId: uuid, name: z.string().trim().min(2).max(40), sequence: z.number().int().min(1).max(4), startDate: isoDate, endDate: isoDate });

export async function createAcademicYear(ctx: SecurityContext, raw: z.infer<typeof YearInput>) {
  const i = YearInput.parse(raw);
  if (toDate(i.startDate) >= toDate(i.endDate)) throw validation("End date must be after start date");
  return transact(async (tx) => {
    if (await tx.academicYear.findUnique({ where: { name: i.name } })) throw conflict("That academic year already exists");
    const y = await tx.academicYear.create({ data: { name: i.name, startDate: toDate(i.startDate), endDate: toDate(i.endDate) } });
    await enqueueSync(tx, "academic_year", y);
    await auditIn(tx, ctx, { action: "academic_year.create", module: "academics", entityType: "AcademicYear", entityId: y.id, after: y });
    return y;
  });
}

export async function createTerm(ctx: SecurityContext, raw: z.infer<typeof TermInput>) {
  const i = TermInput.parse(raw);
  if (toDate(i.startDate) >= toDate(i.endDate)) throw validation("End date must be after start date");
  return transact(async (tx) => {
    const year = await tx.academicYear.findUnique({ where: { id: i.academicYearId } });
    if (!year) throw notFound("Academic year");
    const s = toDate(i.startDate), e = toDate(i.endDate);
    if (s < year.startDate || e > year.endDate) throw validation("Term dates must fall inside the academic year");
    const overlap = await tx.term.findFirst({ where: { academicYearId: year.id, startDate: { lte: e }, endDate: { gte: s } } });
    if (overlap) throw conflict(`Dates overlap with ${overlap.name}`);
    if (await tx.term.findFirst({ where: { academicYearId: year.id, sequence: i.sequence } })) throw conflict("A term with that sequence already exists this year");
    const t = await tx.term.create({ data: { academicYearId: year.id, name: i.name, sequence: i.sequence, startDate: s, endDate: e } });
    await enqueueSync(tx, "term", t);
    await auditIn(tx, ctx, { action: "term.create", module: "academics", entityType: "Term", entityId: t.id, after: t });
    return t;
  });
}

/** Make a term current (and its year). One current term/year is enforced by partial unique indexes as well. */
export async function setCurrentTerm(ctx: SecurityContext, termId: string) {
  return transact(async (tx) => {
    const term = await tx.term.findUnique({ where: { id: termId } });
    if (!term) throw notFound("Term");
    await tx.term.updateMany({ where: { isCurrent: true }, data: { isCurrent: false, version: { increment: 1 } } });
    await tx.academicYear.updateMany({ where: { isCurrent: true, NOT: { id: term.academicYearId } }, data: { isCurrent: false, version: { increment: 1 } } });
    await tx.academicYear.update({ where: { id: term.academicYearId }, data: { isCurrent: true, version: { increment: 1 } } });
    const t = await tx.term.update({ where: { id: termId }, data: { isCurrent: true, version: { increment: 1 } }, include: { academicYear: true } });
    await enqueueSync(tx, "term", t);
    await enqueueSync(tx, "academic_year", t.academicYear);
    await auditIn(tx, ctx, { action: "term.set_current", module: "academics", entityType: "Term", entityId: termId, after: { name: t.name, year: t.academicYear.name } });
    return t;
  });
}

export const currentTerm = () => db.term.findFirst({ where: { isCurrent: true }, include: { academicYear: true } });

export async function listYears() {
  return db.academicYear.findMany({ orderBy: { startDate: "desc" }, include: { terms: { orderBy: { sequence: "asc" } } } });
}

// ───────────── Classes / sections ─────────────

export const ClassInput = z.object({
  name: z.string().trim().min(2).max(30),
  level: z.number().int().min(1).max(30),
  stage: z.enum(["NURSERY", "PRIMARY", "JUNIOR_SECONDARY", "SENIOR_SECONDARY"]),
  nextClassId: uuid.nullable().optional(),
});

export async function createClass(ctx: SecurityContext, raw: z.infer<typeof ClassInput>) {
  const i = ClassInput.parse(raw);
  return transact(async (tx) => {
    if (await tx.schoolClass.findUnique({ where: { name: i.name } })) throw conflict("A class with that name exists");
    const c = await tx.schoolClass.create({ data: { name: i.name, level: i.level, stage: i.stage, nextClassId: i.nextClassId ?? null } });
    await enqueueSync(tx, "school_class", c);
    await auditIn(tx, ctx, { action: "class.create", module: "academics", entityType: "SchoolClass", entityId: c.id, after: c });
    return c;
  });
}

export async function updateClass(ctx: SecurityContext, id: string, raw: Partial<z.infer<typeof ClassInput>> & { version: number }) {
  const { version, ...rest } = raw;
  const patch = ClassInput.partial().parse(rest);
  return transact(async (tx) => {
    const before = await tx.schoolClass.findUnique({ where: { id } });
    if (!before) throw notFound("Class");
    if (patch.nextClassId === id) throw validation("A class cannot be its own next class");
    const r = await tx.schoolClass.updateMany({ where: { id, version }, data: { ...patch, version: { increment: 1 } } });
    assertUpdated(r.count, "Class", before.version);
    const after = await tx.schoolClass.findUniqueOrThrow({ where: { id } });
    await enqueueSync(tx, "school_class", after);
    await auditIn(tx, ctx, { action: "class.update", module: "academics", entityType: "SchoolClass", entityId: id, before, after });
    return after;
  });
}

export async function createSection(ctx: SecurityContext, raw: { classId: string; name: string; capacity?: number; formTeacherId?: string | null }) {
  const i = z.object({ classId: uuid, name: z.string().trim().min(1).max(20), capacity: z.number().int().min(1).max(200).optional(), formTeacherId: uuid.nullable().optional() }).parse(raw);
  return transact(async (tx) => {
    if (await tx.section.findUnique({ where: { classId_name: { classId: i.classId, name: i.name } } })) throw conflict("That section already exists for this class");
    const s = await tx.section.create({ data: { classId: i.classId, name: i.name, capacity: i.capacity, formTeacherId: i.formTeacherId ?? null } });
    await auditIn(tx, ctx, { action: "section.create", module: "academics", entityType: "Section", entityId: s.id, after: s });
    return s;
  });
}

export async function listClasses() {
  return db.schoolClass.findMany({ orderBy: { level: "asc" }, include: { sections: { orderBy: { name: "asc" } }, _count: { select: { enrollments: true } } } });
}

// ───────────── Subjects, curriculum, class-subjects ─────────────

export const SubjectInput = z.object({ code: z.string().trim().toUpperCase().min(2).max(12), name: z.string().trim().min(2).max(60), category: z.string().trim().max(40).optional(), isCompulsory: z.boolean().default(false) });

export async function createSubject(ctx: SecurityContext, raw: z.input<typeof SubjectInput>) {
  const i = SubjectInput.parse(raw);
  return transact(async (tx) => {
    if (await tx.subject.findUnique({ where: { code: i.code } })) throw conflict("A subject with that code exists");
    const s = await tx.subject.create({ data: i });
    await enqueueSync(tx, "subject", s);
    await auditIn(tx, ctx, { action: "subject.create", module: "academics", entityType: "Subject", entityId: s.id, after: s });
    return s;
  });
}

export async function setCurriculum(ctx: SecurityContext, raw: { subjectId: string; classLevel: number; title: string; description?: string; topics: string[] }) {
  const i = z.object({ subjectId: uuid, classLevel: z.number().int().min(1).max(30), title: z.string().trim().min(2).max(120), description: z.string().max(2000).optional(), topics: z.array(z.string().trim().min(1).max(200)).max(200) }).parse(raw);
  return transact(async (tx) => {
    const c = await tx.curriculum.upsert({
      where: { subjectId_classLevel: { subjectId: i.subjectId, classLevel: i.classLevel } },
      create: { subjectId: i.subjectId, classLevel: i.classLevel, title: i.title, description: i.description, topics: i.topics },
      update: { title: i.title, description: i.description, topics: i.topics, version: { increment: 1 } },
    });
    await auditIn(tx, ctx, { action: "curriculum.set", module: "academics", entityType: "Curriculum", entityId: c.id, after: { title: c.title, topics: i.topics.length } });
    return c;
  });
}

/** Assign a subject (and teacher) to a class/section. Whole-class assignment uses sectionId = null. */
export async function assignClassSubject(ctx: SecurityContext, raw: { classId: string; sectionId?: string | null; subjectId: string; teacherId?: string | null }) {
  const i = z.object({ classId: uuid, sectionId: uuid.nullable().optional(), subjectId: uuid, teacherId: uuid.nullable().optional() }).parse(raw);
  return transact(async (tx) => {
    if (i.sectionId) {
      const sec = await tx.section.findUnique({ where: { id: i.sectionId } });
      if (!sec || sec.classId !== i.classId) throw validation("Section does not belong to that class");
    }
    // The unique index treats NULL sections as distinct, so whole-class duplicates are checked explicitly.
    const existing = await tx.classSubject.findFirst({ where: { classId: i.classId, sectionId: i.sectionId ?? null, subjectId: i.subjectId } });
    const row = existing
      ? await tx.classSubject.update({ where: { id: existing.id }, data: { teacherId: i.teacherId ?? null } })
      : await tx.classSubject.create({ data: { classId: i.classId, sectionId: i.sectionId ?? null, subjectId: i.subjectId, teacherId: i.teacherId ?? null } });
    await auditIn(tx, ctx, { action: "class_subject.assign", module: "academics", entityType: "ClassSubject", entityId: row.id, before: existing ?? undefined, after: row });
    return row;
  });
}

export async function listClassSubjects(classId: string) {
  return db.classSubject.findMany({
    where: { classId },
    include: { subject: { select: { code: true, name: true } }, section: { select: { name: true } }, teacher: { select: { id: true, user: { select: { firstName: true, lastName: true } } } } },
    orderBy: { subject: { name: "asc" } },
  });
}
