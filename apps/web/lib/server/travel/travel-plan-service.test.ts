import type {
  ExactProductPlanApiEvidenceEnvelope,
  FrontierPlanV2,
  MoneyOre,
  OfficialOffer,
  PlanResultV2,
  ReviewedFamilyPlanApiRequestV2,
  TravelPlanApiRequest,
} from "@handleplan/domain";
import { paretoFrontierV2, projectRepresentativesV2 } from "@handleplan/domain";
import { travelPlanApiResponseSchemaFor } from "@handleplan/domain";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createServerContainer, FAKE_EVALUATION_TIME } from "../container";
import { PlanRequestCancelledError, type PlanServiceContract } from "../plan-service";
import type { LocationChoiceResolver } from "./location-search-service";
import {
  pruneReviewedPlanningSources,
  TravelPlanCoordinator,
  type TravelPlanCoordinatorDependencies,
} from "./travel-plan-service";
import type { TravelServiceResult } from "./travel-service";

const TOKEN = `location-choice:${"a".repeat(43)}`;
const ORIGIN = { latitudeE6: 59_913_900, longitudeE6: 10_752_200 };
const REQUEST_TIME = new Date("2026-07-17T18:00:00.000Z");
const MARKET_CONTEXT = {
  contractVersion: 1,
  countryCode: "NO",
  kind: "national",
} as const;
const OSLO_DIRECTORY_ATTESTATION = {
  contractVersion: 1 as const,
  countryCode: "NO",
  directoryVersionId: "postal-directory-2026-07",
  evaluatedAt: FAKE_EVALUATION_TIME,
  evidenceReference: "manifest:postal-directory-2026-07",
  publishedAt: "2026-07-15T10:00:00.000Z",
  region: {
    coverageState: "complete" as const,
    evidenceReference: "manifest:oslo-postal-set",
    postalCodes: ["0152", "0452"],
    regionCode: "no-0301-oslo",
  },
  reviewedAt: "2026-07-15T09:00:00.000Z",
  status: "approved" as const,
  validFrom: "2026-07-15T00:00:00.000Z",
};

const exactPlanning: Extract<TravelPlanApiRequest["planning"], { contractVersion: 1 }> = {
  contractVersion: 1,
  enabledMembershipProgramIds: [],
  marketContext: MARKET_CONTEXT,
  maxStores: 2,
  needs: [
    {
      id: "need:milk",
      match: {
        kind: "exact-product",
        product: { kind: "gtin", value: "7038010000010" },
        userApproved: true,
      },
      quantity: 1,
      quantityUnit: "package",
      required: true,
    },
    {
      id: "need:coffee",
      match: {
        kind: "exact-product",
        product: { kind: "gtin", value: "7038010000027" },
        userApproved: true,
      },
      quantity: 1,
      quantityUnit: "package",
      required: true,
    },
  ],
};

function travelRequest(
  planning: TravelPlanApiRequest["planning"] = exactPlanning,
): TravelPlanApiRequest {
  return {
    contractVersion: 1,
    locationSelectionToken: TOKEN,
    planning,
    travelMode: "car",
  };
}

function resolver(
  resolve: LocationChoiceResolver["resolve"] = () => ORIGIN,
): LocationChoiceResolver {
  return { resolve: vi.fn(resolve) };
}

function calculatedFor(
  candidates: readonly PlanResultV2[],
  selected?: readonly PlanResultV2[],
  mode: "car" | "bike" = "car",
  durationFor?: (plan: PlanResultV2, index: number) => number,
): TravelServiceResult {
  const evaluatedCandidates: FrontierPlanV2[] = candidates.map((plan, planIndex) => ({
    ...plan,
    travel: {
      calculatedAt: FAKE_EVALUATION_TIME,
      contractVersion: 1,
      distanceMeters: 2_000 + planIndex,
      durationSeconds: durationFor?.(plan, planIndex) ?? 300 + planIndex,
      kind: "calculated",
      providerSourceId: "fixture-router",
      routeFingerprint: `route:fixture-${planIndex}`,
    },
  }));
  const expected = projectRepresentativesV2(
    paretoFrontierV2(evaluatedCandidates),
    7,
  );
  const plans = selected === undefined
    ? expected
    : selected.map((plan) => evaluatedCandidates.find(({ id }) => id === plan.id)!)
      .filter((plan): plan is FrontierPlanV2 => plan !== undefined);
  return {
    evaluatedCandidates,
    plans,
    travel: {
      contractVersion: 1,
      kind: "calculated",
      routes: plans.map((plan) => ({
        aggregate: {
          calculatedAt: plan.travel!.calculatedAt,
          distanceMeters: plan.travel!.distanceMeters,
          durationSeconds: plan.travel!.durationSeconds,
          mode,
          providerSourceId: plan.travel!.providerSourceId,
          routeFingerprint: plan.travel!.routeFingerprint,
        },
        planId: plan.id,
        stops: plan.chains.map((chainId, stopIndex) => ({
          branchId: `branch:${chainId}:${plan.id}`,
          chainId,
          name: `${chainId} testbutikk`,
          sequence: stopIndex + 1,
        })),
      })),
    },
  };
}

function postalEvidence(
  evidence: ExactProductPlanApiEvidenceEnvelope,
): ExactProductPlanApiEvidenceEnvelope {
  return {
    ...evidence,
    needs: evidence.needs.map((need) => ({
      ...need,
      ordinaryPrices: need.ordinaryPrices.map((price) => ({
        ...price,
        geographicScope: {
          countryCode: "NO",
          kind: "postal-set",
          postalCodes: ["0152", "0452"],
        },
      })),
    })),
  };
}

function regionalPostalPlanService(): PlanServiceContract {
  const base = createServerContainer({ mode: "fake" }).planService;
  return {
    calculateExact: async (request, signal) => {
      const result = await base.calculateExact(request, signal);
      return {
        ...result,
        completeCandidateSet: {
          ...result.completeCandidateSet,
          evidence: postalEvidence(result.completeCandidateSet.evidence),
        },
        evidence: postalEvidence(result.evidence),
        geographicDirectoryAttestation: OSLO_DIRECTORY_ATTESTATION,
      };
    },
    calculateReviewed: (request, signal) => base.calculateReviewed(request, signal),
  };
}

function dependencies(
  overrides: Partial<TravelPlanCoordinatorDependencies> = {},
): TravelPlanCoordinatorDependencies {
  return {
    locationChoices: resolver(),
    now: () => new Date(REQUEST_TIME),
    planService: createServerContainer({ mode: "fake" }).planService,
    travelEnabled: true,
    travelService: { calculate: async ({ candidates }) => calculatedFor(candidates) },
    ...overrides,
  };
}

async function reviewedPlanningRequest(): Promise<ReviewedFamilyPlanApiRequestV2> {
  const container = createServerContainer({ mode: "fake" });
  const inspection = await container.familyCandidateService.inspect({
    contractVersion: 2,
    families: [{ familyId: "family:melk" }],
  });
  const candidate = inspection.candidateSets[0]!;
  return {
    contractVersion: 2,
    enabledMembershipProgramIds: [],
    marketContext: MARKET_CONTEXT,
    maxStores: 2,
    needs: [
      {
        id: "need:coffee",
        match: {
          kind: "exact-product",
          product: { kind: "gtin", value: "7038010000027" },
          userApproved: true,
        },
        quantity: 1,
        quantityUnit: "package",
        required: true,
      },
      {
        id: "need:milk",
        match: {
          confirmation: {
            candidateSetId: candidate.candidateSetId,
            taxonomyVersionId: candidate.taxonomyVersionId,
            userApproved: true,
          },
          familyId: "family:melk",
          kind: "reviewed-family",
        },
        quantity: 1,
        quantityUnit: "package",
        required: true,
      },
    ],
  };
}

describe("TravelPlanCoordinator", () => {
  it("uses current request time for the token, planning generatedAt for routing, and rebuilds exact plan evidence", async () => {
    const locationChoices = resolver();
    const calculate = vi.fn(async ({ candidates }: { candidates: readonly PlanResultV2[] }) =>
      calculatedFor(candidates));
    const coordinator = new TravelPlanCoordinator(dependencies({
      locationChoices,
      travelService: { calculate },
    }));

    const result = await coordinator.calculate(travelRequest());

    expect(locationChoices.resolve).toHaveBeenCalledWith(
      TOKEN,
      REQUEST_TIME,
    );
    expect(calculate).toHaveBeenCalledWith(expect.objectContaining({
      capturedEvaluationTime: new Date(FAKE_EVALUATION_TIME),
      marketContext: exactPlanning.marketContext,
      mode: "car",
      origin: ORIGIN,
    }), undefined);
    expect(result.planning.contractVersion).toBe(1);
    expect(result.planning.plans.length).toBeGreaterThan(0);
    const visibleIds = new Set(result.planning.plans.map(({ id }) => id));
    expect(result.planning.evidence.assignmentEvidence.every(({ planId }) =>
      visibleIds.has(planId))).toBe(true);
    expect(result.travel.kind).toBe("calculated");
    if (result.travel.kind !== "calculated") throw new Error("expected calculated travel");
    expect(result.travel.routes.every(({ aggregate }) => aggregate.mode === "car")).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(
      /latitude|longitude|coordinate|59_913_900|10_752_200/i,
    );
  });

  it("routes every complete candidate before Pareto filtering so shorter travel can rescue a price-dominated plan", async () => {
    const planService = createServerContainer({ mode: "fake" }).planService;
    const priceOnly = await planService.calculateExact(exactPlanning);
    const visibleIds = new Set(priceOnly.plans.map(({ id }) => id));
    const rescued = priceOnly.completeCandidateSet.plans.find(({ id }) => !visibleIds.has(id));
    expect(priceOnly.completeCandidateSet.plans.length).toBeGreaterThan(priceOnly.plans.length);
    expect(rescued).toBeDefined();
    if (rescued === undefined) throw new Error("fixture needs a price-dominated complete plan");

    const calculate = vi.fn(async ({ candidates }: { candidates: readonly PlanResultV2[] }) =>
      calculatedFor(
        candidates,
        undefined,
        "car",
        (plan) => plan.id === rescued.id ? 1 : 3_600,
      ));
    const result = await new TravelPlanCoordinator(dependencies({
      planService,
      travelService: { calculate },
    })).calculate(travelRequest());

    const routedCandidates = calculate.mock.calls[0]?.[0].candidates ?? [];
    expect(routedCandidates.map(({ id }) => id)).toEqual(
      priceOnly.completeCandidateSet.plans.map(({ id }) => id),
    );
    expect(result.travel.kind).toBe("calculated");
    expect(result.planning.plans.map(({ id }) => id)).toContain(rescued.id);
  });

  it("rejects a travel response whose plan body is a non-canonical assignment permutation", async () => {
    const request = travelRequest();
    const result = await new TravelPlanCoordinator(dependencies()).calculate(request);
    expect(travelPlanApiResponseSchemaFor(request).safeParse(result).success).toBe(true);
    const planIndex = result.planning.plans.findIndex(({ assignments }) => assignments.length > 1);
    expect(planIndex).toBeGreaterThanOrEqual(0);
    const plan = result.planning.plans[planIndex]!;
    const plans = result.planning.plans.map((candidate, index) => index === planIndex
      ? { ...candidate, assignments: [...plan.assignments].reverse() }
      : candidate);

    expect(travelPlanApiResponseSchemaFor(request).safeParse({
      ...result,
      planning: { ...result.planning, plans },
    }).success).toBe(false);
  });

  it("fails closed when calculated route aggregates do not bind the requested mode", async () => {
    const coordinator = new TravelPlanCoordinator(dependencies({
      travelService: {
        calculate: async ({ candidates }) => calculatedFor(candidates, undefined, "bike"),
      },
    }));

    const result = await coordinator.calculate(travelRequest());

    expect(result.travel).toEqual({
      contractVersion: 1,
      kind: "unavailable",
      reason: "provider-unavailable",
    });
  });

  it("recalculates reviewed-family planning and preserves current disabled member offers", async () => {
    const planning = await reviewedPlanningRequest();
    const container = createServerContainer({ mode: "fake" });
    const base = await container.planService.calculateReviewed(planning);
    const ordinary = base.evidence.ordinaryPrices[0];
    if (ordinary?.productMatch.kind !== "exact") throw new Error("expected exact ordinary evidence");
    const disabledMemberOffer: OfficialOffer = {
      applicability: {
        channels: ["in-store"],
        contractVersion: 1,
        endsAt: "2026-07-17T00:00:00.000Z",
        geographicScope: { countryCode: "NO", kind: "national" },
        startsAt: "2026-07-14T00:00:00.000Z",
      },
      beforePriceOre: ordinary.amountOre,
      capturedAt: "2026-07-15T11:00:00.000Z",
      chainId: ordinary.chainId,
      conditions: [{ kind: "member", programId: "travel-member-program" }],
      contractVersion: 1,
      evidenceLevel: "reviewed",
      id: "offer:travel:disabled-member",
      kind: "official-offer",
      pricing: {
        kind: "unit",
        unitPriceOre: Math.max(1, ordinary.amountOre - 100) as MoneyOre,
      },
      productMatch: ordinary.productMatch,
      sourceId: ordinary.sourceId,
      sourceRecordId: "source-record:travel-disabled-member",
    };
    const withOffer = {
      ...base,
      completeCandidateSet: {
        ...base.completeCandidateSet,
        evidence: {
          ...base.completeCandidateSet.evidence,
          officialOffers: [
            ...base.completeCandidateSet.evidence.officialOffers,
            disabledMemberOffer,
          ].sort((left, right) => left.id.localeCompare(right.id)),
        },
      },
      evidence: {
        ...base.evidence,
        officialOffers: [...base.evidence.officialOffers, disabledMemberOffer]
          .sort((left, right) => left.id.localeCompare(right.id)),
      },
    };
    const coordinator = new TravelPlanCoordinator(dependencies({
      planService: {
        calculateExact: (request, signal) =>
          container.planService.calculateExact(request, signal),
        calculateReviewed: async () => withOffer,
      },
      travelService: {
        calculate: async ({ candidates }) => calculatedFor(candidates),
      },
    }));

    const result = await coordinator.calculate(travelRequest(planning));

    expect(result.planning.contractVersion).toBe(2);
    if (result.planning.contractVersion !== 2) throw new Error("expected reviewed response");
    expect(result.planning.needMatches.map(({ kind }) => kind)).toEqual([
      "exact-product",
      "reviewed-family",
    ]);
    const visibleIds = new Set(result.planning.plans.map(({ id }) => id));
    expect(result.planning.evidence.assignmentEvidence.every(({ planId }) =>
      visibleIds.has(planId))).toBe(true);
    const visibleOfferIds = new Set(result.planning.evidence.assignmentEvidence.flatMap(
      ({ conditions }) => conditions.kind === "official-offer" ? [conditions.offerId] : [],
    ));
    expect(visibleOfferIds.has(disabledMemberOffer.id)).toBe(false);
    expect(result.planning.evidence.officialOffers).toContainEqual(disabledMemberOffer);
    expect(result.travel.kind).toBe("calculated");
  });

  it("prunes source descriptors that no longer support a filtered reviewed frontier", async () => {
    const planning = await reviewedPlanningRequest();
    const result = await new TravelPlanCoordinator(dependencies({
      travelEnabled: false,
    })).calculate(travelRequest(planning));
    if (result.planning.contractVersion !== 2) throw new Error("expected reviewed response");

    const pruned = pruneReviewedPlanningSources({
      ...result.planning,
      evidence: {
        ...result.planning.evidence,
        sources: [
          ...result.planning.evidence.sources,
          {
            contractVersion: 1 as const,
            displayName: "Removed offer source",
            id: "removed-offer-source",
            sourceClass: "offer" as const,
            state: "approved" as const,
          },
        ].sort((left, right) => left.id.localeCompare(right.id)),
      },
    });

    expect(pruned.evidence.sources.map(({ id }) => id)).not.toContain(
      "removed-offer-source",
    );
  });

  it("returns a coherent price-only response for an expired valid token", async () => {
    const locationChoices = resolver((_token, at) =>
      at.getTime() >= REQUEST_TIME.getTime() ? undefined : ORIGIN);
    const calculate = vi.fn();
    const result = await new TravelPlanCoordinator(dependencies({
      locationChoices,
      travelService: { calculate },
    })).calculate(travelRequest());

    expect(result.travel).toEqual({
      contractVersion: 1,
      kind: "unavailable",
      reason: "invalid-location",
    });
    expect(result.planning.plans.length).toBeGreaterThan(0);
    expect(calculate).not.toHaveBeenCalled();
    expect(locationChoices.resolve).toHaveBeenCalledWith(TOKEN, REQUEST_TIME);
  });

  it("rejects a malformed token before planning", async () => {
    const planService = {
      calculateExact: vi.fn(),
      calculateReviewed: vi.fn(),
    } satisfies PlanServiceContract;
    const coordinator = new TravelPlanCoordinator(dependencies({ planService }));

    await expect(coordinator.calculate({
      ...travelRequest(),
      locationSelectionToken: "location-choice:not-opaque",
    } as TravelPlanApiRequest)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(planService.calculateExact).not.toHaveBeenCalled();
  });

  it("keeps the source default-off and never resolves or routes when disabled", async () => {
    const locationChoices = resolver();
    const calculate = vi.fn();
    const result = await new TravelPlanCoordinator(dependencies({
      locationChoices,
      travelEnabled: false,
      travelService: { calculate },
    })).calculate(travelRequest());

    expect(result.travel).toEqual({
      contractVersion: 1,
      kind: "unavailable",
      reason: "provider-unavailable",
    });
    expect(locationChoices.resolve).not.toHaveBeenCalled();
    expect(calculate).not.toHaveBeenCalled();
  });

  it("binds regional travel to the selected market and preserves branch failure", async () => {
    const locationChoices = resolver();
    const calculate = vi.fn(async ({ candidates }) => ({
      plans: candidates,
      travel: {
        contractVersion: 1 as const,
        kind: "unavailable" as const,
        reason: "branch-data-unavailable" as const,
      },
    }));
    const regionalPlanning = {
      ...exactPlanning,
      marketContext: {
        contractVersion: 1 as const,
        countryCode: "NO" as const,
        kind: "launch-region" as const,
        regionId: "no-0301-oslo",
      },
    };
    const result = await new TravelPlanCoordinator(dependencies({
      locationChoices,
      planService: regionalPostalPlanService(),
      travelService: { calculate },
    })).calculate(travelRequest(regionalPlanning));

    expect(result.planning.marketContext).toEqual(regionalPlanning.marketContext);
    expect(result.planning.geographicDirectoryAttestation).toEqual(
      OSLO_DIRECTORY_ATTESTATION,
    );
    expect(result.travel).toEqual({
      contractVersion: 1,
      kind: "unavailable",
      reason: "branch-data-unavailable",
    });
    expect(locationChoices.resolve).toHaveBeenCalledWith(TOKEN, REQUEST_TIME);
    expect(calculate).toHaveBeenCalledWith(expect.objectContaining({
      marketContext: regionalPlanning.marketContext,
      origin: ORIGIN,
    }), undefined);
  });

  it("keeps the regional directory attestation through calculated-route filtering", async () => {
    const planning = {
      ...exactPlanning,
      marketContext: {
        contractVersion: 1 as const,
        countryCode: "NO" as const,
        kind: "launch-region" as const,
        regionId: "no-0301-oslo",
      },
    };
    const request = travelRequest(planning);
    const result = await new TravelPlanCoordinator(dependencies({
      planService: regionalPostalPlanService(),
    })).calculate(request);

    expect(result.travel.kind).toBe("calculated");
    expect(result.planning.geographicDirectoryAttestation).toEqual(
      OSLO_DIRECTORY_ATTESTATION,
    );
    if (result.planning.contractVersion !== 1) throw new Error("expected exact response");
    expect(result.planning.evidence.needs.flatMap(({ ordinaryPrices }) => ordinaryPrices)
      .every(({ geographicScope }) => geographicScope.kind === "postal-set"))
      .toBe(true);
    expect(travelPlanApiResponseSchemaFor(request).safeParse(result).success).toBe(true);
  });

  it("maps routing/provider failure to a usable price-only response without leaking details", async () => {
    const result = await new TravelPlanCoordinator(dependencies({
      travelService: {
        calculate: async () => {
          throw new Error("private coordinate https://router.internal/sentinel");
        },
      },
    })).calculate(travelRequest());

    expect(result.travel).toEqual({
      contractVersion: 1,
      kind: "unavailable",
      reason: "provider-unavailable",
    });
    expect(JSON.stringify(result)).not.toMatch(/router\.internal|sentinel|coordinate/i);
  });

  it("fails travel closed when public route aggregates disagree with the evidence used to rank plans", async () => {
    const result = await new TravelPlanCoordinator(dependencies({
      travelService: {
        calculate: async ({ candidates }) => {
          const calculated = calculatedFor(candidates);
          if (calculated.travel.kind !== "calculated") throw new Error("fixture");
          return {
            ...calculated,
            travel: {
              ...calculated.travel,
              routes: calculated.travel.routes.map((route, index) => index === 0
                ? {
                    ...route,
                    aggregate: {
                      ...route.aggregate,
                      durationSeconds: route.aggregate.durationSeconds + 1,
                    },
                  }
                : route),
            },
          };
        },
      },
    })).calculate(travelRequest());

    expect(result.travel).toEqual({
      contractVersion: 1,
      kind: "unavailable",
      reason: "provider-unavailable",
    });
    expect(result.planning.plans.length).toBeGreaterThan(0);
  });

  it("fails travel closed when the provider omits a plan from the recomputed travel frontier", async () => {
    const result = await new TravelPlanCoordinator(dependencies({
      travelService: {
        calculate: async ({ candidates }) => calculatedFor(
          candidates,
          candidates.slice(0, 1),
        ),
      },
    })).calculate(travelRequest());

    expect(result.travel).toEqual({
      contractVersion: 1,
      kind: "unavailable",
      reason: "provider-unavailable",
    });
  });

  it("ignores provider-supplied plan subsets when travel is unavailable", async () => {
    const priceOnly = await createServerContainer({ mode: "fake" })
      .planService.calculateExact(exactPlanning);
    const result = await new TravelPlanCoordinator(dependencies({
      travelService: {
        calculate: async () => ({
          plans: [],
          travel: { contractVersion: 1, kind: "unavailable", reason: "timeout" },
        }),
      },
    })).calculate(travelRequest());

    expect(result.travel).toEqual({
      contractVersion: 1,
      kind: "unavailable",
      reason: "timeout",
    });
    expect(result.planning.plans.length).toBeGreaterThan(0);
    expect(result.planning.plans.map(({ id }) => id)).toEqual(
      priceOnly.plans.map(({ id }) => id),
    );
    expect(result.planning.evidence.assignmentEvidence.length).toBeGreaterThan(0);
  });

  it("propagates cancellation instead of turning it into provider unavailability", async () => {
    const controller = new AbortController();
    const coordinator = new TravelPlanCoordinator(dependencies({
      travelService: {
        calculate: async (_input, signal) => {
          controller.abort("private cancellation reason");
          signal?.throwIfAborted();
          throw new Error("unreachable");
        },
      },
    }));

    await expect(coordinator.calculate(travelRequest(), controller.signal))
      .rejects.toBeInstanceOf(PlanRequestCancelledError);
  });
});
