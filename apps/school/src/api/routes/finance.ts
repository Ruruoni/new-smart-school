import { z } from "zod";
import * as fin from "@/modules/finance/service";
import { evaluateFinancialLockout } from "@/modules/finance/lockout";
import { assertCanAccessStudent } from "@/platform/security/scope";
import { db } from "@/platform/db";
import { pageParams, uuid } from "@/platform/util";
import { json, pick, route, type RouteDef } from "../router";

const M = { module: "finance" as const };

export const financeRoutes: RouteDef[] = [
  route("GET", "/finance/summary", { ...M, permission: "finance.reports" }, async ({ query }) => fin.financeSummary({ from: query.get("from") ? new Date(query.get("from")!) : undefined, to: query.get("to") ? new Date(query.get("to")!) : undefined })),
  route("GET", "/finance/verify", { ...M, permission: "finance.reports" }, async () => fin.verifyFinance()),

  route("GET", "/finance/fee-structures", { ...M, permission: "finance.view" }, async () => fin.listFeeStructures()),
  route("POST", "/finance/fee-structures", { ...M, permission: "finance.manage_fees" }, async ({ ctx, req }) => fin.createFeeStructure(ctx, (await json(req)) as never)),
  route("PUT", "/finance/fee-structures/:id", { ...M, permission: "finance.manage_fees" }, async ({ ctx, req, params }) => fin.updateFeeStructure(ctx, params.id!, (await json(req)) as never)),

  route("GET", "/finance/discounts", { ...M, permission: "finance.view" }, async ({ query }) => db.studentDiscount.findMany({ where: { revokedAt: null, ...(query.get("studentId") ? { studentId: query.get("studentId")! } : {}) }, include: { student: { select: { firstName: true, lastName: true, admissionNumber: true } } }, orderBy: { createdAt: "desc" }, take: 200 })),
  route("POST", "/finance/discounts", { ...M, permission: "finance.manage_fees" }, async ({ ctx, req }) => fin.addDiscount(ctx, (await json(req)) as never)),
  route("DELETE", "/finance/discounts/:id", { ...M, permission: "finance.manage_fees" }, async ({ ctx, params }) => { await fin.revokeDiscount(ctx, params.id!); return { ok: true }; }),

  route("GET", "/finance/invoices", { ...M, permission: "finance.view" }, async ({ ctx, query }) => fin.listInvoices(ctx, pick(query))),
  route("GET", "/finance/invoices/:id", { ...M, permission: "finance.view" }, async ({ ctx, params }) => {
    const inv = await db.invoice.findUnique({ where: { id: params.id! }, include: { items: true, allocations: { include: { payment: { select: { receiptNumber: true, receivedAt: true, method: true, status: true } } } }, student: { select: { firstName: true, lastName: true, admissionNumber: true } }, term: { select: { name: true } } } });
    if (!inv) return null;
    if (inv.studentId) await assertCanAccessStudent(ctx, inv.studentId, "finance");
    else ctx.require("finance.create_payment");
    return inv;
  }),
  route("POST", "/finance/invoices/generate", { ...M, permission: "finance.create_invoice" }, async ({ ctx, req }) => fin.generateInvoice(ctx, (await json(req)) as never)),
  route("POST", "/finance/invoices/generate-class", { ...M, permission: "finance.create_invoice" }, async ({ ctx, req }) => fin.generateInvoicesForClass(ctx, (await json(req)) as never)),
  route("POST", "/finance/invoices/:id/issue", { ...M, permission: "finance.create_invoice" }, async ({ ctx, params }) => fin.issueInvoice(ctx, params.id!)),
  route("POST", "/finance/invoices/:id/void", { ...M, permission: "finance.void_invoice" }, async ({ ctx, req, params }) => fin.voidInvoice(ctx, params.id!, z.object({ reason: z.string() }).parse(await json(req)).reason)),

  route("GET", "/finance/payments", { ...M, permission: "finance.view" }, async ({ ctx, query }) => fin.listPayments(ctx, { ...pageParams(query), studentId: query.get("studentId") ?? undefined })),
  route("POST", "/finance/payments", { ...M, permission: "finance.create_payment" }, async ({ ctx, req }) => fin.recordPayment(ctx, (await json(req)) as never)),
  route("POST", "/finance/payments/:id/reverse", { ...M, permission: "finance.reverse_payment" }, async ({ ctx, req, params }) => fin.reversePayment(ctx, params.id!, z.object({ reason: z.string() }).parse(await json(req)).reason)),

  route("GET", "/finance/expenses", { ...M, permission: "finance.expenses" }, async ({ query }) => db.expense.findMany({ orderBy: { paidOn: "desc" }, take: Number(query.get("take") ?? 100) })),
  route("POST", "/finance/expenses", { ...M, permission: "finance.expenses" }, async ({ ctx, req }) => fin.recordExpense(ctx, (await json(req)) as never)),
  route("POST", "/finance/expenses/:id/void", { ...M, permission: "finance.expenses" }, async ({ ctx, req, params }) => fin.voidExpense(ctx, params.id!, z.object({ reason: z.string() }).parse(await json(req)).reason)),

  /** A family member's or bursar's statement of account for one student. */
  route("GET", "/finance/students/:id/statement", { ...M, permission: "finance.view" }, async ({ ctx, params }) => fin.studentStatement(ctx, params.id!)),
  /** Is this student locked out of results? Powers the payment-request screen; the enforcement itself is server-side in the results service. */
  route("GET", "/finance/students/:id/lockout", { permission: ["finance.view", "results.view", "self.view"] }, async ({ ctx, params }) => { await assertCanAccessStudent(ctx, params.id!, "finance"); return evaluateFinancialLockout(params.id!); }),
  route("GET", "/finance/ledger", { ...M, permission: "finance.reports" }, async ({ query }) => db.financialLedger.findMany({ where: query.get("studentId") ? { studentId: uuid.parse(query.get("studentId")) } : {}, orderBy: { seq: "desc" }, take: 200 }).then((rows) => rows.map((r) => ({ ...r, seq: r.seq.toString() })))),
];
