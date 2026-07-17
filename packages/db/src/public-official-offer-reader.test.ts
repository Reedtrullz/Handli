import { describe, expect, it, vi } from "vitest";

import type { HandleplanDatabase } from "./client";
import {
  PostgresPublicOfficialOfferReader,
  type PublicOfficialOfferRow,
} from "./public-official-offer-reader";

const AT = new Date("2026-07-17T12:00:00.000Z");

interface CapturedQuery {
  parameters: unknown[];
  sql: string;
}

type TestQuery = Promise<unknown[]> & { cancel: ReturnType<typeof vi.fn> };

function resolvedQuery(rows: unknown[]): TestQuery {
  const query = Promise.resolve(rows) as TestQuery;
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
    { array: vi.fn((values: unknown[]) => values) },
  );
  return {
    captures,
    db: { $client: client } as unknown as HandleplanDatabase,
  };
}

function row(overrides: Partial<PublicOfficialOfferRow> = {}): PublicOfficialOfferRow {
  return {
    amount_ore: 2_000,
    before_amount_ore: 3_000,
    captured_at: new Date("2026-07-17T10:00:00.000Z"),
    chain: "extra",
    channels: ["in-store"],
    geographic_scope: { countryCode: "NO", kind: "national" },
    member_program_id: null,
    membership_requirement: "public",
    multibuy_group_amount_ore: null,
    multibuy_quantity: null,
    offer_id: "7",
    product_id: "42",
    product_offer_count: "1",
    source_display_name: "Reviewed weekly offers",
    source_id: "extra-offers",
    source_record_id: `official-source-record:${"a".repeat(64)}`,
    total_offer_count: "1",
    valid_from: new Date("2026-07-17T00:00:00.000Z"),
    valid_until: new Date("2026-07-20T00:00:00.000Z"),
    ...overrides,
  };
}

function readerError(code: "CANCELLED" | "INVALID_REQUEST" | "UNAVAILABLE") {
  return expect.objectContaining({ code, name: "PublicOfficialOfferReaderError" });
}

describe("PostgresPublicOfficialOfferReader", () => {
  it("uses only the bounded public function and maps a reviewed exact-product offer", async () => {
    const { captures, db } = databaseWith(() => resolvedQuery([row()]));

    await expect(new PostgresPublicOfficialOfferReader(db).getMany(["product:42"], AT))
      .resolves.toEqual({
        offers: [{
          applicability: {
            channels: ["in-store"],
            contractVersion: 1,
            endsAt: "2026-07-20T00:00:00.000Z",
            geographicScope: { countryCode: "NO", kind: "national" },
            startsAt: "2026-07-17T00:00:00.000Z",
          },
          beforePriceOre: 3_000,
          capturedAt: "2026-07-17T10:00:00.000Z",
          chainId: "extra",
          conditions: [{ kind: "public" }],
          contractVersion: 1,
          evidenceLevel: "reviewed",
          id: "official-offer:7",
          kind: "official-offer",
          pricing: { kind: "unit", unitPriceOre: 2_000 },
          productMatch: { canonicalProductId: "product:42", kind: "exact" },
          sourceId: "extra-offers",
          sourceRecordId: `official-source-record:${"a".repeat(64)}`,
        }],
        sources: [{
          contractVersion: 1,
          displayName: "Reviewed weekly offers",
          id: "extra-offers",
          sourceClass: "offer",
          state: "approved",
        }],
      });

    expect(captures).toHaveLength(1);
    expect(captures[0]!.sql).toContain("from public.public_official_offer_rows_v1(");
    expect(captures[0]!.sql).not.toMatch(
      /\b(?:approved_offers|offer_conditions|publications|publication_captures|extraction_runs|review_actions|source_permissions)\b/u,
    );
    expect(captures[0]!.parameters).toContain("{42}");
    expect(captures[0]!.parameters).toContain(AT.toISOString());
  });

  it("maps canonical reverse-order channels, member identity, multibuy, and store IDs", async () => {
    const programId = "m".repeat(200);
    const { db } = databaseWith(() => resolvedQuery([row({
      amount_ore: 1_667,
      before_amount_ore: 2_000,
      channels: ["online", "in-store"],
      geographic_scope: { kind: "stores", storeIds: ["9", "2"] },
      member_program_id: programId,
      membership_requirement: "member",
      multibuy_group_amount_ore: 5_000,
      multibuy_quantity: 3,
    })]));

    const result = await new PostgresPublicOfficialOfferReader(db).getMany(["product:42"], AT);

    expect(result.offers[0]).toMatchObject({
      applicability: {
        channels: ["in-store", "online"],
        geographicScope: { kind: "stores", storeIds: ["store:2", "store:9"] },
      },
      conditions: [
        { kind: "member", programId },
        { kind: "minimum-quantity", quantity: 3 },
      ],
      pricing: { kind: "multibuy", quantity: 3, totalOre: 5_000 },
    });
  });

  it("returns an empty authoritative snapshot when no official offer is eligible", async () => {
    const { db } = databaseWith(() => resolvedQuery([]));
    await expect(new PostgresPublicOfficialOfferReader(db).getMany(["product:42"], AT))
      .resolves.toEqual({ offers: [], sources: [] });
  });

  it.each([
    ["unrequested product", [row({ product_id: "43" })]],
    ["duplicate offer ID", [
      row({ product_offer_count: "2", total_offer_count: "2" }),
      row({ product_offer_count: "2", total_offer_count: "2" }),
    ]],
    ["conflicting source metadata", [
      row({ product_offer_count: "2", total_offer_count: "2" }),
      row({
        offer_id: "8",
        product_offer_count: "2",
        source_display_name: "Conflicting name",
        total_offer_count: "2",
      }),
    ]],
    ["bad total count", [row({ total_offer_count: "2" })]],
    ["per-product overflow sentinel", [row({ product_offer_count: "51" })]],
    ["global overflow sentinel", [row({ total_offer_count: "501" })]],
    ["future capture", [row({ captured_at: new Date("2026-07-17T12:00:00.001Z") })]],
    ["noncanonical member program", [row({
      member_program_id: " member ",
      membership_requirement: "member",
    })]],
    ["incomplete multibuy", [row({ multibuy_quantity: 3 })]],
    ["multibuy unit rounding mismatch", [row({
      amount_ore: 1_666,
      before_amount_ore: 2_000,
      multibuy_group_amount_ore: 5_000,
      multibuy_quantity: 3,
    })]],
    ["multibuy before-price below group total", [row({
      amount_ore: 1_667,
      before_amount_ore: 1_000,
      multibuy_group_amount_ore: 5_000,
      multibuy_quantity: 3,
    })]],
    ["oversized multibuy quantity", [row({
      amount_ore: 20,
      multibuy_group_amount_ore: 2_000,
      multibuy_quantity: 101,
    })]],
    ["unsafe multibuy comparison", [row({
      before_amount_ore: 2_147_483_647,
      multibuy_group_amount_ore: 2_147_483_647,
      multibuy_quantity: 2_147_483_647,
    })]],
  ] as const)("fails closed on %s", async (_label, rows) => {
    const { db } = databaseWith(() => resolvedQuery([...rows]));
    await expect(new PostgresPublicOfficialOfferReader(db).getMany(["product:42"], AT))
      .rejects.toEqual(readerError("UNAVAILABLE"));
  });

  it("fails closed before returning a 101st distinct offer source", async () => {
    const productIds = ["42", "43", "44"] as const;
    const counts = new Map([["42", 40], ["43", 40], ["44", 21]]);
    const rows = Array.from({ length: 101 }, (_, index) => {
      const productId = productIds[Math.floor(index / 40)]!;
      return row({
        offer_id: String(index + 1),
        product_id: productId,
        product_offer_count: String(counts.get(productId)),
        source_display_name: `Offer source ${index + 1}`,
        source_id: `offer-source-${index + 1}`,
        total_offer_count: "101",
      });
    });
    const { db } = databaseWith(() => resolvedQuery(rows));

    await expect(new PostgresPublicOfficialOfferReader(db).getMany(
      ["product:42", "product:43", "product:44"],
      AT,
    )).rejects.toEqual(readerError("UNAVAILABLE"));
  });

  it.each([
    [[], AT],
    [["product:0"], AT],
    [["product:01"], AT],
    [["product:42", "product:42"], AT],
    [["product:42"], new Date(Number.NaN)],
    [Array.from({ length: 51 }, (_, index) => `product:${index + 1}`), AT],
  ] as const)("rejects invalid public projection input", async (ids, at) => {
    const { db } = databaseWith(() => resolvedQuery([]));
    await expect(new PostgresPublicOfficialOfferReader(db).getMany(ids, at))
      .rejects.toEqual(readerError("INVALID_REQUEST"));
  });

  it("cancels the database query without exposing a backend error", async () => {
    const query = new Promise<unknown[]>((_, reject) => {
      setTimeout(() => reject(new Error("private backend detail")), 5);
    }) as TestQuery;
    query.cancel = vi.fn();
    const { db } = databaseWith(() => query);
    const controller = new AbortController();
    const pending = new PostgresPublicOfficialOfferReader(db)
      .getMany(["product:42"], AT, controller.signal);
    controller.abort();

    await expect(pending).rejects.toEqual(readerError("CANCELLED"));
    expect(query.cancel).toHaveBeenCalledOnce();
  });

  it("sanitizes database failures", async () => {
    const query = Promise.reject(new Error("relation private_table secret")) as TestQuery;
    query.cancel = vi.fn();
    const { db } = databaseWith(() => query);

    await expect(new PostgresPublicOfficialOfferReader(db).getMany(["product:42"], AT))
      .rejects.toEqual(readerError("UNAVAILABLE"));
  });
});
