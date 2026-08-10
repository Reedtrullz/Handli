import { describe, expect, it } from "vitest";

import {
  discoveryImpactRequestV1Schema,
  discoveryImpactResponseV1Schema,
  discoveryImpactResponseV1SchemaFor,
  type DiscoveryImpactRequestV1,
} from "./index";

const GTIN_MILK = "7038010000010";
const GTIN_COFFEE = "7038010000027";
const GTIN_BREAD = "7038010000034";

function exactNeed(id: string, value: string) {
  return {
    id,
    match: {
      kind: "exact-product" as const,
      product: { kind: "gtin" as const, value },
      userApproved: true as const,
    },
    quantity: 1,
    quantityUnit: "each" as const,
    required: true as const,
  };
}

function reviewedNeed(id = "need:milk") {
  return {
    id,
    match: {
      confirmation: {
        candidateSetId: `candidate-set:${"a".repeat(64)}`,
        taxonomyVersionId: "handleplan-reviewed-families@1.0.0",
        userApproved: true as const,
      },
      familyId: "family:melk",
      kind: "reviewed-family" as const,
    },
    quantity: 1,
    quantityUnit: "each" as const,
    required: true as const,
  };
}

const request: DiscoveryImpactRequestV1 = {
  actions: [
    {
      actionId: "action:add-bread",
      kind: "add",
      product: { kind: "gtin", value: GTIN_BREAD },
      userApproved: true,
    },
    {
      actionId: "action:replace-coffee",
      kind: "replace",
      needId: "need:coffee",
      product: { kind: "gtin", value: GTIN_BREAD },
      userApproved: true,
    },
    {
      actionId: "action:lock-milk",
      kind: "lock",
      needId: "need:milk",
      product: { kind: "gtin", value: GTIN_MILK },
      userApproved: true,
    },
  ],
  contractVersion: 1,
  convenienceWeightBasisPoints: 5_000,
  planning: {
    contractVersion: 2,
    enabledMembershipProgramIds: [],
    marketContext: { contractVersion: 1, countryCode: "NO", kind: "national" },
    maxStores: 3,
    needs: [
      reviewedNeed(),
      exactNeed("need:coffee", GTIN_COFFEE),
    ],
  },
};

function summary(overrides: Record<string, unknown> = {}) {
  return {
    appliedOfficialOfferIds: [],
    chains: ["extra"],
    comparisonCoverage: "complete",
    requiredMembershipProgramIds: [],
    storeCount: 1,
    substitutionCount: 1,
    totalOre: 10_000,
    ...overrides,
  };
}

const response = {
  baseline: { kind: "complete", plan: summary() },
  contractVersion: 1,
  evaluatedAt: "2026-07-17T12:00:00.000Z",
  evaluatedProductCount: 3,
  marketContext: request.planning.marketContext,
  outcomes: [
    {
      action: request.actions[0],
      actionId: "action:add-bread",
      actionKind: "add",
      comparison: {
        basis: "different-basket",
        chainsAdded: ["bunnpris"],
        chainsRemoved: [],
        checkoutTotalDeltaOre: 2_000,
        claimScope: "declared-complete-coverage",
        kind: "comparable",
        storeCountDelta: 1,
        substitutionCountDelta: 0,
      },
      plan: summary({
        chains: ["bunnpris", "extra"],
        storeCount: 2,
        totalOre: 12_000,
      }),
      state: "complete",
    },
    {
      action: request.actions[1],
      actionId: "action:replace-coffee",
      actionKind: "replace",
      comparison: {
        basis: "same-need",
        chainsAdded: [],
        chainsRemoved: [],
        checkoutTotalDeltaOre: -1_000,
        claimScope: "among-verified-prices",
        kind: "comparable",
        storeCountDelta: 0,
        substitutionCountDelta: -1,
      },
      plan: summary({
        comparisonCoverage: "partial",
        substitutionCount: 0,
        totalOre: 9_000,
      }),
      state: "complete",
    },
    {
      action: request.actions[2],
      actionId: "action:lock-milk",
      actionKind: "lock",
      reason: "no-complete-plan",
      state: "incomplete",
    },
  ],
  travelImpact: {
    kind: "omitted",
    reason: "origin-not-retained",
  },
} as const;

function ean13(index: number): string {
  const body = `703801${String(index).padStart(6, "0")}`;
  const weighted = [...body].reduce(
    (sum, digit, digitIndex) => sum + Number(digit) * (digitIndex % 2 === 0 ? 1 : 3),
    0,
  );
  return `${body}${(10 - (weighted % 10)) % 10}`;
}

describe("V1 discovery impact request contract", () => {
  it("accepts a strict, approved, bounded add/replace/lock batch", () => {
    expect(discoveryImpactRequestV1Schema.safeParse(request).success).toBe(true);
    expect(discoveryImpactRequestV1Schema.safeParse({
      ...request,
      origin: "Storgata 1",
    }).success).toBe(false);
    expect(discoveryImpactRequestV1Schema.safeParse({
      ...request,
      actions: request.actions.map((action) => ({ ...action, userApproved: false })),
    }).success).toBe(false);
  });

  it("enforces eight actions, unique identities, valid targets, and lock semantics", () => {
    const add = request.actions[0]!;
    expect(discoveryImpactRequestV1Schema.safeParse({
      ...request,
      actions: Array.from({ length: 9 }, (_, index) => ({
        ...add,
        actionId: `action:${index}`,
        product: { kind: "gtin", value: ean13(index + 100) },
      })),
    }).success).toBe(false);
    expect(discoveryImpactRequestV1Schema.safeParse({
      ...request,
      actions: [add, { ...add, actionId: "action:duplicate" }],
    }).success).toBe(false);
    expect(discoveryImpactRequestV1Schema.safeParse({
      ...request,
      actions: [{ ...request.actions[1]!, needId: "need:missing" }],
    }).success).toBe(false);
    expect(discoveryImpactRequestV1Schema.safeParse({
      ...request,
      actions: [{ ...request.actions[2]!, needId: "need:coffee" }],
    }).success).toBe(false);
  });

  it("enforces the visible exact/action GTIN union and per-variant need ceiling", () => {
    const exactNeeds = Array.from({ length: 43 }, (_, index) =>
      exactNeed(`need:${index}`, ean13(index + 1)));
    const actions = Array.from({ length: 8 }, (_, index) => ({
      actionId: `action:${index}`,
      kind: "replace" as const,
      needId: "need:0",
      product: { kind: "gtin" as const, value: ean13(index + 100) },
      userApproved: true as const,
    }));
    expect(discoveryImpactRequestV1Schema.safeParse({
      actions,
      contractVersion: 1,
      convenienceWeightBasisPoints: 5_000,
      planning: { contractVersion: 1, maxStores: 3, needs: exactNeeds },
    }).success).toBe(false);

    const fullBasket = Array.from({ length: 50 }, (_, index) =>
      exactNeed(`need:${index}`, GTIN_MILK));
    expect(discoveryImpactRequestV1Schema.safeParse({
      ...request,
      actions: [request.actions[0]],
      planning: { contractVersion: 1, maxStores: 3, needs: fullBasket },
    }).success).toBe(false);
  });
});

describe("V1 discovery impact response contract", () => {
  it("binds outcomes to the request and accepts only coherent arithmetic", () => {
    expect(discoveryImpactResponseV1Schema.safeParse(response).success).toBe(true);
    expect(discoveryImpactResponseV1SchemaFor(request).safeParse(response).success).toBe(true);
    expect(discoveryImpactResponseV1SchemaFor(request).safeParse({
      ...response,
      outcomes: [...response.outcomes].reverse(),
    }).success).toBe(false);
    const sameKindDifferentNeedRequest: DiscoveryImpactRequestV1 = {
      ...request,
      actions: request.actions.map((action, index) => index === 1
        ? { ...action, needId: "need:milk" }
        : action),
    };
    expect(discoveryImpactRequestV1Schema.safeParse(
      sameKindDifferentNeedRequest,
    ).success).toBe(true);
    expect(discoveryImpactResponseV1SchemaFor(
      sameKindDifferentNeedRequest,
    ).safeParse(response).success).toBe(false);
    expect(discoveryImpactResponseV1Schema.safeParse({
      ...response,
      outcomes: response.outcomes.map((outcome, index) => index === 0
        ? {
            ...outcome,
            comparison: {
              ...response.outcomes[0].comparison,
              checkoutTotalDeltaOre: 2_001,
            },
          }
        : outcome),
    }).success).toBe(false);
  });

  it("counts every resolved product used by a successful action variant", () => {
    const addOnlyRequest = {
      ...request,
      actions: [request.actions[0]!],
    };
    const addOnlyResponse = {
      ...response,
      evaluatedProductCount: 2,
      outcomes: [response.outcomes[0]!],
    };
    expect(discoveryImpactResponseV1SchemaFor(addOnlyRequest)
      .safeParse(addOnlyResponse).success).toBe(true);
    expect(discoveryImpactResponseV1SchemaFor(addOnlyRequest).safeParse({
      ...addOnlyResponse,
      evaluatedProductCount: 1,
    }).success).toBe(false);
  });

  it("cross-checks stores, chain set differences, substitution deltas, and claim scope", () => {
    const first = response.outcomes[0];
    expect(discoveryImpactResponseV1Schema.safeParse({
      ...response,
      outcomes: [{
        ...first,
        plan: { ...first.plan, storeCount: 3 },
      }, ...response.outcomes.slice(1)],
    }).success).toBe(false);
    expect(discoveryImpactResponseV1Schema.safeParse({
      ...response,
      outcomes: [{
        ...first,
        comparison: { ...first.comparison, chainsAdded: [] },
      }, ...response.outcomes.slice(1)],
    }).success).toBe(false);
    expect(discoveryImpactResponseV1Schema.safeParse({
      ...response,
      outcomes: [{
        ...first,
        comparison: { ...first.comparison, substitutionCountDelta: 1 },
      }, ...response.outcomes.slice(1)],
    }).success).toBe(false);
    expect(discoveryImpactResponseV1Schema.safeParse({
      ...response,
      outcomes: [{
        ...first,
        comparison: { ...first.comparison, claimScope: "among-verified-prices" },
      }, ...response.outcomes.slice(1)],
    }).success).toBe(false);
  });

  it("makes incomplete and ineligible results structurally non-numeric", () => {
    expect(discoveryImpactResponseV1Schema.safeParse({
      ...response,
      outcomes: response.outcomes.map((outcome, index) => index === 2
        ? { ...outcome, checkoutTotalDeltaOre: -1_000 }
        : outcome),
    }).success).toBe(false);
    expect(discoveryImpactResponseV1Schema.safeParse({
      ...response,
      outcomes: response.outcomes.map((outcome, index) => index === 2
        ? {
            actionId: outcome.actionId,
            actionKind: outcome.actionKind,
            reason: "not-reviewed-family-candidate",
            state: "ineligible",
            storeCountDelta: 0,
          }
        : outcome),
    }).success).toBe(false);
  });

  it("requires non-comparability when the baseline is incomplete", () => {
    const baselineIncomplete = {
      ...response,
      baseline: { kind: "incomplete" as const, reason: "no-complete-plan" as const },
      outcomes: [{
        ...response.outcomes[0],
        comparison: { kind: "unavailable" as const, reason: "baseline-incomplete" as const },
      }],
    };
    expect(discoveryImpactResponseV1Schema.safeParse(baselineIncomplete).success).toBe(true);
    expect(discoveryImpactResponseV1Schema.safeParse({
      ...baselineIncomplete,
      outcomes: [response.outcomes[0]],
    }).success).toBe(false);
  });

  it("caps evaluated products and stores and makes travel omission exact", () => {
    expect(discoveryImpactResponseV1Schema.safeParse({
      ...response,
      evaluatedProductCount: 51,
    }).success).toBe(false);
    expect(discoveryImpactResponseV1Schema.safeParse({
      ...response,
      evaluatedProductCount: 0,
    }).success).toBe(false);
    expect(discoveryImpactResponseV1Schema.safeParse({
      ...response,
      baseline: {
        kind: "complete",
        plan: summary({ chains: ["bunnpris", "extra", "rema-1000", "fourth"], storeCount: 4 }),
      },
    }).success).toBe(false);
    expect(discoveryImpactResponseV1Schema.safeParse({
      ...response,
      travelImpact: {
        kind: "omitted",
        reason: "origin-not-retained",
        origin: "Storgata 1",
      },
    }).success).toBe(false);
    expect(discoveryImpactResponseV1SchemaFor({
      ...request,
      planning: { ...request.planning, maxStores: 1 },
    }).safeParse(response).success).toBe(false);
  });
});
