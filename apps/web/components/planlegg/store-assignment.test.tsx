// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import type { MoneyOre, Need, Product } from "@handleplan/domain";
import { afterEach, describe, expect, it } from "vitest";

import { StoreAssignment } from "./store-assignment";

afterEach(cleanup);

describe("StoreAssignment quantities", () => {
  it.each([
    ["each", 2, "2×"],
    ["g", 750, "750 g"],
    ["ml", 1_000, "1 000 ml"],
  ] as const)("renders %s quantities from the need unit", (quantityUnit, quantity, expected) => {
    const need: Need = { id: "need", query: "Vare", quantity, quantityUnit, matchRuleId: "rule", required: true };
    const product: Product = { ean: "7038010000013", name: "Vare" };
    render(
      <StoreAssignment
        chain="extra"
        order={1}
        assignments={[{ needId: "need", ean: product.ean, chain: "extra", quantity, costOre: 1_000 as MoneyOre, observedAt: "2026-07-15T10:00:00.000Z", source: "kassalapp" }]}
        needs={[need]}
        products={[product]}
      />,
    );
    expect(screen.getByText(expected)).toBeVisible();
  });
});
