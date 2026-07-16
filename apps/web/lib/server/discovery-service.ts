import type { PriceCache } from "@handleplan/db";
import {
  classifyFreshness,
  type PriceObservation,
  type Product,
} from "@handleplan/domain";
import {
  type KassalappGateway,
  KassalappGatewayError,
} from "@handleplan/kassalapp";

const SEARCH_LIMIT = 12;
const BROWSE_LIMIT = 36;

export interface DiscoveryOpportunity {
  product: Product;
  prices: PriceObservation[];
}

export interface DiscoveryResult {
  generatedAt: string;
  opportunities: DiscoveryOpportunity[];
  priceDataSource: "upstream" | "cache";
}

export interface DiscoveryServiceContract {
  browse(signal?: AbortSignal): Promise<DiscoveryResult>;
  search(query: string, signal?: AbortSignal): Promise<DiscoveryResult>;
}

export class DiscoveryUnavailableError extends Error {
  constructor() {
    super("Prisfunn er midlertidig utilgjengelige.");
    this.name = "DiscoveryUnavailableError";
  }
}

export class DiscoveryRequestCancelledError extends Error {
  constructor() {
    super("Forespørselen ble avbrutt.");
    this.name = "DiscoveryRequestCancelledError";
  }
}

function eligibleLatestPrices(rows: PriceObservation[], now: Date): PriceObservation[] {
  const latest = new Map<string, PriceObservation>();
  for (const row of rows) {
    const observedAt = new Date(row.observedAt);
    if (classifyFreshness(now, observedAt) !== "eligible") continue;
    const key = `${row.ean}\u0000${row.chain}`;
    const previous = latest.get(key);
    if (
      previous === undefined ||
      row.observedAt > previous.observedAt ||
      (row.observedAt === previous.observedAt && row.amountOre < previous.amountOre)
    ) {
      latest.set(key, row);
    }
  }
  return [...latest.values()].sort(
    (left, right) => left.amountOre - right.amountOre || left.chain.localeCompare(right.chain),
  );
}

function resultFor(
  products: Product[],
  rows: PriceObservation[],
  generatedAt: Date,
  priceDataSource: DiscoveryResult["priceDataSource"],
): DiscoveryResult {
  const eligible = eligibleLatestPrices(rows, generatedAt);
  const pricesByEan = new Map<string, PriceObservation[]>();
  for (const row of eligible) {
    const prices = pricesByEan.get(row.ean) ?? [];
    prices.push(row);
    pricesByEan.set(row.ean, prices);
  }
  return {
    generatedAt: generatedAt.toISOString(),
    opportunities: products.flatMap((product) => {
      const prices = pricesByEan.get(product.ean);
      return prices && prices.length > 0 ? [{ product, prices }] : [];
    }),
    priceDataSource,
  };
}

export class DiscoveryService implements DiscoveryServiceContract {
  constructor(
    private readonly dependencies: {
      cache: PriceCache;
      gateway: KassalappGateway;
      now?: () => Date;
    },
  ) {}

  async browse(signal?: AbortSignal): Promise<DiscoveryResult> {
    if (this.dependencies.gateway.browseCatalog) {
      try {
        const items = await this.dependencies.gateway.browseCatalog(BROWSE_LIMIT, signal);
        const generatedAt = (this.dependencies.now ?? (() => new Date()))();
        const products = [...new Map(items.map(({ product }) => [product.ean, product])).values()];
        const prices = items.map(({ price }) => price);
        try { await this.dependencies.cache.putMany(prices, generatedAt); } catch { /* Browse remains usable. */ }
        return resultFor(products, prices, generatedAt, "upstream");
      } catch (error) {
        if (error instanceof KassalappGatewayError && error.code === "CANCELLED") {
          throw new DiscoveryRequestCancelledError();
        }
        throw new DiscoveryUnavailableError();
      }
    }
    return this.loadProductsAndPrices(
      () => this.dependencies.gateway.browseProducts(BROWSE_LIMIT, signal),
      signal,
    );
  }

  async search(query: string, signal?: AbortSignal): Promise<DiscoveryResult> {
    return this.loadProductsAndPrices(
      () => this.dependencies.gateway.searchProducts(query, SEARCH_LIMIT, signal),
      signal,
    );
  }

  private async loadProductsAndPrices(
    loadProducts: () => Promise<Product[]>,
    signal?: AbortSignal,
  ): Promise<DiscoveryResult> {
    let products: Product[];
    try {
      products = await loadProducts();
    } catch (error) {
      if (error instanceof KassalappGatewayError && error.code === "CANCELLED") {
        throw new DiscoveryRequestCancelledError();
      }
      throw new DiscoveryUnavailableError();
    }

    const now = this.dependencies.now ?? (() => new Date());
    if (products.length === 0) {
      const generatedAt = now();
      return { generatedAt: generatedAt.toISOString(), opportunities: [], priceDataSource: "upstream" };
    }
    const eans = products.map(({ ean }) => ean);

    try {
      const rows = await this.dependencies.gateway.getBulkPrices(eans, signal);
      const generatedAt = now();
      try {
        await this.dependencies.cache.putMany(rows, generatedAt);
      } catch {
        // Fresh validated upstream data remains usable when the cache write fails.
      }
      return resultFor(products, rows, generatedAt, "upstream");
    } catch (error) {
      if (error instanceof KassalappGatewayError && error.code === "CANCELLED") {
        throw new DiscoveryRequestCancelledError();
      }
      const generatedAt = now();
      try {
        return resultFor(
          products,
          await this.dependencies.cache.getMany(eans),
          generatedAt,
          "cache",
        );
      } catch {
        throw new DiscoveryUnavailableError();
      }
    }
  }
}
