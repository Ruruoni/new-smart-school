# Repository audit and skill coverage

This records the audit the master specification (§32) asks for, what it found, what was changed, and — separately and honestly — how the installed skills were used. Findings are from reading the code and running it, not from assumptions about the UI.

## 1. Architecture map (as implemented)

```
Browser ──▶ Next.js web (apps/school: UI + one catch-all API) ──▶ business services ──▶ local PostgreSQL
                                                                        │  same transaction:
                                                                        ├─▶ audit_logs (hash chain, append-only trigger)
                                                                        ├─▶ domain_events (outbox → automation, notifications)
                                                                        └─▶ sync_queue   (outbox → cloud, allow-listed fields only)
Worker process (same code, separate process): events · delivery · imports · reports · analytics · backups · sync push · heartbeat · scheduler
        └─▶ HTTPS, HMAC-signed, only when online ─▶ Control Tower (apps/cloud, own PostgreSQL): registry · licences · flags · monitoring · alerts · commands
Browser exam room ─▶ IndexedDB (paper + answers) ─▶ local server; a service worker caches the shell (never /api)
```
Unchanged by this pass: isolated local installations, local PostgreSQL, offline-first operation, SyncQueue/outbox, the Control Tower, backend-enforced authorisation, audit trail, required workers.

## 2. Student portal

| Feature | Exists? | Working? | Accessible? | Issue found | Action |
|---|---|---|---|---|---|
| Exams / CBT, practice, progress, weak topics | yes | yes | yes | — | none (browser-tested offline) |
| Lesson notes | yes | yes | yes | reachable only from a tab | moved under **More** |
| Results / report card | **yes (API, scope, financial lockout)** | yes | **no — no page** | student role can call it; no UI existed | student page reusing the parent-portal page (the API already returns the student as "Self") |
| Attendance | **yes (API, scoped by `self.view`)** | yes | **no — no page** | same | reused parent-portal page |
| Timetable | **no self-scoped API** | — | no | staff-only endpoint | **new** `GET /timetable/mine` (student: own class+section; parent: linked child; teacher: own lessons; others 404), page + tests |
| Announcements | yes | yes | no (student) | not shown to students | in **More** |
| Notifications | yes (engine + bell component) | yes | **no in the portals** | portal header had no bell: parents/students could never read "results published / absent today" | bell added to the portal shell; session refreshed every 90 s |
| Profile / change password | yes (page) | yes | no link | no way to reach it | linked from **More** |
| Fees | yes for parents | yes | intentionally no for students | student role has no `finance.view` | left denied (intentional; an administrator can grant it) |

## 3. Admin dashboard

| Area | Exists? | Data source | Working? | Issue | Action |
|---|---|---|---|---|---|
| Headline KPIs | yes | real queries → cached snapshot | **partly** | served from a snapshot up to 10 min old, and a stale snapshot was refreshed **only by the worker** — with the worker down the numbers froze | live datasets recompute inline after 5 s (concurrent requests share one ~80 ms computation); every dataset recomputes inline when no worker is alive; page refreshes itself every 30 s |
| Needs attention | no | — | — | spec lists pending items | **new**, live counts: applications, unpublished report cards, overdue invoices, undeliverable messages, sync conflicts, exams in progress |
| System health | no | — | — | spec lists sync/queue/conflicts/worker health | **new**: worker, cloud connection, sync backlog/stuck, jobs, messages, backup, licence |
| Recent activity | no | — | — | | **new** (audit log, only if `audit.view`) |
| Isolation/RBAC/modules | — | — | yes | — | every section is filtered server-side by permission and enabled module (tested) |

## 4. Report download pipeline

| Stage | Status | Finding | Action |
|---|---|---|---|
| Button → request → export row + job (one transaction) | working | — | — |
| Queue (PostgreSQL, `SKIP LOCKED`) | working | — | direct tests added (concurrent claim, dedupe, durability) |
| **Worker not running** | **defect** | job sat in "Queued" forever with no explanation | worker liveness helper; Reports/Imports pages say "the background worker isn't running" and continue by themselves when it returns; dashboard reports it; container health check |
| Processing / retries | partly | *permanent* errors (e.g. "no report cards for that selection") were retried five times; failure state flickered FAILED between retries | permanent failures dead-letter at once; a retry shows "Waiting to start — Will retry: reason"; FAILED only when final |
| Failure message | defect | raw validation JSON shown to users | readable reason |
| File storage / authorised download | working | requester-only (and Primary Admin) | tested |
| Recovery | working | stale RUNNING jobs returned to the queue | tested |
| Lifecycle names | ok | QUEUED → RUNNING → SUCCEEDED / FAILED | shown to users as Waiting to start → Preparing → Ready / Failed |

## 5. System gaps

| Capability | Exists? | State | Needed? | Action |
|---|---|---|---|---|
| Generic job-queue behaviour tests | no | claim/retry/dead-letter/recovery were untested | yes (§30, §60) | 14 tests |
| Worker health in deployment | no | container was "healthy" while the worker was wedged | yes (§59) | `scripts/worker-health.ts` + compose `healthcheck` (script verified against a real DB; container not run) |
| Teacher home | thin | listed assignments only | yes (§26) | live workload: score-entry progress, class average, today's lessons, roll-call status, open exams |
| Feature-toggle matrix, role builder, permissions | yes | modules & features, users & roles pages | — | none |
| Weak-topic analysis (student) / CBT analytics (teacher) | yes | working | — | none |
| Foreign keys without indexes | partly | 39 of 105 unindexed | yes | 23 indexes added; the rest pinned with reasons |
| Installable PWA | partly | SVG-only icons; service-worker version never changed | yes (§18 offline, PWA skill) | PNG 192/512 + maskable; per-build cache version; tested |
| Production build reproducibility | defect | `next build` type-checked the tests folder, which broke the Docker build | yes | build-only tsconfig for both apps |
| Offline exam, sync, conflicts, licence, backup | yes | verified in earlier phases | — | none |

## 6. Skill coverage — what was actually used, and what the skills actually contained

**Read this before trusting the checkmarks.** On inspection, eight of the installed skills — *Senior Architect, Senior Backend, Senior Frontend, Senior Fullstack, Code Reviewer* and also *Senior QA, Senior Security, Senior DevOps* — are one identical template: generic advice ("follow established patterns", "validate all inputs", "use parameterised queries"), placeholder reference files, and Python "analyzers" that print "0 findings" for any directory (verified by running them). They contain no domain guidance to apply beyond those platitudes, so their rows below record the principle applied and the specification's own review dimensions, not skill-specific checklists. *UI Design System* is a 32-line description plus a token-generator script. The skills with real content are *backend-architect, postgresql, prisma-expert, docker-expert, progressive-web-app, react-best-practices, tailwind-patterns, ui-ux-pro-max, frontend-design*. Only skills that were actually read appear as "applied".

| Skill | Task where used | Guidance actually applied | Evidence |
|---|---|---|---|
| Senior Architect (template) | architecture map; boundary and preservation check | the §1 invariants re-verified after each change. Its three scripts are stubs and are **not** cited as evidence | §1, §7 |
| Senior Backend (template) + **backend-architect** (real) | job queue, worker liveness, dashboard service | *long-running operations need status polling/progress; retries with back-off and a dead-letter state; idempotency; deep health checks* → permanent-vs-transient failures, `worker-status`, honest report states, container health check | `platform/jobs.ts`, `worker-status.ts`, `analytics/overview.ts`; 14 job tests |
| **postgresql** (real) | schema review | *"PostgreSQL does not auto-index foreign keys"* → audited all 105 FKs, found 39 unindexed, added 23 indexes in migration `fk_support_indexes`, pinned the rest in a test. Also checked: NUMERIC for money ✓, text ✓, CHECK/partial-unique constraints ✓. **Deviation noted:** the skill says avoid `timestamp` without time zone; the project deliberately uses Prisma's `timestamp` with every session forced to UTC | migration, `tests/db-integrity.test.ts`, `docs/database.md` |
| **prisma-expert** (real) | queries and migrations | *"no N+1 queries"* → the teacher overview's per-class-subject queries were replaced with a fixed number of batched ones; *migrations* → `--create-only`, reviewed SQL, `migrate deploy` in the compose file, `migrate status` clean | `results/teacher-overview.ts` |
| Senior Frontend (template) | dashboard, teacher home, notice, student/parent pages | typed components; loading/error/empty states; accessible progress bars and live regions; polling that pauses when hidden/offline | `ui/dashboard-live.tsx`, `ui/worker-notice.tsx`, e2e spec 07 |
| Senior Fullstack (template) | every feature traced DB → service → authorisation → API → UI → user action → DB | report download, dashboard, student pages, notifications, PWA install | e2e specs 07 and 08 |
| Frontend Design / **ui-ux-pro-max** (real) | earlier: the "register" design system; this pass: hierarchy (needs-attention first), ≥16 px text, 44 px targets, weak-network states, mobile tabs | existing tokens reused; no new visual language | UI files above |
| UI Design System (tiny) | component reuse | `Panel/Stat/Badge/DataState/Dialog` reused; new components follow the same tokens; the token generator was not needed because the tokens already exist | `ui/kit.tsx` API unchanged |
| **react-best-practices** (real) | data fetching and rendering | *eliminate waterfalls* → parallel `Promise.all` in each new endpoint and independent parallel fetches on pages; *polling that doesn't waste work* → visibility/online-aware `useApi`; shared in-flight computation on the server | `overview.ts`, `useApi` |
| **docker-expert** (real) | deployment files | *separate dependency install from source copy* → manifests-first Dockerfile; *non-root user, tini, health checks, .dockerignore* ✓; ran `docker build --check` (fixed a secrets-in-ENV finding); **built the images and ran the stack** (see [deployment](deployment.md)), which found a real defect (tests type-checked in the production build) | `deploy/Dockerfile`, `tsconfig.build.json` |
| **progressive-web-app** (real) | offline shell and installability | its shipping checklist → found SVG-only icons (no 192/512 PNG, no true maskable icon) and a service-worker version that never changed (old builds' assets would pile up on devices); fixed both, tested | `public/icon-*.png`, `sw.js` route, `e2e/08-pwa.spec.ts` |
| Code Reviewer (template) | review after each phase against the spec's own dimensions (security, correctness, error handling, tests) | found and fixed: 409 wrongly treated as permanent; raw Zod dump shown to users; an over-broad licence exemption (caught by the pinned-list test); N+1 queries; SW cache versioning | the tests named above |
| Skill Creator | evaluated after implementation | see §8 | `.claude/skills/smartschool-conventions` |

## 7. Final architecture-preservation check (§21)

| Must NOT have happened | Verified |
|---|---|
| Shared-database SaaS / tenant columns | no tenant columns; one DB per school; cloud holds an allow-listed replica |
| Cloud-dependent CBT or core features | exam room has no server-render dependency; nothing added here calls the cloud |
| localStorage as primary store | not introduced; exam state stays in IndexedDB; the only localStorage use is the remembered child selection (per-viewer convenience) |
| Removal of PostgreSQL / SyncQueue / school isolation / offline / Control Tower | all present and tested (sync e2e, cloud tests, Control Tower browser spec) |
| Weakened backend authorisation | new endpoints are permission-gated and scope-checked; the whole-surface sweeps (role-less user, hostile input) cover them automatically |
| Removal of audit or workers | audit unchanged; worker now has liveness reporting and a container health check |

## 8. Skill Creator: is a SmartSchool skill justified?

Yes, narrowly. The same repository-specific steps recur on every task (guarded route → service with a security context → transaction with audit/outbox/sync in one commit → migration rules → tests → docs) and the generic installed skills do not know them; forgetting one (for example a licence-exempt route, a missing sync allow-list entry, or a local-time SQL comparison) has already caused real defects here. A short project skill, `.claude/skills/smartschool-conventions`, records the invariants and checklists. It was written and structurally validated, **not** put through the with-skill/without-skill benchmark loop (that requires spawning subagents, which was not requested), so its effectiveness is unmeasured.

## 9. Incident: Docker setup/login failing and "Can't reach the Control Tower"

**Reported:** with the containers running, `/setup` and login answered *"Something went wrong. Please try again."*, and the Control Tower page said *"Can't reach the Control Tower"*.

**What the running system actually showed** (inspected before changing anything): the containers had been created with plain `docker run` — random names, the default bridge network, **no environment variables at all** for the school and tower containers, no migration step, and PostgreSQL started separately with its default database. The school log said `Invalid environment configuration — DATABASE_URL … APP_ENCRYPTION_KEY … APP_SIGNING_SECRET: expected string, received undefined`; the tower's said the same for its `CLOUD_*` variables. Reproduced with throw-away containers: every endpoint — even `/api/health` — returned a bare, empty **HTTP 500**.

| # | Root cause (class of defect) | Evidence | Fix |
|---|---|---|---|
| 1 | The containers were started **without configuration** (the trigger) | logs above | preflight names what is missing and how to fix it; docs give the right recipe |
| 2 | **Configuration was validated when the database module was imported**, i.e. before the router's error handling existed, so a config problem escaped as a raw framework 500 with an empty body | reproduced; code trace | API loaded lazily inside the handler; a start-up failure becomes a structured 503 `SERVER_MISCONFIGURED` with a reference id (school and tower) |
| 3 | The browser client turned *any* body-less error into the literal "Something went wrong. Please try again." | `lib/api.ts` | honest fallback text per status; the reference id is shown; login/setup pages no longer swallow a failing status check and warn before anyone types a password |
| 4 | The tower labelled **every** non-401 failure "Can't reach the Control Tower" — false when the tower was reachable but misconfigured | `(tower)/layout.tsx` | "Can't reach" only for a real network failure; otherwise "The Control Tower isn't ready" + the real reason + reference |
| 5 | **False health**: `/api/health` returned HTTP 200 with `ok:false` when the database was down and never checked config or migrations; the image had no `HEALTHCHECK`, so a `docker run` container could not report unhealthy | code + `docker inspect` showed *none* | deep health (config → database → schema), 503 naming the stage, real `HEALTHCHECK` in the image |
| 6 | **Nothing applied the migrations** on the `docker run` path; a fresh database gives "table does not exist" | Prisma error captured live (`P2021`) | preflight creates a missing database and applies migrations; `DATABASE_NOT_MIGRATED` reported plainly; recovers by itself once migrated |
| 7 | Infrastructure errors (database down, wrong credentials, missing database, host not resolving) all collapsed to a generic 500 | real error shapes captured (`P1001`, `P1000`, `P1003`, `P2021`, and a plain "Connection terminated due to connection timeout" for an unresolvable host) | classified into `DATABASE_UNAVAILABLE / MISCONFIGURED / NOT_MIGRATED`; structured JSON log lines carry the request id, secrets redacted, repeats throttled |
| 8 | **`localhost` / Docker-default-bridge networking**: container names don't resolve on the default bridge, and `localhost` inside a container is the container itself | analysis; a name that doesn't resolve surfaces as a *timeout*, which is misleading | preflight recognises it and says so; a documented address table for every boundary (browser→school, school→PostgreSQL, school→tower, …) |
| 9 | **The image downloaded pnpm from the internet at container start** (pnpm 12 fetches its native binary on first run) — a school server without internet would hang | "Corepack is about to download …" in the log; confirmed with `--network none` | pnpm pre-fetched at build; the main processes run via `node` directly; verified offline |
| 10 | **Cookie trap**: the tower defaulted to an always-`Secure` session cookie, silently dropped by browsers on plain HTTP (except `localhost`) | analysis | `SESSION_COOKIE_SECURE=auto` (Secure only when the request arrived over HTTPS) in both apps |
| 11 | A malformed encryption key passed validation and failed later as a 500 at first encryption | code | validated at start-up (32 bytes, base64) with an instruction |
| 12 | Uploaded files and backups defaulted to a path inside the container's disposable layer | image config | default `/data`, declared as a volume |

**What was NOT the cause:** the setup and login code, password hashing, sessions/RBAC, the schema and migrations themselves, and the Control Tower's application logic. Started with correct configuration, the *same images* set up the Primary Admin, sign in, keep a session across reloads, enforce RBAC, run the worker and register with the tower (see [deployment](deployment.md#what-was-verified-and-what-was-not)). No authentication, RBAC, middleware or isolation behaviour was weakened, disabled or bypassed to achieve this.

**Skills used for this task** (same caveat as §6: the "Senior …"/Code Reviewer skills are placeholder templates and offered no domain checklist): *docker-expert* (health checks, non-root, layer caching, secrets-in-ENV lint — applied), *backend-architect* (deep health checks, resilience, observability with correlation ids — applied), *postgresql*/*prisma-expert* (error taxonomy from real Prisma failures; migrate deploy in the start-up path — applied), *react-best-practices* (effects that don't swallow errors, no stale state on retry — applied to the login/setup/tower pages), *ui-ux-pro-max*/*frontend-design* (actionable error wording, retry placement, kept the existing design tokens). Skill Creator was evaluated and **no separate skill was created** — the diagnostic workflow now lives in code (preflight, health, two verification scripts) and docs, so a skill would only duplicate them; the incident's rules were added to the existing `smartschool-conventions` skill instead.
