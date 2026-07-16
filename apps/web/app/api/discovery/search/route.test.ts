import type { PriceObservation, Product } from "@handleplan/domain";
import { describe, expect, it } from "vitest";

import {
  DiscoveryRequestCancelledError,
  DiscoveryUnavailableError,
  type DiscoveryServiceContract,
} from "../../../../lib/server/discovery-service";
import { createDiscoverySearchHandler } from "./route";

const product: Product = { ean: "7038010000013", name: "Tine Lettmelk" };
const price: PriceObservation = {
  amountOre: 2290 as PriceObservation["amountOre"], chain: "rema-1000", ean: product.ean,
  observedAt: "2026-07-16T09:00:00.000Z", source: "kassalapp",
};

function request(query: string): Request {
  return new Request(`https://handleplan.no/api/discovery/search?q=${encodeURIComponent(query)}`);
}

describe("GET /api/discovery/search", () => {
  it("returns bounded discovery data and forwards cancellation", async () => {
    let signal: AbortSignal | undefined;
    const service: DiscoveryServiceContract = {
      search: async (_query, incoming) => {
        signal = incoming;
        return { generatedAt: "2026-07-16T10:00:00.000Z", opportunities: [{ product, prices: [price] }], priceDataSource: "upstream" };
      },
    };
    const incoming = request("melk");
    const response = await createDiscoverySearchHandler(() => service)(incoming);
    expect(response.status).toBe(200);
    expect(signal).toBe(incoming.signal);
    await expect(response.json()).resolves.toMatchObject({ opportunities: [{ product }] });
  });

  it("rejects short, oversized, duplicate, and unexpected parameters", async () => {
    const handler = createDiscoverySearchHandler(() => ({ search: async () => { throw new Error("unused"); } }));
    expect((await handler(request("m"))).status).toBe(400);
    expect((await handler(request("m".repeat(81)))).status).toBe(400);
    expect((await handler(new Request("https://handleplan.no/api/discovery/search?q=melk&q=ost"))).status).toBe(400);
    expect((await handler(new Request("https://handleplan.no/api/discovery/search?q=melk&debug=1"))).status).toBe(400);
  });

  it.each([
    [new DiscoveryRequestCancelledError(), 499, "REQUEST_CANCELLED"],
    [new DiscoveryUnavailableError(), 503, "PRICE_DATA_UNAVAILABLE"],
    [new Error("secret upstream detail"), 503, "PRICE_DATA_UNAVAILABLE"],
  ] as const)("sanitizes service failures", async (error, status, code) => {
    const response = await createDiscoverySearchHandler(() => ({ search: async () => { throw error; } }))(request("melk"));
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ code });
  });
});
