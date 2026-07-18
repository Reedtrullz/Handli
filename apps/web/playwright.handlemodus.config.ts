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
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        // Browser-context certificate bypass does not cover Chromium's
        // service-worker process. The certificate is ephemeral and the test
        // CSP is same-origin-only; this launch flag is scoped to this local
        // harness so the exact production headers can remain enabled.
        launchOptions: { args: ["--ignore-certificate-errors"] },
      },
    },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  use: {
    baseURL: "https://127.0.0.1:3115",
    ignoreHTTPSErrors: true,
    locale: "nb-NO",
    screenshot: "off",
    serviceWorkers: "allow",
    timezoneId: "Europe/Oslo",
    trace: "off",
    video: "off",
  },
  webServer: {
    command: "node tests/handlemodus/start-production-server.mjs",
    env: {
      HANDLEPLAN_HANDLEMODUS_PARENT_POISON: "handleplan-handlemodus-parent-env-poison-v1",
      KASSAL_API_KEY: "handleplan-handlemodus-parent-env-poison-v1",
    },
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 120_000,
    url: "https://127.0.0.1:3115/planlegg/handle",
  },
});
