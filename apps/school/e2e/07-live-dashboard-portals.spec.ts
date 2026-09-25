import { expect, test } from "@playwright/test";
import { ADMIN } from "./env";
import { activateUser, seedSchool, type State } from "./seed";
import { adminApi, apiAs, alerts, get, login, post } from "./helpers";
import { ensureWorker, stopWorker } from "./worker";
import { ageWorkerBeats } from "./db";

let S: State;
const today = ((new Date().getDay() + 6) % 7) + 1; // Mon=1 … Sun=7, the same rule the app uses
const todayIso = new Date().toISOString().slice(0, 10);

test.beforeAll(async () => { S = await seedSchool(); await ensureWorker(); });
test.afterAll(async () => { await ensureWorker(); });

test.describe.serial("a worker that isn't running is reported honestly, and comes back cleanly", () => {
  test("reports wait with a clear explanation while the worker is down, then finish by themselves when it returns", async ({ page }) => {
    await stopWorker();
    await ageWorkerBeats(10); // a real crash is noticed after 90 s; make it immediate

    await login(page, ADMIN.username, ADMIN.password);
    await page.goto("/reports");
    await page.getByLabel("Report", { exact: true }).selectOption({ label: "Student list" });
    await page.getByLabel("Download as").selectOption("CSV");
    await page.getByRole("button", { name: "Prepare CSV" }).click();
    const row = page.getByRole("row", { name: /student list/i }).first();
    await expect(row).toContainText("Waiting to start");
    await expect(page.getByRole("status").filter({ hasText: "The background worker isn't running" })).toBeVisible({ timeout: 15_000 });
    await expect(row.getByRole("link", { name: "Download" })).toHaveCount(0);

    // nothing is lost: the job waits in the database and the worker picks it up when it returns
    await ensureWorker();
    await expect(row).toContainText("Ready", { timeout: 60_000 });
    await expect(row.getByRole("link", { name: "Download" })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "The background worker isn't running" })).toHaveCount(0);
    const [dl] = await Promise.all([page.waitForEvent("download"), row.getByRole("link", { name: "Download" }).click()]);
    expect(dl.suggestedFilename()).toMatch(/\.csv$/);
  });

  test("the admin dashboard shows the worker as stopped, then running again — updating on its own", async ({ page }) => {
    await page.clock.install();
    await login(page, ADMIN.username, ADMIN.password);
    await page.goto("/dashboard");
    const live = page.getByTestId("dashboard-live");
    await expect(live.getByText("Background worker")).toBeVisible();
    await expect(live.locator("div", { hasText: /^Background workerRunning/ }).first()).toBeVisible({ timeout: 15_000 });

    await stopWorker();
    await ageWorkerBeats(10);
    await page.clock.fastForward(31_000); // the page refreshes itself every 30 s
    await expect(live.getByText("The background worker is not running", { exact: false })).toBeVisible({ timeout: 15_000 });
    await expect(live.locator("div", { hasText: /^Background workerStopped/ }).first()).toBeVisible();

    await ensureWorker();
    await expect(async () => {
      await page.clock.fastForward(31_000);
      await expect(live.getByText("The background worker is not running")).toHaveCount(0, { timeout: 3_000 });
    }).toPass({ timeout: 60_000, intervals: [1_000] });
  });
});

test("the dashboard reflects a change on its own, without a reload and without waiting for the worker", async ({ page }) => {
  await page.clock.install();
  await login(page, ADMIN.username, ADMIN.password);
  await page.goto("/dashboard");
  const stat = page.locator("div", { has: page.getByText("Active students", { exact: true }) }).last();
  await expect(stat).toContainText(/\d/);
  const num = stat.locator("p, span, div").filter({ hasText: /^\d+$/ }).first();
  const before = Number(await num.innerText());

  const api = await adminApi();
  await post(api, "/students", { firstName: "Live", lastName: "Update", gender: "MALE", classId: S.jss1, sectionId: S.secA });
  // the page refreshes itself every 30 s (fake clock) and the server recomputes within 5 s (real time): keep ticking until it shows
  await expect(async () => {
    await page.clock.fastForward(31_000);
    expect(Number((await stat.locator("p, span, div").filter({ hasText: /^\d+$/ }).first().innerText()))).toBe(before + 1);
  }).toPass({ timeout: 30_000, intervals: [2_000] });
});

test.describe.serial("student portal: results, attendance and timetable are reachable, scoped to the student, and not cached", () => {
  const stu = { username: "", password: "Student-pass-2", id: "", firstName: "Portal" };
  let otherStudentId = "";
  const parent = { username: "", password: "Parent-pass-3" };

  test.beforeAll(async () => {
    const api = await adminApi();
    const r = await post(api, "/students", { firstName: stu.firstName, lastName: "Scholar", gender: "FEMALE", classId: S.jss1, sectionId: S.secA, createLogin: true });
    stu.username = r.username; stu.id = r.student.id;
    await activateUser(r.username, r.initialPassword, stu.password);
    otherStudentId = (await post(api, "/students", { firstName: "Someone", lastName: "Else", gender: "MALE", classId: S.jss1, sectionId: S.secA })).student.id;

    // a family whose child will have results published: the parent must be told, inside the portal
    const kid = await post(api, "/students", { firstName: "Notified", lastName: "Child", gender: "MALE", classId: S.jss1, sectionId: S.secA, guardians: [{ newParent: { firstName: "Mr", lastName: "Child", phone: "08055550001" }, relationship: "Father" }] });
    parent.username = kid.guardianCredentials[0].username;
    await activateUser(parent.username, kid.guardianCredentials[0].initialPassword, parent.password);

    // published result (teacher scores → admin processes and publishes)
    const sheet = await get(api, `/results/sheet?classSubjectId=${S.classSubjectId}&termId=${S.termId}`);
    const entries = [stu.id, kid.student.id].flatMap((studentId) => sheet.components.map((c: any) => ({ studentId, typeId: c.id, score: c.maxScore === 60 ? 54 : 17 })));
    await post(api, "/results/scores", { classSubjectId: S.classSubjectId, termId: S.termId, entries });
    await post(api, "/results/process", { termId: S.termId, classId: S.jss1, allowIncomplete: true });
    await post(api, "/results/publish", { termId: S.termId, classId: S.jss1 });

    // attendance today; an active timetable with a JSS 1 lesson and a JSS 2 lesson
    await post(api, "/attendance/record", { classId: S.jss1, sectionId: S.secA, date: todayIso, entries: [{ studentId: stu.id, status: "PRESENT" }, { studentId: otherStudentId, status: "ABSENT" }] });
    const t = await post(api, "/timetable", { termId: S.termId, name: "E2E portal timetable" });
    await post(api, "/timetable/slots", { timetableId: t.id, dayOfWeek: today, periodIndex: 4, startTime: "10:00", endTime: "10:40", classId: S.jss1, subjectId: S.math, teacherId: S.teacher.id });
    await post(api, "/timetable/slots", { timetableId: t.id, dayOfWeek: today, periodIndex: 5, startTime: "10:40", endTime: "11:20", classId: S.jss2, subjectId: S.eng, teacherId: S.teacher.id, allowUnassignedTeacher: true });
    await post(api, `/timetable/${t.id}/activate`);
  });

  test("the student sees their own report card, attendance and timetable — and nobody else's", async ({ page }) => {
    await login(page, stu.username, stu.password);
    await expect(page).toHaveURL(/\/student/);
    await expect(page.getByRole("link", { name: "Results" })).toBeVisible();

    await page.getByRole("link", { name: "Results" }).click();
    await expect(page.getByText("Mathematics")).toBeVisible();
    await expect(page.getByText("A1").first()).toBeVisible();

    await page.getByRole("link", { name: "More" }).click();
    await expect(page.getByRole("link", { name: /My attendance/ })).toBeVisible();
    await page.getByRole("link", { name: /My attendance/ }).click();
    await expect(page.getByText("Present").first()).toBeVisible();

    await page.getByRole("link", { name: "More" }).click();
    await page.getByRole("link", { name: /My timetable/ }).click();
    await expect(page.getByText("Mathematics")).toBeVisible();          // JSS 1 lesson
    await expect(page.getByText("10:00–10:40")).toBeVisible();
    await expect(page.getByText("English Language")).toHaveCount(0);    // JSS 2's lesson is not theirs
    await expect(page.getByText(`${["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][today]} (today)`)).toBeVisible();

    await page.getByRole("link", { name: "More" }).click();
    await page.getByRole("link", { name: /Change my password/ }).click();
    await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  });

  test("the server, not the page, keeps a student inside their own records", async () => {
    const api = await apiAs(stu.username, stu.password);
    // asking for another student's timetable, attendance or report card gets nothing — same answer as "doesn't exist"
    const tm = await (await api.get(`/api/timetable/mine?studentId=${otherStudentId}`)).json();
    expect(tm.data.title).toBe("JSS 1 timetable");                                           // the parameter is ignored: it is always the caller
    expect((await api.get(`/api/attendance/students/${otherStudentId}`)).status()).toBe(404);
    expect((await api.get(`/api/results/students/${otherStudentId}/terms`)).status()).toBe(404);
    // and a student can't reach staff timetable/attendance sheets
    expect((await api.get(`/api/timetable`)).status()).toBe(403);
    expect((await api.get(`/api/attendance/sheet?classId=${S.jss1}&date=${todayIso}`)).status()).toBe(403);
  });

  test("the teacher's home shows today's lessons and real score-entry progress", async ({ page }) => {
    await login(page, S.teacher.username, S.teacher.password);
    await expect(page).toHaveURL(/\/teach/);
    await expect(page.getByRole("heading", { name: "Today's lessons" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Today's lessons" }).locator("xpath=ancestor::section[1]")).toContainText("Mathematics");
    const bar = page.getByRole("progressbar", { name: /Mathematics scores entered/ });
    await expect(bar).toBeVisible();
    const pct = Number(await bar.getAttribute("aria-valuenow"));
    expect(pct).toBeGreaterThan(0);
    expect(pct).toBeLessThanOrEqual(100);
    await expect(page.getByText("Results published")).toBeVisible(); // this class-subject was published above
    expect(await alerts(page).count()).toBe(0);
  });

  test("a parent is told in the portal when results are published — the bell works on a phone, and marking read sticks", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true });
    const page = await ctx.newPage();
    await login(page, parent.username, parent.password);
    const bell = page.getByRole("button", { name: /^Notifications, \d+ unread/ });
    await expect(bell).toBeVisible();
    // the worker turns the "results published" event into an in-app notification; the bell refreshes itself
    await expect(async () => { await page.reload(); await expect(page.getByRole("button", { name: /^Notifications, [1-9]\d* unread/ })).toBeVisible({ timeout: 2_000 }); }).toPass({ timeout: 45_000, intervals: [3_000] });
    await page.getByRole("button", { name: /^Notifications, [1-9]\d* unread/ }).click();
    await expect(page.getByText(/Results published: Notified Child/)).toBeVisible();
    await page.getByRole("button", { name: "Mark all as read" }).click();
    await expect(page.getByRole("button", { name: "Notifications, 0 unread" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "Notifications, 0 unread" })).toBeVisible(); // stored, not just hidden
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await ctx.close();
  });
});
