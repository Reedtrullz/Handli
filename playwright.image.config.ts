import { randomBytes } from "node:crypto";

import { defineConfig } from "@playwright/test";

const controlToken = process.env.HANDLEPLAN_IMAGE_E2E_CONTROL_TOKEN
  ?? `handleplan-image-control-${randomBytes(24).toString("hex")}`;
const responseCanary = process.env.HANDLEPLAN_IMAGE_E2E_RESPONSE_CANARY
  ?? `handleplan-image-canary-${randomBytes(24).toString("hex")}`;
const databaseRoleEnvironment = Object.fromEntries([
  "HANDLEPLAN_IMAGE_DATABASE_URL",
  "HANDLEPLAN_IMAGE_SEED_APP_DATABASE_URL",
  "HANDLEPLAN_IMAGE_SEED_DATABASE_URL",
  "HANDLEPLAN_IMAGE_SEED_REVIEW_DATABASE_URL",
].map((name) => [name, process.env[name] ?? ""]));

// Only the host-side response-scanning launcher receives the four database role
// URLs. Playwright workers (and therefore browser test code) inherit the
// sanitized environment; the launcher passes only the web role into the image.
for (const name of Object.keys(databaseRoleEnvironment)) delete process.env[name];
process.env.HANDLEPLAN_IMAGE_E2E_CONTROL_TOKEN = controlToken;
process.env.HANDLEPLAN_IMAGE_E2E_RESPONSE_CANARY = responseCanary;

export default defineConfig({
  testDir: "./tests/image-e2e",
  globalTeardown: "./tests/image-e2e/verify-production-image-harness.mjs",
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
        launchOptions: { args: ["--ignore-certificate-errors"] },
      },
    },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  use: {
    baseURL: "https://127.0.0.1:3121",
    ignoreHTTPSErrors: true,
    locale: "nb-NO",
    screenshot: "off",
    serviceWorkers: "allow",
    timezoneId: "Europe/Oslo",
    trace: "off",
    video: "off",
  },
  webServer: {
    command: "exec node tests/image-e2e/start-production-image.mjs",
    env: {
      ...process.env,
      ...databaseRoleEnvironment,
      HANDLEPLAN_IMAGE_E2E_CONTROL_TOKEN: controlToken,
      HANDLEPLAN_IMAGE_E2E_RESPONSE_CANARY: responseCanary,
    },
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 180_000,
    url: "https://127.0.0.1:3121/api/ready",
  },
});
