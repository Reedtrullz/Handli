import type { Product } from "@handleplan/domain";
import { KassalappGatewayError, type KassalappGateway } from "@handleplan/kassalapp";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createSearchHandler } from "./route";

const product: Product = { ean: "7038010000013", name: "Tine Lettmelk 1 %" };

function request(q: string): Request {
  return new Request(`https://handleplan.no/api/products/search?q=${encodeURIComponent(q)}`);
}

describe("GET /api/products/search", () => {
  it("returns normalized products and forwards the request signal", async () => {
    let seenSignal: AbortSignal | undefined;
    const gateway: KassalappGateway = {
      getBulkPrices: async () => [],
      searchProducts: async (_query, _limit, signal) => {
        seenSignal = signal;
        return [product];
      },
    };
    const incoming = request("melk");

    const response = await createSearchHandler(() => gateway)(incoming);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ products: [product] });
    expect(seenSignal).toBe(incoming.signal);
  });

  it.each(["", "m", " "])('rejects the too-short query "%s"', async (query) => {
    const response = await createSearchHandler(() => ({
      getBulkPrices: async () => [],
      searchProducts: async () => [],
    }))(request(query));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ code: "INVALID_REQUEST" });
  });

  it("rejects oversized and unexpected query parameters", async () => {
    const handler = createSearchHandler(() => ({
      getBulkPrices: async () => [],
      searchProducts: async () => [],
    }));

    expect((await handler(request("m".repeat(121)))).status).toBe(400);
    expect(
      (await handler(new Request("https://handleplan.no/api/products/search?q=melk&debug=1"))).status,
    ).toBe(400);
  });

  it.each([
    ["INVALID_REQUEST", 400, "INVALID_REQUEST"],
    ["CANCELLED", 499, "REQUEST_CANCELLED"],
    ["TIMEOUT", 504, "PRICE_DATA_TIMEOUT"],
    ["UPSTREAM_UNAVAILABLE", 502, "PRICE_DATA_UNAVAILABLE"],
    ["INVALID_RESPONSE", 502, "PRICE_DATA_UNAVAILABLE"],
  ] as const)("maps %s without exposing upstream details", async (gatewayCode, status, code) => {
    const response = await createSearchHandler(() => ({
      getBulkPrices: async () => [],
      searchProducts: async () => {
        const error = new KassalappGatewayError(gatewayCode);
        error.stack = "secret stack https://upstream.example/?query=melk";
        throw error;
      },
    }))(request("melk"));

    expect(response.status).toBe(status);
    const body = JSON.stringify(await response.json());
    expect(body).toBe(JSON.stringify({ code }));
    expect(body).not.toMatch(/upstream|query|stack|Bearer/i);
  });
});
