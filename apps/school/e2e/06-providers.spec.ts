import http from "node:http";
import { expect, test } from "@playwright/test";
import { ADMIN } from "./env";
import { seedSchool } from "./seed";
import { alerts, login } from "./helpers";

// A stand-in SMS gateway on this machine: records what it receives and can be told to refuse.
const received: Record<string, unknown>[] = [];
let mode: "ok" | "reject" = "ok";
let server: http.Server; let gateway = "";

test.beforeAll(async () => {
  await seedSchool();
  server = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push(JSON.parse(body || "{}"));
      res.setHeader("content-type", "application/json");
      if (mode === "reject") { res.statusCode = 400; return void res.end(JSON.stringify({ message: "Invalid sender name" })); }
      res.end(JSON.stringify({ message_id: "gw-1" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  gateway = `http://127.0.0.1:${(server.address() as { port: number }).port}/sms/send`;
});
test.afterAll(async () => { await new Promise((r) => server.close(r)); });

test("an administrator sets up an SMS gateway, proves it works with a test message, and editing the e-mail settings never switches the SMS off", async ({ page }) => {
  await login(page, ADMIN.username, ADMIN.password);
  await page.goto("/communication");
  await page.getByRole("tab", { name: /Providers/ }).click();
  await expect(page.getByText("Save a provider first, then test it here.")).toBeVisible();

  await page.getByLabel("Gateway address").fill(gateway);
  await page.getByLabel("API key", { exact: true }).fill("gw-secret-key");
  await page.getByLabel("Sender name").fill("GREENFIELD");
  await page.getByRole("button", { name: "Save providers" }).click();
  await expect(page.getByText("Configured: " + gateway)).toBeVisible();

  // the secret is never sent back to the browser
  const cfg = await (await page.request.get("/api/communication/providers")).json();
  expect(JSON.stringify(cfg)).not.toContain("gw-secret-key");

  // a working gateway
  await page.getByLabel("Send to").fill("0803 123 4567");
  await page.getByRole("button", { name: "Send test message" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Sent. Check that the message arrived." })).toBeVisible();
  expect(received.at(-1)).toMatchObject({ to: "2348031234567", from: "GREENFIELD", api_key: "gw-secret-key" });
  expect(String(received.at(-1)!.sms)).toContain("Greenfield College");

  // a gateway that refuses: the reason is shown in plain words
  mode = "reject";
  await page.getByRole("button", { name: "Send test message" }).click();
  await expect(alerts(page).filter({ hasText: "Invalid sender name" })).toBeVisible();
  mode = "ok";

  // saving ONLY the e-mail server leaves the SMS gateway configured
  await page.getByLabel("Server").fill("smtp.greenfield.test");
  await page.getByLabel("Send from").fill("Greenfield <office@greenfield.test>");
  await page.getByRole("button", { name: "Save providers" }).click();
  await expect(page.getByText(/Configured: smtp\.greenfield\.test/)).toBeVisible();
  await expect(page.getByText("Configured: " + gateway)).toBeVisible();

  // removing a provider switches just that one off
  await page.getByText("Configured: " + gateway).locator("..").getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Configured: " + gateway)).toHaveCount(0);
  await expect(page.getByText(/Configured: smtp\.greenfield\.test/)).toBeVisible();

  // asking an unconfigured channel to send says what to do, never a stack trace
  const r = await page.request.post("/api/communication/providers/test", { data: { channel: "SMS", to: "08031234567" }, headers: { origin: "http://127.0.0.1:3200" } });
  expect((await r.json()).data).toEqual({ ok: false, error: "No sms provider is set up yet. Save its settings first." });
});
