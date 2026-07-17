import { expect, test, type Page } from "@playwright/test";
import {
  deriveExactProductPlanDeltaExplanationsV1,
  travelPlanApiRequestSchema,
  travelPlanApiResponseSchemaFor,
  type ExactProductPlanApiResponse,
  type TravelPlanApiRequest,
  type TravelPlanApiResponse,
} from "@handleplan/domain";

import {
  expectFourHundredPercentZoomEquivalentReflow,
  expectMinimumTargetSize,
  expectNoAutomatedWcag22Violations,
  expectNoHorizontalOverflow,
  expectSemanticHeadingOrder,
  expectTravelStateAbsentFromWebStorageAndUrl,
} from "../../apps/web/test-support/accessibility-evidence";
import { strictResultTripFixture } from "../../apps/web/test-support/strict-result-trip-fixture";

const BASKET_STORAGE_KEY = "handleplan:basket:v4";
const LOCATION_TOKEN = `location-choice:${"v".repeat(43)}`;

async function addExactProduct(page: Page, query: string, productName: RegExp): Promise<void> {
  const composer = page.getByRole("combobox", { name: "Hva skal du handle?" });
  await composer.fill(query);
  await page.getByRole("option", { name: productName }).click();
}

async function addCompleteFakeBasket(page: Page): Promise<void> {
  await addExactProduct(page, "lettmelk", /TINE Lettmelk/);
  await addExactProduct(page, "kaffe", /Evergood Kaffe/);
  await addExactProduct(page, "brød", /Norsk grovbrød/);
}

async function resizeRenderedText(page: Page, multiplier: number) {
  const stylesheetId = "handleplan-e2e-text-resize";
  const snapshots = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) => {
        const style = window.getComputedStyle(element);
        const ownsText = [...element.childNodes].some((node) =>
          node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()));
        const presentsFormText = element.matches(
          "input:not([type='checkbox']):not([type='radio']):not([type='range']), textarea, select, output",
        );
        return (ownsText || presentsFormText)
          && style.display !== "none"
          && style.visibility !== "hidden"
          && element.getClientRects().length > 0;
      })
      .map((element, index) => {
        const id = String(index);
        element.setAttribute("data-e2e-text-resize", id);
        return {
          fontSize: Number.parseFloat(window.getComputedStyle(element).fontSize),
          id,
          tagName: element.tagName,
          text: element.textContent?.replace(/\s+/gu, " ").trim().slice(0, 80) ?? "",
        };
      })
      .filter(({ fontSize }) => Number.isFinite(fontSize) && fontSize > 0),
  );
  const css = snapshots
    .map(({ fontSize, id }) =>
      `[data-e2e-text-resize="${id}"] { font-size: ${fontSize * multiplier}px !important; }`)
    .join("\n");

  await page.evaluate(({ content, id }) => {
    document.getElementById(id)?.remove();
    const style = document.createElement("style");
    style.id = id;
    style.textContent = content;
    document.head.append(style);
  }, { content: css, id: stylesheetId });
  // Chromium may defer style recalculation until the next rendered frame even
  // though the style sheet is already present in CSSOM.
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));

  const measurements = await page.evaluate((expected) => expected.map((snapshot) => {
    const element = document.querySelector<HTMLElement>(
      `[data-e2e-text-resize="${snapshot.id}"]`,
    );
    if (element === null) return { ...snapshot, after: 0, ratio: 0 };

    const resizedFontSize = Number.parseFloat(window.getComputedStyle(element).fontSize);
    return {
      after: resizedFontSize,
      before: snapshot.fontSize,
      ratio: resizedFontSize / snapshot.fontSize,
      tagName: snapshot.tagName,
      text: snapshot.text,
    };
  }), snapshots);
  const stylesheetAudit = await page.evaluate((id) => {
    const style = document.getElementById(id) as HTMLStyleElement | null;
    const first = document.querySelector<HTMLElement>('[data-e2e-text-resize="0"]');
    return {
      firstAttribute: first?.getAttribute("data-e2e-text-resize") ?? null,
      firstFontSize: first === null ? null : window.getComputedStyle(first).fontSize,
      firstRule: style?.sheet?.cssRules.item(0)?.cssText ?? null,
      ruleCount: style?.sheet?.cssRules.length ?? -1,
      stylePresent: style !== null,
    };
  }, stylesheetId);
  await page.evaluate((id) => {
    document.getElementById(id)?.remove();
    for (const element of document.querySelectorAll<HTMLElement>("[data-e2e-text-resize]")) {
      element.removeAttribute("data-e2e-text-resize");
    }
  }, stylesheetId);

  const ratios = measurements.map(({ ratio }) => ratio);
  return {
    count: ratios.length,
    maximumRatio: Math.max(...ratios),
    minimumRatio: Math.min(...ratios),
    outliers: measurements
      .filter(({ ratio }) => Math.abs(ratio - multiplier) > 0.001)
      .slice(0, 12),
    stylesheetAudit,
  };
}

function partialFixtureBasket() {
  return {
    convenienceWeightBasisPoints: 5_000,
    familyConfirmations: [],
    marketContext: { contractVersion: 1, countryCode: "NO", kind: "national" },
    matchingRules: [{
      exactEan: "7038010000010",
      explanation: "Eksakt produkt valgt i syntetisk nettleserfixture",
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

function calculatedTravelResponse(
  planning: ExactProductPlanApiResponse,
  request: TravelPlanApiRequest,
): TravelPlanApiResponse {
  const routes = planning.plans.map((plan, routeIndex) => ({
    aggregate: {
      calculatedAt: planning.generatedAt,
      distanceMeters: 4_200,
      durationSeconds: 720,
      mode: request.travelMode,
      providerSourceId: "valhalla-openstreetmap-self-hosted",
      routeFingerprint: `route:v1-accessibility:${routeIndex}`,
    },
    planId: plan.id,
    stops: plan.chains.map((chainId, stopIndex) => ({
      branchId: `branch:${chainId}:v1-accessibility:${routeIndex}`,
      chainId,
      name: `${chainId === "rema-1000" ? "REMA 1000" : chainId === "bunnpris" ? "Bunnpris" : "Extra"} sentrum`,
      sequence: stopIndex + 1,
    })),
  }));
  const planDeltaExplanations = deriveExactProductPlanDeltaExplanationsV1({
    evidence: planning.evidence,
    generatedAt: planning.generatedAt,
    marketContext: planning.marketContext,
    plans: planning.plans,
    travelRoutes: routes,
  });
  if (planDeltaExplanations === undefined) {
    throw new Error("The calculated-travel fixture is not a canonical frontier");
  }
  return travelPlanApiResponseSchemaFor(request).parse({
    contractVersion: 1,
    planning: { ...planning, planDeltaExplanations },
    travel: { contractVersion: 1, kind: "calculated", routes },
  });
}

function unavailableTravelResponse(
  planning: ExactProductPlanApiResponse,
  request: TravelPlanApiRequest,
): TravelPlanApiResponse {
  return travelPlanApiResponseSchemaFor(request).parse({
    contractVersion: 1,
    planning,
    travel: { contractVersion: 1, kind: "unavailable", reason: "provider-unavailable" },
  });
}

test.describe("same-origin test stylesheet text-only resize", () => {
  test("Planlegg preserves focus, semantics, targets, and singular Norwegian copy at 200% text-only resize", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ height: 900, width: 640 });
    await page.goto("/planlegg");

    const composer = page.getByRole("combobox", { name: "Hva skal du handle?" });
    await composer.fill("lettmelk");
    await expect(page.getByRole("option", { name: /TINE Lettmelk/ })).toBeVisible();
    await composer.press("ArrowDown");
    await expect(composer).toHaveAttribute("aria-activedescendant", /option-0$/u);
    await composer.press("Escape");
    await expect(composer).toBeFocused();
    await expect(composer).toHaveAttribute("aria-expanded", "false");

    await composer.fill("");
    await composer.fill("lettmelk");
    await expect(page.getByRole("option", { name: /TINE Lettmelk/ })).toBeVisible();
    await composer.press("ArrowDown");
    await composer.press("Enter");
    await expect(page.getByRole("heading", { name: "Din kurv (1 varebehov)" })).toBeVisible();
    const planRail = page.getByRole("complementary", { name: "Din handleplan" });
    await expect(planRail.getByText("Varebehov i kurv", { exact: true })).toBeVisible();
    await expect(planRail.locator("dd").first()).toHaveText("1");

    const resizeEvidence = await resizeRenderedText(page, 2);
    expect(resizeEvidence.count).toBeGreaterThan(0);
    expect(resizeEvidence.minimumRatio, JSON.stringify(resizeEvidence)).toBeCloseTo(2, 5);
    expect(resizeEvidence.maximumRatio, JSON.stringify(resizeEvidence)).toBeCloseTo(2, 5);

    await expectSemanticHeadingOrder(page);
    await expectNoHorizontalOverflow(page);
    await expectMinimumTargetSize(page.locator(".quantity-stepper button, .primary-button, .secondary-button"));
    await expectNoAutomatedWcag22Violations(page);
    const runningAnimations = await page.evaluate(() =>
      document.getAnimations().filter(({ playState }) => playState === "running").length);
    expect(runningAnimations).toBe(0);
  });
});

test("complete results expose both savings-convenience slider endpoints and reflow at the bounded 400% zoom equivalent", async ({ page }) => {
  await page.goto("/planlegg");
  await addCompleteFakeBasket(page);
  await page.getByRole("link", { name: /Finn handleplan/ }).click();

  await expect(page.getByRole("heading", { name: "Handleliste fordelt på butikker" })).toBeVisible();
  await expect(page.getByText("Komplett kurv basert på 3 nødvendige varer.")).toBeVisible();
  const slider = page.getByRole("slider", { name: "Velg komplett plan" });
  await expect(slider).toHaveAttribute("min", "0");
  await expect(slider).toHaveAttribute("max", "2");

  await slider.focus();
  await slider.press("Home");
  await expect(slider).toHaveValue("0");
  await expect(slider).toHaveAttribute("aria-valuetext", /^Enklest, 98,00 kr$/u);
  await expect(page.getByRole("radio", { name: /^Enklest/ })).toBeChecked();
  await expectNoAutomatedWcag22Violations(page);

  await slider.press("End");
  await expect(slider).toHaveValue("2");
  await expect(slider).toHaveAttribute("aria-valuetext", /^Mest spart, 80,00 kr$/u);
  const savingsRadio = page.getByRole("radio", { name: /^Mest spart/ });
  await expect(savingsRadio).toBeChecked();
  await expectNoAutomatedWcag22Violations(page);
  await savingsRadio.focus();
  await savingsRadio.press("ArrowLeft");
  await expect(page.getByRole("radio", { name: /^Balansert/ })).toBeChecked();

  const zoomEvidence = await expectFourHundredPercentZoomEquivalentReflow(page);
  expect(zoomEvidence).toEqual({
    baselineCssPixels: 1_280,
    effectiveCssPixels: 320,
    method: "viewport-equivalent",
    zoomPercent: 400,
  });
  const meaningfulSequence = await page.evaluate(() => {
    const heading = document.querySelector<HTMLElement>(".result-heading");
    const stores = [...document.querySelectorAll<HTMLElement>(".result-store")];
    const rail = document.querySelector<HTMLElement>(".result-rail");
    if (heading === null || stores.length === 0 || rail === null) return undefined;
    const firstStore = stores[0]!;
    const lastStore = stores.at(-1)!;
    return {
      domHeadingBeforeStores: Boolean(
        heading.compareDocumentPosition(firstStore) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
      domStoresBeforeRail: Boolean(
        lastStore.compareDocumentPosition(rail) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
      visualHeadingBeforeStores:
        heading.getBoundingClientRect().top < firstStore.getBoundingClientRect().top,
      visualStoresBeforeRail:
        lastStore.getBoundingClientRect().bottom <= rail.getBoundingClientRect().top,
    };
  });
  expect(meaningfulSequence).toEqual({
    domHeadingBeforeStores: true,
    domStoresBeforeRail: true,
    visualHeadingBeforeStores: true,
    visualStoresBeforeRail: true,
  });
  await expectMinimumTargetSize(page.locator(".plan-option"));
  await expectSemanticHeadingOrder(page);
  await expectNoAutomatedWcag22Violations(page);
});

test("an empty complete-plan frontier is announced without recommending a partial basket", async ({ page }) => {
  await page.goto("/planlegg");
  await addExactProduct(page, "stale", /Stale testvare/);
  await page.getByRole("link", { name: /Finn handleplan/ }).click();

  await expect(page.getByRole("heading", { name: "Ingen komplett handleplan" })).toBeVisible();
  await expect(page.getByText("Ingen delvis plan blir anbefalt.")).toBeVisible();
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expectSemanticHeadingOrder(page);
  await expectNoAutomatedWcag22Violations(page);
});

test("partial price coverage keeps calculated and unavailable travel explicit and out of web storage and URL", async ({ page }) => {
  const fixture = strictResultTripFixture();
  const address = "Eksempelgata 1, 0155 Oslo";
  const travelRequests: string[] = [];
  await page.addInitScript(({ key, value }) => {
    localStorage.setItem(key, JSON.stringify(value));
  }, { key: BASKET_STORAGE_KEY, value: partialFixtureBasket() });
  await page.route("**/api/plans", async (route) => {
    expect(route.request().postDataJSON()).toEqual(fixture.exactRequest);
    await route.fulfill({
      body: JSON.stringify(fixture.exactResponse),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route("**/api/locations/search", async (route) => {
    const generatedAt = new Date().toISOString();
    await route.fulfill({
      body: JSON.stringify({
        candidates: [{
          label: address,
          matchQuality: "exact",
          selectionToken: LOCATION_TOKEN,
        }],
        contractVersion: 1,
        expiresAt: new Date(Date.parse(generatedAt) + 5 * 60_000).toISOString(),
        generatedAt,
        source: { displayName: "Kartverket fixture", id: "kartverket-address-api" },
      }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route("**/api/plans/travel", async (route) => {
    travelRequests.push(route.request().postData() ?? "");
    const request = travelPlanApiRequestSchema.parse(route.request().postDataJSON());
    const response = travelRequests.length === 1
      ? calculatedTravelResponse(fixture.exactResponse, request)
      : unavailableTravelResponse(fixture.exactResponse, request);
    await route.fulfill({ body: JSON.stringify(response), contentType: "application/json", status: 200 });
  });

  await page.goto("/planlegg/resultat");
  await expect(page.getByText("Komplett kurv basert på 1 nødvendig vare.")).toBeVisible();
  await expect(page.getByText("1 nødvendig vare er med")).toBeVisible();
  await expect(page.getByText(/1 nødvendige varer/u)).toHaveCount(0);
  await expect(page.getByText(/Prisdekning: sammenligningen er delvis/u)).toBeVisible();
  await expect(page.getByRole("slider", { name: "Velg komplett plan" })).toBeDisabled();
  await expectNoAutomatedWcag22Violations(page);

  await page.getByRole("switch", { name: "Beregn" }).click();
  await page.getByRole("combobox", { name: /adresse og poststed/i }).fill(address);
  await page.getByRole("button", { name: "Finn adresse" }).click();
  await page.getByRole("option", { name: /Eksempelgata 1, 0155 Oslo/ }).click();
  await expect(page.getByText("Reisetid er beregnet for de komplette planene under.")).toBeVisible();
  await expect(page.getByText(/Estimert reisetid: 12 min · 4,2 km/u).first()).toBeVisible();
  await expect(page.locator(".travel-feedback")).toHaveAttribute("aria-live", "polite");
  await expect(page.locator(".travel-feedback")).toHaveAttribute("aria-atomic", "true");
  await expectTravelStateAbsentFromWebStorageAndUrl(page, [address, LOCATION_TOKEN, "59.9139"]);
  expect(travelRequests[0]).not.toMatch(/Eksempelgata|latitude|longitude|coordinate/u);
  await expectNoAutomatedWcag22Violations(page);

  await page.getByRole("radio", { name: "Sykkel" }).check();
  await expect(page.getByText("Rutetjenesten er utilgjengelig. Prisplanen vises fortsatt.")).toBeVisible();
  await expect(page.locator(".result-total")).toHaveText("24,90 kr");
  expect(travelRequests[1]).not.toMatch(/Eksempelgata|latitude|longitude|coordinate/u);
  await expectTravelStateAbsentFromWebStorageAndUrl(page, [address, LOCATION_TOKEN, "59.9139"]);
  await expectNoAutomatedWcag22Violations(page);
});

test("Oppdag separates price claims at the 320px reflow proxy for the bounded 400% zoom equivalent", async ({ page }) => {
  await page.goto("/oppdag");
  const zoomEvidence = await expectFourHundredPercentZoomEquivalentReflow(page);
  expect(zoomEvidence.zoomPercent).toBe(400);
  expect(zoomEvidence.effectiveCssPixels).toBe(320);

  await expect(page.getByRole("heading", { name: "Oppdag", exact: true })).toBeVisible();
  await expect(page.getByText("Laveste viste ordinærpris • Bunnpris")).toBeVisible();
  await expect(page.getByText(/Ordinærpris, offisielt tilbud og historisk sammenligning er tre forskjellige påstander/u)).toBeVisible();
  await expect(page.getByText(/Den er ikke butikkens førpris og kalles ikke rabatt/u)).toBeVisible();
  const results = page.locator(".discovery-results");
  await expect(results).toHaveAttribute("aria-live", "polite");

  const extra = page.getByRole("button", { name: "Extra", exact: true });
  await extra.click();
  await expect(extra).toBeFocused();
  await expect(extra).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "Prisgrunnlag hos Extra" })).toBeVisible();
  const offers = page.getByRole("button", { name: "Offisielle tilbud", exact: true });
  await offers.click();
  await expect(offers).toHaveAttribute("aria-pressed", "true");

  await expectNoHorizontalOverflow(page);
  await expectMinimumTargetSize(page.locator(".chain-tabs button, .discovery-type-tabs button, .primary-button, .secondary-button"));
  await expectSemanticHeadingOrder(page);
  await expectNoAutomatedWcag22Violations(page);
});

test("private review Access boundary is a sanitized axe-clean 404 without bypassing authentication", async ({ page }) => {
  const response = await page.goto("/review");

  expect(response).not.toBeNull();
  expect(response!.status()).toBe(404);
  expect(response!.headers()["cache-control"]).toBe("private, no-store");
  expect(response!.headers()["content-language"]).toBe("nb");
  expect(response!.headers()["content-type"]).toContain("text/html");
  expect(response!.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  await expect(page).toHaveTitle("Siden finnes ikke | Handleplan");
  await expect(page.getByRole("heading", { level: 1, name: "Siden finnes ikke" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(
    /privat arbeidsflate|tilbud til vurdering|kildeutsnitt|review-candidate/iu,
  );
  await expectSemanticHeadingOrder(page);
  await expectNoHorizontalOverflow(page);
  await expectNoAutomatedWcag22Violations(page);
});

test("Oppdag and public family inspection expose sanitized alert states", async ({ page }) => {
  await page.route("**/api/discovery/search**", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ error: { code: "UNAVAILABLE" } }),
      contentType: "application/json",
      status: 503,
    });
  });
  await page.goto("/oppdag");
  await expect(page.locator(".discovery-message[role='alert']"))
    .toContainText("Kunne ikke hente katalogen akkurat nå.");
  await expectNoAutomatedWcag22Violations(page);

  await page.unroute("**/api/discovery/search**");
  await page.route("**/api/plan-candidates", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ error: { code: "UPSTREAM_PRIVATE_DETAIL", detail: "must not render" } }),
      contentType: "application/json",
      status: 503,
    });
  });
  await page.goto("/planlegg");
  await page.getByRole("button", { name: "Se gjennom alternativer" }).click();
  const alert = page.locator(".family-composer [role='alert']");
  await expect(alert).toHaveText("Kandidatgrunnlaget er utilgjengelig akkurat nå. Prøv igjen senere.");
  await expect(alert).not.toContainText("UPSTREAM_PRIVATE_DETAIL");
  await expectNoAutomatedWcag22Violations(page);
});
