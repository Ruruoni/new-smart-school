import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/platform/db";
import * as tt from "@/modules/timetable/service";
import * as people from "@/modules/people/service";
import * as academics from "@/modules/academics/service";
import { findConflicts, solveTimetable, type Lesson } from "@/modules/timetable/solver";
import { ctxFor, seedAcademics } from "./fixtures";
import { makeUser, resetDb } from "./helpers";
import { hashPassword } from "@/platform/password";

describe("solver (pure)", () => {
  const lesson = (id: string, classId: string, teacherId: string, n: number, subjectId = id): Lesson => ({ id, classId, sectionKey: "*", subjectId, teacherId, periodsPerWeek: n });

  function assertNoDoubleBooking(placements: { lessonId: string; dayOfWeek: number; periodIndex: number }[], lessons: Lesson[]) {
    const seen = new Map<string, string>();
    for (const p of placements) {
      const l = lessons.find((x) => x.id === p.lessonId)!;
      for (const key of [`T|${l.teacherId}|${p.dayOfWeek}|${p.periodIndex}`, `C|${l.classId}|${p.dayOfWeek}|${p.periodIndex}`]) {
        expect(seen.has(key), `double booking ${key}`).toBe(false);
        seen.set(key, p.lessonId);
      }
    }
  }

  it("places a feasible school with zero conflicts", () => {
    const lessons: Lesson[] = [];
    for (const c of ["c1", "c2", "c3"]) for (const [i, t] of ["t1", "t2", "t3", "t4"].entries()) lessons.push(lesson(`${c}-${i}`, c, t, 4));
    const r = solveTimetable({ days: [1, 2, 3, 4, 5], periodsPerDay: 6, lessons });
    expect(r.unplaced).toEqual([]);
    expect(r.placements).toHaveLength(48);
    assertNoDoubleBooking(r.placements, lessons);
  });
  it("is deterministic for the same seed", () => {
    const lessons = [lesson("a", "c1", "t1", 5), lesson("b", "c2", "t1", 5), lesson("c", "c1", "t2", 5)];
    const a = solveTimetable({ days: [1, 2, 3, 4, 5], periodsPerDay: 4, lessons, seed: 7 });
    const b = solveTimetable({ days: [1, 2, 3, 4, 5], periodsPerDay: 4, lessons, seed: 7 });
    expect(a).toEqual(b);
  });
  it("reports what cannot be placed instead of double-booking", () => {
    // one teacher, two classes, a 5-slot week: 8 lessons cannot fit
    const lessons = [lesson("a", "c1", "t1", 4), lesson("b", "c2", "t1", 4)];
    const r = solveTimetable({ days: [1, 2, 3, 4, 5], periodsPerDay: 1, lessons });
    expect(r.placements).toHaveLength(5);
    expect(r.unplaced.reduce((s, u) => s + u.missing, 0)).toBe(3);
    assertNoDoubleBooking(r.placements, lessons);
  });
  it("spreads a subject across days (max 2 per day)", () => {
    const r = solveTimetable({ days: [1, 2, 3, 4, 5], periodsPerDay: 8, lessons: [lesson("m", "c1", "t1", 5, "maths")] });
    const perDay = new Map<number, number>();
    for (const p of r.placements) perDay.set(p.dayOfWeek, (perDay.get(p.dayOfWeek) ?? 0) + 1);
    expect(Math.max(...perDay.values())).toBeLessThanOrEqual(2);
  });
  it("honours unavailable teacher periods", () => {
    const fixed = [1, 2, 3, 4, 5].map((d) => ({ dayOfWeek: d, periodIndex: 0, classId: "x", sectionKey: "x", teacherId: "t1" }));
    const r = solveTimetable({ days: [1, 2, 3, 4, 5], periodsPerDay: 3, lessons: [lesson("a", "c1", "t1", 10)], fixed });
    expect(r.placements.every((p) => p.periodIndex !== 0)).toBe(true);
  });
  it("randomised property: no schedule ever double-books a teacher or class", () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let round = 0; round < 25; round++) {
      const lessons: Lesson[] = Array.from({ length: 6 + Math.floor(rnd() * 20) }, (_, i) => lesson(`l${i}`, `c${Math.floor(rnd() * 4)}`, `t${Math.floor(rnd() * 5)}`, 1 + Math.floor(rnd() * 5), `s${i}`));
      const r = solveTimetable({ days: [1, 2, 3, 4, 5], periodsPerDay: 5, lessons, seed: round, attempts: 5 });
      assertNoDoubleBooking(r.placements, lessons);
    }
  });
  it("whole-class lessons collide with any section; different sections do not", () => {
    const base = { dayOfWeek: 1, periodIndex: 0, classId: "c", teacherId: "t1" };
    expect(findConflicts({ ...base, sectionKey: "*", teacherId: "t2" }, [{ ...base, sectionKey: "A" }]).map((c) => c.kind)).toEqual(["CLASS"]);
    expect(findConflicts({ ...base, sectionKey: "B", teacherId: "t2" }, [{ ...base, sectionKey: "A" }])).toEqual([]);
  });
});

describe("timetable service", () => {
  let S: Awaited<ReturnType<typeof seedAcademics>>;
  let tea: string, tea2: string, room: string, table: string;
  beforeEach(async () => {
    await resetDb();
    S = await seedAcademics();
    tea = (await people.createTeacher(S.admin, { firstName: "Mr", lastName: "One" })).teacher.id;
    tea2 = (await people.createTeacher(S.admin, { firstName: "Mrs", lastName: "Two" })).teacher.id;
    await academics.assignClassSubject(S.admin, { classId: S.jss1.id, subjectId: S.math.id, teacherId: tea });
    await academics.assignClassSubject(S.admin, { classId: S.jss2.id, subjectId: S.math.id, teacherId: tea });
    await academics.assignClassSubject(S.admin, { classId: S.jss1.id, subjectId: S.eng.id, teacherId: tea2 });
    room = (await tt.createRoom(S.admin, { name: "Lab 1", kind: "LABORATORY" })).id;
    table = (await tt.createTimetable(S.admin, { termId: S.t1.id, name: "Master" })).id;
  });
  const slot = (o: object) => ({ timetableId: table, dayOfWeek: 1, periodIndex: 0, startTime: "08:00", endTime: "08:40", classId: S.jss1.id, subjectId: S.math.id, teacherId: tea, ...o });

  it("blocks teacher, room and class double-booking with clear messages", async () => {
    await tt.addSlot(S.admin, slot({ roomId: room }));
    await expect(tt.addSlot(S.admin, slot({ classId: S.jss2.id }))).rejects.toMatchObject({ code: "TIMETABLE_CONFLICT", message: expect.stringMatching(/Teacher is already/) });
    await expect(tt.addSlot(S.admin, slot({ subjectId: S.eng.id, teacherId: tea2, roomId: room, classId: S.jss2.id, allowUnassignedTeacher: true }))).rejects.toMatchObject({ message: expect.stringMatching(/Room is already/) });
    await expect(tt.addSlot(S.admin, slot({ subjectId: S.eng.id, teacherId: tea2 }))).rejects.toMatchObject({ message: expect.stringMatching(/class already has/) });
    expect(await db.timetableSlot.count()).toBe(1);
  });
  it("requires the teacher to be assigned to the subject unless overridden", async () => {
    await expect(tt.addSlot(S.admin, slot({ teacherId: tea2 }))).rejects.toMatchObject({ message: expect.stringMatching(/not assigned/) });
    await expect(tt.addSlot(S.admin, slot({ teacherId: tea2, allowUnassignedTeacher: true }))).resolves.toBeTruthy();
  });
  it("database unique indexes are the backstop even if the service is bypassed", async () => {
    await tt.addSlot(S.admin, slot({}));
    await expect(db.timetableSlot.create({ data: { timetableId: table, dayOfWeek: 1, periodIndex: 0, startTime: "08:00", endTime: "08:40", classId: S.jss2.id, sectionKey: "*", subjectId: S.math.id, teacherId: tea } })).rejects.toThrow();
  });
  it("moves and removes slots, re-validating on move", async () => {
    const a = await tt.addSlot(S.admin, slot({}));
    await tt.addSlot(S.admin, slot({ periodIndex: 1, startTime: "08:40", endTime: "09:20", classId: S.jss2.id }));
    await expect(tt.moveSlot(S.admin, a.id, { dayOfWeek: 1, periodIndex: 1, startTime: "08:40", endTime: "09:20" })).rejects.toMatchObject({ code: "TIMETABLE_CONFLICT" });
    await expect(tt.moveSlot(S.admin, a.id, { dayOfWeek: 2, periodIndex: 3, startTime: "10:20", endTime: "11:00" })).resolves.toBeTruthy();
    await tt.removeSlot(S.admin, a.id);
    expect(await db.timetableSlot.count()).toBe(1);
  });
  it("generates a conflict-free draft, persists it, and honours unavailability", async () => {
    const periods = [["08:00", "08:40"], ["08:40", "09:20"], ["09:20", "10:00"], ["10:20", "11:00"]].map(([start, end]) => ({ start: start!, end: end! }));
    const r = await tt.generateTimetable(S.admin, { timetableId: table, periods, defaultPeriodsPerWeek: 4, unavailable: [{ teacherId: tea, dayOfWeek: 1, periodIndex: 0 }] });
    expect(r.unplaced).toEqual([]);
    expect(r.placed).toBe(12);
    const slots = await db.timetableSlot.findMany({ where: { timetableId: table } });
    expect(slots.some((s) => s.teacherId === tea && s.dayOfWeek === 1 && s.periodIndex === 0)).toBe(false);
    const keys = new Set(slots.map((s) => `${s.teacherId}|${s.dayOfWeek}|${s.periodIndex}`));
    expect(keys.size).toBe(slots.length);
  });
  it("activating archives the previous active timetable for the term", async () => {
    const b = await tt.createTimetable(S.admin, { termId: S.t1.id, name: "Revised" });
    await tt.activateTimetable(S.admin, table);
    await tt.activateTimetable(S.admin, b.id);
    expect((await db.timetable.findUniqueOrThrow({ where: { id: table } })).status).toBe("ARCHIVED");
  });

  describe("my timetable (self-scoped, no timetable permission needed)", () => {
    const login = async (username: string) => {
      const u = await db.user.findUniqueOrThrow({ where: { username } });
      await db.user.update({ where: { id: u.id }, data: { passwordHash: await hashPassword("Pass-word-9"), mustChangePassword: false } });
      return ctxFor(username, "Pass-word-9");
    };
    let secA: string, secB: string;
    beforeEach(async () => {
      secA = (await academics.createSection(S.admin, { classId: S.jss1.id, name: "Grace", capacity: 30 })).id;
      secB = (await academics.createSection(S.admin, { classId: S.jss1.id, name: "Peace", capacity: 30 })).id;
      await tt.addSlot(S.admin, slot({}));                                                                            // whole JSS 1, Mon P1 (maths, tea)
      await tt.addSlot(S.admin, slot({ periodIndex: 1, startTime: "08:40", endTime: "09:20", subjectId: S.eng.id, teacherId: tea2, sectionId: secA })); // Grace only
      await tt.addSlot(S.admin, slot({ periodIndex: 2, startTime: "09:20", endTime: "10:00", subjectId: S.eng.id, teacherId: tea2, sectionId: secB })); // Peace only
      await tt.addSlot(S.admin, slot({ classId: S.jss2.id, periodIndex: 3, startTime: "10:20", endTime: "11:00" })); // another class entirely
      await tt.activateTimetable(S.admin, table);
    });
    const periods = (m: Awaited<ReturnType<typeof tt.myTimetable>>) => m.days.flatMap((d) => d.slots.map((s) => `${d.day}:${s.period}`));

    it("a student sees exactly their own class and section — never another class or section", async () => {
      const st = await people.createStudent(S.admin, { firstName: "Ada", lastName: "Grace", gender: "FEMALE", classId: S.jss1.id, sectionId: secA, createLogin: true });
      const m = await tt.myTimetable(await login(st.username!));
      expect(m).toMatchObject({ kind: "student", title: "JSS 1 timetable", timetable: { name: "Master" } });
      expect(periods(m)).toEqual(["1:0", "1:1"]); // whole-class + Grace; not Peace, not JSS 2
      expect(m.days[0]!.slots[0]).toMatchObject({ subject: expect.any(String), teacher: "Mr One", room: null });
    });

    it("a parent sees a linked child's timetable; an unlinked child looks like it doesn't exist", async () => {
      const mine = await people.createStudent(S.admin, { firstName: "A", lastName: "Kid", gender: "MALE", classId: S.jss1.id, sectionId: secB, guardians: [{ newParent: { firstName: "P", lastName: "Kid", phone: "08022223333" }, relationship: "Mother" }] });
      const other = await people.createStudent(S.admin, { firstName: "B", lastName: "Kid", gender: "MALE", classId: S.jss2.id });
      const parent = await login(mine.guardianCredentials[0]!.username);
      expect(periods(await tt.myTimetable(parent, mine.student.id))).toEqual(["1:0", "1:2"]);
      await expect(tt.myTimetable(parent, other.student.id)).rejects.toMatchObject({ status: 404 });
      await expect(tt.myTimetable(parent)).rejects.toMatchObject({ status: 422 }); // must say which child
    });

    it("a teacher sees only their own lessons (with the class, not the teacher's own name)", async () => {
      const t = await people.createTeacher(S.admin, { firstName: "Solo", lastName: "Teacher" });
      await academics.assignClassSubject(S.admin, { classId: S.ss1.id, subjectId: S.math.id, teacherId: t.teacher.id });
      await tt.addSlot(S.admin, slot({ classId: S.ss1.id, teacherId: t.teacher.id, dayOfWeek: 3, periodIndex: 5, startTime: "13:00", endTime: "13:40" }));
      const m = await tt.myTimetable(await login(t.username));
      expect(m.kind).toBe("teacher");
      expect(m.days).toEqual([{ day: 3, slots: [expect.objectContaining({ period: 5, class: "SS 1", teacher: null })] }]);
    });

    it("non-teaching staff have their own full timetable screen and no 'mine'; only the ACTIVE timetable is ever shown", async () => {
      await makeUser({ username: "clerk", type: "STAFF", roles: ["staff"] });
      await expect(tt.myTimetable(await login("clerk"))).rejects.toMatchObject({ status: 404 });
      const st = await people.createStudent(S.admin, { firstName: "C", lastName: "Kid", gender: "MALE", classId: S.jss1.id, sectionId: secA, createLogin: true });
      await db.timetable.update({ where: { id: table }, data: { status: "DRAFT" } });
      expect((await tt.myTimetable(await login(st.username!))).days).toEqual([]);
    });
  });
});
