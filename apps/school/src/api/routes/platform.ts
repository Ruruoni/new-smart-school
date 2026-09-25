import { z } from "zod";
import { db } from "@/platform/db";
import { listAuditLogs, verifyAuditChain } from "@/platform/audit";
import { openFile } from "@/platform/files";
import { assertKnownSetting, getProfile, moduleMatrix, readPolicy, setFeatureFlag, setModuleEnabled, updatePolicy, updateProfile, ProfileInput } from "@/modules/settings/service";
import * as users from "@/modules/users/service";
import { listNotifications, markRead } from "@/modules/communication/engine";
import { forbidden } from "@/platform/errors";
import { PageQuery, pageParams, uuid } from "@/platform/util";
import { saveUpload } from "@/platform/files";
import { auditIn } from "@/platform/security/interceptor";
import { transact } from "@/platform/db";
import { json, pick, readUpload, route, type RouteDef } from "../router";

const policyPermission = (key: string) => (key === "finance.lockout" ? "finance.configure_lockout" : key === "results.policy" ? "settings.edit" : "settings.edit");

export const platformRoutes: RouteDef[] = [
  // ── users ──
  route("GET", "/users", { permission: "users.view" }, async ({ query }) => users.listUsers({ ...PageQuery.parse(pick(query)), userType: query.get("userType") ?? undefined, status: query.get("status") ?? undefined })),
  route("POST", "/users", { permission: "users.create" }, async ({ ctx, req }) => users.createUser(ctx, (await json(req)) as never)),
  route("PATCH", "/users/:id", { permission: "users.edit" }, async ({ ctx, req, params }) => users.updateUser(ctx, params.id!, (await json(req)) as never)),
  route("POST", "/users/:id/status", { permission: "users.disable" }, async ({ ctx, req, params }) => users.setUserStatus(ctx, params.id!, z.object({ status: z.enum(["ACTIVE", "SUSPENDED", "DISABLED"]) }).parse(await json(req)).status)),
  route("POST", "/users/:id/reset-password", { permission: "users.reset_password" }, async ({ ctx, req, params }) => users.resetUserPassword(ctx, params.id!, z.object({ password: z.string() }).parse(await json(req)).password)),
  route("PUT", "/users/:id/roles", { permission: "users.edit" }, async ({ ctx, req, params }) => users.setUserRoles(ctx, params.id!, z.object({ roleKeys: z.array(z.string()) }).parse(await json(req)).roleKeys)),
  route("POST", "/admin/transfer-ownership", { permission: "users.edit" }, async ({ ctx, req }) => { const b = z.object({ toUserId: uuid, password: z.string() }).parse(await json(req)); await users.transferPrimaryAdmin(ctx, b.toUserId, b.password); return { ok: true }; }),

  // ── roles & permissions ──
  route("GET", "/roles", { permission: "roles.view" }, async () => users.listRoles()),
  route("GET", "/permissions", { permission: "roles.view" }, async () => users.listPermissions()),
  route("POST", "/roles", { permission: "roles.manage" }, async ({ ctx, req }) => users.createRole(ctx, (await json(req)) as never)),
  route("PUT", "/roles/:id/permissions", { permission: "roles.manage" }, async ({ ctx, req, params }) => { await users.setRolePermissions(ctx, params.id!, z.object({ permissions: z.array(z.string()) }).parse(await json(req)).permissions); return { ok: true }; }),
  route("DELETE", "/roles/:id", { permission: "roles.manage" }, async ({ ctx, params }) => { await users.deleteRole(ctx, params.id!); return { ok: true }; }),

  // ── school settings ──
  route("GET", "/settings/profile", { permission: "settings.view" }, async () => getProfile()),
  route("PATCH", "/settings/profile", { permission: "settings.edit" }, async ({ ctx, req }) => updateProfile(ctx, ProfileInput.parse(await json(req)))),
  route("POST", "/settings/logo", { permission: "settings.edit" }, async ({ ctx, req }) => {
    const { file } = await readUpload(req);
    return transact(async (tx) => {
      const asset = await saveUpload(tx, { ...file, profile: "IMAGE", ownerType: "SCHOOL_LOGO", uploadedById: ctx.user.id });
      const inst = await tx.schoolInstallation.findFirstOrThrow();
      await tx.schoolInstallation.update({ where: { id: inst.id }, data: { logoFileId: asset.id, version: { increment: 1 } } });
      await auditIn(tx, ctx, { action: "settings.logo", module: "platform", entityType: "SchoolInstallation", entityId: inst.id });
      return { fileId: asset.id };
    });
  }),
  route("GET", "/settings/policies/:key", { permission: ["settings.view", "finance.configure_lockout"] }, async ({ params }) => { assertKnownSetting(params.key!); return readPolicy(params.key); }),
  route("PUT", "/settings/policies/:key", { permission: ["settings.edit", "finance.configure_lockout"] }, async ({ ctx, req, params }) => {
    assertKnownSetting(params.key!);
    ctx.require(policyPermission(params.key));
    return updatePolicy(ctx, params.key, await json(req));
  }),
  route("GET", "/settings/modules", { permission: "modules.manage" }, async () => moduleMatrix()),
  route("PUT", "/settings/modules/:key", { permission: "modules.manage" }, async ({ ctx, req, params }) => { await setModuleEnabled(ctx, params.key!, z.object({ enabled: z.boolean() }).parse(await json(req)).enabled); return { ok: true }; }),
  route("PUT", "/settings/features/:key", { permission: "modules.manage" }, async ({ ctx, req, params }) => { await setFeatureFlag(ctx, params.key!, z.object({ enabled: z.boolean() }).parse(await json(req)).enabled); return { ok: true }; }),

  // ── audit ──
  route("GET", "/audit", { permission: "audit.view" }, async ({ query }) => listAuditLogs({ ...pick(query), ...pageParams(query, 50) })),
  route("GET", "/audit/verify", { permission: "audit.view" }, async () => verifyAuditChain()),

  // ── files (authorisation is per owner type inside openFile) ──
  route("GET", "/files/:id", { licenseExempt: true }, async ({ ctx, params }) => openFile(ctx, params.id!)),
  // the school logo is shown on public pages (login, apply)
  route("GET", "/notifications", { licenseExempt: true }, async ({ ctx, query }) => listNotifications(ctx.user.id, { unreadOnly: query.get("unread") === "1", take: 50 })),
  route("POST", "/notifications/read", { licenseExempt: true }, async ({ ctx, req }) => {
    const b = z.object({ ids: z.union([z.literal("all"), z.array(uuid)]) }).parse(await json(req));
    return { updated: await markRead(ctx.user.id, b.ids) };
  }),
  route("GET", "/roles/mine", { licenseExempt: true }, async ({ ctx }) => ({ isPrimaryAdmin: ctx.user.isPrimaryAdmin, count: await db.userRole.count({ where: { userId: ctx.user.id } }) }))
];
