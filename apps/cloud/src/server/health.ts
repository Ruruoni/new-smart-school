import { readdirSync } from "node:fs";
import { join } from "node:path";
import { classifyInfrastructureError } from "@smartschool/protocol";
import { CloudConfigError, logServerError as rawLog, shouldLogRepeated } from "./errors";

// Health is polled constantly: log a failing stage once per 30 s, not on every poll.
const logServerError: typeof rawLog = (id, err, extra) => { if (shouldLogRepeated(`health:${String(extra?.check)}`)) rawLog(id, err, extra); };

export type CheckState = "ok" | "fail" | "skipped";
export interface HealthReport { ok: boolean; status: 200 | 503; body: { ok: boolean; code?: string; message?: string; checks: { config: CheckState; database: CheckState; schema: CheckState }; time: string } }

const migrationsOnDisk = (cwd = process.cwd()): number | null => {
  try { return readdirSync(join(cwd, "prisma", "migrations"), { withFileTypes: true }).filter((d) => d.isDirectory() && /^\d{14}_/.test(d.name)).length; } catch { return null; }
};

/** Config valid → database reachable → schema migrated. Imports env/db lazily so a broken configuration yields an explanatory 503, not a crash. Public: reports only which stage failed. */
export async function runHealthChecks(requestId = "health"): Promise<HealthReport> {
  const checks: HealthReport["body"]["checks"] = { config: "skipped", database: "skipped", schema: "skipped" };
  const done = (ok: boolean, code?: string, message?: string): HealthReport => ({ ok, status: ok ? 200 : 503, body: { ok, ...(code ? { code, message } : {}), checks, time: new Date().toISOString() } });
  try { (await import("./env")).env(); checks.config = "ok"; }
  catch (err) { checks.config = "fail"; logServerError(requestId, err, { check: "config" }); return done(false, "SERVER_MISCONFIGURED", err instanceof CloudConfigError ? err.message : "The Control Tower's configuration could not be loaded."); }
  try {
    const { db } = await import("./db");
    await db.$queryRaw`SELECT 1`;
    checks.database = "ok";
    const present = (await db.$queryRaw<{ present: boolean }[]>`SELECT to_regclass('public.installations') IS NOT NULL AS present`)[0]?.present === true;
    let applied: number | null = null;
    try { applied = Number((await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)[0]?.n ?? 0); } catch { applied = null; }
    const expected = migrationsOnDisk();
    if (!present || (expected !== null && applied !== null && applied < expected)) {
      checks.schema = "fail";
      logServerError(requestId, new Error(`schema not up to date: applied ${applied ?? "?"} of ${expected ?? "?"} migrations, installations table ${present ? "present" : "missing"}`), { check: "schema" });
      return done(false, "DATABASE_NOT_MIGRATED", "The database hasn't been fully set up yet (its migrations haven't been applied).");
    }
    checks.schema = "ok";
    return done(true);
  } catch (err) {
    if (checks.database === "skipped") checks.database = "fail";
    const infra = classifyInfrastructureError(err);
    logServerError(requestId, err, { check: checks.database === "ok" ? "schema" : "database" });
    return done(false, infra?.code ?? "DATABASE_UNAVAILABLE", infra?.message ?? "The database can't be reached right now.");
  }
}
