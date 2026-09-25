import type { Tx } from "./db";

/**
 * Atomic per-key counter (receipts, invoices, admission numbers). Uses INSERT … ON CONFLICT DO UPDATE
 * so concurrent callers never get the same number, and the increment rolls back with the caller's tx.
 */
export async function nextNumber(tx: Tx, key: string): Promise<number> {
  const rows = await tx.$queryRaw<{ n: number }[]>`
    INSERT INTO number_sequences ("key", "nextVal") VALUES (${key}, 2)
    ON CONFLICT ("key") DO UPDATE SET "nextVal" = number_sequences."nextVal" + 1
    RETURNING "nextVal" - 1 AS n`;
  return Number(rows[0]!.n);
}

export async function formatted(tx: Tx, prefix: string, scope: string | number, width = 5): Promise<string> {
  const n = await nextNumber(tx, `${prefix}:${scope}`);
  return `${prefix}/${scope}/${String(n).padStart(width, "0")}`;
}
