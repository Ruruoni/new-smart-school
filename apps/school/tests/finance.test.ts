import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db, Decimal } from "@/platform/db";
import * as fin from "@/modules/finance/service";
import { evaluateFinancialLockout, assertResultsAccessible } from "@/modules/finance/lockout";
import { setSetting } from "@/platform/settings";
import * as people from "@/modules/people/service";
import { hashPassword } from "@/platform/password";
import { ctxFor, seedAcademics } from "./fixtures";
import { resetDb } from "./helpers";

let S: Awaited<ReturnType<typeof seedAcademics>>;
let studentId: string;

async function seed() {
  S = await seedAcademics();
  await fin.createFeeStructure(S.admin, { name: "JSS1 First Term", termId: S.t1.id, classId: S.jss1.id, items: [{ name: "Tuition", amount: 100000 }, { name: "PTA levy", amount: 5000 }, { name: "Uniform", amount: 20000, isOptional: true }] });
  const r = await people.createStudent(S.admin, { firstName: "Tola", lastName: "Bakare", gender: "FEMALE", classId: S.jss1.id, guardians: [{ newParent: { firstName: "Mrs", lastName: "Bakare", phone: "08022222222" }, relationship: "Mother" }] });
  studentId = r.student.id;
}
const key = () => randomUUID();
const pay = (amount: number, over = {}) => fin.recordPayment(S.admin, { studentId, amount, method: "BANK_TRANSFER", idempotencyKey: key(), ...over });
const D = (n: number | string) => new Decimal(n);

beforeEach(async () => {
  await resetDb();
  await seed();
});

describe("invoice pricing (pure)", () => {
  const charges = [{ name: "Tuition", amount: D(100000) }, { name: "Levy", amount: D(5000) }];
  it("percentage discount on subtotal", () => {
    const p = fin.priceInvoice(charges, [{ kind: "DISCOUNT", valueType: "PERCENT", value: D(10), reason: "Sibling" }]);
    expect(p.subtotal.toFixed(2)).toBe("105000.00");
    expect(p.discountTotal.toFixed(2)).toBe("10500.00");
    expect(p.total.toFixed(2)).toBe("94500.00");
  });
  it("caps discounts so an invoice never goes negative; scholarship applies first", () => {
    const p = fin.priceInvoice(charges, [
      { kind: "DISCOUNT", valueType: "FIXED", value: D(80000), reason: "Staff child" },
      { kind: "SCHOLARSHIP", valueType: "PERCENT", value: D(100), reason: "Full scholarship" },
    ]);
    expect(p.total.toFixed(2)).toBe("0.00");
    expect(p.lines.filter((l) => l.kind !== "CHARGE")).toHaveLength(1); // the discount had nothing left to discount
  });
  it("rounds percentages half-up to kobo", () => {
    const p = fin.priceInvoice([{ name: "X", amount: D(333.33) }], [{ kind: "DISCOUNT", valueType: "PERCENT", value: D(10), reason: "r" }]);
    expect(p.discountTotal.toFixed(2)).toBe("33.33");
  });
});

describe("billing", () => {
  it("generates and issues an invoice, posts a balanced journal, queues sync + event", async () => {
    await fin.addDiscount(S.admin, { studentId, kind: "SCHOLARSHIP", valueType: "PERCENT", value: 20, reason: "Merit" });
    const inv = await fin.generateInvoice(S.admin, { studentId, termId: S.t1.id, dueDate: "2025-09-30" });
    expect(inv.status).toBe("ISSUED");
    expect(inv.number).toMatch(/^INV\/\d{4}\/00001$/);
    expect(inv.subtotal.toString()).toBe("105000"); // optional uniform excluded
    expect(inv.total.toString()).toBe("84000");
    const lines = await db.financialLedger.findMany({ where: { refType: "INVOICE", refId: inv.id } });
    const dr = lines.reduce((s, l) => s.plus(l.debit), D(0)), cr = lines.reduce((s, l) => s.plus(l.credit), D(0));
    expect(dr.eq(cr)).toBe(true);
    expect(lines.find((l) => l.account === "RECEIVABLE")?.debit.toString()).toBe("84000");
    expect(await db.syncQueue.count({ where: { entityType: "invoice" } })).toBeGreaterThan(0);
    expect(await db.domainEvent.count({ where: { type: "invoice.issued" } })).toBe(1);
    expect((await fin.verifyFinance()).ok).toBe(true);
  });
  it("includes selected optional items and refuses double billing", async () => {
    const inv = await fin.generateInvoice(S.admin, { studentId, termId: S.t1.id, optionalItemNames: ["Uniform"] });
    expect(inv.subtotal.toString()).toBe("125000");
    await expect(fin.generateInvoice(S.admin, { studentId, termId: S.t1.id })).rejects.toThrow(/already been billed/);
  });
  it("bulk class billing is idempotent per student", async () => {
    await people.createStudent(S.admin, { firstName: "Second", lastName: "Pupil", gender: "MALE", classId: S.jss1.id });
    const first = await fin.generateInvoicesForClass(S.admin, { classId: S.jss1.id, termId: S.t1.id });
    expect(first.created).toBe(2);
    const second = await fin.generateInvoicesForClass(S.admin, { classId: S.jss1.id, termId: S.t1.id });
    expect(second.created).toBe(0);
    expect(second.skipped).toHaveLength(2);
  });
  it("refuses to bill a student who is not enrolled", async () => {
    const orphan = (await people.createStudent(S.admin, { firstName: "No", lastName: "Class", gender: "MALE" })).student;
    await expect(fin.generateInvoice(S.admin, { studentId: orphan.id, termId: S.t1.id })).rejects.toThrow(/not actively enrolled/);
  });
  it("void → can be re-billed; void is blocked while payments exist", async () => {
    const inv = await fin.generateInvoice(S.admin, { studentId, termId: S.t1.id });
    const p = await pay(1000);
    await expect(fin.voidInvoice(S.admin, inv.id, "mistake")).rejects.toThrow(/Reverse those payments/);
    await fin.reversePayment(S.admin, p.payment.id, "bounced");
    await fin.voidInvoice(S.admin, inv.id, "wrong class fees");
    expect((await fin.verifyFinance()).ok).toBe(true);
    const again = await fin.generateInvoice(S.admin, { studentId, termId: S.t1.id });
    expect(again.status).toBe("ISSUED");
  });
});

describe("payments", () => {
  it("auto-allocates oldest first, partially pays, then completes", async () => {
    const inv = await fin.generateInvoice(S.admin, { studentId, termId: S.t1.id });
    const p1 = await pay(40000);
    expect(p1.payment.allocations).toHaveLength(1);
    let cur = await db.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(cur.status).toBe("PARTIALLY_PAID");
    expect(cur.amountPaid.toString()).toBe("40000");
    await pay(65000);
    cur = await db.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(cur.status).toBe("PAID");
    expect((await fin.verifyFinance()).ok).toBe(true);
  });
  it("overpayment becomes student credit and is applied to the next invoice automatically", async () => {
    const inv = await fin.generateInvoice(S.admin, { studentId, termId: S.t1.id });
    await pay(110000); // 5,000 over
    let stmt = await fin.studentStatement(S.admin, studentId);
    expect(stmt.credit).toBe("5000.00");
    expect(stmt.outstanding).toBe("0.00");
    // second-term fees arrive; credit is consumed
    await fin.createFeeStructure(S.admin, { name: "JSS1 Second Term", termId: S.t2.id, classId: S.jss1.id, items: [{ name: "Tuition", amount: 8000 }] });
    const inv2 = await fin.generateInvoice(S.admin, { studentId, termId: S.t2.id });
    const after = await db.invoice.findUniqueOrThrow({ where: { id: inv2.id } });
    expect(after.amountPaid.toString()).toBe("5000");
    stmt = await fin.studentStatement(S.admin, studentId);
    expect(stmt.credit).toBe("0.00");
    expect(stmt.outstanding).toBe("3000.00");
    expect((await fin.verifyFinance()).ok).toBe(true);
    expect(inv.id).toBeTruthy();
  });
  it("explicit allocation is validated", async () => {
    const inv = await fin.generateInvoice(S.admin, { studentId, termId: S.t1.id });
    await expect(pay(1000, { allocations: [{ invoiceId: inv.id, amount: 2000 }] })).rejects.toThrow(/exceed/);
    await expect(pay(200000, { allocations: [{ invoiceId: inv.id, amount: 200000 }] })).rejects.toThrow(/exceeds the balance/);
    const ok = await pay(50000, { allocations: [{ invoiceId: inv.id, amount: 30000 }] });
    expect(ok.payment.allocations[0]?.amount.toString()).toBe("30000");
    expect((await fin.studentStatement(S.admin, studentId)).credit).toBe("20000.00");
  });
  it("is idempotent: a replayed payment is not double-counted", async () => {
    await fin.generateInvoice(S.admin, { studentId, termId: S.t1.id });
    const k = key();
    const a = await pay(10000, { idempotencyKey: k });
    const b = await pay(10000, { idempotencyKey: k });
    expect(b.duplicate).toBe(true);
    expect(b.payment.id).toBe(a.payment.id);
    expect(await db.payment.count()).toBe(1);
    await expect(pay(99, { idempotencyKey: k })).rejects.toThrow(/different payment/);
  });
  it("concurrent payments never over-apply an invoice", async () => {
    const inv = await fin.generateInvoice(S.admin, { studentId, termId: S.t1.id });
    await Promise.all(Array.from({ length: 6 }, () => pay(30000)));
    const cur = await db.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(cur.amountPaid.toString()).toBe("105000");
    expect(cur.status).toBe("PAID");
    const stmt = await fin.studentStatement(S.admin, studentId);
    expect(stmt.credit).toBe("75000.00"); // 180,000 paid − 105,000 applied
    expect((await fin.verifyFinance()).ok).toBe(true);
  });
  it("reversal preserves history, restores the invoice and re-balances the books", async () => {
    const inv = await fin.generateInvoice(S.admin, { studentId, termId: S.t1.id });
    const p = await pay(105000);
    const rev = await fin.reversePayment(S.admin, p.payment.id, "Cheque bounced");
    expect(rev.status).toBe("REVERSED");
    expect(await db.payment.count()).toBe(1); // still there
    const cur = await db.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(cur.status).toBe("ISSUED");
    expect(cur.amountPaid.toString()).toBe("0");
    expect(await db.financialLedger.count({ where: { refType: { endsWith: "_REVERSAL" } } })).toBeGreaterThan(0);
    expect((await fin.verifyFinance()).ok).toBe(true);
    await expect(fin.reversePayment(S.admin, p.payment.id, "again")).rejects.toThrow(/already reversed/);
    const cash = (await db.financialLedger.aggregate({ where: { account: "CASH" }, _sum: { debit: true, credit: true } }))._sum;
    expect(D(String(cash.debit ?? 0)).eq(String(cash.credit ?? 0))).toBe(true);
  });
  it("requires a reason and audits reversals", async () => {
    await fin.generateInvoice(S.admin, { studentId, termId: S.t1.id });
    const p = await pay(1000);
    await expect(fin.reversePayment(S.admin, p.payment.id, "")).rejects.toThrow(/reason/);
    await fin.reversePayment(S.admin, p.payment.id, "Entered twice");
    expect(await db.auditLog.count({ where: { action: "payment.reverse" } })).toBe(1);
  });
});

describe("expenses and summary", () => {
  it("records, voids, and reports", async () => {
    await fin.generateInvoice(S.admin, { studentId, termId: S.t1.id });
    await pay(50000);
    const e = await fin.recordExpense(S.admin, { category: "Utilities", description: "Diesel", amount: 12000, paidOn: "2025-10-01" });
    let sum = await fin.financeSummary();
    expect(sum).toMatchObject({ billed: "105000.00", expenses: "12000.00", cashCollected: "50000.00", outstanding: "55000.00" });
    await fin.voidExpense(S.admin, e.id, "duplicate entry");
    sum = await fin.financeSummary();
    expect(sum.expenses).toBe("0.00");
    expect((await fin.verifyFinance()).ok).toBe(true);
  });
});

describe("financial lockout policy", () => {
  async function enable(over = {}) {
    await db.$transaction((tx) => setSetting(tx, "finance.lockout", { enabled: true, graceDays: 0, minimumOutstanding: 0, message: "Please pay at the bursary.", ...over }));
  }
  async function parentCtx() {
    const u = await db.user.findFirstOrThrow({ where: { userType: "PARENT" } });
    await db.user.update({ where: { id: u.id }, data: { passwordHash: await hashPassword("Parent-pass-1"), mustChangePassword: false } });
    return ctxFor(u.username, "Parent-pass-1");
  }

  it("is off by default", async () => {
    await fin.generateInvoice(S.admin, { studentId, termId: S.t1.id, dueDate: "2020-01-01" });
    expect((await evaluateFinancialLockout(studentId)).locked).toBe(false);
  });
  it("blocks parents server-side when fees are overdue; staff are unaffected", async () => {
    await enable();
    await fin.generateInvoice(S.admin, { studentId, termId: S.t1.id, dueDate: "2020-01-01" });
    const parent = await parentCtx();
    await expect(assertResultsAccessible(parent, studentId)).rejects.toMatchObject({ code: "FINANCIAL_LOCKOUT", details: { outstanding: "105000.00", message: "Please pay at the bursary." } });
    await expect(assertResultsAccessible(S.admin, studentId)).resolves.toBeUndefined();
  });
  it("lifts as soon as the balance is cleared", async () => {
    await enable();
    await fin.generateInvoice(S.admin, { studentId, termId: S.t1.id, dueDate: "2020-01-01" });
    const parent = await parentCtx();
    await pay(105000);
    await expect(assertResultsAccessible(parent, studentId)).resolves.toBeUndefined();
  });
  it("respects grace days, not-yet-due invoices and the minimum threshold", async () => {
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    await fin.generateInvoice(S.admin, { studentId, termId: S.t1.id, dueDate: soon });
    await enable();
    expect((await evaluateFinancialLockout(studentId)).locked).toBe(false); // not due yet
    await db.invoice.updateMany({ data: { dueDate: new Date(Date.now() - 5 * 86_400_000) } });
    await enable({ graceDays: 14 });
    expect((await evaluateFinancialLockout(studentId)).locked).toBe(false); // within grace
    await enable({ graceDays: 0, minimumOutstanding: 200000 });
    expect((await evaluateFinancialLockout(studentId)).locked).toBe(false); // below threshold
    await enable({ graceDays: 0, minimumOutstanding: 0 });
    expect((await evaluateFinancialLockout(studentId)).locked).toBe(true);
  });
});
