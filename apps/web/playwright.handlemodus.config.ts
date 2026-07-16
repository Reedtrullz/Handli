import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/handlemodus",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: "line",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: "http://127.0.0.1:3115",
    browserName: "chromium",
    locale: "nb-NO",
    serviceWorkers: "allow",
    timezoneId: "Europe/Oslo",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node tests/handlemodus/start-production-server.mjs",
    reuseExistingServer: false,
    timeout: 120_000,
    url: "http://127.0.0.1:3115/planlegg/handle",
  },
});
