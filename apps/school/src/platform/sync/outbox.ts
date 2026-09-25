import type { Tx } from "../db";
import type { Prisma } from "@/generated/prisma/client";
import { SYNC_ENTITIES, type SyncEntityType } from "./registry";

type Row = Record<string, unknown> & { id: string };

function plain(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (v !== null && typeof v === "object" && "toFixed" in v) return String(v); // Prisma.Decimal → exact string
  if (typeof v === "bigint") return v.toString();
  return v;
}

/** Project a row down to the entity's allow-listed fields. */
export function projectForSync(type: SyncEntityType, row: Row): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of SYNC_ENTITIES[type].fields) if (f in row) out[f] = plain(row[f]);
  return out;
}

/**
 * Write the sync record in the SAME transaction as the mutation (transactional outbox). The idempotency
 * key is derived from entity + version + operation, so re-enqueueing the same state is a no-op.
 */
export async function enqueueSync(tx: Tx, type: SyncEntityType, row: Row, operation: "UPSERT" | "DELETE" = "UPSERT"): Promise<void> {
  const version = typeof row.version === "number" ? row.version : 1;
  const idempotencyKey = `${type}:${row.id}:v${version}:${operation}`;
  await tx.syncQueue.createMany({
    data: [
      {
        entityType: type,
        entityId: row.id,
        operation,
        payload: projectForSync(type, row) as Prisma.InputJsonValue,
        entityVersion: version,
        idempotencyKey,
      },
    ],
    skipDuplicates: true,
  });
}
