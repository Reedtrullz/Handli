// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import type {
  ExactProductPlanApiProductSummary,
  MoneyOre,
  OfficialOffer,
  PlanAssignmentV2,
} from "@handleplan/domain";
import { afterEach, describe, expect, it } from "vitest";

import { StoreAssignment } from "./store-assignment";

const product: ExactProductPlanApiProductSummary = {
  brand: "TINE",
  catalogEvidence: {
    observedAt: "2026-07-15T10:00:00.000Z",
    source: {
      contractVersion: 1,
      displayName: "Kassalapp",
      id: "kassalapp",
      sourceClass: "catalog",
      state: "approved",
    },
    sourceRecordId: `source-record:${"a".repeat(64)}`,
  },
  displayName: "Canonical TINE Lettmelk",
  gtin: "7038010000010",
  packageMeasure: { amount: 500, unit: "ml" },
  unitsPerPack: 1,
};

const memberOffer: OfficialOffer = {
  applicability: {
    channels: ["in-store"],
    contractVersion: 1,
    endsAt: "2026-07-17T12:00:00.000Z",
    geographicScope: { countryCode: "NO", kind: "national" },
    startsAt: "2026-07-14T12:00:00.000Z",
  },
  beforePriceOre: 3_000 as MoneyOre,
  capturedAt: "2026-07-15T09:00:00.000Z",
  chainId: "extra",
  conditions: [{ kind: "member", programId: "source-neutral-program" }],
  contractVersion: 1,
  evidenceLevel: "reviewed",
  id: "offer:milk",
  kind: "official-offer",
  pricing: { kind: "unit", unitPriceOre: 2_500 as MoneyOre },
  productMatch: { canonicalProductId: "product:milk", kind: "exact" },
  sourceId: "kassalapp",
  sourceRecordId: "source-record:offer:milk",
};

function assignment(
  requested: PlanAssignmentV2["fulfilment"]["requested"],
  packageCount: number,
  purchased: PlanAssignmentV2["fulfilment"]["purchased"],
  surplus: PlanAssignmentV2["fulfilment"]["surplus"],
  offer = false,
): PlanAssignmentV2 {
  return {
    canonicalProductId: "product:milk",
    chain: "extra",
    checkout: {
      ...(offer ? { appliedOfferId: "offer:milk" } : {}),
      ordinaryTotalOre: (offer ? 3_000 : 2_500) as MoneyOre,
      savingOre: (offer ? 500 : 0) as MoneyOre,
      totalOre: 2_500 as MoneyOre,
    },
    costOre: 2_500 as MoneyOre,
    ean: product.gtin,
    fulfilment: {
      canonicalProductId: "product:milk",
      complete: true,
      contractVersion: 2,
      needId: "milk",
      packageCount,
      packageMeasure: { amount: 500, unit: requested.unit === "package" ? "ml" : requested.unit },
      purchased,
      requested,
      surplus,
    },
    needId: "milk",
    observedAt: "2026-07-15T10:00:00.000Z",
    ...(offer ? {
      officialOffer: {
        capturedAt: "2026-07-15T09:00:00.000Z",
        id: "offer:milk",
        sourceId: "kassalapp",
        sourceRecordId: "source-record:offer:milk",
      },
    } : {}),
    source: "kassalapp",
  };
}

afterEach(cleanup);

describe("StoreAssignment strict fulfilment", () => {
  it.each([
    [{ amount: 2, unit: "package" as const }, 2, { amount: 2, unit: "package" as const }, { amount: 0, unit: "package" as const }, "2 pakker"],
    [{ amount: 750, unit: "g" as const }, 2, { amount: 1_000, unit: "g" as const }, { amount: 250, unit: "g" as const }, "750 g"],
    [{ amount: 1_000, unit: "ml" as const }, 2, { amount: 1_000, unit: "ml" as const }, { amount: 0, unit: "ml" as const }, "1 000 ml"],
  ])("renders requested and purchased package fulfilment", (requested, count, purchased, surplus, expected) => {
    render(
      <StoreAssignment
        chain="extra"
        order={1}
        assignments={[assignment(requested, count, purchased, surplus)]}
        officialOffers={[]}
        products={[product]}
      />,
    );
    expect(screen.getByText(expected)).toBeVisible();
    expect(screen.getByText("Canonical TINE Lettmelk")).toBeVisible();
    expect(screen.queryByText(/Dekker «/)).not.toBeInTheDocument();
  });

  it("renders checkout before-price, saving and immutable offer source", () => {
    render(
      <StoreAssignment
        chain="extra"
        order={1}
        assignments={[assignment(
          { amount: 1, unit: "package" },
          1,
          { amount: 1, unit: "package" },
          { amount: 0, unit: "package" },
          true,
        )]}
        officialOffers={[memberOffer]}
        products={[product]}
      />,
    );

    expect(screen.getByText("Før 30,00 kr")).toBeVisible();
    expect(screen.getByText("5,00 kr spart")).toBeVisible();
    expect(screen.getByText(/Offisielt tilbud brukt · kilde kassalapp/)).toBeVisible();
    expect(screen.getByText("Medlemspris hos Extra krever medlemskap.")).toBeVisible();
    expect(document.body).not.toHaveTextContent("source-neutral-program");
  });
});
