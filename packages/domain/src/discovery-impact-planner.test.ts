import { describe, expect, it } from "vitest";

import {
  calculateDiscoveryImpactBatchV1,
  enumerateCompletePlanCandidatesV2,
  paretoFrontierV2,
  projectRepresentativesV2,
  type DiscoveryImpactActionV1,
  type MoneyOre,
  type ServerPlanningInputV2,
} from "./index";

const NOW = new Date("2026-07-17T12:00:00.000Z");
const GTIN_MILK_A = "7038010000010";
const GTIN_COFFEE = "7038010000027";
const GTIN_BREAD = "7038010000034";
const GTIN_MILK_B = "7038010000041";
const ore = (amount: number) => amount as MoneyOre;

function ean13(index: number): string {
  const body = `703801${String(index).padStart(6, "0")}`;
  const weighted = [...body].reduce(
    (sum, digit, digitIndex) => sum + Number(digit) * (digitIndex % 2 === 0 ? 1 : 3),
    0,
  );
  return `${body}${(10 - (weighted % 10)) % 10}`;
}

function input(): ServerPlanningInputV2 {
  return {
    contractVersion: 2,
    maxStores: 3,
    matchingRules: [
      {
        explanation: "Gjennomgått melkefamilie.",
        id: "rule:milk",
        mode: "flexible",
        productFamily: "family:melk",
        userApproved: true,
      },
      {
        exactEan: GTIN_COFFEE,
        explanation: "Eksakt kaffe.",
        id: "rule:coffee",
        mode: "exact",
        userApproved: true,
      },
    ],
    needs: [
      {
        id: "need:milk",
        matchRuleId: "rule:milk",
        query: "Melk",
        requested: { amount: 1, unit: "package" },
        required: true,
      },
      {
        id: "need:coffee",
        matchRuleId: "rule:coffee",
        query: "Kaffe",
        requested: { amount: 2, unit: "package" },
        required: true,
      },
    ],
    offerEligibility: {
      channel: "in-store",
      enabledMembershipProgramIds: [],
      enabledSourceIds: ["licensed-price-feed"],
      location: { countryCode: "NO" },
      maxEvidenceAgeMs: 14 * 24 * 60 * 60 * 1_000,
    },
    officialOffers: [],
    ordinaryPrices: [
      { amountOre: ore(2_000), chain: "extra", ean: GTIN_MILK_A, observedAt: "2026-07-17T11:00:00.000Z", source: "licensed-price-feed" },
      { amountOre: ore(1_800), chain: "rema-1000", ean: GTIN_MILK_B, observedAt: "2026-07-17T11:00:00.000Z", source: "licensed-price-feed" },
      { amountOre: ore(5_000), chain: "extra", ean: GTIN_COFFEE, observedAt: "2026-07-17T11:00:00.000Z", source: "licensed-price-feed" },
      { amountOre: ore(4_500), chain: "bunnpris", ean: GTIN_COFFEE, observedAt: "2026-07-17T11:00:00.000Z", source: "licensed-price-feed" },
      { amountOre: ore(3_000), chain: "bunnpris", ean: GTIN_BREAD, observedAt: "2026-07-17T11:00:00.000Z", source: "licensed-price-feed" },
      { amountOre: ore(2_500), chain: "extra", ean: GTIN_BREAD, observedAt: "2026-07-17T11:00:00.000Z", source: "licensed-price-feed" },
    ],
    products: [
      {
        canonicalProductId: "product:milk-a",
        ean: GTIN_MILK_A,
        name: "Melk A",
        packageMeasure: { amount: 1_000, unit: "ml" },
        productFamily: "family:melk",
      },
      {
        canonicalProductId: "product:milk-b",
        ean: GTIN_MILK_B,
        name: "Melk B",
        packageMeasure: { amount: 1_000, unit: "ml" },
        productFamily: "family:melk",
      },
      {
        canonicalProductId: "product:coffee",
        ean: GTIN_COFFEE,
        name: "Kaffe",
        packageMeasure: { amount: 500, unit: "g" },
      },
      {
        canonicalProductId: "product:bread",
        ean: GTIN_BREAD,
        name: "Brød",
        packageMeasure: { amount: 1, unit: "piece" },
      },
    ],
  };
}

function candidateSets() {
  return [
    {
      candidateGtins: [GTIN_MILK_A, GTIN_MILK_B],
      needId: "need:milk",
    },
    {
      candidateGtins: [GTIN_COFFEE],
      needId: "need:coffee",
    },
  ];
}

const actions: DiscoveryImpactActionV1[] = [
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
    product: { kind: "gtin", value: GTIN_MILK_B },
    userApproved: true,
  },
];

function directPlans(planning: ServerPlanningInputV2) {
  return projectRepresentativesV2(
    paretoFrontierV2(enumerateCompletePlanCandidatesV2(planning, NOW)),
    7,
  );
}

describe("compiled V1 discovery impact planner", () => {
  it("evaluates baseline and every eligible single mutation with existing planner primitives", () => {
    const baseline = input();
    const snapshot = structuredClone(baseline);
    const result = calculateDiscoveryImpactBatchV1({
      actions,
      baselineCandidateSets: candidateSets(),
      convenienceWeightBasisPoints: 5_000,
      evaluatedAt: NOW,
      planning: baseline,
    });

    expect(result).toBeDefined();
    expect(baseline).toEqual(snapshot);
    expect(result?.baseline.plans).toEqual(directPlans(baseline));
    expect(result?.outcomes).toHaveLength(3);

    for (const outcome of result?.outcomes ?? []) {
      expect(outcome.state).toBe("compiled");
      if (outcome.state !== "compiled") continue;
      expect(outcome.plans).toEqual(directPlans(outcome.planning));
      expect(outcome.plans.every(({ chains }) => chains.length <= 3)).toBe(true);
      expect(outcome.selectedPlan).toEqual(
        outcome.plans[Math.floor((outcome.plans.length - 1) / 2)],
      );
    }
  });

  it("adds one exact package need without changing any baseline need", () => {
    const baseline = input();
    const result = calculateDiscoveryImpactBatchV1({
      actions: [actions[0]!],
      baselineCandidateSets: candidateSets(),
      convenienceWeightBasisPoints: 10_000,
      evaluatedAt: NOW,
      planning: baseline,
    });
    const outcome = result?.outcomes[0];
    expect(outcome?.state).toBe("compiled");
    if (outcome?.state !== "compiled") return;

    expect(outcome.planning.needs.slice(0, baseline.needs.length)).toEqual(baseline.needs);
    expect(outcome.planning.needs).toHaveLength(baseline.needs.length + 1);
    expect(outcome.planning.needs.at(-1)).toMatchObject({
      query: "Brød",
      requested: { amount: 1, unit: "package" },
      required: true,
    });
    expect(outcome.planning.matchingRules.at(-1)).toMatchObject({
      exactEan: GTIN_BREAD,
      mode: "exact",
      userApproved: true,
    });
    expect(outcome.planning.products).toEqual(baseline.products);
    expect(outcome.planning.ordinaryPrices).toEqual(baseline.ordinaryPrices);
  });

  it("replaces or locks exactly one target while preserving its quantity", () => {
    const baseline = input();
    const result = calculateDiscoveryImpactBatchV1({
      actions: [actions[1]!, actions[2]!],
      baselineCandidateSets: candidateSets(),
      convenienceWeightBasisPoints: 0,
      evaluatedAt: NOW,
      planning: baseline,
    });
    expect(result).toBeDefined();

    for (const outcome of result?.outcomes ?? []) {
      expect(outcome.state).toBe("compiled");
      if (outcome.state !== "compiled") continue;
      expect(outcome.planning.needs).toHaveLength(baseline.needs.length);
      const targetId = outcome.actionKind === "replace" ? "need:coffee" : "need:milk";
      const original = baseline.needs.find(({ id }) => id === targetId)!;
      const mutated = outcome.planning.needs.find(({ id }) => id === targetId)!;
      expect(mutated.requested).toEqual(original.requested);
      expect(mutated.id).toBe(original.id);
      expect(mutated.matchRuleId).not.toBe(original.matchRuleId);
      expect(outcome.planning.needs.filter(({ id }) => id !== targetId))
        .toEqual(baseline.needs.filter(({ id }) => id !== targetId));
      expect(outcome.planning.matchingRules.find(({ id }) => id === mutated.matchRuleId))
        .toMatchObject({ mode: "exact", userApproved: true });
    }
  });

  it("preserves a shared flexible rule for every non-target need", () => {
    const baseline = input();
    baseline.needs = [
      baseline.needs[0]!,
      {
        ...baseline.needs[0]!,
        id: "need:milk:second",
      },
      baseline.needs[1]!,
    ];
    const result = calculateDiscoveryImpactBatchV1({
      actions: [actions[2]!],
      baselineCandidateSets: [
        ...candidateSets(),
        {
          candidateGtins: [GTIN_MILK_A, GTIN_MILK_B],
          needId: "need:milk:second",
        },
      ],
      convenienceWeightBasisPoints: 5_000,
      evaluatedAt: NOW,
      planning: baseline,
    });
    const outcome = result?.outcomes[0];
    expect(outcome?.state).toBe("compiled");
    if (outcome?.state !== "compiled") return;

    expect(outcome.planning.needs.find(({ id }) => id === "need:milk")?.matchRuleId)
      .not.toBe("rule:milk");
    expect(outcome.planning.needs.find(({ id }) => id === "need:milk:second")?.matchRuleId)
      .toBe("rule:milk");
    expect(outcome.planning.matchingRules.find(({ id }) => id === "rule:milk"))
      .toMatchObject({ mode: "flexible", productFamily: "family:melk" });
  });

  it("fails actions closed without suppressing other compiled variants", () => {
    const result = calculateDiscoveryImpactBatchV1({
      actions: [
        { ...actions[0]!, product: { kind: "gtin", value: "7038010000058" } },
        {
          actionId: "action:missing-need",
          kind: "replace",
          needId: "need:missing",
          product: { kind: "gtin", value: GTIN_BREAD },
          userApproved: true,
        },
        {
          actionId: "action:wrong-family",
          kind: "lock",
          needId: "need:milk",
          product: { kind: "gtin", value: GTIN_BREAD },
          userApproved: true,
        },
        actions[1]!,
      ],
      baselineCandidateSets: candidateSets(),
      convenienceWeightBasisPoints: 5_000,
      evaluatedAt: NOW,
      planning: input(),
    });

    expect(result?.outcomes.map((outcome) => outcome.state === "ineligible"
      ? outcome.reason
      : outcome.state)).toEqual([
      "unknown-product",
      "unknown-need",
      "not-reviewed-family-candidate",
      "compiled",
    ]);
  });

  it("keeps lock eligibility inside the explicitly reviewed candidate set", () => {
    const baseline = input();
    baseline.matchingRules = baseline.matchingRules.map((rule) =>
      rule.id === "rule:milk"
        ? {
            allowedBrands: ["Tine"],
            explanation: "Gjennomgått Tine-melk.",
            id: rule.id,
            mode: "constrained" as const,
            productFamily: "family:melk",
            userApproved: true,
          }
        : rule);
    baseline.products = baseline.products.map((product) =>
      product.ean === GTIN_MILK_A
        ? { ...product, brand: "Tine" }
        : product.ean === GTIN_MILK_B
          ? { ...product, brand: "Q" }
          : product);

    const result = calculateDiscoveryImpactBatchV1({
      actions: [actions[2]!],
      baselineCandidateSets: [
        { candidateGtins: [GTIN_MILK_A], needId: "need:milk" },
        { candidateGtins: [GTIN_COFFEE], needId: "need:coffee" },
      ],
      convenienceWeightBasisPoints: 5_000,
      evaluatedAt: NOW,
      planning: baseline,
    });

    expect(result?.outcomes).toEqual([{
      actionId: "action:lock-milk",
      actionKind: "lock",
      reason: "not-reviewed-family-candidate",
      state: "ineligible",
    }]);
  });

  it("rejects a candidate binding that omits a product matched by the baseline", () => {
    expect(calculateDiscoveryImpactBatchV1({
      actions: [actions[0]!],
      baselineCandidateSets: [
        { candidateGtins: [GTIN_MILK_A], needId: "need:milk" },
        { candidateGtins: [GTIN_COFFEE], needId: "need:coffee" },
      ],
      convenienceWeightBasisPoints: 5_000,
      evaluatedAt: NOW,
      planning: input(),
    })).toBeUndefined();
  });

  it("accepts eight distinct mutations and rejects semantic duplicates", () => {
    const eightActions: DiscoveryImpactActionV1[] = [
      actions[0]!,
      {
        actionId: "action:add-milk-a",
        kind: "add",
        product: { kind: "gtin", value: GTIN_MILK_A },
        userApproved: true,
      },
      {
        actionId: "action:add-milk-b",
        kind: "add",
        product: { kind: "gtin", value: GTIN_MILK_B },
        userApproved: true,
      },
      actions[1]!,
      {
        ...actions[1]!,
        actionId: "action:replace-coffee-milk",
        product: { kind: "gtin", value: GTIN_MILK_A },
      },
      {
        actionId: "action:replace-milk-bread",
        kind: "replace",
        needId: "need:milk",
        product: { kind: "gtin", value: GTIN_BREAD },
        userApproved: true,
      },
      {
        ...actions[2]!,
        actionId: "action:lock-milk-a",
        product: { kind: "gtin", value: GTIN_MILK_A },
      },
      actions[2]!,
    ];
    const result = calculateDiscoveryImpactBatchV1({
      actions: eightActions,
      baselineCandidateSets: candidateSets(),
      convenienceWeightBasisPoints: 5_000,
      evaluatedAt: NOW,
      planning: input(),
    });
    expect(result?.outcomes).toHaveLength(8);
    expect(result?.outcomes.every(({ state }) => state === "compiled")).toBe(true);

    expect(calculateDiscoveryImpactBatchV1({
      actions: [
        actions[1]!,
        { ...actions[1]!, actionId: "action:duplicate-semantic-mutation" },
      ],
      baselineCandidateSets: candidateSets(),
      convenienceWeightBasisPoints: 5_000,
      evaluatedAt: NOW,
      planning: input(),
    })).toBeUndefined();
  });

  it("rejects invalid clocks, more than eight actions, and product universes over fifty", () => {
    expect(calculateDiscoveryImpactBatchV1({
      actions,
      baselineCandidateSets: candidateSets(),
      convenienceWeightBasisPoints: 5_000,
      evaluatedAt: new Date(Number.NaN),
      planning: input(),
    })).toBeUndefined();
    expect(calculateDiscoveryImpactBatchV1({
      actions: Array.from({ length: 9 }, (_, index) => ({
        ...actions[1]!,
        actionId: `action:${index}`,
      })),
      baselineCandidateSets: candidateSets(),
      convenienceWeightBasisPoints: 5_000,
      evaluatedAt: NOW,
      planning: input(),
    })).toBeUndefined();
    expect(calculateDiscoveryImpactBatchV1({
      actions,
      baselineCandidateSets: candidateSets(),
      convenienceWeightBasisPoints: 5_000,
      evaluatedAt: NOW,
      planning: {
        ...input(),
        products: [
          ...input().products,
          ...Array.from({ length: 47 }, (_, index) => ({
            canonicalProductId: `product:extra:${index}`,
            ean: ean13(index + 100),
            name: `Vare ${index}`,
            packageMeasure: { amount: 1, unit: "package" as const },
          })),
        ],
      },
    })).toBeUndefined();
  });
});
