import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { CatalogEligibilityRow } from "./catalog-reader";
import type { HandleplanDatabase } from "./client";
import {
  PostgresPublicCatalogIndexReader,
  PublicCatalogIndexReaderError,
} from "./public-catalog-index-reader";

const AT = new Date("2026-07-16T12:00:00.000Z");
const GTIN_MILK = "7038010000010";
const GTIN_ALIAS = "96385074";

interface CapturedQuery {
  parameters: unknown[];
  sql: string;
}

type TestQuery = Promise<unknown[]> & { cancel: ReturnType<typeof vi.fn> };

function row(overrides: Partial<CatalogEligibilityRow> = {}): CatalogEligibilityRow {
  return {
    brand: "TINE",
    canonical_product_id: 1,
    catalog_last_seen_at: new Date("2026-07-16T10:00:00.000Z"),
    catalog_raw_record_hash: "a".repeat(64),
    catalog_runtime_state: "approved",
    catalog_source_display_name: "Kassalapp fixture",
    catalog_source_id: "kassalapp",
    catalog_source_kind: "ordinary_price",
    confidence: 100,
    display_name: "TINE Lettmelk",
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
    verified_at: new Date("2026-07-16T09:00:00.000Z"),
    ...overrides,
  };
}

function discoveryRow(overrides: Record<string, unknown> = {}) {
  const eligibility = row(overrides as Partial<CatalogEligibilityRow>);
  return {
    ...eligibility,
    category_path: null,
    sort_name: eligibility.display_name.toLocaleLowerCase("nb-NO"),
    sort_rank: 0,
    ...overrides,
  };
}

function resolvedQuery(rows: unknown[]): TestQuery {
  const query = Promise.resolve(rows) as TestQuery;
  query.cancel = vi.fn();
  return query;
}

function publicCategoryId(sourceId: string, sourceCategoryId: string): string {
  const digest = createHash("sha256")
    .update(Buffer.byteLength(sourceId, "utf8").toString())
    .update(":")
    .update(sourceId)
    .update(sourceCategoryId)
    .digest("hex");
  return `category:${digest}`;
}

function categoryEntry(
  sourceCategoryId = "10",
  depth = 1,
  name = "Meieri",
) {
  return { depth, name, sourceCategoryId };
}

function databaseWith(
  queryFactory: () => TestQuery,
): { captures: CapturedQuery[]; db: HandleplanDatabase } {
  const captures: CapturedQuery[] = [];
  const client = (strings: TemplateStringsArray, ...parameters: unknown[]) => {
    captures.push({ parameters, sql: strings.join("?") });
    return queryFactory();
  };
  return {
    captures,
    db: { $client: client } as unknown as HandleplanDatabase,
  };
}

function readerError(code: "CANCELLED" | "INVALID_REQUEST" | "UNAVAILABLE") {
  return expect.objectContaining({
    code,
    name: "PublicCatalogIndexReaderError",
  });
}

describe("PostgresPublicCatalogIndexReader", () => {
  it("browses one deterministic summary per canonical product", async () => {
    const { captures, db } = databaseWith(() => resolvedQuery([row()]));
    const reader = new PostgresPublicCatalogIndexReader(db);

    await expect(reader.browse(36, AT)).resolves.toMatchObject([
      { displayName: "TINE Lettmelk", gtin: GTIN_MILK },
    ]);
    expect(captures[0]!.sql).toContain("from catalog_observations observation");
    expect(captures[0]!.sql).toContain(
      "observation.canonical_product_id::double precision as canonical_product_id",
    );
    expect(captures[0]!.sql).toContain("permission.id::double precision as permission_id");
    expect(captures[0]!.sql).toContain("run.status = 'completed'");
    expect(captures[0]!.sql).toContain("run.created_at <=");
    expect(captures[0]!.sql).toContain("run.terminalized_at <=");
    expect(captures[0]!.sql).toContain("observation.retrieved_at <= run.completed_at");
    expect(captures[0]!.sql).toContain("observation.created_at <=");
    expect(captures[0]!.sql).toContain("source.created_at <=");
    expect(captures[0]!.sql).toContain("source.public_state_changed_at <=");
    expect(captures[0]!.sql).toContain("candidate_permission.created_at <=");
    expect(captures[0]!.sql).toContain("permission.permissions @> '{\"catalog\": true}'::jsonb");
    expect(captures[0]!.sql).toContain("100::smallint as confidence");
    expect(captures[0]!.sql).toContain("'product:' || observation.canonical_product_id::text");
    expect(captures[0]!.sql).not.toContain("source_products");
    expect(captures[0]!.sql).not.toContain("canonical_products");
    expect(captures[0]!.sql).not.toContain("product_identifiers");
    expect(captures[0]!.sql).toContain("limit ?");
  });

  it("keeps an exact requested GTIN alias searchable without duplicate browse cards", async () => {
    const alias = row({
      brand: null,
      catalog_raw_record_hash: "b".repeat(64),
      gtin: GTIN_ALIAS,
      package_amount: 4,
      package_unit: "piece",
      scheme: "ean8",
      units_per_pack: 4,
    });
    const { captures, db } = databaseWith(() => resolvedQuery([alias]));

    await expect(new PostgresPublicCatalogIndexReader(db).search(GTIN_ALIAS, 20, AT))
      .resolves.toMatchObject([{ gtin: GTIN_ALIAS }]);
    expect(captures[0]!.parameters).toContain(GTIN_ALIAS);
    expect(captures[0]!.sql).toContain("'gtin:' || observation.gtin");
  });

  it("searches bounded literal text with deterministic relevance and no private output", async () => {
    const { captures, db } = databaseWith(() => resolvedQuery([
      row({ display_name: "TINE Sjokolademelk" }),
      row({
        canonical_product_id: 2,
        catalog_raw_record_hash: "b".repeat(64),
        display_name: "TINE",
        gtin: GTIN_ALIAS,
        scheme: "ean8",
      }),
    ]));
    const result = await new PostgresPublicCatalogIndexReader(db).search(" TINE ", 20, AT);

    expect(result.map(({ displayName }) => displayName)).toEqual(["TINE", "TINE Sjokolademelk"]);
    expect(JSON.stringify(result)).not.toMatch(/canonical_product_id|permission|raw_record_hash|runtime_state/i);
    expect(captures[0]!.parameters).toContain("%TINE%");
    expect(captures[0]!.sql).toContain("escape '\\'");
  });

  it("preserves unknown and known-empty category paths for discovery", async () => {
    const unknownDatabase = databaseWith(() => resolvedQuery([discoveryRow()]));
    const emptyDatabase = databaseWith(() => resolvedQuery([discoveryRow({
      category_path: [],
    })]));

    await expect(new PostgresPublicCatalogIndexReader(unknownDatabase.db)
      .readDiscoveryPage({ limit: 10 }, AT))
      .resolves.toMatchObject({ entries: [{ categoryPath: null, product: { gtin: GTIN_MILK } }] });
    await expect(new PostgresPublicCatalogIndexReader(emptyDatabase.db)
      .readDiscoveryPage({ limit: 10 }, AT))
      .resolves.toMatchObject({ entries: [{ categoryPath: [], product: { gtin: GTIN_MILK } }] });
  });

  it("returns source-scoped opaque category IDs and filters only after latest selection", async () => {
    const categoryId = publicCategoryId("kassalapp", "20");
    const categoryPath = [
      categoryEntry("10", 1, "Meieri"),
      categoryEntry("20", 2, "Melk"),
    ];
    const { captures, db } = databaseWith(() => resolvedQuery([discoveryRow({
      category_path: categoryPath,
    })]));

    const result = await new PostgresPublicCatalogIndexReader(db).readDiscoveryPage({
      categoryId,
      limit: 10,
    }, AT);

    expect(result.entries[0]!.categoryPath).toEqual([
      {
        depth: 1,
        id: publicCategoryId("kassalapp", "10"),
        name: "Meieri",
        sourceId: "kassalapp",
      },
      {
        depth: 2,
        id: categoryId,
        name: "Melk",
        sourceId: "kassalapp",
      },
    ]);
    expect(JSON.stringify(result.entries[0]!.categoryPath)).not.toContain("sourceCategoryId");
    expect(captures[0]!.parameters).toContain(categoryId.slice("category:".length));
    expect(captures[0]!.parameters).not.toContain("20");
    expect(captures[0]!.sql).toContain("encode(sha256(convert_to(");
    expect(captures[0]!.sql.indexOf("where selection_rank = 1"))
      .toBeLessThan(captures[0]!.sql.indexOf("jsonb_array_elements(latest.category_path)"));
  });

  it("retains category paths in discovery search without changing summary search", async () => {
    const { captures, db } = databaseWith(() => resolvedQuery([discoveryRow({
      category_path: [categoryEntry()],
    })]));

    const result = await new PostgresPublicCatalogIndexReader(db)
      .readDiscoveryPage({ limit: 20, query: " TINE " }, AT);

    expect(result.entries).toMatchObject([{
      categoryPath: [{ name: "Meieri", sourceId: "kassalapp" }],
      product: { displayName: "TINE Lettmelk" },
    }]);
    expect(captures[0]!.parameters).toContain("%TINE%");
    expect(captures[0]!.sql).toContain("'gtin:' || observation.gtin");
  });

  it("fails closed when a filtered row does not contain the requested public category", async () => {
    const { db } = databaseWith(() => resolvedQuery([discoveryRow({
      category_path: [categoryEntry("10")],
    })]));

    await expect(new PostgresPublicCatalogIndexReader(db).readDiscoveryPage({
      categoryId: publicCategoryId("kassalapp", "20"),
      limit: 10,
    }, AT)).rejects.toEqual(readerError("UNAVAILABLE"));
  });

  it.each([
    ["non-array", {}],
    ["unknown field", [{ ...categoryEntry(), unexpected: true }]],
    ["non-canonical source ID", [categoryEntry("01")]],
    ["numeric source ID", [{ ...categoryEntry(), sourceCategoryId: 10 }]],
    ["invalid depth", [categoryEntry("10", 101)]],
    ["untrimmed name", [categoryEntry("10", 1, " Meieri")]],
    ["duplicate ID", [categoryEntry("10", 1), categoryEntry("10", 2, "Melk")]],
    ["non-canonical order", [categoryEntry("20", 1), categoryEntry("10", 1, "Melk")]],
    ["overlong path", Array.from({ length: 101 }, (_, index) =>
      categoryEntry(String(index), index, `Category ${index}`))],
  ] as const)("fails closed on a %s category path", async (_label, categoryPath) => {
    const { db } = databaseWith(() => resolvedQuery([discoveryRow({
      category_path: categoryPath,
    })]));

    await expect(new PostgresPublicCatalogIndexReader(db).readDiscoveryPage({ limit: 10 }, AT))
      .rejects.toEqual(readerError("UNAVAILABLE"));
  });

  it("returns a bounded facet directory with source-scoped IDs and truncation", async () => {
    const facetRows = [
      {
        catalog_source_id: "source-a",
        category_variants: [categoryEntry("10")],
        product_count: 4,
      },
      {
        catalog_source_id: "source-b",
        category_variants: [categoryEntry("10")],
        product_count: 2,
      },
    ];
    const { captures, db } = databaseWith(() => resolvedQuery(facetRows));

    const reader = new PostgresPublicCatalogIndexReader(db);
    const result = await reader.categoryFacets(1, AT);
    const complete = await reader.categoryFacets(2, AT);

    expect(result).toEqual({
      facets: [{
        depth: 1,
        id: publicCategoryId("source-a", "10"),
        name: "Meieri",
        productCount: 4,
        sourceId: "source-a",
      }],
      hasMore: true,
    });
    expect(complete.facets.map(({ id }) => id)).toEqual([
      publicCategoryId("source-a", "10"),
      publicCategoryId("source-b", "10"),
    ]);
    expect(complete.hasMore).toBe(false);
    expect(complete.facets[0]!.id).not.toBe(complete.facets[1]!.id);
    expect(JSON.stringify(result)).not.toContain("sourceCategoryId");
    expect(captures[0]!.parameters.at(-1)).toBe(2);
    expect(captures[0]!.sql).toContain("count(distinct canonical_product_id)");
    expect(captures[0]!.sql.indexOf("where selection_rank = 1"))
      .toBeLessThan(captures[0]!.sql.indexOf("jsonb_array_elements(latest.category_path)"));
    expect(captures[0]!.sql).toContain("where latest.category_path is not null");
  });

  it("fails closed on conflicting category facet metadata", async () => {
    const { db } = databaseWith(() => resolvedQuery([{
      catalog_source_id: "kassalapp",
      category_variants: [
        categoryEntry("10", 1, "Meieri"),
        categoryEntry("10", 1, "Konflikt"),
      ],
      product_count: 2,
    }]));

    await expect(new PostgresPublicCatalogIndexReader(db).categoryFacets(10, AT))
      .rejects.toEqual(readerError("UNAVAILABLE"));
  });

  it.each([
    ["revoked permission", { permission_decision: "revoked" }],
    ["expired permission", { permission_valid_until: AT }],
    ["future permission", { permission_reviewed_at: new Date("2026-07-16T12:00:00.001Z") }],
    ["catalog permission absent", { permission_catalog: false }],
    ["revoked source", { catalog_runtime_state: "revoked" }],
    ["expired source", { source_permission_expires_at: AT }],
    ["future verification", { verified_at: new Date("2026-07-16T12:00:00.001Z") }],
    ["stale catalog", { catalog_last_seen_at: new Date("2026-07-14T11:59:59.999Z") }],
    ["quarantined product", { status: "quarantined" }],
  ] as const)("omits %s rows", async (_label, override) => {
    const { db } = databaseWith(() => resolvedQuery([row(override)]));
    await expect(new PostgresPublicCatalogIndexReader(db).browse(10, AT)).resolves.toEqual([]);
  });

  it.each([
    ["malformed hash", { catalog_raw_record_hash: "not-a-hash" }],
    ["invalid GTIN", { gtin: "12345678" }],
    ["invalid package unit", { package_unit: "litres" }],
    ["invalid status", { status: "mystery" }],
    ["invalid source kind", { catalog_source_kind: "private-feed" }],
  ] as const)("fails closed on %s", async (_label, override) => {
    const { db } = databaseWith(() => resolvedQuery([row(override)]));
    await expect(new PostgresPublicCatalogIndexReader(db).browse(10, AT))
      .rejects.toEqual(readerError("UNAVAILABLE"));
  });

  it("rejects unbounded requests before querying", async () => {
    const { db, captures } = databaseWith(() => resolvedQuery([]));
    const reader = new PostgresPublicCatalogIndexReader(db);

    await expect(reader.browse(37, AT)).rejects.toEqual(readerError("INVALID_REQUEST"));
    await expect(reader.search("m", 20, AT)).rejects.toEqual(readerError("INVALID_REQUEST"));
    await expect(reader.search("m".repeat(121), 20, AT)).rejects.toEqual(readerError("INVALID_REQUEST"));
    await expect(reader.search("melk", 21, AT)).rejects.toEqual(readerError("INVALID_REQUEST"));
    await expect(reader.readDiscoveryPage({ limit: 51 }, AT))
      .rejects.toEqual(readerError("INVALID_REQUEST"));
    await expect(reader.readDiscoveryPage({ categoryId: "category:" + "A".repeat(64), limit: 10 }, AT))
      .rejects.toEqual(readerError("INVALID_REQUEST"));
    await expect(reader.readDiscoveryPage({ limit: 20, query: "m" }, AT))
      .rejects.toEqual(readerError("INVALID_REQUEST"));
    await expect(reader.categoryFacets(101, AT))
      .rejects.toEqual(readerError("INVALID_REQUEST"));
    expect(captures).toEqual([]);
  });

  it("cancels the active query and exposes only a sanitized cancellation", async () => {
    let reject!: (error: Error) => void;
    const query = new Promise<unknown[]>((_resolve, nextReject) => {
      reject = nextReject;
    }) as TestQuery;
    query.cancel = vi.fn(() => reject(new Error("driver details")));
    const { db } = databaseWith(() => query);
    const controller = new AbortController();
    const pending = new PostgresPublicCatalogIndexReader(db).browse(10, AT, controller.signal);

    controller.abort();

    await expect(pending).rejects.toEqual(readerError("CANCELLED"));
    expect(query.cancel).toHaveBeenCalledOnce();
  });

  it("uses the dedicated public error type", () => {
    expect(new PublicCatalogIndexReaderError("UNAVAILABLE").message).not.toMatch(/postgres|sql/i);
  });
});
