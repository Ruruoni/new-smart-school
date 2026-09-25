import { randomUUID } from "node:crypto";
import { toSafeError } from "@/platform/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ path?: string[] }> };

/**
 * The API is loaded lazily so that a failure while STARTING it (missing configuration, unreachable database at import time)
 * comes back as a structured JSON error the pages can explain — not as a raw framework 500 with an empty body, which the
 * browser could only show as "Something went wrong". Nothing here bypasses the security interceptor: once the API loads,
 * every request goes through it exactly as before.
 */
const dispatch = async (req: Request, ctx: Ctx) => {
  let handle: (req: Request, path: string[]) => Promise<Response>;
  try {
    ({ handle } = await import("@/api/index"));
  } catch (err) {
    const requestId = randomUUID();
    const safe = toSafeError(err, requestId);
    return Response.json(safe.body, { status: safe.status, headers: { "x-request-id": requestId, "cache-control": "no-store" } });
  }
  return handle(req, (await ctx.params).path ?? []);
};

export const GET = dispatch;
export const POST = dispatch;
export const PUT = dispatch;
export const PATCH = dispatch;
export const DELETE = dispatch;
