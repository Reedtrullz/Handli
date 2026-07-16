// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { searchProductsFromApi } from "./need-composer";

const publicResponse = {
  contractVersion: 1,
  products: [{
    brand: "TINE",
    contractVersion: 1,
    displayName: "TINE Lettmelk 1 %",
    gtin: "7038010000010",
    packageMeasure: { amount: 1_000, unit: "ml" },
    unitsPerPack: 1,
  }, {
    contractVersion: 1,
    displayName: "Egg 6 stk",
    gtin: "96385074",
    packageMeasure: { amount: 6, unit: "piece" },
    unitsPerPack: 6,
  }],
};

afterEach(() => vi.unstubAllGlobals());

describe("searchProductsFromApi", () => {
  it("strictly parses public catalog metadata and maps exact products", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(publicResponse), {
      headers: { "content-type": "application/json; charset=utf-8" },
    }));
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;

    await expect(searchProductsFromApi("melk & egg", signal)).resolves.toEqual([{
      brand: "TINE",
      ean: "7038010000010",
      name: "TINE Lettmelk 1 %",
      packageQuantity: 1_000,
      packageUnit: "ml",
    }, {
      ean: "96385074",
      name: "Egg 6 stk",
      packageQuantity: 6,
      packageUnit: "each",
    }]);
    expect(fetch).toHaveBeenCalledWith(
      "/api/products/search?q=melk%20%26%20egg",
      { signal },
    );
  });

  it("rejects legacy or private fields instead of silently accepting them", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ...publicResponse,
      products: [{ ...publicResponse.products[0], catalogEvidence: { permission: "secret" } }],
    }), { headers: { "content-type": "application/json" } })));

    await expect(searchProductsFromApi("melk", new AbortController().signal))
      .rejects.toThrow("PRODUCT_SEARCH_FAILED");
  });

  it("cancels and rejects a response declared above 128 KiB", async () => {
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

    await expect(searchProductsFromApi("melk", new AbortController().signal))
      .rejects.toThrow("PRODUCT_SEARCH_FAILED");
    expect(cancelled).toBe(true);
  });
});
