import { expect, test } from "@playwright/test";
import {
  exactProductPlanApiResponseSchemaFor,
  type ExactProductPlanApiRequest,
} from "@handleplan/domain";

const GTIN = "7038010000010";
const BASKET_STORAGE_KEY = "handleplan:basket:v2";
const CACHE_PREFIX = "handleplan-handlemodus-";

const strictRequest: ExactProductPlanApiRequest = {
  contractVersion: 1,
  maxStores: 3,
  needs: [{
    id: "milk",
    match: {
      kind: "exact-product",
      product: { kind: "gtin", value: GTIN },
      userApproved: true,
    },
    quantity: 1,
    quantityUnit: "each",
    required: true,
  }],
};

const basket = {
  convenienceWeightBasisPoints: 5_000,
  matchingRules: [{
    exactEan: GTIN,
    explanation: "LOCAL EXPLANATION MUST STAY PRIVATE",
    id: "milk-rule",
    mode: "exact",
    userApproved: true,
  }],
  needs: [{
    id: "milk",
    matchRuleId: "milk-rule",
    quantity: 1,
    quantityUnit: "each",
    query: "LOCAL QUERY MUST STAY PRIVATE",
    required: true,
  }],
  products: [{
    brand: "Local brand",
    ean: GTIN,
    name: "LOCAL PRODUCT MUST STAY PRIVATE",
    productFamily: "local-family",
  }],
  travel: { enabled: false, mode: "car" },
  version: 2,
};

function strictResponse(now: number) {
  const generatedAt = new Date(now - 60_000).toISOString();
  const observedAt = new Date(now - 5 * 60_000).toISOString();
  const catalogObservedAt = new Date(now - 10 * 60_000).toISOString();
  const source = {
    contractVersion: 1,
    displayName: "E2E persisted source",
    id: "e2e-source",
    sourceClass: "ordinary-price",
    state: "approved",
  };
  const ordinaryPrices = ["bunnpris", "extra", "rema-1000"].map((chainId) => ({
    amountOre: chainId === "extra" ? 2_490 : 2_990,
    chainId,
    contractVersion: 1,
    evidenceLevel: "observed",
    geographicScope: { countryCode: "NO", kind: "national" },
    id: `price:${chainId}:milk`,
    kind: "price-evidence",
    observedAt,
    priceKind: "ordinary",
    productMatch: { canonicalProductId: "product:milk", kind: "exact" },
    sourceId: source.id,
    sourceRecordId: `source-record:price:${chainId}:milk`,
  }));
  const plan = {
    assignments: [{
      canonicalProductId: "product:milk",
      chain: "extra",
      checkout: { ordinaryTotalOre: 2_490, savingOre: 0, totalOre: 2_490 },
      costOre: 2_490,
      ean: GTIN,
      fulfilment: {
        canonicalProductId: "product:milk",
        complete: true,
        contractVersion: 2,
        needId: "milk",
        packageCount: 1,
        packageMeasure: { amount: 1_000, unit: "ml" },
        purchased: { amount: 1, unit: "package" },
        requested: { amount: 1, unit: "package" },
        surplus: { amount: 0, unit: "package" },
      },
      needId: "milk",
      observedAt,
      source: source.id,
    }],
    chains: ["extra"],
    coverage: 1,
    freshness: { milk: "eligible" },
    id: "plan:e2e:extra",
    substitutions: [],
    totalOre: 2_490,
  };
  return {
    caveats: ["Kjedepris dokumenterer ikke lagerstatus."],
    contractVersion: 1,
    evidence: {
      assignmentEvidence: [{
        chainId: "extra",
        conditions: { kind: "ordinary-price" },
        evidenceId: "price:extra:milk",
        needId: "milk",
        planId: plan.id,
      }],
      needs: [{
        comparisonScope: {
          completeness: "complete",
          contractVersion: 1,
          entries: ordinaryPrices.map(({ chainId, id }) => ({
            chainId,
            status: { evidenceId: id, kind: "priced" },
          })),
          evaluatedAt: generatedAt,
          expectedChainIds: ["bunnpris", "extra", "rema-1000"],
        },
        excludedPriceEvidence: [],
        historicalComparisons: [],
        historicalPriceEvidence: [],
        needId: "milk",
        officialOffers: [],
        ordinaryPrices,
      }],
      sources: [source],
    },
    generatedAt,
    plans: [plan],
    priceDataSource: "cache",
    products: [{
      brand: "TINE",
      catalogEvidence: {
        observedAt: catalogObservedAt,
        source,
        sourceRecordId: `source-record:${"a".repeat(64)}`,
      },
      displayName: "TINE Lettmelk 1 l",
      gtin: GTIN,
      packageMeasure: { amount: 1_000, unit: "ml" },
      unitsPerPack: 1,
    }],
  };
}

const strictFixtureResponse = exactProductPlanApiResponseSchemaFor(strictRequest)
  .parse(strictResponse(Date.now()));

test("starts a strict trip and reloads the checklist fully offline", async ({ context, page }) => {
  const response = strictFixtureResponse;
  let postedBody = "";
  await page.addInitScript(({ key, value }) => {
    localStorage.setItem(key, JSON.stringify(value));
  }, { key: BASKET_STORAGE_KEY, value: basket });
  await page.route("**/api/plans", async (route) => {
    postedBody = route.request().postData() ?? "";
    await route.fulfill({
      body: JSON.stringify(response),
      contentType: "application/json",
      status: 200,
    });
  });

  await page.goto("/planlegg/resultat");
  await expect(page.getByRole("radio", { name: /Eneste komplette plan/ })).toBeChecked();
  await expect(page.getByRole("button", { name: "Start Handlemodus" })).toBeVisible();
  expect(JSON.parse(postedBody)).toEqual(strictRequest);
  expect(postedBody).not.toMatch(/LOCAL|query|travel|origin|latitude|longitude/i);

  const cacheAudit = await page.evaluate(async ({ cachePrefix }) => {
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller === null) {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(
          () => reject(new Error("service worker did not claim the result page")),
          10_000,
        );
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          window.clearTimeout(timeout);
          resolve();
        }, { once: true });
      });
    }

    await Promise.allSettled([
      fetch("/api/health"),
      fetch("/planlegg/handle?private=e2e"),
      fetch("/provider/private"),
      fetch("/planlegg/handle", { body: "private=e2e", method: "POST" }),
      fetch(`${location.protocol}//localhost:${location.port}/icons/handleplan.svg`),
    ]);

    const names = (await caches.keys()).filter((name) => name.startsWith(cachePrefix));
    const cacheName = names[0];
    if (cacheName === undefined) throw new Error("Handlemodus cache was not installed");
    const cache = await caches.open(cacheName);
    const requests = await cache.keys();
    const urls = requests.map(({ url }) => new URL(url));
    const handleResponse = await cache.match("/planlegg/handle");
    if (handleResponse === undefined) throw new Error("Handlemodus document was not warmed");
    const html = await handleResponse.text();
    const document = new DOMParser().parseFromString(html, "text/html");
    const expectedStaticPaths = [...new Set(
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
    const cachedPaths = new Set(urls.map(({ pathname }) => pathname));
    return {
      cacheName,
      entryCount: requests.length,
      expectedStaticPaths,
      foreignEntries: urls.filter(({ origin }) => origin !== location.origin).map(String),
      missingStaticPaths: expectedStaticPaths.filter((path) => !cachedPaths.has(path)),
      privateEntries: urls
        .filter(({ pathname, search }) =>
          search !== ""
          || pathname === "/api"
          || pathname.startsWith("/api/")
          || pathname === "/provider"
          || pathname.startsWith("/provider/")
          || pathname === "/providers"
          || pathname.startsWith("/providers/"))
        .map(String),
    };
  }, { cachePrefix: CACHE_PREFIX });

  expect(cacheAudit.cacheName).toBe("handleplan-handlemodus-v2");
  expect(cacheAudit.entryCount).toBeLessThanOrEqual(64);
  expect(cacheAudit.expectedStaticPaths.length).toBeGreaterThan(0);
  expect(cacheAudit.missingStaticPaths).toEqual([]);
  expect(cacheAudit.privateEntries).toEqual([]);
  expect(cacheAudit.foreignEntries).toEqual([]);

  await page.getByRole("button", { name: "Start Handlemodus" }).click();
  const openTrip = page.getByRole("link", { name: "Åpne Handlemodus" });
  await expect(openTrip).toBeVisible();

  await context.setOffline(true);
  await openTrip.click();
  await expect(page).toHaveURL(/\/planlegg\/handle$/);
  await expect(page.getByRole("heading", { name: "Ta handleplanen med i butikken" }))
    .toBeVisible();
  const item = page.getByRole("checkbox", { name: /TINE Lettmelk 1 l/ });
  await expect(item).not.toBeChecked();
  // The checkbox is controlled by the durable IndexedDB write, so its final
  // checked state is intentionally asynchronous rather than native-immediate.
  await item.click();
  await expect(page.getByRole("heading", { name: "1 av 1 varer" })).toBeVisible();

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Ta handleplanen med i butikken" }))
    .toBeVisible();
  await expect(page.getByRole("checkbox", { name: /TINE Lettmelk 1 l/ })).toBeChecked();
  await expect(page.getByRole("heading", { name: "1 av 1 varer" })).toBeVisible();

  await page.getByRole("button", { name: "Fullfør og slett turen" }).click();
  await expect(page.getByRole("heading", { name: "Ingen aktiv handletur" })).toBeVisible();
  await context.setOffline(false);
});
