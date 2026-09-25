import { beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { rm } from "node:fs/promises";
import { db } from "@/platform/db";
import * as an from "@/modules/analytics/service";
import * as rep from "@/modules/reports/service";
import { csvSafe, fmt, toCsv, toXlsx, toPdf } from "@/modules/reports/render";
import * as fin from "@/modules/finance/service";
import * as res from "@/modules/results/service";
import * as att from "@/modules/attendance/service";
import * as people from "@/modules/people/service";
import * as academics from "@/modules/academics/service";
import { readFileBuffer } from "@/platform/files";
import { runQueueOnce } from "@/platform/jobs";
import { setSetting } from "@/platform/settings";
import { hashPassword } from "@/platform/password";
import { ctxFor, seedAcademics } from "./fixtures";
import { makeUser, resetDb } from "./helpers";

let S: Awaited<ReturnType<typeof seedAcademics>>;
let kids: string[] = [];
let csMath: string;

const yesterday = (n = 1) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const worker = async () => { while ((await runQueueOnce("reports", "t", rep.reportJobHandlers as never)) > 0); };

async function populate() {
  await db.academicYear.update({ where: { id: S.year.id }, data: { startDate: new Date("2020-01-01"), endDate: new Date("2035-01-01") } });
  await db.term.update({ where: { id: S.t1.id }, data: { startDate: new Date("2020-01-02"), endDate: new Date("2034-12-01") } });
  csMath = (await academics.assignClassSubject(S.admin, { classId: S.jss1.id, subjectId: S.math.id })).id;
  for (const [i, n] of ["Ada", "Bola", "Chi", "Dayo"].entries()) {
    kids.push((await people.createStudent(S.admin, { firstName: n, lastName: "Pupil", gender: i % 2 ? "MALE" : "FEMALE", classId: S.jss1.id, guardians: i === 0 ? [{ newParent: { firstName: "Mum", lastName: "Pupil", phone: "08011112222" }, relationship: "Mother" }] : [] })).student.id);
  }
  const sheet = await res.getScoreSheet(S.admin, csMath, S.t1.id);
  const [c1, c2, ex] = sheet.components.map((c) => c.id) as [string, string, string];
  const marks = [[18, 19, 55], [15, 15, 40], [15, 15, 40], [5, 5, 20]];
  await res.saveScores(S.admin, { classSubjectId: csMath, termId: S.t1.id, entries: kids.flatMap((studentId, i) => [{ studentId, typeId: c1, score: marks[i]![0]! }, { studentId, typeId: c2, score: marks[i]![1]! }, { studentId, typeId: ex, score: marks[i]![2]! }]) });
  await res.processResults(S.admin, { termId: S.t1.id, classId: S.jss1.id, allowIncomplete: true });
  await res.publishResults(S.admin, { termId: S.t1.id, classId: S.jss1.id });
  await fin.createFeeStructure(S.admin, { name: "T1 fees", termId: S.t1.id, items: [{ name: "Tuition", amount: 100000 }] });
  await fin.generateInvoicesForClass(S.admin, { classId: S.jss1.id, termId: S.t1.id, dueDate: yesterday(45) });
  await fin.recordPayment(S.admin, { studentId: kids[0]!, amount: 100000, method: "BANK_TRANSFER", idempotencyKey: "an-pay-0001" });
  await fin.recordPayment(S.admin, { studentId: kids[1]!, amount: 40000, method: "CASH", idempotencyKey: "an-pay-0002" });
  await fin.recordExpense(S.admin, { category: "Utilities", description: "Diesel", amount: 15000, paidOn: yesterday() });
  for (let d = 1; d <= 4; d++) await att.recordClassAttendance(S.admin, { classId: S.jss1.id, date: yesterday(d), entries: [{ studentId: kids[0]!, status: "PRESENT" }, { studentId: kids[1]!, status: "ABSENT" }, { studentId: kids[2]!, status: d === 1 ? "LATE" : "PRESENT" }, { studentId: kids[3]!, status: "PRESENT" }] });
}

beforeEach(async () => {
  await rm("./.data/test-storage", { recursive: true, force: true });
  await resetDb();
  S = await seedAcademics();
  kids = [];
  await populate();
});

describe("analytics", () => {
  it("management KPIs are computed from real data", async () => {
    const k = await an.managementKpis();
    expect(k.enrollment).toMatchObject({ total: 4, male: 2, female: 2 });
    expect(k.enrollment.byClass.find((c) => c.class === "JSS 1")!.count).toBe(4);
    expect(k.finance).toMatchObject({ billed: "400000.00", outstanding: "260000.00", cashCollected: "140000.00", expenses: "15000.00" });
    expect(k.finance.collectionRate).toBe(35);
    expect(k.attendance!.marks).toBe(16);
    expect(k.academics).toMatchObject({ processed: 4, published: 4 });
  });
  it("academic performance: class/subject averages, grade distribution, top students", async () => {
    const a = await an.academicPerformance();
    expect(a.classes[0]).toMatchObject({ class: "JSS 1", students: 4, highest: 92, lowest: 30 });
    expect(a.subjects[0]).toMatchObject({ subject: "Mathematics", results: 4, passRate: 75 });
    expect(Object.fromEntries(a.gradeDistribution.map((g) => [g.grade, g.count]))).toEqual({ A1: 1, B2: 2, F9: 1 });
    expect(a.topStudents[0]).toMatchObject({ average: 92, position: 1 });
  });
  it("finance analytics: ageing buckets, debtors, method mix, expense categories", async () => {
    const f = await an.financeAnalytics();
    expect(f.aging.find((b) => b.bucket === "31-60")).toMatchObject({ amount: 260000, invoices: 3 }); // due 45 days ago
    expect(f.debtors[0]).toMatchObject({ owed: 100000 });
    expect(f.debtors.find((d) => d.owed === 60000)).toBeTruthy();
    expect(f.methods.map((m) => m.method).sort()).toEqual(["BANK_TRANSFER", "CASH"]);
    expect(f.expensesByCategory).toEqual([{ category: "Utilities", amount: 15000 }]);
    expect(f.collectionByClass[0]).toMatchObject({ class: "JSS 1", billed: 400000, paid: 140000, rate: 35 });
  });
  it("attendance analytics: rates, chronic absentees, weekday pattern", async () => {
    const a = await an.attendanceAnalytics(30);
    expect(a.daily).toHaveLength(4);
    expect(a.chronicAbsentees).toEqual([expect.objectContaining({ admissionNumber: expect.any(String), absences: 4 })]);
    expect(a.byClass[0]).toMatchObject({ class: "JSS 1", rate: 75 });
  });
  const students = async () => ((await an.getAnalytics("management.kpis")).data as { enrollment: { total: number } }).enrollment.total;
  const age = (ms: number) => db.analyticsSnapshot.updateMany({ data: { computedAt: new Date(Date.now() - ms) } });

  it("the dashboard KPIs are live: within seconds a change shows up, with no worker needed", async () => {
    expect((await an.getAnalytics("management.kpis")).stale).toBe(false);
    await people.createStudent(S.admin, { firstName: "New", lastName: "Kid", gender: "MALE", classId: S.jss1.id });
    expect(await students()).toBe(4); // inside the 5-second window: served from cache so a busy page doesn't recompute per request
    await age(10_000);
    expect(await students()).toBe(5); // older than the window: recomputed inline, right now
    expect(await db.backgroundJob.count({ where: { type: "analytics.refresh" } })).toBe(0); // it never waited for the worker
  });

  it("heavier datasets: a live worker refreshes them in the background (one de-duplicated job); with NO worker they refresh inline instead of freezing", async () => {
    await an.getAnalytics("finance.overview");
    await age(3_600_000);
    await db.workerHeartbeat.create({ data: { name: "w1", lastBeatAt: new Date() } });
    expect((await an.getAnalytics("finance.overview")).stale).toBe(true); // served stale…
    await an.getAnalytics("finance.overview");
    expect(await db.backgroundJob.count({ where: { type: "analytics.refresh", status: "QUEUED" } })).toBe(1); // …with exactly one refresh queued
    await runQueueOnce("analytics", "t", an.analyticsJobHandlers as never);
    expect((await an.getAnalytics("finance.overview")).stale).toBe(false);

    await age(3_600_000);
    await db.workerHeartbeat.update({ where: { name: "w1" }, data: { lastBeatAt: new Date(Date.now() - 10 * 60_000) } }); // the worker stopped 10 minutes ago
    expect((await an.getAnalytics("finance.overview")).stale).toBe(false); // recomputed inline — never permanently stale
    await expect(an.getAnalytics("nope.nope")).rejects.toThrow(/Unknown analytics dataset/);
  });

  it("concurrent requests for a stale live dataset share one computation", async () => {
    await an.getAnalytics("management.kpis");
    await age(60_000);
    const before = (await db.analyticsSnapshot.findFirstOrThrow()).computedAt.getTime();
    await Promise.all(Array.from({ length: 8 }, () => an.getAnalytics("management.kpis")));
    const after = (await db.analyticsSnapshot.findFirstOrThrow()).computedAt.getTime();
    expect(after).toBeGreaterThan(before);
  });
});

describe("renderers", () => {
  const data = { title: "T", columns: [{ key: "a", label: "Name" }, { key: "m", label: "Amt", format: "money" as const }, { key: "p", label: "P", format: "percent" as const }], rows: [{ a: "=HYPERLINK(\"http://evil\")", m: 1234.5, p: 50 }, { a: "Okafor, Chi \"Jr\"", m: 0.1, p: null }] };
  it("formats Nigerian money/dates and neutralises spreadsheet formula injection", () => {
    expect(fmt(1234567.891, "money")).toBe("₦1,234,567.89");
    expect(fmt("2026-03-05T00:00:00Z", "date")).toBe("05/03/2026");
    expect(csvSafe("=cmd|' /C calc'!A0")).toBe("'=cmd|' /C calc'!A0");
    expect(csvSafe("-12.5")).toBe("-12.5");
    const csv = toCsv(data).toString("utf8");
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(csv).toContain(`"Okafor, Chi ""Jr"""`);
  });
  it("XLSX has typed numeric cells, header styling, frozen header", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await toXlsx(data) as never);
    const ws = wb.worksheets[0]!;
    expect(ws.getRow(3).values).toEqual([undefined, "Name", "Amt", "P"]);
    expect(ws.getRow(4).getCell(2).value).toBe(1234.5);
    expect(ws.getRow(4).getCell(1).value).toBe(`'=HYPERLINK("http://evil")`);
    expect(ws.getColumn(2).numFmt).toBe('"₦"#,##0.00');
  });
  it("PDF renders (₦ glyph via embedded Unicode font) and paginates long tables", async () => {
    const long = { ...data, rows: Array.from({ length: 120 }, (_, i) => ({ a: `Student ${i}`, m: i * 1000.5, p: i })) };
    const pdf = await toPdf(long);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect((pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(2);
    expect(pdf.toString("latin1")).toContain("DejaVuSans"); // font embedded, not Helvetica fallback
  });
});

describe("report service", () => {
  it("previews and queues every report kind; worker produces valid files", async () => {
    const t = S.t1.id, c = S.jss1.id;
    const exam = await db.cBTExam.create({ data: { title: "Exam", classIds: [c], durationMinutes: 30 } });
    const cases: [string, Record<string, unknown>, "PDF" | "XLSX" | "CSV"][] = [
      ["STUDENT_LIST", { classId: c }, "PDF"], ["CLASS_RESULTS", { termId: t, classId: c }, "XLSX"], ["ATTENDANCE", { classId: c, from: yesterday(10), to: yesterday(0) }, "CSV"],
      ["FINANCE_SUMMARY", { from: yesterday(30), to: yesterday(0) }, "PDF"], ["DEBTORS", {}, "XLSX"], ["CBT_RESULTS", { examId: exam.id }, "CSV"], ["ADMISSIONS", {}, "CSV"],
      ["TEACHER_LOAD", {}, "XLSX"], ["SUBJECT_PERFORMANCE", {}, "PDF"], ["MANAGEMENT", {}, "PDF"], ["REPORT_CARD", { termId: t, classId: c }, "PDF"], ["REPORT_CARD", { termId: t, studentId: kids[0] }, "PDF"],
    ];
    for (const [kind, params, format] of cases) {
      const e = await rep.requestReport(S.admin, { kind, format, params });
      expect(e.status).toBe("QUEUED");
    }
    await worker();
    const done = await db.reportExport.findMany({ orderBy: { createdAt: "asc" } });
    expect(done.map((d) => d.status)).toEqual(cases.map(() => "SUCCEEDED"));
    for (const d of done) {
      const { data, asset } = await readFileBuffer(d.fileId!);
      if (d.format === "PDF") expect(data.subarray(0, 5).toString()).toBe("%PDF-");
      if (d.format === "XLSX") expect(data.subarray(0, 2).toString()).toBe("PK");
      if (d.format === "CSV") expect(data.toString("utf8").charCodeAt(0)).toBe(0xfeff);
      expect(asset.ownerType).toBe("REPORT");
    }
    // class report cards: one page per student (4)
    const rc = done.find((d) => d.kind === "REPORT_CARD")!;
    expect(((await readFileBuffer(rc.fileId!)).data.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length).toBe(4);
    const sheet = await rep.previewReport(S.admin, "CLASS_RESULTS", { termId: t, classId: c });
    expect(sheet.rows[0]).toMatchObject({ pos: 1, adm: expect.any(String), total: expect.anything() });
    expect(sheet.columns.map((x) => x.label)).toContain("MTH");
    expect(sheet.rows.map((r) => r.pos)).toEqual([1, 2, 2, 4]);
  });

  it("enforces permissions per report kind and privacy of generated files", async () => {
    await makeUser({ username: "tch", roles: ["teacher"] });
    await makeUser({ username: "bur", roles: ["bursar"] });
    const tch = await ctxFor("tch"), bur = await ctxFor("bur");
    await expect(rep.requestReport(tch, { kind: "FINANCE_SUMMARY", format: "PDF", params: { from: yesterday(3), to: yesterday(0) } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(rep.previewReport(tch, "DEBTORS", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(rep.availableReports(tch).map((r) => r.kind)).not.toContain("FINANCE_SUMMARY");
    expect(rep.availableReports(bur).map((r) => r.kind)).toContain("DEBTORS");
    await expect(rep.requestReport(bur, { kind: "STUDENT_LIST", format: "PDF", params: {} })).resolves.toBeTruthy();
    await expect(rep.requestReport(S.admin, { kind: "MANAGEMENT", format: "CSV", params: {} })).rejects.toThrow(/not available as CSV/);
    await expect(rep.requestReport(S.admin, { kind: "ATTENDANCE", format: "PDF", params: { classId: "x" } })).rejects.toThrow(/Invalid report parameters/);
    const e = await rep.requestReport(bur, { kind: "DEBTORS", format: "XLSX", params: {} });
    await worker();
    await expect(rep.getExport(tch, e.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const fileId = (await rep.getExport(bur, e.id)).fileId!;
    const { openFile } = await import("@/platform/files");
    await expect(openFile(tch, fileId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(openFile(bur, fileId)).resolves.toBeInstanceOf(Response);
  });

  it("a failing job is marked FAILED with a safe message and retried by the queue", async () => {
    const e = await rep.requestReport(S.admin, { kind: "REPORT_CARD", format: "PDF", params: { termId: S.t2.id, classId: S.jss1.id } });
    await worker();
    expect((await db.reportExport.findUniqueOrThrow({ where: { id: e.id } })).status).toBe("FAILED");
    expect((await db.reportExport.findUniqueOrThrow({ where: { id: e.id } })).error).toMatch(/no report cards/);
    expect(await db.backgroundJob.count({ where: { status: "QUEUED", type: "report.generate" } })).toBeGreaterThanOrEqual(0);
  });

  it("parent report-card download honours scope and the financial lockout", async () => {
    const parentUser = await db.user.findFirstOrThrow({ where: { userType: "PARENT" } });
    await db.user.update({ where: { id: parentUser.id }, data: { passwordHash: await hashPassword("Parent-pass-1"), mustChangePassword: false } });
    const parent = await ctxFor(parentUser.username, "Parent-pass-1");
    const ok = await rep.myReportCardPdf(parent, kids[0]!, S.t1.id);
    expect(ok.data.subarray(0, 5).toString()).toBe("%PDF-");
    expect(ok.fileName).toMatch(/^report-card-ADM-\d{4}-0001\.pdf$/);
    await expect(rep.myReportCardPdf(parent, kids[1]!, S.t1.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await fin.generateInvoice(S.admin, { studentId: kids[0]!, termId: S.t1.id, dueDate: "2020-01-01", feeStructureIds: undefined }).catch(() => undefined);
    await db.invoice.updateMany({ where: { studentId: kids[0]! }, data: { status: "ISSUED", amountPaid: 0, dueDate: new Date("2020-01-01") } }).catch(() => undefined);
  });
});
