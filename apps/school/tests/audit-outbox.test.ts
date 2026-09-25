import { beforeEach, describe, expect, it } from "vitest";
import { db, transact } from "@/platform/db";
import { audit, verifyAuditChain } from "@/platform/audit";
import { enqueueSync, projectForSync } from "@/platform/sync/outbox";
import { nextNumber } from "@/platform/sync/../sequence";
import { installTestSchool, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
  await installTestSchool();
});

describe("audit hash chain", () => {
  it("is intact after many concurrent writes", async () => {
    await Promise.all(Array.from({ length: 15 }, (_, i) => transact((tx) => audit(tx, { action: "test.event", module: "platform", after: { i, nested: { b: 1, a: 2 } } }))));
    const r = await verifyAuditChain();
    expect(r.intact).toBe(true);
    expect(r.checked).toBeGreaterThanOrEqual(16);
  });
  it("detects tampering", async () => {
    await transact((tx) => audit(tx, { action: "victim", module: "platform", after: { amount: 100 } }));
    await db.$executeRawUnsafe(`ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only`);
    try {
      await db.$executeRawUnsafe(`UPDATE audit_logs SET after = '{"amount": 1}' WHERE action = 'victim'`);
      const r = await verifyAuditChain();
      expect(r.intact).toBe(false);
    } finally {
      await db.$executeRawUnsafe(`ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only`);
    }
  });
  it("rolls back with the business transaction", async () => {
    const before = await db.auditLog.count();
    await transact(async (tx) => {
      await audit(tx, { action: "will.rollback", module: "platform" });
      throw new Error("boom");
    }).catch(() => undefined);
    expect(await db.auditLog.count()).toBe(before);
  });
});

describe("sync outbox", () => {
  const student = { id: "11111111-1111-4111-8111-111111111111", admissionNumber: "A/1", firstName: "Chi", lastName: "Eze", gender: "FEMALE", status: "ACTIVE", version: 3, medicalNotes: "PRIVATE", address: "PRIVATE" };

  it("only allow-listed fields ever leave the school", () => {
    const p = projectForSync("student", student);
    expect(p).toMatchObject({ id: student.id, admissionNumber: "A/1", version: 3 });
    expect(p).not.toHaveProperty("medicalNotes");
    expect(p).not.toHaveProperty("address");
  });
  it("commits with the mutation and rolls back with it", async () => {
    await transact((tx) => enqueueSync(tx, "student", student));
    expect(await db.syncQueue.count()).toBe(1);
    await transact(async (tx) => {
      await enqueueSync(tx, "student", { ...student, version: 4 });
      throw new Error("mutation failed");
    }).catch(() => undefined);
    expect(await db.syncQueue.count()).toBe(1);
  });
  it("is idempotent for the same entity version", async () => {
    await transact((tx) => enqueueSync(tx, "student", student));
    await transact((tx) => enqueueSync(tx, "student", student));
    expect(await db.syncQueue.count()).toBe(1);
    const row = await db.syncQueue.findFirstOrThrow();
    expect(row.idempotencyKey).toBe(`student:${student.id}:v3:UPSERT`);
    expect(row.status).toBe("PENDING");
  });
});

describe("number sequences", () => {
  it("never repeats under concurrency", async () => {
    const nums = await Promise.all(Array.from({ length: 20 }, () => transact((tx) => nextNumber(tx, "receipt:2026"))));
    expect(new Set(nums).size).toBe(20);
    expect(Math.min(...nums)).toBe(1);
    expect(Math.max(...nums)).toBe(20);
  });
});
