// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  ExactProductPlanApiRequest,
  ExactProductPlanApiResponse,
  MoneyOre,
  OfficialOffer,
  PlanResultV2,
  ReviewedFamilyPlanApiRequestV2,
  ReviewedFamilyPlanApiResponseV2,
  TravelPlanApiResponse,
} from "@handleplan/domain";
import {
  deriveExactProductPlanDeltaExplanationsV1,
  deriveReviewedFamilyPlanDeltaExplanationsV1,
} from "@handleplan/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BASKET_STORAGE_KEY, type BrowserBasket } from "../../../lib/browser-basket";
import ResultPage from "./page";

const GTIN = "7038010000010";
const GTIN_COFFEE = "7038010000027";
const GENERATED_AT = "2026-07-16T12:00:00.000Z";
const OBSERVED_AT = "2026-07-16T11:00:00.000Z";
const CANDIDATE_SET_ID = `candidate-set:${"a".repeat(64)}`;
const LOCATION_TOKEN = `location-choice:${"z".repeat(43)}`;
const ALTERNATE_LOCATION_TOKEN = `location-choice:${"y".repeat(43)}`;
const EXPECTED_CHAINS = ["bunnpris", "extra", "rema-1000"] as const;
const MARKET_CONTEXT = {
  contractVersion: 1,
  countryCode: "NO",
  kind: "national",
} as const;
type Chain = (typeof EXPECTED_CHAINS)[number];
const money = (value: number) => value as MoneyOre;

const basket: BrowserBasket = {
  version: 4,
  marketContext: MARKET_CONTEXT,
  needs: [{
    id: "milk",
    query: "LOCAL QUERY MUST STAY PRIVATE",
    quantity: 1,
    quantityUnit: "each",
    matchRuleId: "milk-rule",
    required: true,
  }],
  matchingRules: [{
    id: "milk-rule",
    mode: "exact",
    exactEan: GTIN,
    userApproved: true,
    explanation: "LOCAL RULE MUST STAY PRIVATE",
  }],
  products: [{
    ean: GTIN,
    name: "LOCAL PRODUCT MUST STAY PRIVATE",
    brand: "Local brand",
    productFamily: "local-family",
  }],
  convenienceWeightBasisPoints: 5_000,
  enabledMembershipProgramIds: [],
  familyConfirmations: [],
  travel: { enabled: false, mode: "car" },
};

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

const mixedBasket: BrowserBasket = {
  version: 4,
  marketContext: MARKET_CONTEXT,
  needs: [
    {
      id: "coffee",
      query: "LOCAL COFFEE QUERY MUST STAY PRIVATE",
      quantity: 1,
      quantityUnit: "each",
      matchRuleId: "coffee-rule",
      required: true,
    },
    {
      id: "milk",
      query: "LOCAL FAMILY QUERY MUST STAY PRIVATE",
      quantity: 1,
      quantityUnit: "each",
      matchRuleId: "milk-family-rule",
      required: true,
    },
  ],
  matchingRules: [
    {
      exactEan: GTIN_COFFEE,
      explanation: "LOCAL EXACT EXPLANATION MUST STAY PRIVATE",
      id: "coffee-rule",
      mode: "exact",
      userApproved: true,
    },
    {
      explanation: "LOCAL FAMILY EXPLANATION MUST STAY PRIVATE",
      id: "milk-family-rule",
      mode: "flexible",
      productFamily: "family:melk",
      userApproved: true,
    },
  ],
  products: [{
    ean: GTIN_COFFEE,
    name: "LOCAL COFFEE PRODUCT MUST STAY PRIVATE",
    brand: "Local coffee brand",
    productFamily: "local-family",
  }],
  convenienceWeightBasisPoints: 5_000,
  enabledMembershipProgramIds: [],
  familyConfirmations: [{
    candidateCount: 1,
    confirmation: {
      candidateSetId: CANDIDATE_SET_ID,
      taxonomyVersionId: "handleplan-reviewed-families@1.0.0",
      userApproved: true,
    },
    family: {
      aliases: ["mjølk"],
      id: "family:melk",
      labelNo: "LOCAL FAMILY LABEL MUST STAY PRIVATE",
      slug: "melk",
      status: "active",
    },
    matchRuleId: "milk-family-rule",
  }],
  travel: { enabled: false, mode: "car" },
};

const mixedRequest: ReviewedFamilyPlanApiRequestV2 = {
  contractVersion: 2,
  enabledMembershipProgramIds: [],
  marketContext: MARKET_CONTEXT,
  maxStores: 3,
  needs: [
    {
      id: "coffee",
      match: {
        kind: "exact-product",
        product: { kind: "gtin", value: GTIN_COFFEE },
        userApproved: true,
      },
      quantity: 1,
      quantityUnit: "each",
      required: true,
    },
    {
      id: "milk",
      match: {
        confirmation: {
          candidateSetId: CANDIDATE_SET_ID,
          taxonomyVersionId: "handleplan-reviewed-families@1.0.0",
          userApproved: true,
        },
        familyId: "family:melk",
        kind: "reviewed-family",
      },
      quantity: 1,
      quantityUnit: "each",
      required: true,
    },
  ],
};

const source = {
  contractVersion: 1 as const,
  displayName: "Kassalapp",
  id: "kassalapp",
  sourceClass: "ordinary-price" as const,
  state: "approved" as const,
};

const canonicalProduct = {
  brand: "TINE",
  catalogEvidence: {
    observedAt: OBSERVED_AT,
    source,
    sourceRecordId: `source-record:${"a".repeat(64)}`,
  },
  displayName: "Canonical TINE Lettmelk 1 %",
  gtin: GTIN,
  packageMeasure: { amount: 1_000, unit: "ml" as const },
  unitsPerPack: 1,
};

const prices: Record<Chain, number> = {
  bunnpris: 1_990,
  extra: 2_490,
  "rema-1000": 2_290,
};

function priceEvidence(chainId: Chain, amountOre = prices[chainId]) {
  return {
    amountOre: money(amountOre),
    chainId,
    contractVersion: 1 as const,
    evidenceLevel: "observed" as const,
    geographicScope: { countryCode: "NO", kind: "national" as const },
    id: `price:${chainId}`,
    kind: "price-evidence" as const,
    observedAt: OBSERVED_AT,
    priceKind: "ordinary" as const,
    productMatch: { canonicalProductId: "product:milk", kind: "exact" as const },
    sourceId: "kassalapp",
    sourceRecordId: `source-record:price:${chainId}`,
  };
}

function plan(id: string, chain: Chain, totalOre = prices[chain]): PlanResultV2 {
  const total = money(totalOre);
  return {
    assignments: [{
      canonicalProductId: "product:milk",
      chain,
      checkout: { ordinaryTotalOre: total, savingOre: money(0), totalOre: total },
      costOre: total,
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
      observedAt: OBSERVED_AT,
      source: "kassalapp",
    }],
    chains: [chain],
    coverage: 1,
    freshness: { milk: "eligible" },
    id,
    substitutions: [],
    totalOre: total,
  };
}

const defaultPlans = [plan("server-balanced", "rema-1000")];

const equivalentPlans = [
  plan("server-balanced", "rema-1000", 2_290),
  plan("server-convenience", "extra", 2_290),
  plan("server-savings", "bunnpris", 2_290),
];

const publicOffer: OfficialOffer = {
  applicability: {
    channels: ["in-store"],
    contractVersion: 1,
    endsAt: "2026-07-17T12:00:00.000Z",
    geographicScope: { countryCode: "NO", kind: "national" },
    startsAt: "2026-07-15T12:00:00.000Z",
  },
  beforePriceOre: money(2_490),
  capturedAt: OBSERVED_AT,
  chainId: "extra",
  conditions: [{ kind: "public" }],
  contractVersion: 1,
  evidenceLevel: "observed",
  id: "offer:milk",
  kind: "official-offer",
  pricing: { kind: "unit", unitPriceOre: money(1_990) },
  productMatch: { canonicalProductId: "product:milk", kind: "exact" },
  sourceId: "kassalapp",
  sourceRecordId: "source-record:offer:milk",
};

const memberOffer: OfficialOffer = {
  ...publicOffer,
  conditions: [{ kind: "member", programId: "source-neutral-program" }],
  id: "offer:member:milk",
  sourceRecordId: "source-record:offer:member:milk",
};

const offerPlan: PlanResultV2 = {
  ...plan("server-offer", "extra", 1_990),
  assignments: [{
    ...plan("server-offer", "extra", 1_990).assignments[0]!,
    checkout: {
      appliedOfferId: publicOffer.id,
      ordinaryTotalOre: money(2_490),
      savingOre: money(500),
      totalOre: money(1_990),
    },
    officialOffer: {
      capturedAt: publicOffer.capturedAt,
      id: publicOffer.id,
      sourceId: publicOffer.sourceId,
      sourceRecordId: publicOffer.sourceRecordId,
    },
  }],
};

function resultResponse(options: {
  enabledMembershipProgramIds?: string[];
  plans?: PlanResultV2[];
  pricedChains?: Chain[];
  offers?: OfficialOffer[];
} = {}): ExactProductPlanApiResponse {
  const plans = options.plans ?? defaultPlans;
  const pricedChains = options.pricedChains
    ?? (options.plans === undefined
      ? [...EXPECTED_CHAINS]
      : [...new Set(plans.flatMap(({ chains }) => chains))] as Chain[]);
  const offers = options.offers ?? [];
  const response: Omit<ExactProductPlanApiResponse, "planDeltaExplanations"> = {
    caveats: ["Kjedepris dokumenterer ikke lagerstatus."],
    contractVersion: 1,
    enabledMembershipProgramIds: options.enabledMembershipProgramIds ?? [],
    marketContext: MARKET_CONTEXT,
    evidence: {
      assignmentEvidence: plans.flatMap((candidate) => candidate.assignments.map((assignment) => ({
        chainId: assignment.chain,
        conditions: assignment.officialOffer === undefined
          ? { kind: "ordinary-price" as const }
          : { kind: "official-offer" as const, offerId: assignment.officialOffer.id },
        evidenceId: `price:${assignment.chain}`,
        needId: assignment.needId,
        planId: candidate.id,
      }))),
      needs: [{
        comparisonScope: {
          completeness: pricedChains.length === EXPECTED_CHAINS.length ? "complete" : "partial",
          contractVersion: 1,
          entries: EXPECTED_CHAINS.map((chainId) => ({
            chainId,
            status: pricedChains.includes(chainId)
              ? { evidenceId: `price:${chainId}`, kind: "priced" as const }
              : { kind: "unknown" as const, reason: "not-checked" as const },
          })),
          evaluatedAt: GENERATED_AT,
          expectedChainIds: [...EXPECTED_CHAINS],
        },
        excludedPriceEvidence: [],
        historicalComparisons: [],
        historicalPriceEvidence: [],
        needId: "milk",
        officialOffers: offers,
        ordinaryPrices: EXPECTED_CHAINS
          .filter((chain) => pricedChains.includes(chain))
          .map((chain) => {
            const selected = plans
              .flatMap(({ assignments }) => assignments)
              .find(({ chain: assignmentChain }) => assignmentChain === chain);
            const unitPrice = selected === undefined
              ? prices[chain]
              : selected.checkout.ordinaryTotalOre / selected.fulfilment.packageCount;
            return priceEvidence(chain, unitPrice);
          }),
      }],
      sources: [source],
    },
    generatedAt: GENERATED_AT,
    plans,
    priceDataSource: "cache",
    products: [canonicalProduct],
  };
  const planDeltaExplanations = deriveExactProductPlanDeltaExplanationsV1(response);
  if (planDeltaExplanations === undefined) throw new Error("invalid result explanation fixture");
  return { ...response, planDeltaExplanations };
}

function calculatedTravelResponse(
  planning: ExactProductPlanApiResponse = resultResponse(),
): TravelPlanApiResponse {
  const routes = planning.plans.map((candidate, routeIndex) => ({
    aggregate: {
      calculatedAt: planning.generatedAt,
      distanceMeters: 4_200,
      durationSeconds: 720,
      mode: "car" as const,
      providerSourceId: "valhalla-osm",
      routeFingerprint: `route:${routeIndex}:${"r".repeat(32)}`,
    },
    planId: candidate.id,
    stops: candidate.chains.map((chainId, stopIndex) => ({
      branchId: `branch:${chainId}:${routeIndex}`,
      chainId,
      name: `${chainId === "rema-1000" ? "REMA 1000" : chainId === "extra" ? "Extra" : "Bunnpris"} Majorstuen`,
      sequence: stopIndex + 1,
    })),
  }));
  const planDeltaExplanations = deriveExactProductPlanDeltaExplanationsV1({
    ...planning,
    travelRoutes: routes,
  });
  if (planDeltaExplanations === undefined) throw new Error("invalid travel explanation fixture");
  return {
    contractVersion: 1,
    planning: { ...planning, planDeltaExplanations },
    travel: { contractVersion: 1, kind: "calculated", routes },
  };
}

function locationTokenResponse() {
  return {
    contractVersion: 1,
    expiresAt: "2099-07-17T12:05:00.000Z",
    generatedAt: "2099-07-17T12:00:00.000Z",
    selectionToken: LOCATION_TOKEN,
  };
}

function locationSearchResponse(candidates: Array<{
  label: string;
  matchQuality: "exact" | "approximate";
  selectionToken: string;
}>, timestamps: { expiresAt: string; generatedAt: string } = {
  expiresAt: "2099-07-17T12:05:00.000Z",
  generatedAt: "2099-07-17T12:00:00.000Z",
}) {
  return {
    candidates,
    contractVersion: 1,
    expiresAt: timestamps.expiresAt,
    generatedAt: timestamps.generatedAt,
    source: { displayName: "Kartverket", id: "kartverket-geocoder" },
  };
}

const mixedTaxonomy = {
  contentSha256: "1d917ee4268615ad510a622ea30d69977191cffc143313a7dbecbad37debf520",
  contractVersion: 1 as const,
  publishedAt: "2026-07-16T00:00:00.000Z",
  taxonomyId: "handleplan-reviewed-families",
  taxonomyVersion: "1.0.0",
  versionId: "handleplan-reviewed-families@1.0.0",
};

const mixedCatalogSource = {
  contractVersion: 1 as const,
  displayName: "Kontrollert produktkatalog",
  id: "catalog-source",
  sourceClass: "catalog" as const,
  state: "approved" as const,
};

const mixedPriceSource = {
  contractVersion: 1 as const,
  displayName: "Kontrollerte kjedepriser",
  id: "price-source",
  sourceClass: "ordinary-price" as const,
  state: "approved" as const,
};

function mixedProductClaim(
  canonicalProductId: string,
  gtin: string,
  displayName: string,
  brand: string,
) {
  return {
    canonicalProductId,
    product: {
      brand,
      catalogEvidence: {
        observedAt: OBSERVED_AT,
        source: mixedCatalogSource,
        sourceRecordId: `source-record:${(gtin === GTIN_COFFEE ? "b" : "c").repeat(64)}`,
      },
      displayName,
      gtin,
      packageMeasure: gtin === GTIN_COFFEE
        ? { amount: 500, unit: "g" as const }
        : { amount: 1_000, unit: "ml" as const },
      unitsPerPack: 1,
    },
  };
}

function mixedCoverage(evidenceId: string) {
  return {
    completeness: "partial" as const,
    contractVersion: 1 as const,
    entries: [
      { chainId: "bunnpris" as const, status: { kind: "unknown" as const, reason: "not-checked" as const } },
      { chainId: "extra" as const, status: { evidenceId, kind: "priced" as const } },
      { chainId: "rema-1000" as const, status: { kind: "unknown" as const, reason: "not-checked" as const } },
    ],
    evaluatedAt: GENERATED_AT,
    expectedChainIds: [...EXPECTED_CHAINS],
  };
}

function mixedPriceEvidence(
  id: string,
  canonicalProductId: string,
  amountOre: number,
) {
  return {
    amountOre: money(amountOre),
    chainId: "extra" as const,
    contractVersion: 1 as const,
    evidenceLevel: "observed" as const,
    geographicScope: { countryCode: "NO" as const, kind: "national" as const },
    id,
    kind: "price-evidence" as const,
    observedAt: OBSERVED_AT,
    priceKind: "ordinary" as const,
    productMatch: { canonicalProductId, kind: "exact" as const },
    sourceId: mixedPriceSource.id,
    sourceRecordId: `source-record:${id}`,
  };
}

function mixedResultResponse(): ReviewedFamilyPlanApiResponseV2 {
  const coffeeClaim = mixedProductClaim(
    "product:coffee",
    GTIN_COFFEE,
    "Evergood Kaffe fra server",
    "Evergood",
  );
  const milkClaim = mixedProductClaim(
    "product:milk",
    GTIN,
    "TINE Lettmelk fra server",
    "TINE",
  );
  const coffeePrice = mixedPriceEvidence("price:coffee", "product:coffee", 5_000);
  const milkPrice = mixedPriceEvidence("price:milk", "product:milk", 2_500);
  const assignments: PlanResultV2["assignments"] = [
    {
      canonicalProductId: "product:coffee",
      chain: "extra",
      checkout: {
        ordinaryTotalOre: money(5_000),
        savingOre: money(0),
        totalOre: money(5_000),
      },
      costOre: money(5_000),
      ean: GTIN_COFFEE,
      fulfilment: {
        canonicalProductId: "product:coffee",
        complete: true,
        contractVersion: 2,
        needId: "coffee",
        packageCount: 1,
        packageMeasure: { amount: 500, unit: "g" },
        purchased: { amount: 1, unit: "package" },
        requested: { amount: 1, unit: "package" },
        surplus: { amount: 0, unit: "package" },
      },
      needId: "coffee",
      observedAt: OBSERVED_AT,
      source: mixedPriceSource.id,
    },
    {
      canonicalProductId: "product:milk",
      chain: "extra",
      checkout: {
        ordinaryTotalOre: money(2_500),
        savingOre: money(0),
        totalOre: money(2_500),
      },
      costOre: money(2_500),
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
      observedAt: OBSERVED_AT,
      source: mixedPriceSource.id,
    },
  ];

  const response: Omit<ReviewedFamilyPlanApiResponseV2, "planDeltaExplanations"> = {
    caveats: ["Kjedepris dokumenterer ikke lagerstatus."],
    contractVersion: 2,
    enabledMembershipProgramIds: [],
    marketContext: MARKET_CONTEXT,
    evidence: {
      assignmentEvidence: assignments.map((assignment) => ({
        chainId: assignment.chain,
        conditions: { kind: "ordinary-price" },
        evidenceId: assignment.needId === "coffee" ? coffeePrice.id : milkPrice.id,
        needId: assignment.needId,
        planId: "plan-v2:mixed",
      })),
      candidateCoverage: [
        {
          canonicalProductId: "product:coffee",
          comparisonScope: mixedCoverage(coffeePrice.id),
          needId: "coffee",
        },
        {
          canonicalProductId: "product:milk",
          comparisonScope: mixedCoverage(milkPrice.id),
          needId: "milk",
        },
      ],
      excludedPriceEvidence: [],
      memberships: [{
        canonicalProductId: "product:milk",
        confidence: 100,
        decision: "approved",
        decisionId: "family-membership:11",
        familyId: "family:melk",
        method: "human-review",
        reviewedAt: "2026-07-16T10:00:00.000Z",
        reviewerAttested: true,
      }],
      officialOffers: [],
      ordinaryPrices: [coffeePrice, milkPrice],
      sources: [mixedCatalogSource, mixedPriceSource],
    },
    generatedAt: GENERATED_AT,
    needMatches: [
      {
        candidateProductIds: ["product:coffee"],
        kind: "exact-product",
        needId: "coffee",
      },
      {
        candidateProductIds: ["product:milk"],
        candidateSetId: CANDIDATE_SET_ID,
        family: {
          aliases: ["mjølk"],
          id: "family:melk",
          labelNo: "Melk fra server",
          slug: "melk",
          status: "active",
        },
        familyId: "family:melk",
        kind: "reviewed-family",
        needId: "milk",
        taxonomyVersionId: mixedTaxonomy.versionId,
      },
    ],
    plans: [{
      assignments,
      chains: ["extra"],
      coverage: 1,
      freshness: { coffee: "eligible", milk: "eligible" },
      id: "plan-v2:mixed",
      substitutions: ["milk"],
      totalOre: money(7_500),
    }],
    priceDataSource: "cache",
    productClaims: [coffeeClaim, milkClaim],
    taxonomy: mixedTaxonomy,
  };
  const planDeltaExplanations = deriveReviewedFamilyPlanDeltaExplanationsV1(response);
  if (planDeltaExplanations === undefined) throw new Error("invalid mixed explanation fixture");
  return { ...response, planDeltaExplanations };
}

function okFetch(body: unknown = resultResponse()) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    void init;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("Planlegg strict result workspace", () => {
  it("places the Handlemodus handoff beside the verified selected plan summary", async () => {
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(basket));
    vi.stubGlobal("fetch", okFetch(resultResponse({
      plans: [offerPlan],
      pricedChains: ["extra"],
      offers: [publicOffer],
    })));
    render(<ResultPage />);

    const start = await screen.findByRole("button", { name: "Start Handlemodus" });
    const summary = screen.getByText("Anbefalt totalpris").closest("section");
    expect(summary).not.toBeNull();
    expect(summary?.nextElementSibling).toBe(start.closest("section"));
  });

  it("posts only the approved exact identity contract and renders server-owned products/order", async () => {
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(basket));
    const fetch = okFetch();
    vi.stubGlobal("fetch", fetch);
    render(<ResultPage />);

    expect(screen.getByText("Beregner komplette handleplaner …")).toBeVisible();
    expect(await screen.findByRole("radio", { name: /Eneste komplette plan/ })).toBeChecked();
    expect(screen.getByText("Canonical TINE Lettmelk 1 %")).toBeVisible();
    expect(screen.queryByText("LOCAL PRODUCT MUST STAY PRIVATE")).not.toBeInTheDocument();
    expect(screen.getByText("22,90 kr", { selector: ".result-total" })).toBeVisible();
    expect(screen.getByText(/Kun kontrollert, lagret prisgrunnlag/)).toBeVisible();
    expect(screen.getByText(/alle tre kjeder er kontrollert/)).toBeVisible();
    expect(screen.getAllByRole("radio").map((radio) => radio.getAttribute("value"))).toEqual([
      "server-balanced",
    ]);

    const request = fetch.mock.calls[0]![1]!;
    const body = String(request.body);
    expect(JSON.parse(body)).toEqual(strictRequest);
    expect(body).not.toMatch(/query|matchingRules|products|productFamily|explanation|travel|origin|LOCAL/i);
  });

  it("posts only mixed identity confirmations and renders server-owned family substitutions", async () => {
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(mixedBasket));
    const fetch = okFetch(mixedResultResponse());
    vi.stubGlobal("fetch", fetch);
    render(<ResultPage />);

    expect(await screen.findByRole("radio", { name: /Eneste komplette plan/ })).toBeChecked();
    expect(screen.getByText("Evergood Kaffe fra server")).toBeVisible();
    expect(screen.getAllByText("TINE Lettmelk fra server").length).toBeGreaterThan(0);
    expect(screen.getByText("Melk fra server")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Godkjente varebytter" })).toBeVisible();
    expect(screen.getByText(/Valgt blant 1 kontrollert produkt/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Start Handlemodus" })).toBeVisible();
    expect(screen.queryByText(/Ikke tilgjengelig for varebytter/)).not.toBeInTheDocument();
    expect(screen.queryByText(/LOCAL .* MUST STAY PRIVATE/)).not.toBeInTheDocument();

    const posted = String(fetch.mock.calls[0]![1]!.body);
    expect(JSON.parse(posted)).toEqual(mixedRequest);
    expect(posted).not.toMatch(/query|matchingRules|products|productFamily|explanation|travel|origin|LOCAL/i);
  });

  it.each([
    [409, "candidate confirmation changed"],
    [422, "candidate set cannot be planned"],
  ] as const)("requires reviewed-family reapproval when %i means %s", async (status, reason) => {
    void reason;
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(mixedBasket));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      code: status === 409 ? "CANDIDATE_CONFIRMATION_CHANGED" : "NO_FAMILY_CANDIDATES",
      detail: "private server detail",
    }), { status })));
    render(<ResultPage />);

    expect(await screen.findByRole("heading", { name: "Godkjenn varevalget på nytt" })).toBeVisible();
    expect(screen.getByText(/kandidatlisten har endret seg eller kan ikke lenger bekreftes/)).toBeVisible();
    expect(screen.queryByText("private server detail")).not.toBeInTheDocument();
  });

  it("fails closed when a mixed response no longer binds the approved confirmation", async () => {
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(mixedBasket));
    const response = mixedResultResponse();
    vi.stubGlobal("fetch", okFetch({
      ...response,
      needMatches: response.needMatches.map((match) => match.kind === "reviewed-family"
        ? { ...match, candidateSetId: `candidate-set:${"d".repeat(64)}` }
        : match),
    }));
    render(<ResultPage />);

    expect(await screen.findByRole("heading", { name: "Kunne ikke vise handleplanen" })).toBeVisible();
    expect(screen.queryByText("Melk fra server")).not.toBeInTheDocument();
  });

  it("selects directly from returned representatives and persists only the normalized preference", async () => {
    const user = userEvent.setup();
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(basket));
    vi.stubGlobal("fetch", okFetch(resultResponse({ plans: equivalentPlans })));
    const first = render(<ResultPage />);

    await user.click(await screen.findByRole("radio", { name: /Likeverdig alternativ 3/ }));
    expect(screen.getByText("22,90 kr", { selector: ".result-total" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Butikk 1: Bunnpris" })).toBeVisible();
    expect(JSON.parse(localStorage.getItem(BASKET_STORAGE_KEY) ?? "{}")).toMatchObject({
      convenienceWeightBasisPoints: 0,
    });
    first.unmount();

    render(<ResultPage />);
    expect(await screen.findByRole("radio", { name: /Likeverdig alternativ 3/ })).toBeChecked();
  });

  it("renders fulfilment, official checkout savings and immutable offer provenance", async () => {
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(basket));
    vi.stubGlobal("fetch", okFetch(resultResponse({
      plans: [offerPlan],
      pricedChains: ["extra"],
      offers: [publicOffer],
    })));
    render(<ResultPage />);

    expect(await screen.findByText("Før 24,90 kr")).toBeVisible();
    expect(screen.getAllByText("5,00 kr spart").length).toBeGreaterThan(0);
    expect(screen.getByText(/Offisielt tilbud brukt · kilde kassalapp/)).toBeVisible();
    expect(screen.getByText(/1 offisielt tilbud er brukt/)).toBeVisible();
    expect(screen.getByText(/1 pakke dekker hele behovet/)).toBeVisible();
  });

  it("offers only verified membership programs and recomputes when the local choice changes", async () => {
    const user = userEvent.setup();
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(basket));
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const posted = JSON.parse(String(init?.body)) as ExactProductPlanApiRequest;
      return new Response(JSON.stringify(resultResponse({
        enabledMembershipProgramIds: posted.enabledMembershipProgramIds,
        offers: [memberOffer],
      })), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetch);
    render(<ResultPage />);

    const initial = await screen.findByRole("checkbox", {
      name: /Medlemspris hos Extra/,
    });
    expect(initial).not.toBeChecked();
    expect(screen.getByText(/Ingen medlemsprogrammer er valgt automatisk/)).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: "forged-hidden-program" }))
      .not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("source-neutral-program");

    await user.click(initial);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toMatchObject({
      enabledMembershipProgramIds: ["source-neutral-program"],
    });
    expect(JSON.parse(localStorage.getItem(BASKET_STORAGE_KEY) ?? "{}"))
      .toMatchObject({ enabledMembershipProgramIds: ["source-neutral-program"] });
    const enabled = await screen.findByRole("checkbox", {
      name: /Medlemspris hos Extra/,
    });
    expect(enabled).toBeChecked();

    await user.click(enabled);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(JSON.parse(String(fetch.mock.calls[2]![1]?.body))).toMatchObject({
      enabledMembershipProgramIds: [],
    });
    expect(JSON.parse(localStorage.getItem(BASKET_STORAGE_KEY) ?? "{}"))
      .toMatchObject({ enabledMembershipProgramIds: [] });
  });

  it("keeps the selected convenience preference through membership recompute and reload", async () => {
    const user = userEvent.setup();
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(basket));
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const posted = JSON.parse(String(init?.body)) as ExactProductPlanApiRequest;
      return new Response(JSON.stringify(resultResponse({
        enabledMembershipProgramIds: posted.enabledMembershipProgramIds,
        offers: [memberOffer],
        plans: equivalentPlans,
      })), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetch);
    const first = render(<ResultPage />);

    await user.click(await screen.findByRole("radio", { name: /Likeverdig alternativ 3/ }));
    expect(JSON.parse(localStorage.getItem(BASKET_STORAGE_KEY) ?? "{}"))
      .toMatchObject({ convenienceWeightBasisPoints: 0 });

    await user.click(screen.getByRole("checkbox", { name: /Medlemspris hos Extra/ }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(localStorage.getItem(BASKET_STORAGE_KEY) ?? "{}"))
      .toMatchObject({
        convenienceWeightBasisPoints: 0,
        enabledMembershipProgramIds: ["source-neutral-program"],
      });
    first.unmount();

    render(<ResultPage />);
    expect(await screen.findByRole("radio", { name: /Likeverdig alternativ 3/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Medlemspris hos Extra/ })).toBeChecked();
    expect(document.body).not.toHaveTextContent("source-neutral-program");
    expect(JSON.parse(localStorage.getItem(BASKET_STORAGE_KEY) ?? "{}"))
      .toMatchObject({
        convenienceWeightBasisPoints: 0,
        enabledMembershipProgramIds: ["source-neutral-program"],
      });
  });

  it("keeps a saved program without a current offer visible and removable", async () => {
    const user = userEvent.setup();
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify({
      ...basket,
      enabledMembershipProgramIds: ["saved-program"],
    }));
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const posted = JSON.parse(String(init?.body)) as ExactProductPlanApiRequest;
      return new Response(JSON.stringify(resultResponse({
        enabledMembershipProgramIds: posted.enabledMembershipProgramIds,
        offers: [memberOffer],
      })), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetch);
    render(<ResultPage />);

    const saved = await screen.findByRole("checkbox", {
      name: /Lagret medlemsvalg uten aktivt tilbud/,
    });
    expect(saved).toBeChecked();
    expect(screen.getByText(
      "Ingen verifiserte medlemstilbud er tilgjengelige nå. Du kan fjerne valget.",
    )).toBeVisible();
    expect(screen.getByRole("checkbox", { name: /Medlemspris hos Extra/ }))
      .not.toBeChecked();
    expect(document.body).not.toHaveTextContent("saved-program");
    expect(document.body).not.toHaveTextContent("source-neutral-program");

    await user.click(saved);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toMatchObject({
      enabledMembershipProgramIds: [],
    });
    expect(JSON.parse(localStorage.getItem(BASKET_STORAGE_KEY) ?? "{}"))
      .toMatchObject({ enabledMembershipProgramIds: [] });
    await waitFor(() => expect(screen.queryByRole("checkbox", {
      name: /Lagret medlemsvalg uten aktivt tilbud/,
    }))
      .not.toBeInTheDocument());
  });

  it("shows comparison completeness and unresolved chains without inventing absence", async () => {
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(basket));
    vi.stubGlobal("fetch", okFetch(resultResponse({
      plans: [plan("only-extra", "extra")],
      pricedChains: ["extra"],
    })));
    render(<ResultPage />);

    expect(await screen.findByText(/Prisdekning: sammenligningen er delvis/)).toBeVisible();
    expect(screen.getByText(/Uavklart dekning: Bunnpris, REMA 1000/)).toBeVisible();
    expect(screen.queryByText(/ikke ført/i)).not.toBeInTheDocument();
  });

  it.each(["flexible", "constrained"] as const)(
    "never calls the legacy API for a %s basket and requests exact re-approval",
    (mode) => {
      const unsupported: BrowserBasket = {
        ...basket,
        matchingRules: [mode === "flexible"
          ? {
              explanation: "Samme type",
              id: "milk-rule",
              mode,
              productFamily: "milk",
              userApproved: true,
            }
          : {
              allowedBrands: ["Local brand"],
              explanation: "Bare valgt merke",
              id: "milk-rule",
              mode,
              productFamily: "milk",
              userApproved: true,
            }],
        products: [{ ...basket.products[0]!, productFamily: "milk" }],
      };
      localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(unsupported));
      const fetch = okFetch();
      vi.stubGlobal("fetch", fetch);
      render(<ResultPage />);

      expect(screen.getByRole("heading", { name: "Godkjenn varevalget på nytt" })).toBeVisible();
      expect(screen.getByText(/Ingen eldre prisberegning ble brukt/)).toBeVisible();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("does not call the API for a missing or corrupt basket", () => {
    const fetch = okFetch();
    vi.stubGlobal("fetch", fetch);
    localStorage.setItem(BASKET_STORAGE_KEY, "not-json");
    render(<ResultPage />);

    expect(screen.getByRole("heading", { name: "Handlekurven er tom" })).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves a stale-market basket but sends no plan request until explicit reselection", () => {
    const fetch = okFetch();
    vi.stubGlobal("fetch", fetch);
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify({
      ...basket,
      marketContext: {
        contractVersion: 1,
        countryCode: "NO",
        kind: "launch-region",
        regionId: "no-9999-not-launched",
      },
    }));
    render(<ResultPage />);

    expect(screen.getByRole("heading", { name: "Velg prisområde på nytt" })).toBeVisible();
    expect(screen.getByText(/Handlelisten er bevart/)).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps unknown exact products to a truthful re-approval state", async () => {
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(basket));
    const fetch = vi.fn(async () => new Response(JSON.stringify({ code: "UNKNOWN_EXACT_PRODUCT" }), { status: 422 }));
    vi.stubGlobal("fetch", fetch);
    render(<ResultPage />);

    expect(await screen.findByRole("heading", { name: "Varen må godkjennes på nytt" })).toBeVisible();
    expect(screen.getByText(/Ingen eldre prisberegning ble brukt/)).toBeVisible();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("never presents a partial plan when the strict response has no complete plan", async () => {
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(basket));
    vi.stubGlobal("fetch", okFetch(resultResponse({ plans: [], pricedChains: [] })));
    render(<ResultPage />);

    expect(await screen.findByRole("heading", { name: "Ingen komplett handleplan" })).toBeVisible();
    expect(screen.queryByText("Anbefalt totalpris")).not.toBeInTheDocument();
  });

  it("sanitizes 503 failures and retries", async () => {
    const user = userEvent.setup();
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(basket));
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "PRICE_DATA_UNAVAILABLE", detail: "secret" }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(resultResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetch);
    render(<ResultPage />);

    expect(await screen.findByRole("heading", { name: "Prisdata er utilgjengelig" })).toBeVisible();
    expect(screen.queryByText("secret")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Prøv igjen" }));
    expect(await screen.findByRole("radio", { name: /Eneste komplette plan/ })).toBeChecked();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("maps a cancelled server calculation to the unavailable state", async () => {
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(mixedBasket));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      code: "REQUEST_CANCELLED",
      detail: "private cancellation detail",
    }), { status: 499 })));
    render(<ResultPage />);

    expect(await screen.findByRole("heading", { name: "Prisdata er utilgjengelig" })).toBeVisible();
    expect(screen.queryByText("private cancellation detail")).not.toBeInTheDocument();
  });

  it.each([
    ["extra field", (body: ExactProductPlanApiResponse) => ({ ...body, unsafe: true })],
    ["non-cache source", (body: ExactProductPlanApiResponse) => ({ ...body, priceDataSource: "upstream" })],
    ["wrong requested GTIN", (body: ExactProductPlanApiResponse) => ({
      ...body,
      products: [{ ...body.products[0]!, gtin: "7038010000027" }],
    })],
    ["missing assignment evidence", (body: ExactProductPlanApiResponse) => ({
      ...body,
      evidence: { ...body.evidence, assignmentEvidence: [] },
    })],
    ["changed requested quantity", (body: ExactProductPlanApiResponse) => ({
      ...body,
      plans: body.plans.map((candidate) => ({
        ...candidate,
        assignments: candidate.assignments.map((assignment) => ({
          ...assignment,
          fulfilment: {
            ...assignment.fulfilment,
            packageCount: 2,
            purchased: { amount: 2, unit: "package" as const },
            requested: { amount: 2, unit: "package" as const },
          },
        })),
      })),
    })],
  ] as const)("fails closed on request-relative strict inconsistency: %s", async (_label, mutate) => {
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(basket));
    vi.stubGlobal("fetch", okFetch(mutate(resultResponse())));
    render(<ResultPage />);
    expect(await screen.findByRole("heading", { name: "Kunne ikke vise handleplanen" })).toBeVisible();
  });

  it("accepts valid JSON parameters and a multibyte code point split across chunks", async () => {
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(basket));
    const encoded = new TextEncoder().encode(JSON.stringify({ ...resultResponse(), caveats: ["Kjedepris – ærlig"] }));
    const split = encoded.findIndex((byte) => byte === 0xc3) + 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, split));
        controller.enqueue(encoded.slice(split));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, {
      headers: { "content-type": "Application/JSON; profile=\"a\\\"b\"; charset = utf-8" },
    })));
    render(<ResultPage />);
    expect(await screen.findByRole("radio", { name: /Eneste komplette plan/ })).toBeChecked();
    expect(screen.getByText("Kjedepris – ærlig")).toBeVisible();
  });

  it.each(["application/jsonp", "text/application/json", "application/json garbage"])(
    "rejects lookalike media type %s",
    async (contentType) => {
      localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(basket));
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(resultResponse()), {
        headers: { "content-type": contentType },
      })));
      render(<ResultPage />);
      expect(await screen.findByRole("heading", { name: "Kunne ikke vise handleplanen" })).toBeVisible();
    },
  );

  it("cancels an unbounded response stream after 128 KiB", async () => {
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(basket));
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(65_537)); },
      cancel() { cancelled = true; },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, {
      headers: { "content-type": "application/json" },
    })));
    render(<ResultPage />);
    expect(await screen.findByRole("heading", { name: "Kunne ikke vise handleplanen" })).toBeVisible();
    expect(cancelled).toBe(true);
  });

  it("cancels immediately when content-length exceeds 128 KiB", async () => {
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(basket));
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, {
      headers: {
        "content-length": String(128 * 1024 + 1),
        "content-type": "application/json",
      },
    })));
    render(<ResultPage />);
    expect(await screen.findByRole("heading", { name: "Kunne ikke vise handleplanen" })).toBeVisible();
    expect(cancelled).toBe(true);
  });

  it("asks for an explicit opt-in before requesting browser location and renders calculated routes", async () => {
    const user = userEvent.setup();
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(basket));
    let locationAttempt = 0;
    const getCurrentPosition = vi.fn((
      success: PositionCallback,
      error: PositionErrorCallback,
    ) => {
      if (locationAttempt++ > 0) {
        error({ code: 1, message: "private detail", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
        return;
      }
      success({
        coords: {
          accuracy: 10,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          latitude: 59.9139,
          longitude: 10.7522,
          speed: null,
          toJSON: () => ({}),
        },
        timestamp: Date.now(),
        toJSON: () => ({}),
      });
    });
    vi.stubGlobal("navigator", { geolocation: { getCurrentPosition } });
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const path = String(input);
      const body = path === "/api/plans"
        ? resultResponse()
        : path === "/api/locations/current"
          ? locationTokenResponse()
          : path === "/api/plans/travel"
            ? calculatedTravelResponse()
            : undefined;
      return new Response(JSON.stringify(body), {
        status: body === undefined ? 404 : 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetch);
    render(<ResultPage />);

    await screen.findByRole("radio", { name: /Eneste komplette plan/ });
    expect(getCurrentPosition).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Bruk min posisjon" })).not.toBeInTheDocument();
    expect(screen.queryByText("© OpenStreetMap-bidragsytere")).not.toBeInTheDocument();

    await user.click(screen.getByRole("switch", { name: "Beregn" }));
    expect(getCurrentPosition).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Bruk min posisjon" }));

    expect(await screen.findByText("Reisetid er beregnet for de komplette planene under.")).toBeVisible();
    expect(screen.getAllByText("12 min").length).toBeGreaterThan(0);
    expect(screen.getAllByText("4,2 km").length).toBeGreaterThan(0);
    expect(screen.getByText("Estimert reisetid", { selector: "dt" })).toBeVisible();
    expect(screen.getByText("Estimert reisetid: 12 min · 4,2 km · 1 stopp")).toBeVisible();
    expect(screen.getByText("1. REMA 1000 Majorstuen")).toBeVisible();
    expect(screen.getByRole("link", { name: "© OpenStreetMap-bidragsytere" })).toHaveAttribute(
      "href",
      "https://www.openstreetmap.org/copyright",
    );
    const feedback = document.querySelector("[aria-live='polite']");
    expect(feedback).not.toBeNull();
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);
    expect(feedback).not.toContainElement(screen.getByRole("link", { name: "© OpenStreetMap-bidragsytere" }));

    const currentCall = fetch.mock.calls.find(([input]) => String(input) === "/api/locations/current")!;
    expect(JSON.parse(String(currentCall[1]?.body))).toEqual({
      contractVersion: 1,
      coordinate: { latitudeE6: 59_913_900, longitudeE6: 10_752_200 },
    });
    const travelCall = fetch.mock.calls.find(([input]) => String(input) === "/api/plans/travel")!;
    expect(String(travelCall[1]?.body)).not.toMatch(/latitude|longitude|coordinate/i);
    expect(fetch.mock.calls.map(([input]) => String(input)).join(" ")).not.toMatch(/59\.9139|10\.7522|location-choice/);
    expect(localStorage.getItem(BASKET_STORAGE_KEY)).not.toMatch(/59\.9139|10\.7522|location-choice/);

    await user.click(screen.getByRole("button", { name: "Bruk min posisjon" }));
    expect(screen.getByText(/Posisjonen ble ikke delt/)).toBeVisible();
    expect(screen.queryByText("private detail")).not.toBeInTheDocument();
    expect(screen.queryByText("Estimert reisetid", { selector: "dt" })).not.toBeInTheDocument();
    expect(screen.queryByText("© OpenStreetMap-bidragsytere")).not.toBeInTheDocument();
  });

  it("keeps geolocation failures private and leaves the price-only plan intact", async () => {
    const user = userEvent.setup();
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(basket));
    const getCurrentPosition = vi.fn((_success: PositionCallback, error: PositionErrorCallback) => {
      error({ code: 1, message: "private browser detail", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
    });
    vi.stubGlobal("navigator", { geolocation: { getCurrentPosition } });
    const fetch = okFetch();
    vi.stubGlobal("fetch", fetch);
    render(<ResultPage />);

    await user.click(await screen.findByRole("switch", { name: "Beregn" }));
    await user.click(screen.getByRole("button", { name: "Bruk min posisjon" }));

    expect(screen.getByText(/Posisjonen ble ikke delt/)).toBeVisible();
    expect(screen.queryByText("private browser detail")).not.toBeInTheDocument();
    expect(screen.getByText("22,90 kr", { selector: ".result-total" })).toBeVisible();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("© OpenStreetMap-bidragsytere")).not.toBeInTheDocument();
  });

  it("confirms one exact address option, keeps it out of URLs/storage, and posts only the opaque token to travel", async () => {
    const user = userEvent.setup();
    const address = "Storgata 1, 0155 Oslo";
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(basket));
    let searchCount = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const path = String(input);
      const body = path === "/api/plans"
        ? resultResponse()
        : path === "/api/locations/search"
          ? searchCount++ === 0
            ? locationSearchResponse([])
            : searchCount === 2
              ? locationSearchResponse([{
                  label: address,
                  matchQuality: "exact",
                  selectionToken: LOCATION_TOKEN,
                }, {
                  label: "Storgata 10, 0155 Oslo",
                  matchQuality: "approximate",
                  selectionToken: ALTERNATE_LOCATION_TOKEN,
                }])
              : locationSearchResponse([{
                  label: "Karl Johans gate 1, Oslo",
                  matchQuality: "exact",
                  selectionToken: LOCATION_TOKEN,
                }], {
                  expiresAt: "2020-07-17T12:05:00.000Z",
                  generatedAt: "2020-07-17T12:00:00.000Z",
                })
          : path === "/api/plans/travel"
            ? calculatedTravelResponse()
            : undefined;
      return new Response(JSON.stringify(body), {
        status: body === undefined ? 404 : 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const view = render(<ResultPage />);

    await user.click(await screen.findByRole("switch", { name: "Beregn" }));
    const addressInput = screen.getByRole("combobox", { name: /adresse og poststed/ });
    expect(addressInput).toHaveAttribute("autocomplete", "off");
    expect(addressInput).toHaveAttribute("aria-expanded", "false");
    await user.type(addressInput, address);
    await user.click(screen.getByRole("button", { name: "Finn adresse" }));
    expect(await screen.findByText(/Vi fant ingen adresseforslag/)).toBeVisible();
    expect(fetch).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole("button", { name: "Finn adresse" }));
    expect(await screen.findByRole("option", { name: /Storgata 1, 0155 Oslo/ })).toBeVisible();
    expect(screen.getByRole("option", { name: /Storgata 10, 0155 Oslo/ })).toBeVisible();
    expect(addressInput).toHaveAttribute("aria-expanded", "true");
    expect(addressInput).toHaveAttribute("aria-controls", "result-travel-address-options");
    expect(fetch.mock.calls.filter(([input]) => String(input) === "/api/plans/travel"))
      .toHaveLength(0);
    expect(localStorage.getItem(BASKET_STORAGE_KEY)).not.toMatch(/Storgata|location-choice/);
    addressInput.focus();
    await user.keyboard("{ArrowDown}");
    expect(addressInput).toHaveAttribute("aria-activedescendant", "result-travel-address-option-1");
    await user.keyboard("{Enter}");
    expect(await screen.findByText("Reisetid er beregnet for de komplette planene under.")).toBeVisible();

    const searchCall = fetch.mock.calls.find(([input]) => String(input) === "/api/locations/search")!;
    expect(JSON.parse(String(searchCall[1]?.body))).toEqual({ contractVersion: 1, query: address });
    const travelCall = fetch.mock.calls.find(([input]) => String(input) === "/api/plans/travel")!;
    const travelBody = JSON.parse(String(travelCall[1]?.body));
    expect(travelBody).toEqual({
      contractVersion: 1,
      locationSelectionToken: ALTERNATE_LOCATION_TOKEN,
      planning: strictRequest,
      travelMode: "car",
    });
    expect(JSON.stringify(travelBody)).not.toMatch(/Storgata|latitude|longitude|coordinate/i);
    expect(fetch.mock.calls.map(([input]) => String(input)).join(" ")).not.toMatch(/Storgata|location-choice|59\.9139/);
    expect(localStorage.getItem(BASKET_STORAGE_KEY)).not.toMatch(/Storgata|location-choice|59\.9139/);

    const car = screen.getByRole("radio", { name: "Bil" });
    car.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Sykkel" })).toBeChecked();
    await waitFor(() => {
      const travelCalls = fetch.mock.calls.filter(([input]) => String(input) === "/api/plans/travel");
      expect(travelCalls).toHaveLength(2);
      expect(JSON.parse(String(travelCalls[1]![1]?.body))).toMatchObject({ travelMode: "bike" });
    });

    await user.clear(addressInput);
    expect(screen.queryByText("Estimert reisetid", { selector: "dt" })).not.toBeInTheDocument();
    expect(screen.queryByText("© OpenStreetMap-bidragsytere")).not.toBeInTheDocument();
    await user.click(car);
    expect(car).toBeChecked();
    expect(fetch.mock.calls.filter(([input]) => String(input) === "/api/plans/travel")).toHaveLength(2);
    await user.type(addressInput, "Karl Johans gate 1, Oslo");
    await user.click(screen.getByRole("button", { name: "Finn adresse" }));
    await user.click(await screen.findByRole("option", { name: /Karl Johans gate 1, Oslo/ }));
    expect(await screen.findByText(/Startpunktet utløp/)).toBeVisible();
    expect(screen.queryByText("Estimert reisetid", { selector: "dt" })).not.toBeInTheDocument();
    expect(screen.queryByText("© OpenStreetMap-bidragsytere")).not.toBeInTheDocument();
    expect(fetch.mock.calls.filter(([input]) => String(input) === "/api/plans/travel")).toHaveLength(2);

    view.unmount();
    render(<ResultPage />);
    expect(await screen.findByRole("switch", { name: "Beregn" })).not.toBeChecked();
    expect(screen.queryByRole("combobox", { name: /adresse og poststed/ })).not.toBeInTheDocument();
    expect(screen.queryByText("© OpenStreetMap-bidragsytere")).not.toBeInTheDocument();
  });

  it("clears ephemeral origin and route state across pagehide and persisted pageshow", async () => {
    const user = userEvent.setup();
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(basket));
    let travelRequestCount = 0;
    let resolvePendingTravel!: (response: Response) => void;
    let pendingTravelSignal: AbortSignal | undefined;
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/plans") {
        return Promise.resolve(new Response(JSON.stringify(resultResponse()), {
          headers: { "content-type": "application/json" },
        }));
      }
      if (path === "/api/locations/search") {
        const query = JSON.parse(String(init?.body)).query as string;
        return Promise.resolve(new Response(JSON.stringify(locationSearchResponse([{
          label: query,
          matchQuality: "exact",
          selectionToken: LOCATION_TOKEN,
        }])), { headers: { "content-type": "application/json" } }));
      }
      if (path === "/api/plans/travel" && travelRequestCount++ === 0) {
        return Promise.resolve(new Response(JSON.stringify(calculatedTravelResponse()), {
          headers: { "content-type": "application/json" },
        }));
      }
      if (path === "/api/plans/travel") {
        pendingTravelSignal = init?.signal ?? undefined;
        return new Promise<Response>((resolve) => { resolvePendingTravel = resolve; });
      }
      return Promise.resolve(new Response(undefined, { status: 404 }));
    });
    vi.stubGlobal("fetch", fetch);
    const view = render(<ResultPage />);

    await user.click(await screen.findByRole("switch", { name: "Beregn" }));
    const firstAddress = screen.getByRole("combobox", { name: /adresse og poststed/ });
    await user.type(firstAddress, "Storgata 1, Oslo");
    await user.click(screen.getByRole("button", { name: "Finn adresse" }));
    await user.click(await screen.findByRole("option", { name: /Storgata 1, Oslo/ }));
    expect(await screen.findByText("Estimert reisetid", { selector: "dt" })).toBeVisible();

    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(screen.getByRole("switch", { name: "Beregn" })).not.toBeChecked();
    expect(screen.queryByRole("combobox", { name: /adresse og poststed/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Estimert reisetid", { selector: "dt" })).not.toBeInTheDocument();
    expect(screen.queryByText("© OpenStreetMap-bidragsytere")).not.toBeInTheDocument();

    await user.click(screen.getByRole("switch", { name: "Beregn" }));
    const secondAddress = screen.getByRole("combobox", { name: /adresse og poststed/ });
    await user.type(secondAddress, "Karl Johans gate 1, Oslo");
    const ordinaryPageShow = new Event("pageshow");
    Object.defineProperty(ordinaryPageShow, "persisted", { value: false });
    act(() => window.dispatchEvent(ordinaryPageShow));
    expect(screen.getByRole("switch", { name: "Beregn" })).toBeChecked();
    expect(secondAddress).toHaveValue("Karl Johans gate 1, Oslo");

    await user.click(screen.getByRole("button", { name: "Finn adresse" }));
    await user.click(await screen.findByRole("option", { name: /Karl Johans gate 1, Oslo/ }));
    expect(await screen.findByText("Beregner rute …")).toBeVisible();
    expect(pendingTravelSignal).toBeDefined();
    expect(pendingTravelSignal?.aborted).toBe(false);

    const restoredPageShow = new Event("pageshow");
    Object.defineProperty(restoredPageShow, "persisted", { value: true });
    act(() => window.dispatchEvent(restoredPageShow));
    expect(pendingTravelSignal?.aborted).toBe(true);
    expect(screen.getByRole("switch", { name: "Beregn" })).not.toBeChecked();
    expect(screen.queryByRole("combobox", { name: /adresse og poststed/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Beregner rute …")).not.toBeInTheDocument();
    expect(localStorage.getItem(BASKET_STORAGE_KEY)).not.toMatch(/Storgata|Karl Johans|location-choice/);

    await act(async () => resolvePendingTravel(new Response(JSON.stringify(calculatedTravelResponse()), {
      headers: { "content-type": "application/json" },
    })));
    expect(screen.queryByText("Estimert reisetid", { selector: "dt" })).not.toBeInTheDocument();
    expect(screen.queryByText("© OpenStreetMap-bidragsytere")).not.toBeInTheDocument();
    view.unmount();
  });

  it("disables mode changes while a new origin lookup is pending", async () => {
    const user = userEvent.setup();
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(basket));
    let resolveSearch!: (response: Response) => void;
    const fetch = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/plans") {
        return Promise.resolve(new Response(JSON.stringify(resultResponse()), {
          headers: { "content-type": "application/json" },
        }));
      }
      if (path === "/api/locations/search") {
        return new Promise<Response>((resolve) => { resolveSearch = resolve; });
      }
      return Promise.resolve(new Response(undefined, { status: 404 }));
    });
    vi.stubGlobal("fetch", fetch);
    const view = render(<ResultPage />);

    await user.click(await screen.findByRole("switch", { name: "Beregn" }));
    await user.type(screen.getByRole("combobox", { name: /adresse og poststed/ }), "Storgata 1, Oslo");
    await user.click(screen.getByRole("button", { name: "Finn adresse" }));

    expect(screen.getByRole("radio", { name: "Bil" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Sykkel" })).toBeDisabled();
    expect(fetch.mock.calls.filter(([input]) => String(input) === "/api/plans/travel")).toHaveLength(0);

    view.unmount();
    resolveSearch(new Response(JSON.stringify(locationSearchResponse([])), {
      headers: { "content-type": "application/json" },
    }));
  });

  it("uses the latest keyboard preference when a pending travel response arrives", async () => {
    const user = userEvent.setup();
    const planning = resultResponse({ plans: equivalentPlans });
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(basket));
    let resolveTravel!: (response: Response) => void;
    const fetch = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/plans") {
        return Promise.resolve(new Response(JSON.stringify(planning), {
          headers: { "content-type": "application/json" },
        }));
      }
      if (path === "/api/locations/search") {
        return Promise.resolve(new Response(JSON.stringify(locationSearchResponse([{
          label: "Storgata 1, Oslo",
          matchQuality: "exact",
          selectionToken: LOCATION_TOKEN,
        }])), { headers: { "content-type": "application/json" } }));
      }
      if (path === "/api/plans/travel") {
        return new Promise<Response>((resolve) => { resolveTravel = resolve; });
      }
      return Promise.resolve(new Response(undefined, { status: 404 }));
    });
    vi.stubGlobal("fetch", fetch);
    render(<ResultPage />);

    await user.click(await screen.findByRole("switch", { name: "Beregn" }));
    await user.type(screen.getByRole("combobox", { name: /adresse og poststed/ }), "Storgata 1, Oslo");
    await user.click(screen.getByRole("button", { name: "Finn adresse" }));
    await user.click(await screen.findByRole("option", { name: /Storgata 1, Oslo/ }));
    expect(await screen.findByText("Beregner rute …")).toBeVisible();

    const slider = screen.getByRole("slider", { name: /Velg komplett plan/ });
    slider.focus();
    await user.keyboard("{End}");
    expect(screen.getByRole("radio", { name: /Likeverdig alternativ 3/ })).toBeChecked();

    await act(async () => resolveTravel(new Response(JSON.stringify(calculatedTravelResponse(planning)), {
      headers: { "content-type": "application/json" },
    })));
    expect(await screen.findByText("Reisetid er beregnet for de komplette planene under.")).toBeVisible();
    expect(screen.getByRole("radio", { name: /Likeverdig alternativ 3/ })).toBeChecked();
    expect(screen.getByRole("region", { name: "Butikk 1: Bunnpris" })).toBeVisible();
  });

  it("applies a server-authoritative unavailable planning snapshot without implying a route was calculated", async () => {
    const user = userEvent.setup();
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(basket));
    const newerPlanning = resultResponse({ plans: [plan("new-price-only", "extra", 2_590)] });
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      const body = path === "/api/plans"
        ? resultResponse()
        : path === "/api/locations/search"
          ? locationSearchResponse([{
              label: "Storgata 1, Oslo",
              matchQuality: "exact",
              selectionToken: LOCATION_TOKEN,
            }])
          : path === "/api/plans/travel"
            ? {
                contractVersion: 1,
                planning: newerPlanning,
                travel: { contractVersion: 1, kind: "unavailable", reason: "timeout" },
              }
            : undefined;
      return new Response(JSON.stringify(body), {
        status: body === undefined ? 404 : 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetch);
    render(<ResultPage />);

    await user.click(await screen.findByRole("switch", { name: "Beregn" }));
    await user.type(screen.getByRole("combobox", { name: /adresse og poststed/ }), "Storgata 1, Oslo");
    await user.click(screen.getByRole("button", { name: "Finn adresse" }));
    await user.click(await screen.findByRole("option", { name: /Storgata 1, Oslo/ }));

    expect(await screen.findByText(/Ruten tok for lang tid/)).toBeVisible();
    expect(screen.getByText("25,90 kr", { selector: ".result-total" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Butikk 1: Extra" })).toBeVisible();
    expect(screen.queryByText("© OpenStreetMap-bidragsytere")).not.toBeInTheDocument();
    expect(screen.queryByText("Estimert reisetid", { selector: "dt" })).not.toBeInTheDocument();
  });

  it("aborts the request on unmount and ignores a late response", async () => {
    localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(basket));
    let resolve!: (response: Response) => void;
    let signal!: AbortSignal;
    const fetch = vi.fn((_url: string, options: RequestInit) => {
      signal = options.signal as AbortSignal;
      return new Promise<Response>((done) => (resolve = done));
    });
    vi.stubGlobal("fetch", fetch);
    const view = render(<ResultPage />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => resolve(new Response(JSON.stringify(resultResponse()), {
      headers: { "content-type": "application/json" },
      status: 200,
    })));
    expect(screen.queryByText("Anbefalt totalpris")).not.toBeInTheDocument();
  });
});
