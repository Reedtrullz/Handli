import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";

import {
  calculateDiscoveryImpactBatchV1,
  enumerateCompletePlanCandidatesV2,
  paretoFrontierV2,
  projectRepresentativesV2,
  serverPlanningInputV2Schema,
  type DiscoveryImpactActionV1,
  type MoneyOre,
  type ServerPlanningInputV2,
} from "./index";

const NOW = new Date("2026-07-17T12:00:00.000Z");
const EANS = {
  milk: "7038010000010",
  coffee: "7038010000027",
  bread: "7038010000034",
  alternateMilk: "7038010000041",
} as const;

function planningInput(): ServerPlanningInputV2 {
  const products = [
    { canonicalProductId: "product:milk", ean: EANS.milk, name: "Melk", packageMeasure: { amount: 1_000, unit: "ml" as const }, productFamily: "family:milk" },
    { canonicalProductId: "product:milk-alt", ean: EANS.alternateMilk, name: "Melk alternativ", packageMeasure: { amount: 1_000, unit: "ml" as const }, productFamily: "family:milk" },
    { canonicalProductId: "product:coffee", ean: EANS.coffee, name: "Kaffe", packageMeasure: { amount: 500, unit: "g" as const } },
    { canonicalProductId: "product:bread", ean: EANS.bread, name: "Brød", packageMeasure: { amount: 1, unit: "piece" as const } },
  ];
  return {
    contractVersion: 2,
    maxStores: 3,
    matchingRules: [
      { explanation: "Gjennomgått familie.", id: "rule:milk", mode: "flexible", productFamily: "family:milk", userApproved: true },
      { exactEan: EANS.coffee, explanation: "Eksakt vare.", id: "rule:coffee", mode: "exact", userApproved: true },
    ],
    needs: [
      { id: "need:milk", matchRuleId: "rule:milk", query: "Melk", requested: { amount: 1, unit: "package" }, required: true },
      { id: "need:coffee", matchRuleId: "rule:coffee", query: "Kaffe", requested: { amount: 1, unit: "package" }, required: true },
    ],
    offerEligibility: {
      channel: "in-store",
      enabledMembershipProgramIds: [],
      enabledSourceIds: ["source:licensed"],
      location: { countryCode: "NO" },
      maxEvidenceAgeMs: 1_209_600_000,
    },
    officialOffers: [],
    ordinaryPrices: products.flatMap((product, productIndex) =>
      (["bunnpris", "extra", "rema-1000"] as const).map((chain, chainIndex) => ({
        amountOre: (1_000 + productIndex * 500 + chainIndex * 125) as MoneyOre,
        chain,
        ean: product.ean,
        observedAt: "2026-07-17T11:00:00.000Z",
        source: "source:licensed",
      }))),
    products,
  };
}

type ActionKind = "add" | "replace" | "lock";

const baselineCandidateSets = [
  {
    candidateGtins: [EANS.milk, EANS.alternateMilk],
    needId: "need:milk",
  },
  {
    candidateGtins: [EANS.coffee],
    needId: "need:coffee",
  },
] as const;

function action(kind: ActionKind, index: number): DiscoveryImpactActionV1 {
  const common = {
    actionId: `action:${index}`,
    product: {
      kind: "gtin" as const,
      value: kind === "lock" ? EANS.alternateMilk : EANS.bread,
    },
    userApproved: true as const,
  };
  if (kind === "add") return { ...common, kind };
  return {
    ...common,
    kind,
    needId: kind === "lock" ? "need:milk" : "need:coffee",
  };
}

function direct(planning: ServerPlanningInputV2) {
  return projectRepresentativesV2(
    paretoFrontierV2(enumerateCompletePlanCandidatesV2(planning, NOW)),
    7,
  );
}

function independentlyConstructedVariant(
  planning: ServerPlanningInputV2,
  kind: ActionKind,
  index: number,
): ServerPlanningInputV2 {
  const mutation = action(kind, index);
  const product = planning.products.find(({ ean }) =>
    ean === mutation.product.value)!;
  const ruleId = `impact:${index + 1}:${kind}:rule`;
  const explanation = kind === "add"
    ? "Eksakt vare lagt til etter uttrykkelig godkjenning."
    : kind === "replace"
      ? "Eksakt vare erstattet etter uttrykkelig godkjenning."
      : "Eksakt vare låst etter uttrykkelig godkjenning.";
  const exactRule = {
    exactEan: mutation.product.value,
    explanation,
    id: ruleId,
    mode: "exact" as const,
    userApproved: true,
  };

  if (kind === "add") {
    return serverPlanningInputV2Schema.parse({
      ...planning,
      matchingRules: [...planning.matchingRules, exactRule],
      needs: [
        ...planning.needs,
        {
          id: `impact:${index + 1}:add:need`,
          matchRuleId: ruleId,
          query: product.name,
          requested: { amount: 1, unit: "package" },
          required: true,
        },
      ],
    });
  }

  const targetId = kind === "lock" ? "need:milk" : "need:coffee";
  const target = planning.needs.find(({ id }) => id === targetId)!;
  const needs = planning.needs.map((need) => need.id === targetId
    ? { ...need, matchRuleId: ruleId }
    : need);
  const stillReferencedRuleIds = new Set(needs.map(({ matchRuleId }) => matchRuleId));
  return serverPlanningInputV2Schema.parse({
    ...planning,
    matchingRules: [
      ...planning.matchingRules.filter(({ id }) =>
        id !== target.matchRuleId || stillReferencedRuleIds.has(id)),
      exactRule,
    ],
    needs,
  });
}

describe("compiled discovery impact planner properties", () => {
  test.prop([
    fc.uniqueArray(fc.constantFrom<ActionKind>("add", "replace", "lock"), {
      minLength: 1,
      maxLength: 3,
    }),
    fc.integer({ min: 0, max: 10_000 }),
    fc.constantFrom<1 | 2 | 3>(1, 2, 3),
    fc.integer({ min: 1, max: 4 }),
    fc.boolean(),
  ], { numRuns: 100 })(
    "is equivalent to direct planning and mutates one semantic need per variant",
    (
      kinds,
      convenienceWeightBasisPoints,
      maxStores,
      coffeeQuantity,
      includeBreadPrice,
    ) => {
      const planning = planningInput();
      planning.maxStores = maxStores;
      planning.needs = planning.needs.map((need) => need.id === "need:coffee"
        ? { ...need, requested: { amount: coffeeQuantity, unit: "package" } }
        : need);
      if (!includeBreadPrice) {
        planning.ordinaryPrices = planning.ordinaryPrices.filter(({ ean }) =>
          ean !== EANS.bread);
      }
      const original = structuredClone(planning);
      const result = calculateDiscoveryImpactBatchV1({
        actions: kinds.map(action),
        baselineCandidateSets,
        convenienceWeightBasisPoints,
        evaluatedAt: NOW,
        planning,
      });

      expect(result).toBeDefined();
      expect(planning).toEqual(original);
      expect(result?.baseline.plans).toEqual(direct(planning));
      expect(result?.outcomes).toHaveLength(kinds.length);

      for (const [index, outcome] of (result?.outcomes ?? []).entries()) {
        expect(outcome.state).toBe("compiled");
        if (outcome.state !== "compiled") continue;
        const expectedPlanning = independentlyConstructedVariant(
          planning,
          kinds[index]!,
          index,
        );
        expect(outcome.planning).toEqual(expectedPlanning);
        expect(outcome.plans).toEqual(direct(expectedPlanning));
        expect(outcome.plans.every(({ chains }) => chains.length <= maxStores)).toBe(true);

        const expectedIndex = outcome.plans.length <= 1
          ? 0
          : Math.floor(
              ((10_000 - convenienceWeightBasisPoints) / 10_000)
              * (outcome.plans.length - 1),
            );
        expect(outcome.selectedPlan).toEqual(outcome.plans[expectedIndex]);

        const kind = kinds[index]!;
        if (kind === "add") {
          expect(outcome.planning.needs).toHaveLength(planning.needs.length + 1);
          expect(outcome.planning.needs.slice(0, planning.needs.length)).toEqual(planning.needs);
        } else {
          expect(outcome.planning.needs).toHaveLength(planning.needs.length);
          const target = kind === "lock" ? "need:milk" : "need:coffee";
          expect(outcome.planning.needs.filter(({ id }) => id !== target))
            .toEqual(planning.needs.filter(({ id }) => id !== target));
          expect(outcome.planning.needs.find(({ id }) => id === target)?.requested)
            .toEqual(planning.needs.find(({ id }) => id === target)?.requested);
        }
      }
    },
  );
});
