import { z } from "zod";
import { db, transact, type Tx } from "@/platform/db";
import type { SecurityContext } from "@/platform/security/context";
import { auditIn } from "@/platform/security/interceptor";
import { audit } from "@/platform/audit";
import { readFileBuffer, registerFileReader, saveUpload, detectType, type UploadInput } from "@/platform/files";
import { enqueueJob } from "@/platform/jobs";
import { AppError, conflict, forbidden, notFound, validation } from "@/platform/errors";
import { uuid } from "@/platform/util";
import { actorContext } from "@/platform/security/actor";
import type { Prisma } from "@/generated/prisma/client";
import { buildTemplate, mapHeaders, parseSheet } from "./parse";
import { kindOrThrow, loadRefData, type RowError } from "./kinds";

const CHUNK = 100;

export async function importTemplate(kind: string) {
  const k = kindOrThrow(kind);
  return { fileName: `${k.key.toLowerCase()}-import-template.xlsx`, data: await buildTemplate(k.columns, k.label.slice(0, 28)) };
}

/** Stage 1 — Upload: store the file safely and queue parsing. Nothing touches real data yet. */
export async function startImport(ctx: SecurityContext, kind: string, file: Omit<UploadInput, "profile" | "ownerType" | "ownerId" | "uploadedById">) {
  const k = kindOrThrow(kind);
  ctx.require(k.permission);
  return transact(async (tx) => {
    const asset = await saveUpload(tx, { ...file, profile: "SPREADSHEET", ownerType: "IMPORT", uploadedById: ctx.user.id });
    const job = await tx.importJob.create({ data: { kind: k.key, fileId: asset.id, createdById: ctx.user.id } });
    await tx.fileAsset.update({ where: { id: asset.id }, data: { ownerId: job.id } });
    await enqueueJob(tx, "imports", "import.parse", { jobId: job.id });
    await auditIn(tx, ctx, { action: "import.upload", module: "imports", entityType: "ImportJob", entityId: job.id, metadata: { kind: k.key, file: asset.originalName, size: asset.sizeBytes } });
    return job;
  });
}

async function fail(jobId: string, message: string) {
  await db.importJob.update({ where: { id: jobId }, data: { status: "FAILED", report: { error: message } } });
}

/** Stages 2–5 — Parse, validate, normalise, detect duplicates → PREVIEW. Row results are staged, never committed. */
export async function parseAndValidate(jobId: string): Promise<void> {
  const job = await db.importJob.findUnique({ where: { id: jobId } });
  if (!job) throw notFound("Import");
  if (job.status !== "UPLOADED") return; // idempotent: already parsed
  const kind = kindOrThrow(job.kind);
  try {
    const { asset, data } = await readFileBuffer(job.fileId);
    const sheet = await parseSheet(data, detectType(data, asset.originalName));
    const { map, missing } = mapHeaders(kind.columns, sheet.headers);
    if (missing.length) return void (await fail(jobId, `Missing required column(s): ${missing.join(", ")}`));
    if (!sheet.rows.length) return void (await fail(jobId, "The file has no data rows"));

    const ref = await loadRefData();
    type Staged = { rowNumber: number; raw: Record<string, string>; data?: Record<string, unknown>; errors: RowError[]; key?: string };
    const staged: Staged[] = sheet.rows.map((r) => {
      const raw: Record<string, string> = {};
      for (const [orig, canonical] of map) raw[canonical] = r.cells[orig] ?? "";
      const v = kind.validateRow(raw, ref);
      return { rowNumber: r.rowNumber, raw, data: v.data as Record<string, unknown> | undefined, errors: v.errors, key: v.data ? kind.naturalKey(v.data) : undefined };
    });
    // Duplicates inside the file: the first occurrence wins, later ones are flagged.
    const firstSeen = new Map<string, number>();
    for (const s of staged) {
      if (!s.key || s.errors.length) continue;
      const prev = firstSeen.get(s.key);
      if (prev !== undefined) s.errors.push({ code: "DUPLICATE_IN_FILE", message: `Same as row ${prev} in this file` });
      else firstSeen.set(s.key, s.rowNumber);
    }
    // Duplicates already in the database.
    const candidates = staged.filter((s) => s.data && !s.errors.length).map((s) => s.data!);
    const existing = await kind.findExisting(candidates);
    for (const s of staged) if (s.key && !s.errors.length && existing.has(s.key)) s.errors.push({ code: "DUPLICATE_EXISTING", message: existing.get(s.key)! });

    const isDup = (s: Staged) => s.errors.some((e) => e.code.startsWith("DUPLICATE"));
    await transact(async (tx) => {
      for (let i = 0; i < staged.length; i += 500) {
        const chunk = staged.slice(i, i + 500);
        await tx.importRow.createMany({
          data: chunk.map((s) => ({ jobId, rowNumber: s.rowNumber, raw: s.raw as Prisma.InputJsonValue, normalized: (s.errors.length ? undefined : s.data) as Prisma.InputJsonValue | undefined, status: !s.errors.length ? "VALID" : isDup(s) ? "DUPLICATE" : "ERROR" })),
        });
        await tx.importRowError.createMany({ data: chunk.flatMap((s) => s.errors.map((e) => ({ jobId, rowNumber: s.rowNumber, field: e.field, code: e.code, message: e.message }))) });
      }
      await tx.importJob.update({
        where: { id: jobId },
        data: { status: "PREVIEW", totalRows: staged.length, validRows: staged.filter((s) => !s.errors.length).length, duplicateRows: staged.filter(isDup).length, errorRows: staged.filter((s) => s.errors.length && !isDup(s)).length },
      });
    });
  } catch (err) {
    await fail(jobId, err instanceof AppError ? err.message : "The file could not be processed");
    if (!(err instanceof AppError)) throw err;
  }
}

export async function getImport(ctx: SecurityContext, jobId: string) {
  const job = await ownedJob(ctx, jobId);
  return job;
}

async function ownedJob(ctx: SecurityContext, jobId: string) {
  const job = await db.importJob.findUnique({ where: { id: jobId } });
  if (!job) throw notFound("Import");
  if (job.createdById !== ctx.user.id && !ctx.can("imports.run") && !ctx.user.isPrimaryAdmin) throw notFound("Import");
  return job;
}

/** Stage 6 — Preview: what will be imported, what was rejected and why. */
export async function getPreview(ctx: SecurityContext, jobId: string, opts: { errorPage?: number; sample?: number } = {}) {
  const job = await ownedJob(ctx, jobId);
  const kind = kindOrThrow(job.kind);
  const sample = await db.importRow.findMany({ where: { jobId, status: "VALID" }, orderBy: { rowNumber: "asc" }, take: opts.sample ?? 10, select: { rowNumber: true, normalized: true } });
  const errorPage = opts.errorPage ?? 1;
  const [errors, errorTotal] = await Promise.all([
    db.importRowError.findMany({ where: { jobId }, orderBy: [{ rowNumber: "asc" }, { id: "asc" }], skip: (errorPage - 1) * 50, take: 50 }),
    db.importRowError.count({ where: { jobId } }),
  ]);
  return { job: { id: job.id, kind: job.kind, label: kind.label, status: job.status, totalRows: job.totalRows, validRows: job.validRows, errorRows: job.errorRows, duplicateRows: job.duplicateRows, importedRows: job.importedRows, report: job.report }, sample, errors, errorTotal, errorPage };
}

/** Stage 7 — Approval. The person approving states whether invalid rows are skipped; there is no silent partial import. */
export async function approveImport(ctx: SecurityContext, jobId: string, raw: { skipInvalidRows: boolean }) {
  const { skipInvalidRows } = z.object({ skipInvalidRows: z.boolean() }).parse(raw);
  const job = await ownedJob(ctx, jobId);
  const kind = kindOrThrow(job.kind);
  ctx.require(kind.permission);
  if (job.status !== "PREVIEW") throw conflict(`This import is ${job.status.toLowerCase()} and cannot be approved`);
  if (!job.validRows) throw validation("There are no valid rows to import");
  if ((job.errorRows || job.duplicateRows) && !skipInvalidRows) throw validation("Some rows are invalid. Fix the file and upload it again, or approve importing only the valid rows.", { errorRows: job.errorRows, duplicateRows: job.duplicateRows });
  return transact(async (tx) => {
    const r = await tx.importJob.updateMany({ where: { id: jobId, status: "PREVIEW" }, data: { status: "APPROVED", approvedById: ctx.user.id } });
    if (!r.count) throw conflict("This import was already approved");
    await enqueueJob(tx, "imports", "import.commit", { jobId });
    await auditIn(tx, ctx, { action: "import.approve", module: "imports", entityType: "ImportJob", entityId: jobId, metadata: { valid: job.validRows, skipped: job.errorRows + job.duplicateRows } });
    return tx.importJob.findUniqueOrThrow({ where: { id: jobId } });
  });
}

export async function cancelImport(ctx: SecurityContext, jobId: string) {
  const job = await ownedJob(ctx, jobId);
  if (!["UPLOADED", "PREVIEW", "APPROVED"].includes(job.status)) throw conflict("This import can no longer be cancelled");
  await db.importJob.update({ where: { id: jobId }, data: { status: "CANCELLED" } });
  await transact((tx) => auditIn(tx, ctx, { action: "import.cancel", module: "imports", entityType: "ImportJob", entityId: jobId }));
}

/**
 * Stages 8–10 — Background processing, transactions, report.
 * Rows commit in small transactions (each row inside a SAVEPOINT): a row that fails is recorded as an error and
 * everything else in the chunk still lands; a crash mid-run is resumable because finished rows are marked IMPORTED.
 * No row is ever half-imported.
 */
export async function commitImport(jobId: string): Promise<void> {
  const claimed = await db.importJob.updateMany({ where: { id: jobId, status: { in: ["APPROVED", "PROCESSING"] } }, data: { status: "PROCESSING" } });
  if (!claimed.count) return; // someone else finished it, or it was cancelled
  const job = await db.importJob.findUniqueOrThrow({ where: { id: jobId } });
  const kind = kindOrThrow(job.kind);
  const actor = await db.user.findUnique({ where: { id: job.approvedById ?? job.createdById ?? "" } });
  if (!actor) return void (await fail(jobId, "The approving user no longer exists"));
  const ctx = await actorContext(actor.id);
  const credentials: { row: number; username: string; password: string; role: string; name: string }[] = [];
  let imported = job.importedRows, failed = 0;

  try {
    for (;;) {
      const rows = await db.importRow.findMany({ where: { jobId, status: "VALID" }, orderBy: { rowNumber: "asc" }, take: CHUNK });
      if (!rows.length) break;
      // Pre-hash passwords outside the transaction (native argon2 runs in parallel and must not hold DB locks).
      const prepared = await Promise.all(rows.map((r) => kind.prepare?.(r.normalized as never) ?? Promise.resolve({})));
      await transact(async (tx) => {
        for (const [i, row] of rows.entries()) {
          await tx.$executeRawUnsafe("SAVEPOINT import_row");
          try {
            const res = await kind.commitRow(tx, ctx, row.normalized as never, prepared[i]!);
            await tx.importRow.update({ where: { id: row.id }, data: { status: "IMPORTED", entityId: res.entityId } });
            await tx.$executeRawUnsafe("RELEASE SAVEPOINT import_row");
            for (const c of res.credentials ?? []) credentials.push({ row: row.rowNumber, ...c });
            imported += 1;
          } catch (err) {
            await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT import_row");
            const message = err instanceof AppError ? err.message : "Unexpected error while saving this row";
            if (!(err instanceof AppError)) console.error("import row failed", err);
            await tx.importRow.update({ where: { id: row.id }, data: { status: "ERROR" } });
            await tx.importRowError.create({ data: { jobId, rowNumber: row.rowNumber, code: "COMMIT_FAILED", message } });
            failed += 1;
          }
        }
      }, { timeoutMs: 120_000 });
    }

    let credentialsFileId: string | null = null;
    if (credentials.length) {
      const csv = ["Row,Name,Role,Username,Temporary password", ...credentials.map((c) => [c.row, c.name, c.role, c.username, c.password].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))].join("\n");
      const a = await saveUpload(db, { data: Buffer.from(csv, "utf8"), originalName: `new-accounts-${jobId.slice(0, 8)}.csv`, profile: "SPREADSHEET", ownerType: "IMPORT_CREDENTIALS", ownerId: jobId, uploadedById: actor.id });
      credentialsFileId = a.id;
    }
    const totals = await db.importRow.groupBy({ by: ["status"], where: { jobId }, _count: true });
    const n = (s: string) => totals.find((t) => t.status === s)?._count ?? 0;
    await transact(async (tx) => {
      await tx.importJob.update({
        where: { id: jobId },
        data: { status: "COMPLETED", importedRows: n("IMPORTED"), errorRows: n("ERROR"), duplicateRows: n("DUPLICATE"), report: { imported: n("IMPORTED"), skipped: n("ERROR") + n("DUPLICATE"), commitFailures: failed, credentialsFileId, finishedAt: new Date().toISOString() } },
      });
      await audit(tx, { actorId: actor.id, actorName: `${actor.firstName} ${actor.lastName}`, action: "import.complete", module: "imports", entityType: "ImportJob", entityId: jobId, metadata: { kind: job.kind, imported: n("IMPORTED"), skipped: n("ERROR") + n("DUPLICATE") } });
    });
  } catch (err) {
    // Leave the job PROCESSING? No: mark FAILED with the count so far; rerunning "commit" resumes from unfinished rows.
    await db.importJob.update({ where: { id: jobId }, data: { status: "FAILED", importedRows: imported, report: { error: (err as Error).message.slice(0, 300), imported } } });
    throw err;
  }
}

/** Retry a FAILED import: resumes from the rows that were not yet imported. */
export async function resumeImport(ctx: SecurityContext, jobId: string) {
  const job = await ownedJob(ctx, jobId);
  if (job.status !== "FAILED" || !(await db.importRow.count({ where: { jobId, status: "VALID" } }))) throw conflict("Nothing to resume");
  await transact(async (tx) => {
    await tx.importJob.update({ where: { id: jobId }, data: { status: "APPROVED" } });
    await enqueueJob(tx, "imports", "import.commit", { jobId });
  });
}

export async function listImports(ctx: SecurityContext, take = 30) {
  return db.importJob.findMany({ where: ctx.can("imports.run") ? {} : { createdById: ctx.user.id }, orderBy: { createdAt: "desc" }, take, select: { id: true, kind: true, status: true, totalRows: true, validRows: true, errorRows: true, duplicateRows: true, importedRows: true, createdAt: true, report: true } });
}

/** Error report as CSV so the school can fix rows in Excel and re-upload. */
export async function errorReportCsv(ctx: SecurityContext, jobId: string): Promise<string> {
  await ownedJob(ctx, jobId);
  const errs = await db.importRowError.findMany({ where: { jobId }, orderBy: [{ rowNumber: "asc" }] });
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return ["Row,Field,Code,Problem", ...errs.map((e) => [e.rowNumber, e.field, e.code, e.message].map(esc).join(","))].join("\n");
}

// Files: the uploaded sheet is readable by its owner/importers; the credentials CSV only by the approver/owner or primary admin.
registerFileReader("IMPORT", async (ctx, a) => ctx.can("imports.run") || a.uploadedById === ctx.user.id);
registerFileReader("IMPORT_CREDENTIALS", async (ctx, a) => a.uploadedById === ctx.user.id || ctx.user.isPrimaryAdmin);

export const importJobHandlers = {
  "import.parse": async (job: { payload: Record<string, unknown> }) => parseAndValidate(uuid.parse(job.payload.jobId)),
  "import.commit": async (job: { payload: Record<string, unknown> }) => commitImport(uuid.parse(job.payload.jobId)),
};
void forbidden;
export type { Tx };
