import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  exactProductPlanApiRequestSchema,
  exactProductPlanApiResponseSchemaFor,
  publicDiscoveryRequestV1Schema,
  publicDiscoveryResponseSchemaFor,
  publicProductSearchResponseSchema,
} from "@handleplan/domain";
import {
  expect,
  test,
  type APIResponse,
  type Page,
  type Response as PlaywrightResponse,
} from "@playwright/test";

import { createStrictResultTripSnapshot } from "../../apps/web/lib/strict-result-trip";
import { strictResultTripFixture } from "../../apps/web/test-support/strict-result-trip-fixture";
import {
  configureImageBuildTransition,
  resetImageHarness,
  setImageNetworkOffline,
} from "./image-harness-control";
import { productionImageDatabaseFixture as databaseFixture } from "./production-image-database-fixture";

const repositoryRoot = process.cwd();
const sealedPublic = path.join(
  repositoryRoot,
  "apps",
  "web",
  ".next",
  "standalone",
  "apps",
  "web",
  "public",
);
const expectedRevision = process.env.APP_COMMIT_SHA ?? "";
const applicationOrigin = "https://127.0.0.1:3121";
const responseScanHeader = "x-handleplan-image-e2e-response-scan";
const leakProbeHeader = "x-handleplan-image-e2e-leak-probe";
const safeServerFailureCodes = new Set([
  "CATALOG_UNAVAILABLE",
  "INVALID_SERVICE_RESPONSE",
  "PRICE_DATA_UNAVAILABLE",
  "REQUEST_BUDGET_UNAVAILABLE",
  "REQUEST_TIMEOUT",
  "RESPONSE_TOO_LARGE",
  "SERVER_BUSY",
]);
const isolatedDatabaseRoleEnvironmentNames = [
  "HANDLEPLAN_IMAGE_DATABASE_URL",
  "HANDLEPLAN_IMAGE_SEED_APP_DATABASE_URL",
  "HANDLEPLAN_IMAGE_SEED_DATABASE_URL",
  "HANDLEPLAN_IMAGE_SEED_REVIEW_DATABASE_URL",
] as const;
const exactRejectionBody = Buffer.from(JSON.stringify({
  error: "exact production image evidence rejected traffic",
}));

test.beforeEach(async () => {
  await resetImageHarness();
});

test.afterEach(async ({ page }) => {
  await page.close({ runBeforeUnload: false }).catch(() => undefined);
  await resetImageHarness();
});

function assertScanned(response: APIResponse): void {
  expect(response.headers()[responseScanHeader]).toBe("passed-v1");
}

async function safeServerFailureDiagnostic(response: PlaywrightResponse): Promise<string> {
  const url = new URL(response.url());
  const headers = response.headers();
  const scanValue = headers[responseScanHeader];
  const scan = scanValue === "passed-v1" || scanValue === "rejected-v1"
    ? scanValue
    : "missing-or-invalid";
  const contentType = headers["content-type"] ?? "";
  const declaredLength = headers["content-length"];
  const safeDeclaredLength = declaredLength === undefined
    || (/^\d{1,4}$/u.test(declaredLength) && Number(declaredLength) <= 1_024);
  let code = "unavailable";
  if (safeDeclaredLength && contentType.toLowerCase().startsWith("application/json")) {
    try {
      const body = await response.body();
      if (body.byteLength <= 1_024) {
        const value: unknown = JSON.parse(body.toString("utf8"));
        if (
          typeof value === "object"
          && value !== null
          && Object.keys(value).length === 1
          && "code" in value
          && typeof value.code === "string"
          && safeServerFailureCodes.has(value.code)
        ) code = value.code;
      }
    } catch {
      // Diagnostics remain path-only if an interrupted response body cannot be read safely.
    }
  }
  return `${response.request().method()} ${url.pathname} status=${response.status()} code=${code} scan=${scan}`;
}

async function assertScannedBrowserSuccess(response: PlaywrightResponse): Promise<void> {
  const url = new URL(response.url());
  const diagnostic = response.status() >= 500
    ? await safeServerFailureDiagnostic(response)
    : `${response.request().method()} ${url.pathname} status=${response.status()}`;
  expect(response.status(), diagnostic).toBe(200);
  expect(
    response.headers()[responseScanHeader],
    `${response.request().method()} ${url.pathname} response scan`,
  ).toBe("passed-v1");
}

async function assertSafeLeakRejection(response: APIResponse): Promise<void> {
  const body = await response.body();
  const headers = Buffer.from(JSON.stringify(response.headers()));
  const forbiddenValues = [
    "DATABASE_URL",
    process.env.HANDLEPLAN_IMAGE_E2E_CONTROL_TOKEN ?? "",
    process.env.HANDLEPLAN_IMAGE_E2E_RESPONSE_CANARY ?? "",
  ].filter((value) => value.length > 0);
  if (forbiddenValues.some((value) => {
    const bytes = Buffer.from(value);
    return body.includes(bytes) || headers.includes(bytes);
  })) {
    throw new Error("exact-image scanner reflected a forbidden value");
  }
  expect(response.status()).toBe(502);
  expect(response.headers()[responseScanHeader]).toBe("rejected-v1");
  expect(body.equals(exactRejectionBody)).toBe(true);
}

function strictImageTripSnapshot() {
  const now = new Date();
  const fixture = strictResultTripFixture({
    catalogObservedAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
    generatedAt: new Date(now.getTime() - 60_000).toISOString(),
    ordinaryObservedAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
  });
  return createStrictResultTripSnapshot({
    exactRequest: fixture.exactRequest,
    exactResponse: fixture.exactResponse,
    now,
    plan: fixture.plan,
    tripId: "trip:exact-image-e2e",
  });
}

async function seedActiveTrip(page: Page): Promise<void> {
  const snapshot = strictImageTripSnapshot();
  await page.evaluate(async (tripSnapshot) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("handleplan-handlemodus", 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("active-trip")) {
          request.result.createObjectStore("active-trip");
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("could not open exact-image trip storage"));
      request.onblocked = () => reject(new Error("exact-image trip storage was blocked"));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("active-trip", "readwrite");
        transaction.objectStore("active-trip").put({
          completedItemIds: [],
          repositoryVersion: 1,
          snapshot: tripSnapshot,
        }, "active");
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(new Error("exact-image trip seed was aborted"));
        transaction.onerror = () => reject(new Error("exact-image trip seed failed"));
      });
    } finally {
      database.close();
    }
  }, snapshot);
}

function publicFiles() {
  const files: Array<{ relativePath: string; bytes: Buffer; digest: string }> = [];
  function visit(directory: string) {
    for (const name of readdirSync(directory).sort()) {
      const absolutePath = path.join(directory, name);
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new Error(`unsupported sealed public entry: ${absolutePath}`);
      }
      if (stat.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      const bytes = readFileSync(absolutePath);
      files.push({
        bytes,
        digest: createHash("sha256").update(bytes).digest("hex"),
        relativePath: path.relative(sealedPublic, absolutePath).split(path.sep).join("/"),
      });
    }
  }
  visit(sealedPublic);
  return files;
}

test("the exact production image serves its sealed public browser shell", async ({ page, request }) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });
  expect(expectedRevision).toMatch(/^[0-9a-f]{40}$/);
  expect(isolatedDatabaseRoleEnvironmentNames.map((name) => process.env[name]))
    .toEqual([undefined, undefined, undefined, undefined]);

  for (const probePath of [
    "/__handleplan-image-e2e/leak-header-v1",
    "/__handleplan-image-e2e/leak-body-v1",
  ]) {
    const response = await request.get(probePath, {
      headers: { [leakProbeHeader]: "v1" },
    });
    await assertSafeLeakRejection(response);
  }

  const health = await request.get("/api/health");
  expect(health.status()).toBe(200);
  assertScanned(health);
  expect(await health.json()).toEqual({
    commit: expectedRevision,
    status: "ok",
    version: 1,
  });
  const readiness = await request.get("/api/ready");
  expect(readiness.status()).toBe(200);
  assertScanned(readiness);
  expect(await readiness.json()).toMatchObject({
    database: { status: "ok" },
    status: "ok",
    version: 1,
  });

  const files = publicFiles();
  expect(files.length).toBeGreaterThanOrEqual(4);
  for (const file of files) {
    const response = await request.get(`/${file.relativePath}`);
    expect(response.status(), file.relativePath).toBe(200);
    expect(response.headers()[responseScanHeader], file.relativePath).toBe("passed-v1");
    const actual = await response.body();
    expect(
      createHash("sha256").update(actual).digest("hex"),
      file.relativePath,
    ).toBe(file.digest);
    expect(Buffer.compare(actual, file.bytes), file.relativePath).toBe(0);
  }

  const manifestResponse = await request.get("/manifest.webmanifest");
  expect(manifestResponse.status()).toBe(200);
  assertScanned(manifestResponse);
  expect(await manifestResponse.json()).toMatchObject({
    display: "standalone",
    id: "/planlegg/handle",
    scope: "/",
    start_url: "/planlegg/handle",
  });

  await page.goto("/planlegg/handle", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveTitle("Handleplan");
  await expect(page.getByRole("heading", { name: "Ta handleplanen med i butikken" }))
    .toBeVisible();
  await expect(page.getByRole("heading", { name: "Ingen aktiv handletur" })).toBeVisible();
  const liveBuildMarkers = page.locator('meta[name="handleplan-public-build-id"]');
  await expect(liveBuildMarkers).toHaveCount(1);
  const liveBuildId = await liveBuildMarkers.getAttribute("content");
  expect(liveBuildId).toMatch(/^hpv2-[0-9a-f]{64}$/u);
  expect(await page.evaluate(() =>
    (globalThis as typeof globalThis & { __zod_globalConfig?: { jitless?: unknown } })
      .__zod_globalConfig?.jitless
  )).toBe(true);
  expect(browserErrors).toEqual([]);

  await expect.poll(
    () => page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return registration.active !== null
        && navigator.serviceWorker.controller?.scriptURL === registration.active.scriptURL;
    }),
    {
      message: "the active Handlemodus worker should claim the first production navigation",
      timeout: 15_000,
    },
  ).toBe(true);

  const cacheAudit = await page.evaluate(async () => {
    const registration = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("service worker readiness timed out")), 15_000)),
    ]);
    if (registration.active === null) throw new Error("service worker is not active");
    if (navigator.serviceWorker.controller?.scriptURL !== registration.active.scriptURL) {
      throw new Error("current page is not controlled by the active Handlemodus worker");
    }
    const scriptUrl = new URL(registration.active.scriptURL);
    const buildId = scriptUrl.searchParams.get("build");
    if (
      scriptUrl.pathname !== "/sw.js"
      || scriptUrl.searchParams.size !== 1
      || buildId === null
      || !/^hpv2-[0-9a-f]{64}$/u.test(buildId)
    ) throw new Error("Handlemodus worker is not source-bound");
    const channel = new MessageChannel();
    const offlineReady = await Promise.race([
      new Promise<unknown>((resolve) => {
        channel.port1.onmessage = (event) => resolve(event.data);
        channel.port1.start();
        registration.active!.postMessage(
          { buildId, kind: "handleplan:handle-mode-offline-ready:v1" },
          [channel.port2],
        );
      }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("offline shell readiness timed out")), 20_000)),
    ]).finally(() => {
      channel.port1.close();
      channel.port2.close();
    });
    async function probe(input: string, init?: RequestInit) {
      try {
        const response = await fetch(input, init);
        return { failed: false, status: response.status, type: response.type };
      } catch {
        return { failed: true, status: -1, type: "error" };
      }
    }
    const [apiProbe, providerProbe, queryProbe, foreignProbe] = await Promise.all([
      probe("/api/health"),
      probe("/provider/private"),
      probe("/planlegg/handle?private=image-e2e"),
      probe(`${location.protocol}//localhost:${location.port}/icons/handleplan.svg`, {
        mode: "no-cors",
      }),
    ]);
    const cacheNames = (await caches.keys()).sort();
    const shellName = `handleplan-handlemodus-${buildId}-shell`;
    const allowedCacheNames = new Set([
      shellName,
      `handleplan-handlemodus-${buildId}-runtime`,
    ]);
    if (!cacheNames.includes(shellName)) throw new Error("Handlemodus shell cache is missing");
    const cacheEntries = await Promise.all(cacheNames.map(async (name) => {
      const cache = await caches.open(name);
      return { name, requests: await cache.keys() };
    }));
    const shellCache = await caches.open(shellName);
    const shellRequests = await shellCache.keys();
    const shellUrls = shellRequests.map(({ url }) => new URL(url));
    const shellPaths = new Set(shellUrls.map(({ pathname }) => pathname));
    const allUrls = cacheEntries.flatMap(({ requests }) =>
      requests.map(({ url }) => new URL(url)));
    const handleResponse = await shellCache.match("/planlegg/handle");
    if (handleResponse === undefined) throw new Error("Handlemodus document is missing");
    const document = new DOMParser().parseFromString(await handleResponse.text(), "text/html");
    const documentBuildIds = [
      ...document.querySelectorAll<HTMLMetaElement>(
        'meta[name="handleplan-public-build-id"]',
      ),
    ].map((marker) => marker.content);
    const staticPaths = [...new Set(
      [...document.querySelectorAll<HTMLElement>("[src], [href]")]
        .flatMap((element) => [element.getAttribute("src"), element.getAttribute("href")])
        .filter((value): value is string => value !== null)
        .map((value) => new URL(value, location.origin))
        .filter((url) =>
          url.origin === location.origin
          && url.search === ""
          && url.pathname.startsWith("/_next/static/"))
        .map(({ pathname }) => pathname),
    )];
    return {
      cacheEntryCount: cacheEntries.reduce((total, { requests }) => total + requests.length, 0),
      cacheNames,
      buildId,
      documentBuildIds,
      foreignEntries: allUrls.filter(({ origin }) => origin !== location.origin).map(String),
      largestCacheEntryCount: Math.max(...cacheEntries.map(({ requests }) => requests.length)),
      missingRequired: [
        "/planlegg/handle",
        "/manifest.webmanifest",
        "/icons/handleplan.svg",
        "/icons/handleplan-maskable.svg",
        "/zod-jitless-v1.js",
        ...staticPaths,
      ].filter((requiredPath) => !shellPaths.has(requiredPath)),
      offlineReady,
      privateEntries: allUrls
        .filter(({ pathname, search }) =>
          search !== ""
          || pathname === "/api"
          || pathname.startsWith("/api/")
          || pathname === "/provider"
          || pathname.startsWith("/provider/")
          || pathname === "/providers"
          || pathname.startsWith("/providers/"))
        .map(String),
      probes: { apiProbe, foreignProbe, providerProbe, queryProbe },
      scriptUrl: scriptUrl.href,
      staticPathCount: staticPaths.length,
      unexpectedCacheNames: cacheNames.filter((name) => !allowedCacheNames.has(name)),
    };
  });
  expect(cacheAudit.documentBuildIds).toEqual([cacheAudit.buildId]);
  expect(liveBuildId).toBe(cacheAudit.buildId);
  expect(cacheAudit.offlineReady).toEqual({
    buildId: cacheAudit.buildId,
    kind: "handleplan:handle-mode-offline-ready-result:v1",
    ready: true,
  });
  expect(cacheAudit.buildId).toMatch(/^hpv2-[0-9a-f]{64}$/u);
  expect(cacheAudit.scriptUrl).toBe(
    `https://127.0.0.1:3121/sw.js?build=${cacheAudit.buildId}`,
  );
  expect(cacheAudit.cacheNames).toContain(
    `handleplan-handlemodus-${cacheAudit.buildId}-shell`,
  );
  expect(cacheAudit.cacheNames.length).toBeLessThanOrEqual(2);
  expect(cacheAudit.unexpectedCacheNames).toEqual([]);
  expect(cacheAudit.cacheEntryCount).toBeLessThanOrEqual(128);
  expect(cacheAudit.largestCacheEntryCount).toBeLessThanOrEqual(64);
  expect(cacheAudit.staticPathCount).toBeGreaterThan(0);
  expect(cacheAudit.missingRequired).toEqual([]);
  expect(cacheAudit.privateEntries).toEqual([]);
  expect(cacheAudit.foreignEntries).toEqual([]);
  expect(cacheAudit.probes.apiProbe).toMatchObject({ failed: false, status: 200 });
  expect(cacheAudit.probes.providerProbe).toMatchObject({ failed: false, status: 404 });
  expect(cacheAudit.probes.queryProbe).toMatchObject({ failed: false, status: 200 });
  expect(
    cacheAudit.probes.foreignProbe.failed || cacheAudit.probes.foreignProbe.type === "opaque",
  ).toBe(true);
});

test("the exact production image searches and plans from governed PostgreSQL evidence", async ({
  page,
  request,
}) => {
  const browserErrors: string[] = [];
  const serverFailureDiagnostics: string[] = [];
  const pendingServerFailureDiagnostics: Promise<void>[] = [];
  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (
      url.origin !== applicationOrigin
      || response.status() < 500
    ) return;
    pendingServerFailureDiagnostics.push(safeServerFailureDiagnostic(response)
      .then((value) => {
        serverFailureDiagnostics.push(value);
      }));
  });

  const productSearch = await request.get(
    `/api/products/search?q=${encodeURIComponent("Handleplan verifisert lettmelk")}`,
  );
  expect(productSearch.status()).toBe(200);
  assertScanned(productSearch);
  const productSearchPayload = publicProductSearchResponseSchema.parse(await productSearch.json());
  expect(productSearchPayload).toEqual({
    contractVersion: 1,
    products: [{
      brand: databaseFixture.brand,
      contractVersion: 1,
      displayName: databaseFixture.productName,
      gtin: databaseFixture.gtin,
      packageMeasure: { amount: 1_000, unit: "ml" },
      unitsPerPack: 1,
    }],
  });

  await page.goto("/planlegg", { waitUntil: "domcontentloaded" });
  expect(new URL(page.url()).origin).toBe(applicationOrigin);
  await expect(page).toHaveTitle("Handleplan");
  await expect(page.getByRole("heading", { name: "Hva skal du handle?" })).toBeVisible();
  const productCombobox = page.getByRole("combobox", { name: "Hva skal du handle?" });
  const uiProductSearchResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET"
      && url.pathname === "/api/products/search"
      && url.searchParams.get("q") === "Handleplan verifisert lettmelk";
  });
  await productCombobox.fill("Handleplan verifisert lettmelk");
  const uiProductSearchResponse = await uiProductSearchResponsePromise;
  await assertScannedBrowserSuccess(uiProductSearchResponse);
  expect(publicProductSearchResponseSchema.parse(await uiProductSearchResponse.json()))
    .toEqual(productSearchPayload);
  const exactOption = page.getByRole("option").filter({ hasText: databaseFixture.productName });
  await expect(exactOption).toHaveCount(1);
  await exactOption.click();
  await expect(page.getByRole("listitem").filter({ hasText: databaseFixture.productName }))
    .toHaveCount(1);
  await page.getByRole("button", { name: "Tøm liste" }).click();
  await expect(page.getByText("Kurven er tom.")).toBeVisible();

  const discoveryRequest = publicDiscoveryRequestV1Schema.parse({
    chain: "all",
    contractVersion: 1,
    marketContext: { contractVersion: 1, countryCode: "NO", kind: "national" },
    pageSize: 8,
    query: "Handleplan verifisert lettmelk",
    resultType: "all",
  });
  if (discoveryRequest.query === undefined) {
    throw new Error("the governed discovery request lost its required query");
  }
  const discoverySearch = await request.get(
    `/api/discovery/search?chain=all&market=national&pageSize=8&type=all&q=${encodeURIComponent(discoveryRequest.query)}`,
  );
  expect(discoverySearch.status()).toBe(200);
  assertScanned(discoverySearch);
  const discovery = publicDiscoveryResponseSchemaFor(discoveryRequest)
    .parse(await discoverySearch.json());
  expect(discovery.products).toHaveLength(1);
  const discoveryProduct = discovery.products[0]!;
  expect(discoveryProduct.catalog).toMatchObject({
    brand: databaseFixture.brand,
    displayName: databaseFixture.productName,
    gtin: databaseFixture.gtin,
  });
  expect(discoveryProduct.ordinaryPrices).toEqual([
    expect.objectContaining({
      amountOre: databaseFixture.ordinaryPriceOre,
      chainId: "extra",
      sourceId: `image-price-${expectedRevision.slice(0, 12)}`,
    }),
  ]);
  expect(discoveryProduct.officialOffers).toEqual([
    expect.objectContaining({
      beforePriceOre: databaseFixture.ordinaryPriceOre,
      chainId: "extra",
      pricing: { kind: "unit", unitPriceOre: databaseFixture.offerPriceOre },
      sourceId: `image-offer-${expectedRevision.slice(0, 12)}`,
    }),
  ]);
  expect(discoveryProduct.comparisonScope).toMatchObject({
    completeness: "partial",
    expectedChainIds: ["bunnpris", "extra", "rema-1000"],
    entries: [
      {
        chainId: "bunnpris",
        status: expect.objectContaining({ kind: "unknown", reason: "source-unavailable" }),
      },
      { chainId: "extra", status: expect.objectContaining({ kind: "priced" }) },
      {
        chainId: "rema-1000",
        status: expect.objectContaining({ kind: "unknown", reason: "source-unavailable" }),
      },
    ],
  });

  const initialDiscoveryRequest = publicDiscoveryRequestV1Schema.parse({
    chain: "all",
    contractVersion: 1,
    marketContext: { contractVersion: 1, countryCode: "NO", kind: "national" },
    pageSize: 8,
    resultType: "all",
  });
  const initialDiscoveryResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET"
      && url.pathname === "/api/discovery/search"
      && url.searchParams.get("chain") === "all"
      && url.searchParams.get("market") === "national"
      && url.searchParams.get("pageSize") === "8"
      && url.searchParams.get("type") === "all"
      && !url.searchParams.has("category")
      && !url.searchParams.has("cursor")
      && !url.searchParams.has("q");
  });
  await page.goto("/oppdag", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveTitle("Oppdag | Handleplan");
  await expect(page.getByRole("heading", { name: "Oppdag" })).toBeVisible();
  const initialDiscoveryResponse = await initialDiscoveryResponsePromise;
  await assertScannedBrowserSuccess(initialDiscoveryResponse);
  const initialDiscovery = publicDiscoveryResponseSchemaFor(initialDiscoveryRequest)
    .parse(await initialDiscoveryResponse.json());
  expect(initialDiscovery.products.length).toBeGreaterThan(0);
  await expect(page.getByRole("heading", {
    name: initialDiscovery.products[0]!.catalog.displayName,
  })).toBeVisible();
  await expect(page.getByText(/^[1-9]\d* (?:vare|varer) på denne siden$/u)).toBeVisible();
  // The exact-image gate proves both required user modes without manufacturing
  // an immediate navigation-time cancellation. Focused component coverage owns
  // the intentional supersession behavior when a real browse is still pending.
  const discoveryQuery = page.getByLabel("Filtrer varene (valgfritt)");
  await discoveryQuery.fill("Handleplan verifisert lettmelk");
  const uiDiscoveryResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET"
      && url.pathname === "/api/discovery/search"
      && url.searchParams.get("q") === discoveryRequest.query;
  });
  await page.getByRole("button", { name: "Søk", exact: true }).click();
  const uiDiscoveryResponse = await uiDiscoveryResponsePromise;
  await assertScannedBrowserSuccess(uiDiscoveryResponse);
  publicDiscoveryResponseSchemaFor(discoveryRequest).parse(await uiDiscoveryResponse.json());
  await expect(page.getByRole("heading", {
    name: "Treff for «Handleplan verifisert lettmelk»",
  })).toBeVisible();
  const productCard = page.getByRole("heading", { name: databaseFixture.productName })
    .locator("xpath=ancestor::article");
  await expect(productCard).toHaveCount(1);
  await expect(productCard).toContainText("24,90 kr");
  await expect(productCard).toContainText("Laveste viste ordinærpris • Extra");
  const offerPanel = productCard.getByRole("region", {
    name: /^Offisielt tilbud 1 hos Extra:/u,
  });
  await expect(offerPanel).toContainText("19,90 kr per pakke");
  await expect(offerPanel).toContainText("Oppgitt førpris: 24,90 kr");
  await expect(offerPanel).toContainText(
    "Spar 5,00 kr (20,1 %) basert på tilbudets oppgitte førpris.",
  );
  await expect(offerPanel).toContainText("CI verifisert offisielt tilbud");
  const ordinaryPrices = productCard.getByRole("list", {
    name: `Ordinærpriser for ${databaseFixture.productName}`,
  });
  await expect(ordinaryPrices).toContainText("Extra");
  await expect(ordinaryPrices).toContainText("24,90 kr");
  await expect(ordinaryPrices).toContainText("CI verifisert ordinærpris");
  await expect(productCard).toContainText(
    "Delvis dekning. Uavklart: Bunnpris, REMA 1000.",
  );

  await productCard.getByRole("button", { name: "Legg til i handlelisten" }).click();
  await expect(productCard.getByRole("button", { name: "I handlelisten" })).toBeDisabled();
  await expect(page.getByText("1 varebehov", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: /Gå til Planlegg/u }).click();
  await expect(page).toHaveURL("/planlegg");
  await expect(page.getByRole("listitem").filter({ hasText: databaseFixture.productName }))
    .toHaveCount(1);

  const planResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/plans");
  await page.getByRole("link", { name: /Finn handleplan/u }).click();
  const planResponse = await planResponsePromise;
  expect(planResponse.status()).toBe(200);
  expect(planResponse.headers()[responseScanHeader]).toBe("passed-v1");
  const planRequest = exactProductPlanApiRequestSchema.parse(
    planResponse.request().postDataJSON(),
  );
  expect(planRequest).toMatchObject({
    contractVersion: 1,
    enabledMembershipProgramIds: [],
    marketContext: { contractVersion: 1, countryCode: "NO", kind: "national" },
    maxStores: 3,
    needs: [{
      match: {
        kind: "exact-product",
        product: { kind: "gtin", value: databaseFixture.gtin },
        userApproved: true,
      },
      quantity: 1,
      quantityUnit: "package",
      required: true,
    }],
  });
  const planResult = exactProductPlanApiResponseSchemaFor(planRequest)
    .parse(await planResponse.json());
  expect(planResult.plans).toHaveLength(1);
  expect(planResult.plans[0]).toMatchObject({
    chains: ["extra"],
    totalOre: databaseFixture.offerPriceOre,
    assignments: [{
      chain: "extra",
      checkout: {
        ordinaryTotalOre: databaseFixture.ordinaryPriceOre,
        savingOre: databaseFixture.ordinaryPriceOre - databaseFixture.offerPriceOre,
        totalOre: databaseFixture.offerPriceOre,
      },
      ean: databaseFixture.gtin,
      officialOffer: { sourceId: `image-offer-${expectedRevision.slice(0, 12)}` },
      source: `image-price-${expectedRevision.slice(0, 12)}`,
    }],
  });
  expect(planResult.evidence.needs[0]?.comparisonScope).toMatchObject({
    completeness: "partial",
    expectedChainIds: ["bunnpris", "extra", "rema-1000"],
    entries: [
      {
        chainId: "bunnpris",
        status: expect.objectContaining({ kind: "unknown", reason: "source-unavailable" }),
      },
      { chainId: "extra", status: expect.objectContaining({ kind: "priced" }) },
      {
        chainId: "rema-1000",
        status: expect.objectContaining({ kind: "unknown", reason: "source-unavailable" }),
      },
    ],
  });

  await expect(page.getByRole("heading", { name: "Handleliste fordelt på butikker" }))
    .toBeVisible();
  await expect(page.locator(".result-total")).toHaveText("19,90 kr");
  const extraStore = page.locator('section[aria-label="Butikk 1: Extra"]');
  await expect(extraStore).toContainText(databaseFixture.productName);
  await expect(extraStore).toContainText("Før 24,90 kr");
  await expect(extraStore).toContainText("19,90 kr");
  await expect(extraStore).toContainText("5,00 kr spart");
  await expect(extraStore).toContainText(
    `Offisielt tilbud brukt · kilde image-offer-${expectedRevision.slice(0, 12)}`,
  );
  await expect(page.getByText("1 nødvendig vare er med", { exact: true })).toBeVisible();
  const priceProvenance = page.locator(".price-provenance");
  await expect(priceProvenance).toContainText("Uavklart dekning: Bunnpris, REMA 1000.");
  await expect(page.getByText(/Kilder: CI verifisert varekatalog, CI verifisert offisielt tilbud, CI verifisert ordinærpris\./u))
    .toBeVisible();
  await expect(priceProvenance).toContainText("1 offisielt tilbud er brukt i valgt plan.");
  await page.waitForTimeout(100);
  let completedDiagnostics = 0;
  let stableDiagnosticChecks = 0;
  while (stableDiagnosticChecks < 2) {
    if (completedDiagnostics < pendingServerFailureDiagnostics.length) {
      const batch = pendingServerFailureDiagnostics.slice(completedDiagnostics);
      completedDiagnostics = pendingServerFailureDiagnostics.length;
      await Promise.all(batch);
      stableDiagnosticChecks = 0;
    } else {
      stableDiagnosticChecks += 1;
    }
    await page.waitForTimeout(25);
  }
  expect({ browserErrors, serverFailureDiagnostics }).toEqual({
    browserErrors: [],
    serverFailureDiagnostics: [],
  });
});

test("a strict saved trip survives a test-only transformed worker generation and a hard origin outage", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/planlegg/handle", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Ingen aktiv handletur" })).toBeVisible();
  await expect.poll(
    () => page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return registration.active !== null
        && navigator.serviceWorker.controller?.scriptURL === registration.active.scriptURL;
    }),
    {
      message: "the sealed image worker should activate and claim the initial Handlemodus page",
      timeout: 20_000,
    },
  ).toBe(true);

  const oldBuildId = await page.locator('meta[name="handleplan-public-build-id"]')
    .getAttribute("content");
  expect(oldBuildId).toMatch(/^hpv2-[0-9a-f]{64}$/u);
  if (oldBuildId === null) throw new Error("the sealed Handlemodus build marker is missing");

  await seedActiveTrip(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForLoadState("load");
  await expect(page.getByText("TINE Lettmelk 1 l", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "0 av 1 vare" })).toBeVisible();
  const initialCheckbox = page.getByRole("checkbox", { name: /TINE Lettmelk/u });
  await expect(initialCheckbox).not.toBeChecked();

  await expect.poll(
    () => page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      const identity = (worker: ServiceWorker | null) => {
        if (worker === null) return null;
        const url = new URL(worker.scriptURL);
        return `${url.pathname}${url.search}`;
      };
      return {
        active: identity(registration.active),
        controller: identity(navigator.serviceWorker.controller),
        installing: identity(registration.installing),
        waiting: identity(registration.waiting),
      };
    }),
    {
      message: "the reloaded app must finish its source-bound registration before transition",
      timeout: 30_000,
    },
  ).toEqual({
    active: `/sw.js?build=${oldBuildId}`,
    controller: `/sw.js?build=${oldBuildId}`,
    installing: null,
    waiting: null,
  });

  const nextBuildId = `hpv2-${createHash("sha256")
    .update(`${oldBuildId}\0exact-image-worker-transition-v1`)
    .digest("hex")}`;
  expect(nextBuildId).not.toBe(oldBuildId);
  await configureImageBuildTransition(oldBuildId, nextBuildId);
  await page.evaluate(async (buildId) => {
    await navigator.serviceWorker.register(`/sw.js?build=${buildId}`, {
      scope: "/",
      updateViaCache: "none",
    });
  }, nextBuildId);
  await expect.poll(
    () => page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      const identity = (worker: ServiceWorker | null) => {
        if (worker === null) return null;
        const url = new URL(worker.scriptURL);
        return `${url.pathname}${url.search}`;
      };
      return {
        active: identity(registration.active),
        controller: identity(navigator.serviceWorker.controller),
        installing: identity(registration.installing),
        waiting: identity(registration.waiting),
      };
    }),
    {
      message: "skipWaiting plus clients.claim should move the open trip to the next worker",
      timeout: 60_000,
    },
  ).toEqual({
    active: `/sw.js?build=${nextBuildId}`,
    controller: `/sw.js?build=${nextBuildId}`,
    installing: null,
    waiting: null,
  });

  const transitionAudit = await page.evaluate(async (toBuildId) => {
    const controllerUrl = navigator.serviceWorker.controller?.scriptURL ?? "";
    const shellName = `handleplan-handlemodus-${toBuildId}-shell`;
    const shell = await caches.open(shellName);
    const documentResponse = await shell.match("/planlegg/handle");
    if (documentResponse === undefined) throw new Error("next-build shell document is missing");
    const document = new DOMParser().parseFromString(await documentResponse.text(), "text/html");
    const documentBuildIds = [
      ...document.querySelectorAll<HTMLMetaElement>('meta[name="handleplan-public-build-id"]'),
    ].map(({ content }) => content);
    return {
      controllerUrl,
      documentBuildIds,
    };
  }, nextBuildId);
  expect(transitionAudit.controllerUrl).toContain(`/sw.js?build=${nextBuildId}`);
  expect(transitionAudit.documentBuildIds).toEqual([nextBuildId]);

  const nextOfflineReady = await page.evaluate(async (buildId) => {
    const registration = await navigator.serviceWorker.ready;
    const active = registration.active;
    if (active === null || !active.scriptURL.endsWith(`/sw.js?build=${buildId}`)) {
      throw new Error("the next Handlemodus worker is not active");
    }
    const channel = new MessageChannel();
    return Promise.race([
      new Promise<unknown>((resolve) => {
        channel.port1.onmessage = (event) => resolve(event.data);
        channel.port1.start();
        active.postMessage(
          { buildId, kind: "handleplan:handle-mode-offline-ready:v1" },
          [channel.port2],
        );
      }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("next-build offline readiness timed out")), 20_000)),
    ]).finally(() => {
      channel.port1.close();
      channel.port2.close();
    });
  }, nextBuildId);
  expect(nextOfflineReady).toEqual({
    buildId: nextBuildId,
    kind: "handleplan:handle-mode-offline-ready-result:v1",
    ready: true,
  });

  await page.evaluate(async (staleBuildId) => {
    try {
      await navigator.serviceWorker.register(`/sw.js?build=${staleBuildId}`, {
        scope: "/",
        updateViaCache: "none",
      });
    } catch {
      // The next deployment serves next-generation bytes for this stale query,
      // so the embedded identity check is expected to reject the update.
    }
  }, oldBuildId);
  await expect.poll(
    () => page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      const identity = (worker: ServiceWorker | null) => {
        if (worker === null) return null;
        const url = new URL(worker.scriptURL);
        return `${url.pathname}${url.search}`;
      };
      return {
        active: identity(registration.active),
        controller: identity(navigator.serviceWorker.controller),
        installing: identity(registration.installing),
        waiting: identity(registration.waiting),
      };
    }),
    {
      message: "a delayed prior-generation registration must not roll the worker back",
      timeout: 30_000,
    },
  ).toEqual({
    active: `/sw.js?build=${nextBuildId}`,
    controller: `/sw.js?build=${nextBuildId}`,
    installing: null,
    waiting: null,
  });

  await setImageNetworkOffline(true);
  const outageProof = await page.evaluate(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(`/api/health?exact-image-outage=${Date.now()}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      return { kind: "resolved", status: response.status };
    } catch {
      return { kind: controller.signal.aborted ? "timed-out" : "rejected" };
    } finally {
      clearTimeout(timer);
    }
  });
  expect(outageProof).toEqual({ kind: "rejected" });

  await page.reload({ timeout: 30_000, waitUntil: "domcontentloaded" });
  await expect(page.getByText("TINE Lettmelk 1 l", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "0 av 1 vare" })).toBeVisible();
  const offlineCheckbox = page.getByRole("checkbox", { name: /TINE Lettmelk/u });
  await expect(offlineCheckbox).not.toBeChecked();
  // Completion is controlled by the durable IndexedDB write, so WebKit must
  // not be asked to observe a native-immediate checkbox transition.
  await offlineCheckbox.click();
  await expect(offlineCheckbox).toBeChecked();
  await expect(page.getByRole("heading", { name: "1 av 1 vare" })).toBeVisible();

  await page.reload({ timeout: 30_000, waitUntil: "domcontentloaded" });
  await expect(page.getByText("TINE Lettmelk 1 l", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /TINE Lettmelk/u })).toBeChecked();
  await expect(page.getByRole("heading", { name: "1 av 1 vare" })).toBeVisible();

  const collectFinalTransitionAudit = () => page.evaluate(
    async ({ fromBuildId, toBuildId }) => {
      const registration = await navigator.serviceWorker.ready;
      const identity = (worker: ServiceWorker | null) => {
        if (worker === null) return null;
        const url = new URL(worker.scriptURL);
        return `${url.pathname}${url.search}`;
      };
      const cacheNames = (await caches.keys())
        .filter((name) => name.startsWith("handleplan-handlemodus-"))
        .sort();
      const nextPrefix = `handleplan-handlemodus-${toBuildId}-`;
      const nextShellName = `${nextPrefix}shell`;
      return {
        active: identity(registration.active),
        cacheNames,
        controller: identity(navigator.serviceWorker.controller),
        installing: identity(registration.installing),
        nextShellCount: cacheNames.filter((name) => name === nextShellName).length,
        priorCacheNames: cacheNames.filter((name) => name.includes(fromBuildId)),
        unexpectedCacheNames: cacheNames.filter((name) => !name.startsWith(nextPrefix)),
        waiting: identity(registration.waiting),
      };
    },
    { fromBuildId: oldBuildId, toBuildId: nextBuildId },
  );

  await expect.poll(async () => {
    const audit = await collectFinalTransitionAudit();
    return {
      active: audit.active,
      cacheCountWithinBound: audit.cacheNames.length <= 2,
      controller: audit.controller,
      installing: audit.installing,
      nextShellCount: audit.nextShellCount,
      priorCacheNames: audit.priorCacheNames,
      unexpectedCacheNames: audit.unexpectedCacheNames,
      waiting: audit.waiting,
    };
  }, {
    message: "the post-outage worker and bounded cache ownership must settle on the next image",
    timeout: 30_000,
  }).toEqual({
    active: `/sw.js?build=${nextBuildId}`,
    cacheCountWithinBound: true,
    controller: `/sw.js?build=${nextBuildId}`,
    installing: null,
    nextShellCount: 1,
    priorCacheNames: [],
    unexpectedCacheNames: [],
    waiting: null,
  });

  const finalTransitionAudit = await collectFinalTransitionAudit();
  expect(finalTransitionAudit.active).toBe(`/sw.js?build=${nextBuildId}`);
  expect(finalTransitionAudit.controller).toBe(`/sw.js?build=${nextBuildId}`);
  expect(finalTransitionAudit.installing).toBeNull();
  expect(finalTransitionAudit.waiting).toBeNull();
  expect(finalTransitionAudit.nextShellCount).toBe(1);
  expect(finalTransitionAudit.cacheNames.length).toBeLessThanOrEqual(2);
  expect(finalTransitionAudit.priorCacheNames).toEqual([]);
  expect(finalTransitionAudit.unexpectedCacheNames).toEqual([]);
});
