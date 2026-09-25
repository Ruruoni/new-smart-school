import { db } from "../db";
import { forbidden, notFound } from "../errors";
import type { SecurityContext } from "./context";

export type StudentAccess = "general" | "results" | "finance";

/**
 * Resource-level authorization (IDOR defence). Permission keys say what a role may do in principle;
 * scope decides WHICH records. Staff with a wide permission see the whole school; parents see only
 * linked children (subject to per-guardian flags); students only themselves.
 */
export async function visibleStudentIds(ctx: SecurityContext, access: StudentAccess = "general"): Promise<string[] | "ALL"> {
  if (ctx.user.userType === "PARENT") {
    const links = await db.guardianRelationship.findMany({
      where: { parent: { userId: ctx.user.id }, ...(access === "results" ? { canViewResults: true } : access === "finance" ? { canViewFinance: true } : {}) },
      select: { studentId: true },
    });
    return links.map((l) => l.studentId);
  }
  if (ctx.user.userType === "STUDENT") {
    const me = await db.studentProfile.findUnique({ where: { userId: ctx.user.id }, select: { id: true } });
    return me ? [me.id] : [];
  }
  return "ALL";
}

export async function assertCanAccessStudent(ctx: SecurityContext, studentId: string, access: StudentAccess = "general"): Promise<void> {
  const ids = await visibleStudentIds(ctx, access);
  if (ids === "ALL") return;
  // Deliberately the same error as "does not exist" so IDs cannot be probed.
  if (!ids.includes(studentId)) throw notFound("Student");
}

/** A teacher may act on a class-subject only if assigned to it (or holds the "any" permission). */
export async function assertTeachesClassSubject(ctx: SecurityContext, classSubjectId: string, anyPermission: string): Promise<void> {
  if (ctx.can(anyPermission)) return;
  const cs = await db.classSubject.findUnique({ where: { id: classSubjectId }, select: { teacher: { select: { userId: true } } } });
  if (!cs) throw notFound("Class subject");
  if (cs.teacher?.userId !== ctx.user.id) throw forbidden("You are not assigned to this class subject");
}

export async function teacherProfileId(ctx: SecurityContext): Promise<string | null> {
  const t = await db.teacherProfile.findUnique({ where: { userId: ctx.user.id }, select: { id: true } });
  return t?.id ?? null;
}
