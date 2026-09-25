import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@cloud": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { environment: "node", include: ["tests/**/*.test.ts"], globalSetup: ["./tests/global-setup.ts"], setupFiles: ["./tests/setup-env.ts"], fileParallelism: false, testTimeout: 30_000, hookTimeout: 60_000 },
});
