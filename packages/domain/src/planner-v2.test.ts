import { describe, expect, it } from "vitest";

import {
  attachOptionalTravelEvidenceV2,
  calculatePlansV2,
  enumerateCompletePlanCandidatesV2,
  fulfilmentV2Schema,
  paretoFrontierV2,
  planResultV2Schema,
  serverPlanningInputV2Schema,
  type MoneyOre,
  type OfficialOffer,
  type ServerPlanningInputV2,
} from "./index";

const NOW = new Date("2026-07-16T12:00:00.000Z");
const EAN = "7038010000010";
const ore = (amount: number) => amount as MoneyOre;

function offer(overrides: Partial<OfficialOffer> = {}): OfficialOffer {
  return {
    contractVersion: 1,
    kind: "official-offer",
    id: "offer:extra:coffee",
    sourceId: "offer-feed",
    sourceRecordId: "campaign:42",
    chainId: "extra",
    productMatch: { kind: "exact", canonicalProductId: "product:coffee" },
    pricing: { kind: "multibuy", quantity: 2, totalOre: ore(10_000) },
    beforePriceOre: ore(6_000),
    conditions: [{ kind: "public" }],
    applicability: {
      contractVersion: 1,
      startsAt: "2026-07-14T00:00:00.000Z",
      endsAt: "2026-07-19T23:59:59.999Z",
      geographicScope: {
        kind: "regions",
        countryCode: "NO",
        regionCodes: ["NO-03"],
      },
      channels: ["in-store"],
    },
    evidenceLevel: "reviewed",
    capturedAt: "2026-07-15T10:00:00.000Z",
    ...overrides,
  };
}

function input(
  overrides: Partial<ServerPlanningInputV2> = {},
): ServerPlanningInputV2 {
  return {
    contractVersion: 2,
    maxStores: 3,
    needs: [
      {
        id: "need:coffee",
        query: "kaffe",
        requested: { amount: 7, unit: "piece" },
        matchRuleId: "rule:coffee",
        required: true,
      },
    ],
    matchingRules: [
      {
        id: "rule:coffee",
        mode: "exact",
        exactEan: EAN,
        userApproved: true,
        explanation: "Bruk varen brukeren valgte.",
      },
    ],
    products: [
      {
        canonicalProductId: "product:coffee",
        ean: EAN,
        name: "Kaffe multipack",
        packageMeasure: { amount: 6, unit: "piece" },
      },
    ],
    ordinaryPrices: [
      {
        ean: EAN,
        chain: "extra",
        amountOre: ore(6_000),
        observedAt: "2026-07-16T11:00:00.000Z",
        source: "licensed-price-feed",
      },
    ],
    officialOffers: [],
    offerEligibility: {
      maxEvidenceAgeMs: 14 * 24 * 60 * 60 * 1_000,
      location: { countryCode: "NO", regionCode: "NO-03" },
      channel: "in-store",
      enabledSourceIds: ["offer-feed"],
      enabledMembershipProgramIds: [],
    },
    ...overrides,
  };
}

describe("server planning v2 contracts", () => {
  it("accepts normalized g, ml, piece, and explicit package requests", () => {
    for (const requested of [
      { amount: 1_000, unit: "g" as const },
      { amount: 1_500, unit: "ml" as const },
      { amount: 7, unit: "piece" as const },
      { amount: 2, unit: "package" as const },
    ]) {
      expect(serverPlanningInputV2Schema.safeParse(input({
        needs: [{ ...input().needs[0]!, requested }],
      })).success).toBe(true);
    }
  });

  it("is strict, bounded, source-neutral, and rejects ambiguous identities", () => {
    expect(serverPlanningInputV2Schema.safeParse(input()).success).toBe(true);
    expect(serverPlanningInputV2Schema.safeParse({ ...input(), contractVersion: 1 }).success)
      .toBe(false);
    expect(serverPlanningInputV2Schema.safeParse({ ...input(), maxStores: 4 }).success)
      .toBe(false);
    expect(serverPlanningInputV2Schema.safeParse({ ...input(), browserProductName: "forged" }).success)
      .toBe(false);
    expect(serverPlanningInputV2Schema.safeParse(input({
      products: [input().products[0]!, { ...input().products[0]!, name: "conflict" }],
    })).success).toBe(false);
    expect(serverPlanningInputV2Schema.safeParse(input({
      officialOffers: [offer(), offer({ pricing: { kind: "unit", unitPriceOre: ore(1) } })],
    })).success).toBe(false);
    expect(serverPlanningInputV2Schema.safeParse(input({
      ordinaryPrices: [
        input().ordinaryPrices[0]!,
        {
          ...input().ordinaryPrices[0]!,
          amountOre: ore(5_500),
          observedAt: "2026-07-16T10:00:00.000Z",
          source: "second-licensed-feed",
        },
      ],
    })).success).toBe(false);
  });

  it("rejects internally inconsistent fulfilment and plans missing required fulfilment", () => {
    const validFulfilment = {
      contractVersion: 2,
      needId: "need:coffee",
      canonicalProductId: "product:coffee",
      requested: { amount: 7, unit: "piece" },
      packageMeasure: { amount: 6, unit: "piece" },
      packageCount: 2,
      purchased: { amount: 12, unit: "piece" },
      surplus: { amount: 5, unit: "piece" },
      complete: true,
    } as const;

    expect(fulfilmentV2Schema.safeParse(validFulfilment).success).toBe(true);
    expect(fulfilmentV2Schema.safeParse({
      ...validFulfilment,
      packageCount: 1,
    }).success).toBe(false);
    expect(fulfilmentV2Schema.safeParse({
      ...validFulfilment,
      purchased: { amount: 7, unit: "piece" },
      surplus: { amount: 0, unit: "piece" },
    }).success).toBe(false);

    const [plan] = calculatePlansV2(input(), NOW);
    expect(planResultV2Schema.safeParse(plan).success).toBe(true);
    expect(planResultV2Schema.safeParse({
      ...plan,
      assignments: plan?.assignments.map(({ fulfilment: _fulfilment, ...assignment }) => assignment),
    }).success).toBe(false);
    expect(planResultV2Schema.safeParse({ ...plan, freshness: {} }).success).toBe(false);
    expect(planResultV2Schema.safeParse({
      ...plan,
      substitutions: ["need:not-assigned"],
    }).success).toBe(false);
  });
});

describe("calculatePlansV2", () => {
  it("fulfils a requested piece count with whole multipacks and exposes all quantity facts", () => {
    const [plan] = calculatePlansV2(input(), NOW);

    expect(plan?.assignments).toEqual([
      {
        needId: "need:coffee",
        canonicalProductId: "product:coffee",
        ean: EAN,
        chain: "extra",
        costOre: 12_000,
        observedAt: "2026-07-16T11:00:00.000Z",
        source: "licensed-price-feed",
        fulfilment: {
          contractVersion: 2,
          needId: "need:coffee",
          canonicalProductId: "product:coffee",
          requested: { amount: 7, unit: "piece" },
          packageMeasure: { amount: 6, unit: "piece" },
          packageCount: 2,
          purchased: { amount: 12, unit: "piece" },
          surplus: { amount: 5, unit: "piece" },
          complete: true,
        },
        checkout: {
          ordinaryTotalOre: 12_000,
          savingOre: 0,
          totalOre: 12_000,
        },
      },
    ]);
    expect(plan?.totalOre).toBe(12_000);
  });

  it("treats an explicit package request as an exact package count while retaining pack contents", () => {
    const [plan] = calculatePlansV2(input({
      needs: [{
        ...input().needs[0]!,
        requested: { amount: 2, unit: "package" },
      }],
    }), NOW);

    expect(plan?.assignments[0]?.fulfilment).toEqual({
      contractVersion: 2,
      needId: "need:coffee",
      canonicalProductId: "product:coffee",
      requested: { amount: 2, unit: "package" },
      packageMeasure: { amount: 6, unit: "piece" },
      packageCount: 2,
      purchased: { amount: 2, unit: "package" },
      surplus: { amount: 0, unit: "package" },
      complete: true,
    });
    expect(plan?.totalOre).toBe(12_000);
  });

  it("ranks candidates by qualifying multibuy checkout total including ordinary remainder", () => {
    const ordinaryPrices = [
      input().ordinaryPrices[0]!,
      { ...input().ordinaryPrices[0]!, chain: "rema-1000" as const, amountOre: ore(5_500) },
    ];
    const [plan] = calculatePlansV2(input({
      needs: [{ ...input().needs[0]!, requested: { amount: 25, unit: "piece" } }],
      ordinaryPrices,
      officialOffers: [offer()],
      maxStores: 1,
    }), NOW);

    expect(plan?.chains).toEqual(["extra"]);
    expect(plan?.totalOre).toBe(26_000);
    expect(plan?.assignments[0]).toMatchObject({
      costOre: 26_000,
      fulfilment: { packageCount: 5, purchased: { amount: 30, unit: "piece" } },
      checkout: {
        appliedOfferId: "offer:extra:coffee",
        ordinaryTotalOre: 30_000,
        savingOre: 4_000,
        totalOre: 26_000,
      },
      officialOffer: {
        id: "offer:extra:coffee",
        sourceId: "offer-feed",
        sourceRecordId: "campaign:42",
        capturedAt: "2026-07-15T10:00:00.000Z",
      },
    });
  });

  it("fails closed when one product-chain cell has duplicate ordinary observations", () => {
    const threeFor = offer({
      id: "offer:three-for",
      sourceRecordId: "campaign:three-for",
      pricing: { kind: "multibuy", quantity: 3, totalOre: ore(12_000) },
    });
    const plans = calculatePlansV2(input({
      needs: [{ ...input().needs[0]!, requested: { amount: 37, unit: "piece" } }],
      ordinaryPrices: [
        input().ordinaryPrices[0]!,
        {
          ...input().ordinaryPrices[0]!,
          amountOre: ore(5_500),
          observedAt: "2026-07-16T10:00:00.000Z",
          source: "second-licensed-feed",
        },
      ],
      officialOffers: [threeFor],
      maxStores: 1,
    }), NOW);

    expect(plans).toEqual([]);
  });

  it("applies member and minimum-quantity conditions only when explicitly satisfied", () => {
    const member = offer({
      conditions: [
        { kind: "member", programId: "coop-medlem" },
        { kind: "minimum-quantity", quantity: 3 },
      ],
      pricing: { kind: "unit", unitPriceOre: ore(4_000) },
    });
    const ordinaryPrices = [
      input().ordinaryPrices[0]!,
      { ...input().ordinaryPrices[0]!, chain: "rema-1000" as const, amountOre: ore(5_500) },
    ];
    const base = input({
      needs: [{ ...input().needs[0]!, requested: { amount: 18, unit: "piece" } }],
      ordinaryPrices,
      officialOffers: [member],
      maxStores: 1,
    });

    expect(calculatePlansV2(base, NOW)[0]?.chains).toEqual(["rema-1000"]);
    expect(calculatePlansV2({
      ...base,
      offerEligibility: {
        ...base.offerEligibility,
        enabledMembershipProgramIds: ["coop-medlem"],
      },
    }, NOW)[0]).toMatchObject({
      chains: ["extra"],
      totalOre: 12_000,
    });

    const belowMinimum = {
      ...base,
      needs: [{ ...base.needs[0]!, requested: { amount: 12, unit: "piece" as const } }],
      offerEligibility: {
        ...base.offerEligibility,
        enabledMembershipProgramIds: ["coop-medlem"],
      },
    };
    expect(calculatePlansV2(belowMinimum, NOW)[0]?.chains).toEqual(["rema-1000"]);
  });

  it("chooses the cheapest eligible offer deterministically and ignores ineligible offers", () => {
    const cheap = offer({
      id: "offer:cheap",
      sourceRecordId: "campaign:cheap",
      pricing: { kind: "unit", unitPriceOre: ore(3_000) },
    });
    const expensive = offer({
      id: "offer:expensive",
      sourceRecordId: "campaign:expensive",
      pricing: { kind: "unit", unitPriceOre: ore(4_000) },
    });
    const wrongRegion = offer({
      id: "offer:wrong-region",
      sourceRecordId: "campaign:wrong-region",
      pricing: { kind: "unit", unitPriceOre: ore(1) },
      applicability: {
        ...offer().applicability,
        geographicScope: {
          kind: "regions",
          countryCode: "NO",
          regionCodes: ["NO-11"],
        },
      },
    });
    const base = input({ officialOffers: [expensive, wrongRegion, cheap] });
    const reordered = { ...base, officialOffers: [...base.officialOffers].reverse() };

    expect(calculatePlansV2(base, NOW)).toEqual(calculatePlansV2(reordered, NOW));
    expect(calculatePlansV2(base, NOW)[0]?.assignments[0]).toMatchObject({
      costOre: 6_000,
      checkout: { appliedOfferId: "offer:cheap" },
      officialOffer: { id: "offer:cheap" },
    });
  });

  it("preserves approved postal-directory evidence through planner offer eligibility", () => {
    const postal = offer({
      applicability: {
        ...offer().applicability,
        geographicScope: {
          countryCode: "NO",
          kind: "postal-set",
          postalCodes: ["0152", "0452"],
        },
      },
      id: "offer:postal-oslo",
      pricing: { kind: "unit", unitPriceOre: ore(3_000) },
      sourceRecordId: "campaign:postal-oslo",
    });
    const base = input({ officialOffers: [postal] });
    const withDirectory = input({
      ...base,
      offerEligibility: {
        ...base.offerEligibility,
        geographicDirectory: {
          state: "available",
          evaluatedAt: NOW.toISOString(),
          directory: {
            contractVersion: 1,
            countryCode: "NO",
            directoryVersionId: "postal-directory-2026-07",
            evidenceReference: "manifest:postal-directory-2026-07",
            publishedAt: "2026-07-16T09:30:00.000Z",
            regions: [{
              coverageState: "complete",
              evidenceReference: "manifest:oslo-postal-set",
              postalCodes: ["0152", "0452"],
              regionCode: "NO-03",
            }],
            reviewedAt: "2026-07-16T09:00:00.000Z",
            status: "approved",
            validFrom: "2026-07-16T09:30:00.000Z",
          },
        },
      },
    });

    expect(calculatePlansV2(base, NOW)[0]?.assignments[0]?.checkout.appliedOfferId)
      .toBeUndefined();
    expect(calculatePlansV2(withDirectory, NOW)[0]?.assignments[0]).toMatchObject({
      checkout: { appliedOfferId: postal.id, totalOre: 6_000 },
      costOre: 6_000,
    });
  });

  it("fails closed for incomplete baskets, incompatible measures, and unsafe money", () => {
    const secondNeed = {
      ...input().needs[0]!,
      id: "need:missing",
      matchRuleId: "rule:missing",
    };
    const secondRule = {
      ...input().matchingRules[0]!,
      id: "rule:missing",
      exactEan: "7038010000027",
    };

    expect(calculatePlansV2(input({
      needs: [...input().needs, secondNeed],
      matchingRules: [...input().matchingRules, secondRule],
    }), NOW)).toEqual([]);
    expect(calculatePlansV2(input({
      needs: [{ ...input().needs[0]!, requested: { amount: 1_000, unit: "g" } }],
    }), NOW)).toEqual([]);
    expect(calculatePlansV2(input({
      needs: [{ ...input().needs[0]!, requested: { amount: 2, unit: "package" } }],
      ordinaryPrices: [{ ...input().ordinaryPrices[0]!, amountOre: ore(2_147_483_647) }],
    }), NOW)).toEqual([]);
    expect(calculatePlansV2(input({
      ordinaryPrices: [{ ...input().ordinaryPrices[0]!, source: " licensed-price-feed" }],
    }), NOW)).toEqual([]);
  });

  it("preserves max-three-store and stable identity/order invariants", () => {
    const ordinaryPrices = [
      input().ordinaryPrices[0]!,
      { ...input().ordinaryPrices[0]!, chain: "rema-1000" as const },
      { ...input().ordinaryPrices[0]!, chain: "bunnpris" as const },
    ];
    const base = input({ ordinaryPrices, officialOffers: [offer()] });
    const reordered = {
      ...base,
      ordinaryPrices: [...base.ordinaryPrices].reverse(),
      products: [...base.products].reverse(),
      matchingRules: [...base.matchingRules].reverse(),
      officialOffers: [...base.officialOffers].reverse(),
    };

    const first = calculatePlansV2(base, NOW);
    const complete = enumerateCompletePlanCandidatesV2(base, NOW);
    const reorderedComplete = enumerateCompletePlanCandidatesV2(reordered, NOW);
    expect(calculatePlansV2(reordered, NOW)).toEqual(first);
    expect(reorderedComplete).toEqual(complete);
    expect(complete.every(({ chains }) => chains.length <= 3)).toBe(true);
    expect(new Set(complete.map(({ id }) => id)).size).toBe(complete.length);
    expect(first.every(({ chains }) => chains.length <= 3)).toBe(true);
    expect(new Set(first.map(({ id }) => id)).size).toBe(first.length);
  });

  it("keeps price-dominated complete candidates available until travel evidence is attached", () => {
    const planningInput = input({
      maxStores: 1,
      officialOffers: [],
      ordinaryPrices: [
        input().ordinaryPrices[0]!,
        {
          ...input().ordinaryPrices[0]!,
          amountOre: ore(5_500),
          chain: "rema-1000",
        },
      ],
    });
    const completeCandidates = enumerateCompletePlanCandidatesV2(planningInput, NOW);

    expect(completeCandidates.map(({ chains, totalOre }) => [chains, totalOre])).toEqual([
      [["rema-1000"], 11_000],
      [["extra"], 12_000],
    ]);
    expect(calculatePlansV2(planningInput, NOW).map(({ chains }) => chains)).toEqual([
      ["rema-1000"],
    ]);

    const withTravel = attachOptionalTravelEvidenceV2(
      completeCandidates,
      completeCandidates.map((plan) => ({
        planId: plan.id,
        travel: {
          calculatedAt: NOW.toISOString(),
          contractVersion: 1,
          distanceMeters: plan.chains[0] === "extra" ? 1_000 : 5_000,
          durationSeconds: plan.chains[0] === "extra" ? 100 : 500,
          kind: "calculated" as const,
          providerSourceId: "route-provider",
          routeFingerprint: `route:${plan.id}`,
        },
      })),
    );
    const travelFrontier = paretoFrontierV2(withTravel);

    expect(travelFrontier.map(({ chains }) => chains)).toEqual([
      ["extra"],
      ["rema-1000"],
    ]);
    expect(travelFrontier.every(({ travel }) => travel !== undefined)).toBe(true);
  });
});
