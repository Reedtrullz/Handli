import { describe, expect, it, vi } from "vitest";

import type { HandleplanDatabase } from "./client";
import {
  PostgresReviewedFamilyReader,
  ReviewedFamilyReaderError,
  reviewedFamilyMatchFromRow,
  type ReviewedFamilyEligibilityRow,
} from "./reviewed-family-reader";

const AT = new Date("2026-07-17T12:00:00.000Z");
const FAMILY_ID = "family:melk";
const GTIN = "7038010000010";

interface CapturedQuery {
  parameters: unknown[];
  sql: string;
}

type TestQuery = Promise<unknown[]> & {
  cancel: ReturnType<typeof vi.fn>;
};

function row(
  overrides: Partial<ReviewedFamilyEligibilityRow> = {},
): ReviewedFamilyEligibilityRow {
  return {
    aliases: ["mjølk"],
    brand: "TINE",
    canonical_product_id: 7,
    catalog_last_seen_at: new Date("2026-07-17T10:00:00.000Z"),
    catalog_raw_record_hash: "a".repeat(64),
    catalog_runtime_state: "approved",
    catalog_source_display_name: "Catalog source",
    catalog_source_id: "catalog-source",
    catalog_source_kind: "catalog",
    confidence: 100,
    content_sha256: "b".repeat(64),
    contract_version: 1,
    decision: "approved",
    decision_id: "11",
    decision_method: "human_review",
    display_name: "TINE Lettmelk 1 %",
    family_id: FAMILY_ID,
    family_status: "active",
    gtin: GTIN,
    label_no: "Melk",
    package_amount: 1_000,
    package_unit: "ml",
    parent_family_id: null,
    permission_catalog: true,
    permission_decision: "approved",
    permission_id: 3,
    permission_reviewed_at: new Date("2026-07-16T00:00:00.000Z"),
    permission_valid_until: new Date("2026-08-16T00:00:00.000Z"),
    product_rank: 1,
    published_at: new Date("2026-07-16T00:00:00.000Z"),
    reviewed_at: new Date("2026-07-16T12:00:00.000Z"),
    reviewer_attested: true,
    rule_version: null,
    scheme: "ean13",
    slug: "melk",
    source_permission_expires_at: new Date("2026-08-16T00:00:00.000Z"),
    source_permission_reviewed_at: new Date("2026-07-16T00:00:00.000Z"),
    status: "active",
    taxonomy_id: "handleplan-reviewed-families",
    taxonomy_version: "1.0.0",
    units_per_pack: 1,
    verified_at: new Date("2026-07-17T10:00:00.000Z"),
    version_id: "handleplan-reviewed-families@1.0.0",
    ...overrides,
  };
}

function resolvedQuery(rows: unknown[]): TestQuery {
  const query = Promise.resolve(rows) as TestQuery;
  query.cancel = vi.fn();
  return query;
}

function rejectedQuery(error: Error): TestQuery {
  const query = Promise.reject(error) as TestQuery;
  query.cancel = vi.fn();
  return query;
}

function databaseWith(queryFactory: () => TestQuery): {
  captures: CapturedQuery[];
  db: HandleplanDatabase;
} {
  const captures: CapturedQuery[] = [];
  const client = (strings: TemplateStringsArray, ...parameters: unknown[]) => {
    captures.push({ parameters, sql: strings.join("?") });
    return queryFactory();
  };
  return { captures, db: { $client: client } as unknown as HandleplanDatabase };
}

function snapshotRow(
  identity: ReviewedFamilyEligibilityRow,
  matchRows: ReviewedFamilyEligibilityRow[],
  requestedOrder: number,
): Record<string, unknown> {
  return {
    aliases: identity.aliases,
    content_sha256: identity.content_sha256,
    contract_version: identity.contract_version,
    family_id: identity.family_id,
    family_status: identity.family_status,
    label_no: identity.label_no,
    match_rows: matchRows,
    parent_family_id: identity.parent_family_id,
    published_at: identity.published_at,
    requested_order: requestedOrder,
    slug: identity.slug,
    taxonomy_id: identity.taxonomy_id,
    taxonomy_version: identity.taxonomy_version,
    version_id: identity.version_id,
  };
}

function readerError(code: "CANCELLED" | "INVALID_REQUEST" | "UNAVAILABLE") {
  return {
    code,
    name: "ReviewedFamilyReaderError",
  };
}

describe("PostgresReviewedFamilyReader", () => {
  it("reads only the current reviewed publication and canonical-deduped eligible catalog", async () => {
    const deterministic = row({
      decision_id: "12",
      decision_method: "deterministic_rule",
      family_id: "family:kaffe",
      label_no: "Kaffe",
      reviewer_attested: false,
      rule_version: "coffee-rule@1",
      slug: "kaffe",
    });
    const milk = row();
    const { captures, db } = databaseWith(() => resolvedQuery([
      snapshotRow(milk, [milk], 1),
      snapshotRow(deterministic, [deterministic], 2),
    ]));

    await expect(
      new PostgresReviewedFamilyReader(db).getMany(
        [FAMILY_ID, "family:kaffe"],
        5,
        AT,
      ),
    ).resolves.toMatchObject([
      {
        canonicalProductId: "product:7",
        family: {
          aliases: ["mjølk"],
          id: FAMILY_ID,
          labelNo: "Melk",
          slug: "melk",
          status: "active",
        },
        membership: {
          confidence: 100,
          decision: "approved",
          decisionId: "family-membership:11",
          method: "human-review",
          reviewedAt: "2026-07-16T12:00:00.000Z",
          reviewerAttested: true,
        },
        product: { gtin: GTIN },
        taxonomy: {
          contractVersion: 1,
          taxonomyId: "handleplan-reviewed-families",
          taxonomyVersion: "1.0.0",
          versionId: "handleplan-reviewed-families@1.0.0",
        },
      },
      {
        family: { id: "family:kaffe", status: "active" },
        membership: {
          decision: "approved",
          method: "deterministic-rule",
          ruleVersion: "coffee-rule@1",
        },
      },
    ]);

    expect(captures).toHaveLength(1);
    const sql = captures[0]!.sql.replace(/\s+/g, " ").trim();
    expect(sql).toContain("with current_taxonomy as");
    expect(sql).toContain("from family_taxonomy_versions version");
    expect(sql).toContain("version.published_at <= ?");
    expect(sql).toContain("version.created_at <= ?");
    expect(sql).toContain("order by version.published_at desc, version.version_id desc");
    expect(sql).toContain("inner join reviewed_family_definitions family");
    expect(sql).toContain("family.status = 'active'");
    expect(sql).toContain("family.created_at <= ?");
    expect(sql).toContain("alias.created_at <= ?");
    expect(sql).toContain("inner join reviewed_family_membership_public decision");
    expect(sql).toContain("order by decision.reviewed_at desc, decision.id desc");
    expect(sql).toContain("decision_rank = 1");
    expect(sql).toContain("decision = 'approved'");
    expect(sql).toContain("confidence = 100");
    expect(sql).toContain("decision_method = 'human_review'");
    expect(sql).toContain("decision_method = 'deterministic_rule'");
    expect(sql).toContain("from approved_memberships membership");
    expect(sql).toContain("inner join catalog_observations observation");
    expect(sql).toContain("run.run_type = 'catalog'");
    expect(sql).toContain("run.status = 'completed'");
    expect(sql).toContain("run.created_at <= ?");
    expect(sql).toContain("run.terminalized_at <= ?");
    expect(sql).toContain("observation.created_at <= ?");
    expect(sql).toContain("source.created_at <= ?");
    expect(sql).toContain("source.public_state_changed_at <= ?");
    expect(sql).toContain("candidate.created_at <= ?");
    expect(sql).toContain("order by candidate.created_at desc, candidate.id desc");
    expect(sql).not.toContain("order by candidate.reviewed_at desc");
    expect(sql).toContain("permission.decision = 'approved'");
    expect(sql).toContain("source.permission_reviewed_at = permission.reviewed_at");
    expect(sql).toContain(
      "source.permission_expires_at is not distinct from permission.valid_until",
    );
    expect(sql).toContain("permission.permissions @> '{\"catalog\": true}'::jsonb");
    expect(sql).toContain("partition by membership.family_id, membership.product_id");
    expect(sql).toContain("observation.gtin asc");
    expect(sql).toContain("where alias_rank = 1");
    expect(sql).toContain("candidate.product_rank <= ?");
    expect(sql).not.toContain("product_family_memberships");
    expect(sql).not.toContain("from product_families");
    expect(captures[0]!.parameters).toContain(JSON.stringify([
      FAMILY_ID,
      "family:kaffe",
    ]));
    expect(captures[0]!.parameters).toContain(6);
    expect(captures[0]!.parameters).toContain(2);
  });

  it("rejects invalid, duplicate, empty, oversized, non-finite, and unbounded requests", async () => {
    const { captures, db } = databaseWith(() => resolvedQuery([]));
    const reader = new PostgresReviewedFamilyReader(db);
    const tooMany = Array.from({ length: 21 }, (_, index) => `family:f${index}`);
    const invalid: Array<[string[], number, Date]> = [
      [[], 1, AT],
      [[FAMILY_ID, FAMILY_ID], 1, AT],
      [["melk"], 1, AT],
      [tooMany, 1, AT],
      [[FAMILY_ID], 0, AT],
      [[FAMILY_ID], 21, AT],
      [[FAMILY_ID], 1.5, AT],
      [[FAMILY_ID], 1, new Date(Number.NaN)],
    ];

    for (const [families, limit, at] of invalid) {
      await expect(reader.getMany(families, limit, at)).rejects.toMatchObject(
        readerError("INVALID_REQUEST"),
      );
    }
    expect(captures).toHaveLength(0);
  });

  it("fails closed for malformed taxonomy, family, approval, and provenance rows", () => {
    const requested = new Set([FAMILY_ID]);
    const malformed: ReviewedFamilyEligibilityRow[] = [
      row({ version_id: "unversioned" }),
      row({ family_status: "retired" }),
      row({ decision: "candidate" }),
      row({ decision: "rejected" }),
      row({ reviewer_attested: false }),
      row({ decision_method: "deterministic_rule", reviewer_attested: false, rule_version: null }),
      row({ aliases: ["mjølk", "mjølk"] }),
      row({ aliases: ["Mjølk"] }),
      row({ aliases: ["melk"] }),
      row({ product_rank: 6 }),
    ];

    for (const candidate of malformed) {
      expect(() => reviewedFamilyMatchFromRow(candidate, requested, 5, AT)).toThrowError(
        ReviewedFamilyReaderError,
      );
    }
    expect(
      reviewedFamilyMatchFromRow(row({ confidence: 99 }), requested, 5, AT),
    ).toBeUndefined();
  });

  it("omits catalog rows that have become ineligible without disclosing why", () => {
    expect(
      reviewedFamilyMatchFromRow(
        row({ permission_decision: "revoked" }),
        new Set([FAMILY_ID]),
        5,
        AT,
      ),
    ).toBeUndefined();
  });

  it("distinguishes an unknown family from a known active family with no candidates", async () => {
    const milk = row();
    const { db } = databaseWith(() => resolvedQuery([
      snapshotRow(milk, [], 2),
    ]));

    await expect(
      new PostgresReviewedFamilyReader(db).getSnapshots(
        ["family:unknown", FAMILY_ID],
        5,
        AT,
      ),
    ).resolves.toMatchObject([
      {
        complete: false,
        familyId: "family:unknown",
        matches: [],
        state: "unknown",
      },
      {
        complete: true,
        family: { id: FAMILY_ID },
        familyId: FAMILY_ID,
        matches: [],
        state: "active",
      },
    ]);
  });

  it("fails closed when LIMIT plus one proves a family candidate set is incomplete", async () => {
    const identity = row({ product_rank: 1 });
    const { captures, db } = databaseWith(() => resolvedQuery([
      snapshotRow(identity, [
        identity,
        row({ canonical_product_id: 8, gtin: "96385074", product_rank: 2 }),
      ], 1),
    ]));

    await expect(
      new PostgresReviewedFamilyReader(db).getMany([FAMILY_ID], 1, AT),
    ).rejects.toMatchObject(readerError("UNAVAILABLE"));
    expect(captures[0]!.parameters).toContain(2);
  });

  it("cancels an in-flight query and normalizes backend failures", async () => {
    let rejectQuery: (reason: Error) => void = () => undefined;
    const pending = new Promise<unknown[]>((_, reject) => {
      rejectQuery = reject;
    }) as TestQuery;
    pending.cancel = vi.fn(() => rejectQuery(new Error("cancelled")));
    const { db } = databaseWith(() => pending);
    const controller = new AbortController();
    const result = new PostgresReviewedFamilyReader(db).getMany(
      [FAMILY_ID],
      5,
      AT,
      controller.signal,
    );
    controller.abort();

    await expect(result).rejects.toMatchObject(readerError("CANCELLED"));
    expect(pending.cancel).toHaveBeenCalledTimes(1);

    const unavailable = databaseWith(() => rejectedQuery(new Error("backend")));
    await expect(
      new PostgresReviewedFamilyReader(unavailable.db).getMany([FAMILY_ID], 5, AT),
    ).rejects.toMatchObject(readerError("UNAVAILABLE"));
  });
});
