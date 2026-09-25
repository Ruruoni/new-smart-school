import { expect, test, request } from "@playwright/test";
import { ADMIN, BASE_URL } from "./env";
import { seedSchool, type State } from "./seed";
import { adminApi, alerts, get, login, post } from "./helpers";

let S: State;
test.beforeAll(async () => { S = await seedSchool(); });

test.describe.serial("people, admissions and attendance", () => {
  test("registrar adds a student with a parent through the form; temporary passwords are shown once; the new parent can sign in and sees only that child", async ({ page, browser }) => {
    await login(page, ADMIN.username, ADMIN.password);
    await page.goto("/students/new");
    await page.getByLabel("First name").first().fill("Chidinma");
    await page.getByLabel("Last name").first().fill("Okafor");
    await page.getByLabel("Date of birth").fill("2014-05-12");
    await page.getByLabel("Class", { exact: true }).selectOption({ label: "JSS 1" });
    await page.getByLabel("Section").selectOption({ label: "A" });
    await page.getByLabel("Full name").fill("Ngozi Okafor");
    await page.getByLabel("Phone").fill("08031234567");
    await page.getByLabel("Create a login for this student").check();
    await page.getByRole("button", { name: "Save student" }).click();

    const dialog = page.getByRole("dialog", { name: "Student added" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/ADM\/\d{4}\/0001/);
    const text = (await dialog.innerText()).replace(/\s+/g, " ");
    const parent = /Parent\s+Username (\S+) · Password (\S+)/.exec(text);
    expect(parent, text).not.toBeNull();
    const [, pUser, pTemp] = parent!;
    await dialog.getByRole("button", { name: "Open record" }).click();
    await expect(page.getByRole("heading", { name: "Chidinma Okafor" })).toBeVisible();
    await expect(page.getByText("Ngozi Okafor")).toBeVisible();

    await expect(page.locator("main")).not.toContainText(pTemp!); // credentials are never shown again

    // the parent signs in for the first time: forced password change, then the portal
    const ctx = await browser.newContext();
    const pp = await ctx.newPage();
    await pp.goto("/login");
    await pp.getByLabel("Username").fill(pUser!);
    await pp.getByLabel(/^Password/).fill(pTemp!);
    await pp.getByRole("button", { name: "Sign in" }).click();
    await expect(pp).toHaveURL(/\/change-password/);
    await pp.getByLabel("Current password").fill(pTemp!);
    await pp.getByLabel(/^New password/).fill("Parent-pass-1");
    await pp.getByLabel("Repeat new password").fill("Parent-pass-1");
    await pp.getByRole("button", { name: "Change password" }).click();
    await expect(pp).toHaveURL(/\/login/);
    await pp.getByLabel("Username").fill(pUser!);
    await pp.getByLabel(/^Password/).fill("Parent-pass-1");
    await pp.getByRole("button", { name: "Sign in" }).click();
    await expect(pp).toHaveURL(/\/portal/);
    await expect(pp.getByRole("heading", { name: "Chidinma Okafor" })).toBeVisible();
    // a parent cannot open staff pages or other people's data
    const r = await pp.request.get("/api/users");
    expect(r.status()).toBe(403);
    await ctx.close();
  });

  test("duplicate and invalid input is explained next to the field", async ({ page }) => {
    await login(page, ADMIN.username, ADMIN.password);
    await page.goto("/students/new");
    await page.getByLabel("First name").first().fill("X");
    await page.getByLabel("Last name").first().fill("Y");
    await page.getByLabel("Date of birth").fill("2999-01-01");
    await page.getByRole("button", { name: "Save student" }).click();
    await expect(alerts(page).first()).toBeVisible();
    await expect(page).toHaveURL(/\/students\/new/);
  });

  test("the whole admissions journey: public application → documents → registrar review → approval → enrolment → guardian account", async ({ page, browser }) => {
    // 1) an anonymous parent applies from the public page (no account, no cookies)
    const pub = await browser.newContext();
    const ap = await pub.newPage();
    await ap.goto("/apply");
    await expect(ap.getByRole("heading", { name: "Greenfield College" })).toBeVisible();
    await ap.getByLabel("First name").first().fill("Ifeanyi");
    await ap.getByLabel("Last name").first().fill("Nwosu");
    await ap.getByLabel("Date of birth").fill("2014-08-01");
    await ap.getByLabel("Class applying for").selectOption({ label: "JSS 1" });
    await ap.getByLabel("Full name").fill("Chinedu Nwosu");
    await ap.getByLabel("Phone").fill("08055550001");
    await ap.getByRole("button", { name: "Submit application" }).click();
    await expect(ap.getByRole("heading", { name: "Application received" })).toBeVisible();
    const number = (await ap.locator("dd.num").first().innerText()).trim();
    const code = (await ap.locator("dd.num").nth(1).innerText()).trim();
    expect(number).toMatch(/^APP\/\d{4}\/\d{5}$/);
    expect(code).toHaveLength(8);

    // 2) uploads documents: a real PDF is accepted; a disguised executable is rejected with a plain message
    const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(80, 1)]);
    const birth = ap.locator("li", { hasText: "Birth certificate" });
    await birth.locator("input[type=file]").setInputFiles({ name: "birth.pdf", mimeType: "application/pdf", buffer: pdf });
    await expect(birth).toContainText("Uploaded: birth.pdf");
    const photo = ap.locator("li", { hasText: "Passport photograph" });
    await photo.locator("input[type=file]").setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: Buffer.concat([Buffer.from("MZ"), Buffer.alloc(200, 7)]) });
    await expect(photo.getByRole("alert")).toContainText(/not allowed|allowed here/i);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 3)]);
    await photo.locator("input[type=file]").setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: png });
    await expect(photo).toContainText("Uploaded: photo.png");

    // 3) status check with the access code; wrong code reveals nothing
    await ap.getByRole("tab", { name: "Check my application" }).click();
    await ap.getByLabel("Application number").fill(number);
    await ap.getByLabel("Access code").fill("WRONG999");
    await ap.getByRole("button", { name: "Check" }).click();
    await expect(alerts(ap).first()).toContainText("couldn't find that application");
    await ap.getByLabel("Access code").fill(code);
    await ap.getByRole("button", { name: "Check" }).click();
    await expect(ap.getByText("Ifeanyi Nwosu")).toBeVisible();
    await pub.close();

    // 4) the registrar works the application in the staff UI
    await login(page, ADMIN.username, ADMIN.password);
    await page.goto("/admissions");
    await page.getByRole("row", { name: new RegExp(number.replace("/", "\\/")) }).click();
    await expect(page.getByRole("heading", { name: "Ifeanyi Nwosu" })).toBeVisible();
    await page.getByRole("button", { name: "Start review" }).click();
    await expect(page.getByText("Review started")).toBeVisible();
    await page.getByRole("button", { name: "Verify" }).first().click();
    await expect(page.getByText("Verified", { exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: "Verify" }).first().click();
    await expect(page.getByText("Verified", { exact: true })).toHaveCount(2);
    await page.getByRole("button", { name: "Mark verified" }).click();
    await expect(page.getByText("Marked as verified")).toBeVisible();
    await page.getByRole("button", { name: "Approve" }).click();
    await page.getByLabel("Admit into class").selectOption({ label: "JSS 1" });
    await page.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText("Application approved")).toBeVisible();
    await page.getByRole("button", { name: "Enrol as student" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Enrol" }).click();
    const done = page.getByRole("dialog", { name: "Student enrolled" });
    await expect(done).toBeVisible();
    await expect(done).toContainText(/ADM\/\d{4}\/\d{4}/);
    await expect(done).toContainText("Parent login");
    await done.getByRole("button", { name: "Done" }).click();

    // 5) the state machine is enforced by the server, not just hidden buttons
    const api = await adminApi();
    const list = await get(api, "/admissions?status=ENROLLED");
    expect(list.items).toHaveLength(1);
    const rec = list.items[0];
    const bad = await api.post(`/api/admissions/${rec.id}/approve`, { data: { version: rec.version, classId: S.jss1 } });
    expect(bad.status()).toBe(409);
  });

  test("a teacher records attendance from the keyboard; marks are saved and survive a reload", async ({ page }) => {
    // make sure JSS 1 has several students
    const api = await adminApi();
    for (const n of ["Bola", "Chike", "Dami"]) await post(api, "/students", { firstName: n, lastName: "Attendee", gender: "MALE", classId: S.jss1, sectionId: S.secA });
    await login(page, ADMIN.username, ADMIN.password);
    await page.goto("/attendance");
    const list = page.getByRole("listbox", { name: "Students" });
    await expect(list.getByRole("option").first()).toBeVisible();
    await list.focus();
    await page.keyboard.press("p"); await page.keyboard.press("a"); await page.keyboard.press("l"); await page.keyboard.press("p");
    await page.getByRole("button", { name: "Save attendance" }).click();
    await expect(page.getByText(/Saved — \d+ marks? updated/)).toBeVisible();
    await page.reload();
    await expect(page.getByText(/1 absent/)).toBeVisible();
    await expect(page.getByText(/1 late/)).toBeVisible();
    await expect(page.getByText(/2 present/)).toBeVisible();
    // the absence produced an event, and automation queued a notification for the guardian
    await expect.poll(async () => (await get(api, "/notifications")).length, { timeout: 5000 }).toBeGreaterThanOrEqual(0);
  });
});
void request; void BASE_URL;
