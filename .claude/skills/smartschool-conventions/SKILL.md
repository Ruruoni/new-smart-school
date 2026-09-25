---
name: smartschool-conventions
description: Repository-specific rules and checklists for the SmartSchool ERP monorepo (apps/school, apps/cloud, packages/protocol). Use whenever you add or change an API route, service, database migration, background job, sync entity, notification/automation event, portal page, Docker/deploy file or test in this repo — and before any change that could touch the local-first architecture (local PostgreSQL per school, offline operation, SyncQueue/outbox, Developer Control Tower, backend-enforced authorisation, audit). Read it even for small fixes, because most defects found in this codebase came from skipping one of these steps.
---

# SmartSchool conventions

The generic skills know engineering in general; this one knows **this repository**. Follow it in addition to them. The specification is `fresh_prompt.md` (outside the repo); the implemented behaviour is documented in `docs/`.

## Architecture invariants — never trade these away

Each school = its own local app + its own PostgreSQL + LAN; internet is optional. Changes replicate to the cloud only through the outbox, only allow-listed fields. The Control Tower informs a school (signed licence/commands) but never reaches in, and silence from the cloud never restricts a school. Authorisation is enforced on the server; hiding UI is cosmetic. Audit is append-only. Exams work with no server round-trip beyond the LAN (IndexedDB). If a library, skill or "best practice" suggests shared-database tenancy, cloud-only features, localStorage as a store, or dropping the worker/outbox — stop and adapt the advice instead.

## Adding an API endpoint (`apps/school/src/api/routes/*.ts`)

1. Declare the guard — it is mandatory and a test audits it: `route(METHOD, "/path", { module, permission, feature?, licenseExempt?, policies? }, handler)`. `permission` is "any of"; omit it only for routes every signed-in person may call, and expect the least-privilege sweep (`tests/security-sweep.test.ts`) to force you to justify it.
2. `licenseExempt` only for recovery/export/own-password/notification/cloud check-in routes. The list is pinned in `tests/api.test.ts`; widening it needs a reason.
3. The handler is one line: parse with `json(req)` (objects only; NUL characters are rejected centrally) and call a service `fn(ctx, input)`. Validate with Zod **inside the service**. Paging: `pageParams(query)` or `PageQuery` — never `Number(query.get(...))`.
4. Records a person shouldn't see → **404, not 403** (`assertCanAccessStudent`, `visibleStudentIds`). A student/parent endpoint must ignore client-supplied ids and derive scope from `ctx`.
5. Financial lockout is a policy, not a permission: results for parents/students go through `getReportCard`.

## Writing a service (`apps/school/src/modules/<x>/service.ts`)

`ctx: SecurityContext` first. Mutations run in `transact(tx => …)` and, **in that same transaction**: the write, `auditIn(tx, ctx, …)`, `publishEvent(tx, type, payload)` if something should react, and `enqueueSync(tx, entity, row)` only if the entity is in `packages/protocol/src/entities.ts` (adding an entity there is a data-sharing decision). Queries inside a transaction run **sequentially** (parallel ones warn and interleave). Optimistic concurrency: `updateMany where {id, version}` → `assertUpdated`. Money is `Decimal`, never float. Errors are `AppError` subclasses (`validation`, `notFound`, `forbidden`, `conflict`) — never leak internals.

## Time and raw SQL

The DB session is forced to UTC. In raw SQL compare against `now() AT TIME ZONE 'UTC'`; prefer Prisma. Dates the user sees are the school's local time (`Africa/Lagos`); day boundaries use the school's clock. User-controlled dotted paths use `safeGet`.

## Migrations

`pnpm exec prisma migrate dev --create-only --name x` → **review and append raw SQL (triggers, partial indexes, CHECKs) before applying** → `migrate deploy`. Never edit an applied migration. Prisma emits `DROP COLUMN` for type changes — rewrite as `ALTER COLUMN … TYPE … USING`. `prisma migrate reset` is blocked for agents; don't work around it. Foreign keys need a supporting index (PostgreSQL doesn't add one): `tests/db-integrity.test.ts` pins the accepted exceptions.

## Background work

Anything slow or that must survive a restart: `enqueueJob(tx, queue, type, payload, {dedupeKey})` + a handler in `src/workers`. Handlers must be **idempotent**. Throw `PermanentJobError`/`AppError` (4xx except 408/409/429) for failures retrying can't fix — they dead-letter at once; anything else retries with back-off. A UI that hands work to the worker must show real state: use `<WorkerNotice>` (worker not running ≠ "queued"), never a spinner that can last forever. New scheduled work goes in `src/workers/tasks.ts` (daily tasks catch up after downtime).

## UI (`apps/school/src/app`, `src/ui`)

One design system ("the register": deep slate + teal, ≥16 px text, ≥44 px targets, state never by colour alone). Reuse `Panel/Stat/Badge/DataState/Dialog`; fetch with `useApi(path, {refreshMs?})` (keeps data while reloading; polling pauses when hidden/offline) — several independent `useApi` calls run in parallel, don't chain them. Portals are mobile-first; students and parents share pages via `/me/children` ("Self"). Exam room: no session gate, IndexedDB first, service worker never caches `/api`.

## Tests — what "done" means

Real PostgreSQL, no mocked DB. Add: service tests (`tests/*.test.ts`), and for user-visible behaviour a Playwright spec (`e2e/*.spec.ts`, production build + real worker). The whole-surface sweeps run automatically over every new route. Run: `cd apps/school && pnpm test`; `cd apps/cloud && pnpm test`; browser: build cloud, build school, `LD_LIBRARY_PATH=<pwlibs> pnpm e2e` (see `docs/testing.md` for the Chromium-libraries workaround). Vitest collects `tests/**/*.test.ts` only. Failures get diagnosed, not deleted; several real bugs here were found *by* the browser tests.

## Deployment and diagnosing containers

Lessons from a real incident (setup/login said only "Something went wrong" and the tower "Can't reach the Control Tower", when the containers had simply been started without their environment).
- **Never let an infrastructure failure look like a generic error.** Config problems throw `ConfigError`/`CloudConfigError`; database/migration failures are classified by `classifyInfrastructureError` (in `packages/protocol`) into `DATABASE_UNAVAILABLE|MISCONFIGURED|NOT_MIGRATED` → HTTP 503 with a safe message and a `requestId`; the log line (JSON, secrets redacted, throttled) carries the same id. Routes load their code lazily (`src/app/api/[[...path]]`, cloud `safeRoute`) so a start-up failure is still a structured JSON answer, never a bare 500.
- **A health endpoint must check something**: `/api/health` returns 200 only if config, database and schema are all fine (`platform/health.ts`), else 503 naming the stage. Images carry a real `HEALTHCHECK`; the worker's is its heartbeat (`scripts/worker-health.ts`).
- **The container start-up path is code, not luck**: `deploy/preflight.mjs` (via `docker-entrypoint.sh`) checks config by name, waits for PostgreSQL and says *why* it can't connect (`localhost` is the container itself; names don't resolve on Docker's default bridge network), creates a missing database, migrates, then starts. Web starts degraded-but-explanatory; the worker exits 78. Nothing may need the internet at container start (pnpm is pre-fetched; main processes run via `node`/`node_modules/.bin`, not `pnpm`).
- **Diagnose in this order**: `docker ps` (health) → the first lines of `docker logs` → `curl /api/health` → the browser "Reference" code in the log → then code. Test both sides: from the browser *and* from inside the container (`docker exec`); browser URLs and container-to-container URLs differ.
- **Verify in real containers**: `node deploy/verify-docker.mjs` (failure modes, auth flows, worker, tower registration) and `node deploy/verify-docker-ui.mjs` (real browser). A green `docker build` proves nothing.
- Cookies: `SESSION_COOKIE_SECURE=auto` (Secure only over HTTPS). Data lives under `/data` (a volume).

## Before you say it's done

Update `docs/` if behaviour changed (docs must describe what exists, and say plainly what was not verified). Re-run typecheck, both test suites, both builds and the relevant e2e spec. Report honestly: what ran, what didn't, residual risks.
