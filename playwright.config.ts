import { defineConfig } from "@playwright/test";
import { randomBytes } from "node:crypto";

const leakSentinel = `handleplan-e2e-${randomBytes(24).toString("hex")}`;
process.env.HANDLEPLAN_E2E_SENTINEL = leakSentinel;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: "line",
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  use: {
    baseURL: "http://127.0.0.1:3109",
    locale: "nb-NO",
    screenshot: "off",
    timezoneId: "Europe/Oslo",
    trace: "off",
    video: "off",
  },
  webServer: {
    command: "corepack pnpm --filter web exec next dev --hostname 127.0.0.1 --port 3109",
    env: {
      HANDLEPLAN_MODE: "fake",
      KASSAL_API_KEY: leakSentinel,
    },
    url: "http://127.0.0.1:3109/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
