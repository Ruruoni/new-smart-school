import { expect, test } from "@playwright/test";
import { CLOUD_URL } from "./env";
import { alerts } from "./helpers";

/**
 * What a person sees when the SERVER (not their input) is the problem. Before: "Something went wrong. Please try again." for
 * everything, and "Can't reach the Control Tower" even when the tower was reachable but misconfigured.
 * The API responses are simulated here; the real containers producing them are verified by deploy/verify-docker.mjs.
 */
const misconfigured = { error: { code: "SERVER_MISCONFIGURED", message: "This server isn't set up correctly yet. Please tell whoever installed it to check the server's log for the exact problem.", requestId: "3f9a1c2e-0000-4000-8000-000000000000" } };

test("login and setup pages say what is wrong with the server before anyone types a password", async ({ page }) => {
  await page.route("**/api/setup/status", (r) => r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify(misconfigured) }));
  for (const path of ["/login", "/setup"]) {
    await page.goto(path);
    const note = alerts(page).filter({ hasText: "isn't set up correctly" });
    await expect(note).toBeVisible();
    await expect(note).toContainText("The school server isn't ready");
    await expect(note).toContainText("Reference: 3f9a1c2e");
    await expect(page.getByText("Something went wrong. Please try again.")).toHaveCount(0);
  }
});

test("an error with NO body (a crash before the API could answer) is described honestly, not as 'Something went wrong'", async ({ page }) => {
  await page.route("**/api/setup/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { needsSetup: false } }) }));
  await page.route("**/api/auth/login", (r) => r.fulfill({ status: 500, body: "", headers: { "x-request-id": "aaaabbbb-0000-4000-8000-000000000000" } }));
  await page.goto("/login");
  await page.getByLabel("Username").fill("someone");
  await page.getByLabel(/^Password/).fill("some-password-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  const msg = alerts(page).filter({ hasText: "gave no details" });
  await expect(msg).toContainText("error 500");
  await expect(msg).toContainText("server's log");
  await expect(msg).toContainText("Reference: aaaabbbb");
});

test("a database problem is named as such at sign-in, and offline is still 'offline'", async ({ page }) => {
  await page.route("**/api/setup/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { needsSetup: false } }) }));
  await page.route("**/api/auth/login", (r) => r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "DATABASE_UNAVAILABLE", message: "The school database can't be reached right now. Please try again in a minute; if this keeps happening, tell whoever looks after the school server.", requestId: "11112222-0000-4000-8000-000000000000" } }) }));
  await page.goto("/login");
  await page.getByLabel("Username").fill("someone");
  await page.getByLabel(/^Password/).fill("some-password-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(alerts(page).filter({ hasText: "school database can't be reached" })).toContainText("Reference: 11112222");
  // a real network failure is a different message
  await page.unroute("**/api/auth/login");
  await page.route("**/api/auth/login", (r) => r.abort("connectionrefused"));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(alerts(page).filter({ hasText: "Cannot reach the school server" })).toBeVisible();
});

test.describe("Control Tower", () => {
  test("'Can't reach' is only for a network failure; an error from a reachable tower is shown as what it is", async ({ page }) => {
    // reachable but misconfigured
    await page.route("**/api/ops/me", (r) => r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "SERVER_MISCONFIGURED", message: "The Control Tower isn't set up correctly yet. Whoever runs it should check its server log for the exact problem.", requestId: "cafe0000-0000-4000-8000-000000000000" } }) }));
    await page.goto(`${CLOUD_URL}/fleet`);
    await expect(page.getByRole("heading", { name: "The Control Tower isn't ready" })).toBeVisible();
    await expect(page.getByText("isn't set up correctly yet")).toBeVisible();
    await expect(page.getByText(/Reference: cafe0000/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Can't reach the Control Tower" })).toHaveCount(0);

    // body-less crash
    await page.unroute("**/api/ops/me");
    await page.route("**/api/ops/me", (r) => r.fulfill({ status: 500, body: "" }));
    await page.reload();
    await expect(page.getByRole("heading", { name: "The Control Tower isn't ready" })).toBeVisible();
    await expect(page.getByText(/gave no details \(error 500\)/)).toBeVisible();

    // genuinely unreachable
    await page.unroute("**/api/ops/me");
    await page.route("**/api/ops/me", (r) => r.abort("connectionrefused"));
    await page.reload();
    await expect(page.getByRole("heading", { name: "Can't reach the Control Tower" })).toBeVisible();

    // and "Try again" recovers when the tower comes back
    await page.unroute("**/api/ops/me");
    await page.route("**/api/ops/me", (r) => r.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }) }));
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page).toHaveURL(/\/login/);
  });

  test("the tower's sign-in form shows the reason and reference when the server is the problem", async ({ page }) => {
    await page.route("**/api/ops/login", (r) => r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "DATABASE_UNAVAILABLE", message: "The database can't be reached right now. Please try again in a minute; if this keeps happening, tell whoever looks after the server.", requestId: "beef0000-0000-4000-8000-000000000000" } }) }));
    await page.goto(`${CLOUD_URL}/login`);
    await page.getByLabel("Email").fill("root@tower.test");
    await page.getByLabel("Password").fill("whatever-password-1");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(alerts(page).filter({ hasText: "database can't be reached" })).toContainText("Reference: beef0000");
  });
});
