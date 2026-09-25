import type { Tx } from "./db";
import type { Prisma } from "@/generated/prisma/client";

/** Known domain events. New modules add to this list so subscribers stay type-checked. */
export type DomainEventType =
  | "student.admitted"
  | "attendance.absent"
  | "attendance.late"
  | "payment.received"
  | "payment.reversed"
  | "invoice.issued"
  | "invoice.overdue"
  | "result.published"
  | "admission.submitted"
  | "admission.approved"
  | "admission.rejected"
  | "exam.scheduled"
  | "cbt.result_available"
  | "announcement.published"
  | "sync.conflict_detected";

/** Transactional outbox: the event commits (or rolls back) together with the change that caused it. */
export async function publishEvent(tx: Tx, type: DomainEventType, payload: Record<string, unknown>): Promise<string> {
  const e = await tx.domainEvent.create({ data: { type, payload: payload as Prisma.InputJsonValue } });
  return e.id;
}
