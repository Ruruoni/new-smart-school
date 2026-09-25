/**
 * Container health check for the background worker: exit 0 only if a worker has beaten in the last 90 seconds.
 * A worker process can be alive but wedged (or unable to reach the database); its heartbeat row is the truthful signal.
 *   pnpm exec tsx scripts/worker-health.ts
 */
import pg from "pg";

const WORKER_ALIVE_SECONDS = 90;
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is not set"); process.exit(2); }

const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
try {
  await client.connect();
  const { rows } = await client.query<{ age: number | null }>(`SELECT EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'UTC') - MAX("lastBeatAt")))::float AS age FROM worker_heartbeats WHERE status <> 'STOPPED'`);
  const age = rows[0]?.age;
  if (age === null || age === undefined) { console.error("no worker has ever reported"); process.exit(1); }
  if (age > WORKER_ALIVE_SECONDS) { console.error(`last worker heartbeat was ${Math.round(age)}s ago`); process.exit(1); }
  console.log(`worker healthy (last beat ${Math.round(age)}s ago)`);
} catch (e) {
  console.error(`worker health check failed: ${(e as Error).message}`);
  process.exit(1);
} finally {
  await client.end().catch(() => undefined);
}
