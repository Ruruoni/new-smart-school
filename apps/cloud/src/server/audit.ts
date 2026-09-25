import type { Tx } from "./db";
import { db } from "./db";

export interface CloudAuditEntry { operatorId?: string | null; operatorEmail?: string | null; action: string; installationId?: string | null; detail?: unknown; ip?: string | null }

export async function cloudAudit(tx: Tx | typeof db, e: CloudAuditEntry) {
  await tx.cloudAudit.create({ data: { operatorId: e.operatorId ?? null, operatorEmail: e.operatorEmail ?? null, action: e.action, installationId: e.installationId ?? null, detail: (e.detail ?? undefined) as never, ip: e.ip ?? null } });
}
