import { db } from "@/platform/db";
import { installWithDefaults } from "@/bootstrap";
import { hashPassword } from "@/platform/password";
import { login, resetLoginThrottle, SESSION_COOKIE } from "@/platform/auth/service";
import { invalidateLicenseCache } from "@/platform/license";
import type { UserType } from "@/generated/prisma/client";

/** Wipe every table (the append-only triggers only guard row DELETE/UPDATE, not TRUNCATE). */
export async function resetDb() {
  const rows = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = rows.map((r) => `"${r.tablename}"`).join(", ");
  await db.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
  invalidateLicenseCache();
  resetLoginThrottle();
}

export const ADMIN = { username: "owner", password: "Owner-pass-123" };

export async function installTestSchool() {
  return installWithDefaults({
    schoolName: "Greenfield College",
    admin: { username: ADMIN.username, password: ADMIN.password, firstName: "Ada", lastName: "Obi" },
  });
}

export async function makeUser(opts: { username: string; type?: UserType; roles?: string[]; password?: string; mustChange?: boolean }) {
  const user = await db.user.create({
    data: {
      username: opts.username,
      passwordHash: await hashPassword(opts.password ?? "Passw0rd-test"),
      firstName: opts.username,
      lastName: "Tester",
      userType: opts.type ?? "STAFF",
      mustChangePassword: opts.mustChange ?? false,
    },
  });
  for (const key of opts.roles ?? []) {
    const role = await db.role.findUniqueOrThrow({ where: { key } });
    await db.userRole.create({ data: { userId: user.id, roleId: role.id } });
  }
  return user;
}

export async function sessionFor(username: string, password = "Passw0rd-test") {
  const r = await login({ username, password });
  return `${SESSION_COOKIE}=${r.token}`;
}

export function req(path: string, opts: { method?: string; cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers = new Headers({ host: "school.local", ...(opts.headers ?? {}) });
  if (opts.cookie) headers.set("cookie", opts.cookie);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`http://school.local${path}`, { method: opts.method ?? "GET", headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
}
