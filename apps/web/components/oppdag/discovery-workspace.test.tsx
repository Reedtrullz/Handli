// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  publicDiscoveryResponseSchema,
  type PublicDiscoveryResponse,
} from "@handleplan/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addExactProductToBasket,
  BASKET_STORAGE_KEY,
  emptyBasketV4,
  saveBasket,
} from "../../lib/browser-basket";
import {
  DiscoveryWorkspace,
  searchDiscoveryFromApi,
  type DiscoverySearch,
} from "./discovery-workspace";

const GENERATED_AT = "2026-07-15T10:00:00.000Z";
const MARKET_CONTEXT = {
  contractVersion: 1,
  countryCode: "NO",
  kind: "national",
} as const;
const catalogSource = {
  contractVersion: 1 as const,
  displayName: "Kassalapp",
  id: "kassalapp",
  sourceClass: "ordinary-price" as const,
  state: "approved" as const,
};
const offerSource = {
  contractVersion: 1 as const,
  displayName: "Extra kundeavis",
  id: "kundeavis",
  sourceClass: "offer" as const,
  state: "approved" as const,
};
const dairyCategory = {
  depth: 1,
  id: `category:${"c".repeat(64)}`,
  name: "Meieri",
  sourceId: catalogSource.id,
} as const;

function evidence(
  id: string,
  canonicalProductId: string,
  chainId: "bunnpris" | "extra" | "rema-1000",
  amountOre: number,
  observedAt: string,
) {
  return {
    amountOre,
    chainId,
    contractVersion: 1 as const,
    evidenceLevel: "observed" as const,
    geographicScope: { countryCode: "NO", kind: "national" as const },
    id,
    kind: "price-evidence" as const,
    observedAt,
    priceKind: "ordinary" as const,
    productMatch: { canonicalProductId, kind: "exact" as const },
    sourceId: catalogSource.id,
    sourceRecordId: `record:${id}`,
  };
}

function fixtureResponse(): PublicDiscoveryResponse {
  const canonicalProductId = "product:milk";
  const currentRema = evidence(
    "price:milk:rema",
    canonicalProductId,
    "rema-1000",
    2_390,
    "2026-07-15T09:00:00.000Z",
  );
  const currentExtra = evidence(
    "price:milk:extra",
    canonicalProductId,
    "extra",
    2_590,
    "2026-07-15T09:00:00.000Z",
  );
  const history = Array.from({ length: 7 }, (_, index) => evidence(
    `history:milk:${index + 1}`,
    canonicalProductId,
    "rema-1000",
    2_990,
    `2026-07-${String(index + 1).padStart(2, "0")}T09:00:00.000Z`,
  ));
  const bunnpris = evidence(
    "price:bunnpris",
    "product:bunnpris",
    "bunnpris",
    2_490,
    "2026-07-15T09:00:00.000Z",
  );

  return publicDiscoveryResponseSchema.parse({
    contractVersion: 1,
    generatedAt: GENERATED_AT,
    marketContext: MARKET_CONTEXT,
    observedCategories: {
      completeness: "partial",
      facets: [{ ...dairyCategory, productCount: 1 }],
      hasMore: false,
      kind: "observed-category-directory",
    },
    page: {
      hasMore: false,
      kind: "bounded-catalog-slice",
      pageSize: 8,
      scannedCatalogProducts: 2,
    },
    priceDataSource: "cache",
    products: [{
      canonicalProductId,
      catalog: {
        brand: "TINE",
        catalogEvidence: {
          observedAt: "2026-07-15T09:15:00.000Z",
          source: catalogSource,
          sourceRecordId: `source-record:${"a".repeat(64)}`,
        },
        displayName: "TINE Lettmelk 1 % 1 l",
        gtin: "7038010000010",
        packageMeasure: { amount: 1_000, unit: "ml" },
        unitsPerPack: 1,
      },
      categoryPath: [dairyCategory],
      comparisonScope: {
        completeness: "partial",
        contractVersion: 1,
        entries: [
          { chainId: "bunnpris", status: { kind: "unknown", reason: "not-checked" } },
          { chainId: "extra", status: { evidenceId: currentExtra.id, kind: "priced" } },
          { chainId: "rema-1000", status: { evidenceId: currentRema.id, kind: "priced" } },
        ],
        evaluatedAt: GENERATED_AT,
        expectedChainIds: ["bunnpris", "extra", "rema-1000"],
      },
      excludedPriceEvidence: [],
      historicalComparisons: [{
        baselineMethod: "median-30d",
        baselineOre: 2_990,
        canonicalProductId,
        chainId: "rema-1000",
        contractVersion: 1,
        currentEvidenceId: currentRema.id,
        currentOre: 2_390,
        derivedAt: GENERATED_AT,
        distinctObservationDays: 7,
        id: "comparison:milk:rema",
        kind: "historical-comparison",
        savingsBasisPoints: 2_006,
        savingsOre: 600,
        sourceEvidenceIds: history.map(({ id }) => id),
        windowEndsAt: currentRema.observedAt,
        windowStartsAt: "2026-06-15T09:00:00.000Z",
      }],
      historicalPriceEvidence: history,
      officialOffers: [{
        applicability: {
          channels: ["in-store"],
          contractVersion: 1,
          endsAt: "2026-07-18T21:59:59.000Z",
          geographicScope: { countryCode: "NO", kind: "national" },
          startsAt: "2026-07-14T00:00:00.000Z",
        },
        beforePriceOre: 2_990,
        capturedAt: "2026-07-15T09:00:00.000Z",
        chainId: "extra",
        conditions: [{ kind: "public" }],
        contractVersion: 1,
        evidenceLevel: "authoritative",
        id: "offer:milk:extra",
        kind: "official-offer",
        pricing: { kind: "unit", unitPriceOre: 1_990 },
        productMatch: { canonicalProductId, kind: "exact" },
        sourceId: offerSource.id,
        sourceRecordId: "offer-record:milk:extra",
      }],
      ordinaryPrices: [currentRema, currentExtra],
    }, {
      canonicalProductId: "product:bunnpris",
      catalog: {
        brand: "Butikk",
        catalogEvidence: {
          observedAt: "2026-07-15T09:15:00.000Z",
          source: catalogSource,
          sourceRecordId: `source-record:${"b".repeat(64)}`,
        },
        displayName: "Lettmelk Bunnpris",
        gtin: "7038010000027",
        packageMeasure: { amount: 1, unit: "package" },
        unitsPerPack: 1,
      },
      categoryPath: [],
      comparisonScope: {
        completeness: "partial",
        contractVersion: 1,
        entries: [
          { chainId: "bunnpris", status: { evidenceId: bunnpris.id, kind: "priced" } },
          { chainId: "extra", status: { kind: "unknown", reason: "not-checked" } },
          { chainId: "rema-1000", status: { kind: "unknown", reason: "not-checked" } },
        ],
        evaluatedAt: GENERATED_AT,
        expectedChainIds: ["bunnpris", "extra", "rema-1000"],
      },
      excludedPriceEvidence: [],
      historicalComparisons: [],
      historicalPriceEvidence: [],
      officialOffers: [],
      ordinaryPrices: [bunnpris],
    }],
    selection: { chain: "all", resultType: "all" },
    sources: [catalogSource, offerSource],
  });
}

const response = fixtureResponse();

function discoveryRequest(overrides: Partial<Parameters<DiscoverySearch>[0]> = {}) {
  return {
    chain: "all" as const,
    contractVersion: 1 as const,
    marketContext: MARKET_CONTEXT,
    pageSize: 8,
    resultType: "all" as const,
    ...overrides,
  };
}

function responseForRequest(
  request: Parameters<DiscoverySearch>[0],
  base: PublicDiscoveryResponse = response,
): PublicDiscoveryResponse {
  const chainMatches = (chainId: string) => request.chain === "all" || chainId === request.chain;
  const products = base.products.filter((product) => {
    if (
      request.categoryId !== undefined
      && product.categoryPath?.some(({ id }) => id === request.categoryId) !== true
    ) return false;
    const prices = product.ordinaryPrices.filter(({ chainId }) => chainMatches(chainId));
    const offers = product.officialOffers.filter(({ chainId }) => chainMatches(chainId));
    const priceIds = new Set(prices.map(({ id }) => id));
    const comparisons = product.historicalComparisons.filter(
      ({ chainId, currentEvidenceId }) => chainMatches(chainId) && priceIds.has(currentEvidenceId),
    );
    if (request.resultType === "official-offer") return offers.length > 0;
    if (request.resultType === "historical-comparison") return comparisons.length > 0;
    return request.chain === "all" || prices.length > 0 || offers.length > 0;
  });
  const neededSourceIds = new Set(products.flatMap((product) => [
    product.catalog.catalogEvidence.source.id,
    ...product.ordinaryPrices.map(({ sourceId }) => sourceId),
    ...product.historicalPriceEvidence.map(({ sourceId }) => sourceId),
    ...product.excludedPriceEvidence.map(({ sourceId }) => sourceId),
    ...product.officialOffers.map(({ sourceId }) => sourceId),
  ]));
  return publicDiscoveryResponseSchema.parse({
    ...base,
    marketContext: request.marketContext,
    page: { ...base.page, pageSize: request.pageSize },
    products,
    selection: {
      ...(request.categoryId === undefined ? {} : { categoryId: request.categoryId }),
      chain: request.chain,
      ...(request.query === undefined ? {} : { query: request.query }),
      resultType: request.resultType,
    },
    sources: base.sources.filter(({ id }) => neededSourceIds.has(id)),
  });
}

function successfulSearch(base: PublicDiscoveryResponse = response) {
  return vi.fn<DiscoverySearch>(async (request) => responseForRequest(request, base));
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Oppdag discovery workspace", () => {
  it("separates ordinary prices, valid historical comparisons, and official offers", async () => {
    const search = successfulSearch();
    render(<DiscoveryWorkspace searchDiscovery={search} storage={memoryStorage()} />);

    expect(await screen.findByRole("heading", { name: "TINE Lettmelk 1 % 1 l" })).toBeVisible();
    expect(search).toHaveBeenCalledWith(
      discoveryRequest(),
      expect.any(AbortSignal),
    );
    expect(screen.getByText(/Manglende kjeder vises som uavklart/)).toBeVisible();
    expect(screen.getByRole("region", { name: "Offisielt tilbud hos Extra" })).toBeVisible();
    expect(screen.getByText("Oppgitt førpris: 29,90 kr")).toBeVisible();
    expect(screen.getByText("Spar 10,00 kr (33,4 %) basert på tilbudets oppgitte førpris.")).toBeVisible();
    expect(screen.getByText(/Gjelder fra 14\. juli 2026 til 18\. juli 2026 • Hele Norge • i butikk/)).toBeVisible();
    expect(screen.getByText(/Fanget .* • Extra kundeavis/)).toBeVisible();
    expect(screen.getAllByText(/Historisk median \(30 dager\): 29,90 kr/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Nå: 23,90 kr — 6,00 kr lavere enn historisk median \(20,1 %\)/)).toBeVisible();
    expect(screen.getAllByText(/Ordinærpris • Kassalapp/).length).toBe(3);
    expect(screen.getByText(/Delvis dekning\. Uavklart: Bunnpris/)).toBeVisible();
    expect(screen.getAllByText(/Katalog: Kassalapp • observert/).length).toBe(2);
    expect(screen.getByText("Observert kildekategori: Meieri • kilde: Kassalapp.")).toBeVisible();
    expect(screen.getByText("Observert kildekategori: Kassalapp oppga ingen kategori.")).toBeVisible();
    expect(screen.getByText(/ikke en komplett butikktaksonomi/i)).toBeVisible();
    expect(screen.getByText(/kontrollert lokal cache/)).toBeVisible();
    expect(screen.getByText(/Manglende historisk sammenligning betyr ikke at prisen er uendret/)).toBeVisible();
    expect(document.body.textContent).not.toMatch(/tidligere observert|upstream/i);
  });

  it("shows a member offer by verified chain without exposing its opaque eligibility ID", async () => {
    const opaqueProgramId = "opaque-extra-membership-key";
    const firstProduct = response.products[0]!;
    const memberResponse = publicDiscoveryResponseSchema.parse({
      ...response,
      products: [{
        ...firstProduct,
        officialOffers: firstProduct.officialOffers.map((offer) => ({
          ...offer,
          conditions: [{ kind: "member", programId: opaqueProgramId }],
        })),
      }, ...response.products.slice(1)],
    });

    render(<DiscoveryWorkspace
      searchDiscovery={successfulSearch(memberResponse)}
      storage={memoryStorage()}
    />);

    expect(await screen.findByText(
      "Medlemspris hos Extra – medlemskap kreves",
    )).toBeVisible();
    expect(document.body).not.toHaveTextContent(opaqueProgramId);
    expect(screen.getByRole("region", { name: "Offisielt tilbud hos Extra" }))
      .toBeVisible();
  });

  it("filters by chain using actual ordinary prices or official offers", async () => {
    const user = userEvent.setup();
    render(<DiscoveryWorkspace
      searchDiscovery={successfulSearch()}
      storage={memoryStorage()}
    />);
    await screen.findByRole("heading", { name: "TINE Lettmelk 1 % 1 l" });

    await user.click(screen.getByRole("button", { name: "Bunnpris" }));
    expect(screen.getByRole("button", { name: "Bunnpris" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { name: "Prisgrunnlag hos Bunnpris" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "TINE Lettmelk 1 % 1 l" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Lettmelk Bunnpris" })).toBeVisible();
    expect(screen.getByText(/Ordinærpris • Kassalapp/)).toBeVisible();
  });

  it("browses official offers and historical comparisons as distinct claim types", async () => {
    const user = userEvent.setup();
    render(<DiscoveryWorkspace
      searchDiscovery={successfulSearch()}
      storage={memoryStorage()}
    />);
    await screen.findByRole("heading", { name: "TINE Lettmelk 1 % 1 l" });

    await user.click(screen.getByRole("button", { name: "Offisielle tilbud" }));
    expect(screen.getByRole("button", { name: "Offisielle tilbud" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("region", { name: "Offisielt tilbud hos Extra" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Historisk prissammenligning hos REMA 1000" }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Lettmelk Bunnpris" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Historiske sammenligninger" }));
    expect(screen.getByRole("button", { name: "Historiske sammenligninger" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("region", { name: "Historisk prissammenligning hos REMA 1000" }))
      .toBeVisible();
    expect(screen.getByText(/Dette er ikke butikkens førpris/)).toBeVisible();
    expect(screen.queryByRole("region", { name: "Offisielt tilbud hos Extra" }))
      .not.toBeInTheDocument();
  });

  it("explains when a store has no ordinary price or official offer", async () => {
    const user = userEvent.setup();
    const onlyMilk = publicDiscoveryResponseSchema.parse({
      ...response,
      products: [response.products[0]],
    });
    render(<DiscoveryWorkspace
      searchDiscovery={successfulSearch(onlyMilk)}
      storage={memoryStorage()}
    />);

    await user.click(await screen.findByRole("button", { name: "Bunnpris" }));
    expect(screen.getByText("Ingen ordinærpriser eller offisielle tilbud er tilgjengelige fra Bunnpris akkurat nå.")).toBeVisible();
  });

  it("keeps search optional and can return to catalog browsing", async () => {
    const user = userEvent.setup();
    const search = successfulSearch();
    render(<DiscoveryWorkspace searchDiscovery={search} storage={memoryStorage()} />);
    await screen.findByRole("heading", { name: "Varekatalog og prisgrunnlag" });

    await user.type(screen.getByLabelText("Filtrer varene (valgfritt)"), "kaffe");
    await user.click(screen.getByRole("button", { name: "Søk" }));
    await waitFor(() => expect(search).toHaveBeenLastCalledWith(
      discoveryRequest({ query: "kaffe" }),
      expect.any(AbortSignal),
    ));
    expect(screen.getByRole("heading", { name: "Treff for «kaffe»" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Fjern søk eller kategori" }));
    await waitFor(() => expect(search).toHaveBeenLastCalledWith(
      discoveryRequest(),
      expect.any(AbortSignal),
    ));
    expect(screen.getByRole("heading", { name: "Varekatalog og prisgrunnlag" })).toBeVisible();
  });

  it("filters by an opaque observed category without combining it with text search", async () => {
    const user = userEvent.setup();
    const search = successfulSearch();
    render(<DiscoveryWorkspace searchDiscovery={search} storage={memoryStorage()} />);

    const select = await screen.findByLabelText("Observert kategori (valgfritt)");
    expect(screen.getByRole("option", {
      name: "Meieri • kilde: Kassalapp • 1 vare",
    })).toBeVisible();
    await user.selectOptions(select, dairyCategory.id);

    await waitFor(() => expect(search).toHaveBeenLastCalledWith(
      discoveryRequest({ categoryId: dairyCategory.id }),
      expect.any(AbortSignal),
    ));
    expect(screen.getByRole("heading", { name: "Observert kategori: Meieri" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "TINE Lettmelk 1 % 1 l" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Lettmelk Bunnpris" })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Filtrer varene (valgfritt)"), "kaffe");
    await user.click(screen.getByRole("button", { name: "Søk" }));
    await waitFor(() => expect(search).toHaveBeenLastCalledWith(
      discoveryRequest({ query: "kaffe" }),
      expect.any(AbortSignal),
    ));
  });

  it("adds the canonical GTIN as an exact basket selection", async () => {
    const user = userEvent.setup();
    const storage = memoryStorage();
    render(
      <DiscoveryWorkspace
        createId={vi.fn().mockReturnValueOnce("need-1").mockReturnValueOnce("rule-1")}
        searchDiscovery={successfulSearch()}
        storage={storage}
      />,
    );

    const card = (await screen.findByRole("heading", { name: "TINE Lettmelk 1 % 1 l" })).closest("article");
    expect(card).not.toBeNull();
    await user.click(within(card!).getByRole("button", { name: "Legg til i handlelisten" }));

    expect(within(card!).getByRole("button", { name: "I handlelisten" })).toBeDisabled();
    expect(screen.getByText("1 varebehov")).toBeVisible();
    expect(JSON.parse(storage.getItem(BASKET_STORAGE_KEY) ?? "{}")).toMatchObject({
      needs: [{ id: "need-1", query: "TINE Lettmelk 1 % 1 l", matchRuleId: "rule-1" }],
      matchingRules: [{ id: "rule-1", mode: "exact", exactEan: "7038010000010" }],
    });
  });

  it("counts needs rather than summing gram and package base quantities", async () => {
    const storage = memoryStorage();
    const existingProduct = response.products[1]!.catalog;
    const existing = addExactProductToBasket(
      emptyBasketV4,
      {
        ean: existingProduct.gtin,
        name: existingProduct.displayName,
        ...(existingProduct.brand === undefined ? {} : { brand: existingProduct.brand }),
      },
      vi.fn().mockReturnValueOnce("existing-need").mockReturnValueOnce("existing-rule"),
    );
    saveBasket({
      ...existing,
      needs: existing.needs.map((need) => ({
        ...need,
        quantity: 1_000,
        quantityUnit: "g" as const,
      })),
    }, storage);

    render(<DiscoveryWorkspace searchDiscovery={successfulSearch()} storage={storage} />);

    expect(await screen.findByText("1 varebehov")).toBeVisible();
    expect(screen.queryByText(/1000 varer/u)).not.toBeInTheDocument();
  });

  it("can retry browsing after a temporary failure", async () => {
    const user = userEvent.setup();
    const search = vi.fn<DiscoverySearch>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementationOnce(async (request) => responseForRequest(request));
    render(<DiscoveryWorkspace searchDiscovery={search} storage={memoryStorage()} />);

    await user.click(await screen.findByRole("button", { name: "Prøv igjen" }));
    expect(await screen.findByRole("heading", { name: "TINE Lettmelk 1 % 1 l" })).toBeVisible();
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
  });

  it("refetches discovery in the explicitly selected allowlisted market", async () => {
    const user = userEvent.setup();
    const search = successfulSearch();
    render(<DiscoveryWorkspace searchDiscovery={search} storage={memoryStorage()} />);
    await screen.findByRole("heading", { name: "TINE Lettmelk 1 % 1 l" });

    await user.selectOptions(screen.getByLabelText("Prisområde"), "no-0301-oslo");
    await waitFor(() => expect(search).toHaveBeenLastCalledWith(
      discoveryRequest({
        marketContext: {
          contractVersion: 1,
          countryCode: "NO",
          kind: "launch-region",
          regionId: "no-0301-oslo",
        },
      }),
      expect.any(AbortSignal),
    ));
    expect(await screen.findByText(/ikke lanseringsklar/)).toBeVisible();
  });

  it("independently validates browser responses and rejects legacy upstream shapes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      generatedAt: GENERATED_AT,
      opportunities: [],
      priceDataSource: "upstream",
    }), { headers: { "content-type": "application/json; charset=utf-8" } })));

    await expect(searchDiscoveryFromApi(
      discoveryRequest(),
      new AbortController().signal,
    ))
      .rejects.toThrow("DISCOVERY_SEARCH_FAILED");
  });

  it("requests opaque categories without placing text or raw source category IDs in the URL", async () => {
    const categoryRequest = discoveryRequest({ categoryId: dairyCategory.id });
    const categoryResponse = responseForRequest(categoryRequest);
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(categoryResponse), {
      headers: { "content-type": "application/json; charset=utf-8" },
    }));
    vi.stubGlobal("fetch", fetch);

    await expect(searchDiscoveryFromApi(
      categoryRequest,
      new AbortController().signal,
    )).resolves.toEqual(categoryResponse);
    expect(fetch).toHaveBeenCalledWith(
      `/api/discovery/search?chain=all&market=national&pageSize=8&type=all&category=${encodeURIComponent(dairyCategory.id)}`,
      { signal: expect.any(AbortSignal) },
    );
    expect(String(fetch.mock.calls[0]?.[0])).not.toContain("sourceCategoryId");
    await expect(searchDiscoveryFromApi(
      { ...categoryRequest, query: "melk" },
      new AbortController().signal,
    )).rejects.toThrow("DISCOVERY_SEARCH_FAILED");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("cancels a discovery response declared above 128 KiB", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => { cancelled = true; },
      start: (controller) => controller.enqueue(new TextEncoder().encode("{}")),
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, {
      headers: {
        "content-length": String(128 * 1_024 + 1),
        "content-type": "application/json",
      },
    })));

    await expect(searchDiscoveryFromApi(
      discoveryRequest(),
      new AbortController().signal,
    ))
      .rejects.toThrow("DISCOVERY_SEARCH_FAILED");
    expect(cancelled).toBe(true);
  });
});
