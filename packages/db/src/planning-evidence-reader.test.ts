import { describe, expect, it, vi } from "vitest";

import type { HandleplanDatabase } from "./client";
import {
  PlanningEvidenceReaderError,
  PostgresPlanningEvidenceReader,
} from "./planning-evidence-reader";

const AT = new Date("2026-07-16T12:00:00.000Z");
const GTIN = "7038010000010";
const GTIN_ALIAS = "7038010000027";

interface TestRow {
  amount_ore: number | null;
  chain: string | null;
  checked_at: Date | string | null;
  claim_eligibility: "historical_eligible" | "ordinary_only" | null;
  country_code: string | null;
  coverage_reason: string | null;
  coverage_state: string | null;
  display_name: string | null;
  fetched_at: Date | string | null;
  gtin: string;
  observed_at: Date | string | null;
  product_id: number | string;
  raw_record_hash: string | null;
  record_id: number | string | null;
  record_type: "coverage" | "price" | "product";
  postal_codes: string[];
  region_codes: string[];
  scope_kind: string | null;
  scope_status: string | null;
  source_id: string | null;
  source_kind: string | null;
  store_ids: string[];
}

interface Capture {
  parameters: unknown[];
  sql: string;
}

type TestQuery = Promise<TestRow[]> & { cancel: ReturnType<typeof vi.fn> };

function resolved(rows: TestRow[]): TestQuery {
  const query = Promise.resolve(rows) as TestQuery;
  query.cancel = vi.fn();
  return query;
}

function rejected(error: Error): TestQuery {
  const query = Promise.reject(error) as TestQuery;
  query.cancel = vi.fn();
  return query;
}

function databaseWith(factory: () => TestQuery) {
  const captures: Capture[] = [];
  const client = Object.assign(
    (strings: TemplateStringsArray, ...parameters: unknown[]) => {
      captures.push({ parameters, sql: strings.join("?") });
      return factory();
    },
    { array: (values: string[]) => ({ values: [...values] }) },
  );
  return {
    captures,
    db: { $client: client } as unknown as HandleplanDatabase,
  };
}

function productRow(overrides: Partial<TestRow> = {}): TestRow {
  return {
    amount_ore: null,
    chain: null,
    checked_at: null,
    claim_eligibility: null,
    country_code: null,
    coverage_reason: null,
    coverage_state: null,
    display_name: null,
    fetched_at: null,
    gtin: GTIN,
    observed_at: null,
    postal_codes: [],
    product_id: 42,
    raw_record_hash: null,
    record_id: null,
    record_type: "product",
    region_codes: [],
    scope_kind: null,
    scope_status: null,
    source_id: null,
    source_kind: null,
    store_ids: [],
    ...overrides,
  };
}

function priceRow(overrides: Partial<TestRow> = {}): TestRow {
  return productRow({
    amount_ore: 2_490,
    chain: "extra",
    claim_eligibility: "ordinary_only",
    country_code: "NO",
    display_name: "Licensed fixture",
    fetched_at: new Date("2026-07-16T11:05:00.000Z"),
    observed_at: new Date("2026-07-16T11:00:00.000Z"),
    raw_record_hash: "a".repeat(64),
    record_id: 101,
    record_type: "price",
    scope_kind: "national",
    scope_status: "active",
    source_id: "licensed-feed",
    source_kind: "ordinary_price",
    ...overrides,
  });
}

function coverageRow(overrides: Partial<TestRow> = {}): TestRow {
  return productRow({
    chain: "bunnpris",
    checked_at: new Date("2026-07-16T11:30:00.000Z"),
    country_code: "NO",
    coverage_reason: "not_in_source_catalog",
    coverage_state: "known_not_carried",
    display_name: "Licensed fixture",
    record_id: 201,
    record_type: "coverage",
    scope_kind: "region",
    scope_status: "active",
    source_id: "licensed-feed",
    source_kind: "ordinary_price",
    region_codes: ["NO-03"],
    ...overrides,
  });
}

describe("PostgresPlanningEvidenceReader", () => {
  it("reads immutable source-neutral price, scope, and explicit coverage records", async () => {
    const { captures, db } = databaseWith(() => resolved([
      coverageRow(),
      priceRow(),
      productRow(),
      coverageRow({
        chain: "rema-1000",
        coverage_reason: "source_unavailable",
        coverage_state: "unknown",
        record_id: 202,
        scope_kind: "store_set",
        store_ids: ["store:7"],
      }),
    ]));

    await expect(new PostgresPlanningEvidenceReader(db).getMany([GTIN], AT)).resolves.toEqual({
      coverageChecks: [
        {
          canonicalProductId: "product:42",
          chainId: "bunnpris",
          checkedAt: "2026-07-16T11:30:00.000Z",
          contractVersion: 1,
          geographicScope: {
            countryCode: "NO",
            kind: "regions",
            regionCodes: ["NO-03"],
          },
          id: "coverage:201",
          sourceId: "licensed-feed",
          state: "known-not-carried",
        },
        {
          canonicalProductId: "product:42",
          chainId: "rema-1000",
          checkedAt: "2026-07-16T11:30:00.000Z",
          contractVersion: 1,
          geographicScope: { kind: "stores", storeIds: ["store:7"] },
          id: "coverage:202",
          sourceId: "licensed-feed",
          state: "source-unavailable",
        },
      ],
      historicalEligibleEvidenceIds: [],
      priceEvidence: [
        {
          amountOre: 2_490,
          chainId: "extra",
          contractVersion: 1,
          evidenceLevel: "observed",
          geographicScope: { countryCode: "NO", kind: "national" },
          id: "price:101",
          kind: "price-evidence",
          observedAt: "2026-07-16T11:00:00.000Z",
          priceKind: "ordinary",
          productMatch: { canonicalProductId: "product:42", kind: "exact" },
          sourceId: "licensed-feed",
          sourceRecordId: `source-record:${"a".repeat(64)}`,
        },
      ],
      products: [{ canonicalProductId: "product:42", gtin: GTIN }],
      sources: [{
        contractVersion: 1,
        displayName: "Licensed fixture",
        id: "licensed-feed",
        sourceClass: "ordinary-price",
        state: "approved",
      }],
    });

    expect(captures).toHaveLength(1);
    expect(captures[0]!.parameters).not.toContainEqual(expect.any(Date));
    expect(captures[0]!.parameters.slice(1).every(
      (value) => typeof value === "string" && value.endsWith("Z"),
    )).toBe(true);
    const query = captures[0]!.sql.replace(/\s+/g, " ").trim();
    expect(query).toContain("?::timestamptz");
    expect(query).toContain("select jsonb_array_elements_text(?::jsonb)");
    expect(query).toContain("from source_permissions");
    expect(query).toContain("ds.created_at <=");
    expect(query).toContain("ds.public_state_changed_at <=");
    expect(query).toContain("permission.created_at <=");
    expect(query).toContain("order by permission.created_at desc, permission.id desc");
    expect(query).not.toContain("order by permission.reviewed_at desc");
    expect(query).toContain("pi.public_state_changed_at <=");
    expect(query).toContain("cp.public_state_changed_at <=");
    expect(query).toContain("runtime_state = 'approved'");
    expect(query).toContain("permission_reviewed_at is not null");
    expect(query).toContain("permission_reviewed_at <=");
    expect(query).toContain("permission_expires_at is null");
    expect(query).toContain("ds.permission_reviewed_at = permission.reviewed_at");
    expect(query).toContain(
      "ds.permission_expires_at is not distinct from permission.valid_until",
    );
    expect(query).toContain("decision = 'approved'");
    expect(query).toContain("ordinaryPrice");
    expect(query).toContain("status = 'completed'");
    expect(query).toContain("run.created_at <=");
    expect(query).toContain("run.terminalized_at <=");
    expect(query).toContain("po.created_at <=");
    expect(query).toContain("coverage.created_at <=");
    expect(query).toContain("source_reference is not null");
    expect(query).toContain("raw_record_hash is not null");
    expect(query).toContain("and source.permissions @> '{\"ordinaryPrice\": true}'::jsonb and (");
    expect(query).toContain("po.claim_eligibility = 'ordinary_only'");
    expect(query).toContain("ordinaryPrice");
    expect(query).toContain("po.claim_eligibility = 'historical_eligible'");
    expect(query).toContain("priceHistory");
    expect(query).toContain("geographic_scope_regions");
    expect(query).toContain("geographic_scope_postal_codes");
    expect(query).toContain("gs.public_state_changed_at <=");
    expect(query).toContain("gsr.created_at <=");
    expect(query).toContain("gsp.created_at <=");
    expect(query).toContain("gss.created_at <=");
    expect(query).toContain("coverage.checked_at >=");
    expect(query).toContain("limit 10001");
  });

  it("partitions historical-eligible evidence without promoting ordinary-only rows", async () => {
    const { db } = databaseWith(() => resolved([
      productRow(),
      priceRow(),
      priceRow({
        claim_eligibility: "historical_eligible",
        observed_at: new Date("2026-07-15T11:00:00.000Z"),
        raw_record_hash: "b".repeat(64),
        record_id: 102,
      }),
    ]));

    const result = await new PostgresPlanningEvidenceReader(db).getMany([GTIN], AT);

    expect(result.priceEvidence.map(({ id }) => id)).toEqual(["price:101", "price:102"]);
    expect(result.historicalEligibleEvidenceIds).toEqual(["price:102"]);
  });

  it("normalizes raw timestamp text from the Drizzle-owned postgres client", async () => {
    const { db } = databaseWith(() => resolved([
      productRow(),
      priceRow({
        fetched_at: "2026-07-16 11:05:00+00",
        observed_at: "2026-07-16 11:00:00+00",
      }),
      coverageRow({ checked_at: "2026-07-16 11:30:00+00" }),
    ]));

    const result = await new PostgresPlanningEvidenceReader(db).getMany([GTIN], AT);

    expect(result.priceEvidence[0]?.observedAt).toBe("2026-07-16T11:00:00.000Z");
    expect(result.coverageChecks[0]?.checkedAt).toBe("2026-07-16T11:30:00.000Z");
  });

  it("normalizes safe bigint identifiers returned as text by postgres.js", async () => {
    const { db } = databaseWith(() => resolved([
      productRow({ product_id: "42" }),
      priceRow({ product_id: "42", record_id: "101" }),
      coverageRow({ product_id: "42", record_id: "201" }),
    ]));

    const result = await new PostgresPlanningEvidenceReader(db).getMany([GTIN], AT);

    expect(result.products).toEqual([{ canonicalProductId: "product:42", gtin: GTIN }]);
    expect(result.priceEvidence[0]?.id).toBe("price:101");
    expect(result.coverageChecks[0]?.id).toBe("coverage:201");
  });

  it("preserves requested GTIN aliases while deduplicating identical canonical evidence", async () => {
    const { db } = databaseWith(() => resolved([
      productRow(),
      productRow({ gtin: GTIN_ALIAS }),
      priceRow(),
      priceRow({ gtin: GTIN_ALIAS }),
      coverageRow(),
      coverageRow({ gtin: GTIN_ALIAS }),
    ]));

    const result = await new PostgresPlanningEvidenceReader(db).getMany(
      [GTIN, GTIN_ALIAS],
      AT,
    );

    expect(result.products).toEqual([
      { canonicalProductId: "product:42", gtin: GTIN },
      { canonicalProductId: "product:42", gtin: GTIN_ALIAS },
    ]);
    expect(result.priceEvidence.map(({ id }) => id)).toEqual(["price:101"]);
    expect(result.coverageChecks.map(({ id }) => id)).toEqual(["coverage:201"]);
  });

  it("preserves absent geography and reads authorized postal-set evidence", async () => {
    const { db } = databaseWith(() => resolved([
      productRow(),
      priceRow({ country_code: null, scope_kind: null, scope_status: null }),
      priceRow({
        postal_codes: ["0152", "0452"],
        record_id: 102,
        raw_record_hash: "b".repeat(64),
        scope_kind: "postal_set",
      }),
    ]));

    const result = await new PostgresPlanningEvidenceReader(db).getMany([GTIN], AT);
    expect(result.priceEvidence.map(({ geographicScope }) => geographicScope)).toEqual([
      { kind: "unknown", reason: "missing-geographic-scope" },
      {
        countryCode: "NO",
        kind: "postal-set",
        postalCodes: ["0152", "0452"],
      },
    ]);
  });

  it("ignores non-semantic coverage states rather than inventing absence", async () => {
    const { db } = databaseWith(() => resolved([
      productRow(),
      coverageRow({ coverage_state: "priced" }),
      coverageRow({ coverage_state: "unknown", coverage_reason: "ambiguous", record_id: 202 }),
    ]));

    const result = await new PostgresPlanningEvidenceReader(db).getMany([GTIN], AT);
    expect(result.coverageChecks).toEqual([]);
    expect(result.sources).toEqual([]);
  });

  it("rejects malformed, duplicate, empty, oversized, and non-finite requests before SQL", async () => {
    const { captures, db } = databaseWith(() => resolved([]));
    const reader = new PostgresPlanningEvidenceReader(db);
    const invalid: Array<[string[], Date]> = [
      [[], AT],
      [[GTIN, GTIN], AT],
      [["7038010000013"], AT],
      [Array.from({ length: 51 }, (_, index) => {
        const body = String(index + 1).padStart(12, "0");
        const sum = [...body].reduce(
          (total, digit, position) => total + Number(digit) * (position % 2 === 0 ? 1 : 3),
          0,
        );
        return `${body}${(10 - (sum % 10)) % 10}`;
      }), AT],
      [[GTIN], new Date("invalid")],
    ];
    for (const [gtins, at] of invalid) {
      await expect(reader.getMany(gtins, at)).rejects.toEqual(
        new PlanningEvidenceReaderError("INVALID_REQUEST"),
      );
    }
    expect(captures).toEqual([]);
  });

  it("fails closed for malformed rows, missing requested product mappings, and row overflow", async () => {
    const malformed = databaseWith(() => resolved([
      productRow(),
      priceRow({ source_kind: "mystery" }),
    ]));
    await expect(
      new PostgresPlanningEvidenceReader(malformed.db).getMany([GTIN], AT),
    ).rejects.toEqual(new PlanningEvidenceReaderError("UNAVAILABLE"));

    const unsafeIdentifier = databaseWith(() => resolved([
      productRow({ product_id: "9007199254740992" }),
    ]));
    await expect(
      new PostgresPlanningEvidenceReader(unsafeIdentifier.db).getMany([GTIN], AT),
    ).rejects.toEqual(new PlanningEvidenceReaderError("UNAVAILABLE"));

    const missingProduct = databaseWith(() => resolved([]));
    await expect(
      new PostgresPlanningEvidenceReader(missingProduct.db).getMany([GTIN], AT),
    ).rejects.toEqual(new PlanningEvidenceReaderError("UNAVAILABLE"));

    const overflow = databaseWith(() => resolved(
      Array.from({ length: 10_001 }, () => productRow()),
    ));
    await expect(
      new PostgresPlanningEvidenceReader(overflow.db).getMany([GTIN], AT),
    ).rejects.toEqual(new PlanningEvidenceReaderError("UNAVAILABLE"));
  });

  it("cancels the in-flight PostgreSQL query and bounds storage errors", async () => {
    let rejectQuery!: (error: Error) => void;
    const query = new Promise<TestRow[]>((_, reject) => { rejectQuery = reject; }) as TestQuery;
    query.cancel = vi.fn(() => rejectQuery(new Error("postgres://secret")));
    const pending = databaseWith(() => query);
    const controller = new AbortController();
    const read = new PostgresPlanningEvidenceReader(pending.db).getMany(
      [GTIN],
      AT,
      controller.signal,
    );
    controller.abort();
    await expect(read).rejects.toEqual(new PlanningEvidenceReaderError("CANCELLED"));
    expect(query.cancel).toHaveBeenCalledOnce();

    const failed = databaseWith(() => rejected(new Error("postgres://secret")));
    const unavailable = new PostgresPlanningEvidenceReader(failed.db).getMany([GTIN], AT);
    await expect(unavailable).rejects.toEqual(new PlanningEvidenceReaderError("UNAVAILABLE"));
    await expect(unavailable).rejects.not.toMatchObject({
      message: expect.stringContaining("secret"),
    });
  });
});
