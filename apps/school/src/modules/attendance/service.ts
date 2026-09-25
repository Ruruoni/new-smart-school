import { z } from "zod";
import { db, transact, type Tx } from "@/platform/db";
import type { SecurityContext } from "@/platform/security/context";
import { auditIn } from "@/platform/security/interceptor";
import { assertCanAccessStudent, teacherProfileId } from "@/platform/security/scope";
import { audit } from "@/platform/audit";
import { enqueueSync } from "@/platform/sync/outbox";
import { publishEvent } from "@/platform/events";
import { hmac, randomToken, safeEqual, sha256 } from "@/platform/crypto";
import { getSetting } from "@/platform/settings";
import { isFeatureEnabled } from "@/platform/features";
import { AppError, featureDisabled, forbidden, notFound, unauthenticated, validation } from "@/platform/errors";
import { isoDate, toDate, uuid } from "@/platform/util";
import type { AttendanceMethod, AttendanceStatus } from "@/generated/prisma/client";

// ───────────── School-local time ─────────────

/** The school's calendar date and minutes-since-midnight for an instant (default Africa/Lagos, UTC+1, no DST). */
export function localParts(at: Date, timezone: string): { date: string; minutes: number } {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, minutes: Number(g("hour")) * 60 + Number(g("minute")) };
}
const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Pure cutoff rule: PRESENT until lateAfter, LATE until absentAfter, then ABSENT. */
export function statusForArrival(minutes: number, policy: { lateAfter: string; absentAfter: string }): AttendanceStatus {
  if (minutes <= toMinutes(policy.lateAfter)) return "PRESENT";
  if (minutes <= toMinutes(policy.absentAfter)) return "LATE";
  return "ABSENT";
}

const schoolTz = async () => (await db.schoolInstallation.findFirst({ select: { timezone: true } }))?.timezone ?? "Africa/Lagos";

// ───────────── Marking ─────────────

export const ClassAttendanceInput = z.object({
  classId: uuid,
  sectionId: uuid.nullable().optional(),
  date: isoDate,
  session: z.string().trim().min(1).max(60).default("DAY"),
  entries: z.array(z.object({ studentId: uuid, status: z.enum(["PRESENT", "LATE", "ABSENT", "EXCUSED"]), note: z.string().max(200).optional() })).min(1).max(500),
});

async function assertMayMark(ctx: SecurityContext, classId: string, sectionId?: string | null) {
  if (ctx.can("attendance.record_any")) return;
  const tp = await teacherProfileId(ctx);
  if (!tp) throw forbidden("Only assigned teachers can record attendance for this class");
  const formTeacher = await db.section.count({ where: { classId, ...(sectionId ? { id: sectionId } : {}), formTeacherId: tp } });
  const teaches = await db.classSubject.count({ where: { classId, teacherId: tp } });
  if (!formTeacher && !teaches) throw forbidden("You are not assigned to this class");
}

/** Counts ABSENT marks in the current term — the input to "repeated absence" automation rules. */
async function absenceCount(tx: Tx, studentId: string, date: Date): Promise<number> {
  const term = await tx.term.findFirst({ where: { startDate: { lte: date }, endDate: { gte: date } } });
  return tx.attendanceLog.count({ where: { studentId, status: "ABSENT", session: "DAY", ...(term ? { date: { gte: term.startDate, lte: term.endDate } } : {}) } });
}

async function upsertMark(tx: Tx, args: { studentId: string; date: Date; session: string; status: AttendanceStatus; method: AttendanceMethod; recordedById?: string | null; deviceId?: string | null; checkedInAt?: Date | null; note?: string | null }) {
  const key = { studentId_date_session: { studentId: args.studentId, date: args.date, session: args.session } };
  const cur = await tx.attendanceLog.findUnique({ where: key });
  if (cur && cur.status === args.status && cur.method === args.method) return { row: cur, changed: false, previous: cur.status };
  const row = cur
    ? await tx.attendanceLog.update({ where: key, data: { status: args.status, method: args.method, recordedById: args.recordedById, deviceId: args.deviceId, checkedInAt: args.checkedInAt ?? cur.checkedInAt, note: args.note ?? cur.note, version: { increment: 1 } } })
    : await tx.attendanceLog.create({ data: { studentId: args.studentId, date: args.date, session: args.session, status: args.status, method: args.method, recordedById: args.recordedById, deviceId: args.deviceId, checkedInAt: args.checkedInAt, note: args.note } });
  await enqueueSync(tx, "attendance_log", row);
  const now = row.status;
  if ((now === "ABSENT" || now === "LATE") && cur?.status !== now) {
    await publishEvent(tx, now === "ABSENT" ? "attendance.absent" : "attendance.late", { studentId: args.studentId, date: args.date.toISOString().slice(0, 10), absenceCount: now === "ABSENT" ? await absenceCount(tx, args.studentId, args.date) : undefined });
  }
  return { row, changed: true, previous: cur?.status ?? null };
}

export async function recordClassAttendance(ctx: SecurityContext, raw: z.input<typeof ClassAttendanceInput>) {
  const i = ClassAttendanceInput.parse(raw);
  await assertMayMark(ctx, i.classId, i.sectionId);
  const tz = await schoolTz();
  if (i.date > localParts(new Date(), tz).date) throw validation("Attendance cannot be recorded for a future date");
  const date = toDate(i.date);
  return transact(async (tx) => {
    const year = await tx.academicYear.findFirst({ where: { startDate: { lte: date }, endDate: { gte: date } } });
    const roster = new Set((await tx.enrollment.findMany({ where: { classId: i.classId, status: "ACTIVE", ...(year ? { academicYearId: year.id } : {}), ...(i.sectionId ? { sectionId: i.sectionId } : {}) }, select: { studentId: true } })).map((e) => e.studentId));
    const bad = i.entries.filter((e) => !roster.has(e.studentId));
    if (bad.length) throw validation("Some students are not in this class", { studentIds: bad.map((b) => b.studentId) });
    let changed = 0;
    for (const e of i.entries) {
      const r = await upsertMark(tx, { studentId: e.studentId, date, session: i.session, status: e.status, method: "MANUAL", recordedById: ctx.user.id, note: e.note });
      if (r.changed) changed += 1;
    }
    await auditIn(tx, ctx, { action: "attendance.record", module: "attendance", entityType: "SchoolClass", entityId: i.classId, metadata: { date: i.date, session: i.session, entries: i.entries.length, changed } });
    return { total: i.entries.length, changed };
  });
}

/** Fill in ABSENT for every enrolled student with no mark for the day (run after the absence cutoff). */
export async function markAbsentees(ctx: SecurityContext | null, raw: { classId?: string; date: string; session?: string }) {
  const date = toDate(raw.date);
  const session = raw.session ?? "DAY";
  return transact(async (tx) => {
    const year = await tx.academicYear.findFirst({ where: { startDate: { lte: date }, endDate: { gte: date } } });
    if (!year) return { marked: 0 };
    const enrolled = await tx.enrollment.findMany({ where: { academicYearId: year.id, status: "ACTIVE", student: { status: "ACTIVE", deletedAt: null }, ...(raw.classId ? { classId: raw.classId } : {}) }, select: { studentId: true } });
    const done = new Set((await tx.attendanceLog.findMany({ where: { date, session, studentId: { in: enrolled.map((e) => e.studentId) } }, select: { studentId: true } })).map((r) => r.studentId));
    let marked = 0;
    for (const e of enrolled) {
      if (done.has(e.studentId)) continue;
      await upsertMark(tx, { studentId: e.studentId, date, session, status: "ABSENT", method: "MANUAL", recordedById: ctx?.user.id ?? null, note: "Auto-marked: no attendance recorded" });
      marked += 1;
    }
    if (ctx) await auditIn(tx, ctx, { action: "attendance.mark_absentees", module: "attendance", metadata: { date: raw.date, marked } });
    else await audit(tx, { action: "attendance.mark_absentees", module: "attendance", metadata: { date: raw.date, marked, by: "system" } });
    return { marked };
  });
}

export async function classSheet(ctx: SecurityContext, classId: string, date: string, sectionId?: string) {
  await assertMayMark(ctx, classId, sectionId);
  const d = toDate(date);
  const year = await db.academicYear.findFirst({ where: { startDate: { lte: d }, endDate: { gte: d } } });
  const students = await db.enrollment.findMany({
    where: { classId, status: "ACTIVE", ...(year ? { academicYearId: year.id } : {}), ...(sectionId ? { sectionId } : {}), student: { status: "ACTIVE", deletedAt: null } },
    select: { student: { select: { id: true, admissionNumber: true, firstName: true, lastName: true, attendance: { where: { date: d, session: "DAY" }, select: { status: true, method: true, checkedInAt: true, version: true } } } } },
  });
  return students.map((s) => ({ studentId: s.student.id, admissionNumber: s.student.admissionNumber, firstName: s.student.firstName, lastName: s.student.lastName, mark: s.student.attendance[0] ?? null })).sort((a, b) => a.lastName.localeCompare(b.lastName));
}

export async function studentAttendance(ctx: SecurityContext, studentId: string, range: { from?: string; to?: string } = {}) {
  await assertCanAccessStudent(ctx, studentId);
  const rows = await db.attendanceLog.findMany({ where: { studentId, session: "DAY", date: { gte: range.from ? toDate(range.from) : undefined, lte: range.to ? toDate(range.to) : undefined } }, orderBy: { date: "desc" }, take: 400, select: { date: true, status: true, checkedInAt: true, method: true } });
  const n = (s: string) => rows.filter((r) => r.status === s).length;
  const attended = n("PRESENT") + n("LATE");
  const total = rows.length;
  return { rows, summary: { present: n("PRESENT"), late: n("LATE"), absent: n("ABSENT"), excused: n("EXCUSED"), total, rate: total ? Math.round((attended / total) * 1000) / 10 : null } };
}

// ───────────── Staff attendance ─────────────

export async function recordStaffAttendance(ctx: SecurityContext, raw: { date: string; entries: { userId: string; status: AttendanceStatus }[] }) {
  const i = z.object({ date: isoDate, entries: z.array(z.object({ userId: uuid, status: z.enum(["PRESENT", "LATE", "ABSENT", "EXCUSED"]) })).min(1).max(300) }).parse(raw);
  const date = toDate(i.date);
  return transact(async (tx) => {
    const users = await tx.user.findMany({ where: { id: { in: i.entries.map((e) => e.userId) }, userType: { in: ["TEACHER", "STAFF"] }, deletedAt: null }, select: { id: true } });
    if (users.length !== new Set(i.entries.map((e) => e.userId)).size) throw validation("Attendance can only be recorded for teachers and staff");
    for (const e of i.entries) {
      const key = { staffUserId_date_session: { staffUserId: e.userId, date, session: "DAY" } };
      const cur = await tx.attendanceLog.findUnique({ where: key });
      const row = cur ? await tx.attendanceLog.update({ where: key, data: { status: e.status, recordedById: ctx.user.id, version: { increment: 1 } } }) : await tx.attendanceLog.create({ data: { staffUserId: e.userId, date, session: "DAY", status: e.status, method: "MANUAL", recordedById: ctx.user.id } });
      await enqueueSync(tx, "attendance_log", row);
    }
    await auditIn(tx, ctx, { action: "staff_attendance.record", module: "staff", metadata: { date: i.date, entries: i.entries.length } });
    return { total: i.entries.length };
  });
}

// ───────────── QR codes ─────────────

/** Signed, non-guessable student code for ID cards. Verifiable offline by any scanner that holds the school secret. */
export const qrTokenFor = (studentId: string) => `SS1.${studentId}.${hmac(studentId, "qr-attendance").slice(0, 22)}`;

export function parseQrToken(token: string): string {
  const [v, id, sig] = token.trim().split(".");
  if (v !== "SS1" || !id || !sig || !z.string().uuid().safeParse(id).success || !safeEqual(sig, hmac(id, "qr-attendance").slice(0, 22))) throw new AppError("INVALID_QR", "This QR code is not valid", 400);
  return id;
}

// ───────────── Devices (QR scanner / RFID / fingerprint boundary) ─────────────

export async function registerDevice(ctx: SecurityContext, raw: { name: string; kind: "QR_SCANNER" | "RFID_READER" | "FINGERPRINT_READER" | "TABLET"; location?: string }) {
  const i = z.object({ name: z.string().trim().min(2).max(60), kind: z.enum(["QR_SCANNER", "RFID_READER", "FINGERPRINT_READER", "TABLET"]), location: z.string().max(100).optional() }).parse(raw);
  if (i.kind === "RFID_READER" && !(await isFeatureEnabled("attendance.rfid"))) throw featureDisabled("attendance.rfid");
  if (i.kind === "FINGERPRINT_READER" && !(await isFeatureEnabled("attendance.fingerprint"))) throw featureDisabled("attendance.fingerprint");
  const apiKey = `ssd_${randomToken(24)}`;
  return transact(async (tx) => {
    const d = await tx.attendanceDevice.create({ data: { ...i, apiKeyHash: sha256(apiKey) } });
    await auditIn(tx, ctx, { action: "attendance_device.register", module: "attendance", entityType: "AttendanceDevice", entityId: d.id, after: { name: d.name, kind: d.kind } });
    return { device: d, apiKey }; // the raw key is shown once and never stored
  });
}

export async function authenticateDevice(apiKey: string | null | undefined) {
  if (!apiKey) throw unauthenticated("Device key required");
  const d = await db.attendanceDevice.findUnique({ where: { apiKeyHash: sha256(apiKey) } });
  if (!d || !d.isActive) throw unauthenticated("Unknown or disabled device");
  await db.attendanceDevice.update({ where: { id: d.id }, data: { lastSeenAt: new Date() } });
  return d;
}

export const ScanBatch = z.object({
  scans: z.array(z.object({
    /// QR scanners send the signed code; RFID/fingerprint readers send the admission number they resolved locally.
    token: z.string().min(3).max(200).optional(),
    admissionNumber: z.string().min(3).max(40).optional(),
    scannedAt: z.string().datetime(),
  }).refine((s) => s.token || s.admissionNumber, "token or admissionNumber required")).min(1).max(500),
});

/**
 * Devices queue scans while offline and replay them in batches. Replays are harmless: one mark per
 * student per day, the earliest arrival wins, and a present student is never downgraded.
 */
export async function ingestScans(device: { id: string; kind: string }, raw: z.input<typeof ScanBatch>) {
  const { scans } = ScanBatch.parse(raw);
  const method: AttendanceMethod = device.kind === "RFID_READER" ? "RFID" : device.kind === "FINGERPRINT_READER" ? "FINGERPRINT" : "QR";
  if (method === "RFID" && !(await isFeatureEnabled("attendance.rfid"))) throw featureDisabled("attendance.rfid");
  if (method === "FINGERPRINT" && !(await isFeatureEnabled("attendance.fingerprint"))) throw featureDisabled("attendance.fingerprint");
  const policy = await getSetting("attendance.policy");
  const tz = await schoolTz();
  const results: { index: number; status: "RECORDED" | "DUPLICATE" | "REJECTED"; reason?: string; mark?: AttendanceStatus }[] = [];
  for (const [index, s] of scans.entries()) {
    try {
      const studentId = s.token ? parseQrToken(s.token) : (await db.studentProfile.findUnique({ where: { admissionNumber: s.admissionNumber! }, select: { id: true } }))?.id;
      if (!studentId) { results.push({ index, status: "REJECTED", reason: "Unknown student" }); continue; }
      const at = new Date(s.scannedAt);
      const { date, minutes } = localParts(at, tz);
      const outcome = await transact(async (tx) => {
        const st = await tx.studentProfile.findFirst({ where: { id: studentId, deletedAt: null, status: "ACTIVE" } });
        if (!st) return { status: "REJECTED" as const, reason: "Student is not active" };
        const existing = await tx.attendanceLog.findUnique({ where: { studentId_date_session: { studentId, date: toDate(date), session: "DAY" } } });
        const status = statusForArrival(minutes, policy);
        // A scan after the absence cutoff still records the arrival time as LATE rather than ABSENT — the child is here.
        const effective: AttendanceStatus = status === "ABSENT" ? "LATE" : status;
        if (existing && existing.status !== "ABSENT" && existing.status !== "EXCUSED") return { status: "DUPLICATE" as const, mark: existing.status };
        const r = await upsertMark(tx, { studentId, date: toDate(date), session: "DAY", status: effective, method, deviceId: device.id, checkedInAt: at });
        return { status: "RECORDED" as const, mark: r.row.status };
      });
      results.push({ index, ...outcome });
    } catch (err) {
      if (err instanceof AppError) results.push({ index, status: "REJECTED", reason: err.message });
      else throw err;
    }
  }
  return { results, recorded: results.filter((r) => r.status === "RECORDED").length };
}

export const listDevices = () => db.attendanceDevice.findMany({ select: { id: true, name: true, kind: true, location: true, isActive: true, lastSeenAt: true }, orderBy: { name: "asc" } });
