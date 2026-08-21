import { describe, expect, it, vi } from "vitest";
import { TjekClient, TjekClientError } from "./client";
import type { TjekCatalog } from "./types";

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
    cover_image_url: null,
    page_count: 8,
    type: "incito",
    locale: "nb-NO",
    country_code: "NO",
    ...overrides,
  };
}

const INCITO_WITH_OFFERS = {
  id: "HEAqFAxC",
  version: "1.0.0",
  root_view: {
    role: "paged-mandatory",
    child_views: [
      {
        role: "section",
        child_views: [
          { role: "offer", id: "view-1" },
          { role: "view", child_views: [] },
        ],
      },
      {
        role: "section",
        child_views: [
          { role: "offer", id: "view-2" },
        ],
      },
    ],
  },
};

const OFFER_DETAIL_1 = {
  offer: {
    name: "Kjøttdeig av svin",
    price: 40,
    currency_code: "NOK",
    validity: { from: "2026-08-17T22:00:00Z", to: "2026-08-24T22:00:00Z" },
    unit_symbol: "gram",
    unit_size: { from: 400, to: 1 },
  },
};

const OFFER_DETAIL_2 = {
  offer: {
    name: "Melk 1L",
    price: 14.9,
    currency_code: "NOK",
    validity: { from: "2026-08-17T22:00:00Z", to: "2026-08-24T22:00:00Z" },
    unit_symbol: "l",
    unit_size: { from: 1, to: 1 },
  },
};

function createClientWithKey(fetchImpl: typeof fetch): TjekClient {
  return new TjekClient({
    apiKey: "test-key-123",
    baseUrl: "https://fixture.invalid",
    fetch: fetchImpl,
  });
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
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([catalog]));
      const client = createClient(mockFetch);

      const result = await client.listCatalogs();

      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe("HEAqFAxC");
      expect(result[0]?.brand).toBe("Bunnpris");
    });

    it("passes custom params", async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([]));
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
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([catalog]));
      const client = createClient(mockFetch);

      const result = await client.getLatestCatalog();
      expect(result?.id).toBe("latest-id");
    });

    it("returns undefined when no catalogs exist", async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([]));
      const client = createClient(mockFetch);

      const result = await client.getLatestCatalog();
      expect(result).toBeUndefined();
    });
  });

  describe("getOffersFromCatalog", () => {
    it("fetches offers via incito + offer detail flow", async () => {
      const mockFetch = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(INCITO_WITH_OFFERS))  // generate_incito
        .mockResolvedValueOnce(jsonResponse(OFFER_DETAIL_1))      // offer 1
        .mockResolvedValueOnce(jsonResponse(OFFER_DETAIL_2));     // offer 2
      const client = createClientWithKey(mockFetch);

      const result = await client.getOffersFromCatalog("HEAqFAxC");

      expect(result).toHaveLength(2);
      expect(result[0]?.name).toBe("Kjøttdeig av svin");
      expect(result[0]?.price).toBe(40);
      expect(result[0]?.catalog_id).toBe("HEAqFAxC");
      expect(result[1]?.name).toBe("Melk 1L");
      expect(result[1]?.price).toBe(14.9);
      // 3 calls: incito + 2 offer details
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("deduplicates offer view IDs", async () => {
      const incito = {
        ...INCITO_WITH_OFFERS,
        root_view: {
          role: "paged-mandatory",
          child_views: [
            { role: "section", child_views: [{ role: "offer", id: "same-id" }] },
            { role: "section", child_views: [{ role: "offer", id: "same-id" }] },
          ],
        },
      };
      const mockFetch = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(incito))
        .mockResolvedValueOnce(jsonResponse(OFFER_DETAIL_1));
      const client = createClientWithKey(mockFetch);

      const result = await client.getOffersFromCatalog("CAT1");

      expect(result).toHaveLength(1);
      // Only 2 calls: incito + 1 offer detail (deduped)
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("returns empty when no offers in incito", async () => {
      const incito = {
        ...INCITO_WITH_OFFERS,
        root_view: { role: "paged-mandatory", child_views: [] },
      };
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(incito));
      const client = createClientWithKey(mockFetch);

      const result = await client.getOffersFromCatalog("CAT2");
      expect(result).toHaveLength(0);
      expect(mockFetch).toHaveBeenCalledOnce(); // only incito call
    });

    it("skips offers that fail to fetch", async () => {
      const mockFetch = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(INCITO_WITH_OFFERS))
        .mockRejectedValueOnce(new Error("network"))
        .mockResolvedValueOnce(jsonResponse(OFFER_DETAIL_2));
      const client = createClientWithKey(mockFetch);

      const result = await client.getOffersFromCatalog("CAT3");
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe("Melk 1L");
    });

    it("throws when no API key is provided", async () => {
      const mockFetch = vi.fn<typeof fetch>();
      const client = createClient(mockFetch); // no apiKey

      await expect(client.getOffersFromCatalog("x")).rejects.toThrow(TjekClientError);
      await expect(client.getOffersFromCatalog("x")).rejects.toSatisfy(
        (err: TjekClientError) => err.code === "SERVER_ERROR",
      );
    });

    it("passes API key in headers", async () => {
      const mockFetch = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(INCITO_WITH_OFFERS))
        .mockResolvedValueOnce(jsonResponse(OFFER_DETAIL_1));
      const client = createClientWithKey(mockFetch);

      await client.getOffersFromCatalog("CAT4");

      const rpcCall = mockFetch.mock.calls[0];
      const headers = rpcCall[1]?.headers as Record<string, string>;
      expect(headers["X-Api-Key"]).toBe("test-key-123");
    });
  });

  describe("error handling", () => {
    it("throws SERVER_ERROR on non-ok response", async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        new Response("Internal Server Error", { status: 500 }),
      );
      const client = createClient(mockFetch);

      await expect(client.listCatalogs()).rejects.toThrow(TjekClientError);
    });

    it("throws RATE_LIMITED on 429", async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        new Response("Too Many Requests", { status: 429 }),
      );
      const client = createClient(mockFetch);

      await expect(client.listCatalogs()).rejects.toSatisfy(
        (err: TjekClientError) => err.code === "RATE_LIMITED",
      );
    });

    it("throws CANCELLED when signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const mockFetch = vi.fn<typeof fetch>();
      const client = createClient(mockFetch);

      await expect(
        client.listCatalogs(undefined, controller.signal),
      ).rejects.toSatisfy(
        (err: TjekClientError) => err.code === "CANCELLED",
      );
    });
  });
});
