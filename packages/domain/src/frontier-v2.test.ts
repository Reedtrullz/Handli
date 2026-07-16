import { describe, expect, it } from "vitest";

import {
  attachOptionalTravelEvidenceV2,
  paretoFrontierV2,
  projectRepresentativesV2,
  type FrontierPlanV2,
  type MoneyOre,
  type PlanResultV2,
  type PlanTravelEvidence,
  type TravelResult,
} from "./index";

const CHAINS = ["extra", "rema-1000", "bunnpris"] as const;
const money = (value: number) => value as MoneyOre;

function plan(
  id: string,
  totalOre: number,
  storeCount: 1 | 2 | 3,
  substitutionCount = 0,
  withOffer = false,
): PlanResultV2 {
  const chains = CHAINS.slice(0, storeCount);
  const assignmentCount = Math.max(storeCount, substitutionCount, 1);
  const baseCost = Math.floor(totalOre / assignmentCount);
  const remainder = totalOre - baseCost * assignmentCount;
  const assignments = Array.from({ length: assignmentCount }, (_, index) => {
    const costOre = baseCost + (index === 0 ? remainder : 0);
    const ordinaryTotalOre = costOre + (withOffer ? 1_000 : 0);
    return {
      needId: `need:${id}:${index}`,
      canonicalProductId: `product:${id}:${index}`,
      ean: "7038010000010",
      chain: chains[index % chains.length]!,
      costOre: money(costOre),
      observedAt: "2026-07-16T11:00:00.000Z",
      source: "fixture-price-source",
      fulfilment: {
        contractVersion: 2 as const,
        needId: `need:${id}:${index}`,
        canonicalProductId: `product:${id}:${index}`,
        requested: { amount: 2, unit: "package" as const },
        packageMeasure: { amount: 6, unit: "piece" as const },
        packageCount: 2,
        purchased: { amount: 2, unit: "package" as const },
        surplus: { amount: 0, unit: "package" as const },
        complete: true as const,
      },
      checkout: {
        ordinaryTotalOre: money(ordinaryTotalOre),
        savingOre: money(withOffer ? 1_000 : 0),
        totalOre: money(costOre),
        ...(withOffer ? { appliedOfferId: `offer:${id}:${index}` } : {}),
      },
      ...(withOffer
        ? {
          officialOffer: {
            id: `offer:${id}:${index}`,
            sourceId: "fixture-offer-source",
            sourceRecordId: `campaign:${id}:${index}`,
            capturedAt: "2026-07-16T10:00:00.000Z",
          },
        }
        : {}),
    };
  });

  return {
    id,
    assignments,
    totalOre: money(totalOre),
    chains: [...chains],
    substitutions: assignments.slice(0, substitutionCount).map(({ needId }) => needId),
    coverage: 1,
    freshness: Object.fromEntries(assignments.map(({ needId }) => [needId, "eligible"])),
  };
}

function calculatedTravel(
  id: string,
  durationSeconds: number,
): Extract<TravelResult, { kind: "calculated" }> {
  return {
    contractVersion: 1,
    kind: "calculated",
    durationSeconds,
    distanceMeters: durationSeconds * 10,
    providerSourceId: "route-provider",
    calculatedAt: "2026-07-16T12:00:00.000Z",
    routeFingerprint: `route:${id}`,
  };
}

function travel(planId: string, durationSeconds: number): PlanTravelEvidence {
  return { planId, travel: calculatedTravel(planId, durationSeconds) };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

describe("v2 frontier", () => {
  it("validates complete v2 candidates, removes dominated plans, and rejects malformed metadata", () => {
    const convenience = plan("convenience", 10_000, 1, 0, true);
    const dominated = plan("dominated", 12_000, 2, 1, true);
    const savings = plan("savings", 8_000, 2, 0, true);
    const missingFulfilment = {
      ...plan("missing", 7_000, 1),
      assignments: plan("missing", 7_000, 1).assignments.map(
        ({ fulfilment: _fulfilment, ...assignment }) => assignment,
      ),
    } as unknown as FrontierPlanV2;
    const inconsistentCheckout = {
      ...plan("inconsistent", 6_000, 1, 0, true),
      assignments: plan("inconsistent", 6_000, 1, 0, true).assignments.map(
        (assignment) => ({
          ...assignment,
          checkout: { ...assignment.checkout, totalOre: money(1) },
        }),
      ),
    } as FrontierPlanV2;
    const transformableMetadata = {
      ...plan("transformable", 5_000, 1),
      assignments: plan("transformable", 5_000, 1).assignments.map(
        (assignment) => ({ ...assignment, source: ` ${assignment.source}` }),
      ),
    } as FrontierPlanV2;

    expect(paretoFrontierV2([
      dominated,
      missingFulfilment,
      savings,
      inconsistentCheckout,
      transformableMetadata,
      convenience,
    ]).map(({ id }) => id)).toEqual(["convenience", "savings"]);
  });

  it("preserves fulfilment, checkout, and offer provenance without mutation", () => {
    const original = deepFreeze(plan("offer-plan", 10_000, 1, 0, true));
    const assignmentBefore = JSON.stringify(original.assignments[0]);

    const [result] = paretoFrontierV2([original]);

    expect(JSON.stringify(result?.assignments[0])).toBe(assignmentBefore);
    expect(JSON.stringify(original.assignments[0])).toBe(assignmentBefore);
    expect(result).not.toBe(original);
    expect(result?.assignments[0]).not.toBe(original.assignments[0]);
  });

  it("orders equal-objective plans identically for every input permutation", () => {
    const first = plan("equal-a", 10_000, 1, 0, true);
    const second = plan("equal-b", 10_000, 1, 0, true);

    const forward = paretoFrontierV2([second, first]);
    const reverse = paretoFrontierV2([first, second]);

    expect(forward.map(({ id }) => id)).toEqual(["equal-a", "equal-b"]);
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reverse));
  });

  it("attaches travel atomically and preserves separate price-only/travel cohorts", () => {
    const slowCheap = plan("slow-cheap", 10_000, 1, 0, true);
    const fastExpensive = plan("fast-expensive", 12_000, 1, 0, true);
    const attached = attachOptionalTravelEvidenceV2(
      [slowCheap, fastExpensive],
      [travel("fast-expensive", 100), travel("slow-cheap", 500)],
    );

    expect(paretoFrontierV2(attached).map(({ id }) => id)).toEqual([
      "fast-expensive",
      "slow-cheap",
    ]);
    expect(new Set(paretoFrontierV2([
      slowCheap,
      attached.find(({ id }) => id === "fast-expensive")!,
    ]).map(({ id }) => id))).toEqual(new Set(["slow-cheap", "fast-expensive"]));

    const partial = attachOptionalTravelEvidenceV2(
      [slowCheap, fastExpensive],
      [travel("slow-cheap", 500)],
    );
    expect(partial.every((candidate) => candidate.travel === undefined)).toBe(true);
    expect(paretoFrontierV2(partial).map(({ id }) => id)).toEqual(["slow-cheap"]);
  });

  it("fails travel attachment closed for unavailable, invalid, duplicate, or unknown evidence", () => {
    const plans = [plan("cheap", 10_000, 1), plan("expensive", 12_000, 1)];
    const failures: PlanTravelEvidence[][] = [
      [
        travel("cheap", 500),
        {
          planId: "expensive",
          travel: { contractVersion: 1, kind: "unavailable", reason: "timeout" },
        },
      ],
      [travel("cheap", 500), travel("cheap", 100)],
      [travel("cheap", 500), travel("unknown", 100)],
      [
        travel("cheap", 500),
        {
          planId: "expensive",
          travel: { ...calculatedTravel("expensive", 100), durationSeconds: -1 } as TravelResult,
        },
      ],
      [
        travel("cheap", 500),
        {
          planId: "expensive",
          travel: {
            ...calculatedTravel("expensive", 100),
            providerSourceId: " route-provider",
          },
        },
      ],
    ];

    for (const evidence of failures) {
      expect(
        attachOptionalTravelEvidenceV2(plans, evidence)
          .every((candidate) => candidate.travel === undefined),
      ).toBe(true);
    }
  });

  it("projects no more than seven real representatives and preserves both endpoints", () => {
    const candidates = Array.from({ length: 12 }, (_, index) =>
      plan(
        `plan-${String(index).padStart(2, "0")}`,
        20_000 - index * 500,
        index < 4 ? 1 : index < 8 ? 2 : 3,
        index,
        true,
      ),
    );
    const frontier = paretoFrontierV2(candidates);
    const projected = projectRepresentativesV2([...frontier].reverse(), 7);

    expect(projected).toHaveLength(7);
    expect(projected[0]?.id).toBe(frontier[0]?.id);
    expect(projected.at(-1)?.id).toBe(frontier.at(-1)?.id);
    expect(new Set(projected.map(({ id }) => id)).size).toBe(7);
    expect(new Set(projected.map(({ chains }) => chains.length))).toEqual(new Set([1, 2, 3]));
    expect(projectRepresentativesV2(frontier, 7)).toEqual(projected);
  });

  it("validates representative bounds and resolves maximum one deterministically", () => {
    const candidates = [plan("convenience", 12_000, 1), plan("savings", 10_000, 2)];

    expect(projectRepresentativesV2(candidates, 0)).toEqual([]);
    expect(projectRepresentativesV2(candidates, 1.5)).toEqual([]);
    expect(projectRepresentativesV2(candidates, 8)).toEqual([]);
    expect(projectRepresentativesV2(candidates, 1).map(({ id }) => id)).toEqual([
      "convenience",
    ]);
  });
});
