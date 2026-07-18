import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import handlemodusPlaywrightConfig from "../playwright.handlemodus.config";
import publicPlaywrightConfig from "../../../playwright.config";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function source(path: string): string {
  return readFileSync(resolve(REPOSITORY_ROOT, path), "utf8");
}

describe("V1 automated accessibility evidence policy", () => {
  it("configures public and offline journeys for all three browser engines without retaining artifacts", () => {
    const configurations = [
      ["playwright.config.ts", publicPlaywrightConfig],
      ["apps/web/playwright.handlemodus.config.ts", handlemodusPlaywrightConfig],
    ] as const;
    for (const [path, configuration] of configurations) {
      const config = source(path);
      expect(configuration.projects?.map((project) => ({
        browserName: project.use?.browserName,
        name: project.name,
      }))).toEqual([
        { browserName: "chromium", name: "chromium" },
        { browserName: "firefox", name: "firefox" },
        { browserName: "webkit", name: "webkit" },
      ]);
      expect(config).toContain('trace: "off"');
      expect(config).toContain('screenshot: "off"');
      expect(config).toContain('video: "off"');
      expect(config).not.toMatch(/retain-on-failure|on-first-retry/u);
    }
  });

  it("separates deterministic public fixtures from production service-worker proof", () => {
    expect(publicPlaywrightConfig.use?.serviceWorkers).toBe("block");
    expect(handlemodusPlaywrightConfig.use?.serviceWorkers).toBe("allow");
    const handlemodusWebServer = Array.isArray(handlemodusPlaywrightConfig.webServer)
      ? undefined
      : handlemodusPlaywrightConfig.webServer;
    expect(handlemodusWebServer?.env?.KASSAL_API_KEY).toBe(
      "handleplan-handlemodus-parent-env-poison-v1",
    );
    expect(source("apps/web/tests/handlemodus/start-production-server.mjs"))
      .toContain("for (const name of Object.keys(process.env)) delete process.env[name]");
    expect(publicPlaywrightConfig.globalTeardown).toBe(
      "./tests/e2e/verify-public-harness.mjs",
    );
    const publicWebServer = Array.isArray(publicPlaywrightConfig.webServer)
      ? undefined
      : publicPlaywrightConfig.webServer;
    expect(publicWebServer).toBeDefined();
    expect(publicWebServer?.url).toBe("https://127.0.0.1:3109/api/ready");

    const environment = publicWebServer?.env;
    expect(environment?.HANDLEPLAN_MODE).toBe("fake");
    expect(environment?.HANDLEPLAN_E2E_PUBLIC_ORIGIN).toBe("https://127.0.0.1:3109");
    expect(environment?.HANDLEPLAN_E2E_SENTINEL).toMatch(/^handleplan-e2e-[0-9a-f]{48}$/u);
    expect(environment?.HANDLEPLAN_E2E_FAKE_PRODUCTION_TOKEN)
      .toBe(environment?.HANDLEPLAN_E2E_SENTINEL);
    expect(environment?.KASSAL_API_KEY).toBe(environment?.HANDLEPLAN_E2E_SENTINEL);
    expect(source("tests/e2e/install-public-fake-capability.mjs")).toContain(
      'Symbol.for("handleplan.e2e.loopback-production-browser-fake-runtime.v1")',
    );
    expect(source("apps/web/package.json")).toContain(
      '"build": "node ../../scripts/e2e/public-build-binding.mjs build"',
    );
    expect(source("tests/e2e/start-https-server.mjs")).not.toContain("cpSync");
    expect(source("apps/web/tests/handlemodus/start-production-server.mjs"))
      .not.toContain("cpSync");
    expect(source("tests/e2e/start-https-server.mjs")).toContain(
      "assertPublicBuildBinding(repositoryRoot)",
    );
    expect(source("tests/e2e/start-https-server.mjs")).toContain(
      'const responseScanHeader = "x-handleplan-e2e-response-scan"',
    );
    expect(source("tests/e2e/start-https-server.mjs")).toContain(
      "harnessState.inFlightRequests += 1",
    );
    expect(source("tests/e2e/start-https-server.mjs")).toContain(
      'const allowedMethods = new Set(["GET", "HEAD", "POST"])',
    );
    expect(source("tests/e2e/start-https-server.mjs")).toContain(
      "void shutdown()",
    );
    const teardown = source("tests/e2e/verify-public-harness.mjs");
    expect(teardown).toContain('path: "/api/_handleplan-e2e/leak-probe"');
    expect(teardown).toContain('path: "/api/_handleplan-e2e/leak-header-probe"');
    expect(teardown).toContain('method: "TRACE"');
    expect(teardown).toContain("status.expectedLeakProbeRejections <= 0");
    expect(teardown).toContain("status.expectedBodyLeakProbeRejections <= 0");
    expect(teardown).toContain("status.expectedHeaderLeakProbeRejections <= 0");
    expect(teardown).toContain(
      "status.expectedBodyLeakProbeRejections + status.expectedHeaderLeakProbeRejections",
    );
    expect(teardown).toContain("status.expectedMethodProbeRejections <= 0");
    expect(teardown).toContain("status.apiResponsesScanned <= 0");
  });

  it("keeps whole-page WCAG 2.2 A and AA scans unfiltered", () => {
    const evidence = [
      source("apps/web/test-support/accessibility-evidence.ts"),
      source("tests/e2e/v1-accessibility.spec.ts"),
      source("apps/web/tests/handlemodus/accessibility-trip.spec.ts"),
    ].join("\n");

    for (const tag of ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]) {
      expect(evidence).toContain(`"${tag}"`);
    }
    expect(evidence).toContain(".analyze()");
    expect(evidence).not.toMatch(/\.exclude\s*\(|\.disableRules\s*\(|test\.(?:only|skip|fixme)\s*\(/u);
  });

  it("names every automated V1-18 state and limits private review evidence to the denied Access boundary", () => {
    const publicJourneys = source("tests/e2e/v1-accessibility.spec.ts");
    const offlineJourney = source("apps/web/tests/handlemodus/accessibility-trip.spec.ts");

    for (const marker of [
      "200% text-only resize",
      "both savings-convenience slider endpoints",
      "bounded 400% zoom equivalent",
      "empty complete-plan frontier",
      "partial price coverage",
      "calculated and unavailable travel",
      "320px reflow proxy",
      "private review Access boundary is a sanitized axe-clean 404 without bypassing authentication",
      "sanitized alert states",
    ]) {
      expect(publicJourneys).toContain(marker);
    }
    expect(offlineJourney).toContain("application origin is unavailable");
    expect(publicJourneys).toContain('page.goto("/review")');
    expect(publicJourneys).not.toMatch(/cf-access-jwt-assertion|REVIEW_ACCESS_AUDIENCE/iu);
    expect(publicJourneys).not.toMatch(/page\.route\([^\n]*review/iu);
  });

  it("keeps the denied review page generic, semantic, and private", () => {
    const proxy = source("apps/web/proxy.ts");
    const config = source("playwright.config.ts");

    expect(proxy).toContain('<html lang="nb">');
    expect(proxy).toContain("<h1>Siden finnes ikke</h1>");
    expect(proxy).toContain('"cache-control": "private, no-store"');
    expect(proxy).toContain('"x-robots-tag": "noindex, nofollow"');
    expect(proxy).not.toMatch(/PRIVATE_NOT_FOUND_DOCUMENT[\s\S]*Privat arbeidsflate/iu);
    expect(config).not.toMatch(/REVIEW_ACCESS_|cf-access-jwt-assertion/iu);
  });

  it("keeps viewport equivalence and private-boundary automation narrower than manual proof", () => {
    const helper = source("apps/web/test-support/accessibility-evidence.ts");
    const helperTest = source("apps/web/test-support/accessibility-evidence.test.ts");
    const evidence = source(
      "docs/evidence/v1/v1-18-accessibility-automated-2026-07-17.md",
    );

    expect(helper).toContain("it is not evidence that");
    expect(helper).toContain("expect(layout.offenders");
    expect(helperTest).toContain("rejects off-canvas content even when the root scroll width still fits");
    expect(evidence).toContain("does not prove");
    expect(evidence).toContain("Firefox and WebKit were discovered but not executed locally");
    expect(evidence).toContain("authenticated private review workspace was not opened or axe-scanned");
    expect(evidence).toContain("No VoiceOver");
    expect(evidence).toContain("No production build");
  });

  it("keeps the travel privacy assertion narrower than an end-to-end retention claim", () => {
    const helper = source("apps/web/test-support/accessibility-evidence.ts");

    expect(helper).toContain("expectTravelStateAbsentFromWebStorageAndUrl");
    for (const unprovenBoundary of [
      "cookies",
      "Cache API",
      "IndexedDB",
      "browser traces",
      "server logs",
      "routing",
      "edge infrastructure",
    ]) {
      expect(helper).toContain(unprovenBoundary);
    }
  });
});
