import { expect, test, type Browser, type Page } from "@playwright/test";
import { ADMIN, CLOUD_URL, OPERATOR, SUPPORT_OPERATOR, VIEWER_OPERATOR } from "./env";
import { seedSchool, type State } from "./seed";
import { adminApi, alerts, apiAs, get, login, post } from "./helpers";
import { ensureWorker } from "./worker";

let S: State;
const CREATED_AS = "Tower Test College";
/** Registration adopts the school's own name, so after step 2 the tower shows this instead. */
const SCHOOL = "Greenfield College";
let code = "";
let token = "";

type Op = { email: string; password: string };
async function towerLogin(page: Page, o: Op) {
  await page.goto(`${CLOUD_URL}/login`);
  await page.getByLabel("Email").fill(o.email);
  await page.getByLabel("Password").fill(o.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/fleet/);
}
async function tower(browser: Browser, o: Op = OPERATOR, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  await towerLogin(page, o);
  return { ctx, page };
}
const strip = (page: Page) => page.getByRole("button", { name: new RegExp(code || CREATED_AS) });
/** Ask the school to check in with the cloud right now (the same as the "Sync now" button). */
async function syncNow(): Promise<any> { const api = await adminApi(); return post(api, "/sync/now"); }

test.beforeAll(async () => { S = await seedSchool(); await ensureWorker(); });

test.describe.serial("Developer Control Tower ↔ a real school", () => {
  test("operators sign in with their own role: unauthenticated visitors are sent to sign-in, wrong passwords are explained, viewers cannot change anything", async ({ page, browser }) => {
    await page.goto(`${CLOUD_URL}/fleet`);
    await expect(page).toHaveURL(/\/login\?next=%2Ffleet/);
    await page.getByLabel("Email").fill(OPERATOR.email);
    await page.getByLabel("Password").fill("not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(alerts(page)).toContainText("Incorrect email or password");
    await page.getByLabel("Password").fill(OPERATOR.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/fleet/);
    await expect(page.getByRole("link", { name: "Operators" })).toBeVisible();

    const v = await tower(browser, VIEWER_OPERATOR);
    await expect(v.page.getByRole("button", { name: "New school" })).toHaveCount(0);
    await expect(v.page.getByRole("link", { name: "Operators" })).toHaveCount(0);
    // even by calling the API directly, the server refuses
    expect((await v.page.request.post(`${CLOUD_URL}/api/ops/installations`, { data: { schoolName: "Sneaky School" }, headers: { origin: CLOUD_URL } })).status()).toBe(403);
    expect((await v.page.request.get(`${CLOUD_URL}/api/ops/operators`)).status()).toBe(403);
    await v.ctx.close();
  });

  test("the operator creates a school and gets a one-time token; the school registers with it from its own admin screen", async ({ browser, page }) => {
    const t = await tower(browser);
    await t.page.getByRole("button", { name: "New school" }).click();
    const dlg = t.page.getByRole("dialog", { name: "New school installation" });
    await expect(dlg.getByRole("button", { name: "Create installation" })).toBeDisabled();
    await dlg.getByLabel("School name").fill(CREATED_AS);
    await dlg.getByLabel("State").fill("Enugu");
    await dlg.getByLabel("Contact person").fill("Mrs. Okoro");
    await dlg.getByRole("button", { name: "Create installation" }).click();
    const shown = t.page.getByTestId("registration-token");
    await expect(shown).toBeVisible();
    token = (await shown.innerText()).trim();
    expect(token).toMatch(/^SSR-SS-[A-Z0-9]{6}-/);
    code = token.split("-").slice(1, 3).join("-");
    await t.page.getByRole("button", { name: "Done" }).click();
    await expect(strip(t.page)).toContainText("Not registered yet");
    await expect(t.page.getByRole("heading", { name: CREATED_AS })).toBeVisible();

    // the school side: the principal registers through the real screen
    await login(page, ADMIN.username, ADMIN.password);
    await page.goto("/admin/sync");
    await page.getByRole("button", { name: "Register with the cloud" }).click();
    await page.getByLabel("Cloud address").fill(CLOUD_URL);
    await page.getByLabel("Registration token").fill("SSR-wrong-token-that-does-not-exist");
    await page.getByRole("dialog").getByRole("button", { name: "Register" }).click();
    await expect(alerts(page).first()).toBeVisible(); // a wrong token is refused, plainly
    await page.getByLabel("Registration token").fill(token);
    await page.getByRole("dialog").getByRole("button", { name: "Register" }).click();
    await expect(page.getByText(`Registered as ${code}`).first()).toBeVisible({ timeout: 20_000 });

    // a token works once
    const api = await adminApi();
    const again = await api.post("/api/sync/register", { data: { cloudUrl: CLOUD_URL, registrationToken: token } });
    expect(again.ok()).toBe(false);
    await t.ctx.close();
  });

  test("after the school checks in, the tower shows its real numbers, its worker and its database state", async ({ browser }) => {
    await post(await adminApi(), "/students", { firstName: "Sync", lastName: "Kid", gender: "MALE", classId: S.jss1, sectionId: S.secA });
    const r = await syncNow();
    expect(r.heartbeat.ok).toBe(true);
    const t = await tower(browser);
    await strip(t.page).click();
    await expect(t.page.getByRole("heading", { name: SCHOOL })).toBeVisible();
    await expect(t.page.getByText("Last heard from just now")).toBeVisible();
    const students = t.page.locator(".kpi", { hasText: "Students" });
    await expect(students).toContainText(/[1-9]/);
    await expect(t.page.locator(".kpi", { hasText: "School database" })).toContainText("OK");
    await expect(t.page.getByRole("region", { name: "Background workers" })).toContainText("e2e-worker");
    // the records the school sent are visible as counts, never as content
    await expect(t.page.getByRole("heading", { name: "Data received in the cloud" })).toBeVisible();
    await t.ctx.close();
  });

  test("a message from the operator shows up as a banner at the school after its next check-in", async ({ browser, page }) => {
    const t = await tower(browser, SUPPORT_OPERATOR);
    await strip(t.page).click();
    await t.page.getByLabel(/Message shown to the school/).fill("Server maintenance on Saturday 8am. Please save your work.");
    await t.page.getByRole("button", { name: "Send message" }).click();
    await expect(t.page.getByText(/Message queued/)).toBeVisible();
    await syncNow();
    await login(page, ADMIN.username, ADMIN.password);
    await expect(page.getByText("Server maintenance on Saturday 8am. Please save your work.")).toBeVisible();
    // the school confirms it applied the command on its NEXT check-in (delivery is at-least-once, acknowledged afterwards)
    await syncNow();
    await t.page.reload(); await strip(t.page).click();
    await expect(t.page.getByRole("row", { name: /message/i }).getByText(/\d{4}/).first()).toBeVisible(); // delivered timestamp, not "Waiting"
    await expect(t.page.getByRole("row", { name: /message .*Waiting/i })).toHaveCount(0);
    // support staff cannot suspend or edit licences
    await expect(t.page.getByText("Suspend or retire")).toHaveCount(0);
    await t.page.getByRole("group").filter({ hasText: "Licence" }).getByLabel("Plan").isDisabled().then((d) => expect(d).toBe(true));
    await t.ctx.close();
  });

  test("suspension needs a reason, puts the school in administrator-only mode, keeps its data available — and resuming restores everything", async ({ browser }) => {
    const t = await tower(browser);
    await strip(t.page).click();
    await t.page.getByText("Suspend or retire").click();
    await t.page.getByRole("button", { name: "Suspend this school…" }).click();
    const dlg = t.page.getByRole("dialog", { name: `Suspend ${SCHOOL}?` });
    await expect(dlg.getByRole("button", { name: "Suspend school" })).toBeDisabled();
    await dlg.getByLabel(/Reason/).fill("Fees unpaid for two terms");
    await dlg.getByRole("button", { name: "Suspend school" }).click();
    await expect(t.page.getByText(/Suspended .*Fees unpaid for two terms/).first()).toBeVisible();
    await expect(strip(t.page)).toContainText("Suspended");

    // nothing changes at the school until it next reaches the cloud…
    const teacher = await apiAs(S.teacher.username, S.teacher.password);
    expect((await teacher.get("/api/students")).status()).toBe(200);
    await syncNow();

    // …then teachers are turned away, while the principal can still see and export everything
    const blocked = await teacher.get("/api/students");
    expect(blocked.status()).toBe(503);
    expect((await blocked.json()).error.code).toBe("INSTALLATION_SUSPENDED");
    const admin = await adminApi();
    expect((await admin.get("/api/students")).status()).toBe(200);
    expect((await get(admin, "/auth/me")).license.mode).toBe("ADMIN_ONLY");
    expect((await admin.post("/api/students", { data: { firstName: "No", lastName: "Write", gender: "MALE", classId: S.jss1 } })).ok()).toBe(false);
    expect((await admin.get("/api/backup")).status()).toBeLessThan(400); // recovery stays available

    // resume → back to normal at the next check-in
    await t.page.reload(); await strip(t.page).click(); await t.page.getByText("Suspend or retire").click();
    await t.page.getByRole("button", { name: "Resume this school" }).click();
    await expect(t.page.getByRole("button", { name: "Suspend this school…" })).toBeVisible();
    await syncNow();
    expect((await teacher.get("/api/students")).status()).toBe(200);
    expect((await get(await adminApi(), "/auth/me")).license.mode).toBe("FULL");
    await t.ctx.close();
  });

  test("a requested backup is made by the school's worker, encrypted, and uploaded to the cloud where a super admin can download it", async ({ browser }) => {
    const t = await tower(browser);
    await strip(t.page).click();
    await t.page.getByRole("button", { name: "Request a backup" }).click();
    await expect(t.page.getByText(/Backup requested/)).toBeVisible();
    await syncNow(); // delivers the signed command; the school queues the job for its worker
    const link = t.page.getByRole("link", { name: "Download" });
    await expect(async () => { await t.page.reload(); await strip(t.page).click(); await expect(link.first()).toBeVisible({ timeout: 1500 }); }).toPass({ timeout: 90_000, intervals: [3000] });
    const res = await t.page.request.get(await link.first().getAttribute("href").then((h) => `${CLOUD_URL}${h}`));
    expect(res.status()).toBe(200);
    const bytes = await res.body();
    expect(bytes.length).toBeGreaterThan(200);
    expect(bytes.subarray(0, 2).toString("hex")).not.toBe("1f8b"); // not plain gzip: it is encrypted
    expect(bytes.toString("latin1")).not.toContain("Sync"); // no readable student data inside

    // the school reports the new backup on its next check-in
    await syncNow();
    await t.page.reload(); await strip(t.page).click();
    await expect(t.page.locator(".kpi", { hasText: "Last backup" })).toContainText(/just now|min ago/);
    await expect(t.page.getByText("No backup has ever completed.")).toHaveCount(0);
    await t.ctx.close();
  });

  test("the audit log names every operator action; an unreachable or decommissioned cloud never locks the school", async ({ browser }) => {
    const t = await tower(browser);
    await t.page.getByRole("link", { name: "Audit log" }).click();
    for (const a of ["installation.create", "installation.registered", "command.message", "installation.suspend", "installation.resume", "command.request_backup", "backup.download"]) await expect(t.page.getByRole("cell", { name: a, exact: true }).first(), a).toBeVisible();
    await expect(t.page.getByRole("cell", { name: SUPPORT_OPERATOR.email }).first()).toBeVisible();

    // decommission (type the code to confirm)
    await t.page.goto(`${CLOUD_URL}/fleet`); await strip(t.page).click();
    await t.page.getByText("Suspend or retire").click();
    await t.page.getByRole("button", { name: "Decommission…" }).click();
    const dlg = t.page.getByRole("dialog", { name: `Decommission ${SCHOOL}?` });
    await dlg.getByLabel("Reason").fill("School closed");
    await expect(dlg.getByRole("button", { name: "Decommission" })).toBeDisabled();
    await dlg.getByLabel(/Type the code/).fill(code);
    await dlg.getByRole("button", { name: "Decommission" }).click();
    await expect(strip(t.page)).toContainText("Decommissioned");

    // the school can no longer talk to the cloud — and keeps working exactly as before
    const r = await syncNow();
    expect(r.heartbeat.ok).toBe(false);
    const teacher = await apiAs(S.teacher.username, S.teacher.password);
    expect((await teacher.get("/api/students")).status()).toBe(200);
    expect((await get(await adminApi(), "/auth/me")).license.mode).toBe("FULL");
    await t.ctx.close();
  });

  test("on a phone the tower becomes three tabs and never scrolls sideways", async ({ browser }) => {
    const t = await tower(browser, OPERATOR, { width: 390, height: 800 });
    await expect(t.page.getByRole("tab", { name: "Schools" })).toHaveAttribute("aria-selected", "true");
    await strip(t.page).click();
    await expect(t.page.getByRole("tab", { name: "Health" })).toHaveAttribute("aria-selected", "true");
    await expect(t.page.getByRole("heading", { name: SCHOOL })).toBeVisible();
    await t.page.getByRole("tab", { name: "Control" }).click();
    await expect(t.page.getByRole("heading", { name: "Control panel" })).toBeVisible();
    expect(await t.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await t.ctx.close();
  });
});
