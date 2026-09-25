import { beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { db } from "@/platform/db";
import { isDue, runDueTasks, lastRun, type Task } from "@/workers/scheduler";
import { autoMarkAbsentees, maintenance, nightlyBackup, scanOverdueInvoices } from "@/workers/tasks";
import { processPendingEvents } from "@/modules/automation/engine";
import { listNotifications } from "@/modules/communication/engine";
import * as att from "@/modules/attendance/service";
import * as fin from "@/modules/finance/service";
import * as people from "@/modules/people/service";
import { publishEvent } from "@/platform/events";
import { resetEnvCache } from "@/platform/env";
import { seedAcademics } from "./fixtures";
import { resetDb } from "./helpers";

let S: Awaited<ReturnType<typeof seedAcademics>>;
const TZ = "Africa/Lagos";
beforeEach(async () => {
  process.env.BACKUP_DIR = "./.data/test-backups";
  resetEnvCache();
  await rm("./.data/test-backups", { recursive: true, force: true });
  await resetDb();
  S = await seedAcademics();
});

describe("scheduler due-logic (pure)", () => {
  // 2026-03-03 is a Tuesday. Lagos = UTC+1.
  const at = (iso: string) => new Date(iso);
  it("interval tasks", () => {
    expect(isDue({ everyMs: 60_000 }, null, at("2026-03-03T10:00:00Z"), TZ)).toBe(true);
    expect(isDue({ everyMs: 60_000 }, at("2026-03-03T09:59:30Z"), at("2026-03-03T10:00:00Z"), TZ)).toBe(false);
    expect(isDue({ everyMs: 60_000 }, at("2026-03-03T09:58:00Z"), at("2026-03-03T10:00:00Z"), TZ)).toBe(true);
  });
  it("daily tasks run once per LOCAL day, at/after the time, with catch-up after downtime", () => {
    const daily = { dailyAt: "02:00" };
    expect(isDue(daily, null, at("2026-03-03T00:30:00Z"), TZ)).toBe(false); // 01:30 local — too early
    expect(isDue(daily, null, at("2026-03-03T01:00:00Z"), TZ)).toBe(true); // 02:00 local
    expect(isDue(daily, at("2026-03-03T01:00:10Z"), at("2026-03-03T14:00:00Z"), TZ)).toBe(false); // already ran today
    expect(isDue(daily, at("2026-03-02T01:00:00Z"), at("2026-03-03T09:00:00Z"), TZ)).toBe(true); // server was off at 02:00 → catches up at 10:00 local
    expect(isDue(daily, at("2026-03-03T22:30:00Z"), at("2026-03-04T00:30:00Z"), TZ)).toBe(false); // 23:30 and 01:30 local: 23:30 Mar-3 is Mar-3, 01:30 Mar-4 is before 02:00
    expect(isDue(daily, at("2026-03-03T22:30:00Z"), at("2026-03-04T01:30:00Z"), TZ)).toBe(true);
  });
  it("weekday filters", () => {
    expect(isDue({ dailyAt: "07:00", days: [1, 2, 3, 4, 5] }, null, at("2026-03-07T10:00:00Z"), TZ)).toBe(false); // Saturday
    expect(isDue({ dailyAt: "07:00", days: [1, 2, 3, 4, 5] }, null, at("2026-03-06T10:00:00Z"), TZ)).toBe(true); // Friday
  });
  it("claims before running (no double runs), retries failed tasks, and isolates failures", async () => {
    const runs: string[] = [];
    const tasks: Task[] = [
      { name: "t.ok", schedule: { everyMs: 60_000 }, run: async () => void runs.push("ok") },
      { name: "t.bad", schedule: { everyMs: 60_000 }, run: async () => { runs.push("bad"); throw new Error("boom"); } },
    ];
    const now = new Date();
    const r1 = await runDueTasks(tasks, now);
    expect(r1).toEqual([{ name: "t.ok", ok: true }, { name: "t.bad", ok: false, error: "boom" }]);
    expect(await runDueTasks(tasks, now)).toEqual([{ name: "t.bad", ok: false, error: "boom" }]); // failed task is retried, ok task is not
    expect((await lastRun("t.ok"))?.getTime()).toBe(now.getTime());
    expect(runs).toEqual(["ok", "bad", "bad"]);
  });
});

describe("scheduled tasks", () => {
  it("overdue scan emits one reminder per invoice per week", async () => {
    await fin.createFeeStructure(S.admin, { name: "T1", termId: S.t1.id, items: [{ name: "Tuition", amount: 1000 }] });
    const kid = (await people.createStudent(S.admin, { firstName: "Late", lastName: "Payer", gender: "MALE", classId: S.jss1.id, guardians: [{ newParent: { firstName: "P", lastName: "Payer", phone: "08012345678" }, relationship: "Mother" }] })).student;
    await fin.generateInvoice(S.admin, { studentId: kid.id, termId: S.t1.id, dueDate: "2020-01-01" });
    expect(await scanOverdueInvoices()).toBe(1);
    expect(await scanOverdueInvoices()).toBe(0);
    expect(await scanOverdueInvoices(new Date(Date.now() + 8 * 86_400_000))).toBe(1); // a week later: nudge again
    await processPendingEvents();
    const parent = await db.user.findFirstOrThrow({ where: { userType: "PARENT" } });
    const inbox = await listNotifications(parent.id);
    expect(inbox.map((n) => n.type)).toContain("invoice.overdue");
    expect(inbox.find((n) => n.type === "invoice.overdue")!.body).toMatch(/1,?000\.00|1000\.00/);
  });
  it("auto-absentees respect the cutoff, weekends and days with no roll call", async () => {
    await db.academicYear.update({ where: { id: S.year.id }, data: { startDate: new Date("2020-01-01"), endDate: new Date("2035-01-01") } });
    const kids = [];
    for (const n of ["A1", "B2", "C3"]) kids.push((await people.createStudent(S.admin, { firstName: n, lastName: "Kid", gender: "MALE", classId: S.jss1.id })).student.id);
    const { date } = att.localParts(new Date(), "Africa/Lagos");
    const dow = ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
    const noon = new Date(`${date}T12:00:00+01:00`), early = new Date(`${date}T06:00:00+01:00`);
    expect(await autoMarkAbsentees(early)).toMatchObject({ skipped: "before cutoff" });
    if (dow > 5) return void expect(await autoMarkAbsentees(noon)).toMatchObject({ skipped: "weekend" });
    expect(await autoMarkAbsentees(noon)).toMatchObject({ skipped: "no attendance recorded today" });
    await att.recordClassAttendance(S.admin, { classId: S.jss1.id, date, entries: [{ studentId: kids[0]!, status: "PRESENT" }] });
    expect(await autoMarkAbsentees(noon)).toEqual({ marked: 2 });
    expect(await autoMarkAbsentees(noon)).toEqual({ marked: 0 });
  });
  it("maintenance purges only what is safe and is audited", async () => {
    const long = new Date(Date.now() - 100 * 86_400_000);
    await db.session.create({ data: { userId: (await db.user.findFirstOrThrow()).id, tokenHash: "x".repeat(64), expiresAt: new Date(Date.now() - 1000) } });
    await db.$transaction((tx) => publishEvent(tx, "attendance.late", { studentId: "s" }));
    await db.domainEvent.updateMany({ data: { processedAt: long } });
    await db.$transaction((tx) => publishEvent(tx, "attendance.late", { studentId: "unprocessed" }));
    const r = await maintenance();
    expect(r).toMatchObject({ expiredSessions: expect.any(Number), eventsPurged: 1 });
    expect(await db.domainEvent.count()).toBe(1);
    expect((await db.domainEvent.findFirstOrThrow()).processedAt).toBeNull(); // unprocessed events are never purged
    expect(await db.auditLog.count({ where: { action: "maintenance.run" } })).toBe(1);
  });
  it("nightly backup produces a verified archive", async () => {
    await people.createStudent(S.admin, { firstName: "Bk", lastName: "Kid", gender: "MALE" });
    const r = await nightlyBackup();
    expect(r.verified).toBe(true);
    expect((await db.backupRecord.findUniqueOrThrow({ where: { id: r.id } })).verifiedAt).not.toBeNull();
  });
});

describe("worker process (real supervisor, real database)", () => {
  it("starts, beats, processes events, stops gracefully on SIGTERM", async () => {
    // an event that a default rule turns into an in-app notification for the principal
    await db.user.create({ data: { username: "head", passwordHash: "x", firstName: "H", lastName: "M", userType: "STAFF" } });
    const head = await db.user.findUniqueOrThrow({ where: { username: "head" } });
    const role = await db.role.findUniqueOrThrow({ where: { key: "principal" } });
    await db.userRole.create({ data: { userId: head.id, roleId: role.id } });
    const kid = (await people.createStudent(S.admin, { firstName: "Abs", lastName: "Ent", gender: "MALE", classId: S.jss1.id })).student;
    await db.$transaction((tx) => publishEvent(tx, "attendance.absent", { studentId: kid.id, absenceCount: 5 }));

    const child = spawn("pnpm", ["exec", "tsx", "src/workers/main.ts"], { env: { ...process.env, WORKER_NAME: "test-worker" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
    try {
      const deadline = Date.now() + 40_000;
      let processed = false;
      while (Date.now() < deadline && !processed) {
        await new Promise((r) => setTimeout(r, 500));
        processed = (await db.domainEvent.count({ where: { processedAt: { not: null } } })) > 0 && (await db.notification.count({ where: { userId: head.id } })) > 0;
      }
      expect(processed, `worker output:\n${out}`).toBe(true);
      expect((await db.workerHeartbeat.findUniqueOrThrow({ where: { name: "test-worker" } })).status).toBe("OK");
      expect(out).toContain("started with 10 loops");
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((r) => child.on("exit", () => r()));
    }
    expect((await db.workerHeartbeat.findUniqueOrThrow({ where: { name: "test-worker" } })).status).toBe("STOPPED");
  }, 90_000);
});
