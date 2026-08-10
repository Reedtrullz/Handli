import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  catalogCanonicalMutationDecision,
  canonicalGtin,
  claimEligibilityForRunType,
  physicalStoreReplacementCondition,
  physicalStoreBranchKey,
  hashSourceRecordOutcome,
  normalizePhysicalStoreIngestionOutcome,
  PostgresIngestionRepository,
  reconstructIngestionRunCounters,
  sourceProductReplacementCondition,
  validateCatalogCategoryPath,
  validateSourceRecordOutcome,
  type PhysicalStoreIngestionOutcome,
  type SourceRecordOutcomeInput,
} from "./ingestion";

const recordedAt = new Date("2026-07-16T12:00:00.000Z");

describe("ingestion persistence primitives", () => {
  it("allows only monotonic, currently approved corrections from the same matched source", () => {
    const canonical = {
      brand: "Old brand",
      displayName: "Old name",
      packageAmount: 1,
      packageUnit: "package" as const,
      status: "active" as const,
      unitsPerPack: 1,
      updatedAt: new Date("2026-07-15T12:00:00.000Z"),
    };
    const incoming = {
      brand: "Correct brand",
      displayName: "Correct name",
      packageAmount: 1_000,
      packageUnit: "g" as const,
      retrievedAt: new Date("2026-07-16T12:05:00.000Z"),
      sourceUpdatedAt: new Date("2026-07-16T12:00:00.000Z"),
      unitsPerPack: 1,
    };
    const trusted = {
      canonical,
      incoming,
      matchedSourceVersion: {
        sourceUpdatedAt: new Date("2026-07-15T12:00:00.000Z"),
      },
      sourceAccessApproved: true,
    };

    expect(catalogCanonicalMutationDecision(trusted)).toBe("correct");
    expect(catalogCanonicalMutationDecision({
      ...trusted,
      sourceAccessApproved: false,
    })).toBe("review");
    expect(catalogCanonicalMutationDecision({
      ...trusted,
      matchedSourceVersion: undefined,
    })).toBe("review");
    expect(catalogCanonicalMutationDecision({
      ...trusted,
      matchedSourceVersion: { sourceUpdatedAt: incoming.sourceUpdatedAt },
    })).toBe("review");
    expect(catalogCanonicalMutationDecision({
      ...trusted,
      incoming: { ...incoming, sourceUpdatedAt: undefined },
    })).toBe("review");
  });

  it("does not require mutation authority for identical fields and keeps retired changes in review", () => {
    const incoming = {
      displayName: "Exact milk",
      packageAmount: 1_000,
      packageUnit: "ml" as const,
      retrievedAt: new Date("2026-07-16T12:05:00.000Z"),
      sourceUpdatedAt: new Date("2026-07-16T12:00:00.000Z"),
      unitsPerPack: 1,
    };
    const canonical = {
      brand: null,
      displayName: "Exact milk",
      packageAmount: 1_000,
      packageUnit: "ml" as const,
      status: "active" as const,
      unitsPerPack: 1,
      updatedAt: new Date("2026-07-15T12:00:00.000Z"),
    };

    expect(catalogCanonicalMutationDecision({
      canonical,
      incoming,
      sourceAccessApproved: false,
    })).toBe("none");
    expect(catalogCanonicalMutationDecision({
      canonical,
      incoming: {
        ...incoming,
        categoryPath: [{ depth: 1, name: "Meieri", sourceCategoryId: "10" }],
      },
      sourceAccessApproved: false,
    })).toBe("none");
    expect(catalogCanonicalMutationDecision({
      canonical: { ...canonical, status: "quarantined" },
      incoming: { ...incoming, displayName: "Promoted milk" },
      sourceAccessApproved: false,
    })).toBe("review");
    expect(catalogCanonicalMutationDecision({
      canonical: { ...canonical, status: "quarantined" },
      incoming: { ...incoming, displayName: "Promoted milk" },
      sourceAccessApproved: true,
    })).toBe("activate");
    expect(catalogCanonicalMutationDecision({
      canonical: { ...canonical, status: "retired" },
      incoming: { ...incoming, displayName: "Do not revive" },
      sourceAccessApproved: true,
    })).toBe("review");
  });

  it("derives historical claim eligibility only from the fenced historical run type", () => {
    expect(claimEligibilityForRunType("historical-prices")).toBe("historical_eligible");
    expect(claimEligibilityForRunType("benchmark-prices")).toBe("ordinary_only");
    expect(() => claimEligibilityForRunType("prices")).toThrow(/exact supported ingestion run type/i);
  });

  it("fails closed when no fencing verifier is configured", () => {
    expect(
      () => new PostgresIngestionRepository({} as never, {} as never),
    ).toThrow(/fence/i);
  });

  it("accepts only exact checksum-valid GTIN identity", () => {
    expect(canonicalGtin("7038010000010")).toBe("7038010000010");
    expect(canonicalGtin("96385074")).toBe("96385074");
    expect(canonicalGtin(" 7038010000010 ")).toBeUndefined();
    expect(canonicalGtin("7038010000011")).toBeUndefined();
    expect(canonicalGtin("milk-7038010000010")).toBeUndefined();
  });

  it("rejects non-finite normalized JSON instead of hashing it as null", () => {
    expect(() =>
      hashSourceRecordOutcome({
        normalizedRecord: { amount: Number.NaN },
        outcomeState: "accepted",
        recordKind: "price",
        recordedAt,
        sourceRecordId: "non-finite",
      }),
    ).toThrow(/finite/i);
    expect(() =>
      hashSourceRecordOutcome({
        normalizedRecord: { amount: Number.POSITIVE_INFINITY },
        outcomeState: "accepted",
        recordKind: "price",
        recordedAt,
        sourceRecordId: "infinite",
      }),
    ).toThrow(/finite/i);
  });

  it("enforces outcome discriminants at runtime", () => {
    expect(() =>
      validateSourceRecordOutcome({
        outcomeState: "accepted",
        reason: "SHOULD_NOT_EXIST",
        recordKind: "product",
        recordedAt,
        sourceRecordId: "accepted-with-reason",
      }),
    ).toThrow(/accepted.*reason/i);
    expect(() =>
      validateSourceRecordOutcome({
        outcomeState: "unknown",
        recordKind: "price",
        recordedAt,
        sourceRecordId: "unknown-without-reason",
      }),
    ).toThrow(/reason/i);
    expect(() =>
      validateSourceRecordOutcome({
        outcomeState: "invented",
        reason: "NOPE",
        recordKind: "price",
        recordedAt,
        sourceRecordId: "invented-state",
      }),
    ).toThrow(/outcomeState/i);
  });

  it("hashes semantic outcome content independently of object key order", () => {
    const left: SourceRecordOutcomeInput = {
      normalizedRecord: { name: "Melk", package: { amount: 1_000, unit: "ml" } },
      outcomeState: "accepted",
      recordKind: "product",
      recordedAt,
      sourceRecordId: "117",
      subjectEan: "7038010000010",
    };
    const right: SourceRecordOutcomeInput = {
      subjectEan: "7038010000010",
      sourceRecordId: "117",
      recordedAt: new Date("2026-07-16T12:05:00.000Z"),
      recordKind: "product",
      outcomeState: "accepted",
      normalizedRecord: { package: { unit: "ml", amount: 1_000 }, name: "Melk" },
    };

    expect(hashSourceRecordOutcome(left)).toBe(hashSourceRecordOutcome(right));
    expect(hashSourceRecordOutcome({ ...right, rawChainCode: "REMA_1000" }))
      .not.toBe(hashSourceRecordOutcome(left));
  });

  it("accepts only canonical bounded product category paths", () => {
    expect(() => validateCatalogCategoryPath(undefined)).not.toThrow();
    expect(() => validateCatalogCategoryPath([])).not.toThrow();
    expect(() => validateCatalogCategoryPath([
      { depth: 1, name: "Meieri", sourceCategoryId: "10" },
      { depth: 2, name: "Melk", sourceCategoryId: "20" },
    ])).not.toThrow();

    expect(() => validateCatalogCategoryPath([
      { depth: 2, name: "Melk", sourceCategoryId: "20" },
      { depth: 1, name: "Meieri", sourceCategoryId: "10" },
    ])).toThrow(/canonical order/i);
    expect(() => validateCatalogCategoryPath([
      { depth: 1, name: "Meieri", sourceCategoryId: "10" },
      { depth: 2, name: "Konflikt", sourceCategoryId: "10" },
    ])).toThrow(/unique/i);
    expect(() => validateCatalogCategoryPath([
      { depth: -1, name: "Meieri", sourceCategoryId: "10" },
    ])).toThrow(/depth/i);
    expect(() => validateCatalogCategoryPath([
      { depth: 1, name: " Meieri", sourceCategoryId: "10" },
    ])).toThrow(/name/i);
    expect(() => validateCatalogCategoryPath([
      { depth: 1, name: "Meieri", sourceCategoryId: "01" },
    ])).toThrow(/sourceCategoryId/i);
    expect(() => validateCatalogCategoryPath(Array.from({ length: 101 }, (_, index) => ({
      depth: index,
      name: `Kategori ${index}`,
      sourceCategoryId: String(index),
    })))).toThrow(/at most 100/i);
  });

  it("reconstructs complete worker counters from persisted outcome states", () => {
    expect(
      reconstructIngestionRunCounters(
        ["accepted", "accepted", "quarantined", "unknown"],
        2,
      ),
    ).toEqual({
      accepted: 2,
      failed: 2,
      fetched: 4,
      persisted: 4,
      quarantined: 1,
      unknown: 1,
    });
  });

  it("downgrades a coordinate-less accepted store to an audited unknown", () => {
    const outcome: PhysicalStoreIngestionOutcome = {
      outcomeState: "accepted",
      recordKind: "physical-store",
      recordedAt,
      sourceRecordId: "store-123",
      store: {
        addressLine: "Testveien 1",
        name: "Testbutikk",
        observedAt: recordedAt,
      },
      subjectChain: "extra",
    };

    expect(normalizePhysicalStoreIngestionOutcome(outcome)).toMatchObject({
      normalizedRecord: {
        addressLine: "Testveien 1",
        name: "Testbutikk",
        observedAt: "2026-07-16T12:00:00.000Z",
      },
      outcomeState: "unknown",
      reason: "MISSING_COORDINATES",
      sourceRecordId: "store-123",
      subjectChain: "extra",
    });
  });

  it("rejects invalid physical-store coordinates before persistence", () => {
    expect(() =>
      normalizePhysicalStoreIngestionOutcome({
        outcomeState: "accepted",
        recordKind: "physical-store",
        recordedAt,
        sourceRecordId: "store-invalid",
        store: {
          latitude: 91,
          longitude: 10,
          name: "Invalid",
          observedAt: recordedAt,
        },
        subjectChain: "extra",
      }),
    ).toThrow(/latitude/i);
  });

  it("accepts only canonical four-digit postal evidence", () => {
    const outcome = {
      outcomeState: "accepted" as const,
      recordKind: "physical-store" as const,
      recordedAt,
      sourceRecordId: "store-postal",
      store: {
        latitude: 59.91,
        longitude: 10.75,
        name: "Postalbutikk",
        observedAt: recordedAt,
        postalCode: "0152",
      },
      subjectChain: "extra" as const,
    };

    expect(normalizePhysicalStoreIngestionOutcome(outcome)).toMatchObject({
      normalizedRecord: { postalCode: "0152" },
      outcomeState: "accepted",
    });
    for (const postalCode of ["152", "01520", "ABCD", " 0152"] as const) {
      expect(() => normalizePhysicalStoreIngestionOutcome({
        ...outcome,
        store: { ...outcome.store, postalCode },
      })).toThrow(/exactly four digits/i);
    }
  });

  it("derives opaque stable branch identities without source-boundary collisions", () => {
    expect(physicalStoreBranchKey("source-a", "store-1")).toMatch(/^[0-9a-f]{64}$/);
    expect(physicalStoreBranchKey("source-a", "store-1")).toBe(
      physicalStoreBranchKey("source-a", "store-1"),
    );
    expect(physicalStoreBranchKey("source-a", "store-1")).not.toBe(
      physicalStoreBranchKey("source-b", "store-1"),
    );
    expect(physicalStoreBranchKey("a", "b\u001fc")).not.toBe(
      physicalStoreBranchKey("a\u001fb", "c"),
    );
  });

  it("rejects absent or duplicate physical-store coverage before opening a transaction", async () => {
    const transaction = vi.fn(() => {
      throw new Error("transaction must not start");
    });
    const repository = new PostgresIngestionRepository({ transaction } as never, {
      verifyFence: async () => undefined,
    });
    const handle = {
      fenceToken: "fence",
      id: 1,
      jobId: "physical-store-job",
      runType: "physical-stores",
      sourceId: "kassalapp",
    } as const;

    await expect(repository.persistPhysicalStoreOutcomes(handle, [], []))
      .rejects.toThrow(/1-3 chain rows/i);
    await expect(repository.persistPhysicalStoreOutcomes(handle, [], [
      { chain: "extra", checkedAt: recordedAt, reason: "REQUEST_FAILED", recordCount: 0, state: "unknown" },
      { chain: "extra", checkedAt: recordedAt, reason: "REQUEST_FAILED", recordCount: 0, state: "unknown" },
    ])).rejects.toThrow(/unique/i);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects unbounded outcome batches before opening a transaction", async () => {
    const transaction = {
      transaction: () => {
        throw new Error("transaction must not start");
      },
    };
    const repository = new PostgresIngestionRepository(transaction as never, {
      verifyFence: async () => undefined,
    });
    const outcome: SourceRecordOutcomeInput = {
      outcomeState: "unknown",
      reason: "PRICE_UNAVAILABLE",
      recordKind: "price",
      recordedAt,
      sourceRecordId: "bounded-outcome",
    };

    await expect(
      repository.auditOutcomes(
        {
          fenceToken: "fence",
          id: 1,
          jobId: "job",
          runType: "prices",
          sourceId: "kassalapp",
        },
        Array.from({ length: 1_001 }, (_, index) => ({
          ...outcome,
          sourceRecordId: `bounded-outcome-${index}`,
        })),
      ),
    ).rejects.toThrow(/at most 1000/i);
  });

  it("rejects a non-terminal final status before opening a transaction", async () => {
    const transaction = {
      transaction: () => {
        throw new Error("transaction must not start");
      },
    };
    const repository = new PostgresIngestionRepository(transaction as never, {
      verifyFence: async () => undefined,
    });

    await expect(
      repository.finalizeRun(
        {
          fenceToken: "fence",
          id: 1,
          jobId: "job",
          runType: "prices",
          sourceId: "kassalapp",
        },
        {
          completedAt: recordedAt,
          status: "running" as never,
        },
      ),
    ).rejects.toThrow(/terminal status/i);
  });

  it("generates deterministic non-regressing catalog and store read-model policies", () => {
    const dialect = new PgDialect();
    const sourceProduct = dialect.sqlToQuery(sourceProductReplacementCondition).sql;
    const physicalStore = dialect.sqlToQuery(physicalStoreReplacementCondition).sql;

    expect(sourceProduct).toContain(
      '"source_products"."last_seen_at" < excluded.last_seen_at',
    );
    expect(sourceProduct).toContain(
      '"source_products"."raw_record_hash" > excluded.raw_record_hash',
    );
    expect(physicalStore).toContain(
      '"physical_stores"."observed_at" < excluded.observed_at',
    );
  });
});
