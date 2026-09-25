import { safeRoute } from "@cloud/server/safe-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = safeRoute(async () => (await import("@cloud/server/api")).handleSyncBatch);
