import { defineConfig, devices } from "@playwright/test";
import { APP_ENV, BASE_URL, CLOUD_DIR, CLOUD_ENV, CLOUD_PORT, CLOUD_URL, E2E_PORT } from "./e2e/env";

/**
 * Real browser tests against the PRODUCTION build (next start) + the worker process + a real PostgreSQL.
 * Run: pnpm build && pnpm e2e     (on a machine without the system libs Chromium needs, see docs/testing.md)
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: { baseURL: BASE_URL, trace: "retain-on-failure", screenshot: "only-on-failure", ...devices["Desktop Chrome"], viewport: { width: 1360, height: 900 } },
  projects: [{ name: "chromium" }],
  webServer: [
    { command: `pnpm exec next start -p ${E2E_PORT} -H 127.0.0.1`, url: `${BASE_URL}/api/health`, timeout: 120_000, reuseExistingServer: false, env: APP_ENV as Record<string, string>, stdout: "ignore", stderr: "pipe" },
    // the developer Control Tower, built separately (pnpm --filter @smartschool/cloud build)
    { command: `pnpm exec next start -p ${CLOUD_PORT} -H 127.0.0.1`, cwd: CLOUD_DIR, url: `${CLOUD_URL}/login`, timeout: 120_000, reuseExistingServer: false, env: CLOUD_ENV as Record<string, string>, stdout: "ignore", stderr: "pipe" },
  ],
});
