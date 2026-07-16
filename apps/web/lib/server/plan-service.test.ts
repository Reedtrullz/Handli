import type { PlanningEvidenceSnapshot } from "@handleplan/db/planning-evidence-reader";
import {
  reviewedFamilyPlanApiResponseV2SchemaFor,
  type ExactProductPlanApiProductSummary,
  type ExactProductPlanApiRequest,
  type PriceObservation,
  type ReviewedFamilyCandidateInspectionResponse,
  type ReviewedFamilyPlanApiRequestV2,
} from "@handleplan/domain";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  type ActiveCatalogReader,
  CatalogUnavailableError,
  PlanService,
  PriceDataUnavailableError,
  ReviewedFamilyPlanError,
  UnknownExactProductError,
} from "./plan-service";
import { PriceService, type ProductPriceServiceResult } from "./price-service";

const NOW = new Date("2026-07-15T12:00:00.000Z");
const GTIN = "7038010000010";
const GTIN_ALIAS = "7038010000027";
const CANDIDATE_SET_ID = `candidate-set:${"a".repeat(64)}`;

function price(
  observedAt = "2026-07-15T10:00:00.000Z",
  ean = GTIN,
): PriceObservation {
  return {
    amountOre: 2_190 as PriceObservation["amountOre"],
    chain: "extra",
    ean,
    observedAt,
    source: "kassalapp",
  };
}

const exactRequest: ExactProductPlanApiRequest = {
  contractVersion: 1,
  maxStores: 3,
  needs: [
    {
      id: "melk",
      match: {
        kind: "exact-product",
        product: { kind: "gtin", value: GTIN },
        userApproved: true,
      },
      quantity: 1,
      quantityUnit: "each",
      required: true,
    },
  ],
};

const canonicalSummary: ExactProductPlanApiProductSummary = {
  brand: "TINE",
  catalogEvidence: {
    observedAt: "2026-07-15T10:00:00.000Z",
    source: {
      contractVersion: 1,
      displayName: "Kassalapp test fixture",
      id: "kassalapp",
      sourceClass: "ordinary-price",
      state: "approved",
    },
    sourceRecordId: `source-record:${"a".repeat(64)}`,
  },
  displayName: "Canonical TINE Lettmelk",
  gtin: GTIN,
  packageMeasure: { amount: 1_000, unit: "ml" },
  unitsPerPack: 1,
};

function catalogReader(
  rows: ExactProductPlanApiProductSummary[],
): ActiveCatalogReader & { calls: Array<{ at: Date; gtins: string[]; signal?: AbortSignal }> } {
  const calls: Array<{ at: Date; gtins: string[]; signal?: AbortSignal }> = [];
  return {
    calls,
    getMany: async (gtins, at, signal) => {
      calls.push({ at, gtins: [...gtins], signal });
      return rows;
    },
  };
}

function exactPriceService(
  rows: PriceObservation[],
  products: PlanningEvidenceSnapshot["products"] = [
    { canonicalProductId: "product:milk", gtin: GTIN },
  ],
): PriceService {
  const canonicalIdByGtin = new Map(
    products.map(({ canonicalProductId, gtin }) => [gtin, canonicalProductId]),
  );
  const snapshot: PlanningEvidenceSnapshot = {
    coverageChecks: [],
    historicalEligibleEvidenceIds: [],
    priceEvidence: rows.map((row, index) => ({
      amountOre: row.amountOre,
      chainId: row.chain,
      contractVersion: 1,
      evidenceLevel: "observed",
      geographicScope: { countryCode: "NO", kind: "national" },
      id: `price:test:${index + 1}`,
      kind: "price-evidence",
      observedAt: row.observedAt,
      priceKind: "ordinary",
      productMatch: {
        canonicalProductId: canonicalIdByGtin.get(row.ean) ?? "product:missing",
        kind: "exact",
      },
      sourceId: row.source,
      sourceRecordId: `record:test:${index + 1}`,
    })),
    products,
    sources: rows.length === 0 ? [] : [{
      contractVersion: 1,
      displayName: "Kassalapp test fixture",
      id: "kassalapp",
      sourceClass: "ordinary-price",
      state: "approved",
    }],
  };
  return new PriceService({ reader: { getMany: async () => snapshot } });
}

const catalogSource = {
  contractVersion: 1 as const,
  displayName: "Reviewed catalog fixture",
  id: "catalog-source",
  sourceClass: "catalog" as const,
  state: "approved" as const,
};

const priceSource = {
  contractVersion: 1 as const,
  displayName: "Persisted price fixture",
  id: "price-source",
  sourceClass: "ordinary-price" as const,
  state: "approved" as const,
};

const mixedExactSummary: ExactProductPlanApiProductSummary = {
  ...canonicalSummary,
  catalogEvidence: {
    ...canonicalSummary.catalogEvidence,
    source: catalogSource,
  },
  displayName: "Evergood Kaffe 500 g",
};

const familySummary: ExactProductPlanApiProductSummary = {
  ...mixedExactSummary,
  brand: "TINE",
  catalogEvidence: {
    ...mixedExactSummary.catalogEvidence,
    sourceRecordId: `source-record:${"b".repeat(64)}`,
  },
  displayName: "TINE Lettmelk 1 %",
  gtin: GTIN_ALIAS,
};

const taxonomy = {
  contentSha256: "1d917ee4268615ad510a622ea30d69977191cffc143313a7dbecbad37debf520",
  contractVersion: 1 as const,
  publishedAt: "2026-07-15T00:00:00.000Z",
  taxonomyId: "handleplan-reviewed-families" as const,
  taxonomyVersion: "1.0.0",
  versionId: "handleplan-reviewed-families@1.0.0",
};

const familyDescriptor = {
  aliases: ["mjølk"],
  id: "family:melk",
  labelNo: "Melk",
  slug: "melk",
  status: "active" as const,
};

const membership = {
  canonicalProductId: "product:milk",
  confidence: 100 as const,
  decision: "approved" as const,
  decisionId: "family-membership:1",
  familyId: "family:melk",
  method: "human-review" as const,
  reviewedAt: "2026-07-15T09:00:00.000Z",
  reviewerAttested: true as const,
};

const mixedRequest: ReviewedFamilyPlanApiRequestV2 = {
  contractVersion: 2,
  maxStores: 2,
  needs: [
    {
      ...exactRequest.needs[0]!,
      id: "need:coffee",
      match: {
        ...exactRequest.needs[0]!.match,
        product: { kind: "gtin", value: GTIN },
      },
      quantityUnit: "package",
    },
    {
      id: "need:milk",
      match: {
        allowedBrands: ["tine"],
        confirmation: {
          candidateSetId: CANDIDATE_SET_ID,
          taxonomyVersionId: taxonomy.versionId,
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

const inspection: ReviewedFamilyCandidateInspectionResponse = {
  candidateSets: [{
    allowedBrands: ["tine"],
    candidateProductIds: ["product:milk"],
    candidateSetId: CANDIDATE_SET_ID,
    complete: true,
    family: familyDescriptor,
    familyId: "family:melk",
    taxonomyVersionId: taxonomy.versionId,
  }],
  contractVersion: 2,
  generatedAt: NOW.toISOString(),
  memberships: [membership],
  productClaims: [{ canonicalProductId: "product:milk", product: familySummary }],
  sources: [catalogSource],
  taxonomy,
};

function comparisonScope(
  evidenceId: string,
): ProductPriceServiceResult["productEvidence"][number]["comparisonScope"] {
  return {
    completeness: "partial" as const,
    contractVersion: 1 as const,
    entries: [
      { chainId: "bunnpris", status: { kind: "unknown" as const, reason: "not-checked" as const } },
      { chainId: "extra", status: { evidenceId, kind: "priced" as const } },
      { chainId: "rema-1000", status: { kind: "unknown" as const, reason: "not-checked" as const } },
    ],
    evaluatedAt: NOW.toISOString(),
    expectedChainIds: ["bunnpris", "extra", "rema-1000"],
  };
}

function mixedPriceEvidence(
  id: string,
  canonicalProductId: string,
  amountOre: number,
): ProductPriceServiceResult["productEvidence"][number]["ordinaryPrices"][number] {
  return {
    amountOre: amountOre as PriceObservation["amountOre"],
    chainId: "extra" as const,
    contractVersion: 1 as const,
    evidenceLevel: "observed" as const,
    geographicScope: { countryCode: "NO" as const, kind: "national" as const },
    id,
    kind: "price-evidence" as const,
    observedAt: "2026-07-15T10:00:00.000Z",
    priceKind: "ordinary" as const,
    productMatch: { canonicalProductId, kind: "exact" as const },
    sourceId: priceSource.id,
    sourceRecordId: `record:${id}`,
  };
}

function mixedPriceResult(): ProductPriceServiceResult {
  const exactEvidence = mixedPriceEvidence("price:coffee", "product:coffee", 5_000);
  const familyEvidence = mixedPriceEvidence("price:milk", "product:milk", 2_500);
  return {
    productEvidence: [
      {
        canonicalProductId: "product:coffee",
        comparisonScope: comparisonScope(exactEvidence.id),
        excludedPriceEvidence: [],
        gtin: GTIN,
        historicalComparisons: [],
        historicalPriceEvidence: [],
        officialOffers: [],
        ordinaryPrices: [exactEvidence],
      },
      {
        canonicalProductId: "product:milk",
        comparisonScope: comparisonScope(familyEvidence.id),
        excludedPriceEvidence: [],
        gtin: GTIN_ALIAS,
        historicalComparisons: [],
        historicalPriceEvidence: [],
        officialOffers: [],
        ordinaryPrices: [familyEvidence],
      },
    ],
    prices: [
      { amountOre: 5_000 as PriceObservation["amountOre"], chain: "extra", ean: GTIN, observedAt: exactEvidence.observedAt, source: priceSource.id },
      { amountOre: 2_500 as PriceObservation["amountOre"], chain: "extra", ean: GTIN_ALIAS, observedAt: familyEvidence.observedAt, source: priceSource.id },
    ],
    products: [
      { canonicalProductId: "product:coffee", gtin: GTIN },
      { canonicalProductId: "product:milk", gtin: GTIN_ALIAS },
    ],
    sources: [priceSource],
  };
}

describe("PlanService", () => {
  it("exposes only the persisted-evidence exact planning operation", () => {
    const service = new PlanService({
      catalog: catalogReader([canonicalSummary]),
      now: () => NOW,
      priceService: exactPriceService([price()]),
    });

    expect(typeof service.calculateExact).toBe("function");
    expect("calculate" in service).toBe(false);
    expect(Object.keys((service as unknown as { dependencies: object }).dependencies).sort())
      .toEqual(["catalog", "now", "priceService"]);
  });

  it("rehydrates exact identities and plans only from persisted admitted evidence", async () => {
    const catalog = catalogReader([canonicalSummary]);
    const signal = new AbortController().signal;

    const result = await new PlanService({
      catalog,
      now: () => NOW,
      priceService: exactPriceService([price()]),
    }).calculateExact(exactRequest, signal);

    expect(catalog.calls).toEqual([{ at: NOW, gtins: [GTIN], signal }]);
    expect(result.products).toEqual([canonicalSummary]);
    expect(result.plans).toHaveLength(1);
    expect(result.priceDataSource).toBe("cache");
    expect(result.plans[0]?.assignments[0]).toMatchObject({
      canonicalProductId: "product:milk",
      checkout: { ordinaryTotalOre: 2_190, savingOre: 0, totalOre: 2_190 },
      fulfilment: { complete: true, contractVersion: 2 },
    });
    expect(result.evidence.assignmentEvidence).toHaveLength(1);
    expect(result.evidence.sources).toEqual([canonicalSummary.catalogEvidence.source]);
  });

  it("fails closed before enumeration when two requested GTINs share one canonical identity", async () => {
    const aliasSummary: ExactProductPlanApiProductSummary = {
      ...canonicalSummary,
      catalogEvidence: {
        ...canonicalSummary.catalogEvidence,
        sourceRecordId: `source-record:${"b".repeat(64)}`,
      },
      displayName: "Canonical TINE Lettmelk alias",
      gtin: GTIN_ALIAS,
    };
    const request: ExactProductPlanApiRequest = {
      ...exactRequest,
      needs: [
        exactRequest.needs[0]!,
        {
          ...exactRequest.needs[0]!,
          id: "melk-alias",
          match: {
            ...exactRequest.needs[0]!.match,
            product: { kind: "gtin", value: GTIN_ALIAS },
          },
        },
      ],
    };

    await expect(new PlanService({
      catalog: catalogReader([canonicalSummary, aliasSummary]),
      now: () => NOW,
      priceService: exactPriceService([], [
        { canonicalProductId: "product:milk", gtin: GTIN },
        { canonicalProductId: "product:milk", gtin: GTIN_ALIAS },
      ]),
    }).calculateExact(request)).rejects.toBeInstanceOf(PriceDataUnavailableError);
  });

  it("fails closed when catalog and price evidence disagree about a source descriptor", async () => {
    const mismatchedCatalog = {
      ...canonicalSummary,
      catalogEvidence: {
        ...canonicalSummary.catalogEvidence,
        source: {
          ...canonicalSummary.catalogEvidence.source,
          displayName: "Conflicting catalog source name",
        },
      },
    } satisfies ExactProductPlanApiProductSummary;

    await expect(new PlanService({
      catalog: catalogReader([mismatchedCatalog]),
      now: () => NOW,
      priceService: exactPriceService([price()]),
    }).calculateExact(exactRequest)).rejects.toBeInstanceOf(PriceDataUnavailableError);
  });

  it("uses only the server-owned package measure for exact measured fulfilment", async () => {
    const measuredRequest: ExactProductPlanApiRequest = {
      ...exactRequest,
      needs: [{ ...exactRequest.needs[0]!, quantity: 1_500, quantityUnit: "ml" }],
    };
    const result = await new PlanService({
      catalog: catalogReader([canonicalSummary]),
      now: () => NOW,
      priceService: exactPriceService([price()]),
    }).calculateExact(measuredRequest);

    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]).toMatchObject({
      totalOre: 4_380,
      assignments: [{
        costOre: 4_380,
        fulfilment: {
          canonicalProductId: "product:milk",
          complete: true,
          contractVersion: 2,
          needId: "melk",
          packageCount: 2,
          packageMeasure: { amount: 1_000, unit: "ml" },
          requested: { amount: 1_500, unit: "ml" },
          purchased: { amount: 2_000, unit: "ml" },
          surplus: { amount: 500, unit: "ml" },
        },
      }],
    });
  });

  it("rejects forged browser package metadata on the exact request boundary", async () => {
    const forged = {
      ...exactRequest,
      needs: [{
        ...exactRequest.needs[0]!,
        packageMeasure: { amount: 10_000, unit: "ml" },
      }],
    } as unknown as ExactProductPlanApiRequest;

    await expect(new PlanService({
      catalog: catalogReader([canonicalSummary]),
      now: () => NOW,
    }).calculateExact(forged)).rejects.toBeInstanceOf(UnknownExactProductError);
  });

  it("returns explicit empty coverage when admitted evidence is absent", async () => {
    const result = await new PlanService({
      catalog: catalogReader([canonicalSummary]),
      now: () => NOW,
      priceService: exactPriceService([]),
    }).calculateExact(exactRequest);

    expect(result).toMatchObject({ plans: [], priceDataSource: "cache" });
  });

  it("fails closed when persisted exact-product evidence cannot be read", async () => {
    await expect(new PlanService({
      catalog: catalogReader([canonicalSummary]),
      now: () => NOW,
      priceService: {
        readExact: async () => { throw new Error("private storage detail"); },
      },
    }).calculateExact(exactRequest)).rejects.toBeInstanceOf(PriceDataUnavailableError);
  });

  it("rejects an unknown exact product before reading price evidence", async () => {
    let priceCalls = 0;
    await expect(new PlanService({
      catalog: catalogReader([]),
      now: () => NOW,
      priceService: {
        readExact: async () => {
          priceCalls += 1;
          throw new Error("must not be called");
        },
      },
    }).calculateExact(exactRequest)).rejects.toBeInstanceOf(UnknownExactProductError);
    expect(priceCalls).toBe(0);
  });

  it("collapses catalog storage errors before reading price evidence", async () => {
    let priceCalls = 0;
    const catalog: ActiveCatalogReader = {
      getMany: async () => { throw new Error("private database detail"); },
    };

    await expect(new PlanService({
      catalog,
      now: () => NOW,
      priceService: {
        readExact: async () => {
          priceCalls += 1;
          throw new Error("must not be called");
        },
      },
    }).calculateExact(exactRequest)).rejects.toBeInstanceOf(CatalogUnavailableError);
    expect(priceCalls).toBe(0);
  });

  it("rejects catalog rows carrying undeclared private metadata before price planning", async () => {
    let priceCalls = 0;
    const privateCatalogRow = {
      ...canonicalSummary,
      catalogEvidence: {
        ...canonicalSummary.catalogEvidence,
        privateReferenceKey: "must-not-leak",
      },
    } as unknown as ExactProductPlanApiProductSummary;

    await expect(new PlanService({
      catalog: catalogReader([privateCatalogRow]),
      now: () => NOW,
      priceService: {
        readExact: async () => {
          priceCalls += 1;
          throw new Error("must not be called");
        },
      },
    }).calculateExact(exactRequest)).rejects.toBeInstanceOf(CatalogUnavailableError);
    expect(priceCalls).toBe(0);
  });

  it("rejects stale or future catalog provenance before price planning", async () => {
    for (const observedAt of [
      "2026-07-13T11:59:59.999Z",
      "2026-07-15T12:00:00.001Z",
    ]) {
      const invalid = {
        ...canonicalSummary,
        catalogEvidence: { ...canonicalSummary.catalogEvidence, observedAt },
      } satisfies ExactProductPlanApiProductSummary;
      await expect(new PlanService({
        catalog: catalogReader([invalid]),
        now: () => NOW,
      }).calculateExact(exactRequest)).rejects.toBeInstanceOf(CatalogUnavailableError);
    }
  });

  it("plans a mixed exact and confirmed reviewed-family basket from one server timestamp", async () => {
    const catalog = catalogReader([mixedExactSummary]);
    const inspectAt = vi.fn(async () => inspection);
    const readProducts = vi.fn(async () => mixedPriceResult());
    const signal = new AbortController().signal;
    const service = new PlanService({
      catalog,
      familyCandidateService: { inspectAt },
      now: () => NOW,
      priceService: { readExact: vi.fn(), readProducts },
    });

    const result = await service.calculateReviewed(mixedRequest, signal);

    expect(inspectAt).toHaveBeenCalledOnce();
    expect(inspectAt).toHaveBeenCalledWith({
      contractVersion: 2,
      families: [{ allowedBrands: ["tine"], familyId: "family:melk" }],
    }, NOW, signal);
    expect(catalog.calls).toEqual([{ at: NOW, gtins: [GTIN], signal }]);
    expect(readProducts).toHaveBeenCalledOnce();
    expect(readProducts).toHaveBeenCalledWith([GTIN, GTIN_ALIAS], NOW, signal);
    expect(result.needMatches).toEqual([
      {
        candidateProductIds: ["product:coffee"],
        kind: "exact-product",
        needId: "need:coffee",
      },
      expect.objectContaining({
        candidateProductIds: ["product:milk"],
        candidateSetId: CANDIDATE_SET_ID,
        familyId: "family:melk",
        kind: "reviewed-family",
        needId: "need:milk",
      }),
    ]);
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]).toMatchObject({
      chains: ["extra"],
      substitutions: ["need:milk"],
      totalOre: 7_500,
    });
    expect(result.evidence.candidateCoverage).toHaveLength(2);
    expect(result.evidence.memberships).toEqual([membership]);
    expect(result.evidence.assignmentEvidence).toHaveLength(2);
    expect(result.evidence.sources.map(({ id }) => id)).toEqual([
      "catalog-source",
      "price-source",
    ]);
    expect(reviewedFamilyPlanApiResponseV2SchemaFor(mixedRequest).safeParse({
      ...result,
      caveats: [],
      contractVersion: 2,
    }).success).toBe(true);
  });

  it("inspects repeated identical family selections once and preserves every need", async () => {
    const repeated: ReviewedFamilyPlanApiRequestV2 = {
      ...mixedRequest,
      needs: [
        mixedRequest.needs[1]!,
        { ...mixedRequest.needs[1]!, id: "need:milk:second" },
      ],
    };
    const inspectAt = vi.fn(async () => inspection);
    const readProducts = vi.fn(async () => {
      const result = mixedPriceResult();
      return {
        ...result,
        productEvidence: [result.productEvidence[1]!],
        prices: [result.prices[1]!],
        products: [result.products[1]!],
      };
    });
    const result = await new PlanService({
      familyCandidateService: { inspectAt },
      now: () => NOW,
      priceService: { readExact: vi.fn(), readProducts },
    }).calculateReviewed(repeated);

    expect(inspectAt).toHaveBeenCalledOnce();
    expect(result.needMatches.map(({ needId }) => needId)).toEqual([
      "need:milk",
      "need:milk:second",
    ]);
    expect(result.plans[0]?.assignments).toHaveLength(2);
  });

  it("rejects conflicting repeated family selections before evidence reads", async () => {
    const inspectAt = vi.fn();
    const readProducts = vi.fn();
    const conflicting = {
      ...mixedRequest,
      needs: [
        mixedRequest.needs[1]!,
        {
          ...mixedRequest.needs[1]!,
          id: "need:milk:conflict",
          match: {
            ...mixedRequest.needs[1]!.match,
            allowedBrands: ["q-meieriene"],
            confirmation: {
              candidateSetId: `candidate-set:${"b".repeat(64)}`,
              taxonomyVersionId: taxonomy.versionId,
              userApproved: true,
            },
          },
        },
      ],
    } as ReviewedFamilyPlanApiRequestV2;

    await expect(new PlanService({
      familyCandidateService: { inspectAt },
      now: () => NOW,
      priceService: { readExact: vi.fn(), readProducts },
    }).calculateReviewed(conflicting)).rejects.toEqual(
      new ReviewedFamilyPlanError("AMBIGUOUS_FAMILY_SELECTION"),
    );
    expect(inspectAt).not.toHaveBeenCalled();
    expect(readProducts).not.toHaveBeenCalled();
  });

  it("rejects stale candidate confirmation before catalog or price reads", async () => {
    const staleInspection = {
      ...inspection,
      candidateSets: [{
        ...inspection.candidateSets[0]!,
        candidateSetId: `candidate-set:${"b".repeat(64)}`,
      }],
    };
    const catalog = catalogReader([mixedExactSummary]);
    const readProducts = vi.fn();

    await expect(new PlanService({
      catalog,
      familyCandidateService: { inspectAt: async () => staleInspection },
      now: () => NOW,
      priceService: { readExact: vi.fn(), readProducts },
    }).calculateReviewed(mixedRequest)).rejects.toEqual(
      new ReviewedFamilyPlanError("CANDIDATE_CONFIRMATION_STALE"),
    );
    expect(catalog.calls).toEqual([]);
    expect(readProducts).not.toHaveBeenCalled();
  });

  it("fails closed on GTIN aliases resolving to one canonical product", async () => {
    const aliased = mixedPriceResult();
    aliased.products = aliased.products.map((identity) => ({
      ...identity,
      canonicalProductId: "product:milk",
    }));
    aliased.productEvidence = aliased.productEvidence.map((entry) => ({
      ...entry,
      canonicalProductId: "product:milk",
    }));

    await expect(new PlanService({
      catalog: catalogReader([mixedExactSummary]),
      familyCandidateService: { inspectAt: async () => inspection },
      now: () => NOW,
      priceService: { readExact: vi.fn(), readProducts: async () => aliased },
    }).calculateReviewed(mixedRequest)).rejects.toEqual(
      new ReviewedFamilyPlanError("AMBIGUOUS_FAMILY_SELECTION"),
    );
  });
});
