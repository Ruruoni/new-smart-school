import { db, Decimal } from "@/platform/db";
import type { SecurityContext } from "@/platform/security/context";
import { financialLockout } from "@/platform/errors";
import { getSetting } from "@/platform/settings";
import type { Policy } from "@/platform/security/interceptor";
import { visibleStudentIds } from "@/platform/security/scope";

export interface LockoutState {
  locked: boolean;
  outstanding: string;
  overdueInvoices: { number: string; balance: string; dueDate: string | null }[];
  message: string | null;
}

/**
 * Financial lockout is a BUSINESS POLICY, not RBAC. It looks at what a student owes (overdue by more than
 * the school's grace period, above the school's minimum), not at what the viewer's role may do.
 */
export async function evaluateFinancialLockout(studentId: string, now = new Date()): Promise<LockoutState> {
  const policy = await getSetting("finance.lockout");
  if (!policy.enabled) return { locked: false, outstanding: "0.00", overdueInvoices: [], message: null };
  const cutoff = new Date(now.getTime() - policy.graceDays * 86_400_000);
  const invoices = await db.invoice.findMany({
    where: { studentId, status: { in: ["ISSUED", "PARTIALLY_PAID"] }, dueDate: { lt: cutoff } },
    select: { number: true, total: true, amountPaid: true, dueDate: true },
    orderBy: { dueDate: "asc" },
  });
  const overdue = invoices.map((i) => ({ number: i.number, balance: new Decimal(i.total).minus(i.amountPaid), dueDate: i.dueDate }));
  const outstanding = overdue.reduce((s, i) => s.plus(i.balance), new Decimal(0));
  const locked = outstanding.gt(policy.minimumOutstanding) && outstanding.gt(0);
  return {
    locked,
    outstanding: outstanding.toFixed(2),
    overdueInvoices: overdue.map((i) => ({ number: i.number, balance: i.balance.toFixed(2), dueDate: i.dueDate?.toISOString().slice(0, 10) ?? null })),
    message: locked ? policy.message || "Outstanding school fees must be paid before results can be viewed." : null,
  };
}

/** Lockout applies to the people it is designed for (parents/students); staff are governed by RBAC + bypass. */
export function lockoutAppliesTo(ctx: SecurityContext): boolean {
  if (ctx.can("results.bypass_lockout")) return false;
  return ctx.user.userType === "PARENT" || ctx.user.userType === "STUDENT";
}

/** Throws FINANCIAL_LOCKOUT (403) with payment details when access to protected results must be blocked. */
export async function assertResultsAccessible(ctx: SecurityContext, studentId: string): Promise<void> {
  if (!lockoutAppliesTo(ctx)) return;
  const state = await evaluateFinancialLockout(studentId);
  if (state.locked) throw financialLockout({ outstanding: state.outstanding, invoices: state.overdueInvoices, message: state.message });
}

/** Route-level policy: `secure({ policies: [resultsLockoutPolicy((_, p) => p.studentId)] })`. Services re-check independently. */
export const resultsLockoutPolicy =
  (getStudentId: (ctx: SecurityContext, input: { req: Request; params: Record<string, string | string[]> }) => string | undefined): Policy<{ req: Request; params: Record<string, string | string[]> }> =>
  async (ctx, input) => {
    const id = getStudentId(ctx, input);
    if (id) return assertResultsAccessible(ctx, id);
    // No specific student in the URL (e.g. "my results"): apply to every visible child.
    const ids = await visibleStudentIds(ctx, "results");
    if (ids !== "ALL") for (const s of ids) await assertResultsAccessible(ctx, s);
  };
