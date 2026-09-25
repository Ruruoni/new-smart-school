# Control Tower and licensing

`apps/cloud` — the developer-side control plane. It never holds a school's full database; it holds the installation registry, licence terms, monitoring data, an allow-listed replica (see [sync](offline-and-sync.md)), alerts, commands, and encrypted backups the schools upload.

## Setting it up

```bash
cd apps/cloud
pnpm keys:generate      # prints CLOUD_ENCRYPTION_KEY, the Ed25519 CLOUD_SIGNING_PRIVATE/PUBLIC_KEY pair, and the public key to give schools (CLOUD_PUBLIC_KEY)
pnpm db:deploy
pnpm operator:create ada@example.com "Ada Obi" 'a-long-password' SUPER_ADMIN
pnpm build && pnpm start          # port 3100 — serve it over HTTPS in production (SESSION_COOKIE_SECURE=auto sets the Secure flag when the request arrived over HTTPS)
```

Keep the private signing key secret and backed up: losing it means every school must be given a new public key.

## The screen

* **Fleet** — three columns. *Left*: every installation as a strip with a health word + coloured margin (Healthy / Needs attention / Critical / Not reporting / Suspended / Not registered / Decommissioned), searchable and filterable. *Middle*: the selected school's health board — headline, the latest report as tiles (waiting to sync, oldest waiting, failed, stuck, open conflicts, students, active users, last backup, school database), a strip of recent reports, open alerts (acknowledge), background workers, recent errors, records received (counts by type), uploaded backups, recent activity. *Right*: the control panel — registration token, licence, feature flags, messages/backup/diagnostics commands, notes, and (super admins) suspend/resume/decommission. On a phone the three columns become three tabs.
* **Alerts**, **Sync conflicts**, **Releases & flags**, **Operators** (super admin), **Audit log**.

"Not reporting" is shown as information, not an emergency: schools work offline, and silence never restricts a school.

## Roles

| Role | Can |
|---|---|
| Viewer | Read everything |
| Support | + create installations, issue registration tokens, per-school feature overrides, send messages / request backups & diagnostics, acknowledge alerts, resolve conflicts, edit notes |
| Super admin | + edit licences, suspend / resume / decommission, global flags, publish releases, download uploaded backups, manage operators |

Every route names its minimum role; the server checks it regardless of what the UI shows. Every action is audited with the operator's email.

## Onboarding a school

1. **New school** → the tower shows a **one-time registration token** (`SSR-<code>-…`, valid 14 days, shown once, only its hash is stored).
2. At the school: *Admin → Cloud and licence → Register with the cloud*, paste the cloud address and the token. The cloud claims the token atomically, generates the installation secret (stored encrypted), and returns the first licence. A token works once.
3. The school's own name is adopted at registration. Workers start heartbeating; the tower shows the school within a minute (or immediately with *Sync now*).

## Licences and flags

* Licence = plan, module list, expiry, grace days, plus feature flags. Changing terms restamps the licence; the school picks it up at its next check-in. The token is deterministic for unchanged terms, so an unchanged licence causes no writes at the school.
* **Flags**: global defaults (Releases & flags) with per-installation overrides (*Follow default / On / Off*). Cloud flags win over local toggles at the school.
* **Suspend** needs a reason of ≥ 5 characters and records it; **Resume** reverses it; **Decommission** needs a reason *and* typing the installation code, destroys the stored secret (the school can no longer register, sync or heartbeat) and is irreversible. A decommissioned school **keeps working exactly as before**.

## Alerts (opened/cleared automatically)

Offline (no heartbeat for 15 min; critical after 24 h), sync backlog, sync failures, open conflicts, backup stale (>7 days or never), licence expiring, worker down, database down, version outdated (a newer release exists). One open alert per installation and kind.

## Backups received

Schools upload their already-encrypted backups (streamed to disk while hashing; the upload is rejected if the checksum or size differs). Super admins can download them from the installation page; each download is audited. The cloud cannot read them.
