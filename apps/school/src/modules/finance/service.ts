import { z } from "zod";
import { db, transact, Decimal, type Tx } from "@/platform/db";
import type { SecurityContext } from "@/platform/security/context";
import { auditIn } from "@/platform/security/interceptor";
import { assertCanAccessStudent, visibleStudentIds } from "@/platform/security/scope";
import { enqueueSync } from "@/platform/sync/outbox";
import { publishEvent } from "@/platform/events";
import { formatted } from "@/platform/sequence";
import { AppError, conflict, notFound, validation } from "@/platform/errors";
import { assertUpdated, asPage, isoDate, money, skipTake, toDate, uuid } from "@/platform/util";
import { postJournal, reverseJournals } from "./ledger";

const D = (v: Decimal | number | string) => new Decimal(v);

// ───────────── Fee structures ─────────────

const FeeItemInput = z.object({ name: z.string().trim().min(1).max(80), category: z.string().trim().max(30).default("TUITION"), amount: money, isOptional: z.boolean().default(false) });
export const FeeStructureInput = z.object({
  name: z.string().trim().min(2).max(100),
  academicYearId: uuid.nullable().optional(),
  termId: uuid.nullable().optional(),
  classId: uuid.nullable().optional(),
  items: z.array(FeeItemInput).min(1).max(40),
});

export async function createFeeStructure(ctx: SecurityContext, raw: z.input<typeof FeeStructureInput>) {
  const i = FeeStructureInput.parse(raw);
  return transact(async (tx) => {
    const fs = await tx.feeStructure.create({
      data: { name: i.name, academicYearId: i.academicYearId ?? null, termId: i.termId ?? null, classId: i.classId ?? null, items: { create: i.items.map((it, idx) => ({ ...it, sortOrder: idx })) } },
      include: { items: true },
    });
    await auditIn(tx, ctx, { action: "fee_structure.create", module: "finance", entityType: "FeeStructure", entityId: fs.id, after: { name: fs.name, items: fs.items.length, total: fs.items.reduce((s, x) => s.plus(x.amount), D(0)).toFixed(2) } });
    return fs;
  });
}

/** Editing replaces items; already-issued invoices keep their own copied lines and are unaffected. */
export async function updateFeeStructure(ctx: SecurityContext, id: string, raw: z.input<typeof FeeStructureInput> & { version: number; isActive?: boolean }) {
  const { version, isActive, ...rest } = raw;
  const i = FeeStructureInput.parse(rest);
  return transact(async (tx) => {
    const before = await tx.feeStructure.findUnique({ where: { id }, include: { items: true } });
    if (!before) throw notFound("Fee structure");
    const r = await tx.feeStructure.updateMany({ where: { id, version }, data: { name: i.name, academicYearId: i.academicYearId ?? null, termId: i.termId ?? null, classId: i.classId ?? null, ...(isActive === undefined ? {} : { isActive }), version: { increment: 1 } } });
    assertUpdated(r.count, "Fee structure", before.version);
    await tx.feeStructureItem.deleteMany({ where: { feeStructureId: id } });
    await tx.feeStructureItem.createMany({ data: i.items.map((it, idx) => ({ ...it, feeStructureId: id, sortOrder: idx })) });
    const after = await tx.feeStructure.findUniqueOrThrow({ where: { id }, include: { items: true } });
    await auditIn(tx, ctx, { action: "fee_structure.update", module: "finance", entityType: "FeeStructure", entityId: id, before: { name: before.name, items: before.items.map((x) => ({ n: x.name, a: x.amount })) }, after: { name: after.name, items: after.items.map((x) => ({ n: x.name, a: x.amount })) } });
    return after;
  });
}

export const listFeeStructures = () => db.feeStructure.findMany({ include: { items: { orderBy: { sortOrder: "asc" } }, class: { select: { name: true } }, term: { select: { name: true } } }, orderBy: { createdAt: "desc" } });

// ───────────── Discounts & scholarships ─────────────

export const DiscountInput = z.object({
  studentId: uuid,
  kind: z.enum(["DISCOUNT", "SCHOLARSHIP"]),
  valueType: z.enum(["PERCENT", "FIXED"]),
  value: money,
  reason: z.string().trim().min(3).max(200),
  termId: uuid.nullable().optional(),
});

export async function addDiscount(ctx: SecurityContext, raw: z.input<typeof DiscountInput>) {
  const i = DiscountInput.parse(raw);
  if (i.valueType === "PERCENT" && (i.value <= 0 || i.value > 100)) throw validation("Percentage must be between 0 and 100");
  if (i.value <= 0) throw validation("Value must be greater than zero");
  return transact(async (tx) => {
    if (!(await tx.studentProfile.findFirst({ where: { id: i.studentId, deletedAt: null } }))) throw notFound("Student");
    const d = await tx.studentDiscount.create({ data: { ...i, termId: i.termId ?? null, approvedById: ctx.user.id } });
    await auditIn(tx, ctx, { action: "discount.add", module: "finance", entityType: "StudentDiscount", entityId: d.id, after: d });
    return d;
  });
}

export async function revokeDiscount(ctx: SecurityContext, id: string) {
  return transact(async (tx) => {
    const r = await tx.studentDiscount.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (!r.count) throw notFound("Active discount");
    await auditIn(tx, ctx, { action: "discount.revoke", module: "finance", entityType: "StudentDiscount", entityId: id });
  });
}

// ───────────── Invoices ─────────────

async function nextInvoiceNumber(tx: Tx) {
  return formatted(tx, "INV", new Date().getFullYear());
}

export interface InvoiceDraftLine {
  description: string;
  kind: "CHARGE" | "DISCOUNT" | "SCHOLARSHIP";
  quantity: number;
  unitAmount: Decimal;
  amount: Decimal;
}

/** Pure: charges + active discounts → lines and totals (discounts are capped so an invoice never goes negative). */
export function priceInvoice(charges: { name: string; amount: Decimal }[], discounts: { kind: "DISCOUNT" | "SCHOLARSHIP"; valueType: "PERCENT" | "FIXED"; value: Decimal; reason: string }[]) {
  const subtotal = charges.reduce((s, c) => s.plus(c.amount), D(0));
  const lines: InvoiceDraftLine[] = charges.map((c) => ({ description: c.name, kind: "CHARGE", quantity: 1, unitAmount: c.amount, amount: c.amount }));
  let remaining = subtotal;
  let discountTotal = D(0);
  // Scholarships apply before discounts so partial waivers stack predictably.
  for (const d of [...discounts].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "SCHOLARSHIP" ? -1 : 1))) {
    const raw = d.valueType === "PERCENT" ? subtotal.times(d.value).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP) : d.value;
    const amt = Decimal.min(raw, remaining);
    if (amt.lte(0)) continue;
    remaining = remaining.minus(amt);
    discountTotal = discountTotal.plus(amt);
    lines.push({ description: `${d.kind === "SCHOLARSHIP" ? "Scholarship" : "Discount"}: ${d.reason}`, kind: d.kind, quantity: 1, unitAmount: amt.negated(), amount: amt.negated() });
  }
  return { lines, subtotal, discountTotal, total: subtotal.minus(discountTotal) };
}

export const GenerateInvoiceInput = z.object({
  studentId: uuid,
  termId: uuid,
  feeStructureIds: z.array(uuid).optional(),
  optionalItemNames: z.array(z.string()).default([]),
  dueDate: isoDate.optional(),
  issue: z.boolean().default(true),
});

export async function generateInvoice(ctx: SecurityContext, raw: z.input<typeof GenerateInvoiceInput>) {
  const i = GenerateInvoiceInput.parse(raw);
  return transact(async (tx) => {
    const student = await tx.studentProfile.findFirst({ where: { id: i.studentId, deletedAt: null } });
    const term = await tx.term.findUnique({ where: { id: i.termId } });
    if (!student) throw notFound("Student");
    if (!term) throw notFound("Term");
    const enrollment = await tx.enrollment.findUnique({ where: { studentId_academicYearId: { studentId: student.id, academicYearId: term.academicYearId } } });
    if (!enrollment || enrollment.status !== "ACTIVE") throw validation("Student is not actively enrolled in this academic year");

    const structures = await tx.feeStructure.findMany({
      where: i.feeStructureIds?.length
        ? { id: { in: i.feeStructureIds }, isActive: true }
        : { isActive: true, AND: [{ OR: [{ termId: term.id }, { termId: null, OR: [{ academicYearId: term.academicYearId }, { academicYearId: null }] }] }, { OR: [{ classId: enrollment.classId }, { classId: null }] }] },
      include: { items: { orderBy: { sortOrder: "asc" } } },
    });
    if (!structures.length) throw validation("No fee structure applies to this student and term");
    const already = await tx.studentFee.findMany({ where: { studentId: student.id, termId: term.id, feeStructureId: { in: structures.map((s) => s.id) } } });
    const fresh = structures.filter((s) => !already.some((a) => a.feeStructureId === s.id));
    if (!fresh.length) throw conflict("This student has already been billed for this term");

    const charges = fresh.flatMap((s) => s.items.filter((it) => !it.isOptional || i.optionalItemNames.includes(it.name)).map((it) => ({ name: it.name, amount: D(it.amount) })));
    const discounts = (await tx.studentDiscount.findMany({ where: { studentId: student.id, revokedAt: null, OR: [{ termId: null }, { termId: term.id }] } })).map((d) => ({ kind: d.kind, valueType: d.valueType, value: D(d.value), reason: d.reason }));
    const priced = priceInvoice(charges, discounts);
    if (priced.subtotal.lte(0)) throw validation("Nothing to bill");

    const invoice = await tx.invoice.create({
      data: {
        number: await nextInvoiceNumber(tx), studentId: student.id, termId: term.id, status: "DRAFT",
        subtotal: priced.subtotal, discountTotal: priced.discountTotal, total: priced.total,
        dueDate: i.dueDate ? toDate(i.dueDate) : term.startDate, createdById: ctx.user.id,
        items: { create: priced.lines.map((l) => ({ description: l.description, kind: l.kind, quantity: l.quantity, unitAmount: l.unitAmount, amount: l.amount })) },
      },
      include: { items: true },
    });
    await tx.studentFee.createMany({ data: fresh.map((s) => ({ studentId: student.id, feeStructureId: s.id, termId: term.id, invoiceId: invoice.id })) });
    await auditIn(tx, ctx, { action: "invoice.create", module: "finance", entityType: "Invoice", entityId: invoice.id, after: { number: invoice.number, total: invoice.total.toString(), studentId: student.id } });
    return i.issue ? issueInvoiceTx(tx, ctx, invoice.id) : invoice;
  });
}

export async function issueInvoiceTx(tx: Tx, ctx: SecurityContext | null, invoiceId: string) {
  const inv = await tx.invoice.findUnique({ where: { id: invoiceId }, include: { items: true } });
  if (!inv) throw notFound("Invoice");
  if (inv.status !== "DRAFT") throw conflict("Only draft invoices can be issued");
  const charges = inv.items.filter((x) => x.kind === "CHARGE").reduce((s, x) => s.plus(x.amount), D(0));
  const disc = inv.items.filter((x) => x.kind === "DISCOUNT").reduce((s, x) => s.plus(D(x.amount).abs()), D(0));
  const schol = inv.items.filter((x) => x.kind === "SCHOLARSHIP").reduce((s, x) => s.plus(D(x.amount).abs()), D(0));
  const total = D(inv.total);
  const status = total.eq(0) ? "PAID" : "ISSUED";
  const issued = await tx.invoice.update({ where: { id: inv.id }, data: { status, issuedAt: new Date(), version: { increment: 1 } } });
  await postJournal(tx, {
    refType: "INVOICE", refId: inv.id, studentId: inv.studentId, memo: `Invoice ${inv.number}`, createdById: ctx?.user.id,
    lines: [{ account: "RECEIVABLE", debit: total }, { account: "DISCOUNTS_GIVEN", debit: disc }, { account: "SCHOLARSHIPS_GIVEN", debit: schol }, { account: "FEE_REVENUE", credit: charges }],
  });
  await enqueueSync(tx, "invoice", issued);
  await publishEvent(tx, "invoice.issued", { invoiceId: inv.id, number: inv.number, studentId: inv.studentId, total: total.toFixed(2), dueDate: inv.dueDate?.toISOString().slice(0, 10) ?? null });
  if (ctx) await auditIn(tx, ctx, { action: "invoice.issue", module: "finance", entityType: "Invoice", entityId: inv.id, after: { number: inv.number, status } });
  // Cash already on account (student credit) is applied to the new invoice immediately.
  if (inv.studentId && total.gt(0)) await applyStudentCreditTx(tx, ctx, inv.studentId);
  return issued;
}

export async function issueInvoice(ctx: SecurityContext, invoiceId: string) {
  return transact((tx) => issueInvoiceTx(tx, ctx, invoiceId));
}

/** Bulk billing for a class. Per-student transactions: one bad record never blocks the rest. */
export async function generateInvoicesForClass(ctx: SecurityContext, raw: { classId: string; termId: string; dueDate?: string }) {
  const term = await db.term.findUnique({ where: { id: raw.termId } });
  if (!term) throw notFound("Term");
  const enrollments = await db.enrollment.findMany({ where: { classId: raw.classId, academicYearId: term.academicYearId, status: "ACTIVE" }, select: { studentId: true } });
  const result = { created: 0, skipped: [] as { studentId: string; reason: string }[] };
  for (const e of enrollments) {
    try {
      await generateInvoice(ctx, { studentId: e.studentId, termId: raw.termId, dueDate: raw.dueDate, issue: true });
      result.created += 1;
    } catch (err) {
      if (err instanceof AppError) result.skipped.push({ studentId: e.studentId, reason: err.message });
      else throw err;
    }
  }
  return result;
}

export async function voidInvoice(ctx: SecurityContext, invoiceId: string, reason: string) {
  if (reason.trim().length < 3) throw validation("A reason is required");
  return transact(async (tx) => {
    await lockInvoices(tx, [invoiceId]);
    const inv = await tx.invoice.findUnique({ where: { id: invoiceId } });
    if (!inv) throw notFound("Invoice");
    if (inv.status === "VOID") throw conflict("Invoice is already void");
    if (D(inv.amountPaid).gt(0)) throw conflict("This invoice has payments applied. Reverse those payments first.");
    if (inv.status === "DRAFT") {
      await tx.invoice.update({ where: { id: inv.id }, data: { status: "VOID", voidedAt: new Date(), voidReason: reason, version: { increment: 1 } } });
    } else {
      await reverseJournals(tx, "INVOICE", inv.id, `Void ${inv.number}: ${reason}`, ctx.user.id);
      await tx.invoice.update({ where: { id: inv.id }, data: { status: "VOID", voidedAt: new Date(), voidReason: reason, version: { increment: 1 } } });
    }
    // Free exactly the fee structures this invoice billed so they can be billed again.
    await tx.studentFee.deleteMany({ where: { invoiceId: inv.id } });
    const after = await tx.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    await enqueueSync(tx, "invoice", after);
    await auditIn(tx, ctx, { action: "invoice.void", module: "finance", entityType: "Invoice", entityId: inv.id, before: { status: inv.status }, after: { status: "VOID" }, metadata: { reason } });
    return after;
  });
}

/** SELECT … FOR UPDATE in id order: serialises concurrent payments on the same invoice and avoids deadlocks. */
async function lockInvoices(tx: Tx, ids: string[]) {
  if (!ids.length) return;
  const sorted = [...new Set(ids)].sort();
  await tx.$queryRaw`SELECT id FROM invoices WHERE id = ANY(${sorted}::uuid[]) ORDER BY id FOR UPDATE`;
}

const balanceOf = (inv: { total: Decimal; amountPaid: Decimal }) => D(inv.total).minus(inv.amountPaid);

// ───────────── Payments ─────────────

export const PaymentInput = z.object({
  studentId: uuid.optional(),
  payerName: z.string().trim().max(120).optional(),
  amount: money,
  method: z.enum(["CASH", "BANK_TRANSFER", "POS", "CHEQUE", "ONLINE"]),
  reference: z.string().trim().max(80).optional(),
  /// Client-generated (UUID). Retries and offline replays of the same payment are safe.
  idempotencyKey: z.string().min(8).max(80),
  receivedAt: z.string().datetime().optional(),
  /// "auto" pays the oldest outstanding invoices first; otherwise an explicit split.
  allocations: z.union([z.literal("auto"), z.array(z.object({ invoiceId: uuid, amount: money })).min(1).max(20)]).default("auto"),
});

async function loadPayment(tx: Tx, id: string) {
  return tx.payment.findUniqueOrThrow({ where: { id }, include: { allocations: true } });
}

export async function recordPayment(ctx: SecurityContext, raw: z.input<typeof PaymentInput>) {
  const i = PaymentInput.parse(raw);
  if (i.amount <= 0) throw validation("Amount must be greater than zero");
  if (!i.studentId && !i.payerName) throw validation("Provide a student or a payer name");

  return transact(async (tx) => {
    const dup = await tx.payment.findUnique({ where: { idempotencyKey: i.idempotencyKey }, include: { allocations: true } });
    if (dup) {
      if (!D(dup.amount).eq(i.amount) || dup.studentId !== (i.studentId ?? null)) throw conflict("That idempotency key was already used for a different payment");
      return { payment: dup, duplicate: true as const };
    }
    const amount = D(i.amount);
    let plan: { invoiceId: string; amount: Decimal }[] = [];

    if (i.allocations === "auto") {
      if (i.studentId) {
        const open = await tx.invoice.findMany({ where: { studentId: i.studentId, status: { in: ["ISSUED", "PARTIALLY_PAID"] } }, orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }], select: { id: true } });
        await lockInvoices(tx, open.map((o) => o.id));
        const locked = await tx.invoice.findMany({ where: { id: { in: open.map((o) => o.id) }, status: { in: ["ISSUED", "PARTIALLY_PAID"] } }, orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }] });
        let left = amount;
        for (const inv of locked) {
          if (left.lte(0)) break;
          const pay = Decimal.min(left, balanceOf(inv));
          if (pay.gt(0)) plan.push({ invoiceId: inv.id, amount: pay });
          left = left.minus(pay);
        }
      }
    } else {
      await lockInvoices(tx, i.allocations.map((a) => a.invoiceId));
      const invoices = await tx.invoice.findMany({ where: { id: { in: i.allocations.map((a) => a.invoiceId) } } });
      for (const a of i.allocations) {
        const inv = invoices.find((x) => x.id === a.invoiceId);
        if (!inv) throw notFound("Invoice");
        if (inv.status !== "ISSUED" && inv.status !== "PARTIALLY_PAID") throw validation(`Invoice ${inv.number} cannot receive payments (${inv.status})`);
        if (i.studentId && inv.studentId && inv.studentId !== i.studentId) throw validation(`Invoice ${inv.number} belongs to a different student`);
        if (D(a.amount).gt(balanceOf(inv))) throw validation(`Allocation exceeds the balance of ${inv.number}`);
        plan.push({ invoiceId: a.invoiceId, amount: D(a.amount) });
      }
      const allocated = plan.reduce((s, p) => s.plus(p.amount), D(0));
      if (allocated.gt(amount)) throw validation("Allocations exceed the payment amount");
    }

    const payment = await tx.payment.create({
      data: {
        receiptNumber: await formatted(tx, "RCP", new Date().getFullYear()), studentId: i.studentId ?? null, payerName: i.payerName, amount, method: i.method,
        reference: i.reference, receivedAt: i.receivedAt ? new Date(i.receivedAt) : new Date(), receivedById: ctx.user.id, idempotencyKey: i.idempotencyKey,
      },
    });
    // Cash received sits in STUDENT_CREDIT until allocated; allocations then move it to RECEIVABLE.
    await postJournal(tx, { refType: "PAYMENT", refId: payment.id, studentId: payment.studentId, memo: `Receipt ${payment.receiptNumber}`, createdById: ctx.user.id, lines: [{ account: "CASH", debit: amount }, { account: "STUDENT_CREDIT", credit: amount }] });
    for (const p of plan) await allocateTx(tx, ctx, payment.id, payment.studentId, p.invoiceId, p.amount);

    const full = await loadPayment(tx, payment.id);
    await enqueueSync(tx, "payment", full);
    await publishEvent(tx, "payment.received", { paymentId: payment.id, receiptNumber: payment.receiptNumber, studentId: payment.studentId, amount: amount.toFixed(2), allocated: plan.reduce((s, p) => s.plus(p.amount), D(0)).toFixed(2) });
    await auditIn(tx, ctx, { action: "payment.record", module: "finance", entityType: "Payment", entityId: payment.id, after: { receipt: payment.receiptNumber, amount: amount.toFixed(2), method: i.method, allocations: plan.map((p) => ({ invoiceId: p.invoiceId, amount: p.amount.toFixed(2) })) } });
    return { payment: full, duplicate: false as const };
  });
}

async function allocateTx(tx: Tx, ctx: SecurityContext | null, paymentId: string, studentId: string | null, invoiceId: string, amount: Decimal) {
  const alloc = await tx.paymentAllocation.create({ data: { paymentId, invoiceId, amount } });
  const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  const paid = D(inv.amountPaid).plus(amount);
  const status = paid.gte(inv.total) ? "PAID" : "PARTIALLY_PAID";
  const updated = await tx.invoice.update({ where: { id: invoiceId }, data: { amountPaid: paid, status, version: { increment: 1 } } });
  await postJournal(tx, { refType: "ALLOCATION", refId: alloc.id, studentId: studentId ?? inv.studentId, memo: `Apply to ${inv.number}`, createdById: ctx?.user.id, lines: [{ account: "STUDENT_CREDIT", debit: amount }, { account: "RECEIVABLE", credit: amount }] });
  await enqueueSync(tx, "invoice", updated);
  return alloc;
}

/** Apply unallocated cash (student credit) to the oldest open invoices. */
export async function applyStudentCreditTx(tx: Tx, ctx: SecurityContext | null, studentId: string) {
  const payments = await tx.payment.findMany({ where: { studentId, status: "POSTED" }, include: { allocations: true }, orderBy: { receivedAt: "asc" } });
  const pool = payments.map((p) => ({ id: p.id, free: D(p.amount).minus(p.allocations.reduce((s, a) => s.plus(a.amount), D(0))) })).filter((p) => p.free.gt(0));
  if (!pool.length) return 0;
  const open = await tx.invoice.findMany({ where: { studentId, status: { in: ["ISSUED", "PARTIALLY_PAID"] } }, orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }], select: { id: true } });
  await lockInvoices(tx, open.map((o) => o.id));
  let applied = 0;
  for (const o of open) {
    const inv = await tx.invoice.findUniqueOrThrow({ where: { id: o.id } });
    let bal = balanceOf(inv);
    for (const p of pool) {
      if (bal.lte(0)) break;
      if (p.free.lte(0)) continue;
      const amt = Decimal.min(bal, p.free);
      const existing = await tx.paymentAllocation.findUnique({ where: { paymentId_invoiceId: { paymentId: p.id, invoiceId: inv.id } } });
      if (existing) {
        await tx.paymentAllocation.update({ where: { id: existing.id }, data: { amount: D(existing.amount).plus(amt) } });
        const updated = await tx.invoice.update({ where: { id: inv.id }, data: { amountPaid: D(inv.amountPaid).plus(amt), status: D(inv.amountPaid).plus(amt).gte(inv.total) ? "PAID" : "PARTIALLY_PAID", version: { increment: 1 } } });
        await postJournal(tx, { refType: "ALLOCATION", refId: existing.id, studentId, memo: `Apply credit to ${inv.number}`, createdById: ctx?.user.id, lines: [{ account: "STUDENT_CREDIT", debit: amt }, { account: "RECEIVABLE", credit: amt }] });
        await enqueueSync(tx, "invoice", updated);
      } else {
        await allocateTx(tx, ctx, p.id, studentId, inv.id, amt);
      }
      p.free = p.free.minus(amt);
      bal = bal.minus(amt);
      inv.amountPaid = D(inv.amountPaid).plus(amt) as never;
      applied += 1;
    }
  }
  return applied;
}

/** Reversal keeps the original payment row (status REVERSED) and posts mirror journals — nothing is erased. */
export async function reversePayment(ctx: SecurityContext, paymentId: string, reason: string) {
  if (reason.trim().length < 3) throw validation("A reason is required");
  return transact(async (tx) => {
    const p = await tx.payment.findUnique({ where: { id: paymentId }, include: { allocations: true } });
    if (!p) throw notFound("Payment");
    if (p.status === "REVERSED") throw conflict("Payment is already reversed");
    await lockInvoices(tx, p.allocations.map((a) => a.invoiceId));
    for (const a of p.allocations) {
      const inv = await tx.invoice.findUniqueOrThrow({ where: { id: a.invoiceId } });
      const paid = D(inv.amountPaid).minus(a.amount);
      const status = inv.status === "VOID" ? "VOID" : paid.lte(0) ? "ISSUED" : "PARTIALLY_PAID";
      const updated = await tx.invoice.update({ where: { id: inv.id }, data: { amountPaid: Decimal.max(paid, D(0)), status, version: { increment: 1 } } });
      await reverseJournals(tx, "ALLOCATION", a.id, `Reversal of receipt ${p.receiptNumber}: ${reason}`, ctx.user.id);
      await enqueueSync(tx, "invoice", updated);
    }
    await reverseJournals(tx, "PAYMENT", p.id, `Reversal of receipt ${p.receiptNumber}: ${reason}`, ctx.user.id);
    const updated = await tx.payment.update({ where: { id: p.id }, data: { status: "REVERSED", reversedAt: new Date(), reversedById: ctx.user.id, reversalReason: reason, version: { increment: 1 } }, include: { allocations: true } });
    await enqueueSync(tx, "payment", updated);
    await publishEvent(tx, "payment.reversed", { paymentId: p.id, receiptNumber: p.receiptNumber, studentId: p.studentId, amount: D(p.amount).toFixed(2) });
    await auditIn(tx, ctx, { action: "payment.reverse", module: "finance", entityType: "Payment", entityId: p.id, before: { status: "POSTED" }, after: { status: "REVERSED" }, metadata: { reason, receipt: p.receiptNumber, amount: D(p.amount).toFixed(2) } });
    return updated;
  });
}

// ───────────── Expenses ─────────────

export const ExpenseInput = z.object({ category: z.string().trim().min(2).max(60), description: z.string().trim().min(2).max(200), vendor: z.string().trim().max(100).optional(), amount: money, paidOn: isoDate, method: z.enum(["CASH", "BANK_TRANSFER", "POS", "CHEQUE", "ONLINE"]).default("CASH") });

export async function recordExpense(ctx: SecurityContext, raw: z.input<typeof ExpenseInput>) {
  const i = ExpenseInput.parse(raw);
  if (i.amount <= 0) throw validation("Amount must be greater than zero");
  return transact(async (tx) => {
    const e = await tx.expense.create({ data: { number: await formatted(tx, "EXP", new Date().getFullYear()), category: i.category, description: i.description, vendor: i.vendor, amount: i.amount, paidOn: toDate(i.paidOn), method: i.method, recordedById: ctx.user.id, approvedById: ctx.user.id } });
    await postJournal(tx, { refType: "EXPENSE", refId: e.id, memo: `${e.number} ${i.category}`, createdById: ctx.user.id, entryDate: toDate(i.paidOn), lines: [{ account: "EXPENSE", debit: i.amount }, { account: "CASH", credit: i.amount }] });
    await enqueueSync(tx, "expense", e);
    await auditIn(tx, ctx, { action: "expense.record", module: "finance", entityType: "Expense", entityId: e.id, after: { number: e.number, amount: i.amount, category: i.category } });
    return e;
  });
}

export async function voidExpense(ctx: SecurityContext, id: string, reason: string) {
  if (reason.trim().length < 3) throw validation("A reason is required");
  return transact(async (tx) => {
    const e = await tx.expense.findUnique({ where: { id } });
    if (!e) throw notFound("Expense");
    if (e.status === "VOIDED") throw conflict("Expense is already voided");
    await reverseJournals(tx, "EXPENSE", id, `Void ${e.number}: ${reason}`, ctx.user.id);
    const u = await tx.expense.update({ where: { id }, data: { status: "VOIDED", voidedAt: new Date(), voidReason: reason, version: { increment: 1 } } });
    await enqueueSync(tx, "expense", u);
    await auditIn(tx, ctx, { action: "expense.void", module: "finance", entityType: "Expense", entityId: id, metadata: { reason } });
    return u;
  });
}

// ───────────── Reads: statements, lists, verification ─────────────

export async function studentStatement(ctx: SecurityContext, studentId: string) {
  await assertCanAccessStudent(ctx, studentId, "finance");
  const [invoices, payments, credit] = await Promise.all([
    db.invoice.findMany({ where: { studentId, status: { not: "DRAFT" } }, include: { items: true, term: { select: { name: true, academicYear: { select: { name: true } } } } }, orderBy: { createdAt: "desc" } }),
    db.payment.findMany({ where: { studentId }, include: { allocations: { include: { invoice: { select: { number: true } } } } }, orderBy: { receivedAt: "desc" } }),
    db.financialLedger.aggregate({ where: { studentId, account: "STUDENT_CREDIT" }, _sum: { credit: true, debit: true } }),
  ]);
  const owed = invoices.filter((i) => i.status === "ISSUED" || i.status === "PARTIALLY_PAID").reduce((s, i) => s.plus(balanceOf(i)), D(0));
  const creditBalance = D(credit._sum.credit ?? 0).minus(credit._sum.debit ?? 0);
  return { invoices, payments, outstanding: owed.toFixed(2), credit: creditBalance.toFixed(2) };
}

export const InvoiceListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(25),
  studentId: uuid.optional(), termId: uuid.optional(), status: z.enum(["DRAFT", "ISSUED", "PARTIALLY_PAID", "PAID", "VOID"]).optional(),
  overdue: z.coerce.boolean().optional(), q: z.string().trim().max(60).optional(),
});

export async function listInvoices(ctx: SecurityContext, raw: z.input<typeof InvoiceListQuery>) {
  const q = InvoiceListQuery.parse(raw);
  const visible = await visibleStudentIds(ctx, "finance");
  const where = {
    ...(visible === "ALL" ? {} : { studentId: { in: visible } }),
    ...(q.studentId ? { studentId: q.studentId } : {}), ...(q.termId ? { termId: q.termId } : {}), ...(q.status ? { status: q.status } : {}),
    ...(q.overdue ? { status: { in: ["ISSUED", "PARTIALLY_PAID"] as ("ISSUED" | "PARTIALLY_PAID")[] }, dueDate: { lt: new Date() } } : {}),
    ...(q.q ? { OR: [{ number: { contains: q.q, mode: "insensitive" as const } }, { student: { OR: [{ firstName: { contains: q.q, mode: "insensitive" as const } }, { lastName: { contains: q.q, mode: "insensitive" as const } }, { admissionNumber: { contains: q.q, mode: "insensitive" as const } }] } }] } : {}),
  };
  const [items, total] = await Promise.all([
    db.invoice.findMany({ where, include: { student: { select: { firstName: true, lastName: true, admissionNumber: true } } }, orderBy: { createdAt: "desc" }, ...skipTake(q) }),
    db.invoice.count({ where }),
  ]);
  return asPage(items, total, q);
}

export async function listPayments(ctx: SecurityContext, raw: { page?: number; pageSize?: number; studentId?: string }) {
  const p = { page: raw.page ?? 1, pageSize: raw.pageSize ?? 25 };
  const visible = await visibleStudentIds(ctx, "finance");
  const where = { ...(visible === "ALL" ? {} : { studentId: { in: visible } }), ...(raw.studentId ? { studentId: raw.studentId } : {}) };
  const [items, total] = await Promise.all([
    db.payment.findMany({ where, include: { student: { select: { firstName: true, lastName: true, admissionNumber: true } } }, orderBy: { receivedAt: "desc" }, ...skipTake(p) }),
    db.payment.count({ where }),
  ]);
  return asPage(items, total, p);
}

/** Cross-checks the denormalised invoice.amountPaid against allocations and the ledger. Returns discrepancies (empty = healthy). */
export async function verifyFinance() {
  const problems: string[] = [];
  const invoices = await db.invoice.findMany({ where: { status: { not: "DRAFT" } }, include: { allocations: { where: { payment: { status: "POSTED" } } } } });
  for (const inv of invoices) {
    const sum = inv.allocations.reduce((s, a) => s.plus(a.amount), D(0));
    if (inv.status !== "VOID" && !sum.eq(inv.amountPaid)) problems.push(`Invoice ${inv.number}: amountPaid ${inv.amountPaid} ≠ allocations ${sum}`);
  }
  const rows = await db.financialLedger.groupBy({ by: ["journalId"], _sum: { debit: true, credit: true } });
  for (const r of rows) if (!D(r._sum.debit ?? 0).eq(r._sum.credit ?? 0)) problems.push(`Journal ${r.journalId} does not balance`);
  const bal = await db.financialLedger.groupBy({ by: ["account"], _sum: { debit: true, credit: true } });
  const net = Object.fromEntries(bal.map((b) => [b.account, D(b._sum.debit ?? 0).minus(b._sum.credit ?? 0)]));
  // Receivable in the ledger must equal the sum of open invoice balances.
  const open = invoices.filter((i) => i.status === "ISSUED" || i.status === "PARTIALLY_PAID").reduce((s, i) => s.plus(balanceOf(i)), D(0));
  const ledgerReceivable = net.RECEIVABLE ?? D(0);
  if (!ledgerReceivable.eq(open)) problems.push(`Ledger receivable ${ledgerReceivable} ≠ open invoice balances ${open}`);
  return { ok: problems.length === 0, problems, checkedInvoices: invoices.length };
}

export async function financeSummary(range: { from?: Date; to?: Date } = {}) {
  const where = { entryDate: { gte: range.from, lte: range.to } };
  const g = await db.financialLedger.groupBy({ by: ["account"], where, _sum: { debit: true, credit: true } });
  const net = (a: string) => { const r = g.find((x) => x.account === a); return D(r?._sum.debit ?? 0).minus(r?._sum.credit ?? 0); };
  const billed = net("FEE_REVENUE").negated();
  const discounts = net("DISCOUNTS_GIVEN").plus(net("SCHOLARSHIPS_GIVEN"));
  const expenses = net("EXPENSE");
  const cashIn = await db.financialLedger.aggregate({ where: { ...where, account: "CASH" }, _sum: { debit: true, credit: true } });
  const receivable = await db.financialLedger.aggregate({ where: { account: "RECEIVABLE" }, _sum: { debit: true, credit: true } });
  const outstanding = D(receivable._sum.debit ?? 0).minus(receivable._sum.credit ?? 0);
  return {
    billed: billed.toFixed(2), discounts: discounts.toFixed(2), netRevenue: billed.minus(discounts).toFixed(2), expenses: expenses.toFixed(2),
    cashCollected: D(cashIn._sum.debit ?? 0).toFixed(2), cashPaidOut: D(cashIn._sum.credit ?? 0).toFixed(2),
    outstanding: outstanding.toFixed(2), surplus: billed.minus(discounts).minus(expenses).toFixed(2),
    collectionRate: billed.minus(discounts).gt(0) ? Number(billed.minus(discounts).minus(outstanding).div(billed.minus(discounts)).times(100).toFixed(1)) : null,
  };
}
