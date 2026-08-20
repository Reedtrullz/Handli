import { describe, expect, it, vi } from "vitest";
import { TjekClient, TjekClientError } from "./client";
import type { TjekCatalog, TjekCatalogListResponse, TjekOffer } from "./types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function makeCatalog(overrides: Partial<TjekCatalog> = {}): TjekCatalog {
  return {
    id: "HEAqFAxC",
    dealer_id: "5b11sm",
    publication_date: "2026-08-18",
    run_from: "2026-08-17T22:00:00Z",
    run_till: "2026-08-24T21:59:00Z",
    offer_count: 3,
    brand: "Bunnpris",
    brand_logo_url: null,
    cover_image_url: "https://example.com/cover.jpg",
    page_count: 8,
    type: "incito",
    locale: "nb-NO",
    country_code: "NO",
    ...overrides,
  };
}

function makeCatalogListResponse(
  catalogs: readonly TjekCatalog[],
): TjekCatalogListResponse {
  return { catalogs, total: catalogs.length };
}

function makeOffer(overrides: Partial<TjekOffer> = {}): TjekOffer {
  return {
    id: "offer-1",
    heading: "Tilbud",
    name: "Melk 1L",
    price: 14.9,
    price_text: "kr 14,90",
    before_price: 19.9,
    quantity: "1",
    unit: "l",
    run_from: "2026-08-17T22:00:00Z",
    run_till: "2026-08-24T21:59:00Z",
    catalog_id: "HEAqFAxC",
    dealer_id: "5b11sm",
    image_url: "https://example.com/melk.jpg",
    page_number: 1,
    ...overrides,
  };
}

function createClient(fetchImpl: typeof fetch): TjekClient {
  return new TjekClient({
    baseUrl: "https://fixture.invalid",
    fetch: fetchImpl,
  });
}

describe("TjekClient", () => {
  describe("listCatalogs", () => {
    it("returns catalogs from the API", async () => {
      const catalog = makeCatalog();
      const apiResponse = makeCatalogListResponse([catalog]);
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(apiResponse));
      const client = createClient(mockFetch);

      const result = await client.listCatalogs();

      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe("HEAqFAxC");
      expect(result[0]?.brand).toBe("Bunnpris");
      expect(mockFetch).toHaveBeenCalledOnce();
      const calledUrl = new URL(String(mockFetch.mock.calls[0]?.[0]));
      expect(calledUrl.pathname).toBe("/v2/catalogs");
      expect(calledUrl.searchParams.get("dealer_id")).toBe("5b11sm");
      expect(calledUrl.searchParams.get("types")).toBe("incito");
      expect(calledUrl.searchParams.get("limit")).toBe("24");
    });

    it("passes custom params", async () => {
      const apiResponse = makeCatalogListResponse([]);
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(apiResponse));
      const client = createClient(mockFetch);

      await client.listCatalogs({ limit: 5, order_by: "-publication_date" });

      const calledUrl = new URL(String(mockFetch.mock.calls[0]?.[0]));
      expect(calledUrl.searchParams.get("limit")).toBe("5");
      expect(calledUrl.searchParams.get("order_by")).toBe("-publication_date");
    });
  });

  describe("getLatestCatalog", () => {
    it("returns the first catalog when available", async () => {
      const catalog = makeCatalog({ id: "latest-id" });
      const apiResponse = makeCatalogListResponse([catalog]);
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(apiResponse));
      const client = createClient(mockFetch);

      const result = await client.getLatestCatalog();

      expect(result?.id).toBe("latest-id");
      const calledUrl = new URL(String(mockFetch.mock.calls[0]?.[0]));
      expect(calledUrl.searchParams.get("limit")).toBe("1");
      expect(calledUrl.searchParams.get("order_by")).toBe("-publication_date");
    });

    it("returns undefined when no catalogs exist", async () => {
      const apiResponse = makeCatalogListResponse([]);
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(apiResponse));
      const client = createClient(mockFetch);

      const result = await client.getLatestCatalog();

      expect(result).toBeUndefined();
    });
  });

  describe("getOffersFromCatalog", () => {
    it("parses offers from array response", async () => {
      const rpcResponse = [
        {
          id: "o1",
          heading: "Dagligvarer",
          name: "Brød",
          price: 24.9,
          price_text: "kr 24,90",
          before_price: null,
          quantity: "1",
          unit: "stk",
          run_from: "2026-08-17T22:00:00Z",
          run_till: "2026-08-24T21:59:00Z",
          image_url: null,
          page_number: 2,
        },
      ];
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(rpcResponse));
      const client = createClient(mockFetch);

      const result = await client.getOffersFromCatalog("HEAqFAxC");

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe("Brød");
      expect(result[0]?.price).toBe(24.9);
      expect(result[0]?.catalog_id).toBe("HEAqFAxC");
      expect(result[0]?.dealer_id).toBe("5b11sm");
    });

    it("parses offers from result-wrapped response", async () => {
      const rpcResponse = {
        result: [
          {
            id: "o2",
            name: "Epler",
            price: 19.9,
          },
        ],
      };
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(rpcResponse));
      const client = createClient(mockFetch);

      const result = await client.getOffersFromCatalog("CAT123");

      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe("o2");
      expect(result[0]?.name).toBe("Epler");
      expect(result[0]?.price).toBe(19.9);
    });

    it("generates fallback id and name for missing fields", async () => {
      const rpcResponse = [{}];
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(rpcResponse));
      const client = createClient(mockFetch);

      const result = await client.getOffersFromCatalog("CAT999");

      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe("CAT999-0");
      expect(result[0]?.name).toBe("Offer 0");
      expect(result[0]?.price).toBeNull();
      expect(result[0]?.heading).toBeNull();
    });

    it("uses heading as name fallback when name is missing", async () => {
      const rpcResponse = [{ heading: "Fersk frukt" }];
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(rpcResponse));
      const client = createClient(mockFetch);

      const result = await client.getOffersFromCatalog("CAT500");

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe("Fersk frukt");
      expect(result[0]?.heading).toBe("Fersk frukt");
    });
  });

  describe("error handling", () => {
    it("throws SERVER_ERROR on non-ok response", async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        new Response("Internal Server Error", { status: 500 }),
      );
      const client = createClient(mockFetch);

      await expect(client.listCatalogs()).rejects.toThrow(TjekClientError);
      await expect(client.listCatalogs()).rejects.toSatisfy(
        (err: TjekClientError) =>
          err.code === "SERVER_ERROR" && err.statusCode === 500,
      );
    });

    it("throws SERVER_ERROR on RPC non-ok response", async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        new Response("Bad Gateway", { status: 502 }),
      );
      const client = createClient(mockFetch);

      await expect(client.getOffersFromCatalog("x")).rejects.toThrow(TjekClientError);
      await expect(client.getOffersFromCatalog("x")).rejects.toSatisfy(
        (err: TjekClientError) =>
          err.code === "SERVER_ERROR" && err.statusCode === 502,
      );
    });

    it("throws RATE_LIMITED on 429 from catalog endpoint", async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        new Response("Too Many Requests", { status: 429 }),
      );
      const client = createClient(mockFetch);

      await expect(client.listCatalogs()).rejects.toThrow(TjekClientError);
      await expect(client.listCatalogs()).rejects.toSatisfy(
        (err: TjekClientError) => err.code === "RATE_LIMITED",
      );
    });

    it("throws RATE_LIMITED on 429 from RPC endpoint", async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        new Response("Too Many Requests", { status: 429 }),
      );
      const client = createClient(mockFetch);

      await expect(client.getOffersFromCatalog("x")).rejects.toThrow(TjekClientError);
      await expect(client.getOffersFromCatalog("x")).rejects.toSatisfy(
        (err: TjekClientError) => err.code === "RATE_LIMITED",
      );
    });

    it("throws CANCELLED when AbortSignal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      const mockFetch = vi.fn<typeof fetch>();
      const client = createClient(mockFetch);

      await expect(
        client.listCatalogs(undefined, controller.signal),
      ).rejects.toThrow(TjekClientError);
      await expect(
        client.listCatalogs(undefined, controller.signal),
      ).rejects.toSatisfy(
        (err: TjekClientError) => err.code === "CANCELLED",
      );
    });

    it("throws CANCELLED for RPC when AbortSignal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      const mockFetch = vi.fn<typeof fetch>();
      const client = createClient(mockFetch);

      await expect(
        client.getOffersFromCatalog("x", controller.signal),
      ).rejects.toThrow(TjekClientError);
      await expect(
        client.getOffersFromCatalog("x", controller.signal),
      ).rejects.toSatisfy(
        (err: TjekClientError) => err.code === "CANCELLED",
      );
    });
  });
});
