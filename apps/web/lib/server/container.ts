import "server-only";

import { PostgresActiveCatalogReader } from "@handleplan/db/catalog-reader";
import { createDatabase } from "@handleplan/db/client";
import {
  PostgresPublicCatalogIndexReader,
  PublicCatalogIndexReaderError,
  type PublicCatalogIndexReader,
} from "@handleplan/db/public-catalog-index-reader";
import {
  PostgresPlanningEvidenceReader,
  type PlanningEvidenceReader,
  type PlanningEvidenceSnapshot,
} from "@handleplan/db/planning-evidence-reader";
import {
  PostgresReviewedFamilyReader,
  ReviewedFamilyReaderError,
  type ReviewedFamilyCatalogMatch,
  type ReviewedFamilyReader,
  type ReviewedFamilySnapshot,
} from "@handleplan/db/reviewed-family-reader";
import type {
  ExactProductPlanApiProductSummary,
  PriceObservation,
  Product,
} from "@handleplan/domain";

import { readServerEnv, type ServerEnv } from "./env";
import { DiscoveryService, type DiscoveryServiceContract } from "./discovery-service";
import {
  FamilyCandidateService,
  type FamilyCandidateServiceContract,
} from "./family-candidate-service";
import {
  PlanService,
  type ActiveCatalogReader,
  type PlanServiceContract,
} from "./plan-service";
import { PriceService } from "./price-service";
import {
  BoundedDatabaseReadinessProbe,
  createPostgresMigrationCheck,
  type DatabaseReadinessProbe,
  REQUIRED_DATABASE_MIGRATION,
} from "./readiness";

export interface ServerContainer {
  discoveryService: DiscoveryServiceContract;
  familyCandidateService: FamilyCandidateServiceContract;
  planService: PlanServiceContract;
  publicCatalogIndex: PublicCatalogIndexReader;
  readinessProbe: DatabaseReadinessProbe;
}

let singleton: ServerContainer | undefined;

export const FAKE_EVALUATION_TIME = "2026-07-15T12:00:00.000Z";
const FRESH_OBSERVED_AT = "2026-07-15T10:00:00.000Z";
const STALE_OBSERVED_AT = "2026-07-12T11:59:59.999Z";

const fakeProducts = [
  { ean: "7038010000010", name: "TINE Lettmelk 1 % 1 l", brand: "TINE", packageQuantity: 1000, packageUnit: "ml", productFamily: "lettmelk" },
  { ean: "7038010000027", name: "Evergood Kaffe 500 g", brand: "Evergood", packageQuantity: 500, packageUnit: "g", productFamily: "kaffe" },
  { ean: "7038010000034", name: "Norsk grovbrød 750 g", brand: "Bakehuset", packageQuantity: 750, packageUnit: "g", productFamily: "brød" },
  { ean: "7038010000041", name: "Stale testvare 1 stk", brand: "Test", packageQuantity: 1, packageUnit: "each", productFamily: "stale" },
] satisfies Product[];

function fakePrice(ean: string, chain: PriceObservation["chain"], amountOre: number, observedAt = FRESH_OBSERVED_AT): PriceObservation {
  return { ean, chain, amountOre: amountOre as PriceObservation["amountOre"], observedAt, source: "kassalapp" };
}

const fakePrices: PriceObservation[] = [
  fakePrice("7038010000010", "bunnpris", 2000),
  fakePrice("7038010000010", "rema-1000", 2500),
  fakePrice("7038010000010", "extra", 2600),
  fakePrice("7038010000027", "bunnpris", 5500),
  fakePrice("7038010000027", "rema-1000", 6000),
  fakePrice("7038010000027", "extra", 4000),
  fakePrice("7038010000034", "bunnpris", 3500),
  fakePrice("7038010000034", "rema-1000", 2000),
  fakePrice("7038010000034", "extra", 3200),
  fakePrice("7038010000041", "extra", 100, STALE_OBSERVED_AT),
];

const fakeCatalogProducts: ExactProductPlanApiProductSummary[] = fakeProducts.map((product, index) => ({
  ...(product.brand === undefined ? {} : { brand: product.brand }),
  catalogEvidence: {
    observedAt: FRESH_OBSERVED_AT,
    source: {
      contractVersion: 1,
      displayName: "Deterministic fake catalog fixture",
      id: "fixture-catalog-source",
      sourceClass: "catalog",
      state: "approved",
    },
    sourceRecordId: `source-record:${(index + 1).toString(16).padStart(64, "0")}`,
  },
  displayName: product.name,
  gtin: product.ean,
  packageMeasure: {
    amount: product.packageQuantity ?? 1,
    unit: product.packageUnit === "each" ? "piece" : product.packageUnit ?? "package",
  },
  unitsPerPack: 1,
}));

const fakeReviewedCatalogProducts = fakeCatalogProducts.slice(0, 3).map((product) => ({
  ...product,
  catalogEvidence: {
    ...product.catalogEvidence,
    source: {
      contractVersion: 1 as const,
      displayName: "Deterministic fake catalog fixture",
      id: "fixture-catalog-source",
      sourceClass: "catalog" as const,
      state: "approved" as const,
    },
  },
}));

const fakeReviewedTaxonomy = {
  contentSha256: "1d917ee4268615ad510a622ea30d69977191cffc143313a7dbecbad37debf520",
  contractVersion: 1 as const,
  publishedAt: "2026-07-15T00:00:00.000Z",
  taxonomyId: "handleplan-reviewed-families" as const,
  taxonomyVersion: "1.0.0",
  versionId: "handleplan-reviewed-families@1.0.0",
};

const fakeReviewedFamilies = [
  {
    aliases: ["mjølk"],
    id: "family:melk",
    labelNo: "Melk",
    product: fakeReviewedCatalogProducts[0]!,
    slug: "melk",
  },
  {
    aliases: [],
    id: "family:kaffe",
    labelNo: "Kaffe",
    product: fakeReviewedCatalogProducts[1]!,
    slug: "kaffe",
  },
  {
    aliases: ["brød"],
    id: "family:brod",
    labelNo: "Brød",
    product: fakeReviewedCatalogProducts[2]!,
    slug: "brod",
  },
] as const;

class InMemoryReviewedFamilyReader implements ReviewedFamilyReader {
  private readonly snapshots = new Map<string, Extract<ReviewedFamilySnapshot, { state: "active" }>>(
    fakeReviewedFamilies.map((entry, index) => {
      const family = {
        aliases: [...entry.aliases],
        id: entry.id,
        labelNo: entry.labelNo,
        slug: entry.slug,
        status: "active" as const,
      };
      const match: ReviewedFamilyCatalogMatch = {
        canonicalProductId: `product:${entry.product.gtin}`,
        family,
        membership: {
          confidence: 100,
          decision: "approved",
          decisionId: `family-membership:${index + 1}`,
          method: "deterministic-rule",
          reviewedAt: "2026-07-15T09:00:00.000Z",
          ruleVersion: "fake-reviewed-family@1",
        },
        product: entry.product,
        taxonomy: fakeReviewedTaxonomy,
      };
      return [entry.id, {
        complete: true,
        family,
        familyId: entry.id,
        matches: [match],
        state: "active",
        taxonomy: fakeReviewedTaxonomy,
      }];
    }),
  );

  async getSnapshots(
    familyIds: readonly string[],
    productsPerFamily: number,
    _at: Date,
    signal?: AbortSignal,
  ): Promise<ReviewedFamilySnapshot[]> {
    if (signal?.aborted) throw new ReviewedFamilyReaderError("CANCELLED");
    return familyIds.map((familyId) => {
      const snapshot = this.snapshots.get(familyId);
      if (snapshot === undefined) {
        return { complete: false, familyId, matches: [], state: "unknown" as const };
      }
      return {
        ...snapshot,
        family: { ...snapshot.family, aliases: [...snapshot.family.aliases] },
        matches: snapshot.matches.slice(0, productsPerFamily).map((candidate) => ({
          ...candidate,
          family: { ...candidate.family, aliases: [...candidate.family.aliases] },
          product: { ...candidate.product },
        })),
      };
    });
  }

  async getMany(
    familyIds: readonly string[],
    productsPerFamily: number,
    at: Date,
    signal?: AbortSignal,
  ): Promise<ReviewedFamilyCatalogMatch[]> {
    return (await this.getSnapshots(familyIds, productsPerFamily, at, signal))
      .flatMap((snapshot) => snapshot.state === "active" ? snapshot.matches : []);
  }
}

class InMemoryPublicCatalogIndexReader implements ActiveCatalogReader, PublicCatalogIndexReader {
  private readonly byGtin = new Map(
    fakeCatalogProducts.map((product) => [product.gtin, Object.freeze({ ...product })]),
  );

  async browse(
    limit: number,
    _at: Date,
    signal?: AbortSignal,
  ): Promise<ExactProductPlanApiProductSummary[]> {
    if (signal?.aborted) throw new PublicCatalogIndexReaderError("CANCELLED");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 36) {
      throw new PublicCatalogIndexReaderError("INVALID_REQUEST");
    }
    return [...this.byGtin.values()]
      .map((product) => ({ ...product }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName, "nb-NO")
        || left.gtin.localeCompare(right.gtin))
      .slice(0, limit);
  }

  async search(
    query: string,
    limit: number,
    _at: Date,
    signal?: AbortSignal,
  ): Promise<ExactProductPlanApiProductSummary[]> {
    if (signal?.aborted) throw new PublicCatalogIndexReaderError("CANCELLED");
    const normalized = query.trim().toLocaleLowerCase("nb-NO");
    if (
      normalized.length < 2
      || normalized.length > 120
      || !Number.isSafeInteger(limit)
      || limit < 1
      || limit > 20
    ) {
      throw new PublicCatalogIndexReaderError("INVALID_REQUEST");
    }
    return [...this.byGtin.values()]
      .filter((product) => product.gtin === query.trim()
        || product.displayName.toLocaleLowerCase("nb-NO").includes(normalized)
        || product.brand?.toLocaleLowerCase("nb-NO").includes(normalized) === true)
      .map((product) => ({ ...product }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName, "nb-NO")
        || left.gtin.localeCompare(right.gtin))
      .slice(0, limit);
  }

  async getMany(
    gtins: readonly string[],
    _at: Date,
    signal?: AbortSignal,
  ): Promise<ExactProductPlanApiProductSummary[]> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return gtins
      .map((gtin) => this.byGtin.get(gtin))
      .filter((product): product is ExactProductPlanApiProductSummary => product !== undefined)
      .map((product) => ({ ...product }))
      .sort((left, right) => left.gtin.localeCompare(right.gtin));
  }
}

class InMemoryPlanningEvidenceReader implements PlanningEvidenceReader {
  async getMany(
    gtins: readonly string[],
    at: Date,
    signal?: AbortSignal,
  ): Promise<PlanningEvidenceSnapshot> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const requested = new Set(gtins);
    const rows = fakePrices.filter(({ ean, observedAt }) =>
      requested.has(ean) && Date.parse(observedAt) <= at.getTime());
    return {
      coverageChecks: [],
      historicalEligibleEvidenceIds: [],
      priceEvidence: rows.map((row) => ({
        amountOre: row.amountOre,
        chainId: row.chain,
        contractVersion: 1,
        evidenceLevel: "observed",
        geographicScope: { countryCode: "NO", kind: "national" },
        id: `fixture-price:${row.ean}:${row.chain}:${row.observedAt}`,
        kind: "price-evidence",
        observedAt: row.observedAt,
        priceKind: "ordinary",
        productMatch: {
          canonicalProductId: `product:${row.ean}`,
          kind: "exact",
        },
        sourceId: "fixture-price-source",
        sourceRecordId: `fixture-record:${row.ean}:${row.chain}:${row.observedAt}`,
      })),
      products: gtins.map((gtin) => ({
        canonicalProductId: `product:${gtin}`,
        gtin,
      })),
      sources: rows.length === 0 ? [] : [{
        contractVersion: 1,
        displayName: "Deterministic fake price fixture",
        id: "fixture-price-source",
        sourceClass: "ordinary-price",
        state: "approved",
      }],
    };
  }
}

export function createServerContainer(env: ServerEnv): ServerContainer {
  if (env.mode === "fake") {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Fake server composition is disabled in production");
    }
    const catalog = new InMemoryPublicCatalogIndexReader();
    const priceService = new PriceService({ reader: new InMemoryPlanningEvidenceReader() });
    const familyCandidateService = new FamilyCandidateService({
      now: () => new Date(FAKE_EVALUATION_TIME),
      reader: new InMemoryReviewedFamilyReader(),
    });
    return {
      discoveryService: new DiscoveryService({
        catalog,
        now: () => new Date(FAKE_EVALUATION_TIME),
        priceService,
      }),
      familyCandidateService,
      planService: new PlanService({
        catalog,
        familyCandidateService,
        now: () => new Date(FAKE_EVALUATION_TIME),
        priceService,
      }),
      publicCatalogIndex: catalog,
      readinessProbe: new BoundedDatabaseReadinessProbe({
        checkMigration: async () => true,
        requiredMigration: REQUIRED_DATABASE_MIGRATION,
        timeoutMs: 1_500,
      }),
    };
  }

  const connection = createDatabase(env.DATABASE_URL);
  const publicCatalogIndex = new PostgresPublicCatalogIndexReader(connection.db);
  const priceService = new PriceService({
    reader: new PostgresPlanningEvidenceReader(connection.db),
  });
  const familyCandidateService = new FamilyCandidateService({
    reader: new PostgresReviewedFamilyReader(connection.db),
  });
  return {
    discoveryService: new DiscoveryService({ catalog: publicCatalogIndex, priceService }),
    familyCandidateService,
    planService: new PlanService({
      catalog: new PostgresActiveCatalogReader(connection.db),
      familyCandidateService,
      priceService,
    }),
    publicCatalogIndex,
    readinessProbe: new BoundedDatabaseReadinessProbe({
      checkMigration: createPostgresMigrationCheck(connection.db),
      requiredMigration: REQUIRED_DATABASE_MIGRATION,
      timeoutMs: 1_500,
    }),
  };
}

export function getServerContainer(): ServerContainer {
  if (singleton !== undefined) return singleton;
  singleton = createServerContainer(readServerEnv());
  return singleton;
}
