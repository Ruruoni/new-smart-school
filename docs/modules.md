# Modules

Modules can be switched off per school (*Admin → Modules & features*) or by licence. A disabled module is refused **by the server**, and its menu entries disappear.

| Key | What it does | Rules worth knowing |
|---|---|---|
| `students`, `staff` | People, guardians (siblings share one parent account, matched by phone), teachers, staff, enrolment, status history. | Admission numbers are generated; a parent only ever sees their own children; login credentials are shown once and must be changed at first sign-in. |
| `academics` | Years, terms, classes, sections, subjects, class-subject assignments. | Exactly one current year/term. Promotion rules follow class order. |
| `results` | Assessment components (CA1, CA2, Exam…), grading scheme, score entry grid, processing, positions, remarks, publication, promotion. | Teachers only see their assigned class-subjects. Processing refuses incomplete sheets unless the administrator chooses *Process anyway*. Published results are frozen; withdrawing needs a reason. Scores autosave per cell; a concurrent edit is shown as *Use theirs / Keep mine*. |
| `finance` | Fee structures, class billing, invoices, payments, reversals, discounts, expenses, ledger, debtors. | Ledger is append-only and balanced. A payment is never edited — it is *reversed* with a reason and the original stays. **Financial lockout** (setting `finance.lockout`) can hold a family's results back while fees are overdue; the server enforces it, staff are unaffected, paying lifts it immediately, a reversal re-applies it. |
| `admissions` | Public application form, access-code status check, secure document upload, registrar workflow, enrolment. | Uploads are sniffed by magic bytes (a renamed `.exe` is refused), size-limited, and readable only by staff. The workflow is a state machine (invalid transitions → 409). |
| `attendance` | Roll call (keyboard-friendly), QR codes, device scans by API key (RFID/fingerprint hardware talks to `/api/device/attendance/scan`), auto-absentees after a cutoff. | Absent marks notify guardians via the notification engine. Hardware drivers are out of scope — the boundary is the authenticated scan endpoint. |
| `timetable` | Periods, rooms, slots, and a deterministic constraint solver that finds teacher/room/class clashes and proposes a clash-free placement. | Validation is server-side and pure (no database) so it is unit-tested exhaustively; a database unique key also stops double-booking a room in the same period. |
| `lessonnotes` | Teacher lesson notes with attachments; draft → published. | Families and students see only *published* notes for their own class; attachments are served through the authenticated file route. |
| `cbt` | Question bank, topics, exams (school / practice), timed attempts, scoring, analytics, publication. | Server-authoritative deadline, frozen per-attempt question/option order, replay-safe autosave (`clientSeq`), auto-submit at zero, answers survive a network drop ([offline](offline-and-sync.md)). |
| `examprep` | One reusable engine for WAEC / NECO / JAMB / BECE practice on top of `cbt`. | Exam body is a property of questions and exams; per-topic performance feeds a progress view. Instant-feedback mode reveals the key only via an authenticated call. |
| `communication` | Templates, announcements, notification centre, delivery queue with provider adapters (SMTP, HTTP SMS gateway, WhatsApp Cloud). | Delivery is asynchronous and retried; messages wait in the queue until a provider is configured. Provider settings save per channel (never wiping the others) and each can be checked with **Send test message**. |
| `automation` | Event → conditions → actions rules with an execution log. | Idempotent per event; templates can't read arbitrary object properties. |
| `analytics` | Precomputed snapshots (enrolment, attendance, finance, results, CBT). | Refreshed by the worker every 10 minutes. |
| `reports` | Registry of report kinds → preview, PDF/XLSX/CSV, report cards. | Heavy reports run as background jobs with a status list; PDF uses bundled DejaVu fonts (Nigerian names and ₦ render correctly). |
| `imports` | Excel/CSV import: students (with guardians), teachers, questions. | Upload → validate in the worker → **preview with row-level problems** → approve (optionally skipping bad rows) → import in the worker. Duplicates are detected in-file and against existing data; a credentials CSV (students, **parents** and teachers created by the import) is stored securely and expires after 7 days. |
| `backup` | Encrypted logical backups, verification, guarded restore. | See [backup](backup-recovery.md). |
| `sync` | Cloud registration, push, heartbeat, conflicts. | See [sync](offline-and-sync.md). |

## Role experiences

| Role | Home | What is there |
|---|---|---|
| Primary admin / staff with analytics | Dashboard | live "needs attention", KPI tiles, system health, recent activity |
| Teacher | `/teach` | today's lessons, roll-call status for sections they are form teacher of, real score-entry progress per class-subject, class average, open CBT exams; score grid, attendance, lesson notes, CBT tools |
| Student | `/student` | Exams, Practice, Progress, **Results** (own report card; the financial lockout applies), **More**: own attendance, own timetable, lesson notes, announcements, change password. Notifications in the header bell |
| Parent | `/portal` | child selector, Results, Attendance, Fees, More (timetable, announcements, lesson notes, change password); notifications in the header bell |

Students and parents use the same pages: the API returns a student as their own "child" (relationship *Self*), and every read is scoped on the server to the caller (an unlinked or other student's id looks like "not found"). A student has no fee view by default (the role lacks `finance.view`); an administrator can grant it.
