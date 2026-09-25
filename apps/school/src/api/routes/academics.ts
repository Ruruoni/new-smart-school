import { z } from "zod";
import * as ac from "@/modules/academics/service";
import { listClassSubjects } from "@/modules/academics/service";
import { db } from "@/platform/db";
import { teacherOverview } from "@/modules/results/teacher-overview";
import { json, route, type RouteDef } from "../router";

const M = { module: "academics" as const };

export const academicsRoutes: RouteDef[] = [
  route("GET", "/academics/years", { ...M, permission: "academics.view" }, async () => ac.listYears()),
  route("POST", "/academics/years", { ...M, permission: "academics.manage" }, async ({ ctx, req }) => ac.createAcademicYear(ctx, (await json(req)) as never)),
  route("POST", "/academics/terms", { ...M, permission: "academics.manage" }, async ({ ctx, req }) => ac.createTerm(ctx, (await json(req)) as never)),
  route("POST", "/academics/terms/:id/current", { ...M, permission: "academics.manage" }, async ({ ctx, params }) => ac.setCurrentTerm(ctx, params.id!)),
  route("GET", "/academics/current", { permission: [] }, async () => ({ term: await ac.currentTerm() })),
  route("GET", "/academics/classes", { ...M, permission: ["academics.view", "self.view"] }, async () => ac.listClasses()),
  route("POST", "/academics/classes", { ...M, permission: "academics.manage" }, async ({ ctx, req }) => ac.createClass(ctx, (await json(req)) as never)),
  route("PATCH", "/academics/classes/:id", { ...M, permission: "academics.manage" }, async ({ ctx, req, params }) => ac.updateClass(ctx, params.id!, (await json(req)) as never)),
  route("POST", "/academics/sections", { ...M, permission: "academics.manage" }, async ({ ctx, req }) => ac.createSection(ctx, (await json(req)) as never)),
  route("GET", "/academics/subjects", { ...M, permission: ["academics.view", "self.view"] }, async () => db.subject.findMany({ where: { isActive: true }, orderBy: { name: "asc" } })),
  route("POST", "/academics/subjects", { ...M, permission: "academics.manage" }, async ({ ctx, req }) => ac.createSubject(ctx, (await json(req)) as never)),
  route("PUT", "/academics/curriculum", { ...M, permission: "academics.manage" }, async ({ ctx, req }) => ac.setCurriculum(ctx, (await json(req)) as never)),
  route("GET", "/academics/curriculum", { ...M, permission: ["academics.view", "self.view"] }, async ({ query }) => db.curriculum.findMany({ where: query.get("subjectId") ? { subjectId: query.get("subjectId")! } : {}, orderBy: { classLevel: "asc" } })),
  route("GET", "/academics/classes/:id/subjects", { ...M, permission: "academics.view" }, async ({ params }) => listClassSubjects(params.id!)),
  route("POST", "/academics/class-subjects", { ...M, permission: "class_subjects.manage" }, async ({ ctx, req }) => ac.assignClassSubject(ctx, (await json(req)) as never)),
  route("GET", "/academics/my-class-subjects", { ...M, permission: ["assessments.enter_scores", "assessments.enter_any"] }, async ({ ctx }) => {
    const tp = await db.teacherProfile.findUnique({ where: { userId: ctx.user.id }, select: { id: true } });
    return db.classSubject.findMany({ where: ctx.can("assessments.enter_any") ? {} : { teacherId: tp?.id ?? "00000000-0000-4000-8000-000000000000" }, include: { class: { select: { name: true, level: true } }, section: { select: { name: true } }, subject: { select: { name: true, code: true } } }, orderBy: [{ class: { level: "asc" } }, { subject: { name: "asc" } }] });
  }),
  route("GET", "/teach/overview", { permission: ["assessments.enter_scores", "attendance.record", "lessonnotes.manage_own"] }, async ({ ctx }) => teacherOverview(ctx)),
  route("GET", "/academics/rooms", { permission: ["timetable.view", "academics.view"] }, async () => db.room.findMany({ where: { isActive: true }, orderBy: { name: "asc" } })),
  route("GET", "/academics/overview", { ...M, permission: "academics.view" }, async () => z.object({}).parse({}) && { classes: await ac.listClasses(), years: await ac.listYears() }),
];
