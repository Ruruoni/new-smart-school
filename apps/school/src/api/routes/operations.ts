import { z } from "zod";
import * as att from "@/modules/attendance/service";
import * as tt from "@/modules/timetable/service";
import * as notes from "@/modules/lessonnotes/service";
import { db } from "@/platform/db";
import { uuid } from "@/platform/util";
import { json, publicRoute, readUpload, route, type RouteDef } from "../router";

const A = { module: "attendance" as const };
const T = { module: "timetable" as const };
const L = { module: "lessonnotes" as const };

export const operationsRoutes: RouteDef[] = [
  // ── attendance ──
  route("GET", "/attendance/sheet", { ...A, permission: ["attendance.record", "attendance.record_any"] }, async ({ ctx, query }) => att.classSheet(ctx, uuid.parse(query.get("classId")), z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(query.get("date")), query.get("sectionId") ?? undefined)),
  route("POST", "/attendance/record", { ...A, permission: ["attendance.record", "attendance.record_any"] }, async ({ ctx, req }) => att.recordClassAttendance(ctx, (await json(req)) as never)),
  route("POST", "/attendance/absentees", { ...A, permission: "attendance.record_any" }, async ({ ctx, req }) => att.markAbsentees(ctx, (await json(req)) as never)),
  route("GET", "/attendance/students/:id", { ...A, permission: ["attendance.view", "self.view"] }, async ({ ctx, params, query }) => att.studentAttendance(ctx, params.id!, { from: query.get("from") ?? undefined, to: query.get("to") ?? undefined })),
  route("POST", "/attendance/staff", { module: "staff", permission: "staff_attendance.record" }, async ({ ctx, req }) => att.recordStaffAttendance(ctx, (await json(req)) as never)),
  route("GET", "/attendance/staff-list", { module: "staff", permission: "staff_attendance.record" }, async ({ query }) => {
    const date = new Date(`${z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(query.get("date"))}T00:00:00Z`);
    const users = await db.user.findMany({ where: { userType: { in: ["TEACHER", "STAFF"] }, deletedAt: null, status: "ACTIVE" }, select: { id: true, firstName: true, lastName: true, userType: true }, orderBy: { lastName: "asc" } });
    const logs = await db.attendanceLog.findMany({ where: { date, session: "DAY", staffUserId: { in: users.map((u) => u.id) } }, select: { staffUserId: true, status: true } });
    return users.map((u) => ({ ...u, status: logs.find((l) => l.staffUserId === u.id)?.status ?? null }));
  }),
  route("GET", "/attendance/devices", { ...A, permission: "attendance.devices" }, async () => att.listDevices()),
  route("POST", "/attendance/devices", { ...A, permission: "attendance.devices" }, async ({ ctx, req }) => att.registerDevice(ctx, (await json(req)) as never)),
  route("POST", "/attendance/devices/:id/active", { ...A, permission: "attendance.devices" }, async ({ params, req }) => { await db.attendanceDevice.update({ where: { id: params.id! }, data: { isActive: z.object({ active: z.boolean() }).parse(await json(req)).active } }); return { ok: true }; }),
  /** Hardware/scanner boundary: authenticated by a per-device API key, not a user session. */
  publicRoute("POST", "/device/attendance/scan", async ({ req }) => att.ingestScans(await att.authenticateDevice(req.headers.get("x-device-key")), (await json(req)) as never)),

  // ── timetable ──
  route("GET", "/timetable", { ...T, permission: "timetable.view" }, async () => db.timetable.findMany({ include: { term: { select: { name: true } }, _count: { select: { slots: true } } }, orderBy: { createdAt: "desc" } })),
  route("POST", "/timetable", { ...T, permission: "timetable.manage" }, async ({ ctx, req }) => tt.createTimetable(ctx, (await json(req)) as never)),
  route("POST", "/timetable/:id/activate", { ...T, permission: "timetable.manage" }, async ({ ctx, params }) => tt.activateTimetable(ctx, params.id!)),
  route("GET", "/timetable/mine", { ...T, permission: ["timetable.view", "self.view"] }, async ({ ctx, query }) => tt.myTimetable(ctx, query.get("studentId") ? uuid.parse(query.get("studentId")) : undefined)),
  route("GET", "/timetable/:id/slots", { ...T, permission: "timetable.view" }, async ({ params, query }) => tt.timetableView(params.id!, { classId: query.get("classId") ?? undefined, teacherId: query.get("teacherId") ?? undefined, roomId: query.get("roomId") ?? undefined })),
  route("POST", "/timetable/validate-slot", { ...T, permission: "timetable.manage" }, async ({ req }) => tt.validateSlot((await json(req)) as never)),
  route("POST", "/timetable/slots", { ...T, permission: "timetable.manage" }, async ({ ctx, req }) => tt.addSlot(ctx, (await json(req)) as never)),
  route("PATCH", "/timetable/slots/:id", { ...T, permission: "timetable.manage" }, async ({ ctx, req, params }) => tt.moveSlot(ctx, params.id!, (await json(req)) as never)),
  route("DELETE", "/timetable/slots/:id", { ...T, permission: "timetable.manage" }, async ({ ctx, params }) => { await tt.removeSlot(ctx, params.id!); return { ok: true }; }),
  route("POST", "/timetable/generate", { ...T, permission: "timetable.manage" }, async ({ ctx, req }) => tt.generateTimetable(ctx, (await json(req)) as never)),
  route("POST", "/timetable/rooms", { ...T, permission: "timetable.manage" }, async ({ ctx, req }) => tt.createRoom(ctx, (await json(req)) as never)),

  // ── lesson notes ──
  route("GET", "/lesson-notes", { ...L, permission: ["lessonnotes.view", "lessonnotes.manage_own", "lessonnotes.manage_any"] }, async ({ ctx, query }) => notes.listNotes(ctx, Object.fromEntries(query.entries()) as never)),
  route("POST", "/lesson-notes", { ...L, permission: ["lessonnotes.manage_own", "lessonnotes.manage_any"] }, async ({ ctx, req }) => notes.createNote(ctx, (await json(req)) as never)),
  route("GET", "/lesson-notes/:id", { ...L, permission: ["lessonnotes.view", "lessonnotes.manage_own", "lessonnotes.manage_any"] }, async ({ ctx, params }) => notes.getNote(ctx, params.id!)),
  route("PATCH", "/lesson-notes/:id", { ...L, permission: ["lessonnotes.manage_own", "lessonnotes.manage_any"] }, async ({ ctx, req, params }) => notes.updateNote(ctx, params.id!, (await json(req)) as never)),
  route("POST", "/lesson-notes/:id/publish", { ...L, permission: ["lessonnotes.manage_own", "lessonnotes.manage_any"] }, async ({ ctx, req, params }) => notes.setPublished(ctx, params.id!, z.object({ published: z.boolean() }).parse(await json(req)).published)),
  route("POST", "/lesson-notes/:id/restore", { ...L, permission: ["lessonnotes.manage_own", "lessonnotes.manage_any"] }, async ({ ctx, req, params }) => notes.restoreVersion(ctx, params.id!, z.object({ versionNo: z.number().int() }).parse(await json(req)).versionNo)),
  route("POST", "/lesson-notes/:id/attachments", { ...L, permission: ["lessonnotes.manage_own", "lessonnotes.manage_any"] }, async ({ ctx, req, params }) => notes.attachFile(ctx, params.id!, (await readUpload(req)).file)),
  route("DELETE", "/lesson-notes/:id/attachments/:attId", { ...L, permission: ["lessonnotes.manage_own", "lessonnotes.manage_any"] }, async ({ ctx, params }) => { await notes.removeAttachment(ctx, params.id!, params.attId!); return { ok: true }; }),
];
