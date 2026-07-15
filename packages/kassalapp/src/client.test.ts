import { describe, expect, it, vi } from "vitest";

import pricesFixture from "../test/fixtures/prices-bulk.json";
import searchFixture from "../test/fixtures/search.json";
import {
  KassalappClient,
  KassalappGatewayError,
} from "./client";

const EAN = "7038010000013";
const API_KEY = "synthetic-test-key";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function createClient(fetchImplementation: typeof fetch): KassalappClient {
  return new KassalappClient({
    apiKey: API_KEY,
    baseUrl: "https://fixture.invalid/api/v1",
    fetch: fetchImplementation,
  });
}

describe("KassalappClient contract", () => {
  it("searches with the injected fetch and normalizes a validated product fixture", async () => {
    let seenAuthorization: string | null = null;
    const seenUrls: string[] = [];
    const injectedFetch: typeof fetch = async (input, init) => {
      seenUrls.push(String(input));
      seenAuthorization = new Headers(init?.headers).get("authorization");
      return jsonResponse(searchFixture);
    };

    const products = await createClient(injectedFetch).searchProducts(" lettmelk ", 10);

    expect(products).toEqual([
      {
        ean: EAN,
        name: "Tine Lettmelk 1 %",
        brand: "Tine",
        packageQuantity: 1000,
        packageUnit: "ml",
        productFamily: "lettmelk",
      },
    ]);
    expect(seenAuthorization).toBe(`Bearer ${API_KEY}`);
    expect(seenUrls).toEqual([
      "https://fixture.invalid/api/v1/products/search?query=lettmelk&limit=10",
    ]);
  });

  it("normalizes NOK prices and canonicalizes observed timestamps to millisecond UTC", async () => {
    const injectedFetch: typeof fetch = async () => jsonResponse(pricesFixture);

    await expect(createClient(injectedFetch).getBulkPrices([EAN])).resolves.toEqual([
      {
        amountOre: 2190,
        chain: "extra",
        ean: EAN,
        observedAt: "2026-07-15T08:30:00.000Z",
        source: "kassalapp",
      },
      {
        amountOre: 2240,
        chain: "rema-1000",
        ean: EAN,
        observedAt: "2026-07-15T08:45:00.000Z",
        source: "kassalapp",
      },
    ]);
  });

  it("enforces the requested result limit even if upstream overproduces", async () => {
    const injectedFetch: typeof fetch = async () =>
      jsonResponse({
        data: [
          searchFixture.data[0],
          { ...searchFixture.data[0], ean: "7038010000020", name: "Annen lettmelk" },
        ],
      });

    await expect(createClient(injectedFetch).searchProducts("lettmelk", 1)).resolves.toEqual([
      expect.objectContaining({ ean: EAN }),
    ]);
  });

  it("batches 101 EANs into requests of at most 100", async () => {
    const batchSizes: number[] = [];
    const injectedFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { eans: string[] };
      batchSizes.push(body.eans.length);
      return jsonResponse({ data: [] });
    };
    const eans = Array.from({ length: 101 }, (_, index) =>
      String(1_000_000_000_000 + index),
    );

    await expect(createClient(injectedFetch).getBulkPrices(eans)).resolves.toEqual([]);
    expect(batchSizes).toEqual([100, 1]);
  });

  it("fails closed on malformed upstream JSON without exposing its body", async () => {
    const secretBody = `not-json-${API_KEY}`;
    const injectedFetch: typeof fetch = async () => new Response(secretBody, { status: 200 });

    const error = await createClient(injectedFetch).searchProducts("melk", 10).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(KassalappGatewayError);
    expect(error).toMatchObject({ code: "INVALID_RESPONSE" });
    expect(String(error)).not.toContain(secretBody);
    expect(String(error)).not.toContain(API_KEY);
  });

  it("fails closed when a normalized observation would violate the domain timestamp", async () => {
    const injectedFetch: typeof fetch = async () =>
      jsonResponse({
        data: [
          {
            ...pricesFixture.data[0],
            observed_at: "not-a-timestamp",
          },
        ],
      });

    await expect(createClient(injectedFetch).getBulkPrices([EAN])).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("fails closed when bulk data contains an EAN that was not requested", async () => {
    const injectedFetch: typeof fetch = async () =>
      jsonResponse({
        data: [
          {
            ...pricesFixture.data[0],
            ean: "7038010000020",
          },
        ],
      });

    await expect(createClient(injectedFetch).getBulkPrices([EAN])).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("aborts each attempt at eight seconds and does not retry a timeout", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      let suppliedSignal: AbortSignal | undefined;
      const injectedFetch: typeof fetch = async (_input, init) => {
        attempts += 1;
        suppliedSignal = init?.signal ?? undefined;
        return await new Promise<Response>((_resolve, reject) => {
          suppliedSignal?.addEventListener("abort", () => {
            reject(new DOMException("synthetic secret detail", "AbortError"));
          });
        });
      };

      const result = createClient(injectedFetch).searchProducts("melk", 10);
      const rejection = expect(result).rejects.toMatchObject({ code: "TIMEOUT" });
      await vi.advanceTimersByTimeAsync(7_999);
      expect(suppliedSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejection;
      expect(suppliedSignal?.aborted).toBe(true);
      expect(attempts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([429, 502, 503, 504])("retries status %s exactly once", async (status) => {
    let attempts = 0;
    const injectedFetch: typeof fetch = async () => {
      attempts += 1;
      return attempts === 1 ? jsonResponse({ private: API_KEY }, status) : jsonResponse({ data: [] });
    };

    await expect(createClient(injectedFetch).searchProducts("melk", 10)).resolves.toEqual([]);
    expect(attempts).toBe(2);
  });

  it("stops after one retry and returns a sanitized public error", async () => {
    const injectedFetch = vi.fn<typeof fetch>(async () =>
      jsonResponse({ header: `Bearer ${API_KEY}`, body: "private-upstream-body" }, 503),
    );

    const error = await createClient(injectedFetch).getBulkPrices([EAN]).catch(
      (caught: unknown) => caught,
    );

    expect(injectedFetch).toHaveBeenCalledTimes(2);
    expect(error).toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    expect(String(error)).not.toContain(API_KEY);
    expect(String(error)).not.toContain("private-upstream-body");
  });

  it.each([400, 401, 404, 500])("does not retry status %s", async (status) => {
    const injectedFetch = vi.fn<typeof fetch>(async () => jsonResponse({ secret: API_KEY }, status));

    await expect(createClient(injectedFetch).searchProducts("melk", 10)).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
    expect(injectedFetch).toHaveBeenCalledTimes(1);
  });

  it("does not call upstream for an empty bulk request", async () => {
    const injectedFetch = vi.fn<typeof fetch>();

    await expect(createClient(injectedFetch).getBulkPrices([])).resolves.toEqual([]);
    expect(injectedFetch).not.toHaveBeenCalled();
  });
});
