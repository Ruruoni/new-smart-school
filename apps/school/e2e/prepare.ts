import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import pg from "pg";
import { reapStaleWorker } from "./worker";
import { ADMIN_DB_URL, APP_ENV, CLOUD_DB, CLOUD_DB_URL, CLOUD_DIR, CLOUD_ENV, DATABASE_URL, E2E_DB, OPERATOR, SUPPORT_OPERATOR, VIEWER_OPERATOR } from "./env";

/** Fresh database + storage for every e2e run, migrated with the real migrations. Runs BEFORE the servers start (pnpm e2e). */
async function main() {
  reapStaleWorker(); // a worker left by a previous run would keep writing heartbeats into the fresh database
  const c = new pg.Client({ connectionString: ADMIN_DB_URL });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${E2E_DB} WITH (FORCE)`);
  await c.query(`CREATE DATABASE ${E2E_DB}`);
  await c.query(`DROP DATABASE IF EXISTS ${CLOUD_DB} WITH (FORCE)`);
  await c.query(`CREATE DATABASE ${CLOUD_DB}`);
  await c.end();
  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL }, stdio: "pipe" });
  // the Control Tower's database, migrated with its own migrations, with one operator per role created through the real CLI
  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], { cwd: CLOUD_DIR, env: { ...process.env, CLOUD_DATABASE_URL: CLOUD_DB_URL }, stdio: "pipe" });
  for (const [o, role] of [[OPERATOR, "SUPER_ADMIN"], [SUPPORT_OPERATOR, "SUPPORT"], [VIEWER_OPERATOR, "VIEWER"]] as const)
    execFileSync("pnpm", ["exec", "tsx", "scripts/create-operator.ts", o.email, o.name, o.password, role], { cwd: CLOUD_DIR, env: { ...process.env, ...CLOUD_ENV, NODE_ENV: "development" }, stdio: "pipe" });
  await rm(CLOUD_ENV.BACKUP_STORAGE_DIR, { recursive: true, force: true });
  await rm(APP_ENV.STORAGE_DIR, { recursive: true, force: true });
  await rm(APP_ENV.BACKUP_DIR, { recursive: true, force: true });
  await rm("e2e/.state.json", { force: true });
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
