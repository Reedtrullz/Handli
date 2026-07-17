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
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  use: {
    baseURL: "http://127.0.0.1:3115",
    locale: "nb-NO",
    screenshot: "off",
    serviceWorkers: "allow",
    timezoneId: "Europe/Oslo",
    trace: "off",
    video: "off",
  },
  webServer: {
    command: "node tests/handlemodus/start-production-server.mjs",
    reuseExistingServer: false,
    timeout: 120_000,
    url: "http://127.0.0.1:3115/planlegg/handle",
  },
});
