import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";
import { ADMIN } from "./env";
import { seedSchool, type State } from "./seed";
import { adminApi, get, login } from "./helpers";
import { ensureWorker } from "./worker";

let S: State;
const dir = resolve("test-results/fixtures");
const file = resolve(dir, "students.xlsx");

const HEAD = ["First name", "Last name", "Gender", "Date of birth", "Class", "Section", "Guardian name", "Guardian phone", "Relationship"];
const ROWS: (string | null)[][] = [
  ["Ifeoma", "Eze", "Female", "2014-03-02", "JSS 1", "A", "Ngozi Eze", "08031110001", "Mother"],
  ["Uche", "Eze", "Male", "2015-08-19", "JSS 1", "A", "Ngozi Eze", "08031110001", "Mother"], // sibling → same parent account
  ["Kelechi", "Madu", "F", "2013-11-30", "JSS 1", null, null, null, null],
  ["Bad", "Gender", "Unknown", "2014-01-01", "JSS 1", null, null, null, null],
  ["Old", "Dob", "Male", "1980-01-01", "JSS 1", null, null, null, null], // 40+ years old: implausible for a student
  ["Wrong", "Class", "Male", "2014-01-01", "JSS 9", null, null, null, null],
];

test.beforeAll(async () => {
  S = await seedSchool();
  await ensureWorker();
  mkdirSync(dir, { recursive: true });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Students");
  ws.addRow(HEAD);
  for (const r of ROWS) ws.addRow(r);
  await wb.xlsx.writeFile(file);
});

test.describe.serial("Excel import and reports", () => {
  test("the registrar uploads a spreadsheet, sees exactly what is wrong before anything is saved, and imports the good rows", async ({ page }) => {
    await login(page, ADMIN.username, ADMIN.password);
    await page.goto("/imports");
    await page.getByLabel("What are you importing?").selectOption({ label: "Students (with guardians)" });
    await page.locator('input[type=file]').setInputFiles(file);
    await page.getByRole("button", { name: "Upload and check" }).click();
    await page.waitForURL(/\/imports\/[0-9a-f-]{36}/);

    // the worker validates in the background; the page updates itself
    await expect(page.getByRole("heading", { name: "Review and approve" })).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText("Nothing has been saved yet.")).toBeVisible();
    const stat = (label: string) => page.locator("div", { has: page.getByText(label, { exact: true }) }).last();
    await expect(stat("Rows in file")).toContainText("6");
    await expect(stat("Ready to import")).toContainText("3");
    await expect(stat("Have problems")).toContainText("3");

    // each problem names the row, the column and what to do
    const problems = page.getByRole("table").filter({ hasText: "Problem" });
    await expect(problems).toContainText("Gender must be Male or Female");
    await expect(problems).toContainText("outside the expected range");
    await expect(problems).toContainText(/JSS 9/);

    // nothing exists yet
    const api = await adminApi();
    expect((await get(api, "/students?q=Ifeoma")).items).toHaveLength(0);

    // importing everything is blocked until the user chooses to skip the bad rows
    const importBtn = page.getByRole("button", { name: "Import 3 rows" });
    await expect(importBtn).toBeDisabled();
    await page.getByLabel(/Import the 3 good rows and skip the 3 with problems/).check();
    await importBtn.click();
    await expect(page.getByText("Imported 3 rows")).toBeVisible({ timeout: 45_000 });
    await expect(page.getByRole("link", { name: "Download the temporary passwords" })).toBeVisible();

    const list = await get(api, "/students?q=Eze");
    expect(list.items).toHaveLength(2);
    // siblings share one parent account
    const a = await get(api, `/students/${list.items[0].id}`);
    const b = await get(api, `/students/${list.items[1].id}`);
    expect(a.guardians[0].parent.id).toBe(b.guardians[0].parent.id);
    expect((await get(api, "/students?q=Bad")).items).toHaveLength(0);
  });

  test("uploading the same file again does not create duplicates; and a wrong file type is refused with a clear message", async ({ page }) => {
    await login(page, ADMIN.username, ADMIN.password);
    await page.goto("/imports");
    await page.locator('input[type=file]').setInputFiles(file);
    await page.getByRole("button", { name: "Upload and check" }).click();
    await page.waitForURL(/\/imports\/[0-9a-f-]{36}/);
    await expect(page.getByRole("heading", { name: "Review and approve" })).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText("Ready to import", { exact: true }).locator("..")).toContainText("0");
    await expect(page.getByText("Already exist", { exact: true }).locator("..")).not.toContainText(/^Already exist\s*0$/);
    await expect(page.getByRole("button", { name: /^Import 0 row/ })).toBeDisabled();
    await page.getByRole("button", { name: "Cancel import" }).click();
    await expect(page.getByText("Cancelled").first()).toBeVisible();

    await page.goto("/imports");
    await page.locator('input[type=file]').setInputFiles({ name: "students.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("MZ\x90\x00 this is really a program, not a spreadsheet") });
    await page.getByRole("button", { name: "Upload and check" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /spreadsheet|file/i })).toBeVisible();
    await expect(page).toHaveURL(/\/imports$/);
  });

  test("a report is prepared in the background, downloads as a real Excel file, and contains the imported students", async ({ page }) => {
    await login(page, ADMIN.username, ADMIN.password);
    await page.goto("/reports");
    await page.getByLabel("Report", { exact: true }).selectOption({ label: "Student list" });
    await page.getByRole("button", { name: "Preview" }).click();
    await expect(page.getByRole("table").filter({ hasText: "Ifeoma" })).toBeVisible();
    await page.getByLabel("Download as").selectOption("XLSX");
    await page.getByRole("button", { name: "Prepare Excel" }).click();
    const link = page.getByRole("link", { name: "Download" }).first();
    await expect(link).toBeVisible({ timeout: 45_000 });
    const [dl] = await Promise.all([page.waitForEvent("download"), link.click()]);
    expect(dl.suggestedFilename()).toMatch(/\.xlsx$/);
    const path = await dl.path();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path);
    const text: string[] = [];
    wb.eachSheet((ws) => ws.eachRow((r) => text.push(r.values!.toString())));
    const all = text.join("\n");
    expect(all).toContain("Ifeoma");
    expect(all).toContain("Kelechi");
    expect(all).not.toContain("Bad,Gender");
  });
});
