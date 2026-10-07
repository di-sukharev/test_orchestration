import { defineConfig } from "@playwright/test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
mkdirSync("work", { recursive: true });
const databaseDir = mkdtempSync(resolve("work/e2e-"));
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:4317",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun run start",
    url: "http://127.0.0.1:4317/api/health",
    reuseExistingServer: false,
    env: {
      NODE_ENV: "test",
      PORT: "4317",
      APP_ORIGIN: "http://127.0.0.1:4317",
      DATABASE_PATH: resolve(databaseDir, "app.sqlite"),
      AUTH_RATE_LIMIT_MAX: "10000",
    },
  },
});
