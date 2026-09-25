import { z } from "zod";
import { db, transact, Decimal, type Tx } from "@/platform/db";
import type { SecurityContext } from "@/platform/security/context";
import { auditIn } from "@/platform/security/interceptor";
import { audit, auditStandalone } from "@/platform/audit";
import { enqueueSync } from "@/platform/sync/outbox";
import { publishEvent } from "@/platform/events";
import { formatted } from "@/platform/sequence";
import { randomToken, sha256, safeEqual } from "@/platform/crypto";
import { saveUpload, registerFileReader, type UploadInput } from "@/platform/files";
import { getSetting } from "@/platform/settings";
import { AppError, conflict, forbidden, notFound, rateLimited, validation } from "@/platform/errors";
import { assertUpdated, asPage, birthDate, ilike, isoDate, skipTake, toDate, uuid } from "@/platform/util";
import { createStudentTx, type StudentInput } from "@/modules/people/service";
import { issueInvoiceTx } from "@/modules/finance/service";
import type { AdmissionStatus } from "@/generated/prisma/client";

/** Legal moves through the workflow. Anything else is refused, so a record can never skip verification. */
export const TRANSITIONS: Record<AdmissionStatus, AdmissionStatus[]> = {
  DRAFT: ["SUBMITTED"],
  SUBMITTED: ["UNDER_REVIEW", "REJECTED"],
  UNDER_REVIEW: ["VERIFIED", "REJECTED", "SUBMITTED"],
  VERIFIED: ["APPROVED", "REJECTED", "UNDER_REVIEW"],
  APPROVED: ["ENROLLED", "REJECTED"],
  REJECTED: ["UNDER_REVIEW"],
  ENROLLED: [],
};
function assertTransition(from: AdmissionStatus, to: AdmissionStatus) {
  if (!TRANSITIONS[from].includes(to)) throw conflict(`An application that is ${from.replace("_", " ").toLowerCase()} cannot become ${to.replace("_", " ").toLowerCase()}`);
}

// ───────────── Public flow ─────────────

export const ApplicationInput = z.object({
  firstName: z.string().trim().min(1).max(60),
  middleName: z.string().trim().max(60).optional(),
  lastName: z.string().trim().min(1).max(60),
  gender: z.enum(["MALE", "FEMALE"]),
  dateOfBirth: birthDate,
  stateOfOrigin: z.string().trim().max(60).optional(),
  lga: z.string().trim().max(80).optional(),
  religion: z.string().trim().max(40).optional(),
  address: z.string().trim().max(300).optional(),
  previousSchool: z.string().trim().max(150).optional(),
  desiredClassId: uuid.optional(),
  guardianName: z.string().trim().min(2).max(120),
  guardianRelationship: z.string().trim().min(2).max(30),
  guardianPhone: z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, "Enter a valid phone number"),
  guardianEmail: z.string().email().optional(),
  guardianAddress: z.string().trim().max(300).optional(),
});

// Per-IP + per-phone throttle for the unauthenticated endpoint.
const hits = new Map<string, { n: number; reset: number }>();
function throttle(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < now) return void hits.set(key, { n: 1, reset: now + windowMs });
  if (++h.n > max) throw rateLimited(Math.ceil((h.reset - now) / 1000));
}
export const resetAdmissionThrottle = () => hits.clear();

export async function publicAdmissionInfo() {
  const policy = await getSetting("admissions.policy");
  const school = await db.schoolInstallation.findFirst({ select: { schoolName: true, motto: true, address: true, phone: true, email: true, logoFileId: true } });
  const classes = policy.open ? await db.schoolClass.findMany({ orderBy: { level: "asc" }, select: { id: true, name: true } }) : [];
  return { open: policy.open, applicationFee: policy.applicationFee, requiredDocuments: policy.requiredDocuments, instructions: policy.instructions, school, classes };
}

export async function submitApplication(raw: z.input<typeof ApplicationInput>, ip?: string | null) {
  const i = ApplicationInput.parse(raw);
  if (ip) throttle(`ip:${ip}`, 10, 3_600_000);
  throttle(`phone:${i.guardianPhone}`, 5, 86_400_000);
  const policy = await getSetting("admissions.policy");
  if (!policy.open) throw new AppError("ADMISSIONS_CLOSED", "Admissions are currently closed", 403);

  const accessCode = randomToken(6).slice(0, 8).toUpperCase().replace(/[-_]/g, "X");
  return transact(async (tx) => {
    if (i.desiredClassId && !(await tx.schoolClass.findUnique({ where: { id: i.desiredClassId } }))) throw validation("Selected class does not exist");
    const dup = await tx.admissionRecord.findFirst({ where: { firstName: { equals: i.firstName, mode: "insensitive" }, lastName: { equals: i.lastName, mode: "insensitive" }, dateOfBirth: toDate(i.dateOfBirth), guardianPhone: i.guardianPhone, status: { notIn: ["REJECTED"] } } });
    if (dup) throw conflict("An application for this child already exists", { applicationNumber: dup.applicationNumber });
    const applicationNumber = await formatted(tx, "APP", new Date().getFullYear(), 5);
    const rec = await tx.admissionRecord.create({
      data: { ...i, dateOfBirth: toDate(i.dateOfBirth), applicationNumber, status: "SUBMITTED", submittedAt: new Date(), accessCodeHash: sha256(accessCode) },
    });
    let invoice: { number: string; total: string } | null = null;
    if (policy.applicationFee > 0) {
      const inv = await tx.invoice.create({
        data: { number: await formatted(tx, "INV", new Date().getFullYear()), admissionRecordId: rec.id, status: "DRAFT", subtotal: policy.applicationFee, total: policy.applicationFee, dueDate: new Date(), notes: `Application fee for ${applicationNumber}`, items: { create: [{ description: "Application fee", kind: "CHARGE", quantity: 1, unitAmount: policy.applicationFee, amount: policy.applicationFee }] } },
      });
      await issueInvoiceTx(tx, null, inv.id);
      await tx.admissionRecord.update({ where: { id: rec.id }, data: { applicationFeeInvoiceId: inv.id } });
      invoice = { number: inv.number, total: new Decimal(policy.applicationFee).toFixed(2) };
    }
    await enqueueSync(tx, "admission_record", rec);
    await publishEvent(tx, "admission.submitted", { admissionId: rec.id, applicationNumber, applicant: `${i.firstName} ${i.lastName}`, guardianPhone: i.guardianPhone });
    await audit(tx, { action: "admission.submit", module: "admissions", entityType: "AdmissionRecord", entityId: rec.id, after: { applicationNumber }, ip });
    return { applicationNumber, accessCode, applicationFee: invoice, requiredDocuments: policy.requiredDocuments };
  });
}

async function authenticateApplicant(applicationNumber: string, accessCode: string) {
  throttle(`app:${applicationNumber}`, 20, 900_000);
  const rec = await db.admissionRecord.findUnique({ where: { applicationNumber } });
  if (!rec?.accessCodeHash || !safeEqual(rec.accessCodeHash, sha256(accessCode.trim().toUpperCase()))) {
    await auditStandalone({ action: "admission.access_failed", module: "admissions", entityType: "AdmissionRecord", metadata: { applicationNumber } });
    throw notFound("Application"); // same answer for wrong number and wrong code
  }
  return rec;
}

export async function applicantStatus(applicationNumber: string, accessCode: string) {
  const rec = await authenticateApplicant(applicationNumber, accessCode);
  const [docs, invoice] = await Promise.all([
    db.admissionDocument.findMany({ where: { admissionId: rec.id }, select: { id: true, kind: true, verified: true, uploadedAt: true } }),
    rec.applicationFeeInvoiceId ? db.invoice.findUnique({ where: { id: rec.applicationFeeInvoiceId }, select: { number: true, status: true, total: true, amountPaid: true } }) : null,
  ]);
  const policy = await getSetting("admissions.policy");
  return {
    applicationNumber, applicant: `${rec.firstName} ${rec.lastName}`, status: rec.status,
    // Internal review notes are only revealed once a decision has been made.
    decisionNote: rec.status === "APPROVED" || rec.status === "REJECTED" || rec.status === "ENROLLED" ? rec.decisionNote : null,
    documents: docs, missingDocuments: policy.requiredDocuments.filter((k) => !docs.some((d) => d.kind === k)),
    fee: invoice ? { invoice: invoice.number, status: invoice.status, total: invoice.total.toString(), paid: invoice.amountPaid.toString() } : null,
  };
}

const DOC_KINDS = ["BIRTH_CERTIFICATE", "PASSPORT_PHOTO", "PREVIOUS_RESULT", "TRANSFER_LETTER", "OTHER"] as const;

export async function uploadApplicantDocument(applicationNumber: string, accessCode: string, kind: string, file: Omit<UploadInput, "profile" | "ownerType" | "ownerId">) {
  const rec = await authenticateApplicant(applicationNumber, accessCode);
  if (!(DOC_KINDS as readonly string[]).includes(kind)) throw validation("Unknown document type");
  if (!["SUBMITTED", "UNDER_REVIEW", "DRAFT"].includes(rec.status)) throw conflict("This application can no longer accept documents");
  const count = await db.admissionDocument.count({ where: { admissionId: rec.id } });
  if (count >= 12) throw validation("Too many documents attached");
  return transact(async (tx) => {
    const asset = await saveUpload(tx, { ...file, profile: kind === "PASSPORT_PHOTO" ? "IMAGE" : "DOCUMENT", ownerType: "ADMISSION", ownerId: rec.id });
    // One document per kind: a re-upload replaces the previous file (old file soft-deleted, still on disk until purge).
    const prev = await tx.admissionDocument.findFirst({ where: { admissionId: rec.id, kind } });
    if (prev) { await tx.fileAsset.update({ where: { id: prev.fileId }, data: { deletedAt: new Date() } }); await tx.admissionDocument.delete({ where: { id: prev.id } }); }
    const doc = await tx.admissionDocument.create({ data: { admissionId: rec.id, kind, fileId: asset.id } });
    await audit(tx, { action: "admission.document_upload", module: "admissions", entityType: "AdmissionRecord", entityId: rec.id, metadata: { kind, size: asset.sizeBytes } });
    return { id: doc.id, kind, fileName: asset.originalName };
  });
}

// ───────────── Registrar workflow ─────────────

export const AdmissionListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(["DRAFT", "SUBMITTED", "UNDER_REVIEW", "VERIFIED", "APPROVED", "REJECTED", "ENROLLED"]).optional(), q: z.string().trim().max(80).optional(),
});

export async function listApplications(raw: z.input<typeof AdmissionListQuery>) {
  const q = AdmissionListQuery.parse(raw);
  const where = { ...(q.status ? { status: q.status } : {}), ...(q.q ? { OR: [{ firstName: ilike(q.q) }, { lastName: ilike(q.q) }, { applicationNumber: ilike(q.q) }, { guardianPhone: ilike(q.q) }] } : {}) };
  const [items, total] = await Promise.all([
    db.admissionRecord.findMany({ where, select: { id: true, applicationNumber: true, status: true, firstName: true, lastName: true, gender: true, guardianName: true, guardianPhone: true, desiredClassId: true, submittedAt: true, version: true, applicationFeeInvoiceId: true }, orderBy: { createdAt: "desc" }, ...skipTake(q) }),
    db.admissionRecord.count({ where }),
  ]);
  return asPage(items, total, q);
}

export async function getApplication(id: string) {
  const rec = await db.admissionRecord.findUnique({ where: { id }, include: { documents: true, applicationFeeInvoice: { select: { number: true, status: true, total: true, amountPaid: true } }, student: { select: { id: true, admissionNumber: true } } } });
  if (!rec) throw notFound("Application");
  const { accessCodeHash: _h, ...safe } = rec;
  return safe;
}

async function moveTo(ctx: SecurityContext, tx: Tx, id: string, to: AdmissionStatus, version: number, extra: Record<string, unknown> = {}, note?: string) {
  const rec = await tx.admissionRecord.findUnique({ where: { id } });
  if (!rec) throw notFound("Application");
  assertTransition(rec.status, to);
  const r = await tx.admissionRecord.updateMany({ where: { id, version }, data: { status: to, reviewedById: ctx.user.id, reviewedAt: new Date(), ...(note !== undefined ? { decisionNote: note } : {}), ...extra, version: { increment: 1 } } });
  assertUpdated(r.count, "Application", rec.version);
  const after = await tx.admissionRecord.findUniqueOrThrow({ where: { id } });
  await enqueueSync(tx, "admission_record", after);
  await auditIn(tx, ctx, { action: `admission.${to.toLowerCase()}`, module: "admissions", entityType: "AdmissionRecord", entityId: id, before: { status: rec.status }, after: { status: to }, metadata: note ? { note } : undefined });
  return { before: rec, after };
}

export async function startReview(ctx: SecurityContext, id: string, version: number) {
  return transact(async (tx) => {
    const rec = await tx.admissionRecord.findUnique({ where: { id }, include: { applicationFeeInvoice: true } });
    if (!rec) throw notFound("Application");
    const policy = await getSetting("admissions.policy", tx);
    if (policy.requireFeePaidBeforeReview && rec.applicationFeeInvoice && rec.applicationFeeInvoice.status !== "PAID") throw conflict("The application fee has not been paid yet");
    return (await moveTo(ctx, tx, id, "UNDER_REVIEW", version)).after;
  });
}

export async function verifyDocument(ctx: SecurityContext, docId: string, verified: boolean) {
  return transact(async (tx) => {
    const d = await tx.admissionDocument.findUnique({ where: { id: docId }, include: { admission: true } });
    if (!d) throw notFound("Document");
    if (!["UNDER_REVIEW", "VERIFIED"].includes(d.admission.status)) throw conflict("Start the review before verifying documents");
    await tx.admissionDocument.update({ where: { id: docId }, data: { verified, verifiedById: verified ? ctx.user.id : null } });
    await auditIn(tx, ctx, { action: verified ? "admission.document_verified" : "admission.document_unverified", module: "admissions", entityType: "AdmissionRecord", entityId: d.admissionId, metadata: { kind: d.kind } });
  });
}

export async function markVerified(ctx: SecurityContext, id: string, version: number) {
  return transact(async (tx) => {
    const policy = await getSetting("admissions.policy", tx);
    const docs = await tx.admissionDocument.findMany({ where: { admissionId: id } });
    const missing = policy.requiredDocuments.filter((k) => !docs.some((d) => d.kind === k && d.verified));
    if (missing.length) throw conflict("Required documents are missing or not yet verified", { missing });
    return (await moveTo(ctx, tx, id, "VERIFIED", version)).after;
  });
}

export async function approveApplication(ctx: SecurityContext, id: string, raw: { version: number; classId: string; note?: string }) {
  const i = z.object({ version: z.number().int(), classId: uuid, note: z.string().max(500).optional() }).parse(raw);
  return transact(async (tx) => {
    if (!(await tx.schoolClass.findUnique({ where: { id: i.classId } }))) throw notFound("Class");
    const { after } = await moveTo(ctx, tx, id, "APPROVED", i.version, { approvedClassId: i.classId }, i.note);
    await publishEvent(tx, "admission.approved", { admissionId: id, applicationNumber: after.applicationNumber, applicant: `${after.firstName} ${after.lastName}`, guardianPhone: after.guardianPhone, guardianEmail: after.guardianEmail });
    return after;
  });
}

export async function rejectApplication(ctx: SecurityContext, id: string, raw: { version: number; note: string }) {
  const i = z.object({ version: z.number().int(), note: z.string().trim().min(3).max(500) }).parse(raw);
  return transact(async (tx) => {
    const { after } = await moveTo(ctx, tx, id, "REJECTED", i.version, {}, i.note);
    await publishEvent(tx, "admission.rejected", { admissionId: id, applicationNumber: after.applicationNumber, guardianPhone: after.guardianPhone });
    return after;
  });
}

/** Approved applicant → student record + login-less enrollment + guardian account, all in one transaction. */
export async function enrollApplicant(ctx: SecurityContext, id: string, raw: { version: number; sectionId?: string | null; createLogin?: boolean }) {
  const i = z.object({ version: z.number().int(), sectionId: uuid.nullable().optional(), createLogin: z.boolean().default(false) }).parse(raw);
  return transact(async (tx) => {
    const rec = await tx.admissionRecord.findUnique({ where: { id } });
    if (!rec) throw notFound("Application");
    if (rec.status !== "APPROVED" || !rec.approvedClassId) throw conflict("Only approved applications can be enrolled");
    const [first, ...rest] = rec.guardianName.trim().split(/\s+/);
    const input: z.input<typeof StudentInput> = {
      firstName: rec.firstName, middleName: rec.middleName ?? undefined, lastName: rec.lastName, gender: rec.gender,
      dateOfBirth: rec.dateOfBirth.toISOString().slice(0, 10), stateOfOrigin: rec.stateOfOrigin ?? undefined, lga: rec.lga ?? undefined, religion: rec.religion ?? undefined, address: rec.address ?? undefined,
      classId: rec.approvedClassId, sectionId: i.sectionId ?? null, createLogin: i.createLogin, admissionRecordId: rec.id,
      guardians: [{ newParent: { firstName: first ?? "Guardian", lastName: rest.join(" ") || rec.lastName, phone: rec.guardianPhone, email: rec.guardianEmail ?? undefined, address: rec.guardianAddress ?? undefined }, relationship: rec.guardianRelationship, isPrimary: true }],
    };
    const created = await createStudentTx(tx, ctx, input);
    await moveTo(ctx, tx, id, "ENROLLED", i.version);
    await publishEvent(tx, "student.admitted", { studentId: created.student.id, admissionNumber: created.student.admissionNumber, guardianPhone: rec.guardianPhone });
    return { student: created.student, studentLogin: created.username ? { username: created.username, initialPassword: created.initialPassword } : null, guardianLogin: created.guardianCredentials[0] ?? null };
  });
}

// Registrars/admins can read admission documents; nobody else.
registerFileReader("ADMISSION", async (ctx) => ctx.can("admissions.view"));
