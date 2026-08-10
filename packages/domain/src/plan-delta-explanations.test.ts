import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";

import {
  derivePlanDeltaExplanationsV1,
  planDeltaExplanationSetV1Schema,
  type ComparisonScope,
  type MoneyOre,
  type PlanDeltaAssignmentEvidenceV1,
  type PlanResultV2,
  type TravelRouteEvidence,
} from "./index";

const GENERATED_AT = "2026-07-17T12:00:00.000Z";
const MARKET = { contractVersion: 1, countryCode: "NO", kind: "national" } as const;
const GTIN_MILK = "7038010000010";
const GTIN_COFFEE = "7038010000027";
const GTIN_MILK_ALTERNATIVE = "7038010000034";
const money = (value: number) => value as MoneyOre;

function scope(evidenceId: string, completeness: "complete" | "partial"): ComparisonScope {
  return {
    contractVersion: 1,
    completeness,
    evaluatedAt: GENERATED_AT,
    expectedChainIds: ["bunnpris", "extra", "rema-1000"],
    entries: [
      {
        chainId: "bunnpris",
        status: evidenceId.includes("bunnpris")
          ? { kind: "priced", evidenceId }
          : completeness === "complete"
            ? { kind: "known-not-carried", sourceId: "source:coverage", checkedAt: GENERATED_AT }
            : { kind: "unknown", reason: "not-checked" },
      },
      {
        chainId: "extra",
        status: evidenceId.includes("extra")
          ? { kind: "priced", evidenceId }
          : { kind: "known-not-carried", sourceId: "source:coverage", checkedAt: GENERATED_AT },
      },
      {
        chainId: "rema-1000",
        status: { kind: "known-not-carried", sourceId: "source:coverage", checkedAt: GENERATED_AT },
      },
    ],
  };
}

function assignment(input: {
  canonicalProductId: string;
  chain: "bunnpris" | "extra";
  costOre: number;
  ean: string;
  needId: string;
  offerSavingOre?: number;
  packageMeasure: { amount: number; unit: "g" | "ml" };
  purchased: { amount: number; unit: "g" | "ml" };
  requested: { amount: number; unit: "g" | "ml" };
  surplus: { amount: number; unit: "g" | "ml" };
}) {
  const offerSavingOre = input.offerSavingOre ?? 0;
  const offerId = offerSavingOre > 0 ? "offer:milk:bunnpris" : undefined;
  return {
    canonicalProductId: input.canonicalProductId,
    chain: input.chain,
    checkout: {
      ...(offerId === undefined ? {} : { appliedOfferId: offerId }),
      ordinaryTotalOre: money(input.costOre + offerSavingOre),
      savingOre: money(offerSavingOre),
      totalOre: money(input.costOre),
    },
    costOre: money(input.costOre),
    ean: input.ean,
    fulfilment: {
      canonicalProductId: input.canonicalProductId,
      complete: true as const,
      contractVersion: 2 as const,
      needId: input.needId,
      packageCount: input.purchased.amount / input.packageMeasure.amount,
      packageMeasure: input.packageMeasure,
      purchased: input.purchased,
      requested: input.requested,
      surplus: input.surplus,
    },
    needId: input.needId,
    observedAt: "2026-07-17T11:00:00.000Z",
    ...(offerId === undefined ? {} : {
      officialOffer: {
        capturedAt: "2026-07-17T10:00:00.000Z",
        id: offerId,
        sourceId: "source:offers",
        sourceRecordId: "record:offer:milk:bunnpris",
      },
    }),
    source: "source:prices",
  };
}

function plans(referenceTotal = 10_000, savingTotal = 7_000): PlanResultV2[] {
  const referenceCoffee = assignment({
    canonicalProductId: "product:coffee",
    chain: "extra",
    costOre: 4_000,
    ean: GTIN_COFFEE,
    needId: "need:coffee",
    packageMeasure: { amount: 500, unit: "g" },
    purchased: { amount: 500, unit: "g" },
    requested: { amount: 500, unit: "g" },
    surplus: { amount: 0, unit: "g" },
  });
  const referenceMilk = assignment({
    canonicalProductId: "product:milk",
    chain: "extra",
    costOre: referenceTotal - 4_000,
    ean: GTIN_MILK,
    needId: "need:milk",
    packageMeasure: { amount: 1_000, unit: "ml" },
    purchased: { amount: 2_000, unit: "ml" },
    requested: { amount: 1_500, unit: "ml" },
    surplus: { amount: 500, unit: "ml" },
  });
  const savingCoffee = assignment({
    canonicalProductId: "product:coffee",
    chain: "extra",
    costOre: 4_000,
    ean: GTIN_COFFEE,
    needId: "need:coffee",
    packageMeasure: { amount: 500, unit: "g" },
    purchased: { amount: 500, unit: "g" },
    requested: { amount: 500, unit: "g" },
    surplus: { amount: 0, unit: "g" },
  });
  const savingMilk = assignment({
    canonicalProductId: "product:milk:alternative",
    chain: "bunnpris",
    costOre: savingTotal - 4_000,
    ean: GTIN_MILK_ALTERNATIVE,
    needId: "need:milk",
    offerSavingOre: 500,
    packageMeasure: { amount: 750, unit: "ml" },
    purchased: { amount: 1_500, unit: "ml" },
    requested: { amount: 1_500, unit: "ml" },
    surplus: { amount: 0, unit: "ml" },
  });
  return [
    {
      assignments: [referenceCoffee, referenceMilk],
      chains: ["extra"],
      coverage: 1,
      freshness: { "need:coffee": "eligible", "need:milk": "eligible" },
      id: "plan:convenience",
      substitutions: [],
      totalOre: money(referenceTotal),
    },
    {
      assignments: [savingCoffee, savingMilk],
      chains: ["bunnpris", "extra"],
      coverage: 1,
      freshness: { "need:coffee": "eligible", "need:milk": "eligible" },
      id: "plan:savings",
      substitutions: ["need:milk"],
      totalOre: money(savingTotal),
    },
  ];
}

function bindings(
  candidates: readonly PlanResultV2[],
  completeness: "complete" | "partial" = "complete",
): PlanDeltaAssignmentEvidenceV1[] {
  return candidates.flatMap((plan) => plan.assignments.map((candidate) => {
    const evidenceId = `price:${candidate.chain}:${candidate.needId}`;
    return {
      planId: plan.id,
      needId: candidate.needId,
      canonicalProductId: candidate.canonicalProductId,
      chainId: candidate.chain,
      evidenceId,
      ...(candidate.checkout.appliedOfferId === undefined
        ? {}
        : { offerId: candidate.checkout.appliedOfferId }),
      comparisonScope: scope(evidenceId, completeness),
    };
  }));
}

function routes(candidates: readonly PlanResultV2[]): TravelRouteEvidence[] {
  return candidates.map((plan, index) => ({
    aggregate: {
      calculatedAt: GENERATED_AT,
      distanceMeters: index === 0 ? 4_000 : 6_500,
      durationSeconds: index === 0 ? 600 : 900,
      mode: "car",
      providerSourceId: "source:valhalla",
      routeFingerprint: `route:${index}:${"r".repeat(32)}`,
    },
    planId: plan.id,
    stops: plan.chains.map((chainId, stopIndex) => ({
      branchId: `branch:${chainId}`,
      chainId,
      name: `${chainId} fixture`,
      sequence: stopIndex + 1,
    })),
  }));
}

describe("server-owned V1 plan-delta explanations", () => {
  it("derives price, stores, per-need product/quantity/offer, and optional travel changes", () => {
    const candidates = plans();
    const result = derivePlanDeltaExplanationsV1({
      plans: candidates,
      generatedAt: GENERATED_AT,
      marketContext: MARKET,
      assignmentEvidence: bindings(candidates),
      travelRoutes: routes(candidates),
    });

    expect(planDeltaExplanationSetV1Schema.safeParse(result).success).toBe(true);
    expect(result?.binding).toMatchObject({
      generatedAt: GENERATED_AT,
      comparisonScope: "complete",
      planIds: ["plan:convenience", "plan:savings"],
    });
    expect(result?.entries[1]).toMatchObject({
      price: { kind: "cheaper", differenceOre: 3_000, savingOre: 3_000 },
      offerSaving: { kind: "documented", amountOre: 500 },
      stores: { addedChainIds: ["bunnpris"], count: 2, referenceCount: 1 },
      travel: {
        kind: "compared",
        durationSeconds: { kind: "more", difference: 300 },
        distanceMeters: { kind: "more", difference: 2_500 },
      },
    });
    expect(result?.entries[1]?.needs.find(({ needId }) => needId === "need:milk"))
      .toMatchObject({
        product: { kind: "changed" },
        quantity: { kind: "changed", from: { packageCount: 2 }, to: { packageCount: 2 } },
        offer: { kind: "added", toOfferId: "offer:milk:bunnpris" },
        chain: { kind: "changed", fromChainId: "extra", toChainId: "bunnpris" },
      });
  });

  it("withholds every numeric price and offer claim when coverage is partial", () => {
    const candidates = plans();
    const result = derivePlanDeltaExplanationsV1({
      plans: candidates,
      generatedAt: GENERATED_AT,
      marketContext: MARKET,
      assignmentEvidence: bindings(candidates, "partial"),
    });

    expect(result?.binding).toMatchObject({
      comparisonScope: "partial",
      unresolvedReasons: ["unknown-coverage", "partial-coverage"],
    });
    expect(result?.entries[1]?.price).toEqual({
      kind: "withheld",
      reason: "unknown-coverage",
      message: "Prisforskjell oppgis ikke fordi deler av kjededekningen er ukjent eller utdatert.",
    });
    expect(result?.entries[1]?.offerSaving).toMatchObject({
      kind: "withheld",
      reason: "unknown-coverage",
      message: "Dokumentert tilbudssparing oppgis ikke fordi deler av kjededekningen er ukjent eller utdatert.",
    });
    expect(result?.entries.map(({ presentation }) => presentation)).toEqual([
      { role: "alternative", label: "Alternativ 1" },
      { role: "alternative", label: "Alternativ 2" },
    ]);
    expect("differenceOre" in (result?.entries[1]?.price ?? {})).toBe(false);
    expect(result?.entries.every((entry) => entry.travel === undefined)).toBe(true);
  });

  it("does not label a travel-rescued, more expensive plan as the savings winner", () => {
    const candidates = plans(10_000, 11_000);
    const travelRoutes = routes(candidates).map((route, index) => ({
      ...route,
      aggregate: {
        ...route.aggregate,
        distanceMeters: index === 0 ? 8_000 : 1_000,
        durationSeconds: index === 0 ? 1_000 : 100,
      },
    }));

    const result = derivePlanDeltaExplanationsV1({
      plans: candidates,
      generatedAt: GENERATED_AT,
      marketContext: MARKET,
      assignmentEvidence: bindings(candidates),
      travelRoutes,
    });

    expect(result?.entries.map(({ presentation }) => presentation)).toEqual([
      { role: "convenience", label: "Enklest og lavest pris" },
      { role: "alternative", label: "Kortest reise" },
    ]);
    expect(result?.entries[1]?.price).toMatchObject({
      kind: "more-expensive",
      differenceOre: 1_000,
    });
    expect(result?.entries.some(({ presentation }) => presentation.label === "Mest spart"))
      .toBe(false);
  });

  it("binds non-selected priced evidence that establishes the comparison scope", () => {
    const candidates = plans();
    const evidence = bindings(candidates);
    const first = evidence[0]!;
    evidence[0] = {
      ...first,
      comparisonScope: {
        ...first.comparisonScope,
        entries: first.comparisonScope.entries.map((entry) => entry.chainId === "rema-1000"
          ? { chainId: entry.chainId, status: { kind: "priced" as const, evidenceId: "price:rema-1000:comparison" } }
          : entry),
      },
    };

    const result = derivePlanDeltaExplanationsV1({
      plans: candidates,
      generatedAt: GENERATED_AT,
      marketContext: MARKET,
      assignmentEvidence: evidence,
    });

    expect(result?.binding.evidenceIds).toContain("price:rema-1000:comparison");
  });

  it("fails closed on mixed snapshots, detached evidence, and dominated alternatives", () => {
    const candidates = plans();
    const validBindings = bindings(candidates);
    expect(derivePlanDeltaExplanationsV1({
      plans: candidates,
      generatedAt: GENERATED_AT,
      marketContext: MARKET,
      assignmentEvidence: validBindings.map((binding, index) => index === 0
        ? { ...binding, comparisonScope: { ...binding.comparisonScope, evaluatedAt: "2026-07-17T11:59:59.000Z" } }
        : binding),
    })).toBeUndefined();
    expect(derivePlanDeltaExplanationsV1({
      plans: candidates,
      generatedAt: GENERATED_AT,
      marketContext: MARKET,
      assignmentEvidence: validBindings.slice(1),
    })).toBeUndefined();
    const dominated = structuredClone(candidates);
    dominated[1]!.totalOre = money(11_000);
    dominated[1]!.assignments[1]!.costOre = money(7_000);
    dominated[1]!.assignments[1]!.checkout.totalOre = money(7_000);
    dominated[1]!.assignments[1]!.checkout.ordinaryTotalOre = money(7_500);
    expect(derivePlanDeltaExplanationsV1({
      plans: dominated,
      generatedAt: GENERATED_AT,
      marketContext: MARKET,
      assignmentEvidence: bindings(dominated),
    })).toBeUndefined();
    const duplicatedRouteFingerprints = routes(candidates).map((route, index, all) => index === 0
      ? route
      : { ...route, aggregate: { ...route.aggregate, routeFingerprint: all[0]!.aggregate.routeFingerprint } });
    expect(derivePlanDeltaExplanationsV1({
      plans: candidates,
      generatedAt: GENERATED_AT,
      marketContext: MARKET,
      assignmentEvidence: validBindings,
      travelRoutes: duplicatedRouteFingerprints,
    })).toBeUndefined();
  });

  test.prop([
    fc.integer({ min: 8_000, max: 80_000 }),
    fc.integer({ min: 100, max: 3_000 }),
    fc.boolean(),
  ], { numRuns: 100 })(
    "is deterministic under evidence permutation and reports the exact safe-integer saving",
    (referenceTotal, saving, reverseEvidence) => {
      const candidates = plans(referenceTotal, referenceTotal - saving);
      const evidence = bindings(candidates);
      const result = derivePlanDeltaExplanationsV1({
        plans: candidates,
        generatedAt: GENERATED_AT,
        marketContext: MARKET,
        assignmentEvidence: reverseEvidence ? [...evidence].reverse() : evidence,
      });
      expect(result?.entries[1]?.price).toMatchObject({
        kind: "cheaper",
        differenceOre: saving,
        savingOre: saving,
      });
      const canonical = derivePlanDeltaExplanationsV1({
        plans: candidates,
        generatedAt: GENERATED_AT,
        marketContext: MARKET,
        assignmentEvidence: evidence,
      });
      expect(result).toEqual(canonical);
      expect(result?.entries.every(({ stores }) => stores.count <= 3)).toBe(true);
    },
  );
});
