import { z } from "zod";
import * as comms from "@/modules/communication/announcements";
import { deliveryOverview, requeueDead } from "@/modules/communication/delivery";
import { maskedProviderConfig, saveProviderConfig, sendTestMessage } from "@/modules/communication/providers";
import * as rules from "@/modules/automation/service";
import { ACTION_TYPES } from "@/modules/automation/engine";
import { getAnalytics, refreshSnapshot, DATASETS } from "@/modules/analytics/service";
import * as reports from "@/modules/reports/service";
import * as imports from "@/modules/imports/service";
import { IMPORT_KINDS } from "@/modules/imports/kinds";
import * as backup from "@/modules/backup/service";
import { workerStatus } from "@/platform/worker-status";
import { dashboardOverview } from "@/modules/analytics/overview";
import * as sync from "@/modules/sync/worker";
import { resolveConflict, listConflicts } from "@/modules/sync/conflicts";
import { registerWithCloud, sendHeartbeat } from "@/modules/sync/heartbeat";
import { currentLicense } from "@/platform/license";
import { db, transact } from "@/platform/db";
import { auditIn } from "@/platform/security/interceptor";
import { openFile } from "@/platform/files";
import { AppError } from "@/platform/errors";
import { uuid } from "@/platform/util";
import { json, readUpload, route, type RouteDef } from "../router";

export const serviceRoutes: RouteDef[] = [
  // ── announcements & communication ──
  route("GET", "/announcements", { module: "communication", permission: "announcements.view" }, async ({ ctx }) => comms.listAnnouncementsFor(ctx.user.id, ctx.user.userType)),
  route("POST", "/announcements", { module: "communication", permission: "announcements.manage" }, async ({ ctx, req }) => comms.createAnnouncement(ctx, (await json(req)) as never)),
  route("POST", "/announcements/:id/publish", { module: "communication", permission: "announcements.manage" }, async ({ ctx, params }) => comms.publishAnnouncement(ctx, params.id!)),
  route("GET", "/communication/deliveries", { module: "communication", permission: "notifications.manage" }, async () => ({ overview: await deliveryOverview(), recent: await db.notificationDelivery.findMany({ orderBy: { createdAt: "desc" }, take: 50, select: { id: true, channel: true, recipient: true, status: true, attempts: true, lastError: true, createdAt: true, sentAt: true } }) })),
  route("POST", "/communication/deliveries/requeue", { module: "communication", permission: "notifications.manage" }, async () => ({ requeued: await requeueDead() })),
  route("GET", "/communication/providers", { module: "communication", permission: "notifications.manage" }, async () => maskedProviderConfig()),
  route("PUT", "/communication/providers", { module: "communication", permission: "notifications.manage" }, async ({ ctx, req }) => transact(async (tx) => { await saveProviderConfig(tx, (await json(req)) as never); await auditIn(tx, ctx, { action: "communication.providers_update", module: "communication" }); return { ok: true }; })),
  route("POST", "/communication/providers/test", { module: "communication", permission: "notifications.manage" }, async ({ ctx, req }) => {
    const b = z.object({ channel: z.enum(["EMAIL", "SMS", "WHATSAPP"]), to: z.string().trim().min(3).max(200) }).parse(await json(req));
    const r = await sendTestMessage(b.channel, b.to, (await db.schoolInstallation.findFirst({ select: { schoolName: true } }))?.schoolName ?? "your school");
    await transact((tx) => auditIn(tx, ctx, { action: "communication.provider_test", module: "communication", metadata: { channel: b.channel, ok: r.ok } }));
    return r;
  }),
  route("GET", "/communication/templates", { module: "communication", permission: "notifications.manage" }, async () => db.notificationTemplate.findMany({ orderBy: [{ key: "asc" }, { channel: "asc" }] })),
  route("PUT", "/communication/templates/:id", { module: "communication", permission: "notifications.manage" }, async ({ ctx, req, params }) => {
    const b = z.object({ subject: z.string().max(200).nullable().optional(), body: z.string().min(2).max(1500), isActive: z.boolean().optional() }).parse(await json(req));
    return transact(async (tx) => { const t = await tx.notificationTemplate.update({ where: { id: params.id! }, data: b }); await auditIn(tx, ctx, { action: "communication.template_update", module: "communication", entityType: "NotificationTemplate", entityId: t.id }); return t; });
  }),

  // ── automation ──
  route("GET", "/automation/rules", { module: "automation", permission: "automation.view" }, async () => ({ rules: await rules.listRules(), actionTypes: ACTION_TYPES })),
  route("POST", "/automation/rules", { module: "automation", permission: "automation.manage" }, async ({ ctx, req }) => rules.createRule(ctx, (await json(req)) as never)),
  route("PUT", "/automation/rules/:id", { module: "automation", permission: "automation.manage" }, async ({ ctx, req, params }) => { await rules.updateRule(ctx, params.id!, (await json(req)) as never); return { ok: true }; }),
  route("POST", "/automation/rules/:id/enabled", { module: "automation", permission: "automation.manage" }, async ({ ctx, req, params }) => { await rules.setRuleEnabled(ctx, params.id!, z.object({ enabled: z.boolean() }).parse(await json(req)).enabled); return { ok: true }; }),
  route("DELETE", "/automation/rules/:id", { module: "automation", permission: "automation.manage" }, async ({ ctx, params }) => { await rules.deleteRule(ctx, params.id!); return { ok: true }; }),
  route("GET", "/automation/executions", { module: "automation", permission: "automation.view" }, async ({ query }) => rules.listExecutions(query.get("ruleId") ?? undefined, 100)),

  // ── analytics & reports ──
  route("GET", "/dashboard/overview", { permission: ["analytics.view", "students.view", "finance.view"] }, async ({ ctx }) => dashboardOverview(ctx)),
  route("GET", "/analytics/:key", { module: "analytics", permission: "analytics.view" }, async ({ params, query }) => { if (!(params.key! in DATASETS)) throw new AppError("NOT_FOUND", "Unknown dataset", 404); return getAnalytics(params.key!, query.get("scope") ?? "school"); }),
  route("POST", "/analytics/:key/refresh", { module: "analytics", permission: "analytics.view" }, async ({ params, query }) => { if (!(params.key! in DATASETS)) throw new AppError("NOT_FOUND", "Unknown dataset", 404); await refreshSnapshot(params.key!, query.get("scope") ?? "school"); return getAnalytics(params.key!, query.get("scope") ?? "school"); }),
  route("GET", "/reports", { module: "reports", permission: "reports.generate" }, async ({ ctx }) => ({ available: reports.availableReports(ctx), mine: await reports.listMyExports(ctx) })),
  route("POST", "/reports/preview", { module: "reports", permission: "reports.generate" }, async ({ ctx, req }) => { const b = z.object({ kind: z.string(), params: z.record(z.string(), z.unknown()).default({}) }).parse(await json(req)); return reports.previewReport(ctx, b.kind, b.params); }),
  route("POST", "/reports", { module: "reports", permission: "reports.generate" }, async ({ ctx, req }) => reports.requestReport(ctx, (await json(req)) as never)),
  route("GET", "/reports/:id", { module: "reports", permission: "reports.generate" }, async ({ ctx, params }) => reports.getExport(ctx, params.id!)),
  route("GET", "/reports/:id/download", { module: "reports", permission: "reports.generate" }, async ({ ctx, params }) => { const e = await reports.getExport(ctx, params.id!); if (!e.fileId) throw new AppError("NOT_READY", "The report is not ready yet", 409); return openFile(ctx, e.fileId); }),

  // ── imports ──
  route("GET", "/imports/kinds", { module: "imports", permission: "imports.run" }, async () => Object.values(IMPORT_KINDS).map((k) => ({ key: k.key, label: k.label, permission: k.permission, columns: k.columns }))),
  route("GET", "/imports/template/:kind", { module: "imports", permission: "imports.run" }, async ({ params }) => { const t = await imports.importTemplate(params.kind!); return new Response(new Uint8Array(t.data), { headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": `attachment; filename="${t.fileName}"` } }); }),
  route("GET", "/imports", { module: "imports", permission: "imports.run" }, async ({ ctx }) => imports.listImports(ctx)),
  route("POST", "/imports", { module: "imports", permission: "imports.run" }, async ({ ctx, req }) => { const { file, form } = await readUpload(req); return imports.startImport(ctx, String(form.get("kind") ?? ""), file); }),
  route("GET", "/imports/:id", { module: "imports", permission: "imports.run" }, async ({ ctx, params, query }) => imports.getPreview(ctx, params.id!, { errorPage: Number(query.get("errorPage") ?? 1) })),
  route("POST", "/imports/:id/approve", { module: "imports", permission: "imports.run" }, async ({ ctx, req, params }) => imports.approveImport(ctx, params.id!, (await json(req)) as never)),
  route("POST", "/imports/:id/cancel", { module: "imports", permission: "imports.run" }, async ({ ctx, params }) => { await imports.cancelImport(ctx, params.id!); return { ok: true }; }),
  route("POST", "/imports/:id/resume", { module: "imports", permission: "imports.run" }, async ({ ctx, params }) => { await imports.resumeImport(ctx, params.id!); return { ok: true }; }),
  route("GET", "/imports/:id/errors.csv", { module: "imports", permission: "imports.run" }, async ({ ctx, params }) => new Response(await imports.errorReportCsv(ctx, params.id!), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="import-errors.csv"` } })),

  // ── backup ──
  route("GET", "/backup", { module: "backup", permission: "backup.view" }, async () => ({ backups: (await backup.listBackups()).map((b) => ({ ...b, sizeBytes: b.sizeBytes === null ? null : Number(b.sizeBytes) })), health: await backup.backupHealth() })),
  route("POST", "/backup/run", { module: "backup", permission: "backup.run", licenseExempt: true }, async ({ ctx }) => { const r = await backup.runBackup(ctx, { reason: "manual" }); return { id: r.record.id, rows: r.manifest.totalRows }; }),
  route("POST", "/backup/:id/verify", { module: "backup", permission: "backup.run", licenseExempt: true }, async ({ params, req }) => backup.verifyBackup(params.id!, { deep: z.object({ deep: z.boolean().default(false) }).parse(await json(req).catch(() => ({}))).deep })),
  route("POST", "/backup/:id/restore", { module: "backup", permission: "backup.restore", licenseExempt: true }, async ({ ctx, req, params }) => backup.restoreBackup(ctx, { ...(await json<object>(req)), backupId: params.id! } as never)),
  route("GET", "/backup/:id/download", { module: "backup", permission: "backup.restore", licenseExempt: true }, async ({ params }) => { const f = await backup.backupFileStream(params.id!); const { Readable } = await import("node:stream"); return new Response(Readable.toWeb(f.stream) as ReadableStream, { headers: { "content-type": "application/octet-stream", "content-length": String(f.size), "content-disposition": `attachment; filename="${f.name}"` } }); }),

  // ── synchronization & licensing ──
  route("GET", "/sync/status", { module: "sync", permission: ["sync.view", "license.view"], licenseExempt: true }, async () => {
    const [overview, license, inst] = await Promise.all([sync.syncOverview(), currentLicense(), db.schoolInstallation.findFirstOrThrow({ select: { installationCode: true, cloudUrl: true, registeredAt: true, appVersion: true } })]);
    return { overview, license: { status: license.status, mode: license.mode, plan: license.plan, expiresAt: license.expiresAt, graceEndsAt: license.graceEndsAt, message: license.message, modules: [...license.modules] }, installation: inst };
  }),
  route("GET", "/sync/conflicts", { module: "sync", permission: "sync.view" }, async ({ query }) => listConflicts(query.get("status") === "ALL" ? "ALL" : "OPEN")),
  route("POST", "/sync/conflicts/:id/resolve", { module: "sync", permission: "sync.resolve_conflicts" }, async ({ ctx, req, params }) => resolveConflict(ctx, params.id!, (await json(req)) as never)),
  route("POST", "/sync/now", { module: "sync", permission: "sync.view", licenseExempt: true }, async () => ({ push: await sync.pushAll(), heartbeat: await sendHeartbeat() })),
  route("POST", "/sync/requeue-dead", { module: "sync", permission: "sync.resolve_conflicts" }, async () => ({ requeued: await sync.requeueDead() })),
  route("POST", "/sync/register", { permission: "settings.edit", licenseExempt: true }, async ({ ctx, req }) => registerWithCloud(ctx, z.object({ cloudUrl: z.string().url(), registrationToken: z.string().min(10) }).parse(await json(req)))),
  // "Is anything actually processing the queue?" — asked by pages that hand work to the worker (reports, imports, backups).
  route("GET", "/system/worker", { permission: ["reports.generate", "imports.run", "backup.view", "license.view", "analytics.view"] }, async () => workerStatus()),
  route("GET", "/system/health", { permission: "license.view", licenseExempt: true }, async () => {
    const [ws, ov, bk] = await Promise.all([db.workerHeartbeat.findMany(), sync.syncOverview(), backup.backupHealth()]);
    const q = await db.backgroundJob.groupBy({ by: ["queue", "status"], _count: true });
    return { workers: ws, sync: ov, backup: bk, jobs: q.map((j) => ({ queue: j.queue, status: j.status, count: j._count })), events: { pending: await db.domainEvent.count({ where: { processedAt: null } }), parked: await db.domainEvent.count({ where: { lastError: { startsWith: "PARKED" } } }) }, uuid: uuid.safeParse("x").success };
  }),
];
