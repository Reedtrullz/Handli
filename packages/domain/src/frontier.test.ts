import { describe, expect, it } from "vitest";

import {
  attachOptionalTravelEvidence,
  explainPlanDeltas,
  paretoFrontier,
  planExplanationSchema,
  projectRepresentatives,
  type FrontierPlan,
  type MoneyOre,
  type PlanClaimEvidence,
  type PlanResult,
  type PlanTravelEvidence,
  type TravelResult,
} from "./index";

const CHAINS = ["extra", "rema-1000", "bunnpris"] as const;

function money(value: number): MoneyOre {
  return value as MoneyOre;
}

function plan(
  id: string,
  totalOre: number,
  storeCount: 1 | 2 | 3,
  substitutionCount = 0,
): PlanResult<string> {
  const chains = CHAINS.slice(0, storeCount);
  const assignmentCount = Math.max(storeCount, substitutionCount, 1);
  const baseCost = Math.floor(totalOre / assignmentCount);
  const remainder = totalOre - baseCost * assignmentCount;
  const assignments = Array.from({ length: assignmentCount }, (_, index) => ({
    needId: `need:${id}:${index}`,
    ean: "7038010000010",
    chain: chains[index % chains.length]!,
    quantity: 1,
    costOre: money(baseCost + (index === 0 ? remainder : 0)),
    observedAt: "2026-07-16T11:00:00.000Z",
    source: "fixture-source",
  }));

  return {
    id,
    assignments,
    totalOre: money(totalOre),
    chains: [...chains],
    substitutions: assignments
      .slice(0, substitutionCount)
      .map(({ needId }) => needId),
    coverage: 1,
    freshness: Object.fromEntries(
      assignments.map(({ needId }) => [needId, "eligible"]),
    ),
  };
}

function calculatedTravel(id: string, durationSeconds: number): TravelResult {
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
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

describe("frontier domain stages", () => {
  it("removes dominated plans and excludes invalid or incomplete candidates", () => {
    const convenience = plan("convenience", 10_000, 1);
    const dominated = plan("dominated", 12_000, 2, 1);
    const savings = plan("savings", 8_000, 2);
    const overThreeStores = {
      ...plan("over-three", 7_000, 3),
      chains: ["extra", "rema-1000", "bunnpris", "extra"],
    } as unknown as FrontierPlan<string>;
    const incomplete = {
      ...plan("incomplete", 6_000, 1),
      coverage: 0,
    } as unknown as FrontierPlan<string>;
    const inconsistentTotal = {
      ...plan("inconsistent", 5_000, 1),
      totalOre: money(4_999),
    };

    expect(
      paretoFrontier([
        savings,
        incomplete,
        dominated,
        overThreeStores,
        inconsistentTotal,
        convenience,
      ]).map(({ id }) => id),
    ).toEqual(["convenience", "savings"]);
  });

  it("retains equal-objective distinct plans and orders every input permutation byte-equivalently", () => {
    const first = plan("equal-a", 10_000, 1);
    const second = plan("equal-b", 10_000, 1);

    const forward = paretoFrontier([second, first]);
    const reversed = paretoFrontier([first, second]);

    expect(forward.map(({ id }) => id)).toEqual(["equal-a", "equal-b"]);
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
  });

  it("attaches valid calculated travel atomically by stable plan ID without mutation", () => {
    const plans = deepFreeze([
      plan("slow-cheap", 10_000, 1),
      plan("fast-expensive", 12_000, 1),
    ]);
    const evidence = deepFreeze([
      travel("fast-expensive", 100),
      travel("slow-cheap", 500),
    ]);
    const before = JSON.stringify({ plans, evidence });

    const forward = attachOptionalTravelEvidence(plans, evidence);
    const reversed = attachOptionalTravelEvidence(
      [...plans].reverse(),
      [...evidence].reverse(),
    );

    expect(forward.map(({ id, travel: result }) => [id, result?.durationSeconds])).toEqual([
      ["fast-expensive", 100],
      ["slow-cheap", 500],
    ]);
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
    expect(JSON.stringify({ plans, evidence })).toBe(before);
    expect(forward[0]).not.toBe(plans[1]);
  });

  it("allows a price-dominated candidate onto the travel-aware frontier", () => {
    const slowCheap = plan("slow-cheap", 10_000, 1);
    const fastExpensive = plan("fast-expensive", 12_000, 1);

    expect(paretoFrontier([fastExpensive, slowCheap]).map(({ id }) => id)).toEqual([
      "slow-cheap",
    ]);

    const attached = attachOptionalTravelEvidence(
      [slowCheap, fastExpensive],
      [travel("slow-cheap", 500), travel("fast-expensive", 100)],
    );
    expect(paretoFrontier(attached).map(({ id }) => id)).toEqual([
      "fast-expensive",
      "slow-cheap",
    ]);
  });

  it("never treats missing travel as zero when mixed candidates reach dominance", () => {
    const priceOnly = plan("price-only", 10_000, 1);
    const travelBacked: FrontierPlan<string> = {
      ...plan("travel-backed", 12_000, 1),
      travel: calculatedTravel("travel-backed", 100) as Extract<
        TravelResult,
        { kind: "calculated" }
      >,
    };

    expect(new Set(paretoFrontier([travelBacked, priceOnly]).map(({ id }) => id))).toEqual(
      new Set(["price-only", "travel-backed"]),
    );
  });

  it.each(["missing", "unavailable", "invalid"] as const)(
    "recomputes a coherent price-only frontier when travel is %s",
    (failure) => {
      const cheap = plan("cheap", 10_000, 1);
      const expensive = plan("expensive", 12_000, 1);
      const evidence: PlanTravelEvidence[] = [travel("expensive", 100)];
      if (failure === "unavailable") {
        evidence.push({
          planId: "cheap",
          travel: {
            contractVersion: 1,
            kind: "unavailable",
            reason: "provider-unavailable",
          },
        });
      } else if (failure === "invalid") {
        evidence.push({
          planId: "cheap",
          travel: {
            ...calculatedTravel("cheap", 500),
            durationSeconds: -1,
          } as TravelResult,
        });
      }

      const attached = attachOptionalTravelEvidence([expensive, cheap], evidence);

      expect(attached.every((candidate) => !("travel" in candidate))).toBe(true);
      expect(paretoFrontier(attached).map(({ id }) => id)).toEqual(["cheap"]);
    },
  );

  it("projects at most seven real representatives while preserving both endpoints", () => {
    const candidates = Array.from({ length: 12 }, (_, index) =>
      plan(
        `plan-${String(index).padStart(2, "0")}`,
        20_000 - index * 500,
        index < 4 ? 1 : index < 8 ? 2 : 3,
        index,
      ),
    );
    const frontier = paretoFrontier(candidates);

    const projected = projectRepresentatives([...frontier].reverse(), 7);

    expect(projected).toHaveLength(7);
    expect(projected[0]?.id).toBe(frontier[0]?.id);
    expect(projected.at(-1)?.id).toBe(frontier.at(-1)?.id);
    expect(new Set(projected.map(({ id }) => id)).size).toBe(7);
    expect(new Set(projected.map(({ chains }) => chains.length))).toEqual(
      new Set([1, 2, 3]),
    );
    expect(JSON.stringify(projected)).toBe(
      JSON.stringify(projectRepresentatives(frontier, 7)),
    );
  });

  it("validates the representative bound and resolves max one deterministically", () => {
    const candidates = [plan("convenience", 12_000, 1), plan("savings", 10_000, 2)];

    expect(projectRepresentatives(candidates, 0)).toEqual([]);
    expect(projectRepresentatives(candidates, 1.5)).toEqual([]);
    expect(projectRepresentatives(candidates, 8)).toEqual([]);
    expect(projectRepresentatives(candidates, 1).map(({ id }) => id)).toEqual([
      "convenience",
    ]);
  });

  it("emits deterministic source-neutral deltas with evidence-backed savings and travel", () => {
    const convenience: FrontierPlan<string> = {
      ...plan("convenience", 20_000, 1),
      travel: calculatedTravel("convenience", 500) as Extract<
        TravelResult,
        { kind: "calculated" }
      >,
    };
    const savings: FrontierPlan<string> = {
      ...plan("savings", 15_000, 2, 1),
      travel: calculatedTravel("savings", 400) as Extract<
        TravelResult,
        { kind: "calculated" }
      >,
    };
    const evidence: PlanClaimEvidence[] = [
      { planId: "savings", priceEvidenceIds: ["price:savings"] },
      { planId: "convenience", priceEvidenceIds: ["price:convenience"] },
    ];

    const forward = explainPlanDeltas([savings, convenience], evidence);
    const reversed = explainPlanDeltas(
      [convenience, savings],
      [...evidence].reverse(),
    );

    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
    expect(forward.map(({ planId }) => planId)).toEqual(["convenience", "savings"]);
    expect(forward[0]?.explanations.map(({ kind }) => kind)).toEqual(["convenience"]);
    expect(forward[1]?.explanations.map(({ kind }) => kind)).toEqual([
      "savings",
      "convenience",
      "substitution",
      "travel",
    ]);

    const savingsExplanation = forward[1]?.explanations.find(
      ({ kind }) => kind === "savings",
    );
    const travelExplanation = forward[1]?.explanations.find(
      ({ kind }) => kind === "travel",
    );
    expect(savingsExplanation?.evidenceIds).toEqual([
      "price:convenience",
      "price:savings",
    ]);
    expect(travelExplanation?.evidenceIds).toEqual([
      "route:convenience",
      "route:savings",
    ]);
    expect(
      forward.flatMap(({ explanations }) => explanations).every(
        (explanation) => planExplanationSchema.safeParse(explanation).success,
      ),
    ).toBe(true);
    expect(JSON.stringify(forward)).not.toContain("fixture-source");
    expect(JSON.stringify(forward)).not.toContain("kassalapp");
  });

  it("suppresses savings claims when the required price evidence IDs are absent", () => {
    const convenience = plan("convenience", 20_000, 1);
    const savings = plan("savings", 15_000, 2);

    const explained = explainPlanDeltas(
      [savings, convenience],
      [{ planId: "convenience", priceEvidenceIds: ["price:convenience"] }],
    );

    expect(explained.map(({ planId }) => planId)).toEqual(["convenience", "savings"]);
    expect(
      explained.flatMap(({ explanations }) => explanations).some(
        ({ kind }) => kind === "savings",
      ),
    ).toBe(false);
  });
});
