# Security, authentication and RBAC

## Authentication

* **Passwords**: argon2id (memory 19 MiB, 2 passes), 8–128 characters. New accounts get a generated temporary password shown **once** and must change it at first sign-in (`mustChangePassword` blocks every other API until done).
* **Sessions**: a random opaque token in an `HttpOnly`, `SameSite=Lax` cookie (`ss_session`); only its SHA-256 is stored, so a database leak does not yield usable sessions. Default lifetime 12 h (`SESSION_TTL_HOURS`). Signing out revokes the row. `SESSION_COOKIE_SECURE` defaults to `auto`: the cookie is `Secure` exactly when the sign-in request arrived over HTTPS (directly or via `X-Forwarded-Proto`), so plain-HTTP school LANs work and TLS deployments get the stricter cookie. `true`/`false` force it. There is deliberately **no e-mail "forgot password"** (the school must work offline): an administrator resets a user's password from *Users & roles*, which forces a change at next sign-in and revokes their sessions.
* **Lockout**: 5 wrong passwords lock the account for 15 minutes; the message for an unknown user and a wrong password is identical, and an unknown user still costs one hash verification (no timing oracle).
* **Public endpoints** are exactly ten, listed in `tests/api.test.ts` (health, setup status/setup, login, the admissions form/status/documents, the logo, and the device scan endpoint which uses an API key). A test fails if anything else becomes public, and another sends an unauthenticated request to *every* other route and requires 401.
* **Attendance devices** authenticate with per-device API keys (hashed at rest), not cookies.

## Authorisation (RBAC)

* **Permissions** are `module.action` strings from a catalogue (`platform/rbac/catalog.ts`), grouped into roles. Shipped roles: *Primary Admin* (protected, all permissions), *Principal*, *Registrar*, *Bursar*, *Teacher*, *Staff*, *Parent / Guardian*, *Student*. Administrators can create roles and assign any combination; a role assignment can carry a **scope** (e.g. a class) instead of the whole school.
* **The Primary Admin is protected in three layers**: the service refuses to delete/disable/demote it, the *Primary Admin* role can't lose permissions, and a database trigger plus a partial unique index enforce "exactly one, never removed" even against direct SQL.
* **Ownership checks** sit on top of permissions: a teacher reads/writes scores only for their own class-subjects (403 by API), a parent sees only their own children (an unrelated child id returns **404**, not 403, so existence is not revealed), a student sees only their own attempts.
* The UI hides what you can't do (`<Can>`), but that is cosmetic — the server checks every call.

## The central interceptor

One function, `secure()`, wraps every protected route (see [architecture](architecture.md#the-request-pipeline-platformsecurityinterceptorts)). Its guard options are mandatory in the route table, so a developer cannot forget them. Sensitive actions also write an **audit** entry inside the same transaction.

## Audit log

Append-only (database trigger), each row contains the SHA-256 of the previous row's hash plus its own content. `verifyAuditChain` recomputes the chain and reports the first broken link; deleting or editing history is both blocked and detectable. The Control Tower has its own append-only audit for operator actions.

## Uploads

Every upload goes through one gate (`platform/files.ts`): allowed types per profile (image, document, spreadsheet, attachment), size limits (2/5/10 MB…), **type decided by magic bytes, never the file name or the browser's claim**, random storage keys outside the web root, and reads only through an authenticated route that re-checks who may see the file. Spreadsheets are parsed with size/row limits.

## Web hardening

Strict CSP (`default-src 'self'`, no third-party origins, frames denied), `nosniff`, `Referrer-Policy: same-origin`, same-origin (CSRF) enforcement for every mutating call, generic error messages with a request id (no stack traces or SQL to clients), Zod validation of every input with 4xx (never 500) on bad input, per-IP and per-phone throttles on the public admissions form.

## Secrets at rest and in transit

* The school's cloud credential and provider API keys are **AES-256-GCM encrypted** with `APP_ENCRYPTION_KEY`.
* School ↔ cloud: every request is **HMAC-SHA256 signed** over timestamp + body with a per-installation secret (5-minute clock window); the cloud verifies in constant time and answers "invalid signature" for unknown installations and bad signatures alike. Cloud → school: licences and commands are **Ed25519 JWS**; the school holds only the public key.
* Backups are AES-256-GCM encrypted before they leave the database server; the cloud stores them opaquely.

## Operator (Control Tower) security

Separate accounts (argon2id, 12+ character passwords, 5-strike lockout), `SameSite=Strict` session cookies, roles `VIEWER < SUPPORT < SUPER_ADMIN` checked on every route, same-origin enforcement, and an audit record of sign-ins and every change. See [control-tower](control-tower.md). Findings from the review are in [security-review](security-review.md).
