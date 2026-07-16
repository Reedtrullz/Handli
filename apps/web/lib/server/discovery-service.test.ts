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
  const stored = [...rows];
  return {
    getMany: async (eans) => {
      const selected = new Set(eans);
      return stored.filter((row) => selected.has(row.ean));
    },
    putMany: async (incoming) => {
      for (const row of incoming) {
        const existingIndex = stored.findIndex(
          (existing) => existing.ean === row.ean && existing.chain === row.chain,
        );
        if (existingIndex === -1) stored.push(row);
        else if (stored[existingIndex]!.observedAt < row.observedAt) stored[existingIndex] = row;
      }
    },
  };
}

function gateway(prices: PriceObservation[] = [fresh]): KassalappGateway {
  return {
    browseProducts: async () => [product],
    getBulkPrices: async () => prices,
    searchProducts: async () => [product],
  };
}

describe("DiscoveryService", () => {
  it("uses store-scoped catalog prices when the gateway exposes them", async () => {
    const catalogGateway = gateway();
    const previous = { ...fresh, amountOre: 2990 as PriceObservation["amountOre"], observedAt: "2026-07-10T09:00:00.000Z" };
    catalogGateway.browseCatalog = async () => [{ product, price: fresh, previousPrice: previous }];
    catalogGateway.getBulkPrices = async () => { throw new Error("bulk should not run"); };
    const result = await new DiscoveryService({ cache: cache(), gateway: catalogGateway, now: () => now }).browse();
    expect(result.opportunities).toEqual([{ product, prices: [fresh], previousPrices: [previous] }]);
  });

  it("browses current priced products without a search query", async () => {
    const result = await new DiscoveryService({ cache: cache(), gateway: gateway(), now: () => now }).browse();
    expect(result.opportunities).toEqual([{ product, prices: [fresh], previousPrices: [] }]);
  });

  it("never ranks upstream prices that the configured read model rejects", async () => {
    const rejectingReadModel: PriceCache = {
      getMany: async () => [],
      putMany: async () => undefined,
    };

    const result = await new DiscoveryService({
      cache: rejectingReadModel,
      gateway: gateway(),
      now: () => now,
    }).search("melk");

    expect(result).toMatchObject({ opportunities: [], priceDataSource: "upstream" });
  });

  it("hides catalog history when the current catalog price is not admitted", async () => {
    const catalogGateway = gateway();
    catalogGateway.browseCatalog = async () => [{
      product,
      price: fresh,
      previousPrice: {
        ...fresh,
        amountOre: 2_990 as PriceObservation["amountOre"],
        observedAt: "2026-07-10T09:00:00.000Z",
      },
    }];
    const rejectingReadModel: PriceCache = {
      getMany: async () => [],
      putMany: async () => undefined,
    };

    const result = await new DiscoveryService({
      cache: rejectingReadModel,
      gateway: catalogGateway,
      now: () => now,
    }).browse();

    expect(result.opportunities).toEqual([]);
  });

  it("does not rank raw upstream prices when evidence persistence fails", async () => {
    const failingPersistence: PriceCache = {
      getMany: async () => [],
      putMany: async () => {
        throw new Error("database unavailable");
      },
    };

    await expect(
      new DiscoveryService({
        cache: failingPersistence,
        gateway: gateway(),
        now: () => now,
      }).search("melk"),
    ).rejects.toBeInstanceOf(DiscoveryUnavailableError);
  });

  it("uses previously admitted prices when a discovery refresh cannot be persisted", async () => {
    const fallback: PriceCache = {
      getMany: async () => [fresh],
      putMany: async () => {
        throw new Error("database unavailable");
      },
    };

    await expect(
      new DiscoveryService({ cache: fallback, gateway: gateway(), now: () => now }).search("melk"),
    ).resolves.toMatchObject({
      opportunities: [{ prices: [fresh] }],
      priceDataSource: "cache",
    });
  });

  it("returns only fresh current prices and preserves search relevance", async () => {
    const stale = { ...fresh, chain: "extra" as const, observedAt: "2026-07-12T09:00:00.000Z" };
    const result = await new DiscoveryService({ cache: cache(), gateway: gateway([stale, fresh]), now: () => now })
      .search("melk");

    expect(result).toEqual({
      generatedAt: now.toISOString(),
      opportunities: [{ product, prices: [fresh], previousPrices: [] }],
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
