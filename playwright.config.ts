import { defineConfig } from "@playwright/test";
import { randomBytes } from "node:crypto";

const leakSentinel = `handleplan-e2e-${randomBytes(24).toString("hex")}`;
process.env.HANDLEPLAN_E2E_SENTINEL = leakSentinel;

export default defineConfig({
  globalTeardown: "./tests/e2e/verify-public-harness.mjs",
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
    baseURL: "https://127.0.0.1:3109",
    ignoreHTTPSErrors: true,
    locale: "nb-NO",
    screenshot: "off",
    // Public UI and accessibility tests use deterministic page routes. The
    // separate production Handlemodus matrix keeps service workers enabled
    // and proves install, cache, offline navigation, and recovery per engine.
    serviceWorkers: "block",
    timezoneId: "Europe/Oslo",
    trace: "off",
    video: "off",
  },
  webServer: {
    // Replace Playwright's shell so its shutdown signal reaches the wrapper
    // instead of orphaning Next and the ephemeral certificate directory.
    command: "exec node tests/e2e/start-https-server.mjs",
    env: {
      HANDLEPLAN_E2E_FAKE_PRODUCTION_TOKEN: leakSentinel,
      HANDLEPLAN_E2E_PUBLIC_ORIGIN: "https://127.0.0.1:3109",
      HANDLEPLAN_E2E_SENTINEL: leakSentinel,
      HANDLEPLAN_MODE: "fake",
      KASSAL_API_KEY: leakSentinel,
    },
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    ignoreHTTPSErrors: true,
    // Readiness constructs the bound fake container; health alone would not
    // prove that the production-only loopback gate is valid.
    url: "https://127.0.0.1:3109/api/ready",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
