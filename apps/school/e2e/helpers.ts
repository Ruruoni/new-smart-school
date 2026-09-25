import { expect, type APIRequestContext, type Page, request } from "@playwright/test";
import { ADMIN, BASE_URL } from "./env";

/** Fill and submit the real sign-in form (does not wait for the outcome). */
export async function tryLogin(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** Sign in through the real form and wait until the app has taken us past the login screen. */
export async function login(page: Page, username: string, password: string) {
  await tryLogin(page, username, password);
  await page.waitForURL((u) => !/\/(login|setup)/.test(u.pathname));
}

/** An API client with its own session cookie (for fast, deterministic data set-up; the behaviour under test still goes through the UI). */
export async function apiAs(username: string, password: string): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { origin: BASE_URL } });
  const r = await ctx.post("/api/auth/login", { data: { username, password } });
  expect(r.ok(), await r.text()).toBeTruthy();
  return ctx;
}
export const adminApi = () => apiAs(ADMIN.username, ADMIN.password);

export async function post<T = any>(api: APIRequestContext, path: string, data: unknown = {}): Promise<T> {
  const r = await api.post(`/api${path}`, { data });
  const body = await r.json();
  expect(r.ok(), `${path}: ${JSON.stringify(body)}`).toBeTruthy();
  return body.data as T;
}
export async function get<T = any>(api: APIRequestContext, path: string): Promise<T> {
  const r = await api.get(`/api${path}`);
  const body = await r.json();
  expect(r.ok(), `${path}: ${JSON.stringify(body)}`).toBeTruthy();
  return body.data as T;
}
export async function put<T = any>(api: APIRequestContext, path: string, data: unknown = {}): Promise<T> {
  const r = await api.put(`/api${path}`, { data });
  const body = await r.json();
  expect(r.ok(), `${path}: ${JSON.stringify(body)}`).toBeTruthy();
  return body.data as T;
}

/** App alerts (Next.js adds its own hidden route-announcer alert, which must be excluded). */
export const alerts = (page: Page) => page.locator("[role=alert]:not(#__next-route-announcer__)");
