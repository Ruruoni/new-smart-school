import { z } from "zod";
import * as res from "@/modules/results/service";
import { validateBands, validateComponents } from "@/modules/results/engine";
import { db, transact } from "@/platform/db";
import { auditIn } from "@/platform/security/interceptor";
import { myReportCardPdf } from "@/modules/reports/service";
import { resultsLockoutPolicy } from "@/modules/finance/lockout";
import { conflict, validation } from "@/platform/errors";
import { uuid } from "@/platform/util";
import { json, route, type RouteDef } from "../router";

const M = { module: "results" as const };
const lockout = resultsLockoutPolicy((_ctx, { params }) => (typeof params.studentId === "string" ? params.studentId : undefined));

export const resultsRoutes: RouteDef[] = [
  // ── teacher score grid ──
  route("GET", "/results/sheet", { ...M, permission: ["assessments.enter_scores", "assessments.enter_any", "assessments.view"] }, async ({ ctx, query }) => res.getScoreSheet(ctx, uuid.parse(query.get("classSubjectId")), uuid.parse(query.get("termId")))),
  route("POST", "/results/scores", { ...M, permission: ["assessments.enter_scores", "assessments.enter_any"] }, async ({ ctx, req }) => res.saveScores(ctx, (await json(req)) as never)),
  route("POST", "/results/lock", { ...M, permission: ["assessments.enter_scores", "assessments.enter_any"] }, async ({ ctx, req }) => {
    const b = z.object({ classSubjectId: uuid, termId: uuid, locked: z.boolean() }).parse(await json(req));
    return { assessments: await res.setAssessmentsLocked(ctx, b.classSubjectId, b.termId, b.locked) };
  }),

  // ── processing / publication ──
  route("POST", "/results/process", { ...M, permission: "results.process" }, async ({ ctx, req }) => res.processResults(ctx, (await json(req)) as never)),
  route("GET", "/results/class", { ...M, permission: "results.view" }, async ({ query }) => res.listClassResults(uuid.parse(query.get("termId")), uuid.parse(query.get("classId")))),
  route("PATCH", "/results/report-cards/:id/remarks", { ...M, permission: "results.edit" }, async ({ ctx, req, params }) => { await res.setRemarks(ctx, params.id!, (await json(req)) as never); return { ok: true }; }),
  route("POST", "/results/publish", { ...M, permission: "results.publish" }, async ({ ctx, req }) => res.publishResults(ctx, (await json(req)) as never)),
  route("POST", "/results/withdraw", { ...M, permission: "results.publish" }, async ({ ctx, req }) => res.withdrawResults(ctx, (await json(req)) as never)),

  // ── reading (server-side scope + financial lockout inside the service AND as a route policy) ──
  route("GET", "/results/students/:studentId/terms", { ...M, permission: ["results.view"] }, async ({ ctx, params }) => res.listStudentTerms(ctx, params.studentId!)),
  route("GET", "/results/students/:studentId/report-card", { ...M, permission: "results.view", policies: [lockout as never] }, async ({ ctx, params, query }) => res.getReportCard(ctx, params.studentId!, uuid.parse(query.get("termId")))),
  route("GET", "/results/students/:studentId/report-card.pdf", { ...M, permission: "results.view", policies: [lockout as never] }, async ({ ctx, params, query }) => {
    const { data, fileName } = await myReportCardPdf(ctx, params.studentId!, uuid.parse(query.get("termId")));
    return new Response(new Uint8Array(data), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${fileName}"`, "cache-control": "private, no-store" } });
  }),

  // ── promotion ──
  route("GET", "/results/promotion/preview", { ...M, permission: "promotion.manage" }, async ({ ctx, query }) => res.previewPromotions(ctx, { classId: uuid.parse(query.get("classId")), academicYearId: uuid.parse(query.get("academicYearId")) })),
  route("POST", "/results/promotion/apply", { ...M, permission: "promotion.manage" }, async ({ ctx, req }) => res.applyPromotions(ctx, (await json(req)) as never)),

  // ── grading configuration ──
  route("GET", "/results/grading", { ...M, permission: ["grading.manage", "results.view", "assessments.view"] }, async () => {
    const { scheme, bands, components } = await res.loadScheme();
    return { scheme: { id: scheme.id, name: scheme.name, positionMethod: scheme.positionMethod }, bands, components, problems: [...validateBands(bands), ...validateComponents(components)] };
  }),
  route("PUT", "/results/grading", { ...M, permission: "grading.manage" }, async ({ ctx, req }) => {
    const b = z.object({
      positionMethod: z.enum(["STANDARD_COMPETITION", "DENSE"]),
      bands: z.array(z.object({ grade: z.string().min(1).max(4), minScore: z.number().min(0).max(100), maxScore: z.number().min(0).max(100), remark: z.string().max(40).nullable().optional(), gradePoint: z.number().nullable().optional(), isPass: z.boolean() })).min(2).max(20),
      components: z.array(z.object({ id: uuid.optional(), name: z.string().min(2).max(60), code: z.string().min(2).max(12).toUpperCase(), maxScore: z.number().min(1).max(100), isExam: z.boolean() })).min(2).max(8),
    }).parse(await json(req));
    const problems = [...validateBands(b.bands.map((x) => ({ ...x, gradePoint: x.gradePoint ?? null }))), ...validateComponents(b.components.map((c, i) => ({ id: c.id ?? String(i), ...c })))];
    if (problems.length) throw validation("The grading configuration is not valid", problems);
    return transact(async (tx) => {
      const scheme = await tx.gradingScheme.findFirstOrThrow({ where: { isDefault: true } });
      // Changing the scheme under processed/published results would silently change their meaning.
      if (await tx.examResult.count({ where: { status: "PUBLISHED" } })) throw conflict("Results have been published. Withdraw them before changing the grading scheme.");
      await tx.gradingScheme.update({ where: { id: scheme.id }, data: { positionMethod: b.positionMethod, version: { increment: 1 } } });
      await tx.gradeRule.deleteMany({ where: { schemeId: scheme.id } });
      await tx.gradeRule.createMany({ data: b.bands.map((x) => ({ schemeId: scheme.id, grade: x.grade, minScore: x.minScore, maxScore: x.maxScore, remark: x.remark ?? null, gradePoint: x.gradePoint ?? null, isPass: x.isPass })) });
      const existing = await tx.assessmentType.findMany({ where: { schemeId: scheme.id } });
      const keep = new Set<string>();
      for (const [i, c] of b.components.entries()) {
        const cur = existing.find((e) => e.id === c.id) ?? existing.find((e) => e.code === c.code);
        if (cur) { keep.add(cur.id); await tx.assessmentType.update({ where: { id: cur.id }, data: { name: c.name, code: c.code, maxScore: c.maxScore, isExam: c.isExam, sortOrder: i } }); }
        else keep.add((await tx.assessmentType.create({ data: { schemeId: scheme.id, name: c.name, code: c.code, maxScore: c.maxScore, isExam: c.isExam, sortOrder: i } })).id);
      }
      const dropped = existing.filter((e) => !keep.has(e.id));
      if (dropped.length && (await tx.assessment.count({ where: { typeId: { in: dropped.map((d) => d.id) } } }))) throw conflict("A score column that already has scores cannot be removed");
      await tx.assessmentType.deleteMany({ where: { id: { in: dropped.map((d) => d.id) } } });
      await auditIn(tx, ctx, { action: "grading.update", module: "results", entityType: "GradingScheme", entityId: scheme.id, after: { bands: b.bands.length, components: b.components.map((c) => `${c.code}:${c.maxScore}`) } });
      return { ok: true };
    });
  }),
  route("GET", "/results/terms/mine", { ...M, permission: "self.view" }, async () => db.term.findMany({ include: { academicYear: { select: { name: true } } }, orderBy: { startDate: "desc" }, take: 12 })),
];
