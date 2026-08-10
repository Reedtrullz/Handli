import {
  discoveryImpactResponseV1SchemaFor,
  type DiscoveryImpactRequestV1,
  type ReviewedFamilyPlanApiRequestV2,
} from "@handleplan/domain";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createServerContainer, FAKE_EVALUATION_TIME } from "./container";
import { DiscoveryImpactService } from "./discovery-impact-service";
import { ReviewedFamilyPlanError, type PlanService } from "./plan-service";
import type { PriceService } from "./price-service";

const MILK = "7038010000010";
const COFFEE = "7038010000027";
const MILK_ALTERNATIVE = "7038010000041";
const UNKNOWN = "7038010000058";
const MARKET_CONTEXT = {
  contractVersion: 1,
  countryCode: "NO",
  kind: "national",
} as const;

function exactImpact(
  actionGtin = COFFEE,
): DiscoveryImpactRequestV1 {
  return {
    actions: [{
      actionId: "action:add",
      kind: "add",
      product: { kind: "gtin", value: actionGtin },
      userApproved: true,
    }],
    contractVersion: 1,
    convenienceWeightBasisPoints: 5_000,
    planning: {
      contractVersion: 1,
      enabledMembershipProgramIds: [],
      marketContext: MARKET_CONTEXT,
      maxStores: 3,
      needs: [{
        id: "need:milk",
        match: {
          kind: "exact-product",
          product: { kind: "gtin", value: MILK },
          userApproved: true,
        },
        quantity: 1,
        quantityUnit: "package",
        required: true,
      }],
    },
  };
}

function resolverDependencies(planService: PlanService) {
  return (planService as unknown as {
    dependencies: {
      catalog: { getMany: (...args: never[]) => Promise<unknown> };
      familyCandidateService: { inspectAt: (...args: never[]) => Promise<unknown> };
      priceService: PriceService;
    };
  }).dependencies;
}

describe("DiscoveryImpactService", () => {
  it("qualifies numeric comparisons when either selected plan has partial coverage", async () => {
    const request = exactImpact();
    const service = new DiscoveryImpactService({
      resolver: {
        resolveDiscoveryImpactPlanning: vi.fn(async () => ({
          baselineCandidateSets: [{
            candidateGtins: [MILK],
            needId: "need:milk",
          }],
          comparisonCoverageByCanonicalProductId: new Map([
            ["product:milk", "complete" as const],
            ["product:coffee", "partial" as const],
          ]),
          evaluatedAt: new Date(FAKE_EVALUATION_TIME),
          planning: {
            contractVersion: 2 as const,
            matchingRules: [{
              exactEan: MILK,
              explanation: "Eksakt produkt valgt av brukeren",
              id: "need:milk",
              mode: "exact" as const,
              userApproved: true as const,
            }],
            maxStores: 3 as const,
            needs: [{
              id: "need:milk",
              matchRuleId: "need:milk",
              query: "Melk",
              requested: { amount: 1, unit: "package" as const },
              required: true as const,
            }],
            offerEligibility: {
              channel: "in-store" as const,
              enabledMembershipProgramIds: [],
              enabledSourceIds: ["price-source"],
              location: { countryCode: "NO" },
              maxEvidenceAgeMs: 1_209_600_000,
            },
            officialOffers: [],
            ordinaryPrices: [
              {
                amountOre: 2_000 as never,
                chain: "extra" as const,
                ean: MILK,
                observedAt: "2026-07-15T11:00:00.000Z",
                source: "price-source",
              },
              {
                amountOre: 4_000 as never,
                chain: "extra" as const,
                ean: COFFEE,
                observedAt: "2026-07-15T11:00:00.000Z",
                source: "price-source",
              },
            ],
            products: [
              {
                canonicalProductId: "product:milk",
                ean: MILK,
                name: "Melk",
                packageMeasure: { amount: 1, unit: "package" as const },
              },
              {
                canonicalProductId: "product:coffee",
                ean: COFFEE,
                name: "Kaffe",
                packageMeasure: { amount: 1, unit: "package" as const },
              },
            ],
          },
        })),
      },
    });

    const result = await service.calculate(request);

    expect(result.baseline).toMatchObject({
      kind: "complete",
      plan: { comparisonCoverage: "complete" },
    });
    expect(result.outcomes[0]).toMatchObject({
      comparison: {
        claimScope: "among-verified-prices",
        kind: "comparable",
      },
      plan: { comparisonCoverage: "partial" },
      state: "complete",
    });
  });

  it("keeps a reviewed plan partial when an eligible unselected family candidate is partial", async () => {
    const request: DiscoveryImpactRequestV1 = {
      actions: [{
        actionId: "action:add-coffee",
        kind: "add",
        product: { kind: "gtin", value: COFFEE },
        userApproved: true,
      }],
      contractVersion: 1,
      convenienceWeightBasisPoints: 10_000,
      planning: {
        contractVersion: 2,
        enabledMembershipProgramIds: [],
        marketContext: MARKET_CONTEXT,
        maxStores: 3,
        needs: [{
          id: "need:milk",
          match: {
            confirmation: {
              candidateSetId: `candidate-set:${"a".repeat(64)}`,
              taxonomyVersionId: "handleplan-reviewed-families@1.0.0",
              userApproved: true,
            },
            familyId: "family:melk",
            kind: "reviewed-family",
          },
          quantity: 1,
          quantityUnit: "package",
          required: true,
        }],
      },
    };
    const service = new DiscoveryImpactService({
      resolver: {
        resolveDiscoveryImpactPlanning: vi.fn(async () => ({
          baselineCandidateSets: [{
            candidateGtins: [MILK, MILK_ALTERNATIVE],
            needId: "need:milk",
          }],
          comparisonCoverageByCanonicalProductId: new Map([
            ["product:milk:selected", "complete" as const],
            ["product:milk:alternative", "partial" as const],
            ["product:coffee", "complete" as const],
          ]),
          evaluatedAt: new Date(FAKE_EVALUATION_TIME),
          planning: {
            contractVersion: 2 as const,
            matchingRules: [{
              explanation: "Serververifisert produktfamilie godkjent av brukeren",
              id: "need:milk",
              mode: "flexible" as const,
              productFamily: "family:melk",
              userApproved: true as const,
            }],
            maxStores: 3 as const,
            needs: [{
              id: "need:milk",
              matchRuleId: "need:milk",
              query: "Melk",
              requested: { amount: 1, unit: "package" as const },
              required: true as const,
            }],
            offerEligibility: {
              channel: "in-store" as const,
              enabledMembershipProgramIds: [],
              enabledSourceIds: ["price-source"],
              location: { countryCode: "NO" },
              maxEvidenceAgeMs: 1_209_600_000,
            },
            officialOffers: [],
            ordinaryPrices: [
              {
                amountOre: 2_000 as never,
                chain: "extra" as const,
                ean: MILK,
                observedAt: "2026-07-15T11:00:00.000Z",
                source: "price-source",
              },
              {
                amountOre: 9_000 as never,
                chain: "extra" as const,
                ean: MILK_ALTERNATIVE,
                observedAt: "2026-07-15T11:00:00.000Z",
                source: "price-source",
              },
              {
                amountOre: 4_000 as never,
                chain: "extra" as const,
                ean: COFFEE,
                observedAt: "2026-07-15T11:00:00.000Z",
                source: "price-source",
              },
            ],
            products: [
              {
                canonicalProductId: "product:milk:selected",
                ean: MILK,
                name: "Melk A",
                packageMeasure: { amount: 1, unit: "package" as const },
                productFamily: "family:melk",
              },
              {
                canonicalProductId: "product:milk:alternative",
                ean: MILK_ALTERNATIVE,
                name: "Melk B",
                packageMeasure: { amount: 1, unit: "package" as const },
                productFamily: "family:melk",
              },
              {
                canonicalProductId: "product:coffee",
                ean: COFFEE,
                name: "Kaffe",
                packageMeasure: { amount: 1, unit: "package" as const },
              },
            ],
          },
        })),
      },
    });

    const result = await service.calculate(request);

    expect(result.baseline).toMatchObject({
      kind: "complete",
      plan: { comparisonCoverage: "partial", totalOre: 2_000 },
    });
    expect(result.outcomes[0]).toMatchObject({
      comparison: {
        claimScope: "among-verified-prices",
        kind: "comparable",
      },
      plan: { comparisonCoverage: "partial" },
      state: "complete",
    });
  });

  it("never emits a numeric delta when the baseline basket has no complete plan", async () => {
    const request: DiscoveryImpactRequestV1 = {
      ...exactImpact(),
      actions: [{
        actionId: "action:replace",
        kind: "replace",
        needId: "need:milk",
        product: { kind: "gtin", value: COFFEE },
        userApproved: true,
      }],
    };
    const service = new DiscoveryImpactService({
      resolver: {
        resolveDiscoveryImpactPlanning: vi.fn(async () => ({
          baselineCandidateSets: [{ candidateGtins: [MILK], needId: "need:milk" }],
          comparisonCoverageByCanonicalProductId: new Map([
            ["product:milk", "partial" as const],
            ["product:coffee", "partial" as const],
          ]),
          evaluatedAt: new Date(FAKE_EVALUATION_TIME),
          planning: {
            contractVersion: 2 as const,
            matchingRules: [{
              exactEan: MILK,
              explanation: "Eksakt produkt valgt av brukeren",
              id: "need:milk",
              mode: "exact" as const,
              userApproved: true as const,
            }],
            maxStores: 3 as const,
            needs: [{
              id: "need:milk",
              matchRuleId: "need:milk",
              query: "Melk",
              requested: { amount: 1, unit: "package" as const },
              required: true as const,
            }],
            offerEligibility: {
              channel: "in-store" as const,
              enabledMembershipProgramIds: [],
              enabledSourceIds: ["price-source"],
              location: { countryCode: "NO" },
              maxEvidenceAgeMs: 1_209_600_000,
            },
            officialOffers: [],
            ordinaryPrices: [{
              amountOre: 4_000 as never,
              chain: "extra" as const,
              ean: COFFEE,
              observedAt: "2026-07-15T11:00:00.000Z",
              source: "price-source",
            }],
            products: [
              {
                canonicalProductId: "product:milk",
                ean: MILK,
                name: "Melk",
                packageMeasure: { amount: 1, unit: "package" as const },
              },
              {
                canonicalProductId: "product:coffee",
                ean: COFFEE,
                name: "Kaffe",
                packageMeasure: { amount: 1, unit: "package" as const },
              },
            ],
          },
        })),
      },
    });

    const result = await service.calculate(request);

    expect(result.baseline).toEqual({
      kind: "incomplete",
      reason: "no-complete-plan",
    });
    expect(result.outcomes[0]).toMatchObject({
      comparison: {
        kind: "unavailable",
        reason: "baseline-incomplete",
      },
      state: "complete",
    });
    expect(JSON.stringify(result.outcomes[0])).not.toContain("DeltaOre");
  });

  it("resolves and prices one exact baseline/action union once without calling PlanService.calculate*", async () => {
    const container = createServerContainer({ mode: "fake" });
    const planService = container.planService as PlanService;
    const dependencies = resolverDependencies(planService);
    const catalogRead = vi.spyOn(dependencies.catalog, "getMany");
    const priceRead = vi.spyOn(dependencies.priceService, "readProducts");
    const familyRead = vi.spyOn(dependencies.familyCandidateService, "inspectAt");
    const exactCalculate = vi.spyOn(planService, "calculateExact");
    const reviewedCalculate = vi.spyOn(planService, "calculateReviewed");
    const request = exactImpact();

    const result = await container.discoveryImpactService.calculate(request);

    expect(discoveryImpactResponseV1SchemaFor(request).safeParse(result).success)
      .toBe(true);
    expect(result.evaluatedAt).toBe(FAKE_EVALUATION_TIME);
    expect(result.travelImpact).toEqual({
      kind: "omitted",
      reason: "origin-not-retained",
    });
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]).toMatchObject({
      actionId: "action:add",
      actionKind: "add",
      state: "complete",
    });
    expect(catalogRead).toHaveBeenCalledOnce();
    expect(catalogRead.mock.calls[0]?.[0]).toEqual([MILK, COFFEE].sort());
    expect(priceRead).toHaveBeenCalledOnce();
    expect(priceRead.mock.calls[0]?.[0]).toEqual([MILK, COFFEE].sort());
    expect(familyRead).not.toHaveBeenCalled();
    expect(exactCalculate).not.toHaveBeenCalled();
    expect(reviewedCalculate).not.toHaveBeenCalled();
    const summaries = [
      ...(result.baseline.kind === "complete" ? [result.baseline.plan] : []),
      ...result.outcomes.flatMap((outcome) =>
        outcome.state === "complete" ? [outcome.plan] : []),
    ];
    expect(summaries.every(({ storeCount }) => storeCount <= 3)).toBe(true);
  });

  it("keeps an unknown action local to its ineligible outcome and prices the known baseline once", async () => {
    const container = createServerContainer({ mode: "fake" });
    const planService = container.planService as PlanService;
    const dependencies = resolverDependencies(planService);
    const catalogRead = vi.spyOn(dependencies.catalog, "getMany");
    const priceRead = vi.spyOn(dependencies.priceService, "readProducts");
    const request = exactImpact(UNKNOWN);

    const result = await container.discoveryImpactService.calculate(request);

    expect(result.outcomes).toEqual([{
      action: request.actions[0],
      actionId: "action:add",
      actionKind: "add",
      reason: "unknown-product",
      state: "ineligible",
    }]);
    expect(catalogRead).toHaveBeenCalledOnce();
    expect(catalogRead.mock.calls[0]?.[0]).toEqual([MILK, UNKNOWN].sort());
    expect(priceRead).toHaveBeenCalledOnce();
    expect(priceRead.mock.calls[0]?.[0]).toEqual([MILK]);
  });

  it("inspects a reviewed family once, binds the confirmation, and performs one catalog and price read", async () => {
    const container = createServerContainer({ mode: "fake" });
    const inspection = await container.familyCandidateService.inspect({
      contractVersion: 2,
      families: [{ familyId: "family:melk" }],
    });
    const confirmation = inspection.candidateSets[0]!;
    const planning: ReviewedFamilyPlanApiRequestV2 = {
      contractVersion: 2,
      enabledMembershipProgramIds: [],
      marketContext: MARKET_CONTEXT,
      maxStores: 2,
      needs: [{
        id: "need:milk",
        match: {
          confirmation: {
            candidateSetId: confirmation.candidateSetId,
            taxonomyVersionId: confirmation.taxonomyVersionId,
            userApproved: true,
          },
          familyId: "family:melk",
          kind: "reviewed-family",
        },
        quantity: 2,
        quantityUnit: "package",
        required: true,
      }],
    };
    const request: DiscoveryImpactRequestV1 = {
      actions: [{
        actionId: "action:lock",
        kind: "lock",
        needId: "need:milk",
        product: { kind: "gtin", value: MILK },
        userApproved: true,
      }],
      contractVersion: 1,
      convenienceWeightBasisPoints: 7_500,
      planning,
    };
    const planService = container.planService as PlanService;
    const dependencies = resolverDependencies(planService);
    const catalogRead = vi.spyOn(dependencies.catalog, "getMany");
    const priceRead = vi.spyOn(dependencies.priceService, "readProducts");
    const familyRead = vi.spyOn(dependencies.familyCandidateService, "inspectAt");

    const result = await container.discoveryImpactService.calculate(request);

    expect(discoveryImpactResponseV1SchemaFor(request).safeParse(result).success)
      .toBe(true);
    expect(familyRead).toHaveBeenCalledOnce();
    expect(familyRead.mock.calls[0]?.[1]).toEqual(new Date(FAKE_EVALUATION_TIME));
    expect(catalogRead).toHaveBeenCalledOnce();
    expect(priceRead).toHaveBeenCalledOnce();
    expect(result.outcomes[0]).toMatchObject({
      actionId: "action:lock",
      actionKind: "lock",
      state: "complete",
    });
    if (result.outcomes[0]?.state === "complete") {
      expect(result.outcomes[0].plan.storeCount).toBeLessThanOrEqual(2);
    }
  });

  it("rejects a stale reviewed confirmation before catalog or price evaluation", async () => {
    const container = createServerContainer({ mode: "fake" });
    const request: DiscoveryImpactRequestV1 = {
      actions: [{
        actionId: "action:lock",
        kind: "lock",
        needId: "need:milk",
        product: { kind: "gtin", value: MILK },
        userApproved: true,
      }],
      contractVersion: 1,
      convenienceWeightBasisPoints: 5_000,
      planning: {
        contractVersion: 2,
        enabledMembershipProgramIds: [],
        marketContext: MARKET_CONTEXT,
        maxStores: 3,
        needs: [{
          id: "need:milk",
          match: {
            confirmation: {
              candidateSetId: `candidate-set:${"f".repeat(64)}`,
              taxonomyVersionId: "handleplan-reviewed-families@1.0.0",
              userApproved: true,
            },
            familyId: "family:melk",
            kind: "reviewed-family",
          },
          quantity: 1,
          quantityUnit: "package",
          required: true,
        }],
      },
    };
    const planService = container.planService as PlanService;
    const dependencies = resolverDependencies(planService);
    const catalogRead = vi.spyOn(dependencies.catalog, "getMany");
    const priceRead = vi.spyOn(dependencies.priceService, "readProducts");
    const familyRead = vi.spyOn(dependencies.familyCandidateService, "inspectAt");

    await expect(container.discoveryImpactService.calculate(request)).rejects
      .toEqual(new ReviewedFamilyPlanError("CANDIDATE_CONFIRMATION_STALE"));
    expect(familyRead).toHaveBeenCalledOnce();
    expect(catalogRead).not.toHaveBeenCalled();
    expect(priceRead).not.toHaveBeenCalled();
  });
});
