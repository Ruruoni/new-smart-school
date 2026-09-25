import { z, ZodError } from "zod";
import { db, transact } from "@/platform/db";
import type { SecurityContext } from "@/platform/security/context";
import { auditIn } from "@/platform/security/interceptor";
import { audit } from "@/platform/audit";
import { actorContext } from "@/platform/security/actor";
import { enqueueJob, isFinalAttempt } from "@/platform/jobs";
import { registerFileReader, saveUpload } from "@/platform/files";
import { AppError, forbidden, notFound, validation } from "@/platform/errors";
import { uuid } from "@/platform/util";
import { getReportCard } from "@/modules/results/service";
import { reportOrThrow, REPORTS } from "./definitions";
import { renderReport, type ReportData } from "./render";
import { classReportCards, reportCardPdf } from "./reportcard";

function assertMay(ctx: SecurityContext, permission: readonly string[]) {
  if (!permission.some((p) => ctx.can(p))) throw forbidden("You do not have permission to generate this report", { permission });
}

export function availableReports(ctx: SecurityContext) {
  return Object.values(REPORTS).filter((d) => d.permission.some((p) => ctx.can(p))).map((d) => ({ kind: d.kind, label: d.label, formats: d.formats }))
    .concat(ctx.can("results.view") ? [{ kind: "REPORT_CARD", label: "Report cards (PDF)", formats: ["PDF"] as never }] : []);
}

/** On-screen / print preview (capped) — same data as the downloads. */
export async function previewReport(ctx: SecurityContext, kind: string, rawParams: unknown): Promise<ReportData> {
  const def = reportOrThrow(kind);
  assertMay(ctx, def.permission);
  const parsed = def.params.safeParse(rawParams ?? {});
  if (!parsed.success) throw validation("Invalid report parameters", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const data = await def.build(ctx, parsed.data as never);
  return { ...data, generatedAt: new Date().toISOString().slice(0, 16).replace("T", " "), rows: data.rows.slice(0, 1000) };
}

export const ReportRequest = z.object({ kind: z.string(), format: z.enum(["PDF", "XLSX", "CSV"]), params: z.record(z.string(), z.unknown()).default({}) });

/** Queue a report; heavy rendering happens in the reports worker so the web request returns immediately. */
export async function requestReport(ctx: SecurityContext, raw: z.input<typeof ReportRequest>) {
  const i = ReportRequest.parse(raw);
  if (i.kind === "REPORT_CARD") {
    ctx.require("results.view");
    if (i.format !== "PDF") throw validation("Report cards are PDF only");
    z.object({ termId: uuid, classId: uuid.optional(), studentId: uuid.optional() }).refine((p) => p.classId || p.studentId, "Choose a class or a student").parse(i.params);
  } else {
    const def = reportOrThrow(i.kind);
    assertMay(ctx, def.permission);
    if (!def.formats.includes(i.format)) throw validation(`${def.label} is not available as ${i.format}`);
    const p = def.params.safeParse(i.params);
    if (!p.success) throw validation("Invalid report parameters", p.error.issues.map((x) => ({ path: x.path.join("."), message: x.message })));
  }
  return transact(async (tx) => {
    const exp = await tx.reportExport.create({ data: { kind: i.kind, format: i.format, params: i.params as never, requestedById: ctx.user.id } });
    await enqueueJob(tx, "reports", "report.generate", { exportId: exp.id });
    await auditIn(tx, ctx, { action: "report.request", module: "reports", entityType: "ReportExport", entityId: exp.id, metadata: { kind: i.kind, format: i.format } });
    return exp;
  });
}

/**
 * Worker entry point. `attempt` (from the job) lets the export tell the truth about a failure: on a non-final failure it goes
 * back to QUEUED with the reason ("will retry"); when retrying can't help or attempts are used up it becomes FAILED with an
 * actionable message — never stuck in RUNNING/QUEUED without explanation.
 */
export async function generateReport(exportId: string, attempt?: { attempts: number; maxAttempts: number }): Promise<void> {
  const exp = await db.reportExport.findUnique({ where: { id: exportId } });
  if (!exp || exp.status === "SUCCEEDED") return;
  await db.reportExport.update({ where: { id: exportId }, data: { status: "RUNNING" } });
  try {
    const ctx = await actorContext(exp.requestedById!);
    const params = (exp.params ?? {}) as Record<string, string>;
    let data: Buffer, mime: string, ext: string, name: string;
    if (exp.kind === "REPORT_CARD") {
      const cards = params.studentId ? [await getReportCard(ctx, params.studentId, params.termId!)] : await classReportCards(ctx, params.termId!, params.classId!, ctx.can("results.process"));
      if (!cards.length) throw validation("There are no report cards to print for that selection");
      data = await reportCardPdf(cards); mime = "application/pdf"; ext = "pdf"; name = `report-cards-${cards.length}`;
    } else {
      const def = reportOrThrow(exp.kind);
      const built = { ...(await def.build(ctx, def.params.parse(params) as never)), generatedAt: new Date().toISOString().slice(0, 16).replace("T", " ") };
      const r = await renderReport(built, exp.format);
      data = r.data; mime = r.mime; ext = r.ext; name = def.label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    }
    const asset = await saveUpload(db, { data, originalName: `${name}-${new Date().toISOString().slice(0, 10)}.${ext}`, declaredMime: mime, profile: "REPORT", ownerType: "REPORT", ownerId: exportId, uploadedById: exp.requestedById });
    await transact(async (tx) => {
      await tx.reportExport.update({ where: { id: exportId }, data: { status: "SUCCEEDED", fileId: asset.id, finishedAt: new Date(), error: null } });
      await audit(tx, { actorId: exp.requestedById, action: "report.generated", module: "reports", entityType: "ReportExport", entityId: exportId, metadata: { kind: exp.kind, format: exp.format, size: asset.sizeBytes } });
    });
  } catch (err) {
    const reason = (err instanceof AppError ? err.message
      : err instanceof ZodError ? `The report options are not valid: ${err.issues[0]?.path.join(".") || "request"} — ${err.issues[0]?.message ?? "invalid value"}`
      : `Something went wrong while preparing this report (${err instanceof Error ? err.message : String(err)})`).slice(0, 500);
    const final = attempt ? isFinalAttempt(attempt, err) : true;
    await db.reportExport.update({ where: { id: exportId }, data: final ? { status: "FAILED", error: reason, finishedAt: new Date() } : { status: "QUEUED", error: `Will retry: ${reason}` } });
    throw err;
  }
}

export async function getExport(ctx: SecurityContext, id: string) {
  const e = await db.reportExport.findUnique({ where: { id } });
  if (!e || (e.requestedById !== ctx.user.id && !ctx.user.isPrimaryAdmin)) throw notFound("Report");
  return e;
}

export const listMyExports = (ctx: SecurityContext) => db.reportExport.findMany({ where: { requestedById: ctx.user.id }, orderBy: { createdAt: "desc" }, take: 30 });

/** A parent/student downloads their own report card — synchronous, scope + lockout enforced by getReportCard. */
export async function myReportCardPdf(ctx: SecurityContext, studentId: string, termId: string) {
  const card = await getReportCard(ctx, studentId, termId);
  return { data: await reportCardPdf([card]), fileName: `report-card-${card.card.student.admissionNumber.replace(/\//g, "-")}.pdf` };
}

registerFileReader("REPORT", async (ctx, a) => a.uploadedById === ctx.user.id);

export const reportJobHandlers = { "report.generate": async (job: { payload: Record<string, unknown>; attempts: number; maxAttempts: number }) => generateReport(uuid.parse(job.payload.exportId), job) };
