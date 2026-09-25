import { randomUUID } from "node:crypto";
import { runHealthChecks } from "@/platform/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness + readiness in one honest answer: 200 only if config, database and schema are all fine; otherwise 503 saying which stage failed. */
export async function GET() {
  const r = await runHealthChecks(randomUUID());
  return Response.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
