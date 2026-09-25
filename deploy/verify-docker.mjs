#!/usr/bin/env node
/**
 * End-to-end verification of the SmartSchool images in REAL containers — the failure modes people actually hit as well as the
 * happy path. Needs Docker and the images smartschool/school:2.0.0 and smartschool/cloud:2.0.0 (see docs/deployment.md).
 *   node deploy/verify-docker.mjs            (set DOCKER_CONFIG to a dir containing {} if the credential helper fails)
 * Creates and removes its own containers/network (names start with "ssv-"). Exit code 0 only if every check passes.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const SCHOOL = "smartschool/school:2.0.0", CLOUD = "smartschool/cloud:2.0.0";
const PORTS = { bareSchool: 3710, bareCloud: 3711, school: 3720, tower: 3721, bridge: 3730, unmigrated: 3731 };
const docker = (...a) => { const r = spawnSync("docker", a, { encoding: "utf8" }); if (r.status !== 0) throw new Error(`docker ${a.join(" ")} → ${r.stderr}`); return r.stdout.trim(); };
const tryDocker = (...a) => spawnSync("docker", a, { encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = () => randomBytes(32).toString("base64");
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) failed++; };
const section = (t) => console.log(`\n── ${t}`);
const logs = (n) => { const r = tryDocker("logs", n); return `${r.stdout}${r.stderr}`; };
const cleanup = () => { const l = tryDocker("ps", "-aq", "--filter", "name=ssv-").stdout.split("\n").filter(Boolean); if (l.length) tryDocker("rm", "-f", ...l); tryDocker("network", "rm", "ssv-net"); };

async function waitFor(fn, seconds, every = 1000) { const end = Date.now() + seconds * 1000; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* keep waiting */ } await sleep(every); } return null; }
const http = async (port, path, { method = "GET", body, cookie = "", headers = {} } = {}) => {
  const base = `http://127.0.0.1:${port}`;
  const r = await fetch(base + path, { method, redirect: "manual", headers: { origin: base, ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text, setCookie: r.headers.get("set-cookie") ?? "", requestId: r.headers.get("x-request-id") };
};
const reachable = (port) => waitFor(async () => (await http(port, "/api/health")).status > 0, 120);
const health = (name) => docker("inspect", name, "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}");

cleanup();
const runOpts = ["--health-start-period=2s", "--health-interval=4s", "--health-timeout=8s", "--health-retries=2"];

try {
  // ───────────────────────────────────────────────────────────────────────────────────────────────
  section("A. a bare `docker run` with NO configuration (how the problem was first seen)");
  docker("run", "-d", "--name", "ssv-bare-school", ...runOpts, "-p", `${PORTS.bareSchool}:3000`, SCHOOL);
  docker("run", "-d", "--name", "ssv-bare-cloud", ...runOpts, "-p", `${PORTS.bareCloud}:3000`, CLOUD);
  ok(!!(await reachable(PORTS.bareSchool)), "school container answers HTTP quickly (no runtime download of pnpm)");
  ok(!!(await reachable(PORTS.bareCloud)), "tower container answers HTTP");
  let l = logs("ssv-bare-school");
  ok(/CONFIGURATION PROBLEM/.test(l) && /DATABASE_URL is not set/.test(l) && /APP_ENCRYPTION_KEY is not set/.test(l), "school log names exactly what is missing");
  ok(/docker compose -f deploy\/docker-compose\.school\.yml/.test(l), "school log tells the installer how to fix it");
  l = logs("ssv-bare-cloud");
  ok(/CLOUD_DATABASE_URL is not set/.test(l) && /CLOUD_SIGNING_PRIVATE_KEY is not set/.test(l), "tower log names exactly what is missing");
  for (const [n, port] of [["school", PORTS.bareSchool], ["tower", PORTS.bareCloud]]) {
    const h = await http(port, "/api/health");
    ok(h.status === 503 && h.json?.code === "SERVER_MISCONFIGURED" && h.json?.checks?.config === "fail", `${n}: /api/health → 503 SERVER_MISCONFIGURED (not a false 200, not an empty 500)`);
    ok(!JSON.stringify(h.json).match(/DATABASE_URL|ENCRYPTION|SIGNING/), `${n}: health does not reveal setting names`);
  }
  let r = await http(PORTS.bareSchool, "/api/setup/status");
  ok(r.status === 503 && r.json?.error?.code === "SERVER_MISCONFIGURED" && !!r.json.error.requestId, `school /api/setup/status → structured 503 with a reference (was an empty 500) — "${r.json?.error?.message?.slice(0, 60)}…"`);
  r = await http(PORTS.bareSchool, "/api/auth/login", { method: "POST", body: { username: "a", password: "b" } });
  ok(r.status === 503 && r.json?.error?.code === "SERVER_MISCONFIGURED", "school login → structured 503 (the browser can now say WHY, not 'Something went wrong')");
  r = await http(PORTS.bareSchool, "/api/setup", { method: "POST", body: { schoolName: "X", admin: { username: "owner.admin", password: "Sup3r-secret-Adm1n", firstName: "A", lastName: "B" } } });
  ok(r.status === 503 && r.json?.error?.code === "SERVER_MISCONFIGURED", "school setup → structured 503");
  r = await http(PORTS.bareCloud, "/api/ops/me");
  ok(r.status === 503 && r.json?.error?.code === "SERVER_MISCONFIGURED" && !!r.json.error.requestId, "tower /api/ops/me → structured 503 (was a raw 500 shown as \"Can't reach the Control Tower\")");
  ok(/"requestId":"[0-9a-f-]{36}"/.test(logs("ssv-bare-school")), "server log lines carry a request id (the same one the user is shown as \"Reference\")");
  for (let i = 0; i < 30; i++) await http(PORTS.bareSchool, "/api/setup/status");
  const errorLines = logs("ssv-bare-school").split("\n").filter((x) => x.startsWith('{"level":"error"')).length;
  ok(errorLines >= 1 && errorLines <= 4, `30 more requests to the broken server did not flood its log (${errorLines} error line(s) in total)`);
  const hs = await waitFor(() => health("ssv-bare-school") === "unhealthy" && "unhealthy", 60, 2000);
  ok(hs === "unhealthy", "Docker marks the misconfigured container UNHEALTHY (it is not 'running fine')");
  tryDocker("rm", "-f", "ssv-bare-school", "ssv-bare-cloud");

  // ───────────────────────────────────────────────────────────────────────────────────────────────
  section("B. the correct plain-`docker run` recipe: user-defined network + PostgreSQL + school + worker + tower");
  docker("network", "create", "ssv-net");
  const pw = randomBytes(12).toString("hex");
  docker("run", "-d", "--name", "ssv-pg", "--network", "ssv-net", "-e", `POSTGRES_PASSWORD=${pw}`, "postgres:18");
  ok(!!(await waitFor(() => tryDocker("exec", "ssv-pg", "pg_isready", "-U", "postgres").status === 0, 60, 2000)), "PostgreSQL container is ready");
  const schoolEnv = ["-e", `DATABASE_URL=postgresql://postgres:${pw}@ssv-pg:5432/smartschool_school`, "-e", `APP_ENCRYPTION_KEY=${b64()}`, "-e", `APP_SIGNING_SECRET=${b64()}`];
  const towerKeys = execFileSync("node", ["-e", `const c=require("node:crypto");const{publicKey:p,privateKey:k}=c.generateKeyPairSync("ed25519");const b=(x,t)=>Buffer.from(x.export({type:t,format:"pem"})).toString("base64");console.log(b(k,"pkcs8")+" "+b(p,"spki"))`], { encoding: "utf8" }).trim().split(" ");
  const towerEnv = ["-e", `CLOUD_DATABASE_URL=postgresql://postgres:${pw}@ssv-pg:5432/smartschool_cloud`, "-e", `CLOUD_ENCRYPTION_KEY=${b64()}`, "-e", `CLOUD_SIGNING_PRIVATE_KEY=${towerKeys[0]}`, "-e", `CLOUD_SIGNING_PUBLIC_KEY=${towerKeys[1]}`];
  docker("run", "-d", "--name", "ssv-tower", "--network", "ssv-net", ...runOpts, "-p", `${PORTS.tower}:3000`, ...towerEnv, CLOUD);
  docker("run", "-d", "--name", "ssv-school", "--network", "ssv-net", ...runOpts, "-p", `${PORTS.school}:3000`, ...schoolEnv, "-e", `CLOUD_PUBLIC_KEY=${towerKeys[1]}`, SCHOOL);
  ok(!!(await waitFor(() => health("ssv-school") === "healthy" && health("ssv-tower") === "healthy", 240, 3000)), "school and tower both become HEALTHY (database created, migrated, schema verified)");
  l = logs("ssv-school");
  ok(/created the missing database/.test(l) && /migrations are up to date/.test(l), "preflight created the missing database and applied the migrations");
  ok(!l.includes(pw), "the database password appears nowhere in the school log");
  // the worker must share the school's secrets: the SAME values (schoolEnv is generated once)
  docker("run", "-d", "--name", "ssv-worker", "--network", "ssv-net", "--health-start-period=5s", "--health-interval=5s", "--health-retries=3", "--health-cmd", "node_modules/.bin/tsx scripts/worker-health.ts", ...schoolEnv, "-e", "WORKER_NAME=ssv-worker", SCHOOL, "node_modules/.bin/tsx", "src/workers/main.ts");
  ok(!!(await waitFor(() => health("ssv-worker") === "healthy", 120, 3000)), "worker container is HEALTHY (its heartbeat is fresh — proven by the health check, not assumed)");

  section("B1. setup → login → session → protected route → logout (browser-equivalent, over the published port)");
  let s = await http(PORTS.school, "/api/health"); ok(s.status === 200 && s.json.checks.schema === "ok", "school /api/health → 200 with config/database/schema all ok");
  s = await http(PORTS.school, "/api/setup/status"); ok(s.json?.data?.needsSetup === true, "fresh database reports needsSetup");
  s = await http(PORTS.school, "/api/setup", { method: "POST", body: { schoolName: "Container College", city: "Enugu", admin: { username: "owner.admin", password: "Sup3r-secret-Adm1n", firstName: "Ada", lastName: "Obi" } } });
  ok(s.status === 200 && !!s.json?.data?.installationCode, `Primary Admin setup completes (${s.status} ${s.json?.data?.installationCode ?? s.json?.error?.message})`);
  s = await http(PORTS.school, "/api/setup/status"); ok(s.json?.data?.needsSetup === false, "setup state persisted");
  s = await http(PORTS.school, "/api/setup", { method: "POST", body: { schoolName: "Again", admin: { username: "hacker", password: "Sup3r-secret-Adm1n", firstName: "A", lastName: "B" } } });
  ok(s.status === 409, "setup cannot be run a second time (409)");
  s = await http(PORTS.school, "/api/auth/login", { method: "POST", body: { username: "owner.admin", password: "wrong-password-1" } });
  ok(s.status === 401 && !s.setCookie, "wrong password → 401 with no session cookie");
  s = await http(PORTS.school, "/api/auth/login", { method: "POST", body: { username: "owner.admin", password: "Sup3r-secret-Adm1n" } });
  const cookie = (s.setCookie.match(/ss_session=[^;]+/) ?? [""])[0];
  ok(s.status === 200 && !!cookie && /HttpOnly/.test(s.setCookie) && /SameSite=Lax/.test(s.setCookie) && !/Secure/i.test(s.setCookie), "valid login → session cookie (HttpOnly, SameSite=Lax, not Secure on plain HTTP so the browser keeps it)");
  s = await http(PORTS.school, "/api/auth/me", { cookie });
  ok(s.status === 200 && s.json.data.user.isPrimaryAdmin === true && s.json.data.permissions.includes("finance.reverse_payment"), "session recognised: Primary Admin with full permissions");
  s = await http(PORTS.school, "/api/students", { cookie }); ok(s.status === 200, "protected route works with the session");
  s = await http(PORTS.school, "/api/students"); ok(s.status === 401, "same route without a session → 401");
  s = await http(PORTS.school, "/api/auth/logout", { method: "POST", cookie, body: {} }); ok(s.status === 200, "logout");
  s = await http(PORTS.school, "/api/auth/me", { cookie }); ok(s.status === 401, "session is dead after logout");
  const page = await fetch(`http://127.0.0.1:${PORTS.school}/setup`); ok(page.status === 307 || page.status === 200, `the /setup page itself loads (${page.status})`);

  section("B1b. the other authentication flows, in the container: first-login password change, session revocation, RBAC");
  s = await http(PORTS.school, "/api/auth/login", { method: "POST", body: { username: "owner.admin", password: "Sup3r-secret-Adm1n" } });
  const adminCk = (s.setCookie.match(/ss_session=[^;]+/) ?? [""])[0];
  s = await http(PORTS.school, "/api/teachers", { method: "POST", cookie: adminCk, body: { firstName: "Emeka", lastName: "Nwosu" } });
  const tUser = s.json?.data?.username, tTemp = s.json?.data?.initialPassword;
  ok(s.status < 300 && !!tUser && !!tTemp, "administrator creates a teacher with a one-time temporary password");
  s = await http(PORTS.school, "/api/auth/login", { method: "POST", body: { username: tUser, password: tTemp } });
  const tCk = (s.setCookie.match(/ss_session=[^;]+/) ?? [""])[0];
  ok(s.status === 200 && s.json?.data?.mustChangePassword === true, "teacher can sign in with the temporary password, and is told to change it");
  s = await http(PORTS.school, "/api/students", { cookie: tCk }); ok(s.status === 403 && s.json?.error?.code === "PASSWORD_CHANGE_REQUIRED", "until then EVERYTHING else is blocked (PASSWORD_CHANGE_REQUIRED)");
  s = await http(PORTS.school, "/api/auth/change-password", { method: "POST", cookie: tCk, body: { currentPassword: tTemp, newPassword: "short" } }); ok(s.status === 422, "a weak new password is refused");
  s = await http(PORTS.school, "/api/auth/change-password", { method: "POST", cookie: tCk, body: { currentPassword: tTemp, newPassword: "Brand-new-pass-9" } }); ok(s.status === 200, "a strong new password is accepted");
  s = await http(PORTS.school, "/api/auth/me", { cookie: tCk }); ok(s.status === 401, "every old session was revoked by the change");
  s = await http(PORTS.school, "/api/auth/login", { method: "POST", body: { username: tUser, password: tTemp } }); ok(s.status === 401, "the temporary password no longer works");
  s = await http(PORTS.school, "/api/auth/login", { method: "POST", body: { username: tUser, password: "Brand-new-pass-9" } });
  const tCk2 = (s.setCookie.match(/ss_session=[^;]+/) ?? [""])[0];
  ok(s.status === 200 && !s.json.data.mustChangePassword, "the teacher signs in with the new password");
  s = await http(PORTS.school, "/api/users", { cookie: tCk2 }); ok(s.status === 403, "RBAC enforced by the server: a teacher cannot list users");
  s = await http(PORTS.school, "/api/backup", { cookie: tCk2 }); ok(s.status === 403, "…or see backups");
  s = await http(PORTS.school, "/api/students", { cookie: tCk2 }); ok(s.status === 200, "…but can use what a teacher is allowed to");
  for (let i = 0; i < 5; i++) await http(PORTS.school, "/api/auth/login", { method: "POST", body: { username: tUser, password: "not-the-password-" + i } });
  s = await http(PORTS.school, "/api/auth/login", { method: "POST", body: { username: tUser, password: "Brand-new-pass-9" } });
  ok(s.status === 429, "five wrong passwords lock the account (429) even for the right password");
  const store = tryDocker("exec", "ssv-school", "sh", "-c", "echo $STORAGE_DIR; ls /data").stdout;
  ok(/\/data\/storage/.test(store), "uploads/backups default to /data (a volume), not the container's disposable layer");

  section("B2. the worker in its container does real work");
  s = await http(PORTS.school, "/api/auth/login", { method: "POST", body: { username: "owner.admin", password: "Sup3r-secret-Adm1n" } });
  const ck = (s.setCookie.match(/ss_session=[^;]+/) ?? [""])[0];
  s = await http(PORTS.school, "/api/reports", { method: "POST", cookie: ck, body: { kind: "STUDENT_LIST", format: "CSV", params: {} } });
  const rid = s.json?.data?.id;
  const st = await waitFor(async () => { const x = (await http(PORTS.school, `/api/reports/${rid}`, { cookie: ck })).json?.data?.status; return x === "SUCCEEDED" || x === "FAILED" ? x : null; }, 60, 1500);
  ok(st === "SUCCEEDED", `a report requested through the web container is produced by the worker container (${st})`);

  section("B3. Control Tower: sign-in, and the school registers with it CONTAINER-TO-CONTAINER by name");
  await sleep(1000);
  const tw = await http(PORTS.tower, "/api/health"); ok(tw.status === 200 && tw.json.checks.schema === "ok", "tower /api/health → 200 (config, database, schema)");
  execFileSync("docker", ["exec", "ssv-tower", "node_modules/.bin/tsx", "scripts/create-operator.ts", "root@tower.test", "Tower Root", "tower-root-password-1", "SUPER_ADMIN"], { stdio: "pipe" });
  let t = await http(PORTS.tower, "/api/ops/login", { method: "POST", body: { email: "root@tower.test", password: "wrong-password-xx" } }); ok(t.status === 401, "tower: wrong password → 401");
  t = await http(PORTS.tower, "/api/ops/login", { method: "POST", body: { email: "root@tower.test", password: "tower-root-password-1" } });
  const tc = (t.setCookie.match(/ss_cloud_session=[^;]+/) ?? [""])[0];
  ok(t.status === 200 && !!tc && /HttpOnly/.test(t.setCookie) && /SameSite=Strict/.test(t.setCookie) && !/Secure/i.test(t.setCookie), "tower: sign-in works over plain HTTP and sets a usable session cookie");
  t = await http(PORTS.tower, "/api/ops/me", { cookie: tc }); ok(t.status === 200 && t.json.data.role === "SUPER_ADMIN", "tower: protected API works with the session");
  t = await http(PORTS.tower, "/api/ops/installations"); ok(t.status === 401, "tower: protected API without a session → 401");
  t = await http(PORTS.tower, "/api/ops/installations", { method: "POST", cookie: tc, body: { schoolName: "Container College" } });
  const token = t.json?.data?.registrationToken; ok(!!token, "tower issues a one-time registration token");
  s = await http(PORTS.school, "/api/sync/register", { method: "POST", cookie: ck, body: { cloudUrl: "http://ssv-tower:3000", registrationToken: token } });
  ok(s.status === 200, `school container → tower container via its NAME on the shared network (${s.status} ${s.json?.data?.installationCode ?? s.json?.error?.message})`);
  s = await http(PORTS.school, "/api/sync/now", { method: "POST", cookie: ck, body: {} }); ok(s.json?.data?.heartbeat?.ok === true, "heartbeat accepted");
  t = await http(PORTS.tower, "/api/ops/installations", { cookie: tc });
  ok(t.json?.data?.some((i) => i.status === "ACTIVE" && i.lastHeartbeatAt), "tower lists the school as ACTIVE with a heartbeat");
  s = await http(PORTS.school, "/api/sync/status", { cookie: ck }); ok(s.json?.data?.license?.status === "ACTIVE", "school holds a verified, tower-signed licence");
  // and the wrong way round: tower → school is NOT needed by the architecture (the school always calls out), so it is deliberately not tested

  // ───────────────────────────────────────────────────────────────────────────────────────────────
  section("C. Docker's DEFAULT bridge network: containers cannot find each other by name");
  docker("run", "-d", "--name", "ssv-bridge", ...runOpts, "-p", `${PORTS.bridge}:3000`, "-e", `DATABASE_URL=postgresql://postgres:x@ssv-pg:5432/smartschool_school`, "-e", `APP_ENCRYPTION_KEY=${b64()}`, "-e", `APP_SIGNING_SECRET=${b64()}`, "-e", "WAIT_FOR_DB_SECONDS=15", SCHOOL);
  ok(!!(await reachable(PORTS.bridge)), "school container starts anyway (degraded), so the browser can be told what is wrong");
  ok(!!(await waitFor(() => /does not resolve from inside this container/.test(logs("ssv-bridge")) && /DEFAULT bridge network/.test(logs("ssv-bridge")), 60, 2000)), "log explains that the hostname does not resolve and that the default bridge has no name resolution");
  s = await http(PORTS.bridge, "/api/health"); ok(s.status === 503 && ["DATABASE_UNAVAILABLE"].includes(s.json?.code), `health → 503 ${s.json?.code}`);
  s = await http(PORTS.bridge, "/api/auth/login", { method: "POST", body: { username: "a", password: "b" } }); ok(s.status === 503 && s.json?.error?.code === "DATABASE_UNAVAILABLE", "login → structured 503 DATABASE_UNAVAILABLE (says the database can't be reached, not 'Something went wrong')");
  tryDocker("rm", "-f", "ssv-bridge");

  section("D. database reachable but NOT migrated (AUTO_MIGRATE=false), then fixed WITHOUT restarting the app");
  docker("run", "-d", "--name", "ssv-unmigrated", "--network", "ssv-net", ...runOpts, "-p", `${PORTS.unmigrated}:3000`, "-e", `DATABASE_URL=postgresql://postgres:${pw}@ssv-pg:5432/smartschool_empty`, "-e", `APP_ENCRYPTION_KEY=${b64()}`, "-e", `APP_SIGNING_SECRET=${b64()}`, "-e", "AUTO_MIGRATE=false", SCHOOL);
  ok(!!(await reachable(PORTS.unmigrated)), "container starts");
  s = await http(PORTS.unmigrated, "/api/health"); ok(s.status === 503 && s.json?.code === "DATABASE_NOT_MIGRATED" && s.json.checks.database === "ok" && s.json.checks.schema === "fail", "health → 503 DATABASE_NOT_MIGRATED (database fine, schema missing)");
  s = await http(PORTS.unmigrated, "/api/setup/status"); ok(s.status === 503 && s.json?.error?.code === "DATABASE_NOT_MIGRATED", "setup/status → structured 503 DATABASE_NOT_MIGRATED (the exact 'setup fails' symptom, now explained)");
  ok(!!(await waitFor(() => health("ssv-unmigrated") === "unhealthy", 60, 2000)), "Docker reports it unhealthy");
  execFileSync("docker", ["exec", "ssv-unmigrated", "node_modules/.bin/prisma", "migrate", "deploy"], { stdio: "pipe" });
  ok(!!(await waitFor(async () => (await http(PORTS.unmigrated, "/api/health")).status === 200, 30, 2000)), "after `prisma migrate deploy` the SAME container turns healthy by itself (no restart)");
  s = await http(PORTS.unmigrated, "/api/setup/status"); ok(s.status === 200 && s.json.data.needsSetup === true, "and setup is available");

  section("E. runs with NO internet at all (a school server that is offline)");
  const off = tryDocker("run", "--rm", "--network", "none", SCHOOL, "pnpm", "--version");
  ok(off.status === 0 && /^\d+\.\d+\.\d+/.test(off.stdout.trim()), `pnpm is already inside the image — starts without downloading anything (pnpm ${off.stdout.trim() || off.stderr.slice(0, 80)})`);
} catch (e) {
  failed++; console.log(`FAIL  unexpected error: ${String(e.message).slice(0, 400)}`);
} finally {
  cleanup();
}
console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(failed ? 1 : 0);
