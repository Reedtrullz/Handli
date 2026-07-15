import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:3109",
    browserName: "chromium",
    locale: "nb-NO",
    timezoneId: "Europe/Oslo",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "KASSAL_MODE=fake pnpm --filter web exec next dev --hostname 127.0.0.1 --port 3109",
    url: "http://127.0.0.1:3109/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
