# Backup and recovery

Backups are **logical, native and encrypted** — no dependency on `pg_dump` being installed on the school server.

## What a backup is

* One `REPEATABLE READ` transaction snapshots every table at the same instant.
* Rows are streamed as `table<TAB>json` lines, gzip-compressed, then **AES-256-GCM encrypted** with `APP_ENCRYPTION_KEY` (32 bytes) as the key, so numerics and timestamps restore bit-exact and the file is unreadable without the key.
* A sidecar **manifest** records per-table row counts, SHA-256 of the file and the schema version.
* Backup records themselves are excluded from restore (they describe files, not school data).

**Keep `APP_ENCRYPTION_KEY` safe and backed up separately from the backups** — without it, a backup cannot be decrypted (and the cloud credential stored in the database cannot be read).

## Schedules and triggers

* Nightly at 02:00 (school time) by the worker, with catch-up if the server was off. A registered school also uploads the encrypted archive to the cloud; an unregistered one keeps it locally.
* On demand: *Admin → Backup → Back up now*, or a `REQUEST_BACKUP` command from the Control Tower (the backup is made locally, then uploaded to the cloud if registered).
* The daily maintenance task keeps the newest **14** backups plus the newest verified one and deletes the older files.

## Verifying

The nightly backup is verified straight after it is written: the file is re-hashed, decrypted, and every row counted against the manifest. **Every Sunday's verification is deep**: the data is loaded into a scratch schema to prove it really restores. Anyone with backup permission can also verify a backup on demand. A failed verification is written to the audit log (`backup.verify_failed`) and appears in the Control Tower's *Recent errors at the school*; a missing backup raises the *backup stale* alert.

## Restoring

Restore is an administrator operation with guard rails:

1. Requires the `backup.restore` permission, the acting administrator's **own password**, and typing exactly `RESTORE <installation code>`.
2. Verifies the backup first; refuses a backup from a different schema version.
3. Takes a **safety backup of the current state** first (the safety backup's record survives the restore).
4. Replaces the data inside one transaction; on any failure nothing changes.
5. Writes an audit entry and invalidates caches; users should sign in again.

Restore is licence-exempt: a suspended or lapsed school can still recover its own data.

## Disaster scenarios

| Situation | What to do |
|---|---|
| Server disk died | New server → deploy the app → `db:deploy` → copy the backup file and the same `APP_ENCRYPTION_KEY` → Restore from *Admin → Backup*. |
| Bad data entry | Restore a recent backup (a safety backup is taken first). |
| Backup stale alert in the tower | Check the worker is running and there is free disk; *Request a backup* from the tower. |
| Lost `APP_ENCRYPTION_KEY` | Backups can't be decrypted. This is why the key must be stored somewhere else (password manager / safe). |
