# Offline operation, sync and conflicts

## The rule

**A school never needs the internet to teach, mark, bill or examine.** Everything runs against the local PostgreSQL over the school's own Wi-Fi. Cloud features are additive.

## What is stored where

* **Authoritative data**: the school's database. Always.
* **In the cloud**: a *replica of an allow-list of fields* (`packages/protocol/src/entities.ts`: students, enrolments, invoices, payments, expenses, report cards, attendance, CBT results, admissions, and reference data like years, terms, classes, subjects). The school projects rows down to these fields; the cloud **rejects** any record containing others. Names, marks per subject, guardians' contact details, medical notes, documents and passwords never leave. Adding an entity there is a deliberate data-sharing decision.

## How a change reaches the cloud

1. In the same database transaction as the change, `enqueueSync` writes a row to the **sync queue** (transactional outbox): key `entity:id:vN:OP`, projected payload, payload hash.
2. The worker (`sync` loop, every 15 s) claims up to **200** due rows and POSTs a signed batch to `/api/v1/sync/batch`. If there is no network the rows simply wait — with **exponential back-off** 5 s → 15 s → 1 min → 5 min → 15 min → 1 h, up to 12 attempts before a row is parked as *dead* and surfaced to administrators.
3. The cloud ingests **idempotently**: `UNIQUE(installationId, idempotencyKey)` means a resent or duplicated batch is acknowledged as `DUPLICATE` without changing anything, so a crash between "cloud applied it" and "school heard back" is harmless.
4. Acknowledged rows are marked and eventually pruned; the *Cloud and licence* page and the Control Tower show waiting/failed/dead counts and the age of the oldest waiting change.

Sync is **replication, not backup** — see [backup-recovery](backup-recovery.md).

## Conflicts

A conflict is when the cloud already holds a higher — or equal but different — version of a record than the one arriving. It happens after a restore from an old backup or if two installations wrongly share an identity; normal operation has a single writer, so it is rare.

* **Reference data** (years, terms, classes, subjects): last write wins by record time.
* **Everything else** (money, results, attendance, students…): the conflict is recorded on both sides and **nothing is overwritten**. The school's *Cloud and licence → Conflicts* tab shows the two versions side by side; the administrator chooses **Keep local** (the school's version is re-sent with a higher version so the cloud converges), **Accept cloud** (allowed only for reference data — years, terms, classes, subjects — and refused by the server for anything else) or **Resolved manually** (after correcting the record in the app), with a note that is audited. The cloud's own conflict list is informational — **the school is authoritative**.

## Licence, suspension and outages

* The cloud issues an Ed25519-signed licence (plan, modules, feature flags, expiry, grace days, status) on registration and on every heartbeat that has newer terms. The school verifies it locally on every load against the embedded public key — a tampered or expired-signature token is ignored.
* `ACTIVE` → `GRACE` (after expiry, full access for `graceDays`, default 30, with a banner) → `EXPIRED` = **READ_ONLY** (data readable/exportable, writes refused). `SUSPENDED` (a signed status inside the licence) = **ADMIN_ONLY**: only the Primary Admin can sign in; writes are refused except the exempt routes (backup, export, own password, notifications, checking in with the cloud), so the principal can still take a backup and, once the matter is resolved, press *Sync now* to pick up the resumed licence.
* **Missing cloud ≠ restriction.** No heartbeat, an unreachable cloud, a decommissioned installation or a cloud that has vanished never changes the mode; only a verified licence can. A school that never registers gets a 30-day trial and then READ_ONLY until licensed (documented on the *Cloud and licence* page).
* Suspension takes effect only when the school **receives** the signed licence — the Control Tower says so on the suspend dialog.

## Heartbeat and commands

Every 60 s the worker posts health metrics (queue sizes, oldest waiting age, conflicts, worker beats, DB reachability, recent errors, active users, student count, last backup time). The reply carries the current licence and any pending **commands** — `MESSAGE` (banner text), `REQUEST_BACKUP` (queues a backup + upload), `REQUEST_DIAGNOSTICS` — each a signed one-shot JWS with an id. The school records applied ids, skips replays, and reports the applied ids on its *next* heartbeat, which is when the cloud marks the command delivered (at-least-once delivery, exactly-once effect). There is deliberately **no** command that runs code, changes data or unlocks anything.

## CBT and the exam room

The exam room (`app/(exam)`) does **not** wait for the server to render: its layout has no session fetch, so a refresh while the Wi-Fi is down still opens the exam.

* On the way in, the paper (frozen question and option order) is stored in **IndexedDB**; every answer is written to IndexedDB *first*, then sent (debounced, retried with back-off, flushed on `online`). Each answer carries a per-question `clientSeq`; the server applies only higher sequence numbers, so replays and out-of-order sends are harmless.
* The clock is the **server's** (offset measured at every sync); the deadline is enforced server-side, and the room auto-submits at zero — retrying every 5 s if the network is down, with answers safe on the device.
* A service worker (`public/sw.js`) caches the app shell and static assets so a reload works offline; it **never** caches `/api`. On submit or server-side finalisation the local copy is cleared.
* Verified end to end in a real browser: answer online → go offline → answer, flag, refresh → reload from the device → reconnect → server has every answer → submit.
