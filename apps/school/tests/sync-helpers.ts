import { db } from "@/platform/db";
export async function getFlagSource(key: string) {
  const f = await db.featureFlag.findUniqueOrThrow({ where: { key } });
  return { enabled: f.enabled, source: f.source };
}
