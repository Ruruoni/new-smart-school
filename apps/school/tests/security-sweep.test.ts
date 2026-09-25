import { beforeAll, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { handle, routes } from "@/api/index";
import { resetLoginThrottle } from "@/platform/auth/service";
import { ADMIN, installTestSchool, makeUser, resetDb } from "./helpers";

/**
 * Whole-surface security sweeps. Unlike the per-feature tests these run EVERY route in the API table, so a new
 * endpoint that forgets its guard, or that crashes on hostile input, fails here without anyone remembering to test it.
 */
async function call(path: string, opts: { method?: string; cookie?: string; body?: unknown; raw?: string } = {}) {
  const headers = new Headers({ host: "school.local", origin: "http://school.local" });
  if (opts.cookie) headers.set("cookie", opts.cookie);
  let body: BodyInit | undefined;
  if (opts.raw !== undefined) { headers.set("content-type", "application/json"); body = opts.raw; }
  else if (opts.body !== undefined) { headers.set("content-type", "application/json"); body = JSON.stringify(opts.body); }
  const [p, qs] = path.split("?");
  const r = await handle(new Request(`http://school.local/api${p}${qs ? `?${qs}` : ""}`, { method: opts.method ?? "GET", headers, body }), p!.split("/").filter(Boolean));
  let json: any = null;
  if ((r.headers.get("content-type") ?? "").includes("json")) json = await r.json(); else await r.arrayBuffer();
  return { status: r.status, json, headers: r.headers };
}
async function cookieFor(username: string, password: string) {
  const r = await call("/auth/login", { method: "POST", body: { username, password } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return /ss_session=[^;]+/.exec(r.headers.get("set-cookie")!)![0];
}
const ID = "00000000-0000-4000-8000-000000000001";
const fill = (p: string, v = ID) => p.replace(/:([a-zA-Z]+)/g, v);
const protectedRoutes = () => routes.filter((r) => r.guard !== "public");

beforeAll(async () => {
  await rm("./.data/test-storage", { recursive: true, force: true });
  await resetDb();
  resetLoginThrottle();
  await installTestSchool();
});

describe("least privilege", () => {
  it("a signed-in user who has been given NO role can use only a short, reviewed list of routes", async () => {
    await makeUser({ username: "nobody", roles: [] });
    const cookie = await cookieFor("nobody", "Passw0rd-test");
    const allowed: string[] = [];
    for (const r of protectedRoutes().filter((x) => x.path !== "/auth/logout")) { // logout would end the session mid-sweep
      const out = await call(fill(r.path), { method: r.method, cookie, ...(r.method === "GET" ? {} : { body: {} }) });
      if (out.status !== 403) allowed.push(`${r.method} ${r.path} → ${out.status}`);
      expect(out.status, `${r.method} ${r.path}`).toBeLessThan(500);
    }
    // Everything a role-less user may touch is about THEMSELVES (session, notifications, own files) — never school data.
    expect(allowed.sort()).toEqual([
      "GET /academics/current → 200", // the current year/term name: needed by every page header, not sensitive
      "GET /auth/me → 200",
      "GET /files/:id → 404",
      "GET /notifications → 200",
      "GET /roles/mine → 200",
      "POST /auth/change-password → 422",
      "POST /notifications/read → 422",
    ].sort());
    expect((await call("/auth/logout", { method: "POST", cookie, body: {} })).status).toBe(200);
  }, 180_000);

  it("a teacher, parent and student each get 403 (never data) on administrative endpoints", async () => {
    await makeUser({ username: "teach", roles: ["teacher"] });
    await makeUser({ username: "parent1", type: "PARENT", roles: ["parent"] });
    await makeUser({ username: "stud1", type: "STUDENT", roles: ["student"] });
    const adminOnly = ["/admin/users", "/users", "/roles", "/audit", "/backup", "/sync/status", "/settings/school", "/finance/ledger", "/imports"];
    for (const u of ["teach", "parent1", "stud1"]) {
      const cookie = await cookieFor(u, "Passw0rd-test");
      for (const p of adminOnly) {
        const out = await call(p, { cookie });
        expect([401, 403, 404], `${u} ${p} → ${out.status}`).toContain(out.status);
      }
    }
  });
});

describe("hostile input never crashes the server", () => {
  const BODIES: [string, { body?: unknown; raw?: string }][] = [
    ["empty object", { body: {} }],
    ["array", { body: [] }],
    ["null", { raw: "null" }],
    ["not JSON", { raw: "{oops" }],
    ["wrong types", { body: { id: 123, name: { $ne: 1 }, amount: "abc", items: "x", date: {}, email: [] } }],
    ["prototype pollution", { raw: '{"__proto__":{"isPrimaryAdmin":true},"constructor":{"prototype":{"x":1}}}' }],
    ["huge strings", { body: { name: "A".repeat(200_000), note: "B".repeat(200_000) } }],
    ["control characters", { body: { name: "\u0000\u0007‮", q: "%00" } }],
  ];
  const SKIP = new Set(["POST /auth/logout", "POST /backup/run", "POST /backup/:id/restore"]); // intentionally destructive / long-running

  it("every mutating route answers hostile bodies with a 4xx — never a 5xx", async () => {
    const cookie = await cookieFor(ADMIN.username, ADMIN.password);
    const bad: string[] = [];
    for (const r of protectedRoutes().filter((x) => x.method !== "GET" && !SKIP.has(`${x.method} ${x.path}`))) {
      for (const [label, b] of BODIES) {
        const out = await call(fill(r.path), { method: r.method, cookie, ...b });
        if (out.status >= 500) bad.push(`${r.method} ${r.path} [${label}] → ${out.status} ${out.json?.error?.code ?? ""}`);
      }
    }
    expect([...new Set(bad.map((b) => b.replace(/ \[.*?\]/, "").replace(/ id=\S+ q=\S*/, "")))]).toEqual([]);
    // the Primary Admin flag can't be smuggled in through a request body
    expect(await (await import("@/platform/db")).db.user.count({ where: { isPrimaryAdmin: true } })).toBe(1);
  }, 600_000);

  it("every read route survives malformed ids, extreme paging and injection-shaped queries", async () => {
    const cookie = await cookieFor(ADMIN.username, ADMIN.password);
    const bad: string[] = [];
    const queries = ["", "?page=-1&pageSize=999999", "?q=%27%20OR%201%3D1--", "?q=%00&sort=;DROP%20TABLE%20users", "?classId=not-a-uuid&termId=%7B%7D&from=abc&to=9999-99-99"];
    for (const r of protectedRoutes().filter((x) => x.method === "GET")) {
      for (const id of [ID, "not-a-uuid", "%27%3B--"]) for (const q of queries) {
        const out = await call(fill(r.path, id) + q, { cookie });
        if (out.status >= 500) bad.push(`GET ${r.path} id=${id} q=${q} → ${out.status} ${out.json?.error?.code ?? ""}`);
      }
    }
    expect([...new Set(bad.map((b) => b.replace(/ id=\S+ q=\S* /, " ")))]).toEqual([]);
  }, 600_000);
});
