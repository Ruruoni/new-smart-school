import { z } from "zod";
import { db, transact, type Tx } from "@/platform/db";
import type { SecurityContext } from "@/platform/security/context";
import { auditIn } from "@/platform/security/interceptor";
import { AppError, conflict, notFound, validation } from "@/platform/errors";
import { uuid } from "@/platform/util";
import { assertCanAccessStudent } from "@/platform/security/scope";
import { findConflicts, solveTimetable, type Lesson, type Occupied } from "./solver";

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");

export async function createTimetable(ctx: SecurityContext, raw: { termId: string; name: string }) {
  const i = z.object({ termId: uuid, name: z.string().trim().min(2).max(60) }).parse(raw);
  return transact(async (tx) => {
    if (!(await tx.term.findUnique({ where: { id: i.termId } }))) throw notFound("Term");
    if (await tx.timetable.findUnique({ where: { termId_name: i } })) throw conflict("A timetable with that name already exists for this term");
    const t = await tx.timetable.create({ data: i });
    await auditIn(tx, ctx, { action: "timetable.create", module: "timetable", entityType: "Timetable", entityId: t.id, after: t });
    return t;
  });
}

/** Activating one timetable archives the previously active one for the same term. */
export async function activateTimetable(ctx: SecurityContext, id: string) {
  return transact(async (tx) => {
    const t = await tx.timetable.findUnique({ where: { id } });
    if (!t) throw notFound("Timetable");
    await tx.timetable.updateMany({ where: { termId: t.termId, status: "ACTIVE", NOT: { id } }, data: { status: "ARCHIVED" } });
    const a = await tx.timetable.update({ where: { id }, data: { status: "ACTIVE" } });
    await auditIn(tx, ctx, { action: "timetable.activate", module: "timetable", entityType: "Timetable", entityId: id });
    return a;
  });
}

export const SlotInput = z.object({
  timetableId: uuid, dayOfWeek: z.number().int().min(1).max(7), periodIndex: z.number().int().min(0).max(15),
  startTime: time, endTime: time, classId: uuid, sectionId: uuid.nullable().optional(), subjectId: uuid, teacherId: uuid,
  roomId: uuid.nullable().optional(), resourceId: uuid.nullable().optional(), allowUnassignedTeacher: z.boolean().default(false),
});

const occ = (s: { dayOfWeek: number; periodIndex: number; classId: string; sectionKey: string; teacherId: string; roomId: string | null; resourceId: string | null }): Occupied => s;

async function slotsOf(tx: Tx, timetableId: string, ignoreId?: string) {
  return (await tx.timetableSlot.findMany({ where: { timetableId, ...(ignoreId ? { NOT: { id: ignoreId } } : {}) } })).map(occ);
}

/** Dry-run validation used by the UI to show conflicts before saving. */
export async function validateSlot(raw: z.input<typeof SlotInput>, ignoreSlotId?: string) {
  const i = SlotInput.parse(raw);
  const conflicts = findConflicts({ dayOfWeek: i.dayOfWeek, periodIndex: i.periodIndex, classId: i.classId, sectionKey: i.sectionId ?? "*", teacherId: i.teacherId, roomId: i.roomId ?? null, resourceId: i.resourceId ?? null }, await slotsOf(db as never, i.timetableId, ignoreSlotId));
  if (!i.allowUnassignedTeacher) {
    const assigned = await db.classSubject.count({ where: { classId: i.classId, subjectId: i.subjectId, teacherId: i.teacherId } });
    if (!assigned) conflicts.push({ kind: "CLASS", message: "That teacher is not assigned to this subject for this class" });
  }
  return conflicts;
}

function friendlyUnique(err: unknown): never {
  const e = err as { code?: string; meta?: { driverAdapterError?: { cause?: { constraint?: unknown } } } };
  if (e?.code === "P2002" || String(err).includes("Unique constraint")) throw conflict("That period is already taken (teacher, room, resource or class double-booked)");
  throw err;
}

export async function addSlot(ctx: SecurityContext, raw: z.input<typeof SlotInput>) {
  const i = SlotInput.parse(raw);
  const conflicts = await validateSlot(i);
  if (conflicts.length) throw new AppError("TIMETABLE_CONFLICT", conflicts[0]!.message, 409, { conflicts });
  return transact(async (tx) => {
    try {
      const { allowUnassignedTeacher: _a, sectionId, ...rest } = i;
      const s = await tx.timetableSlot.create({ data: { ...rest, sectionId: sectionId ?? null, sectionKey: sectionId ?? "*" } });
      await auditIn(tx, ctx, { action: "timetable.slot_add", module: "timetable", entityType: "TimetableSlot", entityId: s.id, after: { day: s.dayOfWeek, period: s.periodIndex, classId: s.classId, teacherId: s.teacherId } });
      return s;
    } catch (err) {
      friendlyUnique(err);
    }
  });
}

export async function moveSlot(ctx: SecurityContext, slotId: string, to: { dayOfWeek: number; periodIndex: number; startTime: string; endTime: string }) {
  return transact(async (tx) => {
    const s = await tx.timetableSlot.findUnique({ where: { id: slotId } });
    if (!s) throw notFound("Slot");
    const moved = { ...to, timetableId: s.timetableId, classId: s.classId, sectionKey: s.sectionKey, teacherId: s.teacherId, roomId: s.roomId, resourceId: s.resourceId };
    const conflicts = findConflicts(occ(moved), await slotsOf(tx, s.timetableId, slotId));
    if (conflicts.length) throw new AppError("TIMETABLE_CONFLICT", conflicts[0]!.message, 409, { conflicts });
    try {
      const u = await tx.timetableSlot.update({ where: { id: slotId }, data: to });
      await auditIn(tx, ctx, { action: "timetable.slot_move", module: "timetable", entityType: "TimetableSlot", entityId: slotId, before: { day: s.dayOfWeek, period: s.periodIndex }, after: { day: to.dayOfWeek, period: to.periodIndex } });
      return u;
    } catch (err) {
      friendlyUnique(err);
    }
  });
}

export async function removeSlot(ctx: SecurityContext, slotId: string) {
  return transact(async (tx) => {
    const s = await tx.timetableSlot.findUnique({ where: { id: slotId } });
    if (!s) throw notFound("Slot");
    await tx.timetableSlot.delete({ where: { id: slotId } });
    await auditIn(tx, ctx, { action: "timetable.slot_remove", module: "timetable", entityType: "TimetableSlot", entityId: slotId });
  });
}

export const GenerateInput = z.object({
  timetableId: uuid,
  days: z.array(z.number().int().min(1).max(7)).min(1).default([1, 2, 3, 4, 5]),
  periods: z.array(z.object({ start: time, end: time })).min(1).max(12),
  /// Default weekly periods for a class-subject without an explicit override.
  defaultPeriodsPerWeek: z.number().int().min(1).max(10).default(3),
  overrides: z.array(z.object({ classSubjectId: uuid, periodsPerWeek: z.number().int().min(1).max(10) })).default([]),
  /// Teacher unavailability: (teacherId, day, periodIndex) triples that must stay free.
  unavailable: z.array(z.object({ teacherId: uuid, dayOfWeek: z.number().int().min(1).max(7), periodIndex: z.number().int().min(0) })).default([]),
  classIds: z.array(uuid).optional(),
  replaceExisting: z.boolean().default(false),
  seed: z.number().int().optional(),
});

/** Auto-generate a conflict-free draft from the class-subject assignments; persists everything placed, reports the rest. */
export async function generateTimetable(ctx: SecurityContext, raw: z.input<typeof GenerateInput>) {
  const i = GenerateInput.parse(raw);
  return transact(async (tx) => {
    const t = await tx.timetable.findUnique({ where: { id: i.timetableId } });
    if (!t) throw notFound("Timetable");
    if (i.replaceExisting) await tx.timetableSlot.deleteMany({ where: { timetableId: i.timetableId } });
    const css = await tx.classSubject.findMany({ where: { teacherId: { not: null }, ...(i.classIds ? { classId: { in: i.classIds } } : {}) }, include: { subject: { select: { name: true } }, class: { select: { name: true } } } });
    if (!css.length) throw validation("No class subjects have teachers assigned yet");
    const overrides = new Map(i.overrides.map((o) => [o.classSubjectId, o.periodsPerWeek]));
    const lessons: Lesson[] = css.map((c) => ({ id: c.id, classId: c.classId, sectionKey: c.sectionId ?? "*", subjectId: c.subjectId, teacherId: c.teacherId!, periodsPerWeek: overrides.get(c.id) ?? i.defaultPeriodsPerWeek }));
    const fixed: Occupied[] = [
      ...(await slotsOf(tx, i.timetableId)),
      ...i.unavailable.map((u) => ({ dayOfWeek: u.dayOfWeek, periodIndex: u.periodIndex, classId: "__unavailable__", sectionKey: `__${u.teacherId}`, teacherId: u.teacherId })),
    ];
    const result = solveTimetable({ days: i.days, periodsPerDay: i.periods.length, lessons, fixed, seed: i.seed });
    const byId = new Map(css.map((c) => [c.id, c]));
    if (result.placements.length) {
      await tx.timetableSlot.createMany({
        data: result.placements.map((p) => {
          const c = byId.get(p.lessonId)!;
          const per = i.periods[p.periodIndex]!;
          return { timetableId: i.timetableId, dayOfWeek: p.dayOfWeek, periodIndex: p.periodIndex, startTime: per.start, endTime: per.end, classId: c.classId, sectionId: c.sectionId, sectionKey: c.sectionId ?? "*", subjectId: c.subjectId, teacherId: c.teacherId! };
        }),
      });
    }
    await auditIn(tx, ctx, { action: "timetable.generate", module: "timetable", entityType: "Timetable", entityId: i.timetableId, metadata: { placed: result.placements.length, unplaced: result.unplaced.length } });
    return { placed: result.placements.length, unplaced: result.unplaced.map((u) => ({ ...u, class: byId.get(u.lessonId)?.class.name, subject: byId.get(u.lessonId)?.subject.name })) };
  });
}

export async function timetableView(timetableId: string, by: { classId?: string; teacherId?: string; roomId?: string }) {
  return db.timetableSlot.findMany({
    where: { timetableId, ...(by.classId ? { classId: by.classId } : {}), ...(by.teacherId ? { teacherId: by.teacherId } : {}), ...(by.roomId ? { roomId: by.roomId } : {}) },
    include: { subject: { select: { name: true, code: true } }, class: { select: { name: true } }, section: { select: { name: true } }, teacher: { select: { user: { select: { firstName: true, lastName: true } } } }, room: { select: { name: true } } },
    orderBy: [{ dayOfWeek: "asc" }, { periodIndex: "asc" }],
  });
}

export async function createRoom(ctx: SecurityContext, raw: { name: string; kind?: "CLASSROOM" | "LABORATORY" | "HALL" | "LIBRARY" | "ICT_LAB" | "OTHER"; capacity?: number }) {
  const i = z.object({ name: z.string().trim().min(1).max(60), kind: z.enum(["CLASSROOM", "LABORATORY", "HALL", "LIBRARY", "ICT_LAB", "OTHER"]).default("CLASSROOM"), capacity: z.number().int().min(1).max(2000).optional() }).parse(raw);
  return transact(async (tx) => {
    if (await tx.room.findUnique({ where: { name: i.name } })) throw conflict("A room with that name exists");
    const r = await tx.room.create({ data: i });
    await auditIn(tx, ctx, { action: "room.create", module: "timetable", entityType: "Room", entityId: r.id, after: r });
    return r;
  });
}

export interface MyTimetable {
  kind: "student" | "teacher";
  title: string;
  timetable: { id: string; name: string; term: string } | null;
  days: { day: number; slots: { id: string; period: number; start: string; end: string; subject: string; teacher: string | null; class: string | null; room: string | null }[] }[];
}

/**
 * "My timetable" for people who hold no timetable permission: a student sees their own class (and section), a parent sees a
 * linked child's (the same guardian-link check as every other parent-portal read), a teacher sees their own lessons.
 * Only the ACTIVE timetable of the current term is used; nothing else about the timetable module is exposed.
 */
export async function myTimetable(ctx: SecurityContext, studentId?: string): Promise<MyTimetable> {
  const t = await db.timetable.findFirst({ where: { status: "ACTIVE", term: { isCurrent: true } }, include: { term: { select: { name: true } } } });
  const meta = t ? { id: t.id, name: t.name, term: t.term.name } : null;
  const group = (rows: { id: string; dayOfWeek: number; periodIndex: number; startTime: string; endTime: string; subject: { name: string }; teacher: { user: { firstName: string; lastName: string } } | null; class: { name: string } | null; room: { name: string } | null }[], forTeacher: boolean): MyTimetable["days"] => {
    const days = new Map<number, MyTimetable["days"][number]["slots"]>();
    for (const r of rows) {
      const list = days.get(r.dayOfWeek) ?? [];
      list.push({ id: r.id, period: r.periodIndex, start: r.startTime, end: r.endTime, subject: r.subject.name, teacher: forTeacher ? null : r.teacher ? `${r.teacher.user.firstName} ${r.teacher.user.lastName}` : null, class: forTeacher ? r.class?.name ?? null : null, room: r.room?.name ?? null });
      days.set(r.dayOfWeek, list);
    }
    return [...days.entries()].sort((a, b) => a[0] - b[0]).map(([day, slots]) => ({ day, slots: slots.sort((a, b) => a.period - b.period) }));
  };
  const include = { subject: { select: { name: true } }, teacher: { select: { user: { select: { firstName: true, lastName: true } } } }, class: { select: { name: true } }, room: { select: { name: true } } } as const;
  const orderBy = [{ dayOfWeek: "asc" as const }, { periodIndex: "asc" as const }];

  if (ctx.user.userType === "TEACHER") {
    const me = await db.teacherProfile.findUnique({ where: { userId: ctx.user.id }, select: { id: true } });
    const rows = t && me ? await db.timetableSlot.findMany({ where: { timetableId: t.id, teacherId: me.id }, include, orderBy }) : [];
    return { kind: "teacher", title: "My lessons", timetable: meta, days: group(rows, true) };
  }

  let sid: string | undefined = studentId;
  if (ctx.user.userType === "STUDENT") sid = (await db.studentProfile.findUnique({ where: { userId: ctx.user.id }, select: { id: true } }))?.id;
  else if (ctx.user.userType === "PARENT") { if (!sid) throw validation("Choose a child"); await assertCanAccessStudent(ctx, sid); }
  else throw notFound("Timetable"); // staff use the full timetable screen, which has its own permission
  if (!sid) throw notFound("Student");
  const en = await db.enrollment.findFirst({ where: { studentId: sid, status: "ACTIVE" }, select: { classId: true, sectionId: true, class: { select: { name: true } }, student: { select: { firstName: true } } }, orderBy: { enrolledOn: "desc" } });
  if (!en) return { kind: "student", title: "Timetable", timetable: meta, days: [] };
  const rows = t ? await db.timetableSlot.findMany({ where: { timetableId: t.id, classId: en.classId, OR: [{ sectionKey: "*" }, ...(en.sectionId ? [{ sectionId: en.sectionId }] : [])] }, include, orderBy }) : [];
  return { kind: "student", title: `${en.class.name} timetable`, timetable: meta, days: group(rows, false) };
}
