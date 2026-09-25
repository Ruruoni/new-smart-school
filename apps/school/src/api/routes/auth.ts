import { z } from "zod";
import { db } from "@/platform/db";
import { env } from "@/platform/env";
import { changeOwnPassword, login, logout, SESSION_COOKIE } from "@/platform/auth/service";
import { enabledModules } from "@/platform/features";
import { listNotifications, unreadCount } from "@/modules/communication/engine";
import { needsSetup, installWithDefaults } from "@/bootstrap";
import { InstallInput } from "@/platform/provision";
import { AppError, rateLimited } from "@/platform/errors";
import { cookieShouldBeSecure } from "@smartschool/protocol";
import { json, publicRoute, route, type RouteDef } from "../router";

function cookie(token: string, expires: Date, req: Request): string {
  const secure = cookieShouldBeSecure(env().SESSION_COOKIE_SECURE, req) ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${secure}`;
}
const clearCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

const setupHits = new Map<string, { n: number; reset: number }>();

export const authRoutes: RouteDef[] = [
  publicRoute("GET", "/setup/status", async () => ({ needsSetup: await needsSetup() })),

  publicRoute("POST", "/setup", async ({ req, ip }) => {
    if (!(await needsSetup())) throw new AppError("ALREADY_INSTALLED", "This installation has already been set up", 409);
    if (ip) {
      const now = Date.now(), h = setupHits.get(ip);
      if (!h || h.reset < now) setupHits.set(ip, { n: 1, reset: now + 600_000 });
      else if (++h.n > 10) throw rateLimited(Math.ceil((h.reset - now) / 1000));
    }
    const r = await installWithDefaults(InstallInput.parse(await json(req)));
    return { installationCode: r.installation.installationCode };
  }),

  publicRoute("POST", "/auth/login", async ({ req, ip }) => {
    const body = z.object({ username: z.string().min(1).max(80), password: z.string().min(1).max(200) }).parse(await json(req));
    const r = await login({ ...body, ip, userAgent: req.headers.get("user-agent") });
    const res = Response.json({ data: { mustChangePassword: r.mustChangePassword, userType: r.user.userType } });
    res.headers.append("set-cookie", cookie(r.token, r.expiresAt, req));
    return res;
  }),

  route("POST", "/auth/logout", { licenseExempt: true, allowPasswordChangePending: true }, async ({ ctx, req }) => {
    const token = /(?:^|;\s*)ss_session=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
    await logout(token ? decodeURIComponent(token) : null, { id: ctx.user.id, ip: ctx.ip });
    const res = Response.json({ data: { ok: true } });
    res.headers.append("set-cookie", clearCookie());
    return res;
  }),

  route("POST", "/auth/change-password", { licenseExempt: true, allowPasswordChangePending: true }, async ({ ctx, req }) => {
    const b = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8).max(128) }).parse(await json(req));
    await changeOwnPassword(ctx.user.id, b.currentPassword, b.newPassword, ctx.ip);
    const res = Response.json({ data: { ok: true } });
    res.headers.append("set-cookie", clearCookie()); // all sessions were revoked: sign in again with the new password
    return res;
  }),

  /** Everything the UI needs to render the shell — computed on the server from real grants, never trusted from the client. */
  route("GET", "/auth/me", { licenseExempt: true, allowPasswordChangePending: true }, async ({ ctx }) => {
    const [modules, inst, unread, banner, teacher, parent] = await Promise.all([
      enabledModules(), db.schoolInstallation.findFirstOrThrow({ select: { schoolName: true, shortName: true, logoFileId: true, primaryColor: true } }),
      unreadCount(ctx.user.id), db.systemSetting.findUnique({ where: { key: "cloud.message" } }),
      db.teacherProfile.findUnique({ where: { userId: ctx.user.id }, select: { id: true } }), db.parentProfile.findUnique({ where: { userId: ctx.user.id }, select: { id: true } }),
    ]);
    const perms = ctx.user.isPrimaryAdmin ? (await db.permission.findMany({ select: { key: true } })).map((p) => p.key) : [...ctx.permissions];
    return {
      user: { ...ctx.user, teacherId: teacher?.id ?? null, parentId: parent?.id ?? null },
      school: inst, permissions: perms, modules,
      license: { status: ctx.license.status, mode: ctx.license.mode, message: ctx.license.message, plan: ctx.license.plan },
      unreadNotifications: unread, banner: (banner?.value as { text?: string } | undefined)?.text ?? null,
      notifications: await listNotifications(ctx.user.id, { take: 5 }),
    };
  }),
];
