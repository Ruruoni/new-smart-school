import { z } from "zod";
import { db, Decimal } from "@/platform/db";
import type { SecurityContext } from "@/platform/security/context";
import { AppError, validation } from "@/platform/errors";
import { isoDate, toDate, uuid } from "@/platform/util";
import { financeSummary } from "@/modules/finance/service";
import { getAnalytics } from "@/modules/analytics/service";
import { examResultsTable } from "@/modules/cbt/analytics";
import type { ReportData } from "./render";

export interface ReportDef<P extends z.ZodType = z.ZodType> {
  kind: string;
  label: string;
  /** User needs ANY of these. */
  permission: readonly string[];
  formats: readonly ("PDF" | "XLSX" | "CSV")[];
  params: P;
  build(ctx: SecurityContext, params: z.infer<P>): Promise<ReportData>;
}

const school = async () => (await db.schoolInstallation.findFirst({ select: { schoolName: true } }))?.schoolName ?? "School";
const all = ["PDF", "XLSX", "CSV"] as const;
const today = () => new Date().toISOString().slice(0, 10);
const money = (d: Decimal | number | string) => Number(new Decimal(d).toFixed(2));

const studentList: ReportDef = {
  kind: "STUDENT_LIST", label: "Student list", permission: ["students.view"], formats: all,
  params: z.object({ classId: uuid.optional(), status: z.enum(["ACTIVE", "SUSPENDED", "WITHDRAWN", "TRANSFERRED", "GRADUATED"]).default("ACTIVE") }),
  async build(_ctx, p: { classId?: string; status: string }) {
    const rows = await db.studentProfile.findMany({
      where: { deletedAt: null, status: p.status as never, ...(p.classId ? { enrollments: { some: { classId: p.classId, status: "ACTIVE" } } } : {}) },
      include: { enrollments: { where: { status: "ACTIVE" }, include: { class: true, section: true }, take: 1 }, guardians: { include: { parent: true }, orderBy: { isPrimary: "desc" }, take: 1 } },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    });
    return {
      title: "Student list", school: await school(), subtitle: `${p.status.toLowerCase()} students · ${rows.length} record(s)`,
      columns: [{ key: "adm", label: "Adm. No.", width: 1.3 }, { key: "name", label: "Name", width: 2.4 }, { key: "gender", label: "Sex", width: 0.7 }, { key: "dob", label: "Date of birth", format: "date", width: 1.2 }, { key: "class", label: "Class", width: 1.2 }, { key: "guardian", label: "Guardian", width: 2 }, { key: "phone", label: "Guardian phone", width: 1.5 }],
      rows: rows.map((s) => ({ adm: s.admissionNumber, name: `${s.lastName}, ${s.firstName}${s.middleName ? ` ${s.middleName}` : ""}`, gender: s.gender === "MALE" ? "M" : "F", dob: s.dateOfBirth, class: s.enrollments[0] ? `${s.enrollments[0].class.name}${s.enrollments[0].section ? ` ${s.enrollments[0].section.name}` : ""}` : "", guardian: s.guardians[0] ? `${s.guardians[0].parent.firstName} ${s.guardians[0].parent.lastName}` : "", phone: s.guardians[0]?.parent.phone ?? "" })),
    };
  },
};

const classResults: ReportDef = {
  kind: "CLASS_RESULTS", label: "Class result sheet", permission: ["results.view"], formats: all, params: z.object({ termId: uuid, classId: uuid }),
  async build(_ctx, p: { termId: string; classId: string }) {
    const [term, cls] = await Promise.all([db.term.findUnique({ where: { id: p.termId }, include: { academicYear: true } }), db.schoolClass.findUnique({ where: { id: p.classId } })]);
    if (!term || !cls) throw new AppError("NOT_FOUND", "Term or class not found", 404);
    const cards = await db.reportCard.findMany({ where: { termId: p.termId, classId: p.classId }, include: { student: { select: { id: true, firstName: true, lastName: true, admissionNumber: true } } }, orderBy: [{ position: "asc" }] });
    const results = await db.examResult.findMany({ where: { termId: p.termId, classSubject: { classId: p.classId } }, include: { classSubject: { include: { subject: { select: { code: true } } } } } });
    const subjects = [...new Set(results.map((r) => r.classSubject.subject.code))].sort();
    return {
      title: `Class result sheet — ${cls.name}`, school: await school(), subtitle: `${term.academicYear.name} · ${term.name}`,
      columns: [{ key: "pos", label: "Pos", format: "integer", width: 0.6 }, { key: "name", label: "Name", width: 2.6 }, { key: "adm", label: "Adm. No.", width: 1.4 }, ...subjects.map((s) => ({ key: `s_${s}`, label: s, format: "integer" as const, width: 0.8 })), { key: "total", label: "Total", format: "integer", width: 1 }, { key: "avg", label: "Avg %", format: "percent", width: 1 }],
      rows: cards.map((c) => ({ pos: c.position, name: `${c.student.lastName}, ${c.student.firstName}`, adm: c.student.admissionNumber, ...Object.fromEntries(subjects.map((s) => [`s_${s}`, results.find((r) => r.studentId === c.studentId && r.classSubject.subject.code === s)?.total ?? null])), total: c.totalScore, avg: c.average })),
      footnote: cards.some((c) => c.status !== "PUBLISHED") ? "Contains results that are not yet published." : undefined,
    };
  },
};

const attendanceReport: ReportDef = {
  kind: "ATTENDANCE", label: "Attendance register summary", permission: ["attendance.view"], formats: all, params: z.object({ classId: uuid, from: isoDate, to: isoDate }),
  async build(_ctx, p: { classId: string; from: string; to: string }) {
    if (p.from > p.to) throw validation("The start date must not be after the end date");
    const cls = await db.schoolClass.findUnique({ where: { id: p.classId } });
    if (!cls) throw new AppError("NOT_FOUND", "Class not found", 404);
    const students = await db.enrollment.findMany({ where: { classId: p.classId, status: "ACTIVE" }, select: { student: { select: { id: true, firstName: true, lastName: true, admissionNumber: true } } } });
    const logs = await db.attendanceLog.groupBy({ by: ["studentId", "status"], where: { studentId: { in: students.map((s) => s.student.id) }, session: "DAY", date: { gte: toDate(p.from), lte: toDate(p.to) } }, _count: true });
    const rows = students.map(({ student: s }) => {
      const n = (st: string) => logs.find((l) => l.studentId === s.id && l.status === st)?._count ?? 0;
      const total = n("PRESENT") + n("LATE") + n("ABSENT") + n("EXCUSED");
      return { name: `${s.lastName}, ${s.firstName}`, adm: s.admissionNumber, present: n("PRESENT"), late: n("LATE"), absent: n("ABSENT"), excused: n("EXCUSED"), rate: total ? ((n("PRESENT") + n("LATE")) / total) * 100 : null };
    }).sort((a, b) => a.name.localeCompare(b.name));
    return { title: `Attendance — ${cls.name}`, school: await school(), subtitle: `${p.from} to ${p.to}`, columns: [{ key: "name", label: "Name", width: 2.6 }, { key: "adm", label: "Adm. No.", width: 1.4 }, { key: "present", label: "Present", format: "integer" }, { key: "late", label: "Late", format: "integer" }, { key: "absent", label: "Absent", format: "integer" }, { key: "excused", label: "Excused", format: "integer" }, { key: "rate", label: "Rate", format: "percent" }], rows };
  },
};

const financeReport: ReportDef = {
  kind: "FINANCE_SUMMARY", label: "Finance summary & receipts", permission: ["finance.reports"], formats: all, params: z.object({ from: isoDate, to: isoDate }),
  async build(_ctx, p: { from: string; to: string }) {
    const from = toDate(p.from), to = new Date(toDate(p.to).getTime() + 86_399_999);
    const [sum, payments] = await Promise.all([financeSummary({ from, to }), db.payment.findMany({ where: { receivedAt: { gte: from, lte: to } }, include: { student: { select: { firstName: true, lastName: true, admissionNumber: true } } }, orderBy: { receivedAt: "asc" } })]);
    return {
      title: "Finance summary", school: await school(), subtitle: `${p.from} to ${p.to}`,
      columns: [{ key: "date", label: "Date", format: "date", width: 1 }, { key: "receipt", label: "Receipt", width: 1.6 }, { key: "payer", label: "Paid by / for", width: 2.4 }, { key: "method", label: "Method", width: 1.2 }, { key: "status", label: "Status", width: 1 }, { key: "amount", label: "Amount", format: "money", width: 1.4 }],
      rows: payments.map((x) => ({ date: x.receivedAt, receipt: x.receiptNumber, payer: x.student ? `${x.student.firstName} ${x.student.lastName} (${x.student.admissionNumber})` : x.payerName ?? "", method: x.method.replace("_", " "), status: x.status, amount: money(x.amount) })),
      summary: [{ label: "Billed (fees)", value: `₦${new Intl.NumberFormat("en-NG", { minimumFractionDigits: 2 }).format(Number(sum.billed))}` }, { label: "Discounts & scholarships", value: `₦${new Intl.NumberFormat("en-NG", { minimumFractionDigits: 2 }).format(Number(sum.discounts))}` }, { label: "Cash collected", value: `₦${new Intl.NumberFormat("en-NG", { minimumFractionDigits: 2 }).format(Number(sum.cashCollected))}` }, { label: "Expenses", value: `₦${new Intl.NumberFormat("en-NG", { minimumFractionDigits: 2 }).format(Number(sum.expenses))}` }, { label: "Outstanding (all time)", value: `₦${new Intl.NumberFormat("en-NG", { minimumFractionDigits: 2 }).format(Number(sum.outstanding))}` }],
    };
  },
};

const debtors: ReportDef = {
  kind: "DEBTORS", label: "Outstanding fees (debtors)", permission: ["finance.reports"], formats: all, params: z.object({ minBalance: z.coerce.number().min(0).default(0) }),
  async build(_ctx, p: { minBalance: number }) {
    const rows = await db.$queryRaw<{ adm: string; name: string; class: string | null; owed: string; oldest: Date | null; inv: number }[]>`
      SELECT s."admissionNumber" adm, s."lastName" || ', ' || s."firstName" name, (SELECT c.name FROM enrollments e JOIN classes c ON c.id = e."classId" WHERE e."studentId" = s.id AND e.status = 'ACTIVE' LIMIT 1) class,
             SUM(i.total - i."amountPaid")::text owed, MIN(i."dueDate") oldest, COUNT(*)::int inv
      FROM invoices i JOIN students s ON s.id = i."studentId" WHERE i.status IN ('ISSUED','PARTIALLY_PAID')
      GROUP BY s.id HAVING SUM(i.total - i."amountPaid") > ${p.minBalance} ORDER BY SUM(i.total - i."amountPaid") DESC`;
    const total = rows.reduce((s, r) => s.plus(r.owed), new Decimal(0));
    return { title: "Outstanding fees", school: await school(), subtitle: `As at ${today()} · ${rows.length} student(s)`, columns: [{ key: "adm", label: "Adm. No.", width: 1.4 }, { key: "name", label: "Student", width: 2.6 }, { key: "class", label: "Class", width: 1.2 }, { key: "inv", label: "Invoices", format: "integer", width: 0.9 }, { key: "oldest", label: "Oldest due", format: "date", width: 1.2 }, { key: "owed", label: "Balance", format: "money", width: 1.5 }], rows: rows.map((r) => ({ ...r, owed: money(r.owed) })), summary: [{ label: "Total outstanding", value: `₦${new Intl.NumberFormat("en-NG", { minimumFractionDigits: 2 }).format(Number(total))}` }] };
  },
};

const cbtResults: ReportDef = {
  kind: "CBT_RESULTS", label: "CBT exam results", permission: ["cbt.review_attempt"], formats: all, params: z.object({ examId: uuid }),
  async build(_ctx, p: { examId: string }) {
    const exam = await db.cBTExam.findUnique({ where: { id: p.examId } });
    if (!exam) throw new AppError("NOT_FOUND", "Exam not found", 404);
    const rows = await examResultsTable(p.examId);
    return { title: `CBT results — ${exam.title}`, school: await school(), subtitle: `${rows.length} attempt(s) · pass mark ${Number(exam.passMark)}%`, columns: [{ key: "pos", label: "#", format: "integer", width: 0.5 }, { key: "name", label: "Student", width: 2.6 }, { key: "adm", label: "Adm. No.", width: 1.4 }, { key: "score", label: "Score", width: 1 }, { key: "pct", label: "%", format: "percent", width: 0.9 }, { key: "result", label: "Result", width: 0.9 }], rows: rows.map((r, i) => ({ pos: i + 1, name: `${r.attempt.student.lastName}, ${r.attempt.student.firstName}`, adm: r.attempt.student.admissionNumber, score: `${Number(r.score)}/${Number(r.totalMarks)}`, pct: Number(r.percentage), result: r.passed ? "Pass" : "Fail" })) };
  },
};

const admissionsReport: ReportDef = {
  kind: "ADMISSIONS", label: "Admissions register", permission: ["admissions.view"], formats: all, params: z.object({ status: z.enum(["DRAFT", "SUBMITTED", "UNDER_REVIEW", "VERIFIED", "APPROVED", "REJECTED", "ENROLLED"]).optional() }),
  async build(_ctx, p: { status?: string }) {
    const rows = await db.admissionRecord.findMany({ where: p.status ? { status: p.status as never } : {}, orderBy: { createdAt: "desc" }, take: 5000 });
    return { title: "Admissions register", school: await school(), subtitle: p.status ? `Status: ${p.status}` : "All applications", columns: [{ key: "no", label: "Application", width: 1.6 }, { key: "name", label: "Applicant", width: 2.4 }, { key: "status", label: "Status", width: 1.2 }, { key: "guardian", label: "Guardian", width: 2 }, { key: "phone", label: "Phone", width: 1.4 }, { key: "date", label: "Submitted", format: "date", width: 1.1 }], rows: rows.map((r) => ({ no: r.applicationNumber, name: `${r.lastName}, ${r.firstName}`, status: r.status.replace("_", " "), guardian: r.guardianName, phone: r.guardianPhone, date: r.submittedAt })) };
  },
};

const teacherLoad: ReportDef = {
  kind: "TEACHER_LOAD", label: "Teacher workload", permission: ["teachers.view"], formats: all, params: z.object({}),
  async build() {
    const teachers = await db.teacherProfile.findMany({ where: { deletedAt: null }, include: { user: { select: { firstName: true, lastName: true } }, classSubjects: { include: { subject: { select: { name: true } }, class: { select: { name: true } } } }, _count: { select: { slots: true } } }, orderBy: { staffNumber: "asc" } });
    return { title: "Teacher workload", school: await school(), columns: [{ key: "no", label: "Staff No.", width: 1.1 }, { key: "name", label: "Name", width: 2.2 }, { key: "assignments", label: "Assignments", width: 4 }, { key: "count", label: "Classes×subjects", format: "integer", width: 1.2 }, { key: "periods", label: "Periods/wk", format: "integer", width: 1 }], rows: teachers.map((t) => ({ no: t.staffNumber, name: `${t.user.lastName}, ${t.user.firstName}`, assignments: t.classSubjects.map((c) => `${c.class.name} ${c.subject.name}`).join("; "), count: t.classSubjects.length, periods: t._count.slots })) };
  },
};

const subjectPerformance: ReportDef = {
  kind: "SUBJECT_PERFORMANCE", label: "Subject performance", permission: ["analytics.view", "results.view"], formats: all, params: z.object({ termId: uuid.optional() }),
  async build(_ctx, p: { termId?: string }) {
    const a = (await getAnalytics("academic.performance", p.termId ? `term:${p.termId}` : "school")).data as { term: { name: string } | null; subjects: { subject: string; average: number; results: number; passRate: number | null }[] };
    return { title: "Subject performance", school: await school(), subtitle: a.term?.name, columns: [{ key: "subject", label: "Subject", width: 2.6 }, { key: "results", label: "Results", format: "integer" }, { key: "average", label: "Average %", format: "percent" }, { key: "passRate", label: "Pass rate", format: "percent" }], rows: a.subjects };
  },
};

const management: ReportDef = {
  kind: "MANAGEMENT", label: "Management summary", permission: ["analytics.view"], formats: ["PDF", "XLSX"], params: z.object({}),
  async build() {
    const k = (await getAnalytics("management.kpis")).data as Record<string, any>;
    const money2 = (v: string | number) => `₦${new Intl.NumberFormat("en-NG", { minimumFractionDigits: 2 }).format(Number(v))}`;
    const rows = [
      { area: "Enrollment", measure: "Active students", value: String(k.enrollment.total) }, { area: "Enrollment", measure: "Male / Female", value: `${k.enrollment.male} / ${k.enrollment.female}` },
      { area: "Staff", measure: "Teachers", value: String(k.staff.teachers) }, { area: "Staff", measure: "Non-teaching staff", value: String(k.staff.nonTeaching) },
      { area: "Finance", measure: "Billed", value: money2(k.finance.billed) }, { area: "Finance", measure: "Cash collected", value: money2(k.finance.cashCollected) }, { area: "Finance", measure: "Outstanding", value: money2(k.finance.outstanding) }, { area: "Finance", measure: "Collection rate", value: k.finance.collectionRate === null ? "—" : `${k.finance.collectionRate}%` },
      { area: "Attendance", measure: "Attendance rate (term)", value: k.attendance?.rate == null ? "—" : `${k.attendance.rate}%` },
      { area: "Academics", measure: "Average score (term)", value: k.academics?.average == null ? "—" : `${k.academics.average}%` },
      { area: "CBT", measure: "Attempts / average", value: `${k.cbt.attempts} / ${k.cbt.averagePercentage ?? "—"}%` },
    ];
    return { title: "Management summary", school: await school(), subtitle: k.term ? `${k.term.year} · ${k.term.name}` : undefined, columns: [{ key: "area", label: "Area", width: 1.2 }, { key: "measure", label: "Measure", width: 2.4 }, { key: "value", label: "Value", width: 1.6, align: "right" }], rows };
  },
};

export const REPORTS: Record<string, ReportDef> = Object.fromEntries([studentList, classResults, attendanceReport, financeReport, debtors, cbtResults, admissionsReport, teacherLoad, subjectPerformance, management].map((d) => [d.kind, d]));

export function reportOrThrow(kind: string): ReportDef {
  const d = REPORTS[kind];
  if (!d) throw new AppError("UNKNOWN_REPORT", `Unknown report "${kind}"`, 400);
  return d;
}
