# Deployment

## What was verified and what was not

**Verified by actually running it, in real Docker containers (2026-09-25, Docker 29 on WSL2)** — repeatable with two scripts:

```bash
node deploy/verify-docker.mjs        # 69 checks, ~6 min: failure modes, authentication, worker, tower, registration
node deploy/verify-docker-ui.mjs     # 18 checks: a real browser against real containers, with screenshots
```
(They create and remove their own `ssv-*` / `ssu-*` containers and network. If Docker's credential helper fails with "error getting credentials", run with `DOCKER_CONFIG=<a directory containing {}>`. The browser script needs Chromium's system libraries — see [testing](testing.md).)

| Scenario | What is checked |
|---|---|
| **A. bare `docker run`, no configuration** (the reported failure) | the log names exactly what is missing and how to fix it (no secrets); `/api/health` → 503 `SERVER_MISCONFIGURED`; setup, login and the tower's API answer with a structured 503 and a reference id instead of a bare 500; repeated requests don't flood the log; Docker marks the container **unhealthy**; in the browser the setup/login pages say *"The school server isn't ready"* and the tower says *"The Control Tower isn't ready"* — not "Something went wrong" / "Can't reach" |
| **B. correct `docker run` recipe** (user-defined network, PostgreSQL, school, worker, tower) | database created and migrated by the preflight; all containers **healthy**; **setup → login → session → protected route → logout**; wrong password → 401, no cookie; setup can't run twice; cookie is `HttpOnly`, `SameSite=Lax`, not `Secure` on plain HTTP; **forced first-login password change**, session revocation, RBAC (a teacher gets 403 on users/backups), 5-strike lockout; a report requested through the web container is produced by the worker container; the tower signs in operators, issues a token, and **the school registers with it container-to-container by name**, heartbeats, and holds a verified signed licence |
| **C. Docker's default bridge network** | container names don't resolve; the container still starts; the log explains it; health/login → `DATABASE_UNAVAILABLE` |
| **D. database reachable but not migrated** | health/setup → `DATABASE_NOT_MIGRATED`; unhealthy; after `prisma migrate deploy` the **same container recovers by itself** |
| **E. offline server** | `docker run --network none … pnpm --version` works: nothing is downloaded at start-up |
| Compose stacks (school; tower) | `docker compose up` → migrate exits 0 → web and worker healthy in ~15 s; smoke test passes (setup, login, worker produces a report, PWA assets) |

**Defects this verification found, all fixed:** the image downloaded pnpm at container start (impossible offline); migrations were never applied on the `docker run` path; `/api/health` returned 200 when the database was down; there was no image `HEALTHCHECK`; the production build type-checked the tests folder (broke the image build); a message-text classifier mislabelled ordinary bugs as database problems (caught by an existing test, now driver-code based); see [audit](audit-and-skills.md#9-incident-docker-setuplogin-failing-and-cant-reach-the-control-tower).

**Still not verified:** other machines (LAN access from phones, a real reverse proxy/TLS — the `auto` cookie behaviour behind `X-Forwarded-Proto: https` is unit- and API-tested but not run through a real proxy), Windows-native Docker, long-running behaviour (days), image hardening scans, and hardware devices (RFID/fingerprint). The plain-`docker run` recipe above is what was tested; `docker run` with `localhost` for the database can never work inside a container (explained in the table above and in the container log).

## Environment variables

### School app and worker (`apps/school/.env`, or `deploy/school.env`)

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `APP_ENCRYPTION_KEY` | yes | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts backups and stored secrets. **Back it up separately.** |
| `APP_SIGNING_SECRET` | yes | 32 random bytes, base64. Signs QR codes and download URLs. |
| `STORAGE_DIR` | no (`/data/storage` in the image) | Uploaded files, outside the web root |
| `BACKUP_DIR` | no (`/data/backups` in the image) | Encrypted backup archives |
| `CLOUD_URL` | no | Default Control Tower address (also enterable at registration) |
| `CLOUD_PUBLIC_KEY` | no* | The tower's Ed25519 public key (base64 PEM). *Needed to accept licences; without it the school runs as a standalone 30-day trial then read-only. |
| `SESSION_COOKIE_SECURE` | no (`auto`) | `auto`: the session cookie is `Secure` exactly when the request arrived over HTTPS (directly, or via a proxy sending `X-Forwarded-Proto`). Force with `true` / `false`. Plain-HTTP LAN and TLS proxy both work with the default |
| `SESSION_TTL_HOURS` | no (12) | Session lifetime |
| `WORKER_NAME` | no | Worker identity (for running more than one) |

### Container start-up behaviour (both images)

| Variable | Default | Meaning |
|---|---|---|
| `WAIT_FOR_DB_SECONDS` | 60 | How long the preflight waits for PostgreSQL (it gives up sooner on a name that doesn't resolve or a wrong password, which won't fix themselves) |
| `AUTO_CREATE_DATABASE` | true | Create the database named in the URL if the server is reachable but it doesn't exist yet |
| `AUTO_MIGRATE` | true | The **web** container applies pending migrations before starting (idempotent; the compose file's `migrate` service does it first). Set `false` if migrations are run some other way |
| `SS_PREFLIGHT` | true | `false` skips the preflight entirely |

### Control Tower (`apps/cloud/.env`, or `deploy/cloud.env`)

| Variable | Required | Meaning |
|---|---|---|
| `CLOUD_DATABASE_URL` | yes | The tower's PostgreSQL |
| `CLOUD_ENCRYPTION_KEY` | yes | Encrypts installation secrets at rest |
| `CLOUD_SIGNING_PRIVATE_KEY` / `CLOUD_SIGNING_PUBLIC_KEY` | yes | Ed25519 pair (base64 PEM) — from `pnpm keys:generate` |
| `BACKUP_STORAGE_DIR` | no | Where uploaded school backups are kept |
| `SESSION_TTL_HOURS` | no (8) | Operator session lifetime |
| `SESSION_COOKIE_SECURE` | no (`auto`) | As for the school app. (It used to default to always-`Secure`, which browsers silently drop on plain HTTP except `localhost`.) |

## Which address goes where (Docker networking)

`localhost` means *"this same machine or container"*, so it changes meaning at every boundary. The addresses the system needs:

| From → to | Address to use | Notes |
|---|---|---|
| Browser → school app | `http://<server-ip>:3000` (published port; `http://localhost:3000` on the same computer) | The port is whatever `-p` / `WEB_PORT` publishes |
| Browser → Control Tower | `http://<tower-host>:3100` (its published port) | The tower's own pages call the tower's own `/api/ops/*` on the same address — nothing to configure |
| School container → PostgreSQL | the database **container name** on a shared network, e.g. `…@db:5432/smartschool_school` (compose), or `…@ssv-pg:5432/…` | **Not `localhost`** (that is the school container itself). On Docker's *default* bridge network container names do **not** resolve — use compose or a user-defined network |
| Tower container → its PostgreSQL | same rule, `CLOUD_DATABASE_URL` | Each app has its own database (`smartschool_school`, `smartschool_cloud`) |
| Worker container → PostgreSQL | same `DATABASE_URL` as the school app, and **the same** `APP_ENCRYPTION_KEY` / `APP_SIGNING_SECRET` | The worker shares the school's database and secrets |
| **School container → Control Tower** | on a shared network: `http://<tower-container-name>:3000` (the tower's *container* port). Otherwise `http://host.docker.internal:3100` (Docker Desktop) or the host's LAN IP and the published port | This is the cloud address typed into *Admin → Cloud and licence*; it is used **from inside the school container**, so it is *not* the address your browser uses. In production it is the tower's public `https://` name |
| Control Tower → school | **not used** | By design the school always calls out; the tower never connects in (it can only leave signed messages the school collects) |

## Running with plain `docker run` (without compose)

Compose is the supported way (`deploy/docker-compose.*.yml` supply every variable and the network). If you prefer `docker run`, three things must be right, and the containers now tell you clearly when they are not:

```bash
docker network create smartschool                                   # a USER-DEFINED network: container names resolve on it
docker run -d --name ss-pg --network smartschool -v ss-pgdata:/var/lib/postgresql \
  -e POSTGRES_PASSWORD='<long random>' postgres:18
docker run -d --name ss-school --network smartschool -p 3000:3000 -v ss-data:/data \
  -e DATABASE_URL='postgresql://postgres:<password>@ss-pg:5432/smartschool_school' \
  -e APP_ENCRYPTION_KEY="$(openssl rand -base64 32)" -e APP_SIGNING_SECRET="$(openssl rand -base64 32)" \
  smartschool/school:2.0.0
# the worker: SAME database URL and SAME two secrets (put them in an env file so both containers read the same values)
docker run -d --name ss-worker --network smartschool -v ss-data:/data --env-file school.env \
  smartschool/school:2.0.0 node_modules/.bin/tsx src/workers/main.ts
```

The school container creates the database if it is missing and applies the migrations before it starts; it reports itself unhealthy until config, database and schema are all fine (`docker ps` shows `(healthy)`). Keep the two secrets somewhere safe — see [backup](backup-recovery.md). The Control Tower is the same idea with the `CLOUD_*` variables (`pnpm keys:generate` prints them).

## When it doesn't work — read the container's log first

The first lines of `docker logs <container>` say what is wrong, by name and without printing secrets:

* `CONFIGURATION PROBLEM … DATABASE_URL is not set` — the container was started without its environment (a bare `docker run <image>`). Use compose or pass `-e`.
* `cannot connect (dns) … does not resolve` — a container name used on the default bridge network. Use compose or a user-defined network.
* `cannot connect (refused) … 'localhost' is THIS container` — `localhost` in a connection URL.
* `cannot connect (auth)` — the password differs from the database container's `POSTGRES_PASSWORD` (which only applies when the data volume is first created).
* `DATABASE MIGRATION FAILED` — the log shows Prisma's message.

In the browser the same problems appear as *"The school server isn't ready"* with a **Reference** code; the server log has one line (`"requestId":"…"`) carrying the same code and the real reason. The health endpoint (`/api/health`) returns 200 only when configuration, database and schema are all fine, and otherwise 503 with the failing stage.

## A school server with Docker

```bash
cp deploy/school.env.example deploy/school.env     # fill in the three secrets
docker compose -f deploy/docker-compose.school.yml --env-file deploy/school.env up -d --build
# open http://<server-ip>:3000  → setup wizard: school name + Primary Admin
```

Services: `db` (PostgreSQL 18, named volume), `migrate` (one-shot `prisma migrate deploy`), `web` (port 3000, health-checked at `/api/health`), `worker` (**healthy only while its heartbeat is fresh** — `scripts/worker-health.ts`; a wedged worker shows *unhealthy*, not *running*). Files and backups live in the `school-data` volume — **back that volume up**, and remember the nightly encrypted backups are inside it (copy them to a second device regularly).

Give the server a fixed LAN IP or a local DNS name and make sure phones on the school Wi-Fi can reach it. Time zone is Africa/Lagos (`TZ`). If you serve HTTPS through a reverse proxy, set `SESSION_COOKIE_SECURE=true`.

## The Control Tower with Docker

```bash
pnpm --filter @smartschool/cloud keys:generate     # copy the output into deploy/cloud.env
cp deploy/cloud.env.example deploy/cloud.env
docker compose -f deploy/docker-compose.cloud.yml --env-file deploy/cloud.env up -d --build
docker compose -f deploy/docker-compose.cloud.yml --env-file deploy/cloud.env run --rm web \
  pnpm exec tsx scripts/create-operator.ts you@example.com "Your Name" 'a-long-password' SUPER_ADMIN
```

Put it behind HTTPS (Caddy, nginx or Traefik on port 3100). Hand each school the `CLOUD_PUBLIC_KEY` printed by `keys:generate`.

## Without Docker (development, or a plain Linux/Windows server)

See the README quick start. For production without containers: PostgreSQL 18, Node 22+, `pnpm install`, `pnpm --filter @smartschool/school build`, `pnpm db:deploy`, then run `pnpm --filter @smartschool/school start` and `pnpm --filter @smartschool/school worker` under a process supervisor (systemd, NSSM, PM2) with the environment above.

## Upgrades

1. Take a backup (*Admin → Backup*), stop `web` and `worker`.
2. Build/pull the new image, run `migrate` (`prisma migrate deploy` is forward-only and idempotent), start `web` and `worker`.
3. A backup can only be restored into the schema version it was made with — after an upgrade, take a fresh backup.

The school reports its version in every heartbeat; publishing a release in the Control Tower flags schools still on an older one.

## First-run checklist

1. Setup wizard (Primary Admin, school name). Sign in.
2. *Admin → School settings* — name, logo, contacts, grading and result policies.
3. Academic year and terms, classes and sections, subjects, assign teachers.
4. Users & roles — create staff; hand out the one-time passwords.
5. Fee structures, then *Generate class invoices*.
6. Notification providers if wanted (SMTP / SMS gateway / WhatsApp), then a test message.
7. *Admin → Backup → Back up now* and confirm it verifies. Store `APP_ENCRYPTION_KEY` somewhere safe.
8. Register with the Control Tower (optional).
