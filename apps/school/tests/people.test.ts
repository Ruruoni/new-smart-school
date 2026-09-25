import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/platform/db";
import * as people from "@/modules/people/service";
import * as academics from "@/modules/academics/service";
import { assertCanAccessStudent } from "@/platform/security/scope";
import { ctxFor, seedAcademics } from "./fixtures";
import { resetDb } from "./helpers";

let S: Awaited<ReturnType<typeof seedAcademics>>;
beforeEach(async () => {
  await resetDb();
  S = await seedAcademics();
});

const kid = (over = {}) => ({ firstName: "Chidi", lastName: "Okafor", gender: "MALE" as const, ...over });

describe("academic structure", () => {
  it("only one current term/year and term dates validated", async () => {
    await academics.setCurrentTerm(S.admin, S.t2.id);
    expect((await db.term.findMany({ where: { isCurrent: true } })).map((t) => t.name)).toEqual(["Second Term"]);
    await expect(academics.createTerm(S.admin, { academicYearId: S.year.id, name: "Bad", sequence: 3, startDate: "2025-11-01", endDate: "2025-11-30" })).rejects.toThrow(/overlap/);
    await expect(academics.createTerm(S.admin, { academicYearId: S.year.id, name: "Outside", sequence: 3, startDate: "2026-09-01", endDate: "2026-12-01" })).rejects.toThrow(/inside the academic year/);
  });
  it("assigns class subjects incl. whole-class duplicates", async () => {
    const a = await academics.assignClassSubject(S.admin, { classId: S.jss1.id, subjectId: S.math.id });
    const b = await academics.assignClassSubject(S.admin, { classId: S.jss1.id, subjectId: S.math.id });
    expect(b.id).toBe(a.id);
    await expect(academics.assignClassSubject(S.admin, { classId: S.jss2.id, sectionId: S.secA.id, subjectId: S.math.id })).rejects.toThrow(/does not belong/);
  });
});

describe("students", () => {
  it("creates a student with login, guardian, enrollment; syncs and audits atomically", async () => {
    const r = await people.createStudent(S.admin, {
      ...kid(), classId: S.jss1.id, sectionId: S.secA.id, createLogin: true,
      guardians: [{ newParent: { firstName: "Ngozi", lastName: "Okafor", phone: "08031234567" }, relationship: "Mother", isPrimary: true }],
    });
    expect(r.student.admissionNumber).toMatch(/^ADM\/\d{4}\/0001$/);
    expect(r.initialPassword).toBeTruthy();
    expect(r.guardianCredentials).toHaveLength(1);
    expect(await db.guardianRelationship.count({ where: { studentId: r.student.id } })).toBe(1);
    expect(await db.enrollment.count({ where: { studentId: r.student.id, status: "ACTIVE" } })).toBe(1);
    expect(await db.syncQueue.count({ where: { entityType: "student", entityId: r.student.id } })).toBe(1);
    expect(await db.syncQueue.count({ where: { entityType: "enrollment" } })).toBe(1);
    // stored password is hashed
    const u = await db.user.findUniqueOrThrow({ where: { id: r.student.userId! } });
    expect(u.passwordHash).toMatch(/^\$argon2id\$/);
    expect(u.mustChangePassword).toBe(true);
  });

  it("rolls everything back if enrollment fails (no orphan student, no wasted sync row)", async () => {
    await db.academicYear.updateMany({ data: { isCurrent: false } }); // no current year → enroll must fail
    await expect(people.createStudent(S.admin, { ...kid(), classId: S.jss1.id })).rejects.toThrow(/current academic year/);
    expect(await db.studentProfile.count()).toBe(0);
    expect(await db.syncQueue.count({ where: { entityType: "student" } })).toBe(0);
  });

  it("generates distinct sequential admission numbers", async () => {
    const nums = [];
    for (let i = 0; i < 3; i++) nums.push((await people.createStudent(S.admin, kid({ firstName: `K${i}` }))).student.admissionNumber);
    expect(new Set(nums).size).toBe(3);
  });

  it("enforces section capacity and one enrollment per year", async () => {
    const sec = await academics.createSection(S.admin, { classId: S.jss1.id, name: "B", capacity: 1 });
    await people.createStudent(S.admin, kid({ classId: S.jss1.id, sectionId: sec.id }));
    await expect(people.createStudent(S.admin, kid({ firstName: "Second", classId: S.jss1.id, sectionId: sec.id }))).rejects.toThrow(/full/);
    const s = (await people.createStudent(S.admin, kid({ firstName: "Mover", classId: S.jss1.id }))).student;
    await people.enrollStudent(S.admin, { studentId: s.id, classId: S.jss2.id });
    expect(await db.enrollment.count({ where: { studentId: s.id } })).toBe(1);
  });

  it("status changes keep history, deactivate the login, and archiving is soft", async () => {
    const r = await people.createStudent(S.admin, kid({ createLogin: true, classId: S.jss1.id }));
    await people.changeStudentStatus(S.admin, r.student.id, "TRANSFERRED", "Moved to Abuja");
    expect((await db.user.findUniqueOrThrow({ where: { id: r.student.userId! } })).status).toBe("SUSPENDED");
    expect(await db.enrollment.count({ where: { studentId: r.student.id, status: "TRANSFERRED" } })).toBe(1);
    expect(await db.studentStatusHistory.count({ where: { studentId: r.student.id } })).toBe(2);
    await people.archiveStudent(S.admin, r.student.id);
    expect(await db.studentProfile.count({ where: { id: r.student.id } })).toBe(1); // row still exists
    await expect(people.getStudent(S.admin, r.student.id)).rejects.toThrow(/not found/);
    expect(await db.syncQueue.count({ where: { entityType: "student", operation: "DELETE" } })).toBe(1);
  });

  it("optimistic concurrency on edit", async () => {
    const s = (await people.createStudent(S.admin, kid())).student;
    await people.updateStudent(S.admin, s.id, { version: s.version, address: "12 Allen Ave" });
    await expect(people.updateStudent(S.admin, s.id, { version: s.version, address: "elsewhere" })).rejects.toMatchObject({ code: "STALE_WRITE" });
  });

  it("list is paginated, searchable and filterable by class", async () => {
    for (let i = 0; i < 7; i++) await people.createStudent(S.admin, kid({ firstName: `Pupil${i}`, lastName: i < 3 ? "Adeyemi" : "Bello", classId: i < 5 ? S.jss1.id : undefined }));
    const page = await people.listStudents(S.admin, { pageSize: 3, page: 2 });
    expect(page.total).toBe(7);
    expect(page.items).toHaveLength(3);
    expect((await people.listStudents(S.admin, { q: "adeyemi" })).total).toBe(3);
    expect((await people.listStudents(S.admin, { classId: S.jss1.id })).total).toBe(5);
  });
});

describe("resource scope (IDOR)", () => {
  it("parents see only their own children; students only themselves", async () => {
    const a = await people.createStudent(S.admin, { ...kid(), guardians: [{ newParent: { firstName: "P", lastName: "One", phone: "08011111111" }, relationship: "Father" }] });
    const b = await people.createStudent(S.admin, kid({ firstName: "Stranger" }));
    // a parent that can hold the login: reset known password
    const parentUser = await db.user.findFirstOrThrow({ where: { userType: "PARENT" } });
    const { hashPassword } = await import("@/platform/password");
    await db.user.update({ where: { id: parentUser.id }, data: { passwordHash: await hashPassword("Parent-pass-1"), mustChangePassword: false } });
    const pctx = await ctxFor(parentUser.username, "Parent-pass-1");
    await expect(assertCanAccessStudent(pctx, a.student.id)).resolves.toBeUndefined();
    await expect(assertCanAccessStudent(pctx, b.student.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await people.listStudents(pctx, {})).total).toBe(1);
    await expect(people.getStudent(pctx, b.student.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // guardian flag: hide results
    await db.guardianRelationship.updateMany({ where: { studentId: a.student.id }, data: { canViewResults: false } });
    await expect(assertCanAccessStudent(pctx, a.student.id, "results")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("teachers and staff", () => {
  it("creates teacher with role, credentials and staff number", async () => {
    const t = await people.createTeacher(S.admin, { firstName: "Emeka", lastName: "Nwosu", qualification: "B.Ed" });
    expect(t.teacher.staffNumber).toBe("TCH/0001");
    const roles = await db.userRole.findMany({ where: { userId: t.teacher.userId }, include: { role: true } });
    expect(roles[0]?.role.key).toBe("teacher");
    const st = await people.createStaff(S.admin, { firstName: "Amaka", lastName: "Eze", department: "Bursary" });
    expect(st.staff.staffNumber).toBe("STF/0002");
  });
});

describe("date of birth is validated on the server", () => {
  it("rejects future and implausible dates for students (regression from the browser test)", async () => {
    await expect(people.createStudent(S.admin, { firstName: "Future", lastName: "Kid", gender: "MALE", dateOfBirth: "2999-01-01" })).rejects.toThrow(/real date of birth/);
    await expect(people.createStudent(S.admin, { firstName: "Ancient", lastName: "Kid", gender: "MALE", dateOfBirth: "1900-01-01" })).rejects.toThrow(/real date of birth/);
    await expect(people.createStudent(S.admin, { firstName: "Ok", lastName: "Kid", gender: "MALE", dateOfBirth: "2014-05-12" })).resolves.toBeTruthy();
  });
});
