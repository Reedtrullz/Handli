import { describe, expect, it, vi } from "vitest";
import { OpenPricesClient, OpenPricesClientError } from "./client";
import type { OpenPricesApiResponse, OpenPricesPrice } from "./types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function makePrice(overrides: Partial<OpenPricesPrice> = {}): OpenPricesPrice {
  return {
    id: 1,
    product_code: "7038010000010",
    price: 29.9,
    currency: "NOK",
    date: "2026-08-15",
    price_is_discounted: false,
    price_without_discount: null,
    unit_price: null,
    quantity: null,
    location_id: 2728,
    location_osm_id: 12345,
    location_osm_type: "node",
    owner: "testuser",
    source: null,
    tags: [],
    created: "2026-08-15T10:00:00Z",
    updated: "2026-08-15T10:00:00Z",
    proof_id: null,
    ...overrides,
  };
}

function makeApiResponse(
  items: readonly OpenPricesPrice[],
  overrides: Partial<OpenPricesApiResponse> = {},
): OpenPricesApiResponse {
  return {
    items,
    page: 1,
    pages: 1,
    size: items.length,
    total: items.length,
    ...overrides,
  };
}

function createClient(fetchImpl: typeof fetch): OpenPricesClient {
  return new OpenPricesClient({
    baseUrl: "https://fixture.invalid/api/v1",
    fetch: fetchImpl,
  });
}

describe("OpenPricesClient", () => {
  it("returns a single-page response", async () => {
    const price = makePrice();
    const apiResponse = makeApiResponse([price]);
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(apiResponse));
    const client = createClient(mockFetch);

    const result = await client.listPrices({ product_code: "7038010000010" });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe(1);
    expect(mockFetch).toHaveBeenCalledOnce();
    const calledUrl = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(calledUrl.searchParams.get("product_code")).toBe("7038010000010");
    expect(calledUrl.searchParams.get("size")).toBe("100");
  });

  it("paginates across multiple pages in getPricesForGtins", async () => {
    const price1 = makePrice({ id: 1 });
    const price2 = makePrice({ id: 2 });
    const page1 = makeApiResponse([price1], { page: 1, pages: 2, size: 1, total: 2 });
    const page2 = makeApiResponse([price2], { page: 2, pages: 2, size: 1, total: 2 });

    const mockFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(page1))
      .mockResolvedValueOnce(jsonResponse(page2));
    const client = createClient(mockFetch);

    const result = await client.getPricesForGtins(["7038010000010"]);

    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe(1);
    expect(result[1]?.id).toBe(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("returns empty array for empty gtins", async () => {
    const mockFetch = vi.fn<typeof fetch>();
    const client = createClient(mockFetch);

    const result = await client.getPricesForGtins([]);
    expect(result).toHaveLength(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws RATE_LIMITED on 429", async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("Too Many Requests", { status: 429 }),
    );
    const client = createClient(mockFetch);

    await expect(client.listPrices({})).rejects.toThrow(OpenPricesClientError);
    await expect(client.listPrices({})).rejects.toSatisfy(
      (err: OpenPricesClientError) => err.code === "RATE_LIMITED",
    );
  });

  it("throws SERVER_ERROR on 5xx", async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("Internal Server Error", { status: 500 }),
    );
    const client = createClient(mockFetch);

    await expect(client.listPrices({})).rejects.toThrow(OpenPricesClientError);
    await expect(client.listPrices({})).rejects.toSatisfy(
      (err: OpenPricesClientError) => err.code === "SERVER_ERROR" && err.statusCode === 500,
    );
  });

  it("throws PAGE_LIMIT when page exceeds 500", async () => {
    const mockFetch = vi.fn<typeof fetch>();
    const client = createClient(mockFetch);

    await expect(client.listPrices({ page: 501 })).rejects.toThrow(OpenPricesClientError);
    await expect(client.listPrices({ page: 501 })).rejects.toSatisfy(
      (err: OpenPricesClientError) => err.code === "PAGE_LIMIT",
    );
  });

  it("respects AbortSignal cancellation", async () => {
    const controller = new AbortController();
    controller.abort();

    const mockFetch = vi.fn<typeof fetch>();
    const client = createClient(mockFetch);

    await expect(
      client.listPrices({}, controller.signal),
    ).rejects.toThrow(OpenPricesClientError);
    await expect(
      client.listPrices({}, controller.signal),
    ).rejects.toSatisfy(
      (err: OpenPricesClientError) => err.code === "CANCELLED",
    );
  });

  it("handles empty results gracefully", async () => {
    const apiResponse = makeApiResponse([]);
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(apiResponse));
    const client = createClient(mockFetch);

    const result = await client.listPrices({ product_code: "0000000000000" });
    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("clamps size to max 100", async () => {
    const apiResponse = makeApiResponse([]);
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(apiResponse));
    const client = createClient(mockFetch);

    await client.listPrices({ size: 500 });
    const calledUrl = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(calledUrl.searchParams.get("size")).toBe("100");
  });

  it("rate limits between requests", async () => {
    const mockFetch = vi.fn<typeof fetch>().mockImplementation(
      () => Promise.resolve(jsonResponse(makeApiResponse([]))),
    );
    const client = createClient(mockFetch);

    const start = Date.now();
    await client.listPrices({});
    await client.listPrices({});
    const elapsed = Date.now() - start;

    // Should wait at least ~1s between requests
    expect(elapsed).toBeGreaterThanOrEqual(900);
  });
});

describe("OpenPricesClient batching", () => {
  it("batches GTINs to avoid exceeding request-line limit", async () => {
    const gtins = Array.from({ length: 60 }, (_, i) =>
      "703801000001" + String(i).padStart(2, "0").slice(-2)
    );
    const mockFetch = vi.fn<typeof fetch>().mockImplementation(
      () => Promise.resolve(jsonResponse(makeApiResponse([]))),
    );
    const client = createClient(mockFetch);

    const result = await client.getPricesForGtins(gtins);

    expect(result).toHaveLength(0);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    for (const call of mockFetch.mock.calls) {
      const url = String(call[0]);
      expect(url.length).toBeLessThan(4094);
    }

    const firstUrl = new URL(String(mockFetch.mock.calls[0]?.[0]));
    const firstGtins = firstUrl.searchParams.get("product_code__in")?.split(",") ?? [];
    expect(firstGtins.length).toBe(50);

    const secondUrl = new URL(String(mockFetch.mock.calls[1]?.[0]));
    const secondGtins = secondUrl.searchParams.get("product_code__in")?.split(",") ?? [];
    expect(secondGtins.length).toBe(10);
  });
});
