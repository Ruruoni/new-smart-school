import { randomUUID } from "node:crypto";
import type { Tx } from "@/platform/db";
import { Decimal } from "@/platform/db";

type Money = Decimal | number | string;
import type { LedgerAccount } from "@/generated/prisma/client";

export interface JournalLine {
  account: LedgerAccount;
  debit?: Money;
  credit?: Money;
}

/**
 * Post one balanced journal. The database independently rejects an unbalanced journal at COMMIT, so a bug
 * here fails loudly instead of corrupting the books. Zero-valued lines are dropped.
 */
export async function postJournal(
  tx: Tx,
  j: { refType: string; refId: string; studentId?: string | null; memo?: string; lines: JournalLine[]; createdById?: string | null; reversalOfJournalId?: string | null; entryDate?: Date },
): Promise<string> {
  const journalId = randomUUID();
  const rows = j.lines
    .map((l) => ({ account: l.account, debit: new Decimal(l.debit ?? 0), credit: new Decimal(l.credit ?? 0) }))
    .filter((l) => l.debit.gt(0) || l.credit.gt(0));
  if (!rows.length) return journalId;
  const d = rows.reduce((s, r) => s.plus(r.debit), new Decimal(0));
  const c = rows.reduce((s, r) => s.plus(r.credit), new Decimal(0));
  if (!d.eq(c)) throw new Error(`Refusing to post unbalanced journal (${d} vs ${c}) for ${j.refType}`);
  await tx.financialLedger.createMany({
    data: rows.map((r) => ({
      journalId, account: r.account, debit: r.debit, credit: r.credit, refType: j.refType, refId: j.refId, studentId: j.studentId ?? null,
      memo: j.memo, createdById: j.createdById ?? null, reversalOfJournalId: j.reversalOfJournalId ?? null, entryDate: j.entryDate ?? new Date(),
    })),
  });
  return journalId;
}

/** Post the exact mirror of every journal matching (refType, refId). History is preserved; nothing is edited. */
export async function reverseJournals(tx: Tx, refType: string, refId: string, memo: string, createdById?: string | null): Promise<number> {
  const lines = await tx.financialLedger.findMany({ where: { refType, refId, reversalOfJournalId: null }, orderBy: { seq: "asc" } });
  const byJournal = new Map<string, typeof lines>();
  for (const l of lines) (byJournal.get(l.journalId) ?? byJournal.set(l.journalId, []).get(l.journalId)!).push(l);
  for (const [journalId, ls] of byJournal) {
    await postJournal(tx, {
      refType: `${refType}_REVERSAL`, refId, studentId: ls[0]!.studentId, memo, createdById, reversalOfJournalId: journalId,
      lines: ls.map((l) => ({ account: l.account, debit: l.credit, credit: l.debit })),
    });
  }
  return byJournal.size;
}

/** Sum of (debit − credit) per account, optionally scoped to a student. */
export async function accountBalances(tx: Pick<Tx, "financialLedger">, where: { studentId?: string; from?: Date; to?: Date } = {}) {
  const rows = await tx.financialLedger.groupBy({
    by: ["account"],
    where: { studentId: where.studentId, entryDate: { gte: where.from, lte: where.to } },
    _sum: { debit: true, credit: true },
  });
  const out = {} as Record<LedgerAccount, Decimal>;
  for (const r of rows) out[r.account] = new Decimal(r._sum.debit ?? 0).minus(r._sum.credit ?? 0);
  return out;
}
