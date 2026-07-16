import { describe, expect, it, vi } from "vitest";

import type { HandleplanDatabase } from "./client";
import {
  ActiveCatalogReaderError,
  PostgresActiveCatalogReader,
  classifyCatalogRow,
  normalizeCatalogEligibilityRow,
} from "./catalog-reader";

const AT = new Date("2026-07-16T12:00:00.000Z");
const GTIN_MILK = "7038010000010";
const GTIN_EAN8 = "96385074";

interface TestCatalogRow {
  brand: string | null;
  canonical_product_id: number;
  catalog_last_seen_at: Date;
  catalog_raw_record_hash: string;
  catalog_runtime_state: string;
  catalog_source_display_name: string;
  catalog_source_id: string;
  catalog_source_kind: string;
  confidence: number;
  display_name: string;
  gtin: string;
  package_amount: number;
  package_unit: string;
  permission_catalog: boolean | null;
  permission_decision: string | null;
  permission_id: number | null;
  permission_reviewed_at: Date | null;
  permission_valid_until: Date | null;
  scheme: string;
  source_permission_expires_at: Date | null;
  source_permission_reviewed_at: Date | null;
  status: string;
  units_per_pack: number;
  verified_at: Date | null;
}

interface CapturedQuery {
  parameters: unknown[];
  sql: string;
}

interface TestArrayParameter {
  values: string[];
}

type TestQuery = Promise<TestCatalogRow[]> & { cancel: ReturnType<typeof vi.fn> };

function row(overrides: Partial<TestCatalogRow> = {}): TestCatalogRow {
  return {
    brand: "TINE",
    canonical_product_id: 1,
    catalog_last_seen_at: new Date("2026-07-16T00:15:00.000Z"),
    catalog_raw_record_hash: "a".repeat(64),
    catalog_runtime_state: "approved",
    catalog_source_display_name: "Kassalapp fixture",
    catalog_source_id: "kassalapp",
    catalog_source_kind: "ordinary_price",
    confidence: 100,
    display_name: "TINE Lettmelk 1 %",
    gtin: GTIN_MILK,
    package_amount: 1_000,
    package_unit: "ml",
    permission_catalog: true,
    permission_decision: "approved",
    permission_id: 1,
    permission_reviewed_at: new Date("2026-07-15T10:00:00.000Z"),
    permission_valid_until: new Date("2026-08-15T10:00:00.000Z"),
    scheme: "ean13",
    source_permission_expires_at: new Date("2026-08-15T10:00:00.000Z"),
    source_permission_reviewed_at: new Date("2026-07-15T10:00:00.000Z"),
    status: "active",
    units_per_pack: 1,
    verified_at: new Date("2026-07-16T11:00:00.000Z"),
    ...overrides,
  };
}

function resolvedQuery(rows: TestCatalogRow[]): TestQuery {
  const query = Promise.resolve(rows) as TestQuery;
  query.cancel = vi.fn();
  return query;
}

function rejectedQuery(error: Error): TestQuery {
  const query = Promise.reject(error) as TestQuery;
  query.cancel = vi.fn();
  return query;
}

function databaseWith(
  queryFactory: () => TestQuery,
): { captures: CapturedQuery[]; db: HandleplanDatabase } {
  const captures: CapturedQuery[] = [];
  const client = Object.assign(
    (strings: TemplateStringsArray, ...parameters: unknown[]) => {
      captures.push({ parameters, sql: strings.join("?") });
      return queryFactory();
    },
    {
      array: (values: string[]): TestArrayParameter => ({ values: [...values] }),
    },
  );

  return {
    captures,
    db: { $client: client } as unknown as HandleplanDatabase,
  };
}

function gtin13(sequence: number): string {
  const body = String(sequence).padStart(12, "0");
  const weighted = [...body].reduce(
    (sum, digit, index) => sum + Number(digit) * (index % 2 === 0 ? 1 : 3),
    0,
  );
  return `${body}${(10 - (weighted % 10)) % 10}`;
}

function expectReaderError(code: "CANCELLED" | "INVALID_REQUEST" | "UNAVAILABLE") {
  const messages = {
    CANCELLED: "Active catalog request cancelled",
    INVALID_REQUEST: "Active catalog request is invalid",
    UNAVAILABLE: "Active catalog is unavailable",
  } as const;
  return {
    code,
    message: messages[code],
    name: "ActiveCatalogReaderError",
  };
}

describe("PostgresActiveCatalogReader", () => {
  it("queries the strict active identifier contract and returns canonical sorted summaries", async () => {
    const ean8 = row({
      brand: null,
      display_name: "EAN-8 fixture",
      gtin: GTIN_EAN8,
      package_amount: 4,
      package_unit: "piece",
      scheme: "ean8",
      units_per_pack: 4,
      verified_at: AT,
    });
    const { captures, db } = databaseWith(() => resolvedQuery([ean8, row()]));
    const reader = new PostgresActiveCatalogReader(db);

    await expect(reader.getMany([GTIN_EAN8, GTIN_MILK], AT)).resolves.toEqual([
      {
        brand: "TINE",
        catalogEvidence: {
          observedAt: "2026-07-16T00:15:00.000Z",
          source: {
            contractVersion: 1,
            displayName: "Kassalapp fixture",
            id: "kassalapp",
            sourceClass: "ordinary-price",
            state: "approved",
          },
          sourceRecordId: `source-record:${"a".repeat(64)}`,
        },
        displayName: "TINE Lettmelk 1 %",
        gtin: GTIN_MILK,
        packageMeasure: { amount: 1_000, unit: "ml" },
        unitsPerPack: 1,
      },
      {
        catalogEvidence: {
          observedAt: "2026-07-16T00:15:00.000Z",
          source: {
            contractVersion: 1,
            displayName: "Kassalapp fixture",
            id: "kassalapp",
            sourceClass: "ordinary-price",
            state: "approved",
          },
          sourceRecordId: `source-record:${"a".repeat(64)}`,
        },
        displayName: "EAN-8 fixture",
        gtin: GTIN_EAN8,
        packageMeasure: { amount: 4, unit: "piece" },
        unitsPerPack: 4,
      },
    ]);

    expect(captures).toHaveLength(1);
    const query = captures[0]!;
    const sql = query.sql.replace(/\s+/g, " ").trim();
    expect(sql).toContain("with ranked_catalog as");
    expect(sql).toContain("from catalog_observations observation");
    expect(sql).toContain("observation.canonical_product_id::double precision as canonical_product_id");
    expect(sql).toContain("permission.id::double precision as permission_id");
    expect(sql).toContain("inner join ingestion_runs run");
    expect(sql).toContain("run.run_type = 'catalog'");
    expect(sql).toContain("run.status = 'completed'");
    expect(sql).toContain("observation.retrieved_at <= run.completed_at");
    expect(sql).not.toContain("from product_identifiers");
    expect(sql).not.toContain("canonical_products");
    expect(sql).not.toContain("source_products");
    expect(sql).toContain("inner join data_sources source");
    expect(sql).toContain("source.runtime_state = 'approved'");
    expect(sql).toContain("inner join lateral");
    expect(sql).toContain("from source_permissions candidate");
    expect(sql).toContain("candidate.reviewed_at <= ?");
    expect(sql).toContain("order by candidate.reviewed_at desc, candidate.id desc");
    expect(sql).toContain("permission.decision = 'approved'");
    expect(sql).toContain("permission.permissions @> '{\"catalog\": true}'::jsonb");
    expect(sql).toContain("observation.retrieved_at >= ?");
    expect(sql).toContain("observation.retrieved_at <= ?");
    expect(sql).toContain("partition by observation.gtin");
    expect(sql).toContain("observation.retrieved_at desc");
    expect(sql).toContain("run.completed_at desc");
    expect(sql).toContain("where selection_rank = 1");
    expect(sql).toContain("select jsonb_array_elements_text(?::jsonb)");
    expect(sql).toContain("case char_length(observation.gtin)");
    expect(sql).toContain("100::smallint as confidence");
    expect(sql).toContain("observation.retrieved_at as verified_at");
    expect(sql).toContain("order by gtin asc");
    expect(query.parameters).toContain(JSON.stringify([GTIN_EAN8, GTIN_MILK]));
    expect(query.parameters).toContain("2026-07-14T12:00:00.000Z");
    expect(query.parameters.filter((parameter) => parameter === AT.toISOString()).length)
      .toBeGreaterThan(1);
  });

  it("rejects invalid, duplicate, empty, oversized, and non-finite requests before querying", async () => {
    const { captures, db } = databaseWith(() => resolvedQuery([]));
    const reader = new PostgresActiveCatalogReader(db);
    const oversized = Array.from({ length: 51 }, (_, index) => gtin13(index + 1));
    const sparse = new Array<string>(1);
    const invalidRequests: Array<[string[], Date]> = [
      [[], AT],
      [sparse, AT],
      [[GTIN_MILK, GTIN_MILK], AT],
      [["7038010000013"], AT],
      [oversized, AT],
      [[GTIN_MILK], new Date(Number.NaN)],
    ];

    for (const [gtins, at] of invalidRequests) {
      await expect(reader.getMany(gtins, at)).rejects.toMatchObject(
        expectReaderError("INVALID_REQUEST"),
      );
    }
    expect(captures).toHaveLength(0);
  });

  it("accepts the exact 50-identity request bound", async () => {
    const { captures, db } = databaseWith(() => resolvedQuery([]));
    const reader = new PostgresActiveCatalogReader(db);
    const gtins = Array.from({ length: 50 }, (_, index) => gtin13(index + 1));

    await expect(reader.getMany(gtins, AT)).resolves.toEqual([]);
    expect(captures).toHaveLength(1);
  });

  it("omits every legitimately ineligible or absent state indistinguishably", async () => {
    const gtins = Array.from({ length: 8 }, (_, index) => gtin13(index + 100));
    const eligible = row({ gtin: gtins[0] });
    const { db } = databaseWith(() => resolvedQuery([
      eligible,
      row({ gtin: gtins[1], status: "retired" }),
      row({ gtin: gtins[2], status: "quarantined" }),
      row({ gtin: gtins[3], verified_at: null }),
      row({ confidence: 99, gtin: gtins[4] }),
      row({ gtin: gtins[5], verified_at: new Date("2026-07-16T12:00:00.001Z") }),
      row({ gtin: gtins[6], scheme: "source" }),
    ]));
    const reader = new PostgresActiveCatalogReader(db);

    await expect(reader.getMany(gtins, AT)).resolves.toEqual([
      {
        brand: "TINE",
        catalogEvidence: {
          observedAt: "2026-07-16T00:15:00.000Z",
          source: {
            contractVersion: 1,
            displayName: "Kassalapp fixture",
            id: "kassalapp",
            sourceClass: "ordinary-price",
            state: "approved",
          },
          sourceRecordId: `source-record:${"a".repeat(64)}`,
        },
        displayName: "TINE Lettmelk 1 %",
        gtin: gtins[0],
        packageMeasure: { amount: 1_000, unit: "ml" },
        unitsPerPack: 1,
      },
    ]);
  });

  it("fails closed for revoked, expired, future, missing, or catalog-disabled permission", async () => {
    const gtins = Array.from({ length: 8 }, (_, index) => gtin13(index + 200));
    const { db } = databaseWith(() => resolvedQuery([
      row({ gtin: gtins[0], catalog_runtime_state: "revoked" }),
      row({ gtin: gtins[1], source_permission_expires_at: AT }),
      row({ gtin: gtins[2], source_permission_reviewed_at: new Date("2026-07-16T12:00:00.001Z") }),
      row({ gtin: gtins[3], permission_decision: "revoked" }),
      row({ gtin: gtins[4], permission_valid_until: AT }),
      row({ gtin: gtins[5], permission_reviewed_at: new Date("2026-07-16T12:00:00.001Z") }),
      row({ gtin: gtins[6], permission_id: null, permission_decision: null, permission_reviewed_at: null }),
      row({ gtin: gtins[7], permission_catalog: false }),
    ]));

    await expect(new PostgresActiveCatalogReader(db).getMany(gtins, AT)).resolves.toEqual([]);
  });

  it("keeps legitimate requested GTIN aliases backed by one canonical source record", async () => {
    const alias = gtin13(301);
    const shared = {
      canonical_product_id: 42,
      catalog_raw_record_hash: "b".repeat(64),
    };
    const { db } = databaseWith(() => resolvedQuery([
      row({ ...shared, gtin: alias }),
      row({ ...shared, gtin: GTIN_MILK }),
    ]));

    const products = await new PostgresActiveCatalogReader(db).getMany([GTIN_MILK, alias], AT);
    expect(products.map(({ gtin }) => gtin)).toEqual([GTIN_MILK, alias].sort());
    expect(new Set(products.map(({ catalogEvidence }) => catalogEvidence.sourceRecordId)).size)
      .toBe(1);
  });

  it("applies an inclusive 48-hour catalog freshness ceiling", async () => {
    const boundary = row({ catalog_last_seen_at: new Date("2026-07-14T12:00:00.000Z") });
    const staleGtin = gtin13(302);
    const stale = row({
      catalog_last_seen_at: new Date("2026-07-14T11:59:59.999Z"),
      gtin: staleGtin,
    });
    const { db } = databaseWith(() => resolvedQuery([stale, boundary]));

    await expect(new PostgresActiveCatalogReader(db).getMany([GTIN_MILK, staleGtin], AT))
      .resolves.toEqual([expect.objectContaining({ gtin: GTIN_MILK })]);
  });

  it("normalizes PostgreSQL timestamp text without accepting invalid dates", () => {
    const timestampText = {
      ...row(),
      catalog_last_seen_at: "2026-07-16 00:15:00+00",
      permission_reviewed_at: "2026-07-15 10:00:00+00",
      permission_valid_until: "2026-08-15 10:00:00+00",
      source_permission_expires_at: "2026-08-15 10:00:00+00",
      source_permission_reviewed_at: "2026-07-15 10:00:00+00",
      verified_at: "2026-07-16 11:00:00+00",
    };
    const normalized = normalizeCatalogEligibilityRow(timestampText) as TestCatalogRow;
    expect(normalized.catalog_last_seen_at).toBeInstanceOf(Date);
    expect(normalized.verified_at).toBeInstanceOf(Date);
    expect(classifyCatalogRow(normalized, AT)).toBe("eligible");

    const invalid = normalizeCatalogEligibilityRow({
      ...timestampText,
      verified_at: "not-a-date",
    });
    expect(classifyCatalogRow(invalid, AT)).toBe("malformed");
  });

  it("fails the whole read when an eligible row violates the domain summary contract", async () => {
    const { db } = databaseWith(() => resolvedQuery([
      row({ display_name: "   " }),
    ]));
    const reader = new PostgresActiveCatalogReader(db);

    await expect(reader.getMany([GTIN_MILK], AT)).rejects.toMatchObject(
      expectReaderError("UNAVAILABLE"),
    );
  });

  it("fails the whole read on duplicate or unexpected eligible identities", async () => {
    const duplicateDatabase = databaseWith(() => resolvedQuery([row(), row()]));
    const duplicateReader = new PostgresActiveCatalogReader(duplicateDatabase.db);
    await expect(duplicateReader.getMany([GTIN_MILK], AT)).rejects.toMatchObject(
      expectReaderError("UNAVAILABLE"),
    );

    const unexpectedGtin = gtin13(999);
    const unexpectedDatabase = databaseWith(() => resolvedQuery([
      row({ gtin: unexpectedGtin }),
    ]));
    const unexpectedReader = new PostgresActiveCatalogReader(unexpectedDatabase.db);
    await expect(unexpectedReader.getMany([GTIN_MILK], AT)).rejects.toMatchObject(
      expectReaderError("UNAVAILABLE"),
    );
  });

  it("stops before querying when cancellation is already requested", async () => {
    const { captures, db } = databaseWith(() => resolvedQuery([]));
    const reader = new PostgresActiveCatalogReader(db);
    const controller = new AbortController();
    controller.abort();

    await expect(reader.getMany([GTIN_MILK], AT, controller.signal)).rejects.toMatchObject(
      expectReaderError("CANCELLED"),
    );
    expect(captures).toHaveLength(0);
  });

  it("cancels an in-flight PostgreSQL query", async () => {
    let rejectQuery!: (error: Error) => void;
    const query = new Promise<TestCatalogRow[]>((_, reject) => {
      rejectQuery = reject;
    }) as TestQuery;
    query.cancel = vi.fn(() => rejectQuery(new Error("postgres query cancelled")));
    const { db } = databaseWith(() => query);
    const reader = new PostgresActiveCatalogReader(db);
    const controller = new AbortController();

    const read = reader.getMany([GTIN_MILK], AT, controller.signal);
    controller.abort();

    await expect(read).rejects.toMatchObject(expectReaderError("CANCELLED"));
    expect(query.cancel).toHaveBeenCalledOnce();
  });

  it("collapses database failures without disclosing SQL or connection state", async () => {
    const internalMessage = "relation canonical_products missing at postgres://secret";
    const { db } = databaseWith(() => rejectedQuery(new Error(internalMessage)));
    const reader = new PostgresActiveCatalogReader(db);

    const read = reader.getMany([GTIN_MILK], AT);
    await expect(read).rejects.toMatchObject(expectReaderError("UNAVAILABLE"));
    await expect(read).rejects.not.toMatchObject({ message: expect.stringContaining("secret") });
  });

  it("exposes only bounded error codes and messages", () => {
    expect(new ActiveCatalogReaderError("INVALID_REQUEST")).toMatchObject(
      expectReaderError("INVALID_REQUEST"),
    );
    expect(new ActiveCatalogReaderError("CANCELLED")).toMatchObject(
      expectReaderError("CANCELLED"),
    );
    expect(new ActiveCatalogReaderError("UNAVAILABLE")).toMatchObject(
      expectReaderError("UNAVAILABLE"),
    );
  });
});
