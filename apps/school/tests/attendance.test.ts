import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/platform/db";
import * as att from "@/modules/attendance/service";
import * as people from "@/modules/people/service";
import * as academics from "@/modules/academics/service";
import { hashPassword } from "@/platform/password";
import { ctxFor, seedAcademics } from "./fixtures";
import { resetDb } from "./helpers";

let S: Awaited<ReturnType<typeof seedAcademics>>;
let kids: string[] = [];
const TODAY_SCHOOL = () => att.localParts(new Date(), "Africa/Lagos").date;
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

beforeEach(async () => {
  await resetDb();
  S = await seedAcademics();
  // widen the year so "today" always falls inside a term-less academic year
  await db.academicYear.update({ where: { id: S.year.id }, data: { startDate: new Date("2020-01-01"), endDate: new Date("2035-01-01") } });
  kids = [];
  for (const n of ["Ada", "Bola", "Chi"]) kids.push((await people.createStudent(S.admin, { firstName: n, lastName: "Kid", gender: "MALE", classId: S.jss1.id, sectionId: S.secA.id })).student.id);
});

describe("arrival policy (pure)", () => {
  const policy = { lateAfter: "08:00", absentAfter: "11:00" };
  it.each([[7 * 60 + 59, "PRESENT"], [8 * 60, "PRESENT"], [8 * 60 + 1, "LATE"], [11 * 60, "LATE"], [11 * 60 + 1, "ABSENT"]])("%d min → %s", (m, s) => expect(att.statusForArrival(m, policy)).toBe(s));
  it("converts instants to the school's local time (Lagos = UTC+1)", () => {
    expect(att.localParts(new Date("2026-01-05T07:30:00Z"), "Africa/Lagos")).toEqual({ date: "2026-01-05", minutes: 8 * 60 + 30 });
    expect(att.localParts(new Date("2026-01-05T23:30:00Z"), "Africa/Lagos")).toEqual({ date: "2026-01-06", minutes: 30 }); // crosses midnight locally
  });
});

describe("manual roll call", () => {
  it("records, is idempotent, and emits absence events only on transitions", async () => {
    const date = yesterday();
    const entries = [{ studentId: kids[0]!, status: "PRESENT" as const }, { studentId: kids[1]!, status: "ABSENT" as const }, { studentId: kids[2]!, status: "LATE" as const }];
    expect(await att.recordClassAttendance(S.admin, { classId: S.jss1.id, date, entries })).toEqual({ total: 3, changed: 3 });
    expect(await db.domainEvent.count({ where: { type: "attendance.absent" } })).toBe(1);
    expect(await db.domainEvent.count({ where: { type: "attendance.late" } })).toBe(1);
    expect(await att.recordClassAttendance(S.admin, { classId: S.jss1.id, date, entries })).toEqual({ total: 3, changed: 0 }); // replay
    expect(await db.domainEvent.count({ where: { type: "attendance.absent" } })).toBe(1);
    await att.recordClassAttendance(S.admin, { classId: S.jss1.id, date, entries: [{ studentId: kids[1]!, status: "PRESENT" }] });
    expect((await db.attendanceLog.findFirstOrThrow({ where: { studentId: kids[1] } })).version).toBe(2);
    expect(await db.syncQueue.count({ where: { entityType: "attendance_log" } })).toBeGreaterThanOrEqual(4);
  });
  it("counts absences this term for repeated-absence rules", async () => {
    for (let d = 1; d <= 3; d++) {
      const date = new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
      await att.recordClassAttendance(S.admin, { classId: S.jss1.id, date, entries: [{ studentId: kids[0]!, status: "ABSENT" }] });
    }
    const counts = (await db.domainEvent.findMany({ where: { type: "attendance.absent" }, orderBy: { seq: "asc" } })).map((e) => (e.payload as { absenceCount: number }).absenceCount);
    expect(counts.length).toBe(3);
    expect(Math.max(...counts)).toBeGreaterThanOrEqual(3);
  });
  it("refuses future dates and students outside the class", async () => {
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    await expect(att.recordClassAttendance(S.admin, { classId: S.jss1.id, date: tomorrow, entries: [{ studentId: kids[0]!, status: "PRESENT" }] })).rejects.toThrow(/future/);
    await expect(att.recordClassAttendance(S.admin, { classId: S.jss2.id, date: yesterday(), entries: [{ studentId: kids[0]!, status: "PRESENT" }] })).rejects.toThrow(/not in this class/);
  });
  it("only the form teacher / assigned teachers may mark; others are forbidden", async () => {
    const t1 = await people.createTeacher(S.admin, { firstName: "Form", lastName: "Teacher" });
    const t2 = await people.createTeacher(S.admin, { firstName: "Other", lastName: "Teacher" });
    await db.section.update({ where: { id: S.secA.id }, data: { formTeacherId: t1.teacher.id } });
    for (const t of [t1, t2]) await db.user.update({ where: { id: t.teacher.userId }, data: { passwordHash: await hashPassword("Teach-pass-1"), mustChangePassword: false } });
    const c1 = await ctxFor(t1.username, "Teach-pass-1");
    const c2 = await ctxFor(t2.username, "Teach-pass-1");
    const body = { classId: S.jss1.id, date: yesterday(), entries: [{ studentId: kids[0]!, status: "PRESENT" as const }] };
    await expect(att.recordClassAttendance(c1, body)).resolves.toBeTruthy();
    await expect(att.recordClassAttendance(c2, body)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("auto-marks absentees for students with no record", async () => {
    const date = yesterday();
    await att.recordClassAttendance(S.admin, { classId: S.jss1.id, date, entries: [{ studentId: kids[0]!, status: "PRESENT" }] });
    expect(await att.markAbsentees(S.admin, { date })).toEqual({ marked: 2 });
    expect(await att.markAbsentees(S.admin, { date })).toEqual({ marked: 0 });
    const s = await att.studentAttendance(S.admin, kids[1]!);
    expect(s.summary).toMatchObject({ absent: 1, total: 1, rate: 0 });
  });
});

describe("QR + devices", () => {
  it("QR tokens are signed; tampering and foreign ids are rejected", () => {
    const t = att.qrTokenFor(kids[0]!);
    expect(att.parseQrToken(t)).toBe(kids[0]);
    expect(() => att.parseQrToken(t.slice(0, -2) + "xx")).toThrow(/not valid/);
    expect(() => att.parseQrToken(`SS1.${kids[1]}.${t.split(".")[2]}`)).toThrow(/not valid/); // signature of another student
    expect(() => att.parseQrToken("garbage")).toThrow();
  });
  it("device keys are shown once and stored hashed; bad keys are refused", async () => {
    const { device, apiKey } = await att.registerDevice(S.admin, { name: "Gate scanner", kind: "QR_SCANNER" });
    expect(device.apiKeyHash).not.toBe(apiKey);
    expect((await att.authenticateDevice(apiKey)).id).toBe(device.id);
    await expect(att.authenticateDevice("ssd_wrong")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await db.attendanceDevice.update({ where: { id: device.id }, data: { isActive: false } });
    await expect(att.authenticateDevice(apiKey)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
  it("offline replay: earliest scan wins, duplicates ignored, lateness by cutoff, unknown codes rejected", async () => {
    const { device } = await att.registerDevice(S.admin, { name: "Gate", kind: "QR_SCANNER" });
    const day = TODAY_SCHOOL();
    // 07:30 and 09:15 Lagos = 06:30Z / 08:15Z
    const early = `${day}T06:30:00.000Z`, late = `${day}T08:15:00.000Z`;
    const scan = (id: string, at: string) => ({ token: att.qrTokenFor(id), scannedAt: at });
    const r1 = await att.ingestScans(device, { scans: [scan(kids[0]!, late), scan(kids[1]!, late), { token: "SS1.bad.token", scannedAt: early }] });
    expect(r1.results.map((r) => r.status)).toEqual(["RECORDED", "RECORDED", "REJECTED"]);
    expect((await db.attendanceLog.findFirstOrThrow({ where: { studentId: kids[0] } })).status).toBe("LATE");
    // replaying the whole batch (plus an earlier scan for kid 0) changes nothing for present students
    const r2 = await att.ingestScans(device, { scans: [scan(kids[1]!, late), scan(kids[0]!, early)] });
    expect(r2.results.map((r) => r.status)).toEqual(["DUPLICATE", "DUPLICATE"]);
    expect(await db.attendanceLog.count({ where: { date: new Date(`${day}T00:00:00Z`) } })).toBe(2);
    // an ABSENT mark (auto-marked) is corrected when the child actually arrives
    await att.markAbsentees(null, { date: day });
    const r3 = await att.ingestScans(device, { scans: [scan(kids[2]!, early)] });
    expect(r3.results[0]).toMatchObject({ status: "RECORDED", mark: "PRESENT" });
  });
  it("RFID/fingerprint readers are gated by feature flags", async () => {
    await expect(att.registerDevice(S.admin, { name: "RFID gate", kind: "RFID_READER" })).rejects.toMatchObject({ code: "FEATURE_DISABLED" });
    await db.featureFlag.upsert({ where: { key: "attendance.rfid" }, create: { key: "attendance.rfid", enabled: true }, update: { enabled: true } });
    const { device } = await att.registerDevice(S.admin, { name: "RFID gate", kind: "RFID_READER" });
    const st = await db.studentProfile.findUniqueOrThrow({ where: { id: kids[0]! } });
    const r = await att.ingestScans(device, { scans: [{ admissionNumber: st.admissionNumber, scannedAt: new Date().toISOString() }] });
    expect(r.recorded).toBe(1);
    expect((await db.attendanceLog.findFirstOrThrow({ where: { studentId: kids[0] } })).method).toBe("RFID");
  });
});

describe("staff attendance", () => {
  it("records for teachers/staff only", async () => {
    const t = await people.createTeacher(S.admin, { firstName: "Staff", lastName: "Member" });
    await att.recordStaffAttendance(S.admin, { date: yesterday(), entries: [{ userId: t.teacher.userId, status: "LATE" }] });
    expect(await db.attendanceLog.count({ where: { staffUserId: t.teacher.userId } })).toBe(1);
    const parent = (await people.createStudent(S.admin, { firstName: "P", lastName: "K", gender: "MALE", guardians: [{ newParent: { firstName: "Par", lastName: "Ent", phone: "08070000000" }, relationship: "Father" }] })).guardianCredentials;
    const pu = await db.user.findFirstOrThrow({ where: { username: parent[0]!.username } });
    await expect(att.recordStaffAttendance(S.admin, { date: yesterday(), entries: [{ userId: pu.id, status: "PRESENT" }] })).rejects.toThrow(/teachers and staff/);
    expect(academics).toBeTruthy();
  });
});
