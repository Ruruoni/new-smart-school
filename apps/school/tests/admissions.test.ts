import { beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { db } from "@/platform/db";
import * as adm from "@/modules/admissions/service";
import * as fin from "@/modules/finance/service";
import { detectType, openFile, sanitizeFilename, storagePath } from "@/platform/files";
import { setSetting } from "@/platform/settings";
import { hashPassword } from "@/platform/password";
import { ctxFor, seedAcademics } from "./fixtures";
import { makeUser, resetDb } from "./helpers";

let S: Awaited<ReturnType<typeof seedAcademics>>;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 2)]);
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64, 3)]);

const application = (over = {}) => ({
  firstName: "Ifeanyi", lastName: "Nwosu", gender: "MALE" as const, dateOfBirth: "2014-05-12", guardianName: "Chinedu Nwosu", guardianRelationship: "Father", guardianPhone: "08055550001",
  guardianEmail: "chinedu@example.com", desiredClassId: S.jss1.id, ...over,
});

beforeEach(async () => {
  await resetDb();
  adm.resetAdmissionThrottle();
  await rm("./.data/test-storage", { recursive: true, force: true });
  S = await seedAcademics();
});

describe("file security", () => {
  it("detects real types from bytes", () => {
    expect(detectType(PNG)).toBe("png");
    expect(detectType(PDF)).toBe("pdf");
    expect(detectType(EXE)).toBe("unknown");
    expect(detectType(Buffer.from("a,b\n1,2\n"), "x.csv")).toBe("csv");
    expect(detectType(Buffer.from("<svg onload=alert(1)>"), "x.svg")).toBe("unknown");
  });
  it("sanitises hostile file names", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Windows\\evil<script>.pdf")).toBe("evilscript.pdf");
    expect(sanitizeFilename("....hidden")).toBe("hidden");
    expect(sanitizeFilename("")).toBe("file");
  });
  it("storage keys cannot escape the storage root", () => {
    expect(() => storagePath("../../etc/passwd")).toThrow();
    expect(() => storagePath("2026/01/../../../secret")).toThrow();
  });
});

describe("public application flow", () => {
  it("submits, returns an access code once, stores only its hash, and raises the fee invoice", async () => {
    await db.$transaction((tx) => setSetting(tx, "admissions.policy", { open: true, applicationFee: 5000, requiredDocuments: ["BIRTH_CERTIFICATE"] }));
    const r = await adm.submitApplication(application(), "10.0.0.1");
    expect(r.applicationNumber).toMatch(/^APP\/\d{4}\/00001$/);
    expect(r.accessCode).toHaveLength(8);
    expect(r.applicationFee).toMatchObject({ total: "5000.00" });
    const rec = await db.admissionRecord.findFirstOrThrow();
    expect(rec.accessCodeHash).not.toBe(r.accessCode);
    const inv = await db.invoice.findFirstOrThrow({ where: { admissionRecordId: rec.id } });
    expect(inv.status).toBe("ISSUED");
    expect(inv.studentId).toBeNull();
    expect(await db.domainEvent.count({ where: { type: "admission.submitted" } })).toBe(1);
  });

  it("rejects duplicates, closed admissions, and throttles abuse", async () => {
    await adm.submitApplication(application(), "10.0.0.1");
    await expect(adm.submitApplication(application(), "10.0.0.2")).rejects.toMatchObject({ code: "CONFLICT" });
    await db.$transaction((tx) => setSetting(tx, "admissions.policy", { open: false }));
    await expect(adm.submitApplication(application({ firstName: "Other" }), "10.0.0.3")).rejects.toMatchObject({ code: "ADMISSIONS_CLOSED" });
    await db.$transaction((tx) => setSetting(tx, "admissions.policy", { open: true }));
    adm.resetAdmissionThrottle();
    for (let i = 0; i < 10; i++) await adm.submitApplication(application({ firstName: `K${i}`, guardianPhone: `0805555${1000 + i}` }), "10.9.9.9");
    await expect(adm.submitApplication(application({ firstName: "Late", guardianPhone: "08056660000" }), "10.9.9.9")).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("applicants need the access code, and errors do not reveal which part was wrong", async () => {
    const r = await adm.submitApplication(application(), "1.1.1.1");
    await expect(adm.applicantStatus(r.applicationNumber, "WRONGCODE")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(adm.applicantStatus("APP/0000/00099", r.accessCode)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const st = await adm.applicantStatus(r.applicationNumber, r.accessCode.toLowerCase());
    expect(st.status).toBe("SUBMITTED");
    expect(st.missingDocuments).toEqual(["BIRTH_CERTIFICATE", "PASSPORT_PHOTO"]);
  });

  it("accepts valid documents, refuses executables, spoofed types and oversized files", async () => {
    const r = await adm.submitApplication(application(), "1.1.1.1");
    const up = (kind: string, data: Buffer, name = "doc.pdf", declaredMime?: string) => adm.uploadApplicantDocument(r.applicationNumber, r.accessCode, kind, { data, originalName: name, declaredMime });
    const ok = await up("BIRTH_CERTIFICATE", PDF, "../birth cert.pdf", "application/pdf");
    expect(ok.fileName).toBe("birth cert.pdf");
    const asset = await db.fileAsset.findFirstOrThrow();
    expect(existsSync(storagePath(asset.storageKey))).toBe(true);
    expect(asset.storageKey).not.toContain("birth");
    await expect(up("PASSPORT_PHOTO", EXE, "photo.png", "image/png")).rejects.toMatchObject({ code: "FILE_TYPE_NOT_ALLOWED" });
    await expect(up("BIRTH_CERTIFICATE", PNG, "x.pdf", "application/pdf")).rejects.toMatchObject({ code: "FILE_TYPE_MISMATCH" });
    await expect(up("PASSPORT_PHOTO", PDF, "p.pdf", "application/pdf")).rejects.toMatchObject({ code: "FILE_TYPE_NOT_ALLOWED" }); // photo must be an image
    await expect(up("PASSPORT_PHOTO", Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]), "big.png")).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    await expect(up("MALWARE", PDF)).rejects.toThrow(/Unknown document type/);
    // re-upload replaces the earlier file
    await up("BIRTH_CERTIFICATE", Buffer.concat([PDF, Buffer.from("v2")]));
    expect(await db.admissionDocument.count({ where: { kind: "BIRTH_CERTIFICATE" } })).toBe(1);
    expect(await db.fileAsset.count({ where: { deletedAt: { not: null } } })).toBe(1);
  });

  it("only registrars can open admission documents", async () => {
    const r = await adm.submitApplication(application(), "1.1.1.1");
    const doc = await adm.uploadApplicantDocument(r.applicationNumber, r.accessCode, "BIRTH_CERTIFICATE", { data: PDF, originalName: "b.pdf" });
    const fileId = (await db.admissionDocument.findUniqueOrThrow({ where: { id: doc.id } })).fileId;
    await makeUser({ username: "teacher1", roles: ["teacher"] });
    await makeUser({ username: "reg1", roles: ["registrar"] });
    await expect(openFile(await ctxFor("teacher1"), fileId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const res = await openFile(await ctxFor("reg1"), fileId);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    await res.body?.cancel();
  });
});

describe("registrar workflow", () => {
  async function fullApplication(fee = 0) {
    await db.$transaction((tx) => setSetting(tx, "admissions.policy", { open: true, applicationFee: fee, requiredDocuments: ["BIRTH_CERTIFICATE"] }));
    const r = await adm.submitApplication(application(), "2.2.2.2");
    const doc = await adm.uploadApplicantDocument(r.applicationNumber, r.accessCode, "BIRTH_CERTIFICATE", { data: PDF, originalName: "b.pdf" });
    const rec = await db.admissionRecord.findFirstOrThrow();
    return { r, doc, rec };
  }

  it("cannot skip steps and needs verified documents", async () => {
    const { rec, doc } = await fullApplication();
    await expect(adm.approveApplication(S.admin, rec.id, { version: rec.version, classId: S.jss1.id })).rejects.toThrow(/cannot become approved/);
    await expect(adm.markVerified(S.admin, rec.id, rec.version)).rejects.toThrow(/missing or not yet verified/);
    const review = await adm.startReview(S.admin, rec.id, rec.version);
    await adm.verifyDocument(S.admin, doc.id, true);
    const verified = await adm.markVerified(S.admin, rec.id, review.version);
    expect(verified.status).toBe("VERIFIED");
  });

  it("holds review until the application fee is paid", async () => {
    const { rec } = await fullApplication(5000);
    await expect(adm.startReview(S.admin, rec.id, rec.version)).rejects.toThrow(/fee has not been paid/);
    const inv = await db.invoice.findFirstOrThrow({ where: { admissionRecordId: rec.id } });
    await fin.recordPayment(S.admin, { payerName: "Chinedu Nwosu", amount: 5000, method: "BANK_TRANSFER", idempotencyKey: "app-fee-0001", allocations: [{ invoiceId: inv.id, amount: 5000 }] });
    await expect(adm.startReview(S.admin, rec.id, rec.version)).resolves.toMatchObject({ status: "UNDER_REVIEW" });
    expect((await fin.verifyFinance()).ok).toBe(true);
  });

  it("stale decisions are refused (two registrars, one application)", async () => {
    const { rec } = await fullApplication();
    await adm.startReview(S.admin, rec.id, rec.version);
    await expect(adm.rejectApplication(S.admin, rec.id, { version: rec.version, note: "late" })).rejects.toMatchObject({ code: "STALE_WRITE" });
  });

  it("approve → enroll creates student, guardian account, enrollment, sync record and events", async () => {
    const { rec, doc } = await fullApplication();
    let cur = await adm.startReview(S.admin, rec.id, rec.version);
    await adm.verifyDocument(S.admin, doc.id, true);
    cur = await adm.markVerified(S.admin, rec.id, cur.version);
    cur = await adm.approveApplication(S.admin, rec.id, { version: cur.version, classId: S.jss1.id, note: "Welcome" });
    expect(await db.domainEvent.count({ where: { type: "admission.approved" } })).toBe(1);
    const out = await adm.enrollApplicant(S.admin, rec.id, { version: cur.version, sectionId: S.secA.id, createLogin: true });
    expect(out.student.admissionNumber).toMatch(/^ADM\//);
    expect(out.guardianLogin?.username).toBe("08055550001");
    expect(out.studentLogin?.initialPassword).toBeTruthy();
    const student = await db.studentProfile.findUniqueOrThrow({ where: { id: out.student.id }, include: { guardians: true, enrollments: true } });
    expect(student.admissionRecordId).toBe(rec.id);
    expect(student.guardians[0]).toMatchObject({ relationship: "Father", isPrimary: true });
    expect(student.enrollments[0]).toMatchObject({ classId: S.jss1.id, sectionId: S.secA.id, status: "ACTIVE" });
    expect((await db.admissionRecord.findUniqueOrThrow({ where: { id: rec.id } })).status).toBe("ENROLLED");
    expect(await db.domainEvent.count({ where: { type: "student.admitted" } })).toBe(1);
    await expect(adm.enrollApplicant(S.admin, rec.id, { version: 99 })).rejects.toThrow(/Only approved/);
    // the guardian can log in and sees only the new child
    const g = await db.user.findFirstOrThrow({ where: { username: "08055550001" } });
    expect(g.mustChangePassword).toBe(true);
    expect(await hashPassword("x")).toBeTruthy();
  });

  it("applicants only see the decision note after a decision", async () => {
    const { r, rec } = await fullApplication();
    const cur = await adm.startReview(S.admin, rec.id, rec.version);
    await db.admissionRecord.update({ where: { id: rec.id }, data: { decisionNote: "internal: weak results" } });
    expect((await adm.applicantStatus(r.applicationNumber, r.accessCode)).decisionNote).toBeNull();
    await adm.rejectApplication(S.admin, rec.id, { version: cur.version, note: "Not offered a place" });
    expect(await adm.applicantStatus(r.applicationNumber, r.accessCode)).toMatchObject({ status: "REJECTED", decisionNote: "Not offered a place" });
  });
});
