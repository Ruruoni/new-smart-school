import { randomInt } from "node:crypto";
import { z } from "zod";
import { db, transact, type Tx } from "@/platform/db";
import type { SecurityContext } from "@/platform/security/context";
import { auditIn } from "@/platform/security/interceptor";
import { assertCanAccessStudent, visibleStudentIds } from "@/platform/security/scope";
import { enqueueSync } from "@/platform/sync/outbox";
import { publishEvent } from "@/platform/events";
import { hashPassword } from "@/platform/password";
import { formatted, nextNumber } from "@/platform/sequence";
import { conflict, notFound, validation } from "@/platform/errors";
import { assertUpdated, asPage, birthDate, ilike, isoDate, skipTake, toDate, uuid, type PageQuery } from "@/platform/util";

const PW_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function generatePassword(len = 10): string {
  return Array.from({ length: len }, () => PW_ALPHABET[randomInt(PW_ALPHABET.length)]).join("") + "7a";
}

async function uniqueUsername(tx: Tx, base: string): Promise<string> {
  const clean = base.toLowerCase().replace(/[^a-z0-9._-]/g, "");
  let candidate = clean;
  for (let n = 2; await tx.user.findUnique({ where: { username: candidate }, select: { id: true } }); n++) candidate = `${clean}${n}`;
  return candidate;
}

const person = {
  firstName: z.string().trim().min(1).max(60),
  middleName: z.string().trim().max(60).optional(),
  lastName: z.string().trim().min(1).max(60),
};

// ───────────── Guardians / parents ─────────────

export const ParentInput = z.object({
  ...person,
  phone: z.string().trim().min(7).max(30),
  email: z.string().email().optional(),
  occupation: z.string().trim().max(80).optional(),
  address: z.string().trim().max(300).optional(),
});

export async function createParentTx(tx: Tx, input: z.infer<typeof ParentInput>) {
  const p = ParentInput.parse(input);
  const password = generatePassword();
  const username = await uniqueUsername(tx, p.phone.replace(/\D/g, "") || `${p.firstName}.${p.lastName}`);
  const user = await tx.user.create({
    data: { username, email: p.email, phone: p.phone, passwordHash: await hashPassword(password), firstName: p.firstName, lastName: p.lastName, userType: "PARENT", mustChangePassword: true },
  });
  const role = await tx.role.findUnique({ where: { key: "parent" } });
  if (role) await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
  const parent = await tx.parentProfile.create({ data: { userId: user.id, firstName: p.firstName, lastName: p.lastName, phone: p.phone, email: p.email, occupation: p.occupation, address: p.address } });
  return { parent, username, initialPassword: password };
}

export async function linkGuardian(ctx: SecurityContext, raw: { studentId: string; parentId: string; relationship: string; isPrimary?: boolean; canViewFinance?: boolean; canViewResults?: boolean }) {
  const i = z.object({ studentId: uuid, parentId: uuid, relationship: z.string().trim().min(2).max(30), isPrimary: z.boolean().default(false), canViewFinance: z.boolean().default(true), canViewResults: z.boolean().default(true) }).parse(raw);
  return transact(async (tx) => {
    const s = await tx.studentProfile.findFirst({ where: { id: i.studentId, deletedAt: null } });
    const p = await tx.parentProfile.findUnique({ where: { id: i.parentId } });
    if (!s) throw notFound("Student");
    if (!p) throw notFound("Parent");
    if (i.isPrimary) await tx.guardianRelationship.updateMany({ where: { studentId: i.studentId, isPrimary: true }, data: { isPrimary: false } });
    const link = await tx.guardianRelationship.upsert({
      where: { studentId_parentId: { studentId: i.studentId, parentId: i.parentId } },
      create: i,
      update: { relationship: i.relationship, isPrimary: i.isPrimary, canViewFinance: i.canViewFinance, canViewResults: i.canViewResults },
    });
    await auditIn(tx, ctx, { action: "guardian.link", module: "students", entityType: "GuardianRelationship", entityId: link.id, after: link });
    return link;
  });
}

export async function unlinkGuardian(ctx: SecurityContext, studentId: string, parentId: string) {
  return transact(async (tx) => {
    const r = await tx.guardianRelationship.deleteMany({ where: { studentId, parentId } });
    if (!r.count) throw notFound("Guardian link");
    await auditIn(tx, ctx, { action: "guardian.unlink", module: "students", entityType: "Student", entityId: studentId, metadata: { parentId } });
  });
}

// ───────────── Students ─────────────

export const StudentInput = z.object({
  ...person,
  gender: z.enum(["MALE", "FEMALE"]),
  dateOfBirth: birthDate.optional(),
  stateOfOrigin: z.string().trim().max(60).optional(),
  lga: z.string().trim().max(80).optional(),
  religion: z.string().trim().max(40).optional(),
  bloodGroup: z.string().trim().max(5).optional(),
  genotype: z.string().trim().max(5).optional(),
  address: z.string().trim().max(300).optional(),
  phone: z.string().trim().max(30).optional(),
  medicalNotes: z.string().trim().max(1000).optional(),
  classId: uuid.optional(),
  sectionId: uuid.nullable().optional(),
  createLogin: z.boolean().default(false),
  guardians: z.array(z.union([
    z.object({ parentId: uuid, relationship: z.string().trim().min(2).max(30), isPrimary: z.boolean().default(false) }),
    z.object({ newParent: ParentInput, relationship: z.string().trim().min(2).max(30), isPrimary: z.boolean().default(false) }),
  ])).max(4).default([]),
  admissionRecordId: uuid.optional(),
  /// Bulk imports may carry the school's existing admission numbers; when absent one is generated.
  admissionNumber: z.string().trim().min(3).max(40).optional(),
});

/** Enrollment writes the (unique per student-year) row and its sync record. Used by create, enroll and admissions. */
export async function enrollTx(tx: Tx, studentId: string, classId: string, sectionId: string | null | undefined, academicYearId: string) {
  const cls = await tx.schoolClass.findUnique({ where: { id: classId } });
  if (!cls) throw notFound("Class");
  if (sectionId) {
    const sec = await tx.section.findUnique({ where: { id: sectionId } });
    if (!sec || sec.classId !== classId) throw validation("Section does not belong to that class");
    if (sec.capacity) {
      const taken = await tx.enrollment.count({ where: { sectionId, academicYearId, status: "ACTIVE" } });
      if (taken >= sec.capacity) throw conflict(`Section ${sec.name} is full (${sec.capacity})`);
    }
  }
  const existing = await tx.enrollment.findUnique({ where: { studentId_academicYearId: { studentId, academicYearId } } });
  const row = existing
    ? await tx.enrollment.update({ where: { id: existing.id }, data: { classId, sectionId: sectionId ?? null, status: "ACTIVE", version: { increment: 1 } } })
    : await tx.enrollment.create({ data: { studentId, classId, sectionId: sectionId ?? null, academicYearId } });
  await enqueueSync(tx, "enrollment", row);
  return row;
}

export async function admissionNumberTx(tx: Tx): Promise<string> {
  const year = new Date().getFullYear();
  return formatted(tx, "ADM", year, 4);
}

export async function createStudentTx(tx: Tx, ctx: SecurityContext, raw: z.input<typeof StudentInput>, opts: { presetPasswordHash?: string } = {}) {
  const i = StudentInput.parse(raw);
  if (i.admissionNumber && (await tx.studentProfile.findUnique({ where: { admissionNumber: i.admissionNumber }, select: { id: true } }))) throw conflict(`Admission number ${i.admissionNumber} is already in use`);
  const admissionNumber = i.admissionNumber ?? (await admissionNumberTx(tx));
  let user: { id: string } | null = null;
  let initialPassword: string | undefined;
  if (i.createLogin) {
    initialPassword = opts.presetPasswordHash ? undefined : generatePassword();
    const username = await uniqueUsername(tx, admissionNumber.replace(/\//g, "."));
    user = await tx.user.create({ data: { username, passwordHash: opts.presetPasswordHash ?? (await hashPassword(initialPassword!)), firstName: i.firstName, lastName: i.lastName, userType: "STUDENT", mustChangePassword: true } });
    const role = await tx.role.findUnique({ where: { key: "student" } });
    if (role) await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
  }
  const student = await tx.studentProfile.create({
    data: {
      userId: user?.id, admissionNumber, firstName: i.firstName, middleName: i.middleName, lastName: i.lastName, gender: i.gender,
      dateOfBirth: i.dateOfBirth ? toDate(i.dateOfBirth) : undefined, stateOfOrigin: i.stateOfOrigin, lga: i.lga, religion: i.religion,
      bloodGroup: i.bloodGroup, genotype: i.genotype, address: i.address, phone: i.phone, medicalNotes: i.medicalNotes,
      admittedOn: new Date(), admissionRecordId: i.admissionRecordId,
    },
  });
  await tx.studentStatusHistory.create({ data: { studentId: student.id, toStatus: "ACTIVE", reason: "Admitted", changedById: ctx.user.id } });

  const guardianCredentials: { username: string; initialPassword: string }[] = [];
  for (const g of i.guardians) {
    let parentId: string;
    if ("parentId" in g) parentId = g.parentId;
    else {
      const created = await createParentTx(tx, g.newParent);
      parentId = created.parent.id;
      guardianCredentials.push({ username: created.username, initialPassword: created.initialPassword });
    }
    await tx.guardianRelationship.create({ data: { studentId: student.id, parentId, relationship: g.relationship, isPrimary: g.isPrimary } });
  }
  if (i.classId) {
    const year = await tx.academicYear.findFirst({ where: { isCurrent: true } });
    if (!year) throw validation("Set a current academic year before enrolling students");
    await enrollTx(tx, student.id, i.classId, i.sectionId, year.id);
  }
  await enqueueSync(tx, "student", student);
  await auditIn(tx, ctx, { action: "student.create", module: "students", entityType: "StudentProfile", entityId: student.id, after: { admissionNumber, name: `${i.firstName} ${i.lastName}`, classId: i.classId } });
  return { student, initialPassword, username: user ? (await tx.user.findUniqueOrThrow({ where: { id: user.id } })).username : undefined, guardianCredentials };
}

export async function findParentByPhone(tx: Tx, phone: string) {
  return tx.parentProfile.findFirst({ where: { phone }, select: { id: true } });
}

export const createStudent = (ctx: SecurityContext, raw: z.input<typeof StudentInput>) => transact((tx) => createStudentTx(tx, ctx, raw));

export const StudentPatch = StudentInput.pick({ firstName: true, middleName: true, lastName: true, gender: true, stateOfOrigin: true, lga: true, religion: true, bloodGroup: true, genotype: true, address: true, phone: true, medicalNotes: true }).partial().extend({ dateOfBirth: birthDate.optional(), version: z.number().int() });

export async function updateStudent(ctx: SecurityContext, id: string, raw: z.infer<typeof StudentPatch>) {
  const { version, dateOfBirth, ...patch } = StudentPatch.parse(raw);
  return transact(async (tx) => {
    const before = await tx.studentProfile.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw notFound("Student");
    const r = await tx.studentProfile.updateMany({ where: { id, version }, data: { ...patch, ...(dateOfBirth ? { dateOfBirth: toDate(dateOfBirth) } : {}), version: { increment: 1 } } });
    assertUpdated(r.count, "Student", before.version);
    const after = await tx.studentProfile.findUniqueOrThrow({ where: { id } });
    await enqueueSync(tx, "student", after);
    await auditIn(tx, ctx, { action: "student.update", module: "students", entityType: "StudentProfile", entityId: id, before, after });
    return after;
  });
}

export async function changeStudentStatus(ctx: SecurityContext, id: string, status: "ACTIVE" | "SUSPENDED" | "WITHDRAWN" | "TRANSFERRED" | "GRADUATED", reason?: string) {
  return transact(async (tx) => {
    const s = await tx.studentProfile.findFirst({ where: { id, deletedAt: null } });
    if (!s) throw notFound("Student");
    if (s.status === status) throw validation("Student already has that status");
    const updated = await tx.studentProfile.update({ where: { id }, data: { status, version: { increment: 1 } } });
    await tx.studentStatusHistory.create({ data: { studentId: id, fromStatus: s.status, toStatus: status, reason, changedById: ctx.user.id } });
    if (status !== "ACTIVE" && status !== "SUSPENDED") {
      await tx.enrollment.updateMany({ where: { studentId: id, status: "ACTIVE" }, data: { status: status === "GRADUATED" ? "COMPLETED" : status === "TRANSFERRED" ? "TRANSFERRED" : "WITHDRAWN" } });
    }
    if (s.userId && status !== "ACTIVE") await tx.user.update({ where: { id: s.userId }, data: { status: "SUSPENDED" } }).catch(() => undefined);
    if (s.userId && status === "ACTIVE") await tx.user.update({ where: { id: s.userId }, data: { status: "ACTIVE" } }).catch(() => undefined);
    await enqueueSync(tx, "student", updated);
    await auditIn(tx, ctx, { action: "student.status_change", module: "students", entityType: "StudentProfile", entityId: id, before: { status: s.status }, after: { status }, metadata: { reason } });
    return updated;
  });
}

/** Soft delete only — a student with any history is never physically removed. */
export async function archiveStudent(ctx: SecurityContext, id: string) {
  return transact(async (tx) => {
    const s = await tx.studentProfile.findFirst({ where: { id, deletedAt: null } });
    if (!s) throw notFound("Student");
    await tx.studentProfile.update({ where: { id }, data: { deletedAt: new Date(), status: "WITHDRAWN", version: { increment: 1 } } });
    await tx.enrollment.updateMany({ where: { studentId: id, status: "ACTIVE" }, data: { status: "WITHDRAWN" } });
    await enqueueSync(tx, "student", { ...s, status: "WITHDRAWN", version: s.version + 1 }, "DELETE");
    await auditIn(tx, ctx, { action: "student.archive", module: "students", entityType: "StudentProfile", entityId: id, before: { admissionNumber: s.admissionNumber } });
  });
}

export async function enrollStudent(ctx: SecurityContext, raw: { studentId: string; classId: string; sectionId?: string | null; academicYearId?: string }) {
  const i = z.object({ studentId: uuid, classId: uuid, sectionId: uuid.nullable().optional(), academicYearId: uuid.optional() }).parse(raw);
  return transact(async (tx) => {
    const s = await tx.studentProfile.findFirst({ where: { id: i.studentId, deletedAt: null } });
    if (!s) throw notFound("Student");
    const yearId = i.academicYearId ?? (await tx.academicYear.findFirst({ where: { isCurrent: true } }))?.id;
    if (!yearId) throw validation("No current academic year is set");
    const row = await enrollTx(tx, i.studentId, i.classId, i.sectionId, yearId);
    await auditIn(tx, ctx, { action: "enrollment.set", module: "students", entityType: "Enrollment", entityId: row.id, after: row });
    return row;
  });
}

export const StudentListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().trim().max(100).optional(),
  classId: uuid.optional(),
  sectionId: uuid.optional(),
  status: z.enum(["ACTIVE", "SUSPENDED", "WITHDRAWN", "TRANSFERRED", "GRADUATED"]).optional(),
  sort: z.enum(["name", "admission", "newest"]).default("name"),
});

const listSelect = {
  id: true, admissionNumber: true, firstName: true, middleName: true, lastName: true, gender: true, status: true, dateOfBirth: true, photoFileId: true, version: true,
  enrollments: { where: { status: "ACTIVE" as const }, select: { class: { select: { id: true, name: true } }, section: { select: { name: true } } }, take: 1, orderBy: { createdAt: "desc" as const } },
} as const;

export async function listStudents(ctx: SecurityContext, raw: z.input<typeof StudentListQuery>) {
  const q = StudentListQuery.parse(raw);
  const visible = await visibleStudentIds(ctx);
  const where = {
    deletedAt: null,
    ...(visible === "ALL" ? {} : { id: { in: visible } }),
    ...(q.status ? { status: q.status } : {}),
    ...(q.classId || q.sectionId ? { enrollments: { some: { status: "ACTIVE" as const, ...(q.classId ? { classId: q.classId } : {}), ...(q.sectionId ? { sectionId: q.sectionId } : {}) } } } : {}),
    ...(q.q ? { OR: [{ firstName: ilike(q.q) }, { lastName: ilike(q.q) }, { admissionNumber: ilike(q.q) }] } : {}),
  };
  const orderBy = q.sort === "admission" ? [{ admissionNumber: "asc" as const }] : q.sort === "newest" ? [{ createdAt: "desc" as const }] : [{ lastName: "asc" as const }, { firstName: "asc" as const }];
  const [items, total] = await Promise.all([db.studentProfile.findMany({ where, select: listSelect, orderBy, ...skipTake(q) }), db.studentProfile.count({ where })]);
  return asPage(items, total, q);
}

export async function getStudent(ctx: SecurityContext, id: string) {
  await assertCanAccessStudent(ctx, id);
  const s = await db.studentProfile.findFirst({
    where: { id, deletedAt: null },
    include: {
      guardians: { include: { parent: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } } } },
      enrollments: { orderBy: { createdAt: "desc" }, include: { class: { select: { name: true } }, section: { select: { name: true } }, academicYear: { select: { name: true } } } },
      statusHistory: { orderBy: { changedAt: "desc" }, take: 20 },
    },
  });
  if (!s) throw notFound("Student");
  // Guardians/students see the record without internal medical notes.
  if (!ctx.can("students.view")) return { ...s, medicalNotes: null };
  return s;
}

// ───────────── Teachers & staff ─────────────

export const TeacherInput = z.object({
  ...person,
  phone: z.string().trim().max(30).optional(),
  email: z.string().email().optional(),
  qualification: z.string().trim().max(120).optional(),
  specialization: z.string().trim().max(120).optional(),
  employedOn: isoDate.optional(),
  address: z.string().trim().max(300).optional(),
});

export async function createTeacherTx(tx: Tx, ctx: SecurityContext, raw: z.infer<typeof TeacherInput>) {
  const i = TeacherInput.parse(raw);
  const n = await nextNumber(tx, "staff-number");
  const staffNumber = `TCH/${String(n).padStart(4, "0")}`;
  const password = generatePassword();
  const username = await uniqueUsername(tx, `${i.firstName}.${i.lastName}`);
  const user = await tx.user.create({ data: { username, email: i.email, phone: i.phone, passwordHash: await hashPassword(password), firstName: i.firstName, lastName: i.lastName, userType: "TEACHER", mustChangePassword: true } });
  const role = await tx.role.findUnique({ where: { key: "teacher" } });
  if (role) await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
  const teacher = await tx.teacherProfile.create({ data: { userId: user.id, staffNumber, qualification: i.qualification, specialization: i.specialization, phone: i.phone, address: i.address, employedOn: i.employedOn ? toDate(i.employedOn) : undefined } });
  await auditIn(tx, ctx, { action: "teacher.create", module: "staff", entityType: "TeacherProfile", entityId: teacher.id, after: { staffNumber, username } });
  return { teacher, username, initialPassword: password };
}
export const createTeacher = (ctx: SecurityContext, raw: z.input<typeof TeacherInput>) => transact((tx) => createTeacherTx(tx, ctx, raw as z.infer<typeof TeacherInput>));

export const StaffInput = TeacherInput.omit({ qualification: true, specialization: true }).extend({ department: z.string().trim().max(80).optional(), position: z.string().trim().max(80).optional() });

export async function createStaffTx(tx: Tx, ctx: SecurityContext, raw: z.infer<typeof StaffInput>) {
  const i = StaffInput.parse(raw);
  const n = await nextNumber(tx, "staff-number");
  const staffNumber = `STF/${String(n).padStart(4, "0")}`;
  const password = generatePassword();
  const username = await uniqueUsername(tx, `${i.firstName}.${i.lastName}`);
  const user = await tx.user.create({ data: { username, email: i.email, phone: i.phone, passwordHash: await hashPassword(password), firstName: i.firstName, lastName: i.lastName, userType: "STAFF", mustChangePassword: true } });
  const role = await tx.role.findUnique({ where: { key: "staff" } });
  if (role) await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
  const staff = await tx.staffProfile.create({ data: { userId: user.id, staffNumber, department: i.department, position: i.position, phone: i.phone, address: i.address, employedOn: i.employedOn ? toDate(i.employedOn) : undefined } });
  await auditIn(tx, ctx, { action: "staff.create", module: "staff", entityType: "StaffProfile", entityId: staff.id, after: { staffNumber, username } });
  return { staff, username, initialPassword: password };
}
export const createStaff = (ctx: SecurityContext, raw: z.input<typeof StaffInput>) => transact((tx) => createStaffTx(tx, ctx, raw as z.infer<typeof StaffInput>));

export async function listTeachers(q: PageQuery) {
  const where = { deletedAt: null, ...(q.q ? { OR: [{ staffNumber: ilike(q.q) }, { user: { firstName: ilike(q.q) } }, { user: { lastName: ilike(q.q) } }] } : {}) };
  const [items, total] = await Promise.all([
    db.teacherProfile.findMany({ where, include: { user: { select: { firstName: true, lastName: true, email: true, phone: true, status: true } } }, orderBy: { staffNumber: "asc" }, ...skipTake(q) }),
    db.teacherProfile.count({ where }),
  ]);
  return asPage(items, total, q);
}

export async function listStaff(q: PageQuery) {
  const where = { deletedAt: null, ...(q.q ? { OR: [{ staffNumber: ilike(q.q) }, { user: { firstName: ilike(q.q) } }, { user: { lastName: ilike(q.q) } }] } : {}) };
  const [items, total] = await Promise.all([
    db.staffProfile.findMany({ where, include: { user: { select: { firstName: true, lastName: true, email: true, phone: true, status: true } } }, orderBy: { staffNumber: "asc" }, ...skipTake(q) }),
    db.staffProfile.count({ where }),
  ]);
  return asPage(items, total, q);
}
