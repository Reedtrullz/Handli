import { describe, expect, it } from "vitest";

import {
  createTripSnapshot,
  createTripSnapshotV2,
  tripSnapshotSchema,
  tripSnapshotV1Schema,
  tripSnapshotV2Schema,
  type CreateTripSnapshotInput,
  type CreateTripSnapshotV2Input,
} from "./trip-snapshot";
import { planResultV2Schema } from "./planner-v2-contracts";

const products = [
  {
    brand: "TINE",
    catalogEvidence: {
      observedAt: "2026-07-16T10:00:00.000Z",
      source: {
        contractVersion: 1 as const,
        displayName: "Fixture source",
        id: "fixture-source",
        sourceClass: "ordinary-price" as const,
        state: "approved" as const,
      },
      sourceRecordId: `source-record:${"a".repeat(64)}`,
    },
    displayName: "TINE Lettmelk 1 l",
    gtin: "7038010000010",
    packageMeasure: { amount: 1_000, unit: "ml" as const },
    unitsPerPack: 1,
  },
  {
    catalogEvidence: {
      observedAt: "2026-07-16T10:00:00.000Z",
      source: {
        contractVersion: 1 as const,
        displayName: "Fixture source",
        id: "fixture-source",
        sourceClass: "ordinary-price" as const,
        state: "approved" as const,
      },
      sourceRecordId: `source-record:${"b".repeat(64)}`,
    },
    displayName: "Norsk grovbrød",
    gtin: "7038010000034",
    packageMeasure: { amount: 1, unit: "piece" as const },
    unitsPerPack: 1,
  },
];

const plan = planResultV2Schema.parse({
  assignments: [
    {
      canonicalProductId: "product:milk",
      chain: "extra" as const,
      checkout: { ordinaryTotalOre: 2_490, savingOre: 0, totalOre: 2_490 },
      costOre: 2_490,
      ean: products[0]!.gtin,
      fulfilment: {
        canonicalProductId: "product:milk",
        complete: true as const,
        contractVersion: 2 as const,
        needId: "need:milk",
        packageCount: 1,
        packageMeasure: { amount: 1_000, unit: "ml" as const },
        purchased: { amount: 1, unit: "package" as const },
        requested: { amount: 1, unit: "package" as const },
        surplus: { amount: 0, unit: "package" as const },
      },
      needId: "need:milk",
      observedAt: "2026-07-16T10:00:00.000Z",
      source: "source-neutral-fixture",
    },
    {
      canonicalProductId: "product:bread",
      chain: "bunnpris" as const,
      checkout: { ordinaryTotalOre: 3_500, savingOre: 0, totalOre: 3_500 },
      costOre: 3_500,
      ean: products[1]!.gtin,
      fulfilment: {
        canonicalProductId: "product:bread",
        complete: true as const,
        contractVersion: 2 as const,
        needId: "need:bread",
        packageCount: 1,
        packageMeasure: { amount: 1, unit: "piece" as const },
        purchased: { amount: 1, unit: "piece" as const },
        requested: { amount: 1, unit: "piece" as const },
        surplus: { amount: 0, unit: "piece" as const },
      },
      needId: "need:bread",
      observedAt: "2026-07-16T10:00:00.000Z",
      source: "another-source",
    },
  ],
  chains: ["bunnpris", "extra"],
  coverage: 1 as const,
  freshness: { "need:bread": "eligible" as const, "need:milk": "eligible" as const },
  id: "plan-v2:trip-fixture",
  substitutions: [],
  totalOre: 5_990,
});

function input(overrides: Partial<CreateTripSnapshotInput> = {}): CreateTripSnapshotInput {
  return {
    caveats: ["Pris dokumenterer ikke lagerstatus."],
    createdAt: "2026-07-16T12:00:00.000Z",
    evaluatedAt: "2026-07-16T11:00:00.000Z",
    expiresAt: "2026-07-16T18:00:00.000Z",
    id: "trip:fixture",
    navigation: { kind: "price-only" },
    plan,
    products,
    ...overrides,
  };
}

describe("TripSnapshotV1", () => {
  it("creates an immutable source-neutral price-only snapshot with stable checklist IDs", () => {
    const first = createTripSnapshot(input());
    const second = createTripSnapshot(input({ id: "trip:another" }));

    expect(first).toMatchObject({
      contractVersion: 1,
      kind: "trip-snapshot",
      navigation: {
        kind: "price-only",
        stops: [
          { chainId: "bunnpris", kind: "chain-stop", name: "Bunnpris" },
          { chainId: "extra", kind: "chain-stop", name: "Extra" },
        ],
      },
      plan: { assignments: [{ source: "source-neutral-fixture" }, { source: "another-source" }] },
    });
    expect(first.checklistItems.map(({ id }) => id)).toEqual(
      second.checklistItems.map(({ id }) => id),
    );
    expect(new Set(first.checklistItems.map(({ id }) => id)).size).toBe(2);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.plan.assignments)).toBe(true);
    expect(Object.isFrozen(first.products)).toBe(true);
  });

  it("stores only a route aggregate and ordered public branch identities", () => {
    const snapshot = createTripSnapshot(input({
      navigation: {
        aggregate: {
          calculatedAt: "2026-07-16T11:00:00.000Z",
          distanceMeters: 4_200,
          durationSeconds: 900,
          mode: "bike",
          sourceId: "route-source",
          sourceRecordId: "route-record:fixture",
        },
        kind: "route",
        stops: [
          { branchId: "branch:1", chainId: "bunnpris", kind: "branch-stop", name: "Bunnpris Sentrum", sequence: 1 },
          { branchId: "branch:2", chainId: "extra", kind: "branch-stop", name: "Extra Torget", sequence: 2 },
        ],
      },
    }));

    expect(snapshot.navigation).toMatchObject({
      aggregate: { distanceMeters: 4_200, durationSeconds: 900, mode: "bike" },
      kind: "route",
    });
    expect(JSON.stringify(snapshot.navigation)).not.toMatch(/origin|latitude|longitude|address/i);
  });

  it("rejects origin, address, and coordinate injection at every route boundary", () => {
    const valid = createTripSnapshot(input({
      navigation: {
        aggregate: {
          calculatedAt: "2026-07-16T11:00:00.000Z",
          distanceMeters: 4_200,
          durationSeconds: 900,
          mode: "car",
          sourceId: "route-source",
          sourceRecordId: "route-record:fixture",
        },
        kind: "route",
        stops: [
          { branchId: "branch:1", chainId: "bunnpris", kind: "branch-stop", name: "Bunnpris Sentrum", sequence: 1 },
          { branchId: "branch:2", chainId: "extra", kind: "branch-stop", name: "Extra Torget", sequence: 2 },
        ],
      },
    }));

    expect(tripSnapshotV1Schema.safeParse({
      ...valid,
      navigation: { ...valid.navigation, origin: { latitude: 59.9, longitude: 10.7 } },
    }).success).toBe(false);
    if (valid.navigation.kind !== "route") throw new Error("route fixture expected");
    expect(tripSnapshotV1Schema.safeParse({
      ...valid,
      navigation: {
        ...valid.navigation,
        stops: valid.navigation.stops.map((stop, index) =>
          index === 0 ? { ...stop, address: "Privatveien 1", latitude: 59.9 } : stop),
      },
    }).success).toBe(false);
  });

  it("rejects duplicate checklist IDs, product gaps, invalid expiry, and incomplete stops", () => {
    const snapshot = createTripSnapshot(input());
    expect(tripSnapshotV1Schema.safeParse({
      ...snapshot,
      checklistItems: snapshot.checklistItems.map((item) => ({
        ...item,
        id: snapshot.checklistItems[0]!.id,
      })),
    }).success).toBe(false);
    expect(tripSnapshotV1Schema.safeParse({ ...snapshot, products: [snapshot.products[0]] })
      .success).toBe(false);
    expect(tripSnapshotV1Schema.safeParse({ ...snapshot, expiresAt: snapshot.evaluatedAt }).success)
      .toBe(false);
    expect(tripSnapshotV1Schema.safeParse({
      ...snapshot,
      navigation: { ...snapshot.navigation, stops: snapshot.navigation.stops.slice(0, 1) },
    }).success).toBe(false);
    expect(tripSnapshotV1Schema.safeParse({
      ...snapshot,
      createdAt: "2026-07-16T19:00:00.000Z",
    }).success).toBe(false);

    const routed = createTripSnapshot(input({
      navigation: {
        aggregate: {
          calculatedAt: "2026-07-16T11:00:00.000Z",
          distanceMeters: 4_200,
          durationSeconds: 900,
          mode: "car",
          sourceId: "route-source",
          sourceRecordId: "route-record:fixture",
        },
        kind: "route",
        stops: [
          { branchId: "branch:1", chainId: "bunnpris", kind: "branch-stop", name: "Bunnpris Sentrum", sequence: 1 },
          { branchId: "branch:2", chainId: "extra", kind: "branch-stop", name: "Extra Torget", sequence: 2 },
        ],
      },
    }));
    if (routed.navigation.kind !== "route") throw new Error("route fixture expected");
    expect(tripSnapshotV1Schema.safeParse({
      ...routed,
      navigation: {
        ...routed.navigation,
        aggregate: {
          ...routed.navigation.aggregate,
          calculatedAt: "2026-07-16T11:00:01.000Z",
        },
      },
    }).success).toBe(false);
  });

  it("keeps legacy routed snapshots without a transport mode readable", () => {
    const snapshot = createTripSnapshot(input({
      navigation: {
        aggregate: {
          calculatedAt: "2026-07-16T11:00:00.000Z",
          distanceMeters: 4_200,
          durationSeconds: 900,
          sourceId: "route-source",
          sourceRecordId: "route-record:legacy",
        },
        kind: "route",
        stops: [
          { branchId: "branch:1", chainId: "bunnpris", kind: "branch-stop", name: "Bunnpris Sentrum", sequence: 1 },
          { branchId: "branch:2", chainId: "extra", kind: "branch-stop", name: "Extra Torget", sequence: 2 },
        ],
      },
    }));

    expect(snapshot.navigation).toMatchObject({ kind: "route" });
    if (snapshot.navigation.kind !== "route") throw new Error("route fixture expected");
    expect(snapshot.navigation.aggregate.mode).toBeUndefined();
    expect(tripSnapshotV1Schema.safeParse(snapshot).success).toBe(true);
  });
});

const ordinaryPrice = {
  amountOre: 2_490,
  chainId: "extra",
  contractVersion: 1 as const,
  evidenceLevel: "observed" as const,
  geographicScope: { countryCode: "NO", kind: "national" as const },
  id: "price:extra:milk:trip-v2",
  kind: "price-evidence" as const,
  observedAt: "2026-07-16T10:00:00.000Z",
  priceKind: "ordinary" as const,
  productMatch: { canonicalProductId: "product:milk", kind: "exact" as const },
  sourceId: "source-neutral-fixture",
  sourceRecordId: "source-record:price:extra:milk:trip-v2",
};

const appliedOffer = {
  applicability: {
    channels: ["in-store" as const],
    contractVersion: 1 as const,
    endsAt: "2026-07-17T18:00:00.000Z",
    geographicScope: { countryCode: "NO", kind: "national" as const },
    startsAt: "2026-07-15T00:00:00.000Z",
  },
  beforePriceOre: 2_490,
  capturedAt: "2026-07-16T10:00:00.000Z",
  chainId: "extra",
  conditions: [{ kind: "public" as const }, { kind: "minimum-quantity" as const, quantity: 1 }],
  contractVersion: 1 as const,
  evidenceLevel: "observed" as const,
  id: "offer:extra:milk:trip-v2",
  kind: "official-offer" as const,
  pricing: { kind: "unit" as const, unitPriceOre: 1_990 },
  productMatch: { canonicalProductId: "product:milk", kind: "exact" as const },
  sourceId: "offer-source",
  sourceRecordId: "source-record:offer:extra:milk:trip-v2",
};

const offerPlan = planResultV2Schema.parse({
  assignments: [{
    canonicalProductId: "product:milk",
    chain: "extra",
    checkout: {
      appliedOfferId: appliedOffer.id,
      ordinaryTotalOre: 2_490,
      savingOre: 500,
      totalOre: 1_990,
    },
    costOre: 1_990,
    ean: products[0]!.gtin,
    fulfilment: {
      canonicalProductId: "product:milk",
      complete: true,
      contractVersion: 2,
      needId: "need:milk",
      packageCount: 1,
      packageMeasure: { amount: 1_000, unit: "ml" },
      purchased: { amount: 1, unit: "package" },
      requested: { amount: 1, unit: "package" },
      surplus: { amount: 0, unit: "package" },
    },
    needId: "need:milk",
    observedAt: ordinaryPrice.observedAt,
    officialOffer: {
      capturedAt: appliedOffer.capturedAt,
      id: appliedOffer.id,
      sourceId: appliedOffer.sourceId,
      sourceRecordId: appliedOffer.sourceRecordId,
    },
    source: ordinaryPrice.sourceId,
  }],
  chains: ["extra"],
  coverage: 1,
  freshness: { "need:milk": "eligible" },
  id: "plan-v2:offer-trip-fixture",
  substitutions: [],
  totalOre: 1_990,
});

function inputV2(
  overrides: Partial<CreateTripSnapshotV2Input> = {},
): CreateTripSnapshotV2Input {
  return {
    caveats: ["Pris dokumenterer ikke lagerstatus."],
    createdAt: "2026-07-16T12:00:00.000Z",
    evaluatedAt: "2026-07-16T11:00:00.000Z",
    expiresAt: "2026-07-16T18:00:00.000Z",
    id: "trip:v2-fixture",
    marketContext: { contractVersion: 1, countryCode: "NO", kind: "national" },
    navigation: { kind: "price-only" },
    plan: offerPlan,
    products: [products[0]!],
    purchaseEvidence: [{
      appliedOffer,
      needId: "need:milk",
      ordinaryPrice,
    }],
    ...overrides,
    enabledMembershipProgramIds: overrides.enabledMembershipProgramIds ?? [],
  };
}

function reviewedInputV2(): CreateTripSnapshotV2Input {
  const reviewedPlan = planResultV2Schema.parse({
    ...offerPlan,
    substitutions: ["need:milk"],
  });
  const taxonomy = {
    contentSha256: "1d917ee4268615ad510a622ea30d69977191cffc143313a7dbecbad37debf520",
    contractVersion: 1 as const,
    publishedAt: "2026-07-16T09:00:00.000Z",
    taxonomyId: "handleplan-reviewed-families" as const,
    taxonomyVersion: "1.0.0",
    versionId: "handleplan-reviewed-families@1.0.0",
  };
  const candidateSetId = `candidate-set:${"d".repeat(64)}`;
  return inputV2({
    plan: reviewedPlan,
    reviewedFamilyEvidence: {
      assignmentEvidence: [{
        chainId: "extra",
        conditions: { kind: "official-offer", offerId: appliedOffer.id },
        evidenceId: ordinaryPrice.id,
        needId: "need:milk",
        planId: reviewedPlan.id,
      }],
      memberships: [{
        canonicalProductId: "product:milk",
        confidence: 100,
        decision: "approved",
        decisionId: "family-membership:12",
        familyId: "family:melk",
        method: "human-review",
        reviewedAt: "2026-07-16T10:00:00.000Z",
        reviewerAttested: true,
      }],
      needMatches: [{
        candidateProductIds: ["product:milk"],
        candidateSetId,
        family: {
          aliases: ["mjølk"],
          id: "family:melk",
          labelNo: "Melk",
          slug: "melk",
          status: "active",
        },
        familyId: "family:melk",
        kind: "reviewed-family",
        needId: "need:milk",
        taxonomyVersionId: taxonomy.versionId,
      }],
      officialOffers: [appliedOffer],
      ordinaryPrices: [ordinaryPrice],
      productClaims: [{ canonicalProductId: "product:milk", product: products[0]! }],
      request: {
        contractVersion: 2,
        enabledMembershipProgramIds: [],
        marketContext: { contractVersion: 1, countryCode: "NO", kind: "national" },
        maxStores: 1,
        needs: [{
          id: "need:milk",
          match: {
            confirmation: {
              candidateSetId,
              taxonomyVersionId: taxonomy.versionId,
              userApproved: true,
            },
            familyId: "family:melk",
            kind: "reviewed-family",
          },
          quantity: 1,
          quantityUnit: "each",
          required: true,
        }],
      },
      taxonomy,
    },
  });
}

describe("TripSnapshotV2", () => {
  it("freezes exact purchase terms and full public offer evidence beside the immutable plan", () => {
    const snapshot = createTripSnapshotV2(inputV2());

    expect(snapshot).toMatchObject({
      contractVersion: 2,
      checklistItems: [{
        purchase: {
          appliedOffer: {
            applicability: { channels: ["in-store"] },
            conditions: [{ kind: "public" }, { kind: "minimum-quantity", quantity: 1 }],
            id: appliedOffer.id,
          },
          checkoutTotalOre: 1_990,
          freshness: "eligible",
          observedAt: ordinaryPrice.observedAt,
          ordinaryPrice: { id: ordinaryPrice.id },
          ordinaryTotalOre: 2_490,
          packageCount: 1,
          purchased: { amount: 1, unit: "package" },
          requested: { amount: 1, unit: "package" },
          savedOre: 500,
          surplus: { amount: 0, unit: "package" },
        },
      }],
    });
    expect(Object.isFrozen(snapshot.checklistItems[0]!.purchase.appliedOffer)).toBe(true);
    expect(tripSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(tripSnapshotSchema.safeParse(createTripSnapshot(input())).success).toBe(true);
  });

  it("binds regional trips to matching regional or national evidence, never another region or store", () => {
    const osloMarket = {
      contractVersion: 1 as const,
      countryCode: "NO" as const,
      kind: "launch-region" as const,
      regionId: "no-0301-oslo",
    };
    const osloScope = {
      countryCode: "NO" as const,
      kind: "regions" as const,
      regionCodes: [osloMarket.regionId],
    };
    const regionalOrdinary = { ...ordinaryPrice, geographicScope: osloScope };
    const regionalOffer = {
      ...appliedOffer,
      applicability: { ...appliedOffer.applicability, geographicScope: osloScope },
    };
    const regional = createTripSnapshotV2(inputV2({
      marketContext: osloMarket,
      purchaseEvidence: [{
        appliedOffer: regionalOffer,
        needId: "need:milk",
        ordinaryPrice: regionalOrdinary,
      }],
    }));
    expect(tripSnapshotV2Schema.safeParse(regional).success).toBe(true);
    expect(createTripSnapshotV2(inputV2({ marketContext: osloMarket })).marketContext)
      .toEqual(osloMarket);

    const item = regional.checklistItems[0]!;
    for (const geographicScope of [
      {
        countryCode: "NO",
        kind: "regions",
        regionCodes: ["no-4601-bergen"],
      },
      { kind: "stores", storeIds: ["store:extra:oslo-1"] },
    ]) {
      expect(tripSnapshotV2Schema.safeParse({
        ...regional,
        checklistItems: [{
          ...item,
          purchase: {
            ...item.purchase,
            ordinaryPrice: { ...item.purchase.ordinaryPrice, geographicScope },
          },
        }],
      }).success).toBe(false);
    }
  });

  it("rejects tampered quantities, totals, evidence identity, offer terms, and expiry", () => {
    const snapshot = createTripSnapshotV2(inputV2());
    const item = snapshot.checklistItems[0]!;
    const mutations = [
      { ...item.purchase, packageCount: 2 },
      { ...item.purchase, checkoutTotalOre: 1_991 },
      {
        ...item.purchase,
        ordinaryPrice: { ...item.purchase.ordinaryPrice, sourceId: "other-source" },
      },
      {
        ...item.purchase,
        appliedOffer: {
          ...item.purchase.appliedOffer!,
          conditions: [{ kind: "member", programId: "members-only" }],
        },
      },
    ];

    for (const purchase of mutations) {
      expect(tripSnapshotV2Schema.safeParse({
        ...snapshot,
        checklistItems: [{ ...item, purchase }],
      }).success).toBe(false);
    }
    expect(tripSnapshotV2Schema.safeParse({
      ...snapshot,
      expiresAt: "2026-07-19T10:00:00.000Z",
    }).success).toBe(false);
  });

  it("requires a transport mode on every newly created routed V2 snapshot", () => {
    const routed = createTripSnapshotV2(inputV2({
      navigation: {
        aggregate: {
          calculatedAt: "2026-07-16T11:00:00.000Z",
          distanceMeters: 4_200,
          durationSeconds: 900,
          mode: "car",
          sourceId: "route-source",
          sourceRecordId: "route-record:v2-fixture",
        },
        kind: "route",
        stops: [{
          branchId: "branch:extra:v2-fixture",
          chainId: "extra",
          kind: "branch-stop",
          name: "Extra Sentrum",
          sequence: 1,
        }],
      },
    }));
    if (routed.navigation.kind !== "route") throw new Error("route fixture expected");
    const { mode: _mode, ...aggregateWithoutMode } = routed.navigation.aggregate;

    expect(tripSnapshotV2Schema.safeParse({
      ...routed,
      navigation: { ...routed.navigation, aggregate: aggregateWithoutMode },
    }).success).toBe(false);
  });

  it("binds the public reviewed-family confirmation and selected evidence without private fields", () => {
    const snapshot = createTripSnapshotV2(reviewedInputV2());
    expect(snapshot.reviewedFamilyEvidence).toMatchObject({
      memberships: [{ canonicalProductId: "product:milk", reviewerAttested: true }],
      request: { contractVersion: 2, maxStores: 1 },
      taxonomy: { versionId: "handleplan-reviewed-families@1.0.0" },
    });
    expect(JSON.stringify(snapshot)).not.toMatch(
      /reviewerId|reviewerName|privateCapture|capturePayload|query|address|origin|latitude|longitude/i,
    );

    const reviewed = snapshot.reviewedFamilyEvidence!;
    const familyMatch = reviewed.needMatches[0]!;
    if (familyMatch.kind !== "reviewed-family") throw new Error("family match expected");
    expect(tripSnapshotV2Schema.safeParse({
      ...snapshot,
      reviewedFamilyEvidence: {
        ...reviewed,
        needMatches: [{
          ...familyMatch,
          candidateSetId: `candidate-set:${"e".repeat(64)}`,
        }],
      },
    }).success).toBe(false);
    expect(tripSnapshotV2Schema.safeParse({
      ...snapshot,
      reviewedFamilyEvidence: {
        ...reviewed,
        reviewerIdentity: "must-not-be-stored",
      },
    }).success).toBe(false);
    expect(tripSnapshotV2Schema.safeParse({
      ...snapshot,
      reviewedFamilyEvidence: undefined,
    }).success).toBe(false);

    expect(() => createTripSnapshotV2({
      ...reviewedInputV2(),
      marketContext: {
        contractVersion: 1,
        countryCode: "NO",
        kind: "launch-region",
        regionId: "no-0301-oslo",
      },
    })).toThrow();
  });
});
