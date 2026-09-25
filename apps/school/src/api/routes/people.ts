import { z } from "zod";
import * as people from "@/modules/people/service";
import { db } from "@/platform/db";
import { qrTokenFor } from "@/modules/attendance/service";
import { assertCanAccessStudent } from "@/platform/security/scope";
import { PageQuery, uuid } from "@/platform/util";
import { json, pick, route, type RouteDef } from "../router";

export const peopleRoutes: RouteDef[] = [
  route("GET", "/students", { module: "students", permission: ["students.view", "self.view"] }, async ({ ctx, query }) => people.listStudents(ctx, pick(query))),
  route("POST", "/students", { module: "students", permission: "students.create" }, async ({ ctx, req }) => people.createStudent(ctx, (await json(req)) as never)),
  route("GET", "/students/:id", { module: "students", permission: ["students.view", "self.view"] }, async ({ ctx, params }) => people.getStudent(ctx, params.id!)),
  route("PATCH", "/students/:id", { module: "students", permission: "students.edit" }, async ({ ctx, req, params }) => people.updateStudent(ctx, params.id!, (await json(req)) as never)),
  route("POST", "/students/:id/status", { module: "students", permission: "students.edit" }, async ({ ctx, req, params }) => {
    const b = z.object({ status: z.enum(["ACTIVE", "SUSPENDED", "WITHDRAWN", "TRANSFERRED", "GRADUATED"]), reason: z.string().max(300).optional() }).parse(await json(req));
    return people.changeStudentStatus(ctx, params.id!, b.status, b.reason);
  }),
  route("DELETE", "/students/:id", { module: "students", permission: "students.delete" }, async ({ ctx, params }) => { await people.archiveStudent(ctx, params.id!); return { ok: true }; }),
  route("POST", "/students/:id/enroll", { module: "students", permission: "enrollment.manage" }, async ({ ctx, req, params }) => people.enrollStudent(ctx, { ...(await json<object>(req)), studentId: params.id! } as never)),
  route("GET", "/students/:id/qr", { module: "attendance", permission: "students.view" }, async ({ ctx, params }) => { await assertCanAccessStudent(ctx, params.id!); return { token: qrTokenFor(params.id!) }; }),

  route("POST", "/guardians/link", { module: "students", permission: "guardians.manage" }, async ({ ctx, req }) => people.linkGuardian(ctx, (await json(req)) as never)),
  route("POST", "/guardians/unlink", { module: "students", permission: "guardians.manage" }, async ({ ctx, req }) => { const b = z.object({ studentId: uuid, parentId: uuid }).parse(await json(req)); await people.unlinkGuardian(ctx, b.studentId, b.parentId); return { ok: true }; }),
  route("GET", "/parents", { module: "students", permission: "guardians.manage" }, async ({ query }) => {
    const q = PageQuery.parse(pick(query));
    return db.parentProfile.findMany({ where: q.q ? { OR: [{ firstName: { contains: q.q, mode: "insensitive" } }, { lastName: { contains: q.q, mode: "insensitive" } }, { phone: { contains: q.q } }] } : {}, take: 20, orderBy: { lastName: "asc" }, select: { id: true, firstName: true, lastName: true, phone: true, email: true } });
  }),

  route("GET", "/teachers", { module: "staff", permission: "teachers.view" }, async ({ query }) => people.listTeachers(PageQuery.parse(pick(query)))),
  route("POST", "/teachers", { module: "staff", permission: "teachers.manage" }, async ({ ctx, req }) => people.createTeacher(ctx, (await json(req)) as never)),
  route("GET", "/staff", { module: "staff", permission: "staff.view" }, async ({ query }) => people.listStaff(PageQuery.parse(pick(query)))),
  route("POST", "/staff", { module: "staff", permission: "teachers.manage" }, async ({ ctx, req }) => people.createStaff(ctx, (await json(req)) as never)),

  /** The signed-in parent's or student's own children, for the portal's child selector. */
  route("GET", "/me/children", { permission: "self.view" }, async ({ ctx }) => {
    if (ctx.user.userType === "STUDENT") {
      const s = await db.studentProfile.findUnique({ where: { userId: ctx.user.id }, include: { enrollments: { where: { status: "ACTIVE" }, include: { class: { select: { name: true } } }, take: 1 } } });
      return s ? [{ id: s.id, firstName: s.firstName, lastName: s.lastName, admissionNumber: s.admissionNumber, class: s.enrollments[0]?.class.name ?? null, relationship: "Self", canViewFinance: true, canViewResults: true }] : [];
    }
    const links = await db.guardianRelationship.findMany({ where: { parent: { userId: ctx.user.id }, student: { deletedAt: null } }, include: { student: { include: { enrollments: { where: { status: "ACTIVE" }, include: { class: { select: { name: true } } }, take: 1 } } } }, orderBy: { student: { firstName: "asc" } } });
    return links.map((l) => ({ id: l.student.id, firstName: l.student.firstName, lastName: l.student.lastName, admissionNumber: l.student.admissionNumber, class: l.student.enrollments[0]?.class.name ?? null, relationship: l.relationship, canViewFinance: l.canViewFinance, canViewResults: l.canViewResults }));
  }),
];
