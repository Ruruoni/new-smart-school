import { expect, test } from "@playwright/test";
import { ADMIN } from "./env";
import { activateUser, seedSchool, type State } from "./seed";
import { adminApi, alerts, get, login, post } from "./helpers";

let S: State;
const kids: { id: string; first: string }[] = [];
let parent = { username: "", password: "Parent-pass-2" };

test.beforeAll(async () => {
  S = await seedSchool();
  const api = await adminApi();
  for (const [i, first] of ["Amara", "Bisi", "Chuka"].entries()) {
    const r = await post(api, "/students", { firstName: first, lastName: "Pupil", gender: i === 1 ? "MALE" : "FEMALE", classId: S.jss1, sectionId: S.secA, guardians: i === 0 ? [{ newParent: { firstName: "Mrs", lastName: "Pupil", phone: "08099990001" }, relationship: "Mother" }] : [] });
    kids.push({ id: r.student.id, first });
    if (i === 0) { parent.username = r.guardianCredentials[0].username; await activateUser(parent.username, r.guardianCredentials[0].initialPassword, parent.password); }
  }
});

test.describe.serial("teacher scores → results → parent portal → fee lockout", () => {
  test("a teacher enters scores in the grid by keyboard; every cell autosaves, bad values are explained, and edits survive a reload", async ({ page }) => {
    await login(page, S.teacher.username, S.teacher.password);
    await expect(page).toHaveURL(/\/teach/);
    await page.goto("/results/scores");
    const ca1 = (n: string) => page.getByLabel(`${n} Pupil, 1st Continuous Assessment, out of 20`);
    const ca2 = (n: string) => page.getByLabel(`${n} Pupil, 2nd Continuous Assessment, out of 20`);
    const ex = (n: string) => page.getByLabel(`${n} Pupil, Examination, out of 60`);
    await expect(ca1("Amara")).toBeVisible();

    await ca1("Amara").click();
    await page.keyboard.type("18"); await page.keyboard.press("Enter"); // moves down
    await page.keyboard.type("15"); await page.keyboard.press("Enter");
    await page.keyboard.type("10");
    await ca2("Amara").fill("19"); await ca2("Bisi").fill("15"); await ca2("Chuka").fill("10");
    await ex("Amara").fill("55"); await ex("Bisi").fill("40"); await ex("Chuka").fill("a"); // "a" = absent
    await expect(ca1("Bisi")).toHaveValue("15");
    await expect(page.getByText("All changes saved")).toBeVisible({ timeout: 15_000 });

    // validation happens instantly, next to the cell, and the bad value is never sent
    await ca1("Amara").fill("25");
    await expect(page.getByText("Maximum is 20")).toBeVisible();
    await ca1("Amara").fill("18");
    await expect(page.getByText("Maximum is 20")).toHaveCount(0);

    // live preview of total and grade
    const row = page.getByRole("row", { name: /Pupil, Amara/ });
    await expect(row).toContainText("92");
    await expect(row).toContainText("A1");
    await expect(page.getByText("All changes saved")).toBeVisible({ timeout: 15_000 });

    await page.reload();
    await expect(ca1("Amara")).toHaveValue("18");
    await expect(ex("Chuka")).toHaveValue("ABS");

    // a concurrent edit by someone else is surfaced, never silently overwritten
    const api = await adminApi();
    const sheet = await get(api, `/results/sheet?classSubjectId=${S.classSubjectId}&termId=${S.termId}`);
    const type = sheet.components[0].id;
    const cur = sheet.rows.find((r: any) => r.firstName === "Bisi").scores[type];
    await post(api, "/results/scores", { classSubjectId: S.classSubjectId, termId: S.termId, entries: [{ studentId: kids[1]!.id, typeId: type, score: 12, version: cur.version }] });
    await ca1("Bisi").fill("16");
    await expect(page.getByText(/Changed by someone else to 12/)).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Keep mine" }).click();
    await expect(page.getByText("All changes saved")).toBeVisible({ timeout: 15_000 });
    const after = await get(api, `/results/sheet?classSubjectId=${S.classSubjectId}&termId=${S.termId}`);
    expect(after.rows.find((r: any) => r.firstName === "Bisi").scores[type].score).toBe(16);
  });

  test("a teacher cannot touch another teacher's class, even by calling the API directly", async ({ page }) => {
    const api = await adminApi();
    const eng = await post(api, "/academics/class-subjects", { classId: S.jss1, subjectId: S.eng }); // English: no teacher assigned
    await login(page, S.teacher.username, S.teacher.password);
    const r = await page.request.get(`/api/results/sheet?classSubjectId=${eng.id}&termId=${S.termId}`);
    expect(r.status()).toBe(403);
  });

  test("the administrator processes and publishes the class results from the Results page", async ({ page }) => {
    await login(page, ADMIN.username, ADMIN.password);
    await page.goto("/results");
    await page.getByRole("button", { name: "Process results" }).click();
    // English has no scores yet: the server explains what is incomplete instead of silently producing zeros
    await expect(page.getByRole("dialog", { name: "Some score sheets are incomplete" })).toBeVisible();
    await page.getByRole("button", { name: /Process anyway/ }).click();
    await expect(page.locator("p[role=status]", { hasText: /Processed 3 students\./ })).toBeVisible();
    const amara = page.getByRole("row", { name: /Pupil, Amara/ });
    await expect(amara).toContainText("1st");
    await expect(amara).toContainText("Draft");
    await page.getByRole("button", { name: /^Publish/ }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Publish to parents" }).click();
    await expect(page.getByText(/Published 3 report cards/)).toBeVisible();
    await expect(amara).toContainText("Published");
    // published scores are frozen for teachers
    const api = await adminApi();
    const sheet = await get(api, `/results/sheet?classSubjectId=${S.classSubjectId}&termId=${S.termId}`);
    expect(sheet.published).toBe(true);
  });

  test("the parent sees the published result of their own child on the mobile portal and can download the report card PDF", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true });
    const page = await ctx.newPage();
    await login(page, parent.username, parent.password);
    await expect(page).toHaveURL(/\/portal/);
    await page.getByRole("link", { name: "Results" }).click();
    await expect(page.getByText("Mathematics")).toBeVisible();
    await expect(page.getByText("A1")).toBeVisible();
    await expect(page.getByText("1st").first()).toBeVisible();
    const pdf = await page.request.get(`/api/results/students/${kids[0]!.id}/report-card.pdf?termId=${S.termId}`);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toBe("application/pdf");
    expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");
    // another family's child is invisible: 404, never 403
    expect((await page.request.get(`/api/results/students/${kids[1]!.id}/report-card?termId=${S.termId}`)).status()).toBe(404);
    // no horizontal scrolling on a phone
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await ctx.close();
  });

  test("financial lockout: the bursar turns it on, fees become overdue, the parent is blocked with the amount owing; paying lifts it; reversing the payment re-applies it", async ({ page, browser }) => {
    const api = await adminApi();
    const bill = await post(api, "/finance/invoices/generate-class", { classId: S.jss1, termId: S.termId, dueDate: "2020-01-01" });
    expect(bill.created).toBeGreaterThanOrEqual(3);

    // 1) the school turns the policy on from the Finance → Result lockout tab
    await login(page, ADMIN.username, ADMIN.password);
    await page.goto("/finance");
    await page.getByRole("tab", { name: "Result lockout" }).click();
    await page.getByLabel("Hold results back when fees are overdue").check();
    await page.getByLabel("Message shown to parents").fill("Please visit the bursary to settle fees.");
    await page.getByRole("button", { name: "Save policy" }).click();
    await expect(page.getByText("Policy saved")).toBeVisible();

    // 2) the parent is blocked — by the server — and shown what to do
    const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
    const pp = await ctx.newPage();
    await login(pp, parent.username, parent.password);
    await pp.goto("/portal/results");
    await expect(pp.getByRole("alert").filter({ hasText: "Results are on hold" })).toBeVisible();
    await expect(pp.getByText("Please visit the bursary to settle fees.")).toBeVisible();
    await expect(pp.locator("strong", { hasText: "₦75,000.00" })).toBeVisible();
    await expect(pp.getByText("Mathematics")).toHaveCount(0);
    expect((await pp.request.get(`/api/results/students/${kids[0]!.id}/report-card.pdf?termId=${S.termId}`)).status()).toBe(403);
    // staff are unaffected
    expect((await page.request.get(`/api/results/students/${kids[0]!.id}/report-card?termId=${S.termId}`)).status()).toBe(200);

    // 3) the bursar records the payment through the dialog
    await page.getByRole("tab", { name: "Payments" }).click();
    await page.getByRole("button", { name: "Record payment" }).click();
    await page.getByLabel("Find student").fill("Amara");
    await page.getByRole("button", { name: /Pupil, Amara/ }).click();
    await expect(page.getByText(/Owes/)).toContainText("₦75,000.00");
    await page.getByLabel("Amount (₦)").fill("75000");
    await page.getByRole("dialog").getByRole("button", { name: "Record payment" }).click();
    await expect(page.getByRole("dialog")).toContainText(/Receipt RCP\/\d{4}\/\d{5}/);
    await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();

    // 4) the block lifts immediately
    await pp.reload();
    await expect(pp.getByText("Mathematics")).toBeVisible();

    // 5) reversing the payment (with a reason) puts the child back on hold and keeps the original on record
    await page.reload();
    await page.getByRole("row", { name: /Amara Pupil/ }).getByRole("button", { name: "Reverse" }).click();
    await page.getByLabel("Reason").fill("Cheque bounced");
    await page.getByRole("button", { name: "Reverse payment" }).click();
    await expect(page.getByText(/reversed — the original stays on record/)).toBeVisible();
    await expect(page.getByRole("row", { name: /Amara Pupil/ })).toContainText("Reversed");
    await pp.reload();
    await expect(pp.getByRole("alert").filter({ hasText: "Results are on hold" })).toBeVisible();
    const verify = await get(api, "/finance/verify");
    expect(verify.ok, JSON.stringify(verify.problems)).toBe(true);
    await ctx.close();
  });
});
void alerts;
