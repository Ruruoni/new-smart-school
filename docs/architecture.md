# Architecture

## Processes

```
                school LAN (no internet needed)                                 cloud (optional)
 ┌──────────────┐   ┌──────────────────────────────┐   ┌────────────┐        ┌───────────────────────┐
 │ browsers /   │──▶│ web: Next.js (apps/school)   │──▶│ PostgreSQL │◀──────▶│ worker (same code)    │
 │ phones /     │   │  UI + /api/[[...path]]       │   │ (school DB)│        │  jobs, delivery, sync │
 │ scanners     │   └──────────────────────────────┘   └────────────┘        └───────────┬───────────┘
 └──────────────┘                                                                        │ HTTPS, HMAC-signed,
                                                                                         ▼ only when online
                                                                              ┌───────────────────────┐
                                                                              │ Control Tower         │
                                                                              │ apps/cloud + its own  │
                                                                              │ PostgreSQL            │
                                                                              └───────────────────────┘
```

* **Web** serves the UI and one catch-all API handler. **Worker** (`pnpm worker`) is a separate process that reads the same database: it processes events, delivers notifications, runs imports/reports/analytics/backups, pushes sync batches, sends the heartbeat and runs scheduled tasks. If the worker stops, the web app keeps working; the Control Tower shows a *Background workers* warning after 15 minutes.
* The school never depends on the cloud for a request. The cloud is contacted only from the worker (and from the administrator's *Sync now* button).

## Layers (apps/school/src)

| Path | Responsibility |
|---|---|
| `platform/` | Cross-cutting core: env, db (UTC session), errors, crypto, passwords, audit hash chain, sequences, events/outbox, typed settings, licence, feature flags, files, job queue, RBAC catalogue, the security interceptor. |
| `modules/<x>/` | Domain logic. `service.ts` functions take a `SecurityContext` first and run in a `transact()`. No HTTP in here. |
| `api/` | A declarative route table (`routes/*.ts`). Every route states its guard — nothing is unprotected by accident (a test audits this). |
| `app/` | Next.js pages: `(public)` login/setup/apply, `(app)` staff UI, `(portal)` parents and students, `(exam)` the exam room. |
| `ui/`, `lib/` | Design system ("the register"), client API helpers, exam offline store and logic. |
| `workers/` | The worker supervisor, its loops and the daily scheduler. |

## The request pipeline (`platform/security/interceptor.ts`)

Every non-public API call passes, in order:

1. **Same-origin check** for anything that changes data (CSRF).
2. **Session** (opaque cookie; only its SHA-256 is stored) → user must be active; forced password change blocks everything except the change itself.
3. **Installation** exists (setup completed).
4. **Licence mode** — `FULL`, `READ_ONLY` or `ADMIN_ONLY`. Writes are refused outside FULL; `ADMIN_ONLY` turns non-primary-admins away with `INSTALLATION_SUSPENDED`. A short list of routes is *licence-exempt* (backup, export, own password, notifications, checking in with the cloud) and a test pins that list.
5. **Module enabled** (a disabled module returns `MODULE_DISABLED` from the server, not just a hidden menu).
6. **Feature flag**, then **RBAC permission** (with resource scope), then domain **policies** (e.g. teachers only touch their own class-subjects, parents only their own children — IDOR attempts return 404).
7. Handler runs; errors are mapped to safe messages (`toSafeError`) with a request id; validation problems are 4xx, never 500.

## Data flow for changes

`service` mutation → same transaction writes: the row, an **audit** entry (hash-chained), an **outbox** event (`publishEvent`) and, for allow-listed entities, a **sync record** (`enqueueSync`). If the transaction rolls back, none of them exist. The worker turns events into notifications and automation runs, and pushes sync records to the cloud.

## Background work

* **Job queue** (`platform/jobs.ts`): durable rows in PostgreSQL, claimed with `FOR UPDATE SKIP LOCKED`, retried with back-off, stale jobs recovered.
* **Scheduler** (`workers/tasks.ts`): interval tasks (CBT attempt finalisation, automation rules, analytics refresh, auto-absentees) and *daily* tasks with catch-up if the server was off at the time — overdue-invoice scan 07:00, nightly backup 02:00, maintenance 03:30. Times are the school's clock.
* **Loops** (`workers/main.ts`): events 3 s, delivery 10 s, imports/reports 3 s, analytics 5 s, backups 10 s, sync 15 s, heartbeat 60 s.

## Job failure semantics and worker liveness

* A job is retried with back-off (5 s → 1 h) up to its `maxAttempts`, then becomes **DEAD** (the dead-letter state, visible on the dashboard). A failure retrying cannot fix — bad input, a missing record, "not permitted" (`PermanentJobError`, `ZodError`, or an `AppError` with a 4xx status other than 408/409/429) — dead-letters immediately. Conflicts (409) stay retryable because a stale write can clear by itself.
* Handlers are idempotent (a finished report is not produced twice); a job whose worker died mid-run is returned to the queue after 15 minutes.
* **A queued job proves nothing about the worker.** `platform/worker-status.ts` answers "is a worker actually beating (last 90 s)?". Pages that hand work to the worker (Reports, Imports) show *"The background worker isn't running"* instead of an endless "Waiting", the dashboard flags it, and the compose file's worker container is only *healthy* while its heartbeat is fresh (`scripts/worker-health.ts`).
* Report exports show *Waiting to start → Preparing → Ready*, or *Failed* with a plain reason; between retries they show *Waiting to start — Will retry: …*.

## Live dashboard

`GET /dashboard/overview` runs cheap indexed counts fresh on every request: things waiting on a person (applications, unpublished report cards, overdue invoices, undeliverable messages, sync conflicts, exams in progress) and — for people with the permission — system health (worker, cloud connection, sync backlog, jobs, messages, backup, licence) and recent audit activity. The server includes each section only if the caller may see it **and** its module is enabled. The KPI tiles come from snapshots that recompute inline after 5 s (about 80 ms at 2,000 students; concurrent requests share one computation); heavier analytics are refreshed by the worker, and recompute inline when no worker is alive, so a stopped worker can never freeze a number. The page refreshes itself every 30 s, pausing while the tab is hidden or offline.

## Frontend

Server-rendered shell, client components with a small typed fetch layer (`useApi`, optionally polling; independent calls run in parallel, no waterfalls). The exam room is deliberately outside the normal session gate (see [offline](offline-and-sync.md)). Design tokens: deep slate `#0f1b24`, teal `#0f766e`, pen-red for errors, Atkinson Hyperlegible + Source Serif 4 bundled locally (no CDN), ≥16 px text, state is never colour alone. A strict Content-Security-Policy is set in `next.config.ts`. The service worker is generated per build (`/sw.js` route, `lib/sw-source.ts`) so each deploy purges the previous build's caches; icons are PNG 192/512 plus a maskable icon.
