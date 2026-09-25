# SmartSchool ERP Suite 2.0

A school management system for Nigerian secondary schools that **runs on the school's own server and Wi-Fi**, with or without internet. An optional developer **Control Tower** in the cloud handles licensing, monitoring and support without ever being needed for day-to-day school work.

| | |
|---|---|
| `apps/school` | The school application: Next.js 16 (App Router) + PostgreSQL via Prisma 7, plus a background worker. One instance = one school. |
| `apps/cloud` | The Control Tower (cloud control plane): installations, licences, feature flags, monitoring, alerts, commands, backups received. Own database. |
| `packages/protocol` | The wire contract shared by both sides: request signing, sync/heartbeat/licence schemas, and the allow-list of data that may leave a school. |
| `deploy/` | Dockerfile, two compose files, env templates — built and run in containers, see what was and wasn't verified in [deployment](docs/deployment.md). |
| `docs/` | Everything below. |

## What it does

Students, guardians, staff · admissions with secure document upload · classes, subjects, timetable with clash detection · attendance (manual roll call, QR, RFID/fingerprint devices by API key) · continuous assessment and exam results with grading, positions and report cards · fees, invoices, payments, expenses on an append-only ledger, with an optional **financial lockout** of results · CBT exams with offline recovery and a single reusable WAEC/NECO/JAMB/BECE practice engine · lesson notes · parent and student portals · notifications (in-app, SMTP e-mail, HTTP SMS, WhatsApp Cloud) and an automation rule engine · analytics · PDF/Excel/CSV reports · Excel mass import · encrypted backup with verified restore · dynamic roles and permissions with a protected Primary Admin.

## Design in one paragraph

Every school is a self-contained deployment with its own PostgreSQL database. Changes are recorded in a transactional outbox and pushed to the cloud in idempotent batches **only when a connection exists**; only an explicit allow-list of fields ever leaves the school. The cloud can *inform* a school (signed licence, feature flags, messages, backup requests) but cannot reach in: everything it sends is Ed25519-signed and verified locally, and a suspension only takes effect when the school receives it — an outage or a silent cloud never locks anybody out, and even a suspended school keeps its data readable and exportable.

## Quick start (development)

Requires Node 22+ (developed on 24) and pnpm 12.

```bash
pnpm install
pnpm dev:db                       # a real PostgreSQL 18 on :5433 (embedded binaries; no Docker needed)  — leave running
cp apps/school/.env.example apps/school/.env   # fill APP_ENCRYPTION_KEY / APP_SIGNING_SECRET (openssl rand -base64 32)
cd apps/school
pnpm db:deploy                    # apply migrations
pnpm dev                          # http://localhost:3000  → the setup wizard creates the school and the Primary Admin
pnpm worker                       # in a second terminal: notifications, imports, reports, backups, sync
```

Control Tower:

```bash
cd apps/cloud
pnpm keys:generate                # prints the encryption key and the signing key pair → apps/cloud/.env  (+ CLOUD_PUBLIC_KEY for schools)
pnpm db:deploy && pnpm operator:create you@example.com "Your Name" 'a-long-password' SUPER_ADMIN
pnpm dev                          # http://localhost:3100
```

## Run with Docker

```bash
cp deploy/school.env.example deploy/school.env      # fill the three secrets:  openssl rand -base64 32
docker compose -f deploy/docker-compose.school.yml --env-file deploy/school.env up -d --build
# → http://localhost:3000 (setup wizard).  `docker ps` shows (healthy) only when configuration, database and schema are all fine.
```
Compose supplies every variable and the network. A bare `docker run` with no environment — or a database reached through `localhost` or a container name on Docker's default network — cannot work; the container's log and the browser now say exactly why. See [deployment](docs/deployment.md) for the address table, the plain-`docker run` recipe and troubleshooting. `node deploy/verify-docker.mjs` checks the images end to end.

## Documentation

- [Architecture](docs/architecture.md) — how the pieces fit, request pipeline, background work
- [Database](docs/database.md) — schema conventions and the integrity rules the database itself enforces
- [Modules](docs/modules.md) — what each module does and its main rules
- [Security, authentication and RBAC](docs/security.md)
- [Offline operation, sync and conflicts](docs/offline-and-sync.md)
- [Control Tower and licensing](docs/control-tower.md)
- [Backup and recovery](docs/backup-recovery.md)
- [Deployment](docs/deployment.md) — env vars, Docker, first run, upgrades, and what was and was not verified
- [Testing](docs/testing.md) — what the suites prove, how to run them
- [Troubleshooting](docs/troubleshooting.md)
- [Security review](docs/security-review.md) and [Performance review](docs/performance-review.md)
- [Repository audit and skill coverage](docs/audit-and-skills.md) (including the Docker authentication incident) — what was found, what changed, and an honest account of how the installed skills were used
