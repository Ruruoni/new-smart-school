import { beforeAll, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { handle } from "@/api/index";
import { DATASETS, refreshSnapshot } from "@/modules/analytics/service";
import { db } from "@/platform/db";
import { resetLoginThrottle } from "@/platform/auth/service";
import { ADMIN, resetDb } from "../helpers";
import { seedAcademics } from "../fixtures";

/**
 * Manual performance probe (skipped in the normal run):   PERF=1 pnpm exec vitest run tests/perf
 * Seeds a large school (SCALE× a typical 2,000-student secondary school) and times the endpoints people wait on.
 * Budget: every read a person waits on answers in well under a second on a laptop-class server.
 */
const SCALE = Number(process.env.PERF_SCALE ?? 1);
const STUDENTS = 2000 * SCALE, DAYS = 40, AUDIT = 50_000 * SCALE;
const chunks = <T,>(a: T[], n = 5000) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, (i + 1) * n));
let cookie = "", S: Awaited<ReturnType<typeof seedAcademics>>;
const timings: { name: string; ms: number; rows?: number }[] = [];

async function get(path: string) {
  const [p, qs] = path.split("?");
  const t0 = performance.now();
  const r = await handle(new Request(`http://school.local/api${p}${qs ? `?${qs}` : ""}`, { headers: { host: "school.local", cookie } }), p!.split("/").filter(Boolean));
  const body = await r.json();
  const ms = performance.now() - t0;
  expect(r.status, `${path} ${JSON.stringify(body).slice(0, 200)}`).toBe(200);
  return { ms, body };
}
async function time(name: string, path: string, budgetMs = 800) {
  await get(path); // warm the connection / plan cache; we measure steady state
  const runs = [await get(path), await get(path), await get(path)];
  const ms = Math.min(...runs.map((r) => r.ms));
  const d = runs[0]!.body.data;
  timings.push({ name, ms: Math.round(ms), rows: Array.isArray(d) ? d.length : d?.items?.length ?? d?.total });
  expect(ms, `${name} took ${Math.round(ms)} ms`).toBeLessThan(budgetMs);
}

describe.skipIf(!process.env.PERF)(`performance at ${2000 * (Number(process.env.PERF_SCALE ?? 1))} students`, () => {
  beforeAll(async () => {
    await rm("./.data/test-storage", { recursive: true, force: true });
    await resetDb(); resetLoginThrottle();
    S = await seedAcademics();
    const login = await handle(new Request("http://school.local/api/auth/login", { method: "POST", headers: { host: "school.local", origin: "http://school.local", "content-type": "application/json" }, body: JSON.stringify({ username: "owner", password: ADMIN.password }) }), ["auth", "login"]);
    cookie = /ss_session=[^;]+/.exec(login.headers.get("set-cookie")!)![0];

    const classes = [S.jss1.id, S.jss2.id, S.ss1.id];
    const ids = Array.from({ length: STUDENTS }, () => randomUUID());
    const first = ["Ada", "Chidi", "Ngozi", "Emeka", "Bisi", "Tunde", "Amina", "Ibrahim", "Funke", "Kelechi"], last = ["Okafor", "Eze", "Bello", "Adeyemi", "Nwosu", "Musa", "Obi", "Yusuf", "Balogun", "Ude"];
    for (const c of chunks(ids)) await db.studentProfile.createMany({ data: c.map((id) => { const i = ids.indexOf(id); return { id, admissionNumber: `ADM/P/${String(i).padStart(6, "0")}`, firstName: first[i % 10]!, lastName: `${last[(i >> 3) % 10]!}${i}`, gender: i % 2 ? "MALE" as const : "FEMALE" as const }; }) });
    const year = await db.academicYear.findFirstOrThrow();
    for (const c of chunks(ids)) await db.enrollment.createMany({ data: c.map((id) => ({ studentId: id, classId: classes[ids.indexOf(id) % 3]!, academicYearId: year.id })) });
    const rows: { studentId: string; date: Date; status: "PRESENT" | "ABSENT" | "LATE"; session: string }[] = [];
    for (let d = 0; d < DAYS; d++) for (let i = 0; i < ids.length; i++) rows.push({ studentId: ids[i]!, date: new Date(Date.UTC(2025, 8, 1 + d)), status: (i + d) % 17 === 0 ? "ABSENT" : "PRESENT", session: "DAY" });
    for (const c of chunks(rows, 10_000)) await db.attendanceLog.createMany({ data: c });
    const term = await db.term.findFirstOrThrow({ where: { isCurrent: true } });
    const inv = ids.map((id, i) => ({ number: `INV/P/${String(i).padStart(6, "0")}`, studentId: id, termId: term.id, status: (i % 3 === 0 ? "PAID" : i % 3 === 1 ? "PARTIALLY_PAID" : "ISSUED") as "PAID", issuedAt: new Date(), dueDate: new Date(Date.UTC(2025, 9, 1)), subtotal: 75000, total: 75000, amountPaid: i % 3 === 0 ? 75000 : i % 3 === 1 ? 30000 : 0 }));
    for (const c of chunks(inv)) await db.invoice.createMany({ data: c });
    // bulk audit history (hash values are placeholders: this probe measures reads, not tamper-evidence)
    await db.$executeRawUnsafe(`INSERT INTO audit_logs (id, "occurredAt", action, module, hash) SELECT gen_random_uuid(), now() - (g || ' seconds')::interval, 'x.action' || (g % 7), 'mod' || (g % 5), md5(g::text) FROM generate_series(1, ${AUDIT}) g`);
    await db.$executeRawUnsafe("ANALYZE");
  }, 600_000);

  it("the pages people wait on stay fast", async () => {
    await time("students, first page", "/students?page=1");
    await time("students, search by name", "/students?q=Chid");
    await time("students, deep page", `/students?page=${Math.floor(STUDENTS / 25) - 2}`);
    await time("students by class", `/students?classId=${S.jss1.id}&pageSize=200`);
    await time("invoices, first page", "/finance/invoices?page=1");
    await time("invoices, filtered by status", "/finance/invoices?status=ISSUED&page=3");
    await time("payments", "/finance/payments");
    await time("audit log, first page", "/audit?page=1");
    await time("audit log, filtered", "/audit?module=mod3&action=x.action2&page=5");
    await time("attendance roll call (class of ~670)", `/attendance/sheet?classId=${S.jss1.id}&date=2025-09-10`);
    await time("management KPIs (live: recomputed inline when >5 s old)", "/analytics/management.kpis", 3000);
    await time("dashboard overview (all counts fresh, every request)", "/dashboard/overview", 1500);
  }, 300_000);

  it("background analytics snapshots compute in a few seconds at this size", async () => {
    for (const key of Object.keys(DATASETS)) {
      const t0 = performance.now(); await refreshSnapshot(key); const ms = performance.now() - t0;
      timings.push({ name: `analytics compute: ${key}`, ms: Math.round(ms) });
      expect(ms, key).toBeLessThan(5000);
    }
  }, 120_000);

  it("query plans use indexes for the hot lookups", async () => {
    const explain = async (sql: string) => (await db.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN ${sql}`)).map((r) => r["QUERY PLAN"]).join("\n");
    const sid = (await db.studentProfile.findFirstOrThrow()).id;
    const plans: Record<string, string> = {
      "attendance for one student": await explain(`SELECT * FROM attendance_logs WHERE "studentId" = '${sid}' AND date >= '2025-09-01'`),
      "invoices for one student": await explain(`SELECT * FROM invoices WHERE "studentId" = '${sid}'`),
      "audit by module and time": await explain(`SELECT * FROM audit_logs WHERE module = 'mod3' ORDER BY "occurredAt" DESC LIMIT 50`),
      "enrolment of a class": await explain(`SELECT * FROM enrollments WHERE "classId" = '${S.jss1.id}' AND status = 'ACTIVE'`),
    };
    mkdirSync(".data", { recursive: true });
    writeFileSync(".data/perf-plans.json", JSON.stringify(Object.fromEntries(Object.entries(plans).map(([k, v]) => [k, v.split("\n").slice(0, 3).join(" | ")])), null, 2));
    expect(plans["attendance for one student"]).not.toMatch(/Seq Scan on attendance_logs/);
    expect(plans["invoices for one student"]).not.toMatch(/Seq Scan on invoices/);
    expect(plans["audit by module and time"]).not.toMatch(/Seq Scan on audit_logs/);
  });

  it("writes the timing table", () => { mkdirSync(".data", { recursive: true }); writeFileSync(".data/perf-timings.json", JSON.stringify(timings, null, 2)); });
});
