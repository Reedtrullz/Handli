import type {
  PublicDiscoveryResponse,
} from "@handleplan/domain";
import { publicDiscoveryResponseSchema } from "@handleplan/domain";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  DiscoveryRequestCancelledError,
  DiscoveryUnavailableError,
  type DiscoveryServiceContract,
} from "../../../../lib/server/discovery-service";
import { InFlightOperationCoalescer } from "../../../../lib/server/in-flight-operation-coalescer";
import { PublicApiRuntimeControls } from "../../../../lib/server/public-api-runtime-controls";
import { createDiscoverySearchHandler } from "./route";

const GENERATED_AT = "2026-07-16T12:00:00.000Z";
const MARKET = { contractVersion: 1, countryCode: "NO", kind: "national" } as const;
const emptyResponse: PublicDiscoveryResponse = {
  contractVersion: 1,
  generatedAt: GENERATED_AT,
  marketContext: MARKET,
  observedCategories: {
    completeness: "partial",
    facets: [],
    hasMore: false,
    kind: "observed-category-directory",
  },
  page: {
    hasMore: false,
    kind: "bounded-catalog-slice",
    pageSize: 8,
    scannedCatalogProducts: 0,
  },
  priceDataSource: "cache",
  products: [],
  selection: { chain: "all", resultType: "all" },
  sources: [],
};

function emptyResponseFor(
  request: Parameters<DiscoveryServiceContract["discover"]>[0],
): PublicDiscoveryResponse {
  return {
    ...emptyResponse,
    marketContext: request.marketContext,
    page: { ...emptyResponse.page, pageSize: request.pageSize },
    selection: {
      ...(request.categoryId === undefined ? {} : { categoryId: request.categoryId }),
      chain: request.chain,
      ...(request.query === undefined ? {} : { query: request.query }),
      resultType: request.resultType,
    },
  };
}

function request(query: string, signal?: AbortSignal): Request {
  return new Request(
    `https://handleplan.no/api/discovery/search?market=national&q=${encodeURIComponent(query)}`,
    { signal },
  );
}

function service(overrides: Partial<DiscoveryServiceContract> = {}): DiscoveryServiceContract {
  return {
    browse: async () => emptyResponse,
    browseCategory: async () => emptyResponse,
    discover: async (request, signal) => {
      const result = request.query !== undefined && overrides.search !== undefined
        ? await overrides.search(request.query, request.marketContext, signal)
        : request.categoryId !== undefined && overrides.browseCategory !== undefined
          ? await overrides.browseCategory(request.categoryId, request.marketContext, signal)
          : overrides.browse !== undefined
            ? await overrides.browse(request.marketContext, signal)
            : emptyResponse;
      return result === emptyResponse ? emptyResponseFor(request) : result;
    },
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
      categoryPath: null,
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
    marketContext: MARKET,
    observedCategories: {
      completeness: "partial",
      facets: [],
      hasMore: false,
      kind: "observed-category-directory",
    },
    page: {
      hasMore: false,
      kind: "bounded-catalog-slice",
      pageSize: 8,
      scannedCatalogProducts: 4,
    },
    priceDataSource: "cache",
    products,
    selection: { chain: "all", resultType: "all" },
    sources: [source],
  });
}

describe("GET /api/discovery/search", () => {
  it("enforces global admission before discovery and returns bounded Retry-After", async () => {
    const search = vi.fn<DiscoveryServiceContract["search"]>();
    const runtimeControls = new PublicApiRuntimeControls(
      { claim: async () => ({ admitted: false, retryAfterSeconds: 11 }) },
      new InFlightOperationCoalescer(),
    );
    const getService = vi.fn(() => service({ search }));
    const response = await createDiscoverySearchHandler(
      getService,
      { runtimeControls },
    )(request("melk"));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("11");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ code: "RATE_LIMITED" });
    expect(getService).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it("fails closed on admission storage outage without reflecting backend detail", async () => {
    const runtimeControls = new PublicApiRuntimeControls(
      { claim: async () => { throw new Error("private database URL sentinel"); } },
      new InFlightOperationCoalescer(),
    );
    const response = await createDiscoverySearchHandler(
      () => service(),
      { runtimeControls },
    )(request("melk"));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"code":"REQUEST_BUDGET_UNAVAILABLE"}');
  });

  it("browses when no query is supplied and forwards cancellation", async () => {
    const browse = vi.fn<DiscoveryServiceContract["browse"]>().mockResolvedValue(emptyResponse);
    const incoming = new Request("https://handleplan.no/api/discovery/search?market=national");

    const response = await createDiscoverySearchHandler(() => service({ browse }))(incoming);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(browse).toHaveBeenCalledWith(MARKET, expect.any(AbortSignal));
    await expect(response.json()).resolves.toEqual(emptyResponse);
  });

  it("requires one explicit allowlisted market before resolving discovery", async () => {
    const getService = vi.fn(() => service());
    const handler = createDiscoverySearchHandler(getService);

    const missing = await handler(new Request("https://handleplan.no/api/discovery/search"));
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toEqual({ code: "MARKET_CONTEXT_REQUIRED" });

    const stale = await handler(new Request(
      "https://handleplan.no/api/discovery/search?market=no-9999-not-launched",
    ));
    expect(stale.status).toBe(422);
    await expect(stale.json()).resolves.toEqual({ code: "MARKET_UNAVAILABLE" });
    expect(getService).not.toHaveBeenCalled();
  });

  it("uses persisted search and accepts the full bounded query length", async () => {
    const search = vi.fn<DiscoveryServiceContract["search"]>().mockResolvedValue(emptyResponse);
    const query = "m".repeat(120);
    const incoming = request(query);

    const response = await createDiscoverySearchHandler(() => service({ search }))(incoming);

    expect(response.status).toBe(200);
    expect(search).toHaveBeenCalledWith(query, MARKET, expect.any(AbortSignal));
  });

  it("browses one opaque observed category and rejects combining it with text", async () => {
    const browseCategory = vi.fn<DiscoveryServiceContract["browseCategory"]>()
      .mockResolvedValue(emptyResponse);
    const categoryId = `category:${"a".repeat(64)}`;
    const handler = createDiscoverySearchHandler(() => service({ browseCategory }));

    const response = await handler(new Request(
      `https://handleplan.no/api/discovery/search?market=national&category=${categoryId}`,
    ));
    expect(response.status).toBe(200);
    expect(browseCategory).toHaveBeenCalledWith(categoryId, MARKET, expect.any(AbortSignal));

    expect((await handler(new Request(
      `https://handleplan.no/api/discovery/search?market=national&q=melk&category=${categoryId}`,
    ))).status).toBe(400);
    expect((await handler(new Request(
      "https://handleplan.no/api/discovery/search?market=national&category=category%3Araw-source-id",
    ))).status).toBe(400);
  });

  it("bounds service-backed browsing and distinguishes client cancellation", async () => {
    vi.useFakeTimers();
    try {
      let deadlineSignal: AbortSignal | undefined;
      const timeoutPending = createDiscoverySearchHandler(() => service({
        browse: async (_market, signal) => {
          deadlineSignal = signal;
          return new Promise<never>(() => undefined);
        },
      }), { timeoutMs: 25 })(new Request("https://handleplan.no/api/discovery/search?market=national"));

      await vi.advanceTimersByTimeAsync(25);
      const timeoutResponse = await timeoutPending;
      expect(timeoutResponse.status).toBe(503);
      expect(await timeoutResponse.json()).toEqual({ code: "REQUEST_TIMEOUT" });
      expect(deadlineSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);

      const client = new AbortController();
      let clientSignal: AbortSignal | undefined;
      const cancelledPending = createDiscoverySearchHandler(() => service({
        search: async (_query, _market, signal) => {
          clientSignal = signal;
          return new Promise<never>(() => undefined);
        },
      }), { timeoutMs: 25 })(request("melk", client.signal));
      await vi.advanceTimersByTimeAsync(10);
      client.abort();
      const cancelledResponse = await cancelledPending;

      expect(cancelledResponse.status).toBe(499);
      expect(await cancelledResponse.json()).toEqual({ code: "REQUEST_CANCELLED" });
      expect(clientSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects short, oversized, duplicate, and unexpected parameters before reading", async () => {
    const search = vi.fn<DiscoveryServiceContract["search"]>();
    const browse = vi.fn<DiscoveryServiceContract["browse"]>();
    const handler = createDiscoverySearchHandler(() => service({ browse, search }));

    expect((await handler(request("m"))).status).toBe(400);
    expect((await handler(request("m".repeat(121)))).status).toBe(400);
    expect((await handler(new Request("https://handleplan.no/api/discovery/search?market=national&q=melk&q=ost"))).status).toBe(400);
    expect((await handler(new Request("https://handleplan.no/api/discovery/search?market=national&q=melk&debug=1"))).status).toBe(400);
    expect(browse).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it("independently rejects malformed service output", async () => {
    const malformed = { ...emptyResponse, priceDataSource: "upstream" } as unknown as PublicDiscoveryResponse;
    const response = await createDiscoverySearchHandler(() => service({
      browse: async () => malformed,
    }))(new Request("https://handleplan.no/api/discovery/search?market=national"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ code: "PRICE_DATA_UNAVAILABLE" });
  });

  it("rejects a schema-valid response larger than 128 KiB", async () => {
    const oversized = oversizedResponse();
    expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength).toBeGreaterThan(128 * 1_024);

    const response = await createDiscoverySearchHandler(() => service({
      browse: async () => oversized,
    }))(new Request("https://handleplan.no/api/discovery/search?market=national"));

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
