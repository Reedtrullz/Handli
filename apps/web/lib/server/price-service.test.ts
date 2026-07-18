import type {
  PlanningEvidenceReader,
  PlanningEvidenceSnapshot,
} from "@handleplan/db/planning-evidence-reader";
import type {
  PublicOfficialOfferReader,
  PublicOfficialOfferSnapshot,
} from "@handleplan/db/public-official-offer-reader";
import { EmptyPublicOfficialOfferReader } from "@handleplan/db/public-official-offer-reader";
import {
  exactProductPlanApiEvidenceEnvelopeSchema,
  type ExactProductPlanApiRequest,
  type MoneyOre,
  type OfficialOffer,
  type PriceEvidence,
} from "@handleplan/domain";
import { describe, expect, it, vi } from "vitest";

import { PriceService, PriceServiceError } from "./price-service";

const NOW = new Date("2026-07-16T12:00:00.000Z");
const GTIN = "7038010000010";
const GTIN_ALIAS = "7038010000027";
const MARKET_CONTEXT = {
  contractVersion: 1,
  countryCode: "NO",
  kind: "national",
} as const;
const REQUEST: ExactProductPlanApiRequest = {
  contractVersion: 1,
  enabledMembershipProgramIds: [],
  marketContext: MARKET_CONTEXT,
  maxStores: 3,
  needs: [{
    id: "need:milk",
    match: {
      kind: "exact-product",
      product: { kind: "gtin", value: GTIN },
      userApproved: true,
    },
    quantity: 2,
    quantityUnit: "package",
    required: true,
  }],
};

function evidence(
  id: string,
  chainId: "bunnpris" | "extra" | "rema-1000",
  observedAt: string,
  amountOre: number,
  sourceId = "licensed-price",
): PriceEvidence {
  return {
    amountOre: amountOre as PriceEvidence["amountOre"],
    chainId,
    contractVersion: 1,
    evidenceLevel: "observed",
    geographicScope: { countryCode: "NO", kind: "national" },
    id,
    kind: "price-evidence",
    observedAt,
    priceKind: "ordinary",
    productMatch: { canonicalProductId: "product:42", kind: "exact" },
    sourceId,
    sourceRecordId: `record:${id}`,
  };
}

function snapshot(): PlanningEvidenceSnapshot {
  const history = Array.from({ length: 7 }, (_, index) => evidence(
    `price:history:${index + 1}`,
    "extra",
    `2026-07-${String(15 - index).padStart(2, "0")}T10:00:00.000Z`,
    3_000,
  ));
  return {
    coverageChecks: [{
      canonicalProductId: "product:42",
      chainId: "bunnpris",
      checkedAt: "2026-07-16T11:30:00.000Z",
      contractVersion: 1,
      geographicScope: { countryCode: "NO", kind: "national" },
      id: "coverage:bunnpris",
      sourceId: "coverage-feed",
      state: "known-not-carried",
    }],
    historicalEligibleEvidenceIds: history.map(({ id }) => id),
    priceEvidence: [
      evidence("price:current", "extra", "2026-07-16T11:00:00.000Z", 2_490),
      evidence("price:older-current", "extra", "2026-07-16T10:00:00.000Z", 4_000),
      ...history,
      evidence("price:stale", "bunnpris", "2026-07-12T11:59:59.999Z", 1_000),
    ],
    products: [{ canonicalProductId: "product:42", gtin: GTIN }],
    sources: [
      {
        contractVersion: 1,
        displayName: "Coverage feed",
        id: "coverage-feed",
        sourceClass: "ordinary-price",
        state: "approved",
      },
      {
        contractVersion: 1,
        displayName: "Licensed price",
        id: "licensed-price",
        sourceClass: "ordinary-price",
        state: "approved",
      },
      {
        contractVersion: 1,
        displayName: "Unused approved source",
        id: "unused-source",
        sourceClass: "ordinary-price",
        state: "approved",
      },
    ],
  };
}

function readerWith(value: PlanningEvidenceSnapshot): PlanningEvidenceReader & {
  getMany: ReturnType<typeof vi.fn<PlanningEvidenceReader["getMany"]>>;
} {
  return {
    getMany: vi.fn(async () => value),
  };
}

function officialOffer(overrides: Partial<OfficialOffer> = {}): OfficialOffer {
  return {
    applicability: {
      channels: ["in-store"],
      contractVersion: 1,
      endsAt: "2026-07-20T00:00:00.000Z",
      geographicScope: { countryCode: "NO", kind: "national" },
      startsAt: "2026-07-16T00:00:00.000Z",
    },
    beforePriceOre: 3_000 as MoneyOre,
    capturedAt: "2026-07-16T10:00:00.000Z",
    chainId: "extra",
    conditions: [{ kind: "public" }],
    contractVersion: 1,
    evidenceLevel: "reviewed",
    id: "official-offer:7",
    kind: "official-offer",
    pricing: { kind: "unit", unitPriceOre: 2_000 as MoneyOre },
    productMatch: { canonicalProductId: "product:42", kind: "exact" },
    sourceId: "extra-offers",
    sourceRecordId: `official-source-record:${"a".repeat(64)}`,
    ...overrides,
  };
}

function officialSnapshot(
  offers: OfficialOffer[] = [officialOffer()],
): PublicOfficialOfferSnapshot {
  return {
    offers,
    sources: offers.length === 0 ? [] : [{
      contractVersion: 1,
      displayName: "Reviewed weekly offers",
      id: "extra-offers",
      sourceClass: "offer",
      state: "approved",
    }],
  };
}

function officialReaderWith(value: PublicOfficialOfferSnapshot): PublicOfficialOfferReader & {
  getMany: ReturnType<typeof vi.fn<PublicOfficialOfferReader["getMany"]>>;
} {
  return { getMany: vi.fn(async () => value) };
}

function priceService(
  dependencies: Omit<ConstructorParameters<typeof PriceService>[0], "officialOfferReader">
    & { officialOfferReader?: PublicOfficialOfferReader },
): PriceService {
  return new PriceService({
    officialOfferReader: new EmptyPublicOfficialOfferReader(),
    ...dependencies,
  });
}

describe("PriceService", () => {
  it("reads one canonical product union for flexible server planning", async () => {
    const second = snapshot();
    second.products = [
      { canonicalProductId: "product:42", gtin: GTIN },
      { canonicalProductId: "product:42", gtin: GTIN_ALIAS },
    ];
    const reader = readerWith(second);
    const result = await priceService({ reader }).readProducts(
      [GTIN_ALIAS, GTIN],
      MARKET_CONTEXT,
      NOW,
    );

    expect(reader.getMany).toHaveBeenCalledTimes(1);
    expect(reader.getMany).toHaveBeenCalledWith([GTIN, GTIN_ALIAS], NOW, undefined);
    expect(result.productEvidence.map(({ gtin }) => gtin)).toEqual([GTIN, GTIN_ALIAS]);
    expect(result.productEvidence.every(({ canonicalProductId }) =>
      canonicalProductId === "product:42")).toBe(true);
    expect(result.productEvidence[0]).toMatchObject({
      comparisonScope: { completeness: "partial" },
      officialOffers: [],
      ordinaryPrices: [{ id: "price:current" }],
    });
    expect(result.prices.map(({ ean }) => ean)).toEqual([GTIN, GTIN_ALIAS]);
  });

  it("attaches current official offers and exact-merges their approved source metadata", async () => {
    const officialOfferReader = officialReaderWith(officialSnapshot());
    const result = await priceService({
      officialOfferReader,
      reader: readerWith(snapshot()),
    }).readExact(REQUEST, NOW);

    expect(officialOfferReader.getMany).toHaveBeenCalledWith(["product:42"], NOW, undefined);
    expect(result.evidence.needs[0]!.officialOffers).toEqual([
      expect.objectContaining({
        id: "official-offer:7",
        pricing: { kind: "unit", unitPriceOre: 2_000 },
        sourceId: "extra-offers",
      }),
    ]);
    expect(result.evidence.sources).toEqual(expect.arrayContaining([
      {
        contractVersion: 1,
        displayName: "Reviewed weekly offers",
        id: "extra-offers",
        sourceClass: "offer",
        state: "approved",
      },
    ]));
  });

  it("shadows cheaper national offers with an applicable regional edition before planning or discovery", async () => {
    const national = officialOffer({
      applicability: {
        ...officialOffer().applicability,
        geographicScope: { countryCode: "NO", kind: "national" },
      },
      id: "official-offer:00-cheap-national",
      pricing: { kind: "unit", unitPriceOre: 1_000 as MoneyOre },
    });
    const oslo = officialOffer({
      applicability: {
        ...officialOffer().applicability,
        geographicScope: {
          countryCode: "NO",
          kind: "regions",
          regionCodes: ["no-0301-oslo"],
        },
      },
      id: "official-offer:99-expensive-oslo",
      pricing: { kind: "unit", unitPriceOre: 2_500 as MoneyOre },
    });
    const bergen = officialOffer({
      applicability: {
        ...officialOffer().applicability,
        geographicScope: {
          countryCode: "NO",
          kind: "regions",
          regionCodes: ["no-4601-bergen"],
        },
      },
      id: "official-offer:01-cheap-bergen",
      pricing: { kind: "unit", unitPriceOre: 1_100 as MoneyOre },
    });
    const osloMarket = {
      contractVersion: 1 as const,
      countryCode: "NO" as const,
      kind: "launch-region" as const,
      regionId: "no-0301-oslo",
    };

    const result = await priceService({
      officialOfferReader: officialReaderWith(officialSnapshot([
        national,
        bergen,
        oslo,
      ])),
      reader: readerWith(snapshot()),
    }).readExact({ ...REQUEST, marketContext: osloMarket }, NOW);

    expect(result.evidence.needs[0]?.officialOffers.map(({ id }) => id)).toEqual([
      oslo.id,
    ]);
    expect(result.evidence.sources.map(({ id }) => id)).toContain("extra-offers");
  });

  it("keeps explicit member conditions visible while filtering stale, wrong-channel and wrong-region offers", async () => {
    const member = officialOffer({
      conditions: [{ kind: "member", programId: "extra-medlem" }],
      id: "official-offer:member",
    });
    const stale = officialOffer({
      capturedAt: "2026-07-02T11:59:59.999Z",
      id: "official-offer:stale",
    });
    const online = officialOffer({
      applicability: { ...officialOffer().applicability, channels: ["online"] },
      id: "official-offer:online",
    });
    const wrongRegion = officialOffer({
      applicability: {
        ...officialOffer().applicability,
        geographicScope: {
          countryCode: "NO",
          kind: "regions",
          regionCodes: ["no-11-rogaland"],
        },
      },
      id: "official-offer:wrong-region",
    });
    const result = await priceService({
      officialOfferReader: officialReaderWith(officialSnapshot([
        member,
        stale,
        online,
        wrongRegion,
      ])),
      reader: readerWith(snapshot()),
    }).readExact(REQUEST, NOW);

    expect(result.evidence.needs[0]!.officialOffers).toEqual([member]);
    expect(result.evidence.sources.map(({ id }) => id)).toContain("extra-offers");
  });

  it("fails closed on unrequested offer products, source conflicts and offer overflows", async () => {
    const cases: PublicOfficialOfferSnapshot[] = [
      officialSnapshot([officialOffer({
        productMatch: { canonicalProductId: "product:43", kind: "exact" },
      })]),
      {
        ...officialSnapshot(),
        sources: [{
          contractVersion: 1,
          displayName: "Conflicting ordinary source identity",
          id: "licensed-price",
          sourceClass: "offer",
          state: "approved",
        }],
        offers: [officialOffer({ sourceId: "licensed-price" })],
      },
      officialSnapshot(Array.from({ length: 51 }, (_, index) => officialOffer({
        id: `official-offer:${index + 1}`,
      }))),
    ];

    for (const value of cases) {
      await expect(priceService({
        officialOfferReader: officialReaderWith(value),
        reader: readerWith(snapshot()),
      }).readExact(REQUEST, NOW)).rejects.toEqual(expect.objectContaining({
        code: "UNAVAILABLE",
        name: "PriceServiceError",
      }));
    }
  });

  it("separates one selected current price per chain from its traceable historical baseline", async () => {
    const reader = readerWith(snapshot());
    const signal = new AbortController().signal;
    const result = await priceService({ reader }).readExact(REQUEST, NOW, signal);

    expect(reader.getMany).toHaveBeenCalledWith([GTIN], NOW, signal);
    expect(result.prices).toEqual([{
      amountOre: 2_490,
      chain: "extra",
      ean: GTIN,
      observedAt: "2026-07-16T11:00:00.000Z",
      source: "licensed-price",
    }]);
    const need = result.evidence.needs[0]!;
    expect(need.ordinaryPrices.map(({ id }) => id)).toEqual(["price:current"]);
    expect(need.historicalComparisons).toHaveLength(1);
    expect(need.historicalComparisons[0]).toMatchObject({
      currentEvidenceId: "price:current",
      baselineOre: 3_000,
      currentOre: 2_490,
      chainId: "extra",
    });
    expect(need.historicalPriceEvidence.map(({ id }) => id)).toEqual(
      need.historicalComparisons[0]!.sourceEvidenceIds,
    );
    expect(need.historicalPriceEvidence.map(({ id }) => id)).not.toContain("price:current");
    expect(need.comparisonScope).toMatchObject({
      completeness: "partial",
      entries: [
        { chainId: "bunnpris", status: { kind: "known-not-carried" } },
        { chainId: "extra", status: { kind: "priced", evidenceId: "price:current" } },
        { chainId: "rema-1000", status: { kind: "unknown", reason: "not-checked" } },
      ],
    });
  });

  it("selects the matching regional price while the national market keeps national evidence", async () => {
    const persisted = snapshot();
    persisted.priceEvidence.push(
      {
        ...evidence("price:oslo", "extra", "2026-07-16T10:00:00.000Z", 2_190),
        geographicScope: {
          countryCode: "NO" as const,
          kind: "regions",
          regionCodes: ["no-0301-oslo"],
        },
      },
      {
        ...evidence("price:bergen", "extra", "2026-07-16T11:30:00.000Z", 1_990),
        geographicScope: {
          countryCode: "NO",
          kind: "regions",
          regionCodes: ["no-4601-bergen"],
        },
      },
      {
        ...evidence("price:one-store", "extra", "2026-07-16T11:45:00.000Z", 1_490),
        geographicScope: { kind: "stores", storeIds: ["store:extra:oslo-1"] },
      },
    );
    const osloMarket = {
      contractVersion: 1 as const,
      countryCode: "NO" as const,
      kind: "launch-region" as const,
      regionId: "no-0301-oslo",
    };
    const regional = await priceService({ reader: readerWith(persisted) }).readExact({
      ...REQUEST,
      marketContext: osloMarket,
    }, NOW);
    const national = await priceService({ reader: readerWith(persisted) })
      .readExact(REQUEST, NOW);

    expect(regional.evidence.needs[0]?.ordinaryPrices.map(({ id }) => id))
      .toEqual(["price:oslo"]);
    expect(regional.evidence.needs[0]?.comparisonScope.entries.find(
      ({ chainId }) => chainId === "extra",
    )?.status).toEqual({ evidenceId: "price:oslo", kind: "priced" });
    expect(national.evidence.needs[0]?.ordinaryPrices.map(({ id }) => id))
      .toEqual(["price:current"]);
  });

  it("admits a postal-set price for a launch region only with current directory evidence", async () => {
    const persisted = snapshot();
    persisted.priceEvidence.push({
      ...evidence("price:postal-oslo", "extra", "2026-07-16T10:00:00.000Z", 2_090),
      geographicScope: {
        countryCode: "NO",
        kind: "postal-set",
        postalCodes: ["0152", "0452"],
      },
    });
    const osloMarket = {
      contractVersion: 1 as const,
      countryCode: "NO" as const,
      kind: "launch-region" as const,
      regionId: "no-0301-oslo",
    };
    const geographicDirectoryReader = {
      read: vi.fn(async () => ({
        state: "available" as const,
        evaluatedAt: NOW.toISOString(),
        directory: {
          contractVersion: 1 as const,
          countryCode: "NO",
          directoryVersionId: "postal-directory-2026-07",
          evidenceReference: "manifest:directory",
          publishedAt: "2026-07-16T09:30:00.000Z",
          regions: [{
            coverageState: "complete" as const,
            evidenceReference: "manifest:oslo",
            postalCodes: ["0152", "0452"],
            regionCode: "no-0301-oslo",
          }],
          reviewedAt: "2026-07-16T09:00:00.000Z",
          status: "approved" as const,
          validFrom: "2026-07-16T09:30:00.000Z",
        },
      })),
    };

    const withDirectory = await priceService({
      geographicDirectoryReader,
      reader: readerWith(persisted),
    }).readExact({ ...REQUEST, marketContext: osloMarket }, NOW);
    const withoutDirectory = await priceService({ reader: readerWith(persisted) })
      .readExact({ ...REQUEST, marketContext: osloMarket }, NOW);

    expect(withDirectory.evidence.needs[0]?.ordinaryPrices.map(({ id }) => id))
      .toEqual(["price:postal-oslo"]);
    expect(withoutDirectory.evidence.needs[0]?.ordinaryPrices.map(({ id }) => id))
      .not.toContain("price:postal-oslo");
    expect(geographicDirectoryReader.read).toHaveBeenCalledWith("NO", NOW, undefined);
  });

  it("declares every referenced evidence source exactly once and drops unused approvals", async () => {
    const result = await priceService({ reader: readerWith(snapshot()) })
      .readExact(REQUEST, NOW);
    const referencedSourceIds = new Set<string>();
    for (const need of result.evidence.needs) {
      need.ordinaryPrices.forEach(({ sourceId }) => referencedSourceIds.add(sourceId));
      need.historicalPriceEvidence.forEach(({ sourceId }) => referencedSourceIds.add(sourceId));
      need.excludedPriceEvidence.forEach(({ sourceId }) => referencedSourceIds.add(sourceId));
      need.officialOffers.forEach(({ sourceId }) => referencedSourceIds.add(sourceId));
      need.comparisonScope.entries.forEach(({ status }) => {
        if (status.kind === "known-not-carried") referencedSourceIds.add(status.sourceId);
      });
    }
    expect(result.evidence.sources.map(({ id }) => id)).toEqual(
      [...referencedSourceIds].sort(),
    );
    expect(result.evidence.sources.map(({ id }) => id)).toEqual([
      "coverage-feed",
      "licensed-price",
    ]);
    expect(
      exactProductPlanApiEvidenceEnvelopeSchema.safeParse(result.evidence).success,
    ).toBe(true);
  });

  it("returns explicit unknown coverage when approved persisted evidence is absent", async () => {
    const result = await priceService({
      reader: readerWith({
        coverageChecks: [],
        historicalEligibleEvidenceIds: [],
        priceEvidence: [],
        products: [{ canonicalProductId: "product:42", gtin: GTIN }],
        sources: [],
      }),
    }).readExact(REQUEST, NOW);

    expect(result.prices).toEqual([]);
    expect(result.evidence).toMatchObject({
      assignmentEvidence: [],
      sources: [],
      needs: [{
        needId: "need:milk",
        ordinaryPrices: [],
        historicalPriceEvidence: [],
        excludedPriceEvidence: [],
        officialOffers: [],
        historicalComparisons: [],
        comparisonScope: { completeness: "partial" },
      }],
    });
    expect(
      result.evidence.needs[0]!.comparisonScope.entries.every(
        ({ status }) => status.kind === "unknown",
      ),
    ).toBe(true);
  });

  it("plans distinct requested GTIN aliases that resolve to one canonical product", async () => {
    const aliasedRequest: ExactProductPlanApiRequest = {
      ...REQUEST,
      needs: [
        REQUEST.needs[0]!,
        {
          ...REQUEST.needs[0]!,
          id: "need:milk:alias",
          match: {
            ...REQUEST.needs[0]!.match,
            product: { kind: "gtin", value: GTIN_ALIAS },
          },
        },
      ],
    };
    const aliasedSnapshot = snapshot();
    aliasedSnapshot.products.push({
      canonicalProductId: "product:42",
      gtin: GTIN_ALIAS,
    });

    const result = await priceService({ reader: readerWith(aliasedSnapshot) })
      .readExact(aliasedRequest, NOW);

    expect(result.products).toEqual([
      { canonicalProductId: "product:42", gtin: GTIN },
      { canonicalProductId: "product:42", gtin: GTIN_ALIAS },
    ]);
    expect(result.prices.map(({ ean }) => ean)).toEqual([GTIN, GTIN_ALIAS]);
    expect(result.evidence.needs.map(({ needId }) => needId)).toEqual([
      "need:milk",
      "need:milk:alias",
    ]);
  });

  it("keeps stale evidence visible only as bounded excluded provenance", async () => {
    const stale = evidence(
      "price:stale-only",
      "bunnpris",
      "2026-07-12T11:59:59.999Z",
      1_000,
    );
    const result = await priceService({
      reader: readerWith({
        coverageChecks: [],
        historicalEligibleEvidenceIds: [],
        priceEvidence: [stale],
        products: [{ canonicalProductId: "product:42", gtin: GTIN }],
        sources: [{
          contractVersion: 1,
          displayName: "Licensed price",
          id: "licensed-price",
          sourceClass: "ordinary-price",
          state: "approved",
        }],
      }),
    }).readExact(REQUEST, NOW);

    expect(result.prices).toEqual([]);
    expect(result.evidence.needs[0]).toMatchObject({
      ordinaryPrices: [],
      historicalPriceEvidence: [],
      excludedPriceEvidence: [{ id: "price:stale-only", sourceId: "licensed-price" }],
      comparisonScope: {
        completeness: "partial",
      },
    });
    expect(
      result.evidence.needs[0]!.comparisonScope.entries.find(
        ({ chainId }) => chainId === "bunnpris",
      ),
    ).toMatchObject({
      chainId: "bunnpris",
      status: { kind: "stale", evidenceId: "price:stale-only" },
    });
    expect(result.evidence.sources.map(({ id }) => id)).toEqual(["licensed-price"]);
  });

  it("does not plan from conflicting prices observed at the same instant", async () => {
    const conflicting = snapshot();
    conflicting.priceEvidence.push(
      evidence("price:current:conflict", "extra", "2026-07-16T11:00:00.000Z", 2_590),
    );

    const result = await priceService({ reader: readerWith(conflicting) })
      .readExact(REQUEST, NOW);

    expect(result.prices).toEqual([]);
    expect(result.evidence.needs[0]).toMatchObject({
      ordinaryPrices: [],
      comparisonScope: { completeness: "partial" },
    });
    expect(result.evidence.needs[0]!.comparisonScope.entries.find(
      ({ chainId }) => chainId === "extra",
    )).toMatchObject({
      chainId: "extra",
      status: { kind: "ineligible", reason: "invalid-evidence" },
    });
  });

  it("never uses ordinary-only observations as a historical baseline", async () => {
    const ordinaryOnly = snapshot();
    ordinaryOnly.historicalEligibleEvidenceIds = [];

    const result = await priceService({ reader: readerWith(ordinaryOnly) })
      .readExact(REQUEST, NOW);

    expect(result.evidence.needs[0]).toMatchObject({
      historicalComparisons: [],
      historicalPriceEvidence: [],
      ordinaryPrices: [{ id: "price:current" }],
    });
  });

  it("fails closed for inconsistent product/source snapshots and preserves cancellation", async () => {
    const missingProduct = snapshot();
    missingProduct.products = [];
    await expect(priceService({ reader: readerWith(missingProduct) }).readExact(REQUEST, NOW))
      .rejects.toEqual(new PriceServiceError("UNAVAILABLE"));

    const missingSource = snapshot();
    missingSource.sources = missingSource.sources.filter(({ id }) => id !== "licensed-price");
    await expect(priceService({ reader: readerWith(missingSource) }).readExact(REQUEST, NOW))
      .rejects.toEqual(new PriceServiceError("UNAVAILABLE"));

    const unknownHistoricalIdentity = snapshot();
    unknownHistoricalIdentity.historicalEligibleEvidenceIds.push("price:missing");
    await expect(
      priceService({ reader: readerWith(unknownHistoricalIdentity) }).readExact(REQUEST, NOW),
    ).rejects.toEqual(new PriceServiceError("UNAVAILABLE"));

    const duplicateHistoricalIdentity = snapshot();
    duplicateHistoricalIdentity.historicalEligibleEvidenceIds.push(
      duplicateHistoricalIdentity.historicalEligibleEvidenceIds[0]!,
    );
    await expect(
      priceService({ reader: readerWith(duplicateHistoricalIdentity) }).readExact(REQUEST, NOW),
    ).rejects.toEqual(new PriceServiceError("UNAVAILABLE"));

    const controller = new AbortController();
    controller.abort();
    const reader: PlanningEvidenceReader = { getMany: vi.fn() };
    await expect(priceService({ reader }).readExact(REQUEST, NOW, controller.signal))
      .rejects.toEqual(new PriceServiceError("CANCELLED"));
    expect(reader.getMany).not.toHaveBeenCalled();
  });
});
