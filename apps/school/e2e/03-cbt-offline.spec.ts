import { expect, test } from "@playwright/test";
import { activateUser, seedSchool, type State } from "./seed";
import { adminApi, apiAs, get, login, post } from "./helpers";

let S: State;
let examId = "";
const student = { username: "", password: "Student-pass-1" };
const opts = (correct: number) => Array.from({ length: 4 }, (_, i) => ({ label: "ABCD"[i]!, text: `Choice ${"ABCD"[i]} for item`, isCorrect: i === correct }));

test.beforeAll(async () => {
  S = await seedSchool();
  const api = await adminApi();
  const topic = await post(api, "/cbt/topics", { subjectId: S.math, name: "Number work" });
  const qs: string[] = [];
  for (let i = 0; i < 5; i++) qs.push((await post(api, "/cbt/questions", { subjectId: S.math, topicId: topic.id, stem: `Offline item ${i + 1}: what is ${i + 1} + ${i + 1}?`, options: opts(i % 4) })).id);
  const exam = await post(api, "/cbt/exams", { title: "JSS 1 Maths test", kind: "SCHOOL", subjectId: S.math, classIds: [S.jss1], durationMinutes: 30, maxAttempts: 1, sections: [{ title: "Section A", questions: qs.map((questionId) => ({ questionId, marks: 2 })) }] });
  examId = exam.id;
  await post(api, `/cbt/exams/${examId}/status`, { status: "OPEN" });
  const st = await post(api, "/students", { firstName: "Tobi", lastName: "Examinee", gender: "MALE", classId: S.jss1, sectionId: S.secA, createLogin: true });
  student.username = st.username;
  await activateUser(st.username, st.initialPassword, student.password);
});

test.describe.serial("CBT exam room", () => {
  test("the student loses the Wi-Fi mid-exam, keeps answering, refreshes the page, reconnects — and nothing is lost", async ({ page, context }) => {
    await login(page, student.username, student.password);
    await expect(page).toHaveURL(/\/student/);
    await page.getByRole("button", { name: "Start exam" }).click();
    await page.waitForURL(/\/exam\//);
    await expect(page.getByText("Question 1 of 5")).toBeVisible();
    await expect(page.getByRole("timer")).toContainText(/\d\d:\d\d/);

    // let the service worker take control so a reload works with no network
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.reload();
    await expect(page.getByText("Question 1 of 5")).toBeVisible();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, undefined, { timeout: 15_000 });

    // online answer: reaches the server
    await page.getByRole("radio", { name: /Choice A/ }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({ timeout: 15_000 });
    const attemptId = page.url().split("/exam/")[1]!.split(/[?#]/)[0]!;

    // the network drops
    await context.setOffline(true);
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("radio", { name: /Choice B/ }).click(); // Q2 answered offline
    await page.getByRole("button", { name: "Next" }).click();
    await page.keyboard.press("c"); // Q3 by keyboard shortcut
    await page.keyboard.press("f"); // and flagged
    await expect(page.getByRole("status").filter({ hasText: "Offline — answers safe on this device" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Question 3, answered and flagged" })).toBeVisible();
    // the timer keeps running from the server's clock
    const t1 = await page.getByRole("timer").innerText();
    await page.waitForTimeout(2200);
    expect(await page.getByRole("timer").innerText()).not.toBe(t1);

    // refresh with no network at all: the exam room comes back from the device, with the answers
    await page.reload();
    await expect(page.getByText(/Question \d of 5/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("status").filter({ hasText: "Offline" })).toBeVisible();
    await page.getByRole("button", { name: "Question 2, answered" }).click();
    await expect(page.getByRole("radio", { name: /Choice B/ })).toHaveAttribute("aria-checked", "true");
    await page.getByRole("button", { name: "Question 3, answered and flagged" }).click();
    await expect(page.getByRole("radio", { name: /Choice C/ })).toHaveAttribute("aria-checked", "true");

    // the server knows nothing about the offline answers yet
    const stuApi = await apiAs(student.username, student.password);
    const serverAnswered = async () => Object.values((await get(stuApi, `/exam/attempts/${attemptId}/paper`)).answers as Record<string, { selectedOptionIds: string[] }>).filter((a) => a.selectedOptionIds.length).length;
    expect(await serverAnswered()).toBe(1);

    // the network returns: answers sync on their own
    await context.setOffline(false);
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({ timeout: 30_000 });
    expect(await serverAnswered()).toBe(3);

    // finish: the dialog counts what is answered and what is blank, then submits
    await page.getByRole("button", { name: "Finish exam" }).first().click();
    const dlg = page.getByRole("dialog", { name: "Finish and submit?" });
    await expect(dlg).toContainText("3 of 5");
    await expect(dlg).toContainText("2 questions are still blank.");
    await expect(dlg).toContainText("1 flagged for review.");
    await dlg.getByRole("button", { name: "Submit exam" }).click();
    await expect(page.getByRole("heading", { name: /Your answers are in|Exam submitted/ })).toBeVisible({ timeout: 15_000 });
    // a school exam does not show the score until the teacher publishes it
    await expect(page.getByText("Your teacher will publish the results.")).toBeVisible();
  });

  test("the exam cannot be taken twice, the teacher publishes, and the student then sees the mark", async ({ page }) => {
    await login(page, student.username, student.password);
    await expect(page.getByRole("button", { name: "Completed" })).toBeDisabled();
    const api = await adminApi();
    const res = await get(api, `/cbt/exams/${examId}/results`);
    expect(res).toHaveLength(1);
    await post(api, `/cbt/exams/${examId}/publish`);
    await page.reload();
    // Q1 (A) and Q2 (B) are right; Q3 (C) is right for i=2; 3 correct of 5 → 6/10
    await expect(page.getByRole("button", { name: "60%" })).toBeVisible();
  });

  test("a second sitting is refused even when the button is bypassed", async () => {
    const stu = await apiAs(student.username, student.password);
    const again = await stu.post(`/api/exam/${examId}/start`, { data: {} });
    expect(again.status()).toBe(409);
    await stu.dispose();
  });
});
