import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/task8",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:3108",
    browserName: "chromium",
    locale: "nb-NO",
    timezoneId: "Europe/Oslo",
    trace: "off",
  },
  webServer: {
    command: "pnpm exec next dev --hostname 127.0.0.1 --port 3108",
    url: "http://127.0.0.1:3108/planlegg/resultat",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
