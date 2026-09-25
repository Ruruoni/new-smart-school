import { readdirSync } from "node:fs";
import { join } from "node:path";
import { classifyInfrastructureError, ConfigError, logServerError as rawLog, shouldLogRepeated } from "./errors";

// Health is polled constantly (Docker, every open browser): log a failing stage once per 30 s, not on every poll.
const logServerError: typeof rawLog = (id, err, extra) => { if (shouldLogRepeated(`health:${String(extra?.check)}`)) rawLog(id, err, extra); };

/**
 * A health answer that means something: is the configuration valid, can the app reach its database, and has the schema been
 * migrated to what this build expects? It imports the environment and the database LAZILY, so a broken configuration produces
 * an explanatory 503 here instead of a crash — and so a container health check goes unhealthy for the real reason.
 * Public by design, so it reports only which stage failed (never variable names, hosts or credentials); the server log has the detail.
 */
export type CheckState = "ok" | "fail" | "skipped";
export interface HealthReport {
  ok: boolean;
  status: 200 | 503;
  body: { ok: boolean; code?: string; message?: string; checks: { config: CheckState; database: CheckState; schema: CheckState }; time: string };
}

/** Migrations shipped with this build (the folder is part of the image and of a source checkout). */
export function expectedMigrationCount(cwd = process.cwd()): number | null {
  try { return readdirSync(join(cwd, "prisma", "migrations"), { withFileTypes: true }).filter((d) => d.isDirectory() && /^\d{14}_/.test(d.name)).length; }
  catch { return null; }
}

export async function runHealthChecks(requestId = "health"): Promise<HealthReport> {
  const checks: HealthReport["body"]["checks"] = { config: "skipped", database: "skipped", schema: "skipped" };
  const done = (ok: boolean, code?: string, message?: string): HealthReport => ({ ok, status: ok ? 200 : 503, body: { ok, ...(code ? { code, message } : {}), checks, time: new Date().toISOString() } });

  try {
    const { env } = await import("./env");
    env();
    checks.config = "ok";
  } catch (err) {
    checks.config = "fail";
    logServerError(requestId, err, { check: "config" });
    return done(false, "SERVER_MISCONFIGURED", err instanceof ConfigError ? err.message : "The server's configuration could not be loaded.");
  }

  try {
    const { db } = await import("./db");
    await db.$queryRaw`SELECT 1`;
    checks.database = "ok";
    const expected = expectedMigrationCount();
    const present = (await db.$queryRaw<{ present: boolean }[]>`SELECT to_regclass('public.school_installation') IS NOT NULL AS present`)[0]?.present === true;
    let applied: number | null = null;
    try { applied = Number((await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)[0]?.n ?? 0); } catch { applied = null; }
    if (!present || (expected !== null && applied !== null && applied < expected)) {
      checks.schema = "fail";
      logServerError(requestId, new Error(`schema not up to date: applied ${applied ?? "?"} of ${expected ?? "?"} migrations, school_installation ${present ? "present" : "missing"}`), { check: "schema" });
      return done(false, "DATABASE_NOT_MIGRATED", "The school database hasn't been fully set up yet (its migrations haven't been applied).");
    }
    checks.schema = "ok";
    return done(true);
  } catch (err) {
    if (checks.database === "skipped") checks.database = "fail";
    const infra = classifyInfrastructureError(err);
    logServerError(requestId, err, { check: checks.database === "ok" ? "schema" : "database" });
    return done(false, infra?.code ?? "DATABASE_UNAVAILABLE", infra?.message ?? "The school database can't be reached right now.");
  }
}
