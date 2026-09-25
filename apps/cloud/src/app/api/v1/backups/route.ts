import { safeRoute } from "@cloud/server/safe-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const PUT = safeRoute(async () => (await import("@cloud/server/api")).handleBackupUpload);
