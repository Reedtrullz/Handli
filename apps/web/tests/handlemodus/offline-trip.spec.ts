import { expect, test } from "@playwright/test";
import {
  deriveExactProductPlanDeltaExplanationsV1,
  exactProductPlanApiEvidenceEnvelopeSchema,
  exactProductPlanApiResponseSchemaFor,
  planResultV2Schema,
  travelPlanApiResponseSchemaFor,
  type ExactProductPlanApiRequest,
} from "@handleplan/domain";

import { reviewedStrictResultTripFixture } from "../../test-support/strict-result-trip-fixture";
import {
  assertHandlemodusTestApplicationOriginUnavailable,
  installHandlemodusTestFixtures,
  readHandlemodusTestRequestBodies,
  resetHandlemodusTestHarness,
  setHandlemodusTestNetworkOffline,
} from "../../test-support/handlemodus-test-network";

const GTIN = "7038010000010";
const BASKET_STORAGE_KEY = "handleplan:basket:v4";
const CACHE_PREFIX = "handleplan-handlemodus-";
const LOCATION_TOKEN = `location-choice:${"a".repeat(43)}`;
const MARKET_CONTEXT = {
  contractVersion: 1,
  countryCode: "NO",
  kind: "national",
} as const;

test.beforeEach(async ({ request }) => {
  await resetHandlemodusTestHarness(request);
});

test.afterEach(async ({ request }) => {
  await resetHandlemodusTestHarness(request);
});

const strictRequest: ExactProductPlanApiRequest = {
  contractVersion: 1,
  enabledMembershipProgramIds: [],
  marketContext: MARKET_CONTEXT,
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
  enabledMembershipProgramIds: [],
  familyConfirmations: [],
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
  marketContext: MARKET_CONTEXT,
  travel: { enabled: false, mode: "car" },
  version: 4,
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
    enabledMembershipProgramIds: [],
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
    marketContext: MARKET_CONTEXT,
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

const strictFixtureDraft = strictResponse(Date.now());
const strictFixtureEvidence = exactProductPlanApiEvidenceEnvelopeSchema.parse(
  strictFixtureDraft.evidence,
);
const strictFixturePlans = strictFixtureDraft.plans.map((plan) => planResultV2Schema.parse(plan));
const strictFixtureExplanations = deriveExactProductPlanDeltaExplanationsV1({
  evidence: strictFixtureEvidence,
  generatedAt: strictFixtureDraft.generatedAt,
  marketContext: MARKET_CONTEXT,
  plans: strictFixturePlans,
});
if (strictFixtureExplanations === undefined) {
  throw new Error("The Handlemodus fixture is not a canonical plan frontier");
}
const strictFixtureResponse = exactProductPlanApiResponseSchemaFor(strictRequest).parse({
  ...strictFixtureDraft,
  evidence: strictFixtureEvidence,
  planDeltaExplanations: strictFixtureExplanations,
  plans: strictFixturePlans,
});

test("starts a strict trip and reloads the checklist with its application origin unavailable", async ({ page, request }) => {
  const response = strictFixtureResponse;
  // Selection tokens are deliberately short-lived. Mint this browser fixture
  // per test instead of inheriting the older observation clock from the
  // otherwise immutable planning fixture.
  const locationGeneratedAt = new Date().toISOString();
  const locationResponse = {
    candidates: [{
      label: "Storgata 1, 0155 Oslo",
      matchQuality: "exact",
      selectionToken: LOCATION_TOKEN,
    }],
    contractVersion: 1,
    expiresAt: new Date(Date.parse(locationGeneratedAt) + 5 * 60_000).toISOString(),
    generatedAt: locationGeneratedAt,
    source: { displayName: "©Kartverket", id: "kartverket-address-api" },
  };
  const travelRequest = {
    contractVersion: 1 as const,
    locationSelectionToken: LOCATION_TOKEN,
    planning: strictRequest,
    travelMode: "car" as const,
  };
  const travelRoutes = [{
    aggregate: {
      calculatedAt: response.generatedAt,
      distanceMeters: 4_200,
      durationSeconds: 720,
      mode: "car" as const,
      providerSourceId: "valhalla-openstreetmap-self-hosted",
      routeFingerprint: "route:offline-e2e",
    },
    planId: response.plans[0]!.id,
    stops: [{
      branchId: "branch:extra:offline-e2e",
      chainId: "extra" as const,
      name: "Extra Sentrum",
      sequence: 1,
    }],
  }];
  const planDeltaExplanations = deriveExactProductPlanDeltaExplanationsV1({
    evidence: response.evidence,
    generatedAt: response.generatedAt,
    marketContext: response.marketContext,
    plans: response.plans,
    travelRoutes,
  });
  if (planDeltaExplanations === undefined) {
    throw new Error("The offline travel fixture is not a canonical frontier");
  }
  const travelResponse = travelPlanApiResponseSchemaFor(travelRequest).parse({
    contractVersion: 1,
    planning: { ...response, planDeltaExplanations },
    travel: {
      contractVersion: 1,
      kind: "calculated",
      routes: travelRoutes,
    },
  });
  await page.addInitScript(({ key, value }) => {
    localStorage.setItem(key, JSON.stringify(value));
  }, { key: BASKET_STORAGE_KEY, value: basket });
  await installHandlemodusTestFixtures(request, [
    { body: JSON.stringify(response), path: "/api/plans" },
    { body: JSON.stringify(locationResponse), path: "/api/locations/search" },
    { body: JSON.stringify(travelResponse), path: "/api/plans/travel" },
  ]);

  await page.goto("/planlegg/resultat");
  await expect(page.getByRole("radio", { name: /Eneste komplette plan/ })).toBeChecked();
  await expect(page.getByRole("button", { name: "Start Handlemodus" })).toBeVisible();
  const planRequestBodies = await readHandlemodusTestRequestBodies(request, "/api/plans");
  expect(planRequestBodies).toHaveLength(1);
  const postedBody = planRequestBodies[0]!;
  expect(JSON.parse(postedBody)).toEqual(strictRequest);
  expect(postedBody).not.toMatch(/LOCAL|query|travel|origin|latitude|longitude/i);

  await page.getByRole("switch", { name: "Beregn" }).click();
  const volunteeredAddress = "Storgata 1, 0155 Oslo";
  await page.getByRole("combobox", { name: /adresse og poststed/i }).fill(volunteeredAddress);
  await page.getByRole("button", { name: "Finn adresse" }).click();
  await page.getByRole("option", { name: /Storgata 1, 0155 Oslo/ }).click();
  await expect(page.getByText(/Reisetid er beregnet/)).toBeVisible();
  const searchRequestBodies = await readHandlemodusTestRequestBodies(
    request,
    "/api/locations/search",
  );
  const travelRequestBodies = await readHandlemodusTestRequestBodies(
    request,
    "/api/plans/travel",
  );
  expect(searchRequestBodies).toHaveLength(1);
  expect(travelRequestBodies).toHaveLength(1);
  const postedSearchBody = searchRequestBodies[0]!;
  const postedTravelBody = travelRequestBodies[0]!;
  expect(JSON.parse(postedSearchBody)).toEqual({
    contractVersion: 1,
    query: volunteeredAddress,
  });
  expect(JSON.parse(postedTravelBody)).toEqual({
    contractVersion: 1,
    locationSelectionToken: LOCATION_TOKEN,
    planning: strictRequest,
    travelMode: "car",
  });
  expect(postedTravelBody).not.toMatch(/Storgata|latitude|longitude|coordinate/i);
  expect(await page.evaluate((key) => localStorage.getItem(key), BASKET_STORAGE_KEY))
    .not.toMatch(/Storgata|location-choice|latitude|longitude/i);

  await page.getByRole("button", { name: "Start Handlemodus" }).click();
  const openTrip = page.getByRole("link", { name: "Åpne Handlemodus" });
  await expect(openTrip).toBeVisible();

  const cacheAudit = await page.evaluate(async ({ cachePrefix }) => {
    await Promise.allSettled([
      fetch("/api/health"),
      fetch("/planlegg/handle?private=e2e"),
      fetch("/provider/private"),
      fetch("/planlegg/handle", { body: "private=e2e", method: "POST" }),
      fetch(`${location.protocol}//localhost:${location.port}/icons/handleplan.svg`),
    ]);

    const names = (await caches.keys()).filter((name) => name.startsWith(cachePrefix));
    const cacheName = names.find((name) => name.endsWith("-shell"));
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

  expect(cacheAudit.cacheName).toBe("handleplan-handlemodus-v4-shell");
  expect(cacheAudit.entryCount).toBeLessThanOrEqual(64);
  expect(cacheAudit.expectedStaticPaths.length).toBeGreaterThan(0);
  expect(cacheAudit.missingStaticPaths).toEqual([]);
  expect(cacheAudit.privateEntries).toEqual([]);
  expect(cacheAudit.foreignEntries).toEqual([]);

  await setHandlemodusTestNetworkOffline(request, true);
  await assertHandlemodusTestApplicationOriginUnavailable(page);
  await openTrip.click();
  await expect(page).toHaveURL(/\/planlegg\/handle$/);
  await expect(page.getByRole("heading", { name: "Ta handleplanen med i butikken" }))
    .toBeVisible();
  await expect(page.getByRole("region", { name: "Extra Sentrum" })).toBeVisible();
  await expect(page.getByText(/Estimert reise med bil: 12 min/)).toBeVisible();
  await expect(page.getByText(/Behov 1 pakke · kjøp 1 pakke/)).toBeVisible();
  await expect(page.getByText(/Forventet 24,90 kr · ordinært 24,90 kr/)).toBeVisible();
  await expect(page.getByText(/kvalifisert ved planlegging/)).toBeVisible();
  await expect(page.getByRole("link", { name: "© OpenStreetMap-bidragsytere" }))
    .toBeVisible();
  const item = page.getByRole("checkbox", { name: /TINE Lettmelk 1 l/ });
  await expect(item).not.toBeChecked();
  // The checkbox is controlled by the durable IndexedDB write, so its final
  // checked state is intentionally asynchronous rather than native-immediate.
  await item.click();
  await expect(page.getByRole("heading", { name: "1 av 1 vare" })).toBeVisible();

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Ta handleplanen med i butikken" }))
    .toBeVisible();
  await expect(page.getByRole("checkbox", { name: /TINE Lettmelk 1 l/ })).toBeChecked();
  await expect(page.getByRole("heading", { name: "1 av 1 vare" })).toBeVisible();

  await page.getByRole("button", { name: "Fullfør og slett turen" }).click();
  await expect(page.getByRole("heading", { name: "Ingen aktiv handletur" })).toBeVisible();
});

test("takes a mixed exact and reviewed-family plan into Handlemodus during an application-origin outage", async ({ page, request }) => {
  const now = Date.now();
  const fixture = reviewedStrictResultTripFixture({
    generatedAt: new Date(now - 60_000).toISOString(),
    observedAt: new Date(now - 5 * 60_000).toISOString(),
    publishedAt: new Date(now - 60 * 60_000).toISOString(),
    reviewedAt: new Date(now - 30 * 60_000).toISOString(),
  });
  const coffeeGtin = fixture.reviewedRequest.needs.find(({ id }) => id === "need:coffee")!;
  if (coffeeGtin.match.kind !== "exact-product") throw new Error("exact fixture need missing");
  const familyNeed = fixture.reviewedRequest.needs.find(({ id }) => id === "need:milk")!;
  if (familyNeed.match.kind !== "reviewed-family") throw new Error("family fixture need missing");
  const mixedBasket = {
    convenienceWeightBasisPoints: 5_000,
    familyConfirmations: [{
      candidateCount: 1,
      confirmation: familyNeed.match.confirmation,
      family: {
        aliases: ["private local alias"],
        id: familyNeed.match.familyId,
        labelNo: "LOCAL FAMILY LABEL MUST STAY PRIVATE",
        slug: "melk",
        status: "active",
      },
      matchRuleId: "milk-family-rule",
    }],
    matchingRules: [
      {
        exactEan: coffeeGtin.match.product.value,
        explanation: "LOCAL EXACT EXPLANATION MUST STAY PRIVATE",
        id: "coffee-rule",
        mode: "exact",
        userApproved: true,
      },
      {
        explanation: "LOCAL FAMILY EXPLANATION MUST STAY PRIVATE",
        id: "milk-family-rule",
        mode: "flexible",
        productFamily: familyNeed.match.familyId,
        userApproved: true,
      },
    ],
    needs: [
      {
        id: "need:coffee",
        matchRuleId: "coffee-rule",
        quantity: 1,
        quantityUnit: "each",
        query: "LOCAL COFFEE QUERY MUST STAY PRIVATE",
        required: true,
      },
      {
        id: "need:milk",
        matchRuleId: "milk-family-rule",
        quantity: 1,
        quantityUnit: "each",
        query: "LOCAL FAMILY QUERY MUST STAY PRIVATE",
        required: true,
      },
    ],
    products: [{
      brand: "Local coffee brand",
      ean: coffeeGtin.match.product.value,
      name: "LOCAL PRODUCT MUST STAY PRIVATE",
      productFamily: "local-family",
    }],
    marketContext: fixture.reviewedResponse.marketContext,
    travel: { enabled: false, mode: "car" },
    version: 4,
  };
  await page.addInitScript(({ key, value }) => {
    localStorage.setItem(key, JSON.stringify(value));
  }, { key: BASKET_STORAGE_KEY, value: mixedBasket });
  await installHandlemodusTestFixtures(request, [{
    body: JSON.stringify(fixture.reviewedResponse),
    path: "/api/plans",
  }]);

  await page.goto("/planlegg/resultat");
  await expect(page.getByRole("heading", { name: "Godkjente varebytter" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start Handlemodus" })).toBeVisible();
  const planRequestBodies = await readHandlemodusTestRequestBodies(request, "/api/plans");
  expect(planRequestBodies).toHaveLength(1);
  const postedBody = planRequestBodies[0]!;
  expect(JSON.parse(postedBody)).toEqual(fixture.reviewedRequest);
  expect(postedBody).not.toMatch(/LOCAL|query|explanation|origin|address|latitude|longitude/i);

  await page.getByRole("button", { name: "Start Handlemodus" }).click();
  const openTrip = page.getByRole("link", { name: "Åpne Handlemodus" });
  await expect(openTrip).toBeVisible();
  await setHandlemodusTestNetworkOffline(request, true);
  await assertHandlemodusTestApplicationOriginUnavailable(page);
  await openTrip.click();
  await expect(page).toHaveURL(/\/planlegg\/handle$/);
  await expect(page.getByText("Evergood Kaffe 500 g")).toBeVisible();
  await expect(page.getByText("TINE Lettmelk 1 l")).toBeVisible();
  await expect(page.getByText(/Godkjent varebytte: Melk/)).toBeVisible();
  await expect(page.getByText(/menneskelig kontroll uten lagret identitet/)).toBeVisible();
  expect(await page.locator("body").innerText()).not.toMatch(/LOCAL .* MUST STAY PRIVATE/);
});
