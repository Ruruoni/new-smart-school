import { runHealthChecks } from "@cloud/server/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 200 only if configuration, database and schema are all fine; otherwise 503 saying which stage failed. */
export async function GET() {
  const r = await runHealthChecks(crypto.randomUUID());
  return Response.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
