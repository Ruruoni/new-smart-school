import { db } from "@/platform/db";
import { backoffSeconds } from "@smartschool/protocol";
import { PermanentDeliveryError, providerFor, TransientDeliveryError } from "./providers";

const MAX_ATTEMPTS = 8;

export interface DeliveryStats {
  sent: number;
  retried: number;
  dead: number;
  notConfigured: number;
}

/**
 * Deliver queued messages. Safe to run from several workers (rows are claimed with SKIP LOCKED) and
 * safe to run offline: an unreachable/unconfigured provider just reschedules the row with back-off.
 */
export async function deliverPending(limit = 25): Promise<DeliveryStats> {
  const claimed = await db.$queryRaw<{ id: string }[]>`
    UPDATE notification_deliveries SET status = 'SENDING', attempts = attempts + 1
    WHERE id IN (SELECT id FROM notification_deliveries WHERE status IN ('QUEUED','FAILED') AND "nextAttemptAt" <= (now() AT TIME ZONE 'UTC') ORDER BY "createdAt" ASC LIMIT ${limit} FOR UPDATE SKIP LOCKED)
    RETURNING id`;
  const stats: DeliveryStats = { sent: 0, retried: 0, dead: 0, notConfigured: 0 };
  if (!claimed.length) return stats;
  const rows = await db.notificationDelivery.findMany({ where: { id: { in: claimed.map((c) => c.id) } } });
  for (const row of rows) {
    try {
      const provider = await providerFor(row.channel as Exclude<typeof row.channel, "IN_APP">);
      const res = await provider.send({ to: row.recipient, subject: row.subject, body: row.body });
      await db.notificationDelivery.update({ where: { id: row.id }, data: { status: "SENT", sentAt: new Date(), provider: provider.name, providerRef: res.providerRef || row.providerRef, lastError: null } });
      stats.sent += 1;
    } catch (err) {
      const message = (err as Error).message.slice(0, 500);
      const permanent = err instanceof PermanentDeliveryError;
      const exhausted = row.attempts >= MAX_ATTEMPTS;
      if (err instanceof TransientDeliveryError && /not configured/.test(message)) stats.notConfigured += 1;
      if (permanent || exhausted) {
        await db.notificationDelivery.update({ where: { id: row.id }, data: { status: "DEAD", lastError: message } });
        stats.dead += 1;
      } else {
        await db.notificationDelivery.update({ where: { id: row.id }, data: { status: "FAILED", lastError: message, nextAttemptAt: new Date(Date.now() + backoffSeconds(row.attempts - 1) * 1000) } });
        stats.retried += 1;
      }
    }
  }
  return stats;
}

export async function deliveryOverview() {
  const g = await db.notificationDelivery.groupBy({ by: ["channel", "status"], _count: true });
  return g.map((x) => ({ channel: x.channel, status: x.status, count: x._count }));
}

/** Re-queue dead messages after the school fixed provider credentials. */
export async function requeueDead(channel?: "EMAIL" | "SMS" | "WHATSAPP") {
  const r = await db.notificationDelivery.updateMany({ where: { status: "DEAD", ...(channel ? { channel } : {}) }, data: { status: "QUEUED", attempts: 0, nextAttemptAt: new Date() } });
  return r.count;
}
