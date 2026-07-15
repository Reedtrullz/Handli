import type { PriceObservation, Product } from "@handleplan/domain";

import type { KassalappGateway } from "./client";

export class FakeKassalappGateway implements KassalappGateway {
  constructor(
    private readonly products: readonly Product[],
    private readonly prices: readonly PriceObservation[],
  ) {}

  async searchProducts(query: string, limit: number): Promise<Product[]> {
    const normalizedQuery = query.trim().toLocaleLowerCase("nb-NO");
    return this.products
      .filter((product) => product.name.toLocaleLowerCase("nb-NO").includes(normalizedQuery))
      .slice(0, limit)
      .map((product) => ({ ...product }));
  }

  async getBulkPrices(eans: string[]): Promise<PriceObservation[]> {
    const requested = new Set(eans);
    return this.prices
      .filter((price) => requested.has(price.ean))
      .map((price) => ({ ...price }));
  }
}
