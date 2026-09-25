import { z } from "zod";
import * as adm from "@/modules/admissions/service";
import { db } from "@/platform/db";
import { readFileBuffer } from "@/platform/files";
import { AppError } from "@/platform/errors";
import { json, publicRoute, readUpload, route, type RouteDef } from "../router";

const M = { module: "admissions" as const };
const applicant = z.object({ applicationNumber: z.string().min(5).max(40), accessCode: z.string().min(4).max(20) });

export const admissionsRoutes: RouteDef[] = [
  // ── PUBLIC: landing, application, status, documents ──
  publicRoute("GET", "/public/admissions", async () => adm.publicAdmissionInfo()),
  publicRoute("POST", "/public/admissions/apply", async ({ req, ip }) => adm.submitApplication((await json(req)) as never, ip)),
  publicRoute("POST", "/public/admissions/status", async ({ req }) => { const b = applicant.parse(await json(req)); return adm.applicantStatus(b.applicationNumber, b.accessCode); }),
  publicRoute("POST", "/public/admissions/documents", async ({ req }) => {
    const { file, form } = await readUpload(req);
    const b = applicant.parse({ applicationNumber: form.get("applicationNumber"), accessCode: form.get("accessCode") });
    return adm.uploadApplicantDocument(b.applicationNumber, b.accessCode, String(form.get("kind") ?? ""), file);
  }),
  publicRoute("GET", "/public/logo", async () => {
    const inst = await db.schoolInstallation.findFirst({ select: { logoFileId: true } });
    if (!inst?.logoFileId) throw new AppError("NOT_FOUND", "No logo", 404);
    const { asset, data } = await readFileBuffer(inst.logoFileId);
    if (!asset.mimeType.startsWith("image/")) throw new AppError("NOT_FOUND", "No logo", 404);
    return new Response(new Uint8Array(data), { headers: { "content-type": asset.mimeType, "cache-control": "public, max-age=300", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'" } });
  }),

  // ── registrar workflow ──
  route("GET", "/admissions", { ...M, permission: "admissions.view" }, async ({ query }) => adm.listApplications(Object.fromEntries(query.entries()) as never)),
  route("GET", "/admissions/:id", { ...M, permission: "admissions.view" }, async ({ params }) => adm.getApplication(params.id!)),
  route("POST", "/admissions/:id/review", { ...M, permission: "admissions.review" }, async ({ ctx, req, params }) => adm.startReview(ctx, params.id!, z.object({ version: z.number() }).parse(await json(req)).version)),
  route("POST", "/admissions/documents/:docId/verify", { ...M, permission: "admissions.review" }, async ({ ctx, req, params }) => { await adm.verifyDocument(ctx, params.docId!, z.object({ verified: z.boolean() }).parse(await json(req)).verified); return { ok: true }; }),
  route("POST", "/admissions/:id/verified", { ...M, permission: "admissions.review" }, async ({ ctx, req, params }) => adm.markVerified(ctx, params.id!, z.object({ version: z.number() }).parse(await json(req)).version)),
  route("POST", "/admissions/:id/approve", { ...M, permission: "admissions.review" }, async ({ ctx, req, params }) => adm.approveApplication(ctx, params.id!, (await json(req)) as never)),
  route("POST", "/admissions/:id/reject", { ...M, permission: "admissions.review" }, async ({ ctx, req, params }) => adm.rejectApplication(ctx, params.id!, (await json(req)) as never)),
  route("POST", "/admissions/:id/enroll", { ...M, permission: "admissions.enroll" }, async ({ ctx, req, params }) => adm.enrollApplicant(ctx, params.id!, (await json(req)) as never)),
];
