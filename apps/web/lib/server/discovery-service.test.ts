import type { PriceCache } from "@handleplan/db";
import type { PriceObservation, Product } from "@handleplan/domain";
import { KassalappGatewayError, type KassalappGateway } from "@handleplan/kassalapp";
import { describe, expect, it } from "vitest";

import {
  DiscoveryRequestCancelledError,
  DiscoveryService,
  DiscoveryUnavailableError,
} from "./discovery-service";

const now = new Date("2026-07-16T10:00:00.000Z");
const product: Product = { ean: "7038010000013", name: "Tine Lettmelk", brand: "Tine" };
const fresh: PriceObservation = {
  amountOre: 2290 as PriceObservation["amountOre"],
  chain: "rema-1000",
  ean: product.ean,
  observedAt: "2026-07-16T09:00:00.000Z",
  source: "kassalapp",
};

function cache(rows: PriceObservation[] = []): PriceCache {
  return { getMany: async () => rows, putMany: async () => undefined };
}

function gateway(prices: PriceObservation[] = [fresh]): KassalappGateway {
  return {
    getBulkPrices: async () => prices,
    searchProducts: async () => [product],
  };
}

describe("DiscoveryService", () => {
  it("returns only fresh current prices and preserves search relevance", async () => {
    const stale = { ...fresh, chain: "extra" as const, observedAt: "2026-07-12T09:00:00.000Z" };
    const result = await new DiscoveryService({ cache: cache(), gateway: gateway([stale, fresh]), now: () => now })
      .search("melk");

    expect(result).toEqual({
      generatedAt: now.toISOString(),
      opportunities: [{ product, prices: [fresh] }],
      priceDataSource: "upstream",
    });
  });

  it("uses fresh cached prices when bulk prices are unavailable", async () => {
    const failing = gateway();
    failing.getBulkPrices = async () => { throw new KassalappGatewayError("TIMEOUT"); };

    await expect(new DiscoveryService({ cache: cache([fresh]), gateway: failing, now: () => now }).search("melk"))
      .resolves.toMatchObject({ opportunities: [{ prices: [fresh] }], priceDataSource: "cache" });
  });

  it("returns an honest empty result when no searched product has a fresh price", async () => {
    const result = await new DiscoveryService({ cache: cache(), gateway: gateway([]), now: () => now }).search("melk");
    expect(result.opportunities).toEqual([]);
  });

  it("maps cancellation and search failures to sanitized service errors", async () => {
    const cancelled = gateway();
    cancelled.searchProducts = async () => { throw new KassalappGatewayError("CANCELLED"); };
    const failed = gateway();
    failed.searchProducts = async () => { throw new KassalappGatewayError("INVALID_RESPONSE"); };

    await expect(new DiscoveryService({ cache: cache(), gateway: cancelled }).search("melk"))
      .rejects.toBeInstanceOf(DiscoveryRequestCancelledError);
    await expect(new DiscoveryService({ cache: cache(), gateway: failed }).search("melk"))
      .rejects.toBeInstanceOf(DiscoveryUnavailableError);
  });
});
