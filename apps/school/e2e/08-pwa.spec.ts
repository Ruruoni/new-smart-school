import { expect, test } from "@playwright/test";
import { ADMIN } from "./env";
import { seedSchool } from "./seed";
import { login } from "./helpers";

test.beforeAll(async () => { await seedSchool(); });

test("the app is installable: a full icon set that really resolves, and a manifest that names it", async ({ request }) => {
  const m = await (await request.get("/manifest.webmanifest")).json();
  expect(m).toMatchObject({ name: "SmartSchool", display: "standalone", start_url: "/", scope: "/" });
  const has = (size: string, purpose: string) => m.icons.some((i: any) => i.sizes === size && i.purpose === purpose && i.type === "image/png");
  expect(has("192x192", "any")).toBe(true);
  expect(has("512x512", "any")).toBe(true);
  expect(has("512x512", "maskable")).toBe(true);
  for (const icon of m.icons.filter((i: any) => i.type === "image/png")) {
    const r = await request.get(icon.src);
    expect(r.status(), icon.src).toBe(200);
    const b = await r.body();
    expect(b.subarray(1, 4).toString(), icon.src).toBe("PNG");
    expect(b.readUInt32BE(16), `${icon.src} width`).toBe(Number(icon.sizes.split("x")[0])); // the file really is the size the manifest promises
  }
});

test("the service worker is versioned per build, is always revalidated, and never caches private API data", async ({ request, page }) => {
  const a = await request.get("/sw.js");
  expect(a.status()).toBe(200);
  expect(a.headers()["content-type"]).toContain("javascript");
  expect(a.headers()["cache-control"]).toContain("no-store");
  expect(a.headers()["service-worker-allowed"]).toBe("/");
  const src = await a.text();
  const build = /const VERSION = "ss-" \+ "(\d{14})"/.exec(src)?.[1];
  expect(build, "the cache version must carry the build id").toBeTruthy();
  expect(await (await request.get("/sw.js")).text()).toBe(src); // stable within a build
  expect(src).toContain('url.pathname.startsWith("/api/")'); // API requests bypass the worker entirely

  // in a real browser: it registers, takes control, and its caches are named for THIS build
  await login(page, ADMIN.username, ADMIN.password);
  await page.goto("/dashboard");
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, undefined, { timeout: 15_000 });
  const names: string[] = await page.evaluate(async () => caches.keys());
  expect(names.length).toBeGreaterThan(0);
  expect(names.every((n) => n.startsWith(`ss-${build}`))).toBe(true);
  // nothing private was stored: no /api response is in any cache
  const apiCached = await page.evaluate(async () => { for (const n of await caches.keys()) for (const r of await (await caches.open(n)).keys()) if (new URL(r.url).pathname.startsWith("/api/")) return r.url; return null; });
  expect(apiCached).toBeNull();
});
