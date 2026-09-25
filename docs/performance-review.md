# Performance review

Question: does a typical Nigerian secondary school (up to ~2,000 students) get instant screens on one modest server, and does the design avoid the usual traps?

## Measured

`PERF=1 pnpm exec vitest run tests/perf` (skipped in the normal run) builds a school with **2,000 students, 80,000 attendance rows (40 school days), 2,000 invoices, 50,000 audit entries**, runs `ANALYZE`, and times endpoints through the real request pipeline (session, permissions, licence checks included; best of three after a warm-up) on a development laptop with PostgreSQL 18 on the same machine. `PERF_SCALE=5` multiplies it.

| Endpoint | Time | Rows |
|---|---|---|
| Students, first page | 20 ms | 25 |
| Students, search by name | 26 ms | 25 |
| Students, deep page (≈ page 78) | 28 ms | 25 |
| Students in a class (page of 200) | 29 ms | 200 |
| Invoices, first page / filtered by status | 27 / 23 ms | 25 |
| Audit log, first page / filtered | 22 / 21 ms | 50 |
| Attendance roll call for a class of 667 | 48 ms | 667 |
| Dashboard KPIs (served from a ≤5 s snapshot; a recompute costs ≈ 80 ms) | 21 ms | — |
| Dashboard live overview (needs-attention counts, worker/sync/queue/backup health — fresh on every request) | 34 ms | — |
| Analytics computed in the background (all five datasets) | 13–77 ms each | — |

The test enforces budgets (reads < 800 ms, dashboard < 3 s, analytics compute < 5 s), so a regression fails it.

**Query plans** (`EXPLAIN`): attendance by student → index scan on the unique `(studentId, date, session)`; invoices by student → `invoices_studentId_status_idx`; audit newest-first → `audit_logs_occurredAt_idx`; a class's enrolments → composite `(classId, sectionId, academicYearId, status)`. None sequentially scans a large table.

## Design choices that keep it fast

* **Everything paged** with a hard `pageSize ≤ 200` cap; roll calls and score grids are the deliberate exceptions (one class at a time).
* **Snapshots where it pays, live where it's cheap**: the headline KPIs recompute inline after 5 s (≈ 80 ms, one shared computation for concurrent requests) so the dashboard is never stale and never depends on the worker; heavier datasets are refreshed by the worker every 10–30 minutes (and inline if no worker is alive); the "needs attention" and health panels are a handful of indexed counts run fresh each request.
* **Fixed query counts**: the teacher home uses a constant number of batched queries however many classes a teacher has (an earlier draft ran four per class-subject — replaced after review).
* **Foreign-key indexes**: 23 indexes added where a cascade, purge or per-request lookup would otherwise scan (see [database](database.md#indexes-on-foreign-keys)).
* **Heavy work off the request path**: imports, reports, backups, notification delivery and sync all run in the worker with a durable queue; the request only enqueues and the page polls status.
* **Indexes match the filters** (composite indexes led by the selective column; partial unique indexes for "current"/"open" rows).
* **Small payloads**: list endpoints use narrow `select`s; the sync payload is a projected allow-list, batched at 200 records.
* **Exam load**: answers are debounced and batched, each carrying a sequence number; the server does an idempotent upsert per answer, no per-keystroke traffic. Frozen question order means no re-shuffling queries.
* **Connection use**: transactions run their queries sequentially (parallel queries inside one transaction were a source of driver warnings), pool sized by the driver adapter.

## Not measured / limits

* **Concurrent load** (e.g. 500 students starting an exam at the same second) was **not** load-tested; only the per-request cost above was measured. The design (idempotent small writes, server-side deadline, no shared locks per exam) suggests it is sound, but rehearse a big exam on the real server and Wi-Fi first — Wi-Fi capacity is usually the bottleneck, not the application.
* Class **result processing** and **report card PDFs** for a whole class are background jobs; their duration was checked functionally in tests, not benchmarked at scale.
* The known Prisma/pg deprecation warning (parallel queries from a multi-`include` read) is harmless but noisy.
* Browser bundle sizes were not audited; pages are server-rendered shells with client islands, fonts are bundled locally (no external requests), and the exam room ships no heavy libraries.

## Suggested server

A school of 2,000 students: 2 vCPU / 4 GB RAM / SSD is comfortable for web + worker + PostgreSQL together (dominated by PostgreSQL cache); add RAM before CPU. Keep nightly backups on a second disk.
