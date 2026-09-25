import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@cloud": fileURLToPath(new URL("../cloud/src", import.meta.url)), "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"], // e2e/*.spec.ts belong to Playwright
    globalSetup: ["./tests/global-setup.ts"],
    setupFiles: ["./tests/setup-env.ts"],
    // Integration tests share one Postgres database; run files serially and reset between tests.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
