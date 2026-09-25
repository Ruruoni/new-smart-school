import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "@/platform/db";
import { installTestSchool, makeUser, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
  await installTestSchool();
});

describe("primary admin protection (database level)", () => {
  it("allows only one primary admin", async () => {
    await expect(makeUser({ username: "second" }).then((u) => db.user.update({ where: { id: u.id }, data: { isPrimaryAdmin: true } }))).rejects.toThrow();
  });
  it("cannot be deleted, disabled, demoted or soft-deleted", async () => {
    const admin = await db.user.findFirstOrThrow({ where: { isPrimaryAdmin: true } });
    await expect(db.user.delete({ where: { id: admin.id } })).rejects.toThrow(/Primary Admin/);
    await expect(db.user.update({ where: { id: admin.id }, data: { status: "DISABLED" } })).rejects.toThrow(/Primary Admin/);
    await expect(db.user.update({ where: { id: admin.id }, data: { isPrimaryAdmin: false } })).rejects.toThrow(/Primary Admin/);
    await expect(db.user.update({ where: { id: admin.id }, data: { deletedAt: new Date() } })).rejects.toThrow(/Primary Admin/);
  });
  it("allows deliberate transfer only when the session flag is set", async () => {
    const admin = await db.user.findFirstOrThrow({ where: { isPrimaryAdmin: true } });
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('smartschool.allow_primary_admin_change', 'on', true)`;
      await tx.user.update({ where: { id: admin.id }, data: { isPrimaryAdmin: false } });
    });
    expect((await db.user.findUniqueOrThrow({ where: { id: admin.id } })).isPrimaryAdmin).toBe(false);
  });
});

describe("append-only tables", () => {
  it("audit log rows cannot be updated or deleted", async () => {
    const row = await db.auditLog.findFirstOrThrow();
    await expect(db.auditLog.update({ where: { id: row.id }, data: { action: "tampered" } })).rejects.toThrow(/append-only/);
    await expect(db.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
  });
});

describe("financial ledger invariants", () => {
  const line = (journalId: string, account: "CASH" | "RECEIVABLE", debit: number, credit: number) => ({
    journalId, account, debit, credit, refType: "TEST", refId: randomUUID(),
  });
  it("accepts a balanced journal", async () => {
    const j = randomUUID();
    await db.$transaction((tx) => tx.financialLedger.createMany({ data: [line(j, "CASH", 100, 0), line(j, "RECEIVABLE", 0, 100)] }));
    expect(await db.financialLedger.count({ where: { journalId: j } })).toBe(2);
  });
  it("rejects an unbalanced journal at commit", async () => {
    const j = randomUUID();
    await expect(db.$transaction((tx) => tx.financialLedger.createMany({ data: [line(j, "CASH", 100, 0), line(j, "RECEIVABLE", 0, 90)] }))).rejects.toThrow(/Unbalanced journal/);
    expect(await db.financialLedger.count({ where: { journalId: j } })).toBe(0);
  });
  it("rejects lines with both or neither side", async () => {
    await expect(db.financialLedger.create({ data: line(randomUUID(), "CASH", 5, 5) })).rejects.toThrow();
    await expect(db.financialLedger.create({ data: line(randomUUID(), "CASH", 0, 0) })).rejects.toThrow();
  });
  it("cannot be edited or deleted", async () => {
    const j = randomUUID();
    await db.$transaction((tx) => tx.financialLedger.createMany({ data: [line(j, "CASH", 10, 0), line(j, "RECEIVABLE", 0, 10)] }));
    const row = await db.financialLedger.findFirstOrThrow({ where: { journalId: j } });
    await expect(db.financialLedger.update({ where: { id: row.id }, data: { memo: "x" } })).rejects.toThrow(/append-only/);
    await expect(db.financialLedger.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
  });
});

describe("money and data sanity", () => {
  it("refuses overpaid invoices", async () => {
    await expect(
      db.invoice.create({ data: { number: "INV/1", subtotal: 100, total: 100, amountPaid: 150 } }),
    ).rejects.toThrow();
  });
  it("attendance belongs to exactly one person", async () => {
    await expect(db.attendanceLog.create({ data: { date: new Date("2026-01-05"), status: "PRESENT" } })).rejects.toThrow();
  });
});

describe("foreign-key indexes (PostgreSQL does not create them; Prisma doesn't either)", () => {
  /**
   * Every foreign key needs an index that starts with its column, or deleting/updating the parent row scans the child
   * table and joins on it are slow. These are the ones deliberately left without, each for a reason. A NEW foreign key
   * without an index fails this test: add the index, or add it here with the reason.
   */
  const ACCEPTED = new Set([
    "assessments.typeId",                 // tiny table; assessment types are never deleted once used
    "attendance_logs.deviceId",           // device deletion is rare and devices number in the single digits
    "automation_executions.eventId",      // set-null on event purge; executions are few
    "cbt_answers.examQuestionId",         // write-hot during exams: an extra index taxes every autosave. Reads go through attemptId (indexed)
    "cbt_topics.parentId", "classes.nextClassId", "resources.roomId", "role_permissions.permissionId", // small reference tables
    "promotion_records.academicYearId", "promotion_records.fromEnrollmentId", "promotion_records.toClassId", // written once a year
    "sync_conflicts.queueId",             // conflicts are rare and resolved quickly
    "timetable_slots.resourceId", "timetable_slots.roomId", "timetable_slots.sectionId", "timetable_slots.subjectId", // slots number in the low thousands and are always read via timetableId
  ]);
  it("no foreign key lacks a supporting index unless it is on the accepted list", async () => {
    const rows = await db.$queryRaw<{ tbl: string; col: string }[]>`
      SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
      FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1])`;
    const unindexed = rows.map((r) => `${r.tbl}.${r.col}`).filter((k) => !ACCEPTED.has(k));
    expect(unindexed).toEqual([]);
    // the list stays honest: an accepted entry that has since been indexed should be removed
    const still = new Set(rows.map((r) => `${r.tbl}.${r.col}`));
    expect([...ACCEPTED].filter((k) => !still.has(k))).toEqual([]);
  });
});

describe("time handling", () => {
  it("every connection runs in UTC so raw-SQL timestamp comparisons are correct on any server timezone", async () => {
    expect((await db.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`)[0]!.tz).toBe("UTC");
  });
  it("a job scheduled in the future is not claimed early (regression: timestamp vs now() offset)", async () => {
    const { enqueueJob, claimJobs } = await import("@/platform/jobs");
    await enqueueJob(db, "maintenance", "later", {}, { runAt: new Date(Date.now() + 10 * 60_000) });
    await enqueueJob(db, "maintenance", "now", {}, { runAt: new Date(Date.now() - 1000) });
    const claimed = await claimJobs("maintenance", "w1", 10);
    expect(claimed.map((j) => j.type)).toEqual(["now"]);
  });
});
