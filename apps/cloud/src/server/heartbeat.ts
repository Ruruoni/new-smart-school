import { HeartbeatRequest, type HeartbeatResponse } from "@smartschool/protocol";
import { db, transact, type Tx } from "./db";
import { badRequest } from "./errors";
import { effectiveFlags, licenseTokenFor } from "./installations";
import { signCommand } from "./signing";
import { evaluateAlerts } from "./alerts";
import type { Installation } from "@cloud/generated/prisma/client";

const KEEP_HEARTBEATS = 500;

export async function processHeartbeat(inst: Installation, raw: unknown, ip: string | null): Promise<HeartbeatResponse> {
  const p = HeartbeatRequest.safeParse(raw);
  if (!p.success) throw badRequest("Invalid heartbeat", p.error.issues.slice(0, 5).map((i) => ({ path: i.path.join("."), message: i.message })));
  if (p.data.installationCode !== inst.code) throw badRequest("Heartbeat does not belong to this installation");
  const hb = p.data;
  const now = new Date();

  const fresh = await transact(async (tx: Tx) => {
    const updated = await tx.installation.update({ where: { id: inst.id }, data: { lastHeartbeatAt: now, lastIp: ip, appVersion: hb.appVersion, schemaVersion: hb.schemaVersion, lastMetrics: { ...hb.metrics, enabledModules: hb.enabledModules, licenseStatus: hb.licenseStatus } as never, studentCount: hb.metrics.studentCount } });
    await tx.heartbeatLog.create({ data: { installationId: inst.id, metrics: hb.metrics as never, appVersion: hb.appVersion } });
    if (hb.appliedCommandIds.length) await tx.command.updateMany({ where: { installationId: inst.id, id: { in: hb.appliedCommandIds }, deliveredAt: null }, data: { deliveredAt: now } });
    // keep the log bounded
    const old = await tx.heartbeatLog.findMany({ where: { installationId: inst.id }, orderBy: { receivedAt: "desc" }, skip: KEEP_HEARTBEATS, select: { id: true } });
    if (old.length) await tx.heartbeatLog.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
    return updated;
  });
  await evaluateAlerts(fresh, hb.metrics);

  const pending = await db.command.findMany({ where: { installationId: inst.id, deliveredAt: null, expiresAt: { gt: now } }, orderBy: { issuedAt: "asc" }, take: 10 });
  const commands = await Promise.all(pending.map((c) => signCommand({ code: inst.code, id: c.id, cmd: c.type as never, args: c.args as Record<string, unknown>, expiresAt: c.expiresAt })));
  const latest = await db.release.findFirst({ orderBy: { publishedAt: "desc" } });
  return { serverTime: now.toISOString(), licenseToken: await licenseTokenFor(fresh), flags: await effectiveFlags(fresh), commands, latestVersion: latest?.version ?? null };
}
