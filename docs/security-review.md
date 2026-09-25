# Security review

Scope: the school app, the worker, the Control Tower and the protocol between them, as built. Method: code reading of the security-critical paths, static searches, **executable whole-surface sweeps** (they run in the normal test suite), the browser tests, and a dependency audit. This is an engineering review by the authors' tooling, **not** an independent penetration test — commission one before handling real student data at scale.

## What was checked and how

| Area | Method | Result |
|---|---|---|
| Unauthenticated exposure | Test enumerates the route table: exactly 10 public routes; every other route returns 401 without a session | Pass |
| Least privilege | `tests/security-sweep.test.ts`: a signed-in user with **no role** calls every route; only 7 self-scoped routes answer (own session/password, notifications, own files, the current term name, own role count) plus logout; everything else 403 | Pass |
| Role separation | Teacher, parent and student get 401/403/404 on administrative endpoints; e2e: teacher can't read another teacher's class, parent gets 404 for another family's child, module disabled → server 403 | Pass |
| Input robustness | Sweep sends 8 hostile bodies (empty, array, `null`, invalid JSON, wrong types, `__proto__` pollution, 200 kB strings, NUL/RTL control characters) to **every** mutating route and malformed ids / extreme paging / SQL-shaped queries to **every** read route; no 5xx allowed; the Primary Admin count must stay 1 | Pass after fixes (below) |
| SQL injection | Every dynamic query uses Prisma or tagged-template `$queryRaw` (parameterised). The only `$executeRawUnsafe` calls are three fixed `SAVEPOINT` statements. Probes with `' OR 1=1--`, `;DROP TABLE` change nothing | Pass |
| XSS | React escaping everywhere; the only `dangerouslySetInnerHTML` renders the QR SVG generated locally by the `qrcode` library from our own data; strict CSP (no third-party origins) | Pass, low residual |
| CSRF | `SameSite=Lax` cookie + mandatory same-origin check on every mutating request (tested, including the operator API) | Pass |
| Session handling | Opaque token, only its hash stored, revoked on logout/password change, HttpOnly, `Secure` configurable; forced password change blocks all other calls | Pass |
| Brute force | Per-account lockout (5 → 15 min), identical message + equal work for unknown users, public admissions form throttled per IP/phone/application | Pass, see residual |
| Uploads | Magic-byte type detection, size limits, random keys outside web root, authenticated reads; e2e uploads a renamed executable and it is refused | Pass |
| Secrets | Encrypted at rest (AES-256-GCM); password hashes argon2id; masked in API responses (test: a gateway key never appears in `GET /communication/providers`); no secrets in logs (searched every `console.*`) | Pass |
| Cloud channel | HMAC-SHA256 over timestamp+body, 5-minute window, constant-time compare, uniform failure message; licences/commands Ed25519-verified locally; commands are replay-protected one-shots; no command can run code or change data | Pass |
| Data leaving the school | Allow-list of fields per entity enforced on both ends; cloud rejects unknown fields | Pass |
| Audit integrity | DB trigger blocks update/delete; hash chain verifiable | Pass |
| Operator API | Roles on every route (tested per route), cookie `SameSite=Strict`, lockout, audit; backups download is super-admin only and audited | Pass |
| Dependencies | `pnpm audit --prod` | 4 advisories, all transitive and not reachable here — see below |

## Defects found and fixed during the review

1. **500s on hostile input.** A `null`/array body crashed services that destructure the body; a request missing a required id reached Prisma as an invalid query; a NUL character (`\u0000`) in any text — body, query string or path — made PostgreSQL error; malformed UUIDs in the path (`/students/abc`) became 500s; `page=-1` or `pageSize=abc` on two list routes (payments, audit) produced negative/NaN `skip`/`take`. **Fix at the shared choke points:** the JSON reader accepts only objects and rejects NUL; the router rejects NUL and undecodable addresses with 422; `toSafeError` maps Prisma "invalid argument" to 422 and "invalid uuid" to 404; a `pageParams` helper clamps paging. None leaked data (the client only ever saw a generic message), but they were unhandled faults, and the sweep now keeps it that way.
2. **Provider settings could be silently wiped.** Saving the e-mail server replaced the whole provider configuration, switching off SMS/WhatsApp. Saving now merges per channel; there is a per-provider *Remove*, and a *Send test message* so a wrong configuration is found by the administrator, not by a parent who never got the SMS.
3. **Import created parent accounts but never gave their first passwords to the school** (only students'). Fixed and tested.
4. **Cloud API returned 500 for an unknown installation or a validation error**; now 404/400.
5. A suspended school could not use *Sync now* (blocked by the suspension it needed lifting) — an availability/recovery flaw, fixed; the exempt-route list is now pinned by a test.

## Residual risks and recommendations (not fixed; be aware)

| # | Risk | Recommendation |
|---|---|---|
| 1 | **Password policy is length-only (8–128).** | Consider a 10-character minimum for staff/admin and a "breached password" list; 2-factor for the Primary Admin and for Control Tower operators (not implemented). |
| 2 | **Throttles are in memory** (login IP throttle, admissions form). They reset on restart and are per process. Account lockout is stored in the database and is not affected. | Fine for the intended single-server school. For multiple web instances, put rate limiting at the reverse proxy. |
| 3 | **Operator lockout can be triggered by anyone who knows an operator's e-mail** (5 wrong tries → 15 min). | Restrict the tower by IP/VPN or put it behind an access proxy; operator sign-in is audited. |
| 4 | **Administrator-supplied outbound URLs** (cloud address, SMS/WhatsApp gateway) let an administrator make the server call an address of their choosing (SSRF by a trusted user). Local addresses are allowed deliberately because SMS gateways can live on the LAN. | Acceptable given only administrators can set them; block private ranges if the deployment model changes. |
| 5 | **CSP allows `'unsafe-inline'` scripts** (required by Next.js hydration without per-request nonces). | Move to nonce-based CSP when adopting Next's nonce support. |
| 6 | **One key (`APP_ENCRYPTION_KEY`) protects both backups and stored secrets.** Compromise of it exposes both. | Use separate keys with rotation; store the key outside the server that holds the backups. |
| 7 | **Cloud backups are opaque but only as safe as the school's key**; the tower's super admin can download them. | Keep the number of super admins small; downloads are audited. |
| 8 | **Docker images unverified**; no TLS termination is provided. | Terminate HTTPS at a reverse proxy; test the images before rollout. |
| 9 | **No login history/alerting to users** ("your account was used from…"). | Feature idea. |

## Dependency advisories (`pnpm audit --prod`, 2026-09-24)

| Package | Severity | Path | Assessment |
|---|---|---|---|
| `mysql2` (two advisories) | high / moderate | via `prisma` CLI | The project uses PostgreSQL only; the MySQL driver is never loaded. Fixed upstream in newer Prisma; upgrade Prisma when convenient. |
| `deepmerge-ts` | high | via `@prisma/config` | Runs in the Prisma CLI reading our own config file — not reachable from a request. |
| `uuid` | moderate | via `exceljs` | Affects `v3/v5/v6` with a caller-supplied buffer; ExcelJS does not use that path. |

Re-run `pnpm audit --prod` before each release.

## Addendum — second pass (audit-first)

* **New endpoints** (`/dashboard/overview`, `/teach/overview`, `/timetable/mine`, `/system/worker`) are permission-gated and covered automatically by the whole-surface sweeps (role-less user → 403; hostile input → never 5xx).
* **Scope, not parameters:** `/timetable/mine` ignores a student's `studentId` (always the caller); a parent's must pass the guardian-link check; another student's attendance/results return 404. Tested in unit tests and in the browser.
* **Dashboard sections are filtered on the server** by permission and by enabled module; a role without the permission receives `null` for that section, not a hidden one (tested).
* **The service worker never caches `/api/*`** (asserted in a real browser: after browsing as an administrator no API response is present in any cache).
* **Job failures:** malformed or forbidden work dead-letters instead of retrying; a conflict (409) stays retryable so a transient stale write can't permanently kill a job.
* **Errors and logs (second incident):** infrastructure failures are classified by driver error *code* (not by message text) into safe, generic user messages with a reference id; the server log line carries the same id, redacts connection strings/secrets, and identical repeats are throttled. Configuration problems never reveal variable names to visitors (they are in the log only). The public `/api/health` reports only which stage failed. Verified in containers that the database password appears nowhere in the logs.
* **Session cookie:** `SESSION_COOKIE_SECURE=auto` — `Secure` exactly when the request arrived over HTTPS (directly or via `X-Forwarded-Proto`). A client can only influence the flag on its own cookie. There is deliberately no e-mail password-reset flow (offline-first); administrators reset passwords, which revokes the user's sessions.
* **Containers:** the image runs as a non-root user under `tini`; placeholder build values are not baked into image environment (they are scoped to the build command); the worker's health check reads its heartbeat rather than assuming a running process is a working one.
