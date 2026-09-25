# Testing

Everything runs against **real PostgreSQL 18** — no mocked database, no mocked network for the sync path.

## Suites

| Suite | Where | Count at last run | What it proves |
|---|---|---|---|
| School unit + integration | `apps/school/tests` (`pnpm test`) | **373 tests / 28 files** (+4 opt-in performance probes) | Every module's rules with a real DB: DB-level integrity (triggers, constraints, UTC), auth & lockout, the interceptor, RBAC/IDOR, licence modes, audit chain, outbox, users/roles, people, results engine, results service, finance & ledger, admissions & uploads, attendance, timetable solver, CBT scoring/attempts/analytics, communication & automation, imports, backup/restore/verify, analytics & reports, lesson notes, workers, the HTTP API (route table audit: only ten public routes, every other route 401 unauthenticated, licence-exempt list pinned), the exam room's offline logic, and **end-to-end sync over HTTP** against a real cloud request-handler harness. |
| Cloud | `apps/cloud/tests` | **30 tests / 2 files** | Registration tokens, HMAC signing and replay windows, licence determinism, idempotent ingest, conflict policies, allow-list rejection, alerts, operators, the whole operator API (auth, cookies, roles per route, cross-origin refusal, licence/suspend lifecycle, audit). |
| **Real containers** | `deploy/verify-docker.mjs`, `deploy/verify-docker-ui.mjs` | **69 + 18 checks** | The Docker images themselves: failure modes (no configuration, unresolvable database host, unmigrated database, offline start), the full setup/login/logout/RBAC/password flows, the worker, and container-to-container registration with the Control Tower — including a real browser. See [deployment](deployment.md#what-was-verified-and-what-was-not). |
| Browser end-to-end | `apps/school/e2e` (`pnpm e2e`) | **42 tests / 10 specs** | Real Chromium against the **production build**, a real worker, and a real Control Tower on a second port + database (see below). |

### What the browser specs cover

0. **Setup & admin** — setup wizard, sign-in, protected Primary Admin, module disable (server-side 403).
1. **People, admissions, attendance** — creating a student with a parent (first-login password change, IDOR 403/404), the public admissions journey (secure upload incl. a disguised `.exe` refused, access code, registrar workflow, enrolment), keyboard roll call.
2. **Results & fees** — score-entry grid by keyboard with autosave, instant validation, concurrent-edit conflict, teacher ownership; process (incomplete-sheet dialog) and publish; the parent's phone view and PDF; **financial lockout** on, payment via dialog lifts it, reversal re-applies it.
3. **CBT offline** — start an exam, go offline, answer/flag, reload with no network, reconnect, verify the server received everything, submit, publish, one-attempt rule.
4. **Import & reports** — Excel upload, row-level problems, skip-bad-rows approval, sibling sharing one parent, duplicates on re-upload, a fake `.xlsx` refused, background report → real downloaded workbook.
6. **Providers** — configure a (local stand-in) SMS gateway from the settings screen, send a test message, see a refusal explained, confirm editing the e-mail server leaves SMS configured, remove one provider.
5. **Control Tower ↔ school** — operator roles, create school → one-time token → school registers → heartbeat data → message banner at the school → suspend (admin-only mode, teacher turned away, principal still reads/exports) → resume → backup command → encrypted upload → download → audit → decommission (school keeps working) → mobile layout.
7. **Live dashboard, worker-down honesty and portals** — reports wait with a clear notice while the worker is stopped and finish by themselves when it returns; the dashboard flags the stopped worker and updates without a reload; a student sees their own report card, attendance and timetable (never another class's or student's, checked at the API too); the teacher home shows today's lessons and real score-entry progress; a parent gets the "results published" notification in the portal bell on a phone and marking it read persists.
8. **PWA** — the manifest's icons are real PNGs of the promised sizes (including a maskable one); the service worker is versioned per build, always revalidated, takes control, and no `/api` response is ever cached.
9. **Server problems** — what a person sees when the *server* is the problem: a misconfigured/unready server is explained on the login and setup pages before anyone types a password (with a reference id); a body-less 500 is described honestly; a database problem is named; a real network failure is still "offline"; the Control Tower distinguishes "Can't reach" (network) from "isn't ready" (it answered with an error).

## Running

```bash
pnpm dev:db                                    # PostgreSQL on :5433 (once, leave running)
cd apps/school && pnpm test                    # 373 school tests (creates/migrates the *_test databases itself)
cd ../cloud    && pnpm test                    # 30 cloud tests

# browser tests
cd apps/cloud  && pnpm build                   # the tower is started from its production build
cd ../school   && pnpm build && pnpm e2e       # e2e/prepare.ts recreates both e2e databases first
pnpm e2e e2e/03                                # a single spec
```

**Whole-surface sweeps** (`tests/security-sweep.test.ts`) run every API route with a role-less user and with hostile input (new routes are covered automatically); `tests/job-reliability.test.ts` covers the job queue and the report pipeline's failure lifecycle; `tests/dashboard.test.ts` the live overview; the **performance probe** (`PERF=1 pnpm exec vitest run tests/perf`) is skipped unless asked for — see [performance-review](performance-review.md).

Vitest only collects `tests/**/*.test.ts`; Playwright only `e2e/*.spec.ts`.

### Playwright on a machine without system libraries

Chromium needs some system libraries (`libnspr4`, `libnss3`, `libasound2`, …). Preferably `pnpm exec playwright install-deps` (needs root). Without root, download the `.deb`s (`apt-get download …`), extract them with `dpkg -x` into a folder, and run with `LD_LIBRARY_PATH=<folder>/usr/lib/x86_64-linux-gnu pnpm e2e`. This is how the suite was run in the authoring environment.

### The e2e worker lifecycle

The harness starts the worker in its **own process group** and records its pid (`.data/e2e-worker.pid`); stopping it kills the whole group (`tsx` runs the real worker as a child, so killing only the wrapper leaves it running and beating), and `pnpm e2e` first reaps a worker left by a previous run (only if its command line carries the harness marker, so your own `pnpm worker` is never touched). A leaked worker used to write heartbeats into the next run's database and make the "worker not running" checks race.

## Bugs the end-to-end tests found (all fixed, with regression tests where sensible)

Server accepted a birth date in the year 2999 · the score-conflict message was invisible (tooltip only) · "Process anyway" used a stale flag and re-opened its own dialog · the exam room could not open offline because the shared layout waited on the server · an answered *and* flagged question was counted as unanswered on the submit screen · the Excel import created parent accounts but omitted their first passwords from the credentials file · a suspended school's *Sync now* was blocked by the suspension it needed to lift · `GET /installations/:unknown` returned 500 instead of 404 · the process-incomplete dialog didn't name the students.

## Known test limitations

Attendance hardware (RFID/fingerprint) is tested only at the API-key scan boundary. The HTTP SMS and WhatsApp adapters are tested against a local HTTP server and the SMTP adapter with an injected transport — none against a live gateway or a real SMTP server, so provider credentials should be tried with the built-in *send test message* before relying on them. Docker images are not built (see [deployment](deployment.md)). There is no load test beyond the query-plan review in [performance-review](performance-review.md).
