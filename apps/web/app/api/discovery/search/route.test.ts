import type {
  PublicDiscoveryResponse,
} from "@handleplan/domain";
import { publicDiscoveryResponseSchema } from "@handleplan/domain";
import { describe, expect, it, vi } from "vitest";

import {
  DiscoveryRequestCancelledError,
  DiscoveryUnavailableError,
  type DiscoveryServiceContract,
} from "../../../../lib/server/discovery-service";
import { createDiscoverySearchHandler } from "./route";

const GENERATED_AT = "2026-07-16T12:00:00.000Z";
const emptyResponse: PublicDiscoveryResponse = {
  contractVersion: 1,
  generatedAt: GENERATED_AT,
  priceDataSource: "cache",
  products: [],
  sources: [],
};

function request(query: string): Request {
  return new Request(`https://handleplan.no/api/discovery/search?q=${encodeURIComponent(query)}`);
}

function service(overrides: Partial<DiscoveryServiceContract> = {}): DiscoveryServiceContract {
  return {
    browse: async () => emptyResponse,
    search: async () => emptyResponse,
    ...overrides,
  };
}

function oversizedResponse(): PublicDiscoveryResponse {
  const source = {
    contractVersion: 1 as const,
    displayName: "Kassalapp",
    id: "kassalapp",
    sourceClass: "ordinary-price" as const,
    state: "approved" as const,
  };
  function gtinFor(index: number): string {
    const body = `703801${String(index).padStart(6, "0")}`;
    const weighted = [...body].reduce((sum, digit, position) =>
      sum + Number(digit) * ((body.length - position) % 2 === 1 ? 3 : 1), 0);
    return `${body}${(10 - (weighted % 10)) % 10}`;
  }
  const products = Array.from({ length: 4 }, (_, productIndex) => {
    const canonicalProductId = `product:${productIndex}`;
    return {
      canonicalProductId,
      catalog: {
        catalogEvidence: {
          observedAt: "2026-07-16T11:00:00.000Z",
          source,
          sourceRecordId: `source-record:${String(productIndex).repeat(64)}`,
        },
        displayName: "Fixture",
        gtin: gtinFor(productIndex),
        packageMeasure: { amount: 1_000, unit: "ml" as const },
        unitsPerPack: 1,
      },
      comparisonScope: {
        completeness: "partial" as const,
        contractVersion: 1 as const,
        entries: [
          { chainId: "bunnpris", status: { kind: "unknown" as const, reason: "not-checked" as const } },
          { chainId: "extra", status: { kind: "unknown" as const, reason: "not-checked" as const } },
          { chainId: "rema-1000", status: { kind: "unknown" as const, reason: "not-checked" as const } },
        ],
        evaluatedAt: GENERATED_AT,
        expectedChainIds: ["bunnpris", "extra", "rema-1000"],
      },
      excludedPriceEvidence: [],
      historicalComparisons: [],
      historicalPriceEvidence: [],
      officialOffers: Array.from({ length: 50 }, (_, offerIndex) => ({
        applicability: {
          channels: ["in-store" as const],
          contractVersion: 1 as const,
          endsAt: "2026-07-20T00:00:00.000Z",
          geographicScope: { countryCode: "NO", kind: "national" as const },
          startsAt: "2026-07-15T00:00:00.000Z",
        },
        beforePriceOre: 2_990,
        capturedAt: "2026-07-16T11:00:00.000Z",
        chainId: "extra",
        conditions: [{ kind: "public" as const }],
        contractVersion: 1 as const,
        evidenceLevel: "authoritative" as const,
        id: `offer:${productIndex}:${offerIndex}`,
        kind: "official-offer" as const,
        pricing: { kind: "unit" as const, unitPriceOre: 1_990 },
        productMatch: { canonicalProductId, kind: "exact" as const },
        sourceId: source.id,
        sourceRecordId: `offer:${productIndex}:${offerIndex}:${"x".repeat(170)}`,
      })),
      ordinaryPrices: [],
    };
  });
  return publicDiscoveryResponseSchema.parse({
    contractVersion: 1,
    generatedAt: GENERATED_AT,
    priceDataSource: "cache",
    products,
    sources: [source],
  });
}

describe("GET /api/discovery/search", () => {
  it("browses when no query is supplied and forwards cancellation", async () => {
    const browse = vi.fn<DiscoveryServiceContract["browse"]>().mockResolvedValue(emptyResponse);
    const incoming = new Request("https://handleplan.no/api/discovery/search");

    const response = await createDiscoverySearchHandler(() => service({ browse }))(incoming);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(browse).toHaveBeenCalledWith(incoming.signal);
    await expect(response.json()).resolves.toEqual(emptyResponse);
  });

  it("uses persisted search and accepts the full bounded query length", async () => {
    const search = vi.fn<DiscoveryServiceContract["search"]>().mockResolvedValue(emptyResponse);
    const query = "m".repeat(120);
    const incoming = request(query);

    const response = await createDiscoverySearchHandler(() => service({ search }))(incoming);

    expect(response.status).toBe(200);
    expect(search).toHaveBeenCalledWith(query, incoming.signal);
  });

  it("rejects short, oversized, duplicate, and unexpected parameters before reading", async () => {
    const search = vi.fn<DiscoveryServiceContract["search"]>();
    const browse = vi.fn<DiscoveryServiceContract["browse"]>();
    const handler = createDiscoverySearchHandler(() => service({ browse, search }));

    expect((await handler(request("m"))).status).toBe(400);
    expect((await handler(request("m".repeat(121)))).status).toBe(400);
    expect((await handler(new Request("https://handleplan.no/api/discovery/search?q=melk&q=ost"))).status).toBe(400);
    expect((await handler(new Request("https://handleplan.no/api/discovery/search?q=melk&debug=1"))).status).toBe(400);
    expect(browse).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it("independently rejects malformed service output", async () => {
    const malformed = { ...emptyResponse, priceDataSource: "upstream" } as unknown as PublicDiscoveryResponse;
    const response = await createDiscoverySearchHandler(() => service({
      browse: async () => malformed,
    }))(new Request("https://handleplan.no/api/discovery/search"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ code: "PRICE_DATA_UNAVAILABLE" });
  });

  it("rejects a schema-valid response larger than 128 KiB", async () => {
    const oversized = oversizedResponse();
    expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength).toBeGreaterThan(128 * 1_024);

    const response = await createDiscoverySearchHandler(() => service({
      browse: async () => oversized,
    }))(new Request("https://handleplan.no/api/discovery/search"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ code: "PRICE_DATA_UNAVAILABLE" });
  });

  it.each([
    [new DiscoveryRequestCancelledError(), 499, "REQUEST_CANCELLED"],
    [new DiscoveryUnavailableError(), 503, "PRICE_DATA_UNAVAILABLE"],
    [new Error("secret storage detail"), 503, "PRICE_DATA_UNAVAILABLE"],
  ] as const)("sanitizes service failures", async (error, status, code) => {
    const response = await createDiscoverySearchHandler(() => service({
      browse: async () => { throw error; },
      search: async () => { throw error; },
    }))(request("melk"));
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ code });
  });
});
