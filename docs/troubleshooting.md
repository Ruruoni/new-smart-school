# Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| **"Something went wrong" / "The school server isn't ready" on setup or login** | The server itself is unhealthy, not your input. The message now says which problem; note the **Reference** code and search the server log for it (`docker logs <container>`). Typical causes: the container was started without its environment (bare `docker run`), the database name doesn't resolve, the migrations haven't been applied. See *When it doesn't work* in [deployment](deployment.md). |
| **"Can't reach the Control Tower"** | Shown only when the browser genuinely cannot connect. If the tower answered with an error the page says **"The Control Tower isn't ready"** with the reason and a Reference code. |
| `docker ps` shows a container as *(unhealthy)* | `curl http://localhost:<port>/api/health` says which stage failed (`config`, `database` or `schema`); the container's first log lines say why. |
| Setup page keeps appearing | The database is empty or the wrong `DATABASE_URL` is used. Setup runs only once per database. |
| `Invalid environment configuration — APP_ENCRYPTION_KEY …` | Secrets must be ≥ 40 characters (32 random bytes base64): `openssl rand -base64 32`. |
| Sign-in appears to work but you're immediately signed out again | The browser dropped the session cookie. With the default `SESSION_COOKIE_SECURE=auto` the cookie is `Secure` only when the request arrived over HTTPS, so plain HTTP and TLS proxies both work. If you forced `true` while browsing over plain HTTP (other than `localhost`), the browser silently discards it — use `auto` or `false`. Behind a TLS-terminating proxy make sure it sends `X-Forwarded-Proto: https`. |
| "Too many attempts" at sign-in | 5 wrong passwords lock the account for 15 minutes. An administrator can reset another user's password (*Users & roles*); the lock also clears by itself after 15 minutes. If the Primary Admin password is truly lost, it must be reset directly in the database by whoever administers the server (there is deliberately no back door in the app). |
| A report or import shows **Waiting to start** and a banner says *the background worker isn't running* | Exactly that: nothing is processing the queue. Start the worker (`pnpm worker` / the `worker` container). Nothing is lost — the job continues by itself and the page updates. The dashboard's *Needs attention* and *System health* show the same. |
| Reports / imports stay "Queued", notifications never send, backups don't run | The **worker** is not running. Check *Admin → Cloud and licence → Health* (no worker beat) and start `pnpm worker` / the `worker` container. |
| Banner "Trial period: N day(s) left" | The school is not registered with a Control Tower. Fine for 30 days; after that the school is read-only until licensed. |
| "Records are read-only until the license is renewed" | Licence past its grace period. Renew in the tower and press *Sync now*. Data is still readable and exportable. |
| "This installation has been suspended" | The tower suspended the school. Only the Primary Admin can sign in; contact support. The Primary Admin can still take backups and export. |
| *Sync now* says "failed" / tower shows "Not reporting" | The school can't reach the cloud address (DNS, firewall, HTTPS certificate) or the clock is > 5 minutes off (requests are rejected outside a 5-minute window). School work is unaffected. |
| "Waiting to sync" keeps growing | Cloud unreachable or a batch is being rejected; failed rows retry with back-off up to 12 times, then show as *stuck*. Check the *Cloud and licence* page and the tower's alerts. |
| Exam page says it can't be opened offline | The paper was never loaded on this device (first load needs the school server). Reconnect to the Wi-Fi and open it once. |
| A student's answers "didn't save" | The room says *Offline — answers safe on this device*. Keep the tab open (or reopen the same exam URL) — they sync automatically when the connection returns and are flushed again at submit. |
| Parent can't see results | Financial lockout may be on and fees overdue — the portal explains this. Or results are not published yet. |
| Import row "Already exist" | The same admission number, or the same first name + last name + date of birth, is already in the school. |
| PDF shows boxes instead of letters | The bundled DejaVu fonts (npm package `dejavu-fonts-ttf`) weren't installed with the app — reinstall dependencies. |
| Restore refused: "database version" | The backup was made at a different schema version. Restore into the same app version, then upgrade. |
| pg warning "Calling client.query() when the client is already executing a query" | Known and harmless: Prisma's driver adapter issues parallel queries for a multi-include read. It is a deprecation notice, not an error. |
| Dashboard figures look old | They refresh every 30 s and the server recomputes within 5 s of a change; if a figure is wrong, check *System health* (a stopped worker no longer freezes it, but heavier analytics refresh less often). A report that says *Failed* shows the reason next to it. |
| The worker container shows *unhealthy* | Its heartbeat is older than 90 s: the process is stuck or cannot reach the database. `docker compose logs worker`; restart it. |
| Phones keep an old version of the app | The service worker is versioned per build and re-checked on every load; a hard refresh or reopening the app picks it up. |
| Playwright can't launch Chromium | Missing system libraries — see [testing](testing.md#playwright-on-a-machine-without-system-libraries). |
