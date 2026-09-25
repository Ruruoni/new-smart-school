# Database

PostgreSQL 18, one database **per school** (so no tenant column anywhere) and a separate database for the Control Tower. Schema is in `apps/school/prisma/schema/*.prisma` (split by area), migrations in `apps/school/prisma/migrations`.

## Conventions

* **UUID primary keys** (`uuid()`), so records created offline never collide. Human-facing numbers (admission number, invoice, receipt, staff number) are separate `UNIQUE` columns produced by a per-school **sequence** rule (`platform/sequence.ts`).
* **`version` column** on mutable records → optimistic concurrency (`updateMany … WHERE version = ?`; a stale write becomes a 409, never a silent overwrite) and the basis of sync conflict detection.
* **Soft deletes** (`deletedAt`) for people and academic records. Money and audit rows are never deleted.
* **Times are UTC** in the database. The connection forces `timezone=UTC`, and raw SQL compares against `now() AT TIME ZONE 'UTC'` (a real bug found and fixed: a Lagos session timezone made "due now" comparisons always true — there are regression tests).
* Domain areas: `platform` (installation, users, sessions, roles, permissions, flags, licence, settings, audit, files), `academic`, `people`, `admissions`, `assessment`, `finance`, `operations` (attendance, timetable, notes, sync queue, jobs, events, notifications, automation, imports, reports, backups), `cbt`, `services`.

## Integrity enforced by the database itself

These hold even if application code has a bug or someone uses SQL directly:

| Rule | Mechanism |
|---|---|
| Audit log cannot be updated or deleted; each row hashes the previous one | trigger `audit_logs_append_only` + hash chain (`verifyAuditChain`) |
| Financial ledger is append-only | trigger `financial_ledger_append_only` |
| Every journal entry balances (debits = credits) | deferred constraint trigger, checked at commit |
| At most one Primary Admin; it can't be deleted, disabled or demoted | partial unique index + trigger `users_protect_primary_admin` |
| Exactly one installation row | `singleton` unique column |
| One current academic year and one current term; one default grading scheme; one active licence | partial unique indexes (`… ((true)) WHERE …`) |
| One enrolment per student per academic year | unique key `(studentId, academicYearId)` |
| An attendance record belongs to exactly one of a student or a staff member | `CHECK` |
| One open sync conflict per record | partial unique index |
| One open alert/conflict per subject (cloud) | partial unique indexes |
| Sync idempotency | `UNIQUE(installationId, idempotencyKey)` in the cloud |
| Positive money amounts, valid statuses, score ranges | `CHECK` constraints |

## Indexes on foreign keys

PostgreSQL does not index foreign-key columns automatically, and Prisma does not either. Without an index, deleting or updating a parent row scans the child table and joins on it are slow. A review found 39 of 105 foreign keys unindexed; the ones on real query paths (exam results by class-subject, enrolments by section, notification deliveries — scanned by the nightly purge — fee items, exam sections, …) were indexed in migration `fk_support_indexes`. The 16 that remain are deliberate (tiny or rarely-touched tables, and `cbt_answers.examQuestionId`, which is write-hot during exams) and are pinned in `tests/db-integrity.test.ts`: **a new foreign key without an index fails that test** until it is indexed or justified.

## Column types — one deliberate deviation

Timestamps are Prisma `DateTime` (`timestamp without time zone`), not `timestamptz`. The application forces every connection to UTC and raw SQL compares against `now() AT TIME ZONE 'UTC'` (a local-time comparison bug was found and fixed early on, with regression tests). Money is `NUMERIC`, text is `TEXT`, identifiers are UUIDs so records created offline never collide.

## Migrations — rules we learned

* Create with `prisma migrate dev --create-only`, add raw SQL (triggers, partial indexes) to the file **before** applying, never edit an applied migration.
* Prisma emits `DROP COLUMN` for a type change; rewrite it as `ALTER COLUMN … TYPE … USING …` so data survives (done in `report_kind_text`).
* `prisma migrate deploy` is what production runs (the compose file's `migrate` service). Restores bring the schema version check along (see [backup](backup-recovery.md)).
