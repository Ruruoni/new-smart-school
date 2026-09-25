import { beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { rm } from "node:fs/promises";
import { db } from "@/platform/db";
import * as imp from "@/modules/imports/service";
import { mapHeaders, parseCsv, cellToString } from "@/modules/imports/parse";
import { studentsKind, normalisePhoneCell } from "@/modules/imports/kinds";
import { runQueueOnce } from "@/platform/jobs";
import { readFileBuffer } from "@/platform/files";
import { verifyPassword } from "@/platform/password";
import * as people from "@/modules/people/service";
import * as bank from "@/modules/cbt/bank";
import { ctxFor, seedAcademics } from "./fixtures";
import { makeUser, resetDb } from "./helpers";

let S: Awaited<ReturnType<typeof seedAcademics>>;

async function xlsx(headers: string[], rows: (string | number | Date | null)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const H = ["First name", "Last name", "Gender", "Date of birth", "Class", "Section", "Guardian name", "Guardian phone", "Guardian email", "Relationship", "Create student login", "Password", "Admission number"];
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const upload = (ctx: typeof S.admin, kind: string, data: Buffer, name = "students.xlsx") => imp.startImport(ctx, kind, { data, originalName: name, declaredMime: XLSX_MIME });
const workers = async () => { while ((await runQueueOnce("imports", "test", imp.importJobHandlers as never)) > 0); };

beforeEach(async () => {
  await resetDb();
  await rm("./.data/test-storage", { recursive: true, force: true });
  S = await seedAcademics();
});

describe("parsing helpers", () => {
  it("maps messy headers onto canonical columns and reports missing required ones", () => {
    const r = mapHeaders(studentsKind.columns, ["FIRST NAME *", "Surname", "sex", "Class", "DOB", "Favourite colour"]);
    expect([...r.map.values()].sort()).toEqual(["className", "dateOfBirth", "firstName", "gender", "lastName"]);
    expect(r.unknown).toEqual(["Favourite colour"]);
    expect(mapHeaders(studentsKind.columns, ["First name"]).missing).toEqual(["Last name", "Gender", "Class"]);
  });
  it("CSV: quotes, embedded commas/newlines, BOM, CRLF", () => {
    const s = parseCsv('﻿Name,Note\r\n"Okafor, Chi","line1\nline2"\r\nAda,"say ""hi"""\r\n');
    expect(s.rows.map((r) => r.cells)).toEqual([{ Name: "Okafor, Chi", Note: "line1\nline2" }, { Name: "Ada", Note: 'say "hi"' }]);
  });
  it("restores leading zeros dropped by Excel and normalises +234", () => {
    expect(normalisePhoneCell("8031234567")).toBe("08031234567");
    expect(normalisePhoneCell("+234 803 123 4567")).toBe("08031234567");
    expect(normalisePhoneCell("12345")).toBeNull();
    expect(cellToString({ richText: [{ text: "A" }, { text: "b" }] } as never)).toBe("Ab");
    expect(cellToString({ formula: "1+1", result: 2 } as never)).toBe("2");
  });
  it("the downloadable template round-trips through our own parser", async () => {
    const { data } = await imp.importTemplate("STUDENTS");
    const job = await upload(S.admin, "STUDENTS", data);
    await workers();
    const after = await db.importJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe("PREVIEW"); // the sample row has an unknown class ("JSS 1" exists) — parsed without header problems
  });
});

describe("students import pipeline", () => {
  const good = (n: string, extra: Partial<Record<string, string | number>> = {}) => [n, "Okafor", "Female", "2014-05-12", "JSS 1", "A", "Ngozi Okafor", 8031234567, `${n.toLowerCase()}@example.com`, "Mother", "no", null, null].map((v, i) => (extra[H[i]!] !== undefined ? extra[H[i]!]! : v)) as (string | number | null)[];

  it("upload → parse → preview → approve → commit, with a precise row-level report", async () => {
    const data = await xlsx(H, [
      good("Chidinma"),                                                  // 2 valid; phone stored as number (leading zero lost)
      good("Amaka", { "Guardian phone": 8031234567, "Date of birth": "2013-01-01" }), // 3 valid, sibling shares the parent (same phone)
      good("Bad", { Gender: "Robot" }),                                  // 4 gender
      good("NoClass", { Class: "JSS 9" }),                               // 5 class
      good("FutureKid", { "Date of birth": "2999-01-01" }),              // 6 dob
      good("NoPhone", { "Guardian phone": "" }),                         // 7 guardian phone missing
      good("Chidinma"),                                                  // 8 duplicate in file (same name+dob)
      good("WeakPw", { "Create student login": "yes", Password: "abc" }), // 9 weak password
      good("Login", { "Create student login": "yes", Password: "Sup3r-secret-pass" }), // 10 valid with own password
      good("Autogen", { "Create student login": "yes", Class: "JSS 1", "Admission number": "OLD/2019/007" }), // 11 valid, generated password, own adm number
    ]);
    const job = await upload(S.admin, "STUDENTS", data);
    await workers();
    const preview = await imp.getPreview(S.admin, job.id);
    expect(preview.job).toMatchObject({ status: "PREVIEW", totalRows: 10, validRows: 4, errorRows: 5, duplicateRows: 1 });
    expect(await db.studentProfile.count()).toBe(0); // nothing committed at preview
    const byRow = new Map(preview.errors.map((e) => [e.rowNumber, e]));
    expect(byRow.get(4)).toMatchObject({ field: "gender", code: "INVALID" });
    expect(byRow.get(5)).toMatchObject({ code: "UNKNOWN_CLASS" });
    expect(byRow.get(6)).toMatchObject({ code: "FUTURE_DATE" });
    expect(byRow.get(7)).toMatchObject({ field: "guardianPhone", code: "REQUIRED" });
    expect(byRow.get(8)).toMatchObject({ code: "DUPLICATE_IN_FILE", message: "Same as row 2 in this file" });
    expect(byRow.get(9)).toMatchObject({ code: "WEAK_PASSWORD" });

    await expect(imp.approveImport(S.admin, job.id, { skipInvalidRows: false })).rejects.toThrow(/Some rows are invalid/);
    await imp.approveImport(S.admin, job.id, { skipInvalidRows: true });
    await expect(imp.approveImport(S.admin, job.id, { skipInvalidRows: true })).rejects.toThrow(/cannot be approved/); // no double approval
    await workers();

    const done = await db.importJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(done).toMatchObject({ status: "COMPLETED", importedRows: 4 });
    const students = await db.studentProfile.findMany({ include: { enrollments: true, guardians: true, user: true }, orderBy: { createdAt: "asc" } });
    expect(students.map((s) => s.firstName).sort()).toEqual(["Amaka", "Autogen", "Chidinma", "Login"]);
    expect(students.every((s) => s.enrollments.length === 1)).toBe(true);
    // siblings share ONE parent account keyed by phone (leading zero restored)
    expect(await db.parentProfile.count()).toBe(1);
    expect((await db.parentProfile.findFirstOrThrow()).phone).toBe("08031234567");
    expect(students.every((s) => s.guardians[0]!.isPrimary)).toBe(true);
    // custom admission number kept; others generated
    expect(students.find((s) => s.firstName === "Autogen")!.admissionNumber).toBe("OLD/2019/007");
    // passwords: supplied one is argon2-hashed and works; generated one lands only in the credentials file
    students.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const login = students.find((s) => s.firstName === "Login")!.user!;
    expect(login.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(login.passwordHash, "Sup3r-secret-pass")).toBe(true);
    const report = done.report as { credentialsFileId: string };
    const { data: csv } = await readFileBuffer(report.credentialsFileId);
    const text = csv.toString("utf8");
    expect(text).toContain("Autogen Okafor");
    expect(text).toMatch(/"Student"/);
    // the new parent account (one, shared by the siblings) gets its first password in the same file
    expect(text.match(/"Parent"/g)).toHaveLength(1);
    const parentUser = await db.user.findFirstOrThrow({ where: { userType: "PARENT" } });
    expect(text).toContain(`"${parentUser.username}"`);
    expect(text).not.toContain("Sup3r-secret-pass"); // a password the admin supplied is never echoed back
    // audit + row statuses
    expect(await db.auditLog.count({ where: { action: "import.complete" } })).toBe(1);
    expect(await db.importRow.count({ where: { jobId: job.id, status: "IMPORTED" } })).toBe(4);
  });

  it("flags rows that already exist in the database", async () => {
    await people.createStudent(S.admin, { firstName: "Chidinma", lastName: "Okafor", gender: "FEMALE", dateOfBirth: "2014-05-12", classId: S.jss1.id });
    await people.createStudent(S.admin, { firstName: "Old", lastName: "Kid", gender: "MALE", admissionNumber: "ADM/TAKEN/1" });
    const job = await upload(S.admin, "STUDENTS", await xlsx(H, [good("Chidinma"), good("Fresh", { "Admission number": "ADM/TAKEN/1" })]));
    await workers();
    const p = await imp.getPreview(S.admin, job.id);
    expect(p.job).toMatchObject({ validRows: 0, duplicateRows: 2 });
    expect(p.errors.map((e) => e.code)).toEqual(["DUPLICATE_EXISTING", "DUPLICATE_EXISTING"]);
    await expect(imp.approveImport(S.admin, job.id, { skipInvalidRows: true })).rejects.toThrow(/no valid rows/);
  });

  it("a row that fails at commit time is reported without losing the rest (savepoints)", async () => {
    const job = await upload(S.admin, "STUDENTS", await xlsx(H, [good("First", { "Admission number": "X/1" }), good("Second", { "Admission number": "X/2" }), good("Third", { "Admission number": "X/3" })]));
    await workers();
    await people.createStudent(S.admin, { firstName: "Race", lastName: "Winner", gender: "MALE", admissionNumber: "X/2" }); // grabs the number after the preview
    await imp.approveImport(S.admin, job.id, { skipInvalidRows: false });
    await workers();
    const done = await db.importJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(done).toMatchObject({ status: "COMPLETED", importedRows: 2, errorRows: 1 });
    expect((await db.importRowError.findFirstOrThrow({ where: { jobId: job.id } }))).toMatchObject({ rowNumber: 3, code: "COMMIT_FAILED" });
    expect(await db.studentProfile.count({ where: { admissionNumber: { in: ["X/1", "X/3"] } } })).toBe(2);
    expect(await db.studentProfile.count({ where: { firstName: "Second" } })).toBe(0); // no half-created row
    expect(await db.parentProfile.count()).toBe(1); // guardian of the failed row was rolled back with it (shared phone → one parent from the others)
  });

  it("commit is idempotent and a second run does nothing", async () => {
    const job = await upload(S.admin, "STUDENTS", await xlsx(H, [good("Solo")]));
    await workers();
    await imp.approveImport(S.admin, job.id, { skipInvalidRows: false });
    await workers();
    await imp.commitImport(job.id);
    await imp.commitImport(job.id);
    expect(await db.studentProfile.count()).toBe(1);
  });

  it("rejects bad uploads early and explains missing columns", async () => {
    await expect(upload(S.admin, "STUDENTS", Buffer.from("MZ....not a spreadsheet"), "evil.xlsx")).rejects.toMatchObject({ code: "FILE_TYPE_NOT_ALLOWED" });
    const noCols = await upload(S.admin, "STUDENTS", await xlsx(["First name"], [["A"]]));
    await workers();
    const j = await db.importJob.findUniqueOrThrow({ where: { id: noCols.id } });
    expect(j.status).toBe("FAILED");
    expect((j.report as { error: string }).error).toMatch(/Missing required column.*Last name.*Gender.*Class/);
    const empty = await upload(S.admin, "STUDENTS", await xlsx(H, []));
    await workers();
    expect((await db.importJob.findUniqueOrThrow({ where: { id: empty.id } })).status).toBe("FAILED");
    await expect(upload(S.admin, "NOPE", await xlsx(H, []))).rejects.toMatchObject({ code: "UNKNOWN_IMPORT_KIND" });
  });

  it("CSV uploads work through the same pipeline; error CSV can be downloaded for fixing", async () => {
    const csv = ["First name,Last name,Gender,Class", "Uche,Eze,M,JSS 1", "Bad,Row,X,JSS 1"].join("\n");
    const job = await imp.startImport(S.admin, "STUDENTS", { data: Buffer.from(csv), originalName: "kids.csv", declaredMime: "text/csv" });
    await workers();
    const p = await imp.getPreview(S.admin, job.id);
    expect(p.job).toMatchObject({ validRows: 1, errorRows: 1 });
    const report = await imp.errorReportCsv(S.admin, job.id);
    expect(report.split("\n")[1]).toContain('"3","gender","INVALID"');
  });

  it("permissions: needs the kind's permission; other users cannot see someone's import", async () => {
    await makeUser({ username: "teach", roles: ["teacher"] });
    const t = await ctxFor("teach");
    await expect(upload(t, "STUDENTS", await xlsx(H, []))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await makeUser({ username: "reg", roles: ["registrar"] });
    const r = await ctxFor("reg");
    const job = await upload(r, "STUDENTS", await xlsx(H, [good("Mine")]));
    await expect(imp.getPreview(t, job.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await imp.listImports(t)).length).toBe(0);
  });
});

describe("teachers and question imports", () => {
  it("imports teachers with role, staff numbers and credentials", async () => {
    const data = await xlsx(["First name", "Last name", "Phone", "Email", "Qualification"], [["Emeka", "Nwosu", 8055550001, "emeka@school.ng", "B.Ed"], ["Bad", "Mail", "", "not-an-email", ""]]);
    const job = await upload(S.admin, "TEACHERS", data, "teachers.xlsx");
    await workers();
    expect((await imp.getPreview(S.admin, job.id)).job).toMatchObject({ validRows: 1, errorRows: 1 });
    await imp.approveImport(S.admin, job.id, { skipInvalidRows: true });
    await workers();
    const t = await db.teacherProfile.findFirstOrThrow({ include: { user: { include: { roles: { include: { role: true } } } } } });
    expect(t.staffNumber).toBe("TCH/0001");
    expect(t.user.roles[0]!.role.key).toBe("teacher");
    expect(t.user.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it("imports exam-prep questions, validating the answer key", async () => {
    const topic = await bank.createTopic(S.admin, { subjectId: S.math.id, name: "Algebra" });
    const heads = ["Subject", "Topic", "Exam body", "Year", "Difficulty", "Question", "Option A", "Option B", "Option C", "Option D", "Correct answer", "Explanation"];
    const data = await xlsx(heads, [
      ["Mathematics", "Algebra", "JAMB", 2019, "Easy", "Solve 2x + 3 = 11", 4, 5, 6, 7, "A", "2x = 8"],
      ["Mathematics", "Algebra", "JAMB", 2019, "Easy", "Pick the primes", 2, 3, 4, 5, "A, B", ""],
      ["Mathematics", "Algebra", "JAMB", 2019, "Easy", "Broken key", 1, 2, "", "", "D", ""],
      ["Physics", "", "WAEC", "", "", "Unknown subject", 1, 2, "", "", "A", ""],
      ["Mathematics", "Algebra", "JAMB", 2019, "Easy", "Solve 2x + 3 = 11", 4, 5, 6, 7, "A", ""],
    ]);
    const job = await upload(S.admin, "QUESTIONS", data, "questions.xlsx");
    await workers();
    const p = await imp.getPreview(S.admin, job.id);
    expect(p.job).toMatchObject({ validRows: 2, errorRows: 2, duplicateRows: 1 });
    expect(p.errors.map((e) => e.code).sort()).toEqual(["DUPLICATE_IN_FILE", "INVALID_KEY", "UNKNOWN_SUBJECT"]);
    await imp.approveImport(S.admin, job.id, { skipInvalidRows: true });
    await workers();
    const qs = await db.cBTQuestion.findMany({ include: { options: true }, orderBy: { createdAt: "asc" } });
    expect(qs.map((q) => q.type)).toEqual(["MCQ_SINGLE", "MCQ_MULTIPLE"]);
    expect(qs[1]!.options.filter((o) => o.isCorrect).map((o) => o.label).sort()).toEqual(["A", "B"]);
    expect(qs[0]).toMatchObject({ examBody: "JAMB", year: 2019, topicId: topic.id });
  });
});
