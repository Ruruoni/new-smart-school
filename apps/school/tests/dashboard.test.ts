import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/platform/db";
import { dashboardOverview } from "@/modules/analytics/overview";
import * as people from "@/modules/people/service";
import { ctxFor, seedAcademics } from "./fixtures";
import { makeUser, resetDb } from "./helpers";

let S: Awaited<ReturnType<typeof seedAcademics>>;
beforeEach(async () => { await resetDb(); S = await seedAcademics(); });
const keys = async (ctx = S.admin) => (await dashboardOverview(ctx)).attention.map((a) => a.key);

async function overdueInvoice() {
  const st = await people.createStudent(S.admin, { firstName: "Debtor", lastName: "One", gender: "MALE", classId: S.jss1.id });
  const term = await db.term.findFirstOrThrow({ where: { isCurrent: true } });
  return db.invoice.create({ data: { number: `INV/T/${Math.random().toString(36).slice(2, 8)}`, studentId: st.student.id, termId: term.id, status: "ISSUED", issuedAt: new Date(), dueDate: new Date("2020-01-01"), subtotal: 50000, total: 50000 } });
}

describe("dashboard overview is live and honest", () => {
  it("tells the administrator when the background worker is not running, and stops when it is", async () => {
    const first = await dashboardOverview(S.admin);
    expect(first.system!.worker.alive).toBe(false);
    expect(first.attention[0]).toMatchObject({ key: "worker", tone: "bad" });
    await db.workerHeartbeat.create({ data: { name: "w1", lastBeatAt: new Date() } });
    const second = await dashboardOverview(S.admin);
    expect(second.system!.worker.alive).toBe(true);
    expect((await keys())).not.toContain("worker");
  });

  it("every figure is fresh on each request — no snapshot delay", async () => {
    expect(await keys()).not.toContain("overdue");
    const inv = await overdueInvoice();
    expect(await keys()).toContain("overdue"); // immediately
    expect((await dashboardOverview(S.admin)).attention.find((a) => a.key === "overdue")!.count).toBe(1);
    await db.invoice.update({ where: { id: inv.id }, data: { status: "PAID", amountPaid: 50000 } });
    expect(await keys()).not.toContain("overdue");

    await db.notificationDelivery.create({ data: { channel: "SMS", recipient: "08031234567", body: "x", status: "DEAD" } });
    expect((await dashboardOverview(S.admin)).attention.find((a) => a.key === "messages")!.count).toBe(1);
    expect((await dashboardOverview(S.admin)).system!.messages.failed).toBe(1);
  });

  it("reports queue and backup state from the real tables", async () => {
    expect((await keys())).toContain("backup"); // never backed up
    await db.backgroundJob.createMany({ data: [{ queue: "reports", type: "a" }, { queue: "reports", type: "b", status: "DEAD" }] });
    const o = await dashboardOverview(S.admin);
    expect(o.system!.jobs).toEqual({ waiting: 1, running: 0, failed: 1 });
    await db.backupRecord.create({ data: { kind: "LOCAL", status: "SUCCEEDED", startedAt: new Date(), finishedAt: new Date() } });
    expect(await keys()).not.toContain("backup");
  });

  it("each role sees only what it may — the server filters, not the page", async () => {
    await overdueInvoice();
    await db.notificationDelivery.create({ data: { channel: "SMS", recipient: "0803", body: "x", status: "FAILED" } });
    await makeUser({ username: "reg", roles: ["registrar"] });
    await makeUser({ username: "teach", roles: ["teacher"] });
    const reg = await dashboardOverview(await ctxFor("reg", "Passw0rd-test"));
    expect(reg.system).toBeNull();           // no licence/sync permission
    expect(reg.activity).toBeNull();         // no audit permission
    expect(reg.attention.map((a) => a.key)).not.toEqual(expect.arrayContaining(["overdue", "messages", "worker"]));
    const teacher = await dashboardOverview(await ctxFor("teach", "Passw0rd-test"));
    expect(teacher.system).toBeNull();
    expect(teacher.activity).toBeNull();
    expect(teacher.attention.map((a) => a.key)).not.toContain("overdue");
    const admin = await dashboardOverview(S.admin);
    expect(admin.activity!.length).toBeGreaterThan(0);
    expect(JSON.stringify(admin)).not.toMatch(/passwordHash|token|secret/i);
  });

  it("a disabled module disappears from the dashboard even for the administrator", async () => {
    await overdueInvoice();
    expect(await keys()).toContain("overdue");
    await db.moduleSetting.upsert({ where: { moduleKey: "finance" }, create: { moduleKey: "finance", enabled: false }, update: { enabled: false } });
    expect(await keys()).not.toContain("overdue");
  });
});
