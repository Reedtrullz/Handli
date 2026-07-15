import type { PriceObservation, Product } from "@handleplan/domain";
import { describe, expect, it } from "vitest";

import { FakeKassalappGateway } from "./fake";

const product: Product = {
  ean: "7038010000013",
  name: "Tine Lettmelk 1 %",
};
const price: PriceObservation = {
  amountOre: 2190 as PriceObservation["amountOre"],
  chain: "extra",
  ean: product.ean,
  observedAt: "2026-07-15T08:30:00.000Z",
  source: "kassalapp",
};

describe("FakeKassalappGateway", () => {
  it("returns deterministic query and EAN-filtered copies", async () => {
    const gateway = new FakeKassalappGateway([product], [price]);

    const firstSearch = await gateway.searchProducts("LETTMELK", 10);
    const secondSearch = await gateway.searchProducts("LETTMELK", 10);
    const prices = await gateway.getBulkPrices([product.ean]);

    expect(firstSearch).toEqual([product]);
    expect(secondSearch).toEqual(firstSearch);
    expect(firstSearch[0]).not.toBe(product);
    expect(prices).toEqual([price]);
    expect(prices[0]).not.toBe(price);
  });
});
