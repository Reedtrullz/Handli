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
} from "@handleplan/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BASKET_STORAGE_KEY, type BrowserBasket } from "../../../lib/browser-basket";
import ResultPage from "./page";

const GTIN = "7038010000010";
const GENERATED_AT = "2026-07-16T12:00:00.000Z";
const OBSERVED_AT = "2026-07-16T11:00:00.000Z";
const EXPECTED_CHAINS = ["bunnpris", "extra", "rema-1000"] as const;
type Chain = (typeof EXPECTED_CHAINS)[number];
const money = (value: number) => value as MoneyOre;

const basket: BrowserBasket = {
  version: 2,
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
  travel: { enabled: false, mode: "car" },
};

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
  return {
    caveats: ["Kjedepris dokumenterer ikke lagerstatus."],
    contractVersion: 1,
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

      expect(screen.getByRole("heading", { name: "Velg eksakte varer på nytt" })).toBeVisible();
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
