import { safeRoute } from "@cloud/server/safe-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ path?: string[] }> };
const handler = safeRoute<Ctx>(async () => {
  const { handleOps } = await import("@cloud/server/ops");
  return async (req, ctx) => handleOps(req, (await ctx.params).path ?? []);
});
export { handler as GET, handler as POST, handler as PUT, handler as DELETE, handler as PATCH };
