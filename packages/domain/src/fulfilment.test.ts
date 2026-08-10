import { describe, expect, it } from "vitest";

import {
  calculateCheckoutCost,
  calculatePackageFulfilment,
  type MoneyOre,
  type OfficialOffer,
  type OfficialOfferEvaluationContext,
} from "./index";

const ore = (value: number): MoneyOre => value as MoneyOre;

const context: OfficialOfferEvaluationContext = {
  now: new Date("2026-07-16T12:00:00.000Z"),
  maxEvidenceAgeMs: 14 * 24 * 60 * 60 * 1_000,
  location: { countryCode: "NO", regionCode: "NO-03" },
  channel: "in-store",
  enabledSourceIds: ["retailer-feed"],
  enabledMembershipProgramIds: [],
};

function offer(overrides: Partial<OfficialOffer> = {}): OfficialOffer {
  return {
    contractVersion: 1,
    kind: "official-offer",
    id: "offer:coffee",
    sourceId: "retailer-feed",
    sourceRecordId: "campaign:42",
    chainId: "extra",
    productMatch: { kind: "exact", canonicalProductId: "product:coffee" },
    pricing: { kind: "multibuy", quantity: 2, totalOre: ore(10_000) },
    beforePriceOre: ore(6_990),
    conditions: [{ kind: "public" }],
    applicability: {
      contractVersion: 1,
      startsAt: "2026-07-14T00:00:00.000Z",
      endsAt: "2026-07-19T23:59:59.999Z",
      geographicScope: { kind: "regions", countryCode: "NO", regionCodes: ["NO-03"] },
      channels: ["in-store"],
    },
    evidenceLevel: "reviewed",
    capturedAt: "2026-07-15T10:00:00.000Z",
    ...overrides,
  };
}

describe("calculatePackageFulfilment", () => {
  it.each([
    {
      label: "1.5 l with two 1 l packages",
      requested: { amount: 1_500, unit: "ml" as const },
      packageMeasure: { amount: 1_000, unit: "ml" as const },
      packageCount: 2,
      fulfilledAmount: 2_000,
      surplusAmount: 500,
    },
    {
      label: "1 kg with two 500 g packages",
      requested: { amount: 1_000, unit: "g" as const },
      packageMeasure: { amount: 500, unit: "g" as const },
      packageCount: 2,
      fulfilledAmount: 1_000,
      surplusAmount: 0,
    },
    {
      label: "seven pieces with two six-piece multipacks",
      requested: { amount: 7, unit: "piece" as const },
      packageMeasure: { amount: 6, unit: "piece" as const },
      packageCount: 2,
      fulfilledAmount: 12,
      surplusAmount: 5,
    },
    {
      label: "two exact packages",
      requested: { amount: 2, unit: "package" as const },
      packageMeasure: { amount: 1, unit: "package" as const },
      packageCount: 2,
      fulfilledAmount: 2,
      surplusAmount: 0,
    },
  ])("calculates $label using integer arithmetic", ({
    requested,
    packageMeasure,
    packageCount,
    fulfilledAmount,
    surplusAmount,
  }) => {
    expect(calculatePackageFulfilment({
      canonicalProductId: "product:test",
      needId: "need:test",
      requested,
      packageMeasure,
    })).toEqual({
      state: "complete",
      fulfilment: {
        contractVersion: 1,
        canonicalProductId: "product:test",
        needId: "need:test",
        requested,
        packageMeasure,
        packageCount,
        fulfilledAmount,
        surplusAmount,
        complete: true,
      },
    });
  });

  it("fails closed for incompatible units, malformed measures, and safe-integer overflow", () => {
    expect(calculatePackageFulfilment({
      canonicalProductId: "product:test",
      needId: "need:test",
      requested: { amount: 1_000, unit: "ml" },
      packageMeasure: { amount: 500, unit: "g" },
    })).toEqual({ state: "unavailable", reason: "incompatible-unit" });

    expect(calculatePackageFulfilment({
      canonicalProductId: "product:test",
      needId: "need:test",
      requested: { amount: 0, unit: "ml" },
      packageMeasure: { amount: 500, unit: "ml" },
    })).toEqual({ state: "unavailable", reason: "invalid" });

    expect(calculatePackageFulfilment({
      canonicalProductId: "product:test",
      needId: "need:test",
      requested: { amount: Number.MAX_SAFE_INTEGER, unit: "piece" },
      packageMeasure: { amount: Number.MAX_SAFE_INTEGER - 1, unit: "piece" },
    })).toEqual({ state: "unavailable", reason: "overflow" });
  });
});

describe("calculateCheckoutCost", () => {
  it("uses multibuy groups and ordinary price for the non-multiple remainder", () => {
    expect(calculateCheckoutCost({
      canonicalProductId: "product:coffee",
      chainId: "extra",
      packageCount: 5,
      ordinaryUnitPriceOre: 6_000,
      offer: offer(),
      offerContext: context,
    })).toEqual({
      appliedOfferId: "offer:coffee",
      ordinaryTotalOre: 30_000,
      savingOre: 4_000,
      totalOre: 26_000,
    });
  });

  it("uses a unit offer for every package and rejects non-lowering offers", () => {
    expect(calculateCheckoutCost({
      canonicalProductId: "product:coffee",
      chainId: "extra",
      packageCount: 3,
      ordinaryUnitPriceOre: 6_000,
      offer: offer({ pricing: { kind: "unit", unitPriceOre: ore(4_500) } }),
      offerContext: context,
    })).toEqual({
      appliedOfferId: "offer:coffee",
      ordinaryTotalOre: 18_000,
      savingOre: 4_500,
      totalOre: 13_500,
    });

    expect(calculateCheckoutCost({
      canonicalProductId: "product:coffee",
      chainId: "extra",
      packageCount: 3,
      ordinaryUnitPriceOre: 4_000,
      offer: offer({ pricing: { kind: "unit", unitPriceOre: ore(4_500) }, beforePriceOre: ore(5_000) }),
      offerContext: context,
    })).toEqual({ ordinaryTotalOre: 12_000, savingOre: 0, totalOre: 12_000 });
    expect(calculateCheckoutCost({
      canonicalProductId: "product:coffee",
      chainId: "extra",
      packageCount: 2,
      ordinaryUnitPriceOre: 1,
      offer: offer({
        beforePriceOre: ore(2_147_483_647),
        pricing: { kind: "unit", unitPriceOre: ore(2_147_483_647) },
      }),
      offerContext: context,
    })).toEqual({ ordinaryTotalOre: 2, savingOre: 0, totalOre: 2 });
  });

  it("applies member offers only when the membership is explicitly enabled", () => {
    const memberOffer = offer({
      conditions: [{ kind: "member", programId: "coop-medlem" }],
      pricing: { kind: "unit", unitPriceOre: ore(4_000) },
    });
    const input = {
      canonicalProductId: "product:coffee",
      chainId: "extra",
      packageCount: 2,
      ordinaryUnitPriceOre: 6_000,
      offer: memberOffer,
      offerContext: context,
    } as const;

    expect(calculateCheckoutCost(input)).toEqual({
      ordinaryTotalOre: 12_000,
      savingOre: 0,
      totalOre: 12_000,
    });
    expect(calculateCheckoutCost({
      ...input,
      offerContext: { ...context, enabledMembershipProgramIds: ["coop-medlem"] },
    })).toEqual({
      appliedOfferId: "offer:coffee",
      ordinaryTotalOre: 12_000,
      savingOre: 4_000,
      totalOre: 8_000,
    });
  });

  it("fails closed for wrong products, chains, minimum quantities, and unsafe totals", () => {
    const minimum = offer({
      conditions: [{ kind: "public" }, { kind: "minimum-quantity", quantity: 3 }],
      pricing: { kind: "unit", unitPriceOre: ore(4_000) },
    });
    const ordinary = { ordinaryTotalOre: 12_000, savingOre: 0, totalOre: 12_000 };

    expect(calculateCheckoutCost({
      canonicalProductId: "product:coffee",
      chainId: "extra",
      packageCount: 2,
      ordinaryUnitPriceOre: 6_000,
      offer: minimum,
      offerContext: context,
    })).toEqual(ordinary);
    expect(calculateCheckoutCost({
      canonicalProductId: "product:other",
      chainId: "extra",
      packageCount: 2,
      ordinaryUnitPriceOre: 6_000,
      offer: offer(),
      offerContext: context,
    })).toEqual(ordinary);
    expect(calculateCheckoutCost({
      canonicalProductId: "product:coffee",
      chainId: "rema-1000",
      packageCount: 2,
      ordinaryUnitPriceOre: 6_000,
      offer: offer(),
      offerContext: context,
    })).toEqual(ordinary);
    expect(calculateCheckoutCost({
      canonicalProductId: "product:coffee",
      chainId: "extra",
      packageCount: Number.MAX_SAFE_INTEGER,
      ordinaryUnitPriceOre: 2,
      offerContext: context,
    })).toEqual({ state: "unavailable", reason: "overflow" });
    expect(calculateCheckoutCost({
      canonicalProductId: "product:coffee",
      chainId: "extra",
      packageCount: 2,
      ordinaryUnitPriceOre: 2_147_483_647,
      offerContext: context,
    })).toEqual({ state: "unavailable", reason: "overflow" });
  });
});
