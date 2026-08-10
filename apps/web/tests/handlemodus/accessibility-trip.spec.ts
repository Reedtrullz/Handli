import { expect, test } from "@playwright/test";

import {
  expectMinimumTargetSize,
  expectNoAutomatedWcag22Violations,
  expectNoHorizontalOverflow,
  expectSemanticHeadingOrder,
} from "../../test-support/accessibility-evidence";
import {
  assertHandlemodusTestApplicationOriginUnavailable,
  installHandlemodusTestFixtures,
  readHandlemodusTestRequestBodies,
  resetHandlemodusTestHarness,
  setHandlemodusTestNetworkOffline,
} from "../../test-support/handlemodus-test-network";
import { strictResultTripFixture } from "../../test-support/strict-result-trip-fixture";

const BASKET_STORAGE_KEY = "handleplan:basket:v4";

function freshStrictFixture() {
  const now = Date.now();
  return strictResultTripFixture({
    catalogObservedAt: new Date(now - 10 * 60_000).toISOString(),
    generatedAt: new Date(now - 60_000).toISOString(),
    ordinaryObservedAt: new Date(now - 5 * 60_000).toISOString(),
    ordinaryValidUntil: new Date(now + 60 * 60_000).toISOString(),
  });
}

function browserBasket() {
  return {
    convenienceWeightBasisPoints: 5_000,
    familyConfirmations: [],
    marketContext: { contractVersion: 1, countryCode: "NO", kind: "national" },
    matchingRules: [{
      exactEan: "7038010000010",
      explanation: "Eksakt syntetisk produkt",
      id: "rule:fixture:milk",
      mode: "exact",
      userApproved: true,
    }],
    needs: [{
      id: "need:milk",
      matchRuleId: "rule:fixture:milk",
      quantity: 1,
      quantityUnit: "each",
      query: "TINE Lettmelk 1 l",
      required: true,
    }],
    products: [{
      brand: "TINE",
      ean: "7038010000010",
      name: "TINE Lettmelk 1 l",
      packageQuantity: 1_000,
      packageUnit: "ml",
    }],
    travel: { enabled: false, mode: "car" },
    version: 4,
  } as const;
}

test.beforeEach(async ({ request }) => {
  await resetHandlemodusTestHarness(request);
});

test.afterEach(async ({ request }) => {
  await resetHandlemodusTestHarness(request);
});

test("Handlemodus remains operable, semantic, and axe-clean when its application origin is unavailable", async ({ page, request }) => {
  const fixture = freshStrictFixture();
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await page.addInitScript(({ key, value }) => {
    localStorage.setItem(key, JSON.stringify(value));
  }, { key: BASKET_STORAGE_KEY, value: browserBasket() });
  await installHandlemodusTestFixtures(request, [{
    body: JSON.stringify(fixture.exactResponse),
    path: "/api/plans",
  }]);

  await page.goto("/planlegg/resultat");
  await expect(page.getByRole("button", { name: "Start Handlemodus" })).toBeVisible();
  const planRequestBodies = await readHandlemodusTestRequestBodies(request, "/api/plans");
  expect(planRequestBodies).toHaveLength(1);
  expect(JSON.parse(planRequestBodies[0]!)).toEqual(fixture.exactRequest);
  await page.getByRole("button", { name: "Start Handlemodus" }).click();
  const openTrip = page.getByRole("link", { name: "Åpne Handlemodus" });
  await expect(openTrip).toBeVisible();
  // Resize before the service-worker-backed app-router transition. Firefox can
  // deadlock a viewport mutation against that in-flight transition even though
  // the resulting page is otherwise healthy.
  await page.setViewportSize({ height: 900, width: 320 });
  await openTrip.click();
  await expect(page).toHaveURL(/\/planlegg\/handle$/);

  await expect(page.getByRole("heading", { name: "Ta handleplanen med i butikken" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "0 av 1 vare", exact: true })).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "0 av 1 vare fullført", exact: true })).toBeVisible();
  await expectSemanticHeadingOrder(page);
  await expectNoHorizontalOverflow(page);
  await expectMinimumTargetSize(page.locator("button, a, label"));
  await expectNoAutomatedWcag22Violations(page);

  const checklistItem = page.getByRole("checkbox", { name: /TINE Lettmelk 1 l/u });
  // The controlled checkbox commits to IndexedDB before React reflects the
  // checked state, so use an ordinary click and await the durable UI result.
  await checklistItem.click();
  await expect(page.getByRole("heading", { name: "1 av 1 vare", exact: true })).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "1 av 1 vare fullført", exact: true })).toBeVisible();

  await setHandlemodusTestNetworkOffline(request, true);
  await assertHandlemodusTestApplicationOriginUnavailable(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Ta handleplanen med i butikken" })).toBeVisible();
  await expect(checklistItem).toBeChecked();
  await expect(page.getByText("Lagret på enheten")).toBeVisible();
  await expectSemanticHeadingOrder(page);
  await expectNoHorizontalOverflow(page);
  await expectNoAutomatedWcag22Violations(page);

  await checklistItem.click();
  await expect(page.getByRole("heading", { name: "0 av 1 vare", exact: true })).toBeVisible();
});
