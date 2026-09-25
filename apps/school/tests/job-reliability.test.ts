import { beforeEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import { db } from "@/platform/db";
import { claimJobs, enqueueJob, PermanentJobError, recoverStaleJobs, runQueueOnce, type JobHandler } from "@/platform/jobs";
import { workerStatus } from "@/platform/worker-status";
import * as reports from "@/modules/reports/service";
import * as files from "@/platform/files";
import { conflict, validation } from "@/platform/errors";
import { openFile } from "@/platform/files";
import { seedAcademics } from "./fixtures";
import { makeUser, resetDb } from "./helpers";
import { ctxFor } from "./fixtures";

let S: Awaited<ReturnType<typeof seedAcademics>>;
beforeEach(async () => {
  await rm("./.data/test-storage", { recursive: true, force: true });
  await resetDb();
  S = await seedAcademics();
});
const job = (type: string) => db.backgroundJob.findFirstOrThrow({ where: { type }, orderBy: { createdAt: "desc" } });
/** Make a queued job due now (skips the retry back-off) so a test can run the next attempt immediately. */
const makeDue = () => db.backgroundJob.updateMany({ where: { status: "QUEUED" }, data: { runAt: new Date(Date.now() - 1000) } });

describe("job queue: claiming and duplicates", () => {
  it("two workers polling at once never run the same job twice", async () => {
    for (let i = 0; i < 12; i++) await enqueueJob(db, "maintenance", "t.once", { i });
    const ran: number[] = [];
    const handler: JobHandler = async (j) => { await new Promise((r) => setTimeout(r, 5)); ran.push(j.payload.i as number); };
    await Promise.all([runQueueOnce("maintenance", "w1", { "t.once": handler }, 6), runQueueOnce("maintenance", "w2", { "t.once": handler }, 6)]);
    await runQueueOnce("maintenance", "w1", { "t.once": handler }, 12);
    expect(ran.sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(await db.backgroundJob.count({ where: { status: "SUCCEEDED" } })).toBe(12);
  });

  it("a de-duplicated job cannot be queued twice while one is waiting or running, but can be again once it finished", async () => {
    expect(await enqueueJob(db, "analytics", "t.dedupe", {}, { dedupeKey: "k" })).not.toBeNull();
    expect(await enqueueJob(db, "analytics", "t.dedupe", {}, { dedupeKey: "k" })).toBeNull();
    await runQueueOnce("analytics", "w", { "t.dedupe": async () => undefined });
    expect(await enqueueJob(db, "analytics", "t.dedupe", {}, { dedupeKey: "k" })).not.toBeNull();
  });

  it("a job is durable: it survives a 'restart' (new worker id) and runs later; future jobs are not claimed early", async () => {
    await enqueueJob(db, "reports", "t.later", {}, { runAt: new Date(Date.now() + 60_000) });
    expect(await claimJobs("reports", "w1")).toHaveLength(0);
    await db.backgroundJob.updateMany({ data: { runAt: new Date(Date.now() - 1) } });
    expect((await claimJobs("reports", "brand-new-worker-after-restart")).map((j) => j.type)).toEqual(["t.later"]);
  });
});

describe("job queue: failure, retry, dead-letter, recovery", () => {
  it("a transient failure is retried with growing back-off, then dead-lettered with its last error", async () => {
    await enqueueJob(db, "maintenance", "t.flaky", {}, { maxAttempts: 3 });
    const boom: JobHandler = async () => { throw new Error("network blip"); };
    let last = 0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(await runQueueOnce("maintenance", "w", { "t.flaky": boom })).toBe(1);
      const j = await job("t.flaky");
      expect(j.attempts).toBe(attempt);
      if (attempt < 3) {
        expect(j).toMatchObject({ status: "QUEUED", lastError: "network blip", lockedAt: null });
        expect(j.runAt.getTime()).toBeGreaterThan(Date.now()); // waits before the next try
        expect(j.runAt.getTime()).toBeGreaterThanOrEqual(last);
        last = j.runAt.getTime();
        expect(await runQueueOnce("maintenance", "w", { "t.flaky": boom })).toBe(0); // not due yet
        await makeDue();
      } else expect(j).toMatchObject({ status: "DEAD", lastError: "network blip" });
    }
    expect(await runQueueOnce("maintenance", "w", { "t.flaky": boom })).toBe(0); // dead jobs never run again by themselves
  });

  it("a failure retrying can't fix (bad input, missing record, invalid payload) goes straight to dead — no pointless retries", async () => {
    for (const [type, err] of [["t.perm", new PermanentJobError("unsupported")], ["t.valid", validation("Choose a class")], ["t.zod", (await import("zod")).z.string().safeParse(1).error!]] as const) {
      await enqueueJob(db, "maintenance", type);
      await runQueueOnce("maintenance", "w", { [type]: async () => { throw err; } });
      expect(await job(type), type).toMatchObject({ status: "DEAD", attempts: 1 });
    }
  });

  it("a conflict (409) is treated as temporary — it keeps its retries instead of being dead-lettered", async () => {
    await enqueueJob(db, "maintenance", "t.conflict", {}, { maxAttempts: 3 });
    await runQueueOnce("maintenance", "w", { "t.conflict": async () => { throw conflict("Another backup is already running"); } });
    expect(await job("t.conflict")).toMatchObject({ status: "QUEUED", attempts: 1 });
  });

  it("a job with no registered handler fails visibly instead of vanishing", async () => {
    await enqueueJob(db, "maintenance", "t.unknown", {}, { maxAttempts: 1 });
    await runQueueOnce("maintenance", "w", {});
    expect(await job("t.unknown")).toMatchObject({ status: "DEAD", lastError: expect.stringContaining('No handler registered for job type "t.unknown"') });
  });

  it("a job whose worker died mid-run is returned to the queue and finishes on the next worker", async () => {
    await enqueueJob(db, "maintenance", "t.crash");
    await claimJobs("maintenance", "worker-that-died"); // claimed, never completed
    expect((await job("t.crash")).status).toBe("RUNNING");
    expect(await recoverStaleJobs(15)).toBe(0); // recently locked: leave it alone
    await db.backgroundJob.updateMany({ data: { lockedAt: new Date(Date.now() - 20 * 60_000) } });
    expect(await recoverStaleJobs(15)).toBe(1);
    expect(await runQueueOnce("maintenance", "w2", { "t.crash": async () => undefined })).toBe(1);
    expect((await job("t.crash")).status).toBe("SUCCEEDED");
  });
});

describe("worker liveness is reported truthfully", () => {
  it("no worker rows, a fresh beat, a stale beat and a stopped worker", async () => {
    expect(await workerStatus()).toMatchObject({ alive: false, workers: [] });
    await db.workerHeartbeat.create({ data: { name: "w1", lastBeatAt: new Date() } });
    expect((await workerStatus()).alive).toBe(true);
    await db.workerHeartbeat.update({ where: { name: "w1" }, data: { lastBeatAt: new Date(Date.now() - 5 * 60_000) } });
    expect(await workerStatus()).toMatchObject({ alive: false, workers: [expect.objectContaining({ name: "w1", alive: false })] });
    await db.workerHeartbeat.update({ where: { name: "w1" }, data: { lastBeatAt: new Date(), status: "STOPPED" } });
    expect((await workerStatus()).alive).toBe(false);
  });
});

describe("report pipeline: request → job → worker → file → authorised download, and honest failure", () => {
  const handlers = reports.reportJobHandlers as never as Record<string, JobHandler>;
  const run = () => runQueueOnce("reports", "w", handlers);

  it("completes: QUEUED → SUCCEEDED with a stored file only the requester can open", async () => {
    const t = await makeUser({ username: "teach1", roles: ["teacher"] }); void t;
    const teacher = await ctxFor("teach1", "Passw0rd-test");
    const exp = await reports.requestReport(teacher, { kind: "STUDENT_LIST", format: "XLSX", params: {} });
    expect(exp.status).toBe("QUEUED");
    expect(await db.backgroundJob.count({ where: { queue: "reports", status: "QUEUED" } })).toBe(1);
    await run();
    const done = await reports.getExport(teacher, exp.id);
    expect(done).toMatchObject({ status: "SUCCEEDED", error: null });
    expect(done.fileId).toBeTruthy();
    const file = await openFile(teacher, done.fileId!);
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).subarray(0, 2).toString()).toBe("PK"); // a real .xlsx
    await makeUser({ username: "other1", roles: ["teacher"] });
    await expect(reports.getExport(await ctxFor("other1", "Passw0rd-test"), exp.id)).rejects.toThrow(/not found/i); // not someone else's
    await expect(openFile(await ctxFor("other1", "Passw0rd-test"), done.fileId!)).rejects.toThrow();
  });

  it("running the same job twice does not produce a second file (idempotent)", async () => {
    const exp = await reports.requestReport(S.admin, { kind: "STUDENT_LIST", format: "CSV", params: {} });
    await run();
    const first = (await reports.getExport(S.admin, exp.id)).fileId;
    await reports.generateReport(exp.id);
    expect((await reports.getExport(S.admin, exp.id)).fileId).toBe(first);
    expect(await db.fileAsset.count({ where: { ownerType: "REPORT", ownerId: exp.id } })).toBe(1);
  });

  it("a request that can never succeed FAILS at once with a plain-language reason (never stuck queued)", async () => {
    const term = await db.term.findFirstOrThrow();
    const exp = await reports.requestReport(S.admin, { kind: "REPORT_CARD", format: "PDF", params: { termId: term.id, classId: S.jss1.id } });
    await run();
    expect(await reports.getExport(S.admin, exp.id)).toMatchObject({ status: "FAILED", error: "There are no report cards to print for that selection", fileId: null });
    expect(await job("report.generate")).toMatchObject({ status: "DEAD", attempts: 1 });
  });

  it("bad report options fail with a readable reason, not a raw validation dump", async () => {
    const exp = await db.reportExport.create({ data: { kind: "ATTENDANCE", format: "PDF", params: { classId: "not-a-uuid" }, requestedById: (await db.user.findFirstOrThrow({ where: { isPrimaryAdmin: true } })).id } });
    await enqueueJob(db, "reports", "report.generate", { exportId: exp.id });
    await run();
    const failed = await reports.getExport(S.admin, exp.id);
    expect(failed.status).toBe("FAILED");
    expect(failed.error).toMatch(/^The report options are not valid: /);
    expect(failed.error).not.toContain("[");
  });

  it("a temporary fault shows 'will retry' (QUEUED + reason), then completes when the fault clears; it only becomes FAILED when attempts run out", async () => {
    const spy = vi.spyOn(files, "saveUpload").mockRejectedValue(new Error("disk full"));
    try {
      const exp = await reports.requestReport(S.admin, { kind: "STUDENT_LIST", format: "CSV", params: {} });
      await db.backgroundJob.updateMany({ data: { maxAttempts: 2 } });
      await run();
      expect(await reports.getExport(S.admin, exp.id)).toMatchObject({ status: "QUEUED", error: expect.stringContaining("Will retry") });
      await makeDue(); spy.mockRestore();
      await run();
      expect(await reports.getExport(S.admin, exp.id)).toMatchObject({ status: "SUCCEEDED", error: null });

      const spy2 = vi.spyOn(files, "saveUpload").mockRejectedValue(new Error("disk full"));
      const exp2 = await reports.requestReport(S.admin, { kind: "STUDENT_LIST", format: "CSV", params: {} });
      await db.backgroundJob.updateMany({ where: { status: "QUEUED" }, data: { maxAttempts: 2 } });
      await run(); await makeDue(); await run();
      const failed = await reports.getExport(S.admin, exp2.id);
      expect(failed).toMatchObject({ status: "FAILED" });
      expect(failed.error).toContain("disk full");
      spy2.mockRestore();
    } finally { spy.mockRestore(); }
  });
});
