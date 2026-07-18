import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Request, type Response } from "@playwright/test";
import { createServer } from "node:http";

const BASE_ORIGIN = "https://127.0.0.1:3109";
const API_SCAN_HEADER = "x-handleplan-e2e-api-scan";
const API_SCAN_PASSED = "passed-v1";
const API_SCAN_REJECTED = "rejected-v1";
const RESPONSE_SCAN_HEADER = "x-handleplan-e2e-response-scan";
const RESPONSE_SCAN_PASSED = "passed-v1";
const LEAK_PROBE_HEADER = "x-handleplan-e2e-leak-probe";
const LEAK_PROBE_PATH = "/api/_handleplan-e2e/leak-probe";
const MISSING_SCAN_PROBE_PATH = "/api/_handleplan-e2e/missing-scan-probe";
const FORBIDDEN_VALUES = ["KASSAL_API_KEY", process.env.HANDLEPLAN_E2E_SENTINEL].filter(
  (value): value is string => Boolean(value),
);
const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "set-cookie"]);
const BODYLESS_STATUSES = new Set([101, 103, 204, 205, 304]);

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

interface PublicEvidence {
  settle(): Promise<void>;
  stats: {
    apiBodiesInspectedBeforeDelivery: number;
    apiScanFailures: Array<{ result: string; status: number; url: string }>;
    bodyReadFailures: Array<{ message: string; status: number; url: string }>;
    bodylessSameOriginResponses: number;
    browserCookieValuesInspected: number;
    browserCookieReadFailures: number;
    consoleErrors: number;
    consoleErrorMessages: string[];
    crossOriginBodiesNotInspected: number;
    forbiddenMatches: number;
    frameworkFontBodiesNotInspected: number;
    headerReadFailures: Array<{ sameOrigin: boolean; surface: "request" | "response" }>;
    pageErrors: number;
    responseScanFailures: Array<{ result: string; status: number; url: string }>;
    sameOriginBodiesInspected: number;
    surfacesInspected: number;
    observedSensitiveHeaderNames: string[];
  };
}

function collectPublicEvidence(page: Page): PublicEvidence {
  const stats: PublicEvidence["stats"] = {
    apiBodiesInspectedBeforeDelivery: 0,
    apiScanFailures: [],
    bodyReadFailures: [],
    bodylessSameOriginResponses: 0,
    browserCookieValuesInspected: 0,
    browserCookieReadFailures: 0,
    consoleErrors: 0,
    consoleErrorMessages: [],
    crossOriginBodiesNotInspected: 0,
    forbiddenMatches: 0,
    frameworkFontBodiesNotInspected: 0,
    headerReadFailures: [],
    pageErrors: 0,
    responseScanFailures: [],
    sameOriginBodiesInspected: 0,
    surfacesInspected: 0,
    observedSensitiveHeaderNames: [],
  };
  const pending: Promise<void>[] = [];

  function inspect(value: string): void {
    stats.surfacesInspected += 1;
    if (FORBIDDEN_VALUES.some((forbidden) => value.includes(forbidden))) {
      stats.forbiddenMatches += 1;
    }
  }

  function safeDiagnostic(value: string): string {
    let safe = value;
    for (const forbidden of FORBIDDEN_VALUES) safe = safe.replaceAll(forbidden, "[forbidden]");
    return safe.slice(0, 500);
  }

  function inspectHeader(name: string, value: string): void {
    const normalizedName = name.toLowerCase();
    if (SENSITIVE_HEADERS.has(normalizedName) && !stats.observedSensitiveHeaderNames.includes(normalizedName)) {
      stats.observedSensitiveHeaderNames.push(normalizedName);
      stats.observedSensitiveHeaderNames.sort();
    }
    inspect(`${normalizedName}:${value}`);
  }

  function inspectHeaders(headers: Record<string, string>): void {
    for (const [name, value] of Object.entries(headers)) inspectHeader(name, value);
  }

  function inspectHeaderEntries(headers: Array<{ name: string; value: string }>): void {
    for (const { name, value } of headers) inspectHeader(name, value);
  }

  async function inspectResponse(response: Response): Promise<void> {
    inspect(response.url());
    const sameOrigin = new URL(response.url()).origin === BASE_ORIGIN;
    try {
      const [headers, headerEntries] = await Promise.all([response.allHeaders(), response.headersArray()]);
      inspectHeaders(headers);
      inspectHeaderEntries(headerEntries);
    } catch {
      stats.headerReadFailures.push({ sameOrigin, surface: "response" });
    }
    if (!sameOrigin) {
      stats.crossOriginBodiesNotInspected += 1;
      return;
    }
    const responseUrl = new URL(response.url());
    const responseScanResult = response.headers()[RESPONSE_SCAN_HEADER] ?? "missing";
    const redirectWithoutExposedMarker = response.status() >= 300
      && response.status() < 400
      && responseScanResult === "missing";
    if (responseScanResult !== RESPONSE_SCAN_PASSED && !redirectWithoutExposedMarker) {
      stats.responseScanFailures.push({
        result: responseScanResult,
        status: response.status(),
        url: response.url(),
      });
    }
    if (isApiPath(responseUrl.pathname)) {
      const scanResult = response.headers()[API_SCAN_HEADER] ?? "missing";
      if (scanResult === API_SCAN_PASSED) {
        stats.apiBodiesInspectedBeforeDelivery += 1;
      } else {
        stats.apiScanFailures.push({
          result: scanResult,
          status: response.status(),
          url: response.url(),
        });
      }
      // The loopback production proxy fully buffers and scans same-origin API
      // headers and bytes before it releases this response to the browser.
      return;
    }
    const contentType = response.headers()["content-type"]?.split(";", 1)[0]?.toLowerCase();
    if (
      response.request().resourceType() === "font" &&
      contentType === "font/woff2" &&
      /^\/__nextjs_font\/[^/]+\.woff2$/.test(responseUrl.pathname)
    ) {
      // Chromium on Linux does not expose Next's virtual development font body
      // through Network.getResponseBody. Its URL and complete headers are still
      // inspected above; application, script, RSC, and API bodies remain required.
      stats.frameworkFontBodiesNotInspected += 1;
      return;
    }
    if (BODYLESS_STATUSES.has(response.status()) || (response.status() >= 300 && response.status() < 400)) {
      // Playwright cannot return redirect bodies, and WebKit also hides custom
      // redirect headers. The global teardown barrier independently requires
      // the loopback proxy to finish scanning every such body before success.
      stats.bodylessSameOriginResponses += 1;
      return;
    }
    try {
      const body = await response.body();
      stats.sameOriginBodiesInspected += 1;
      inspect(Buffer.from(body).toString("latin1"));
    } catch (error) {
      stats.bodyReadFailures.push({
        message: error instanceof Error ? error.message : String(error),
        status: response.status(),
        url: response.url(),
      });
    }
  }

  async function inspectRequest(request: Request): Promise<void> {
    inspect(request.url());
    inspect(request.postData() ?? "");
    const sameOrigin = new URL(request.url()).origin === BASE_ORIGIN;
    try {
      inspectHeaders(await request.allHeaders());
    } catch {
      stats.headerReadFailures.push({ sameOrigin, surface: "request" });
    }
  }

  page.on("console", (message) => {
    inspect(message.text());
    if (message.type() === "error") {
      stats.consoleErrors += 1;
      if (stats.consoleErrorMessages.length < 12) {
        stats.consoleErrorMessages.push(safeDiagnostic(message.text()));
      }
    }
  });
  page.on("pageerror", (error) => {
    inspect(error.message);
    stats.pageErrors += 1;
  });
  page.on("request", (request) => {
    pending.push(inspectRequest(request));
  });
  page.on("response", (response) => {
    pending.push(inspectResponse(response));
  });

  return {
    stats,
    settle: async () => {
      try {
        const cookies = await page.context().cookies();
        stats.browserCookieValuesInspected += cookies.length;
        for (const cookie of cookies) inspectHeader("cookie", `${cookie.name}=${cookie.value}`);
      } catch {
        stats.browserCookieReadFailures += 1;
      }
      await page.waitForTimeout(100);
      let completed = 0;
      let stableChecks = 0;
      while (stableChecks < 2) {
        if (completed < pending.length) {
          const batch = pending.slice(completed);
          completed = pending.length;
          await Promise.all(batch);
          stableChecks = 0;
        } else {
          stableChecks += 1;
        }
        await page.waitForTimeout(25);
      }
    },
  };
}

async function expectCleanPublicEvidence(evidence: PublicEvidence): Promise<void> {
  await evidence.settle();
  expect(evidence.stats.apiBodiesInspectedBeforeDelivery).toBeGreaterThan(0);
  expect(evidence.stats.sameOriginBodiesInspected).toBeGreaterThan(0);
  expect(evidence.stats.surfacesInspected).toBeGreaterThan(0);
  expect(evidence.stats.apiScanFailures).toEqual([]);
  expect(evidence.stats.bodyReadFailures).toEqual([]);
  expect(evidence.stats.browserCookieReadFailures).toBe(0);
  expect(evidence.stats.headerReadFailures).toEqual([]);
  expect(evidence.stats.consoleErrors, JSON.stringify(evidence.stats.consoleErrorMessages)).toBe(0);
  expect(evidence.stats.pageErrors).toBe(0);
  expect(evidence.stats.responseScanFailures).toEqual([]);
  expect(evidence.stats.forbiddenMatches).toBe(0);
}

async function expectWcag22AandAA(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations).toEqual([]);
}

async function addExactProduct(page: Page, query: string, productName: RegExp): Promise<void> {
  const composer = page.getByLabel("Hva skal du handle?");
  await composer.fill(query);
  await page.getByRole("option", { name: productName }).click();
}

const expectedPackages = [
  "Bakehuset · 750 g per pakke",
  "Evergood · 500 g per pakke",
  "TINE · 1 000 ml per pakke",
].sort();

const expectedPlans = [
  { name: "Enklest", total: "98,00 kr", totalOre: 9_800, stores: 1 },
  { name: "Balansert", total: "85,00 kr", totalOre: 8_500, stores: 2 },
  { name: "Mest spart", total: "80,00 kr", totalOre: 8_000, stores: 3 },
] as const;

test("the leak detector sees authorization, cookie, set-cookie, and rejected API body values", async ({ context, page }) => {
  const sentinel = process.env.HANDLEPLAN_E2E_SENTINEL;
  expect(typeof sentinel === "string" && sentinel.length > 20).toBe(true);
  if (!sentinel) throw new Error("Runtime leak sentinel was unavailable");

  const evidence = collectPublicEvidence(page);
  const missingScanUrl = `${BASE_ORIGIN}${MISSING_SCAN_PROBE_PATH}`;
  await test.step("record a missing API scan marker", async () => {
    await page.route(missingScanUrl, (route) => route.fulfill({
      body: "{}",
      contentType: "application/json",
      status: 200,
    }));
    // WebKit can keep a synthetic JSON top-level navigation in the loading
    // state; commit is sufficient because the response evidence is recorded.
    await page.goto(missingScanUrl, { waitUntil: "commit" });
    // Keep this exact-path route installed until context teardown. Removing a
    // just-committed top-level route races WebKit's synthetic-document load.
  });

  const rejectedProbe = await test.step("reject a forbidden API body before delivery", async () => {
    await page.goto("/planlegg");
    return page.evaluate(async ({ header, path, scanHeader }) => {
      const response = await fetch(path, { headers: { [header]: "v1" } });
      return {
        body: await response.text(),
        scanResult: response.headers.get(scanHeader),
        status: response.status,
      };
    }, {
      header: LEAK_PROBE_HEADER,
      path: LEAK_PROBE_PATH,
      scanHeader: API_SCAN_HEADER,
    });
  });
  expect(rejectedProbe.status).toBe(502);
  expect(rejectedProbe.scanResult).toBe(API_SCAN_REJECTED);
  expect(rejectedProbe.body).not.toContain(sentinel);
  await evidence.settle();
  expect(evidence.stats.apiScanFailures.map(({ result, status, url }) => ({
    path: new URL(url).pathname,
    result,
    status,
  }))).toEqual([
    { path: MISSING_SCAN_PROBE_PATH, result: "missing", status: 200 },
    { path: LEAK_PROBE_PATH, result: API_SCAN_REJECTED, status: 502 },
  ]);
  expect(evidence.stats.responseScanFailures.map(({ result, status, url }) => ({
    path: new URL(url).pathname,
    result,
    status,
  }))).toEqual([
    { path: MISSING_SCAN_PROBE_PATH, result: "missing", status: 200 },
    { path: LEAK_PROBE_PATH, result: API_SCAN_REJECTED, status: 502 },
  ]);

  const probeServer = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": `header-probe=${sentinel}; Path=/; HttpOnly`,
    });
    response.end("{}");
  });
  await new Promise<void>((resolve, reject) => {
    probeServer.once("error", reject);
    probeServer.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = probeServer.address();
    if (!address || typeof address === "string") throw new Error("Header probe address was unavailable");
    await context.setExtraHTTPHeaders({ authorization: `Bearer ${sentinel}` });

    const headerProbeUrl = `http://127.0.0.1:${address.port}/header-probe`;
    await page.goto(headerProbeUrl);
    // The first response supplies the HttpOnly cookie; the second navigation
    // proves the browser sends it and the request evidence lane can see it.
    await expect.poll(async () => (await context.cookies(headerProbeUrl)).some(
      ({ name, value }) => name === "header-probe" && value === sentinel,
    )).toBe(true);
    await page.reload();
    await evidence.settle();

    expect(evidence.stats.observedSensitiveHeaderNames).toEqual(["authorization", "cookie", "set-cookie"]);
    expect(evidence.stats.browserCookieValuesInspected).toBeGreaterThan(0);
    expect(evidence.stats.forbiddenMatches).toBeGreaterThanOrEqual(3);
    expect(evidence.stats.headerReadFailures).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) => probeServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("Planlegg reflows without horizontal overflow at 320 pixels", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/planlegg");

  await expect(page.getByRole("heading", { name: "Hva skal du handle?" })).toBeVisible();
  const reflow = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    offenders: [...document.querySelectorAll<HTMLElement>("body *")]
      .map((element) => {
        const box = element.getBoundingClientRect();
        return {
          className: element.className,
          left: box.left,
          right: box.right,
          tagName: element.tagName,
        };
      })
      .filter(({ left, right }) => left < -0.5 || right > window.innerWidth + 0.5)
      .slice(0, 12),
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(reflow.scrollWidth, JSON.stringify(reflow)).toBeLessThanOrEqual(reflow.innerWidth);

  const composer = await page.locator(".need-composer").boundingBox();
  expect(composer).not.toBeNull();
  expect(composer!.x).toBeGreaterThanOrEqual(0);
  expect(composer!.x + composer!.width).toBeLessThanOrEqual(320);
});

test("public discovery and trust surfaces pass automated WCAG checks", async ({ page }) => {
  const surfaces = [
    { path: "/oppdag", heading: "Oppdag" },
    { path: "/status", heading: "Datadekning og status" },
    { path: "/personvern", heading: "Personvern i Handleplan" },
    { path: "/om", heading: "Handleplan som et offentlig gode" },
  ] as const;

  for (const surface of surfaces) {
    await page.goto(surface.path);
    await expect(page.getByRole("heading", { name: surface.heading, exact: true })).toBeVisible();
    if (surface.path === "/oppdag") {
      await expect(page.getByRole("heading", { name: "Varekatalog og prisgrunnlag" }))
        .toBeVisible();
    }
    await expectWcag22AandAA(page);
  }
});

test("Planlegg remains operable with forced colours and reduced motion", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/planlegg");

  const composer = page.getByLabel("Hva skal du handle?");
  await expect(composer).toBeVisible();
  await composer.focus();
  await expect(composer).toBeFocused();
  const state = await page.evaluate(() => ({
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    runningAnimations: document.getAnimations().filter(
      (animation) => animation.playState === "running",
    ).length,
  }));
  expect(state.horizontalOverflow).toBe(false);
  expect(state.runningAnimations).toBe(0);
});

test("anonymous shopper approves matching and chooses every complete frontier plan", async ({ page }) => {
  const evidence = collectPublicEvidence(page);
  await page.goto("/");

  await expect(page).toHaveURL(`${BASE_ORIGIN}/planlegg`);
  await expect(page).toHaveTitle("Handleplan");
  await expect(page.getByRole("heading", { name: "Hva skal du handle?" })).toBeVisible();
  await expect(page.getByText("Ingen konto nødvendig.")).toBeVisible();
  await expect(page.getByText(/logg inn|opprett konto/i)).toHaveCount(0);
  await expectWcag22AandAA(page);

  await addExactProduct(page, "lettmelk", /TINE Lettmelk/);
  await addExactProduct(page, "kaffe", /Evergood Kaffe/);
  await addExactProduct(page, "brød", /Norsk grovbrød/);

  const storedBeforeResult = await page.evaluate(() => JSON.stringify(localStorage));
  expect(storedBeforeResult).not.toContain("origin");
  expect(JSON.parse(JSON.parse(storedBeforeResult)["handleplan:basket:v4"])).toMatchObject({
    version: 4,
    marketContext: { contractVersion: 1, countryCode: "NO", kind: "national" },
    familyConfirmations: [],
    needs: [{ query: "TINE Lettmelk 1 % 1 l" }, { query: "Evergood Kaffe 500 g" }, { query: "Norsk grovbrød 750 g" }],
    products: expect.arrayContaining([expect.objectContaining({ ean: "7038010000010" })]),
  });
  // Drain response bodies before a client navigation can cancel an in-flight
  // development-server response on slower CI runners.
  await evidence.settle();
  await page.getByRole("link", { name: /Finn handleplan/ }).click();

  await expect(page).toHaveTitle("Resultat | Handleplan");
  await expect(page.getByRole("heading", { name: "Handleliste fordelt på butikker" })).toBeVisible();
  await expect(page.getByText(/Komplett kurv basert på 3 nødvendige varer/)).toBeVisible();
  await expect(page.getByText(/logg inn|opprett konto/i)).toHaveCount(0);

  const radios = page.getByRole("radio");
  await expect(radios).toHaveCount(expectedPlans.length);
  const radioLabels = await radios.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label") ?? ""));
  expect(radioLabels.map((label) => label.split(",")[0])).toEqual(expectedPlans.map(({ name }) => name));

  for (const plan of expectedPlans) {
    const radio = page.getByRole("radio", { name: new RegExp(`^${plan.name}, ${plan.total.replace(".", "\\.")}`) });
    await radio.check();
    await expect(page.locator(".result-total")).toHaveText(plan.total);
    await expect(page.locator(".result-store")).toHaveCount(plan.stores);
    await expect(page.locator(".result-store-row")).toHaveCount(3);
    const packages = (await page.locator(".result-store-row > div > small:first-of-type").allTextContents())
      .map((value) => value.replace(/\s+/g, " "))
      .sort();
    expect(packages).toEqual(expectedPackages);
  }

  for (const left of expectedPlans) {
    for (const right of expectedPlans) {
      if (left === right) continue;
      const leftDominatesRight = left.totalOre <= right.totalOre && left.stores <= right.stores &&
        (left.totalOre < right.totalOre || left.stores < right.stores);
      expect(leftDominatesRight).toBe(false);
    }
  }

  const balanced = page.getByRole("radio", { name: /^Balansert/ });
  await balanced.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("radio", { name: /^Mest spart/ })).toBeChecked();
  const selectedPlanId = await page.getByRole("radio", { checked: true }).getAttribute("value");
  expect(selectedPlanId).toBeTruthy();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("handleplan:basket:v4"))).toContain('"convenienceWeightBasisPoints":0');

  await evidence.settle();
  await page.reload();
  await expect(page.locator(`input[type="radio"][value="${selectedPlanId}"]`)).toBeChecked();
  await expectWcag22AandAA(page);

  const storage = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
  expect(JSON.stringify(storage)).not.toContain("origin");
  await expectCleanPublicEvidence(evidence);
});

test("an intentionally stale fixture cannot produce a recommendation", async ({ page }) => {
  const evidence = collectPublicEvidence(page);
  await page.goto("/planlegg");
  await addExactProduct(page, "stale", /Stale testvare/);
  await page.getByRole("link", { name: /Finn handleplan/ }).click();

  await expect(page.getByRole("heading", { name: "Ingen komplett handleplan" })).toBeVisible();
  await expect(page.getByText("Ingen delvis plan blir anbefalt.")).toBeVisible();
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expectWcag22AandAA(page);
  await expectCleanPublicEvidence(evidence);
});

test("a shopper reviews a complete product family before receiving a server-owned plan", async ({ page }) => {
  const evidence = collectPublicEvidence(page);
  await page.goto("/planlegg");

  await page.getByLabel("Varetype").selectOption("family:melk");
  const candidateRequestPromise = page.waitForRequest((request) =>
    request.method() === "POST" && new URL(request.url()).pathname === "/api/plan-candidates");
  await page.getByRole("button", { name: "Se gjennom alternativer" }).click();
  const candidateRequest = await candidateRequestPromise;
  expect(candidateRequest.postDataJSON()).toEqual({
    contractVersion: 2,
    families: [{ familyId: "family:melk" }],
  });

  const approval = page.getByRole("group", { name: "Godkjenn alternativer for Melk" });
  await expect(approval).toBeVisible();
  await expect(approval.getByText("TINE Lettmelk 1 % 1 l")).toBeVisible();
  await expect(approval.getByText(/1.?000 ml/)).toBeVisible();
  await expect(approval.getByRole("button", {
    name: "Godkjenn kandidatlisten og legg til",
  })).toBeEnabled();
  await expectWcag22AandAA(page);

  await approval.getByRole("button", { name: "Godkjenn kandidatlisten og legg til" }).click();
  const basketRow = page.getByRole("listitem", { name: /Melk/ });
  await expect(basketRow.getByText("Gjennomgått varetype")).toBeVisible();
  const persisted = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("handleplan:basket:v4") ?? "{}"));
  expect(persisted).toMatchObject({
    version: 4,
    marketContext: { contractVersion: 1, countryCode: "NO", kind: "national" },
    familyConfirmations: [{
      candidateCount: 1,
      confirmation: {
        taxonomyVersionId: "handleplan-reviewed-families@1.0.0",
        userApproved: true,
      },
      family: { id: "family:melk", labelNo: "Melk" },
    }],
    matchingRules: [{ mode: "flexible", productFamily: "family:melk" }],
  });
  expect(JSON.stringify(persisted)).not.toContain("candidateProductIds");

  const planRequestPromise = page.waitForRequest((request) =>
    request.method() === "POST" && new URL(request.url()).pathname === "/api/plans");
  await page.getByRole("link", { name: /Finn handleplan/ }).click();
  const planRequest = await planRequestPromise;
  const planBody = planRequest.postDataJSON();
  expect(planBody).toMatchObject({
    contractVersion: 2,
    maxStores: 3,
    needs: [{
      match: {
        familyId: "family:melk",
        kind: "reviewed-family",
        confirmation: { userApproved: true },
      },
      required: true,
    }],
  });
  expect(JSON.stringify(planBody)).not.toMatch(
    /query|labelNo|candidateProductIds|TINE Lettmelk|packageMeasure|reviewer/i,
  );

  await expect(page.getByRole("heading", { name: "Handleliste fordelt på butikker" }))
    .toBeVisible();
  const substitutions = page.getByRole("heading", { name: "Godkjente varebytter" })
    .locator("xpath=ancestor::section");
  await expect(substitutions.getByText("Melk", { exact: true })).toBeVisible();
  await expect(substitutions.getByText("TINE Lettmelk 1 % 1 l")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ikke tilgjengelig for varebytter ennå" }))
    .toHaveCount(0);
  await expectWcag22AandAA(page);
  await expectCleanPublicEvidence(evidence);
});

test("a shopper discovers a fresh price and carries the exact product into Planlegg", async ({ page }) => {
  const evidence = collectPublicEvidence(page);
  await page.goto("/oppdag");

  await expect(page).toHaveTitle("Oppdag | Handleplan");
  await expect(page.getByRole("heading", { name: "Oppdag" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Varekatalog og prisgrunnlag" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "TINE Lettmelk 1 % 1 l" })).toBeVisible();
  await expect(page.getByText("Laveste viste ordinærpris • Bunnpris")).toBeVisible();
  await expect(page.getByText(/Deterministic fake price fixture/).first()).toBeVisible();
  await page.getByRole("button", { name: "Extra" }).click();
  await expect(page.getByRole("heading", { name: "Prisgrunnlag hos Extra" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "TINE Lettmelk 1 % 1 l" })).toBeVisible();
  await expectWcag22AandAA(page);

  const milkCard = page.getByRole("heading", { name: "TINE Lettmelk 1 % 1 l" }).locator("xpath=ancestor::article");
  await milkCard.getByRole("button", { name: "Legg til i handlelisten" }).click();
  await expect(milkCard.getByRole("button", { name: "I handlelisten" })).toBeDisabled();
  await expect(page.getByText("1 varebehov", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: /Gå til Planlegg/ }).click();
  await expect(page).toHaveURL(`${BASE_ORIGIN}/planlegg`);
  await expect(page.getByRole("listitem", { name: /TINE Lettmelk 1 % 1 l/ })).toBeVisible();
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem("handleplan:basket:v4") ?? "{}"));
  expect(persisted).toMatchObject({
    needs: [{ query: "TINE Lettmelk 1 % 1 l" }],
    matchingRules: [{ mode: "exact", exactEan: "7038010000010" }],
  });

  await expectCleanPublicEvidence(evidence);
});
