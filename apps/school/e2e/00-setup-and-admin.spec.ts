import { expect, test } from "@playwright/test";
import { ADMIN } from "./env";
import { alerts, login, tryLogin } from "./helpers";

test.describe.serial("first run and administration", () => {
  test("a fresh installation sends everyone to the setup wizard, which creates the school and its protected admin", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/setup/);
    await page.getByLabel("School name").fill("Greenfield College");
    await page.getByLabel("City or town").fill("Enugu");
    await page.getByLabel("First name").fill("Ada");
    await page.getByLabel("Last name").fill("Obi");
    await page.getByLabel("Username").fill(ADMIN.username);
    await page.getByLabel("Password").fill("weak");
    await page.getByRole("button", { name: "Create school" }).click();
    await expect(alerts(page).first()).toBeVisible(); // password policy is enforced server-side
    await page.getByLabel("Password").fill(ADMIN.password);
    await page.getByRole("button", { name: "Create school" }).click();
    await expect(page.getByRole("heading", { name: /Greenfield College is ready/ })).toBeVisible();
    await expect(page.getByText(/^SS-[A-Z0-9]{6}$/)).toBeVisible();
    await page.getByRole("button", { name: "Go to sign in" }).click();
    await expect(page).toHaveURL(/\/login/);
    // setup can never run twice
    await page.goto("/setup");
    await expect(page).toHaveURL(/\/login/);
  });

  test("wrong password is refused with a clear message; the admin signs in and lands on the dashboard", async ({ page }) => {
    await tryLogin(page, ADMIN.username, "not-the-password-1");
    await expect(alerts(page)).toContainText("Incorrect username or password");
    await login(page, ADMIN.username, ADMIN.password);
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole("heading", { name: /Welcome, Ada/ })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main" })).toContainText("Users & roles");
  });

  test("the primary admin role is shown as protected and cannot be edited", async ({ page }) => {
    await login(page, ADMIN.username, ADMIN.password);
    await page.goto("/admin/users");
    await page.getByRole("tab", { name: "Roles & permissions" }).click();
    await page.getByRole("button", { name: /^Primary Admin/ }).click();
    await expect(page.getByText("always holds every permission and cannot be edited")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save permissions" })).toBeDisabled();
  });

  test("a disabled module disappears from the menu and its pages are refused by the server", async ({ page }) => {
    await login(page, ADMIN.username, ADMIN.password);
    await page.goto("/admin/modules");
    const sw = page.getByRole("switch", { name: "Timetable enabled" });
    await expect(sw).toHaveAttribute("aria-checked", "true");
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await page.reload();
    await expect(page.getByRole("navigation", { name: "Main" })).not.toContainText("Timetable");
    const r = await page.request.get("/api/timetable");
    expect(r.status()).toBe(403);
    expect((await r.json()).error.code).toBe("MODULE_DISABLED");
    await page.goto("/admin/modules");
    await page.getByRole("switch", { name: "Timetable enabled" }).click();
  });
});
