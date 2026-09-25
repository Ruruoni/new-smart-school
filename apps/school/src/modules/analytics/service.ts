import { db, Decimal } from "@/platform/db";
import type { Prisma } from "@/generated/prisma/client";
import { enqueueJob } from "@/platform/jobs";
import { workerAlive } from "@/platform/worker-status";
import { financeSummary } from "@/modules/finance/service";
import { average } from "@/modules/results/engine";
import { weakTopics } from "@/modules/cbt/scoring";

/**
 * Analytics are computed by dedicated query functions (SQL aggregates on indexed columns) and cached in
 * `analytics_snapshots`; dashboards read snapshots and never recompute in the request path. A background job
 * refreshes them; a stale read serves the cache and queues a refresh (stale-while-revalidate).
 */
export type Scope = string; // "school" | "term:<id>" | "class:<id>"
type Compute = (scope: Scope) => Promise<unknown>;

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);

// ───────────── Datasets ─────────────

export async function managementKpis() {
  const [students, byGender, staff, teachers, admissions, term] = await Promise.all([
    db.studentProfile.count({ where: { deletedAt: null, status: "ACTIVE" } }),
    db.studentProfile.groupBy({ by: ["gender"], where: { deletedAt: null, status: "ACTIVE" }, _count: true }),
    db.staffProfile.count({ where: { deletedAt: null } }),
    db.teacherProfile.count({ where: { deletedAt: null } }),
    db.admissionRecord.groupBy({ by: ["status"], _count: true }),
    db.term.findFirst({ where: { isCurrent: true }, include: { academicYear: true } }),
  ]);
  const enrolledByClass = await db.enrollment.groupBy({ by: ["classId"], where: { status: "ACTIVE", ...(term ? { academicYearId: term.academicYearId } : {}) }, _count: true });
  const classes = await db.schoolClass.findMany({ orderBy: { level: "asc" }, select: { id: true, name: true } });
  const finance = await financeSummary();
  const att = term ? await attendanceOverview(term.startDate, term.endDate) : null;
  const acad = term ? await termAcademicSummary(term.id) : null;
  const cbt = await db.cBTResult.aggregate({ _avg: { percentage: true }, _count: true, where: { publishedAt: { not: null } } });
  return {
    term: term ? { id: term.id, name: term.name, year: term.academicYear.name } : null,
    enrollment: { total: students, male: byGender.find((g) => g.gender === "MALE")?._count ?? 0, female: byGender.find((g) => g.gender === "FEMALE")?._count ?? 0, byClass: classes.map((c) => ({ class: c.name, count: enrolledByClass.find((e) => e.classId === c.id)?._count ?? 0 })) },
    staff: { teachers, nonTeaching: staff },
    admissions: Object.fromEntries(admissions.map((a) => [a.status, a._count])),
    finance, attendance: att, academics: acad,
    cbt: { attempts: cbt._count, averagePercentage: cbt._avg.percentage === null ? null : Math.round(num(cbt._avg.percentage) * 10) / 10 },
  };
}

async function attendanceOverview(from: Date, to: Date) {
  const g = await db.attendanceLog.groupBy({ by: ["status"], where: { studentId: { not: null }, session: "DAY", date: { gte: from, lte: to } }, _count: true });
  const n = (s: string) => g.find((x) => x.status === s)?._count ?? 0;
  const total = g.reduce((s, x) => s + x._count, 0);
  return { present: n("PRESENT"), late: n("LATE"), absent: n("ABSENT"), excused: n("EXCUSED"), marks: total, rate: pct(n("PRESENT") + n("LATE"), total) };
}

async function termAcademicSummary(termId: string) {
  const cards = await db.reportCard.findMany({ where: { termId }, select: { average: true, status: true } });
  if (!cards.length) return { processed: 0, published: 0, average: null };
  return { processed: cards.length, published: cards.filter((c) => c.status === "PUBLISHED").length, average: average(cards.map((c) => Number(c.average))) };
}

export async function academicPerformance(termId?: string) {
  const term = termId ? await db.term.findUnique({ where: { id: termId } }) : await db.term.findFirst({ where: { isCurrent: true } });
  if (!term) return { term: null, classes: [], subjects: [], gradeDistribution: [], trend: [], topStudents: [] };
  const [byClass, classes] = await Promise.all([
    db.reportCard.groupBy({ by: ["classId"], where: { termId: term.id }, _avg: { average: true }, _max: { average: true }, _min: { average: true }, _count: true }),
    db.schoolClass.findMany({ select: { id: true, name: true, level: true }, orderBy: { level: "asc" } }),
  ]);
  const subjectRows = await db.$queryRaw<{ subject: string; avg: string; n: number; pass: number }[]>`
    SELECT s.name AS subject, AVG(er.percentage)::text AS avg, COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE er.percentage >= 40)::int AS pass
    FROM exam_results er JOIN class_subjects cs ON cs.id = er."classSubjectId" JOIN subjects s ON s.id = cs."subjectId"
    WHERE er."termId" = ${term.id}::uuid GROUP BY s.name ORDER BY AVG(er.percentage) DESC`;
  const grades = await db.examResult.groupBy({ by: ["grade"], where: { termId: term.id }, _count: true, orderBy: { grade: "asc" } });
  const trend = await db.$queryRaw<{ term: string; year: string; class: string; avg: string }[]>`
    SELECT t.name AS term, ay.name AS year, c.name AS class, AVG(rc.average)::text AS avg
    FROM report_cards rc JOIN terms t ON t.id = rc."termId" JOIN academic_years ay ON ay.id = t."academicYearId" JOIN classes c ON c.id = rc."classId"
    GROUP BY t.name, ay.name, c.name, t."startDate", c.level ORDER BY t."startDate", c.level`;
  const top = await db.reportCard.findMany({ where: { termId: term.id, status: { in: ["PUBLISHED", "DRAFT"] } }, orderBy: { average: "desc" }, take: 10, include: { student: { select: { firstName: true, lastName: true, admissionNumber: true } } } });
  return {
    term: { id: term.id, name: term.name },
    classes: byClass.map((c) => ({ class: classes.find((x) => x.id === c.classId)?.name ?? "", students: c._count, average: Math.round(num(c._avg.average) * 100) / 100, highest: num(c._max.average), lowest: num(c._min.average) })).sort((a, b) => a.class.localeCompare(b.class)),
    subjects: subjectRows.map((s) => ({ subject: s.subject, average: Math.round(Number(s.avg) * 100) / 100, results: s.n, passRate: pct(s.pass, s.n) })),
    gradeDistribution: grades.map((g) => ({ grade: g.grade, count: g._count })),
    trend: trend.map((t) => ({ term: `${t.year} ${t.term}`, class: t.class, average: Math.round(Number(t.avg) * 100) / 100 })),
    topStudents: top.map((t) => ({ name: `${t.student.firstName} ${t.student.lastName}`, admissionNumber: t.student.admissionNumber, average: Number(t.average), position: t.position })),
  };
}

export async function financeAnalytics(months = 12) {
  const since = new Date(); since.setMonth(since.getMonth() - (months - 1)); since.setDate(1); since.setHours(0, 0, 0, 0);
  const monthly = await db.$queryRaw<{ m: string; collected: string; billed: string }[]>`
    WITH pay AS (SELECT to_char(date_trunc('month', "receivedAt"), 'YYYY-MM') m, SUM(amount) collected FROM payments WHERE status = 'POSTED' AND "receivedAt" >= ${since} GROUP BY 1),
         inv AS (SELECT to_char(date_trunc('month', "issuedAt"), 'YYYY-MM') m, SUM(total) billed FROM invoices WHERE status IN ('ISSUED','PARTIALLY_PAID','PAID') AND "issuedAt" >= ${since} GROUP BY 1)
    SELECT COALESCE(pay.m, inv.m) m, COALESCE(collected,0)::text collected, COALESCE(billed,0)::text billed FROM pay FULL JOIN inv ON pay.m = inv.m ORDER BY 1`;
  const methods = await db.payment.groupBy({ by: ["method"], where: { status: "POSTED", receivedAt: { gte: since } }, _sum: { amount: true }, _count: true });
  const aging = await db.$queryRaw<{ bucket: string; total: string; n: number }[]>`
    SELECT CASE WHEN "dueDate" IS NULL OR "dueDate" >= CURRENT_DATE THEN 'current'
                WHEN CURRENT_DATE - "dueDate" <= 30 THEN '1-30' WHEN CURRENT_DATE - "dueDate" <= 60 THEN '31-60'
                WHEN CURRENT_DATE - "dueDate" <= 90 THEN '61-90' ELSE '90+' END AS bucket,
           SUM(total - "amountPaid")::text total, COUNT(*)::int n
    FROM invoices WHERE status IN ('ISSUED','PARTIALLY_PAID') GROUP BY 1`;
  const debtors = await db.$queryRaw<{ id: string; name: string; adm: string; owed: string; oldest: Date | null }[]>`
    SELECT s.id, s."firstName" || ' ' || s."lastName" AS name, s."admissionNumber" adm, SUM(i.total - i."amountPaid")::text owed, MIN(i."dueDate") oldest
    FROM invoices i JOIN students s ON s.id = i."studentId" WHERE i.status IN ('ISSUED','PARTIALLY_PAID') GROUP BY s.id ORDER BY SUM(i.total - i."amountPaid") DESC LIMIT 15`;
  const byClass = await db.$queryRaw<{ class: string; billed: string; paid: string }[]>`
    SELECT c.name AS class, SUM(i.total)::text billed, SUM(i."amountPaid")::text paid
    FROM invoices i JOIN enrollments e ON e."studentId" = i."studentId" AND e.status = 'ACTIVE' JOIN classes c ON c.id = e."classId"
    WHERE i.status IN ('ISSUED','PARTIALLY_PAID','PAID') GROUP BY c.name, c.level ORDER BY c.level`;
  const expenses = await db.expense.groupBy({ by: ["category"], where: { status: "POSTED", paidOn: { gte: since } }, _sum: { amount: true }, orderBy: { _sum: { amount: "desc" } } });
  return {
    summary: await financeSummary(),
    monthly: monthly.map((r) => ({ month: r.m, collected: Number(r.collected), billed: Number(r.billed) })),
    methods: methods.map((m) => ({ method: m.method, amount: num(m._sum.amount), payments: m._count })),
    aging: ["current", "1-30", "31-60", "61-90", "90+"].map((b) => { const r = aging.find((a) => a.bucket === b); return { bucket: b, amount: r ? Number(r.total) : 0, invoices: r?.n ?? 0 }; }),
    debtors: debtors.map((d) => ({ studentId: d.id, name: d.name, admissionNumber: d.adm, owed: Number(d.owed), oldestDue: d.oldest?.toISOString().slice(0, 10) ?? null })),
    collectionByClass: byClass.map((c) => ({ class: c.class, billed: Number(c.billed), paid: Number(c.paid), rate: pct(Number(c.paid), Number(c.billed)) })),
    expensesByCategory: expenses.map((e) => ({ category: e.category, amount: num(e._sum.amount) })),
  };
}

export async function attendanceAnalytics(days = 30) {
  const since = new Date(); since.setDate(since.getDate() - days);
  const daily = await db.$queryRaw<{ d: Date; present: number; late: number; absent: number }[]>`
    SELECT date d, COUNT(*) FILTER (WHERE status='PRESENT')::int present, COUNT(*) FILTER (WHERE status='LATE')::int late, COUNT(*) FILTER (WHERE status='ABSENT')::int absent
    FROM attendance_logs WHERE "studentId" IS NOT NULL AND session='DAY' AND date >= ${since} GROUP BY date ORDER BY date`;
  const weekday = await db.$queryRaw<{ dow: number; absent: number; total: number }[]>`
    SELECT EXTRACT(ISODOW FROM date)::int dow, COUNT(*) FILTER (WHERE status='ABSENT')::int absent, COUNT(*)::int total
    FROM attendance_logs WHERE "studentId" IS NOT NULL AND session='DAY' AND date >= ${since} GROUP BY 1 ORDER BY 1`;
  const byClass = await db.$queryRaw<{ class: string; attended: number; total: number; late: number }[]>`
    SELECT c.name AS class, COUNT(*) FILTER (WHERE a.status IN ('PRESENT','LATE'))::int attended, COUNT(*)::int total, COUNT(*) FILTER (WHERE a.status='LATE')::int late
    FROM attendance_logs a JOIN enrollments e ON e."studentId" = a."studentId" AND e.status = 'ACTIVE' JOIN classes c ON c.id = e."classId"
    WHERE a.session='DAY' AND a.date >= ${since} GROUP BY c.name, c.level ORDER BY c.level`;
  const chronic = await db.$queryRaw<{ id: string; name: string; adm: string; absences: number }[]>`
    SELECT s.id, s."firstName" || ' ' || s."lastName" name, s."admissionNumber" adm, COUNT(*)::int absences
    FROM attendance_logs a JOIN students s ON s.id = a."studentId" WHERE a.status='ABSENT' AND a.session='DAY' AND a.date >= ${since}
    GROUP BY s.id HAVING COUNT(*) >= 3 ORDER BY COUNT(*) DESC LIMIT 20`;
  const names = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return {
    days,
    daily: daily.map((r) => ({ date: r.d.toISOString().slice(0, 10), present: r.present, late: r.late, absent: r.absent, rate: pct(r.present + r.late, r.present + r.late + r.absent) })),
    byWeekday: weekday.map((w) => ({ day: names[w.dow]!, absenceRate: pct(w.absent, w.total) })),
    byClass: byClass.map((c) => ({ class: c.class, rate: pct(c.attended, c.total), lateRate: pct(c.late, c.total) })),
    chronicAbsentees: chronic.map((c) => ({ studentId: c.id, name: c.name, admissionNumber: c.adm, absences: c.absences })),
  };
}

export async function cbtAnalytics() {
  const perf = await db.cBTTopicPerformance.groupBy({ by: ["topicId"], _sum: { attempted: true, correct: true } });
  const topics = await db.cBTTopic.findMany({ where: { id: { in: perf.map((p) => p.topicId) } }, select: { id: true, name: true, subject: { select: { name: true } } } });
  const rows = weakTopics(perf.map((p) => ({ topicId: p.topicId, attempted: num(p._sum.attempted), correct: num(p._sum.correct) })), 10).map((w) => ({ ...w, topic: topics.find((t) => t.id === w.topicId)?.name ?? "", subject: topics.find((t) => t.id === w.topicId)?.subject.name ?? "" }));
  const exams = await db.cBTExam.findMany({ where: { kind: "SCHOOL", attempts: { some: {} } }, select: { id: true, title: true, _count: { select: { attempts: true } } }, orderBy: { createdAt: "desc" }, take: 10 });
  const avg = await db.$queryRaw<{ exam: string; avg: string; n: number }[]>`
    SELECT e.title exam, AVG(r.percentage)::text avg, COUNT(*)::int n FROM cbt_results r JOIN cbt_attempts a ON a.id = r."attemptId" JOIN cbt_exams e ON e.id = a."examId"
    WHERE e.kind = 'SCHOOL' GROUP BY e.title ORDER BY MAX(r."createdAt") DESC LIMIT 10`;
  const prep = await db.$queryRaw<{ body: string; n: number; avg: string }[]>`
    SELECT e."examBody" body, COUNT(*)::int n, AVG(r.percentage)::text avg FROM cbt_results r JOIN cbt_attempts a ON a.id = r."attemptId" JOIN cbt_exams e ON e.id = a."examId"
    WHERE e.kind IN ('PRACTICE','MOCK') GROUP BY e."examBody"`;
  return {
    weakestTopics: rows.slice(0, 10),
    schoolExams: avg.map((a) => ({ exam: a.exam, attempts: a.n, average: Math.round(Number(a.avg) * 10) / 10 })),
    examPrep: prep.map((p) => ({ examBody: p.body, sessions: p.n, average: Math.round(Number(p.avg) * 10) / 10 })),
    recentExams: exams.map((e) => ({ id: e.id, title: e.title, attempts: e._count.attempts })),
  };
}

// ───────────── Snapshot cache ─────────────

/**
 * `ttlMinutes`: how long a computed snapshot is served. `live`: the dataset is cheap (measured ~80 ms at 2,000 students),
 * so a stale request recomputes it inline — the dashboard must reflect what just happened, and must not depend on the
 * worker running. Heavier datasets are refreshed by the worker, and inline only when no worker is alive.
 */
export const DATASETS: Record<string, { compute: Compute; ttlMinutes: number; live?: boolean }> = {
  "management.kpis": { compute: () => managementKpis(), ttlMinutes: 5 / 60, live: true }, // 5 s: concurrent requests share one ~80 ms computation
  "academic.performance": { compute: (s) => academicPerformance(s.startsWith("term:") ? s.slice(5) : undefined), ttlMinutes: 30 },
  "finance.overview": { compute: () => financeAnalytics(), ttlMinutes: 10 },
  "attendance.overview": { compute: () => attendanceAnalytics(), ttlMinutes: 15 },
  "cbt.overview": { compute: () => cbtAnalytics(), ttlMinutes: 30 },
};

export async function refreshSnapshot(key: string, scope: Scope = "school") {
  const d = DATASETS[key];
  if (!d) throw new Error(`Unknown analytics dataset "${key}"`);
  const data = JSON.parse(JSON.stringify(await d.compute(scope))) as Prisma.InputJsonValue;
  return db.analyticsSnapshot.upsert({ where: { key_scope: { key, scope } }, create: { key, scope, data }, update: { data, computedAt: new Date() } });
}

const inflight = new Map<string, Promise<Awaited<ReturnType<typeof refreshSnapshot>>>>();
/** Recompute once even if many requests notice staleness at the same moment. */
function refreshOnce(key: string, scope: Scope) {
  const k = `${key}:${scope}`;
  let p = inflight.get(k);
  if (!p) { p = refreshSnapshot(key, scope).finally(() => inflight.delete(k)); inflight.set(k, p); }
  return p;
}

/** Serve the cached dataset. Missing → compute; stale → recompute inline (live datasets, or no worker) or queue a background refresh. */
export async function getAnalytics(key: string, scope: Scope = "school") {
  const d = DATASETS[key];
  if (!d) throw new Error(`Unknown analytics dataset "${key}"`);
  let snap = await db.analyticsSnapshot.findUnique({ where: { key_scope: { key, scope } } });
  const isStale = (x: { computedAt: Date }) => Date.now() - x.computedAt.getTime() > d.ttlMinutes * 60_000;
  if (!snap) snap = await refreshOnce(key, scope);
  else if (isStale(snap)) {
    if (d.live || !(await workerAlive())) snap = await refreshOnce(key, scope);
    else await enqueueJob(db, "analytics", "analytics.refresh", { key, scope }, { dedupeKey: `analytics:${key}:${scope}` });
  }
  return { data: snap.data, computedAt: snap.computedAt, stale: isStale(snap) };
}

export async function refreshAll() {
  for (const key of Object.keys(DATASETS)) await refreshSnapshot(key);
}

export const analyticsJobHandlers = {
  "analytics.refresh": async (job: { payload: Record<string, unknown> }) => void (await refreshSnapshot(String(job.payload.key), String(job.payload.scope ?? "school"))),
  "analytics.refresh_all": async () => refreshAll(),
};
void Decimal;
