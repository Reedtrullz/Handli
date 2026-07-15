import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";

import type {
  MatchRule,
  MoneyOre,
  Need,
  PlanRequest,
  PlanResult,
  PriceObservation,
  Product,
} from "./contracts";
import { calculatePlans } from "./index";

const NOW = new Date("2026-07-15T12:00:00.000Z");
const CHAINS = ["bunnpris", "extra", "rema-1000"] as const;
type Chain = (typeof CHAINS)[number];
type FreshnessCase = "fresh" | "boundary-72h" | "stale" | "historical" | "future";

interface NeedSpec {
  mode: MatchRule["mode"];
  required: boolean;
  quantity: number;
  missing: boolean;
  duplicate: boolean;
  freshness: [FreshnessCase, FreshnessCase, FreshnessCase];
}

interface Scenario {
  seed: number;
  maxStores: 1 | 2 | 3;
  constructivelyComplete: boolean;
  equalAcrossChains: boolean;
  needs: NeedSpec[];
}

const freshnessCase = fc.constantFrom<FreshnessCase>(
  "fresh",
  "boundary-72h",
  "stale",
  "historical",
  "future",
);
const needSpec = fc.record({
  mode: fc.constantFrom<MatchRule["mode"]>("exact", "constrained", "flexible"),
  required: fc.boolean(),
  quantity: fc.integer({ min: 1, max: 4 }),
  missing: fc.boolean(),
  duplicate: fc.boolean(),
  freshness: fc.tuple(freshnessCase, freshnessCase, freshnessCase),
});
const scenario = fc.record({
  seed: fc.integer({ min: 0, max: 10_000 }),
  maxStores: fc.constantFrom<1 | 2 | 3>(1, 2, 3),
  constructivelyComplete: fc.boolean(),
  equalAcrossChains: fc.boolean(),
  needs: fc.array(needSpec, { minLength: 1, maxLength: 3 }),
});

function ean(prefix: "1" | "2", index: number): string {
  return `70380${prefix}0${String(index).padStart(6, "0")}`;
}

function timestamp(kind: FreshnessCase): string {
  const offsets: Record<FreshnessCase, number> = {
    fresh: -60 * 60 * 1_000,
    "boundary-72h": -72 * 60 * 60 * 1_000,
    stale: -73 * 60 * 60 * 1_000,
    historical: -15 * 24 * 60 * 60 * 1_000,
    future: 1,
  };
  return new Date(NOW.getTime() + offsets[kind]).toISOString();
}

function makeRule(spec: NeedSpec, index: number): MatchRule {
  const common = {
    id: `rule-${index}`,
    userApproved: true,
    explanation: "Godkjent av brukeren.",
  } as const;

  if (spec.mode === "exact") {
    return { ...common, mode: "exact", exactEan: ean("1", index) };
  }
  if (spec.mode === "constrained") {
    return {
      ...common,
      mode: "constrained",
      productFamily: `family-${index}`,
      allowedBrands: [`brand-${index}`],
      sizeRange: { min: 900, max: 1_100, unit: "ml" },
    };
  }
  return { ...common, mode: "flexible", productFamily: `family-${index}` };
}

function buildRequest(input: Scenario): PlanRequest {
  const needs: Need[] = input.needs.map((spec, index) => ({
    id: `need-${index}`,
    query: `vare ${index}`,
    quantity: spec.quantity,
    quantityUnit: "each",
    matchRuleId: `rule-${index}`,
    required: spec.required,
  }));
  const matchingRules = input.needs.map(makeRule);
  const products: Product[] = input.needs.flatMap((spec, index) => {
    const common = {
      brand: `brand-${index}`,
      packageQuantity: 1_000,
      packageUnit: "ml" as const,
      productFamily: `family-${index}`,
    };
    const primary = { ean: ean("1", index), name: `Vare ${index} A`, ...common };
    return spec.mode === "exact"
      ? [primary]
      : [primary, { ean: ean("2", index), name: `Vare ${index} B`, ...common }];
  });
  const prices: PriceObservation[] = [];

  for (const [needIndex, spec] of input.needs.entries()) {
    const productEans = spec.mode === "exact"
      ? [ean("1", needIndex)]
      : [ean("1", needIndex), ean("2", needIndex)];

    if (!spec.missing) {
      for (const [productIndex, productEan] of productEans.entries()) {
        for (const [chainIndex, chain] of CHAINS.entries()) {
          const base = input.equalAcrossChains
            ? 1_000 + needIndex * 100
            : 100 + ((input.seed * 17 + needIndex * 31 + productIndex * 13 + chainIndex * 47) % 5_000);
          const row: PriceObservation = {
            ean: productEan,
            chain,
            amountOre: base as MoneyOre,
            observedAt: timestamp(spec.freshness[chainIndex]!),
            source: "kassalapp",
          };
          prices.push(row);
          if (spec.duplicate) {
            prices.push({ ...row });
          }
        }
      }
    }

    if (input.constructivelyComplete && spec.required) {
      prices.push({
        ean: ean("1", needIndex),
        chain: "extra",
        amountOre: (800 + needIndex * 100) as MoneyOre,
        observedAt: timestamp("fresh"),
        source: "kassalapp",
      });
    }
  }

  return { needs, matchingRules, products, prices, maxStores: input.maxStores };
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function oracleMatches(product: Product, rule: MatchRule): boolean {
  if (rule.mode === "exact") return product.ean === rule.exactEan;
  if (product.productFamily === undefined || normalize(product.productFamily) !== normalize(rule.productFamily!)) {
    return false;
  }
  if (rule.mode === "flexible") return true;
  if (rule.allowedBrands !== undefined &&
      (product.brand === undefined || !rule.allowedBrands.some((brand) => normalize(brand) === normalize(product.brand!)))) {
    return false;
  }
  return rule.sizeRange === undefined ||
    (product.packageQuantity !== undefined &&
      product.packageUnit === rule.sizeRange.unit &&
      product.packageQuantity >= rule.sizeRange.min &&
      product.packageQuantity <= rule.sizeRange.max);
}

function isEligible(observedAt: string): boolean {
  const elapsed = NOW.getTime() - new Date(observedAt).getTime();
  return elapsed >= 0 && elapsed <= 72 * 60 * 60 * 1_000;
}

function subsets(maximum: number): Chain[][] {
  const result: Chain[][] = [];
  for (let mask = 1; mask < 1 << CHAINS.length; mask += 1) {
    const subset = CHAINS.filter((_, index) => (mask & (1 << index)) !== 0);
    if (subset.length <= maximum) result.push([...subset]);
  }
  return result;
}

function assignmentIdentity(assignments: PlanResult["assignments"]): string {
  return JSON.stringify(assignments.map(({ needId, ean: productEan, chain, quantity, costOre }) =>
    [needId, productEan, chain, quantity, costOre]));
}

type OraclePlan = Omit<PlanResult, "id" | "freshness">;

function oraclePlans(request: PlanRequest): OraclePlan[] {
  const requiredNeeds = request.needs.filter(({ required }) => required).sort((a, b) => a.id < b.id ? -1 : 1);
  if (requiredNeeds.length === 0) return [];
  const rules = new Map(request.matchingRules.map((rule) => [rule.id, rule]));
  const generated: OraclePlan[] = [];

  for (const subset of subsets(request.maxStores)) {
    const assignments: PlanResult["assignments"] = [];
    const substitutions: string[] = [];
    let complete = true;

    for (const need of requiredNeeds) {
      const rule = rules.get(need.matchRuleId);
      if (rule === undefined) { complete = false; break; }
      const matchingEans = new Set(request.products.filter((product) => oracleMatches(product, rule)).map(({ ean }) => ean));
      const candidates = request.prices
        .filter((row) => subset.includes(row.chain) && matchingEans.has(row.ean) && isEligible(row.observedAt))
        .map((row) => ({
          needId: need.id,
          ean: row.ean,
          chain: row.chain,
          quantity: need.quantity,
          costOre: (row.amountOre * need.quantity) as MoneyOre,
          observedAt: row.observedAt,
        }))
        .sort((left, right) =>
          left.costOre - right.costOre ||
          (left.ean < right.ean ? -1 : left.ean > right.ean ? 1 : 0) ||
          CHAINS.indexOf(left.chain) - CHAINS.indexOf(right.chain) ||
          (left.observedAt > right.observedAt ? -1 : left.observedAt < right.observedAt ? 1 : 0));
      const selected = candidates[0];
      if (selected === undefined) { complete = false; break; }
      const { observedAt: _observedAt, ...assignment } = selected;
      assignments.push(assignment);
      if (rule.mode !== "exact") substitutions.push(need.id);
    }

    if (!complete) continue;
    assignments.sort((a, b) => a.needId < b.needId ? -1 : 1);
    substitutions.sort();
    const chains = CHAINS.filter((chain) => assignments.some((assignment) => assignment.chain === chain));
    generated.push({
      assignments,
      totalOre: assignments.reduce((sum, assignment) => sum + assignment.costOre, 0) as MoneyOre,
      chains,
      substitutions,
      coverage: 1,
    });
  }

  const unique = new Map<string, OraclePlan>();
  for (const plan of generated) unique.set(assignmentIdentity(plan.assignments), plan);
  const candidates = [...unique.values()];
  return candidates
    .filter((candidate) => !candidates.some((other) =>
      other !== candidate &&
      other.totalOre <= candidate.totalOre &&
      other.chains.length <= candidate.chains.length &&
      other.substitutions.length <= candidate.substitutions.length &&
      (other.totalOre < candidate.totalOre ||
        other.chains.length < candidate.chains.length ||
        other.substitutions.length < candidate.substitutions.length)))
    .sort((left, right) =>
      left.chains.length - right.chains.length ||
      left.substitutions.length - right.substitutions.length ||
      left.totalOre - right.totalOre ||
      (assignmentIdentity(left.assignments) < assignmentIdentity(right.assignments) ? -1 : 1));
}

function comparable(plan: PlanResult): OraclePlan {
  const { id: _id, freshness: _freshness, ...rest } = plan;
  return rest;
}

describe("planner properties", () => {
  test.prop([scenario], { numRuns: 200 })(
    "matches an independent complete-frontier oracle across modes, freshness, gaps, duplicates, quantities, and permutations",
    (input) => {
      const request = buildRequest(input as Scenario);
      const plans = calculatePlans(request, NOW);
      const reversed = calculatePlans({
        ...request,
        needs: [...request.needs].reverse(),
        matchingRules: [...request.matchingRules].reverse(),
        products: [...request.products].reverse(),
        prices: [...request.prices].reverse(),
      }, NOW);
      const expected = oraclePlans(request);
      const requiredCount = request.needs.filter(({ required }) => required).length;

      expect(plans.map(comparable)).toEqual(expected);
      expect(reversed).toEqual(plans);
      expect(new Set(plans.map(({ id }) => id)).size).toBe(plans.length);
      if (input.constructivelyComplete && requiredCount > 0) {
        expect(plans.length).toBeGreaterThan(0);
      }
      for (const plan of plans) {
        expect(plan.assignments).toHaveLength(requiredCount);
        expect(plan.coverage).toBe(1);
        expect(plan.chains.length).toBeLessThanOrEqual(request.maxStores);
        expect(plan.chains.length).toBeLessThanOrEqual(3);
        expect(Number.isSafeInteger(plan.totalOre)).toBe(true);
        expect(plan.totalOre).toBeGreaterThanOrEqual(0);
      }
    },
  );
});
