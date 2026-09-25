#!/usr/bin/env node
/**
 * Start-up preflight for the SmartSchool containers (school app and Control Tower). Runs from the app's directory, before the app starts.
 *
 *   node preflight.mjs <school|cloud> <web|worker>
 *
 * It exists because "the container is running" says nothing about whether the app can work. It:
 *   1. checks the required configuration BY NAME (never printing values) and tells the installer exactly what is missing;
 *   2. waits for PostgreSQL and, when it can't connect, says WHY (host doesn't resolve, nothing listening, wrong password,
 *      database missing) — creating the database if it is merely missing;
 *   3. applies pending migrations (web), or waits until they have been applied (worker);
 * then hands over to the real process. A web process with bad configuration still starts, in a degraded mode that answers every
 * request with an explanatory 503 and reports itself unhealthy, so the browser shows the real problem instead of a blank failure.
 * A worker with bad configuration exits (code 78) so the orchestrator shows it as failed rather than pretending it runs.
 *
 * Environment: WAIT_FOR_DB_SECONDS (60), AUTO_CREATE_DATABASE (true), AUTO_MIGRATE (true).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(join(process.cwd(), "package.json"));
const pg = require("pg");

const [app, role = "web"] = process.argv.slice(2);
const SPECS = {
  school: { dbVar: "DATABASE_URL", required: ["DATABASE_URL", "APP_ENCRYPTION_KEY", "APP_SIGNING_SECRET"], key32: ["APP_ENCRYPTION_KEY", "APP_SIGNING_SECRET"], sentinel: "school_installation", compose: "deploy/docker-compose.school.yml" },
  cloud: { dbVar: "CLOUD_DATABASE_URL", required: ["CLOUD_DATABASE_URL", "CLOUD_ENCRYPTION_KEY", "CLOUD_SIGNING_PRIVATE_KEY", "CLOUD_SIGNING_PUBLIC_KEY"], key32: ["CLOUD_ENCRYPTION_KEY"], sentinel: "installations", compose: "deploy/docker-compose.cloud.yml" },
};
const spec = SPECS[app];
if (!spec) { console.error(`[preflight] unknown app "${app}" (expected school or cloud)`); process.exit(2); }

const say = (m = "") => console.log(m ? `[preflight] ${m}` : "");
const redact = (s) => String(s).replace(/(:\/\/[^:/\s@]+:)[^@\s]+@/g, "$1<redacted>@");
const bad = (lines) => { console.error("\n" + "=".repeat(78)); for (const l of lines) console.error(l); console.error("=".repeat(78) + "\n"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────── 1. configuration ───────────
function configProblems() {
  const problems = [];
  for (const name of spec.required) if (!process.env[name]) problems.push(`${name} is not set`);
  for (const name of spec.key32) {
    const v = process.env[name];
    if (v && Buffer.from(v, "base64").length !== 32) problems.push(`${name} is set but is not 32 random bytes, base64 (generate one with: openssl rand -base64 32)`);
  }
  const url = process.env[spec.dbVar];
  if (url) { try { const u = new URL(url); if (!/^postgres(ql)?:$/.test(u.protocol)) problems.push(`${spec.dbVar} must be a postgresql:// URL`); } catch { problems.push(`${spec.dbVar} is not a valid URL`); } }
  return problems;
}

const problems = configProblems();
if (problems.length) {
  bad([
    `SMARTSCHOOL (${app}) CANNOT START PROPERLY — CONFIGURATION PROBLEM`,
    "",
    ...problems.map((p) => `  • ${p}`),
    "",
    "The application reads these from its ENVIRONMENT. A container started with a bare `docker run <image>` has none.",
    `Recommended: start it with Docker Compose, which supplies all of them:  docker compose -f ${spec.compose} --env-file <your .env> up -d`,
    "Or pass them yourself:  docker run -e VAR=value …  (see docs/deployment.md, 'Running with plain docker run').",
  ]);
  if (role === "worker") process.exit(78);
  say("starting in DEGRADED mode: every request will be answered with an explanatory error, and the health check will report unhealthy.");
  process.exit(0);
}

// ─────────── 2. database ───────────
const dbUrl = process.env[spec.dbVar];
const target = (() => { const u = new URL(dbUrl); return { user: decodeURIComponent(u.username), host: u.hostname, port: u.port || "5432", db: decodeURIComponent(u.pathname.slice(1)) }; })();
const label = `${target.user}@${target.host}:${target.port}/${target.db}`;

function kindOf(err) {
  const c = err?.code, m = String(err?.message ?? "");
  if (c === "ENOTFOUND" || c === "EAI_AGAIN") return "dns";
  if (c === "ECONNREFUSED") return "refused";
  if (c === "28P01" || c === "28000") return "auth";
  if (c === "3D000") return "nodb";
  if (c === "57P03") return "starting";
  if (/timeout|timed out/i.test(m)) return "timeout";
  return "other";
}
function hint(kind) {
  const inDocker = existsSync("/.dockerenv");
  switch (kind) {
    case "dns": return [`The hostname "${target.host}" does not resolve from inside this container.`, inDocker ? "On Docker's DEFAULT bridge network containers cannot find each other by name. Use Docker Compose, or create a network (docker network create smartschool) and start BOTH containers with --network smartschool, or use host.docker.internal / the host's IP." : "Check the host name in the connection URL."];
    case "timeout": return [`Connecting to ${target.host}:${target.port} timed out.`, "If the host is another container, it may be on a different Docker network (on the default bridge, names don't resolve and connections to an unknown name time out). If it is on your computer, use host.docker.internal instead of localhost — inside a container, 'localhost' is the container itself."];
    case "refused": return [`Nothing is accepting connections at ${target.host}:${target.port}.`, target.host === "localhost" || target.host === "127.0.0.1" ? "Inside a container 'localhost' is THIS container, not your computer or the database container. Use the database container's name (same Docker network) or host.docker.internal." : "Is the database container running, and is that the right port?"];
    case "auth": return [`PostgreSQL rejected the user "${target.user}" or its password.`, "Check the password in the connection URL against POSTGRES_PASSWORD of the database container (it only applies the first time the data volume is created)."];
    case "nodb": return [`The database "${target.db}" does not exist on that server.`];
    case "starting": return ["PostgreSQL is still starting up."];
    default: return ["Unexpected connection error."];
  }
}

async function tryConnect(url) {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 4000 });
  try { await c.connect(); await c.query("SELECT 1"); return { ok: true }; }
  catch (err) { return { ok: false, err }; }
  finally { await c.end().catch(() => undefined); }
}

async function createDatabase() {
  if (process.env.AUTO_CREATE_DATABASE === "false") return false;
  if (!/^[A-Za-z0-9_]+$/.test(target.db)) return false;
  const admin = new URL(dbUrl); admin.pathname = "/postgres";
  const c = new pg.Client({ connectionString: admin.toString(), connectionTimeoutMillis: 4000 });
  try { await c.connect(); await c.query(`CREATE DATABASE "${target.db}"`); say(`created the missing database "${target.db}"`); return true; }
  catch (e) { say(`could not create database "${target.db}": ${redact(e.message)}`); return false; }
  finally { await c.end().catch(() => undefined); }
}

async function waitForDb() {
  const total = Number(process.env.WAIT_FOR_DB_SECONDS ?? 60) * 1000;
  const start = Date.now();
  say(`checking the database ${label} …`);
  let last = "", tries = 0;
  while (true) {
    tries += 1;
    const r = await tryConnect(dbUrl);
    if (r.ok) { say(`database reachable (${label})`); return true; }
    const kind = kindOf(r.err);
    if (kind === "nodb" && (await createDatabase())) continue;
    if (kind !== last) { say(`cannot connect (${kind}): ${redact(r.err?.message ?? r.err)}`); for (const h of hint(kind)) say(`  → ${h}`); last = kind; }
    else if (tries % 10 === 0) say(`still cannot connect (${kind}) after ${Math.round((Date.now() - start) / 1000)}s …`);
    // a name that will never resolve, or a wrong password, is not going to fix itself while we wait
    const patience = kind === "auth" ? 10_000 : kind === "dns" || kind === "timeout" ? 20_000 : total;
    if (Date.now() - start >= Math.min(total, patience)) return false;
    await sleep(2000);
  }
}

// ─────────── 3. schema ───────────
const migrationsOnDisk = () => { try { return readdirSync(join(process.cwd(), "prisma", "migrations"), { withFileTypes: true }).filter((d) => d.isDirectory() && /^\d{14}_/.test(d.name)).length; } catch { return null; } };
async function appliedMigrations() {
  const c = new pg.Client({ connectionString: dbUrl, connectionTimeoutMillis: 4000 });
  try { await c.connect(); const r = await c.query("SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL"); return r.rows[0].n; }
  catch { return 0; } finally { await c.end().catch(() => undefined); }
}
function migrate() {
  const bin = join(process.cwd(), "node_modules", ".bin", "prisma");
  say("applying database migrations (prisma migrate deploy) …");
  const r = spawnSync(bin, ["migrate", "deploy"], { env: process.env, encoding: "utf8" });
  const out = redact(`${r.stdout ?? ""}${r.stderr ?? ""}`).trim().split("\n").slice(-12).join("\n");
  if (r.status === 0) { say("migrations are up to date"); return true; }
  bad([`DATABASE MIGRATION FAILED (exit ${r.status})`, "", out, "", "The database was NOT changed by a half-applied step (each migration runs in a transaction). Fix the cause above and restart."]);
  return false;
}
async function waitForSchema() {
  const expected = migrationsOnDisk();
  const total = Number(process.env.WAIT_FOR_SCHEMA_SECONDS ?? 120) * 1000, start = Date.now();
  say(`waiting for the database schema (${expected ?? "?"} migrations expected) …`);
  while (Date.now() - start < total) { if (expected === null || (await appliedMigrations()) >= expected) { say("schema is ready"); return true; } await sleep(3000); }
  return false;
}

const dbOk = await waitForDb();
if (!dbOk) {
  bad([`SMARTSCHOOL (${app}) CANNOT REACH ITS DATABASE (${label})`, "", ...hint(kindOf((await tryConnect(dbUrl)).err)).map((h) => `  • ${h}`)]);
  if (role === "worker") process.exit(1);
  say("starting in DEGRADED mode: the health check reports the database as unreachable and will recover by itself once it is reachable.");
  process.exit(0);
}
if (role === "worker") { if (!(await waitForSchema())) { bad(["THE DATABASE SCHEMA IS NOT READY", "", "The web application (or the `migrate` service) applies migrations; the worker waited but they did not complete."]); process.exit(1); } process.exit(0); }
if (process.env.AUTO_MIGRATE === "false") { say("AUTO_MIGRATE=false: not applying migrations"); process.exit(0); }
if (!migrate()) say("starting in DEGRADED mode: the health check reports the schema as not migrated.");
process.exit(0);
