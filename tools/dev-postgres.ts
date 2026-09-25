/**
 * Dev/CI PostgreSQL without Docker or root: a real PostgreSQL server (embedded-postgres binaries).
 * Production school servers use PostgreSQL from docker-compose; this is only a development convenience.
 *
 *   pnpm dev:db            start (foreground) on :5433, creating the databases below on first run
 */
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const PORT = Number(process.env.DEV_PG_PORT ?? 5433);
const DATA_DIR = resolve(process.env.DEV_PG_DIR ?? ".data/pg");
const DATABASES = ["smartschool_school", "smartschool_cloud", "smartschool_school_test", "smartschool_cloud_test"];

async function main() {
  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: "smartschool",
    password: "smartschool",
    port: PORT,
    persistent: true,
  });
  const fresh = !existsSync(resolve(DATA_DIR, "PG_VERSION"));
  if (fresh) await pg.initialise();
  await pg.start();
  for (const name of DATABASES) {
    try {
      await pg.createDatabase(name);
      console.log(`created database ${name}`);
    } catch {
      /* already exists */
    }
  }
  console.log(`PostgreSQL ready on postgresql://smartschool:smartschool@localhost:${PORT}`);
  const stop = async () => {
    await pg.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  setInterval(() => undefined, 1 << 30);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
