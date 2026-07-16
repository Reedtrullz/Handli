// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  publicDiscoveryResponseSchema,
  type PublicDiscoveryResponse,
} from "@handleplan/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BASKET_STORAGE_KEY } from "../../lib/browser-basket";
import {
  DiscoveryWorkspace,
  searchDiscoveryFromApi,
  type DiscoverySearch,
} from "./discovery-workspace";

const GENERATED_AT = "2026-07-15T10:00:00.000Z";
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
    sources: [catalogSource, offerSource],
  });
}

const response = fixtureResponse();

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
    const search = vi.fn<DiscoverySearch>().mockResolvedValue(response);
    render(<DiscoveryWorkspace searchDiscovery={search} storage={memoryStorage()} />);

    expect(await screen.findByRole("heading", { name: "TINE Lettmelk 1 % 1 l" })).toBeVisible();
    expect(search).toHaveBeenCalledWith(undefined, expect.any(AbortSignal));
    expect(screen.getByText(/Manglende kjeder vises som uavklart/)).toBeVisible();
    expect(screen.getByRole("region", { name: "Offisielt tilbud hos Extra" })).toBeVisible();
    expect(screen.getByText("Oppgitt førpris: 29,90 kr")).toBeVisible();
    expect(screen.getByText("Spar 10,00 kr (33,4 %) basert på tilbudets oppgitte førpris.")).toBeVisible();
    expect(screen.getAllByText(/Historisk median \(30 dager\): 29,90 kr/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Nå: 23,90 kr — 6,00 kr lavere enn historisk median \(20,1 %\)/)).toBeVisible();
    expect(screen.getAllByText(/Ordinærpris • Kassalapp/).length).toBe(3);
    expect(screen.getByText(/Delvis dekning\. Uavklart: Bunnpris/)).toBeVisible();
    expect(screen.getAllByText(/Katalog: Kassalapp • observert/).length).toBe(2);
    expect(screen.getByText(/kontrollert lokal cache/)).toBeVisible();
    expect(screen.getByText(/Manglende historisk sammenligning betyr ikke at prisen er uendret/)).toBeVisible();
    expect(document.body.textContent).not.toMatch(/tidligere observert|upstream/i);
  });

  it("filters by chain using actual ordinary prices or official offers", async () => {
    const user = userEvent.setup();
    render(<DiscoveryWorkspace
      searchDiscovery={vi.fn<DiscoverySearch>().mockResolvedValue(response)}
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

  it("explains when a store has no ordinary price or official offer", async () => {
    const user = userEvent.setup();
    const onlyMilk = publicDiscoveryResponseSchema.parse({
      ...response,
      products: [response.products[0]],
    });
    render(<DiscoveryWorkspace
      searchDiscovery={vi.fn<DiscoverySearch>().mockResolvedValue(onlyMilk)}
      storage={memoryStorage()}
    />);

    await user.click(await screen.findByRole("button", { name: "Bunnpris" }));
    expect(screen.getByText("Ingen ordinærpriser eller offisielle tilbud er tilgjengelige fra Bunnpris akkurat nå.")).toBeVisible();
  });

  it("keeps search optional and can return to catalog browsing", async () => {
    const user = userEvent.setup();
    const search = vi.fn<DiscoverySearch>().mockResolvedValue(response);
    render(<DiscoveryWorkspace searchDiscovery={search} storage={memoryStorage()} />);
    await screen.findByRole("heading", { name: "Varekatalog og prisgrunnlag" });

    await user.type(screen.getByLabelText("Filtrer varene (valgfritt)"), "kaffe");
    await user.click(screen.getByRole("button", { name: "Søk" }));
    await waitFor(() => expect(search).toHaveBeenLastCalledWith("kaffe", expect.any(AbortSignal)));
    expect(screen.getByRole("heading", { name: "Treff for «kaffe»" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Vis hele varekatalogen" }));
    await waitFor(() => expect(search).toHaveBeenLastCalledWith(undefined, expect.any(AbortSignal)));
    expect(screen.getByRole("heading", { name: "Varekatalog og prisgrunnlag" })).toBeVisible();
  });

  it("adds the canonical GTIN as an exact basket selection", async () => {
    const user = userEvent.setup();
    const storage = memoryStorage();
    render(
      <DiscoveryWorkspace
        createId={vi.fn().mockReturnValueOnce("need-1").mockReturnValueOnce("rule-1")}
        searchDiscovery={vi.fn<DiscoverySearch>().mockResolvedValue(response)}
        storage={storage}
      />,
    );

    const card = (await screen.findByRole("heading", { name: "TINE Lettmelk 1 % 1 l" })).closest("article");
    expect(card).not.toBeNull();
    await user.click(within(card!).getByRole("button", { name: "Legg til i handlelisten" }));

    expect(within(card!).getByRole("button", { name: "I handlelisten" })).toBeDisabled();
    expect(screen.getByText("1 vare")).toBeVisible();
    expect(JSON.parse(storage.getItem(BASKET_STORAGE_KEY) ?? "{}")).toMatchObject({
      needs: [{ id: "need-1", query: "TINE Lettmelk 1 % 1 l", matchRuleId: "rule-1" }],
      matchingRules: [{ id: "rule-1", mode: "exact", exactEan: "7038010000010" }],
    });
  });

  it("can retry browsing after a temporary failure", async () => {
    const user = userEvent.setup();
    const search = vi.fn<DiscoverySearch>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(response);
    render(<DiscoveryWorkspace searchDiscovery={search} storage={memoryStorage()} />);

    await user.click(await screen.findByRole("button", { name: "Prøv igjen" }));
    expect(await screen.findByRole("heading", { name: "TINE Lettmelk 1 % 1 l" })).toBeVisible();
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
  });

  it("independently validates browser responses and rejects legacy upstream shapes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      generatedAt: GENERATED_AT,
      opportunities: [],
      priceDataSource: "upstream",
    }), { headers: { "content-type": "application/json; charset=utf-8" } })));

    await expect(searchDiscoveryFromApi(undefined, new AbortController().signal))
      .rejects.toThrow("DISCOVERY_SEARCH_FAILED");
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

    await expect(searchDiscoveryFromApi(undefined, new AbortController().signal))
      .rejects.toThrow("DISCOVERY_SEARCH_FAILED");
    expect(cancelled).toBe(true);
  });
});
