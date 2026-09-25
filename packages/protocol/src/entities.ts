/**
 * What may leave a school — and therefore what the cloud will accept. Single source of truth shared by both
 * sides: the school projects rows down to these fields; the cloud REJECTS any record containing other fields.
 * Adding an entity here is a deliberate data-sharing decision.
 */
export type ConflictPolicy =
  /// Same-version divergence is queued for a human (money, results, exams, attendance, student records).
  | "MANUAL"
  /// Reference data with a single writer: same-version divergence resolves last-write-wins by record time.
  | "LAST_WRITE_WINS";

export interface SyncEntityDef {
  fields: readonly string[];
  policy: ConflictPolicy;
  /** Human label for the Control Tower. */
  label: string;
}

export const SYNC_ENTITIES = {
  student: { label: "Students", fields: ["id", "admissionNumber", "firstName", "lastName", "gender", "status", "admittedOn", "version"], policy: "MANUAL" },
  enrollment: { label: "Enrollments", fields: ["id", "studentId", "classId", "sectionId", "academicYearId", "status", "version"], policy: "MANUAL" },
  invoice: { label: "Invoices", fields: ["id", "number", "studentId", "termId", "status", "issuedAt", "dueDate", "subtotal", "discountTotal", "total", "amountPaid", "version"], policy: "MANUAL" },
  payment: { label: "Payments", fields: ["id", "receiptNumber", "studentId", "amount", "method", "status", "receivedAt", "reversedAt", "version"], policy: "MANUAL" },
  expense: { label: "Expenses", fields: ["id", "number", "category", "amount", "paidOn", "status", "version"], policy: "MANUAL" },
  report_card: { label: "Report cards", fields: ["id", "studentId", "termId", "classId", "average", "position", "status", "publishedAt", "version"], policy: "MANUAL" },
  attendance_log: { label: "Attendance", fields: ["id", "studentId", "staffUserId", "date", "session", "status", "method", "version"], policy: "MANUAL" },
  cbt_result: { label: "CBT results", fields: ["id", "attemptId", "score", "totalMarks", "percentage", "passed", "createdAt"], policy: "MANUAL" },
  admission_record: { label: "Admissions", fields: ["id", "applicationNumber", "status", "firstName", "lastName", "submittedAt", "version"], policy: "MANUAL" },
  academic_year: { label: "Academic years", fields: ["id", "name", "startDate", "endDate", "isCurrent", "version"], policy: "LAST_WRITE_WINS" },
  term: { label: "Terms", fields: ["id", "academicYearId", "name", "sequence", "startDate", "endDate", "isCurrent", "version"], policy: "LAST_WRITE_WINS" },
  school_class: { label: "Classes", fields: ["id", "name", "level", "stage", "version"], policy: "LAST_WRITE_WINS" },
  subject: { label: "Subjects", fields: ["id", "code", "name", "isActive", "version"], policy: "LAST_WRITE_WINS" },
} as const satisfies Record<string, SyncEntityDef>;

export type SyncEntityType = keyof typeof SYNC_ENTITIES;
export const isSyncEntity = (t: string): t is SyncEntityType => Object.hasOwn(SYNC_ENTITIES, t);

/** Returns the payload keys that are not in the entity's allow-list (empty = clean). */
export function unexpectedFields(type: SyncEntityType, payload: Record<string, unknown>): string[] {
  const allowed = new Set<string>(SYNC_ENTITIES[type].fields);
  return Object.keys(payload).filter((k) => !allowed.has(k));
}
