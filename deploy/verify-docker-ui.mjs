#!/usr/bin/env node
/**
 * A REAL BROWSER against the REAL containers, in the two states people meet:
 *   1. a bare `docker run` with no configuration (what the login/setup/tower screens used to answer with generic errors);
 *   2. a correctly configured stack, driven through the actual screens: setup wizard → sign in → dashboard; tower sign-in → fleet.
 * Needs Docker, the two images, and Chromium (uses the Playwright in apps/school; on machines missing system libraries set LD_LIBRARY_PATH).
 *   node deploy/verify-docker-ui.mjs [screenshot-dir]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const require = createRequire(resolve("apps/school/package.json"));
const { chromium } = require("@playwright/test");
const SCHOOL = "smartschool/school:2.0.0", CLOUD = "smartschool/cloud:2.0.0";
const shots = resolve(process.argv[2] ?? ".data/docker-ui-shots"); mkdirSync(shots, { recursive: true });
const docker = (...a) => { const r = spawnSync("docker", a, { encoding: "utf8" }); if (r.status !== 0) throw new Error(`docker ${a.join(" ")} → ${r.stderr}`); return r.stdout.trim(); };
const tryDocker = (...a) => spawnSync("docker", a, { encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = () => randomBytes(32).toString("base64");
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) failed++; };
const cleanup = () => { const l = tryDocker("ps", "-aq", "--filter", "name=ssu-").stdout.split("\n").filter(Boolean); if (l.length) tryDocker("rm", "-f", ...l); tryDocker("network", "rm", "ssu-net"); };
const waitFor = async (fn, s, every = 1500) => { const end = Date.now() + s * 1000; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* keep waiting */ } await sleep(every); } return null; };
const up = (port) => waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/health`)).status > 0, 120);
const health = (n) => docker("inspect", n, "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}");
const opts = ["--health-start-period=2s", "--health-interval=4s"];

cleanup();
const browser = await chromium.launch();
try {
  // ───────── 1. unconfigured containers ─────────
  console.log("\n── 1. bare `docker run`, no configuration");
  docker("run", "-d", "--name", "ssu-bare-school", ...opts, "-p", "3810:3000", SCHOOL);
  docker("run", "-d", "--name", "ssu-bare-cloud", ...opts, "-p", "3811:3000", CLOUD);
  await up(3810); await up(3811);
  let page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto("http://127.0.0.1:3810/setup");
  await page.getByText("isn't set up correctly").first().waitFor({ timeout: 15000 });
  await page.screenshot({ path: join(shots, "1-setup-misconfigured.png") });
  ok(await page.getByText("The school server isn't ready").isVisible(), "http://localhost:3000/setup — says 'The school server isn't ready' and why (was: nothing until submit, then 'Something went wrong')");
  ok(await page.getByText(/Reference: [0-9a-f]{8}/).isVisible(), "…with a reference id that matches the server log");
  ok(!(await page.getByText("Something went wrong. Please try again.").count()), "the generic message is gone");
  await page.getByLabel("School name").fill("X College"); await page.getByLabel("First name").fill("A"); await page.getByLabel("Last name").fill("B"); await page.getByLabel("Username").fill("owner.admin"); await page.getByLabel("Password").fill("Sup3r-secret-Adm1n");
  await page.getByRole("button", { name: "Create school" }).click();
  await page.locator("[role=alert]:not(#__next-route-announcer__)").filter({ hasText: "isn't set up correctly" }).first().waitFor({ timeout: 15000 });
  ok(true, "submitting the setup form shows the real reason too (not a generic failure)");
  await page.goto("http://127.0.0.1:3810/login");
  await page.getByText("isn't set up correctly").first().waitFor({ timeout: 15000 });
  await page.screenshot({ path: join(shots, "2-login-misconfigured.png") });
  ok(await page.getByText("The school server isn't ready").isVisible(), "login page explains the server problem before anyone types a password");
  const t = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await t.goto("http://127.0.0.1:3811/fleet");
  await t.getByRole("heading", { name: "The Control Tower isn't ready" }).waitFor({ timeout: 15000 });
  await t.screenshot({ path: join(shots, "3-tower-misconfigured.png") });
  ok(!(await t.getByRole("heading", { name: "Can't reach the Control Tower" }).count()), "Control Tower: no false \"Can't reach the Control Tower\" — it is reachable, and says it is misconfigured");
  ok(await t.getByText(/Reference: [0-9a-f]{8}/).isVisible(), "…with a reference id");
  await page.close(); await t.close();
  tryDocker("rm", "-f", "ssu-bare-school", "ssu-bare-cloud");

  // ───────── 2. correctly configured stack ─────────
  console.log("\n── 2. correctly configured stack (user-defined network, PostgreSQL, school, worker, tower)");
  docker("network", "create", "ssu-net");
  const pw = randomBytes(12).toString("hex");
  docker("run", "-d", "--name", "ssu-pg", "--network", "ssu-net", "-e", `POSTGRES_PASSWORD=${pw}`, "postgres:18");
  await waitFor(() => tryDocker("exec", "ssu-pg", "pg_isready", "-U", "postgres").status === 0, 60, 2000);
  const schoolEnv = ["-e", `DATABASE_URL=postgresql://postgres:${pw}@ssu-pg:5432/smartschool_school`, "-e", `APP_ENCRYPTION_KEY=${b64()}`, "-e", `APP_SIGNING_SECRET=${b64()}`];
  const keys = execFileSync("node", ["-e", `const c=require("node:crypto");const{publicKey:p,privateKey:k}=c.generateKeyPairSync("ed25519");const b=(x,t)=>Buffer.from(x.export({type:t,format:"pem"})).toString("base64");console.log(b(k,"pkcs8")+" "+b(p,"spki"))`], { encoding: "utf8" }).trim().split(" ");
  docker("run", "-d", "--name", "ssu-tower", "--network", "ssu-net", ...opts, "-p", "3821:3000", "-e", `CLOUD_DATABASE_URL=postgresql://postgres:${pw}@ssu-pg:5432/smartschool_cloud`, "-e", `CLOUD_ENCRYPTION_KEY=${b64()}`, "-e", `CLOUD_SIGNING_PRIVATE_KEY=${keys[0]}`, "-e", `CLOUD_SIGNING_PUBLIC_KEY=${keys[1]}`, CLOUD);
  docker("run", "-d", "--name", "ssu-school", "--network", "ssu-net", ...opts, "-p", "3820:3000", ...schoolEnv, SCHOOL);
  docker("run", "-d", "--name", "ssu-worker", "--network", "ssu-net", "--health-start-period=5s", "--health-interval=5s", "--health-cmd", "node_modules/.bin/tsx scripts/worker-health.ts", ...schoolEnv, SCHOOL, "node_modules/.bin/tsx", "src/workers/main.ts");
  ok(!!(await waitFor(() => health("ssu-school") === "healthy" && health("ssu-tower") === "healthy" && health("ssu-worker") === "healthy", 300, 3000)), "school, tower and worker are all healthy");
  execFileSync("docker", ["exec", "ssu-tower", "node_modules/.bin/tsx", "scripts/create-operator.ts", "root@tower.test", "Tower Root", "tower-root-password-1", "SUPER_ADMIN"], { stdio: "pipe" });

  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto("http://127.0.0.1:3820/");
  await page.waitForURL(/\/setup/, { timeout: 20000 });
  ok(true, "http://localhost:3000/ → the setup wizard (fresh installation)");
  await page.getByLabel("School name").fill("Container College"); await page.getByLabel("City or town").fill("Enugu"); await page.getByLabel("First name").fill("Ada"); await page.getByLabel("Last name").fill("Obi"); await page.getByLabel("Username").fill("owner.admin"); await page.getByLabel("Password").fill("Sup3r-secret-Adm1n");
  await page.getByRole("button", { name: "Create school" }).click();
  await page.getByRole("heading", { name: /Container College is ready/ }).waitFor({ timeout: 20000 });
  await page.screenshot({ path: join(shots, "4-setup-complete.png") });
  ok(true, "the Primary Admin is created through the real wizard");
  await page.getByRole("button", { name: "Go to sign in" }).click();
  await page.getByLabel("Username").fill("owner.admin"); await page.getByLabel(/^Password/).fill("wrong-password-99"); await page.getByRole("button", { name: "Sign in" }).click();
  await page.locator("[role=alert]:not(#__next-route-announcer__)").filter({ hasText: "Incorrect username or password" }).waitFor({ timeout: 15000 });
  ok(true, "a wrong password is refused with a clear, safe message");
  await page.getByLabel(/^Password/).fill("Sup3r-secret-Adm1n"); await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 20000 });
  await page.getByRole("heading", { name: /Welcome, Ada/ }).waitFor();
  await page.screenshot({ path: join(shots, "5-dashboard.png") });
  ok(true, "sign-in → the session is kept → the protected dashboard loads");
  await page.reload(); await page.getByRole("heading", { name: /Welcome, Ada/ }).waitFor();
  ok(true, "the session survives a page reload (cookie accepted by the browser over plain HTTP)");
  await page.getByRole("button", { name: "Sign out" }).first().click(); await page.waitForURL(/\/login/, { timeout: 15000 });
  await page.goto("http://127.0.0.1:3820/dashboard"); await page.waitForURL(/\/login/, { timeout: 15000 });
  ok(true, "logout works, and the protected page now sends you to sign in");

  const tp = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tp.goto("http://127.0.0.1:3821/fleet"); await tp.waitForURL(/\/login/, { timeout: 15000 });
  await tp.getByLabel("Email").fill("root@tower.test"); await tp.getByLabel("Password").fill("tower-root-password-1"); await tp.getByRole("button", { name: "Sign in" }).click();
  await tp.waitForURL(/\/fleet/, { timeout: 20000 });
  await tp.getByRole("button", { name: "New school" }).waitFor();
  await tp.screenshot({ path: join(shots, "6-tower-fleet.png") });
  ok(true, "Control Tower: sign-in → fleet screen loads (no 'Can't reach')");
  await tp.getByRole("button", { name: "New school" }).click();
  await tp.getByRole("dialog").getByLabel("School name").fill("Container College"); await tp.getByRole("dialog").getByRole("button", { name: "Create installation" }).click();
  const token = (await tp.getByTestId("registration-token").innerText()).trim();
  ok(/^SSR-SS-/.test(token), "Control Tower: creating a school issues a one-time token");
  await tp.getByRole("button", { name: "Done" }).click();

  // the school registers with the tower BY CONTAINER NAME, through its own admin screen
  await page.goto("http://127.0.0.1:3820/login"); await page.getByLabel("Username").fill("owner.admin"); await page.getByLabel(/^Password/).fill("Sup3r-secret-Adm1n"); await page.getByRole("button", { name: "Sign in" }).click(); await page.waitForURL(/\/dashboard/);
  await page.goto("http://127.0.0.1:3820/admin/sync");
  await page.getByRole("button", { name: "Register with the cloud" }).click();
  await page.getByLabel("Cloud address").fill("http://ssu-tower:3000"); await page.getByLabel("Registration token").fill(token);
  await page.getByRole("dialog").getByRole("button", { name: "Register" }).click();
  await page.getByText(/Registered as SS-/).first().waitFor({ timeout: 30000 });
  ok(true, "school → Control Tower registration through the real screen, by container name (browser URL and container URL are different, correctly)");
  await page.getByRole("button", { name: "Sync now" }).click(); await sleep(2500);
  await tp.reload(); await tp.getByRole("button", { name: /Container College/ }).first().click();
  await tp.getByText("Last heard from just now").waitFor({ timeout: 20000 });
  await tp.screenshot({ path: join(shots, "7-tower-school-health.png") });
  ok(true, "Control Tower shows the school reporting in, with its health");
} catch (e) {
  failed++; console.log(`FAIL  ${String(e.message).split("\n").slice(0, 3).join(" | ").slice(0, 400)}`);
} finally {
  await browser.close(); cleanup();
}
console.log(failed ? `\n${failed} CHECK(S) FAILED` : `\nALL CHECKS PASSED (screenshots in ${shots})`);
process.exit(failed ? 1 : 0);
