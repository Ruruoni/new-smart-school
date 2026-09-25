import pg from "pg";
import { DATABASE_URL } from "./env";

/** Direct SQL against the e2e database, for the few things a real user can't do (e.g. simulating a worker that died minutes ago). */
export async function sql(query: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try { return (await c.query(query, params)).rows; } finally { await c.end(); }
}

/** Pretend the worker last reported `minutes` ago, so "is it alive?" turns false immediately instead of after 90 s. */
export const ageWorkerBeats = (minutes = 10) => sql(`UPDATE worker_heartbeats SET "lastBeatAt" = (now() AT TIME ZONE 'UTC') - ($1 || ' minutes')::interval`, [String(minutes)]);
