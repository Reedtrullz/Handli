import type { PriceObservation, Product } from "@handleplan/domain";

import { KassalappGatewayError, type KassalappGateway } from "./client";

export class FakeKassalappGateway implements KassalappGateway {
  constructor(
    private readonly products: readonly Product[],
    private readonly prices: readonly PriceObservation[],
  ) {}

  async searchProducts(query: string, limit: number, signal?: AbortSignal): Promise<Product[]> {
    if (signal?.aborted) throw new KassalappGatewayError("CANCELLED");
    const normalizedQuery = query.trim().toLocaleLowerCase("nb-NO");
    return this.products
      .filter((product) => product.name.toLocaleLowerCase("nb-NO").includes(normalizedQuery))
      .slice(0, limit)
      .map((product) => ({ ...product }));
  }

  async getBulkPrices(eans: string[], signal?: AbortSignal): Promise<PriceObservation[]> {
    if (signal?.aborted) throw new KassalappGatewayError("CANCELLED");
    const requested = new Set(eans);
    return this.prices
      .filter((price) => requested.has(price.ean))
      .map((price) => ({ ...price }));
  }
}
