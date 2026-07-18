import {
  ReviewedFamilyReaderError,
  type ReviewedFamilyCatalogMatch,
  type ReviewedFamilyReader,
  type ReviewedFamilySnapshot,
} from "@handleplan/db/reviewed-family-reader";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  FamilyCandidateService,
  FamilyCandidateServiceError,
} from "./family-candidate-service";

const NOW = new Date("2026-07-17T12:00:00.000Z");
const taxonomy = {
  contentSha256: "1d917ee4268615ad510a622ea30d69977191cffc143313a7dbecbad37debf520",
  contractVersion: 1 as const,
  publishedAt: "2026-07-16T00:00:00.000Z",
  taxonomyId: "handleplan-reviewed-families" as const,
  taxonomyVersion: "1.0.0",
  versionId: "handleplan-reviewed-families@1.0.0",
};

function withEan13CheckDigit(firstTwelve: string): string {
  const sum = [...firstTwelve].reduce((total, digit, index) =>
    total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  return `${firstTwelve}${(10 - (sum % 10)) % 10}`;
}

function match(
  familyId: string,
  familyLabel: string,
  canonicalIndex: number,
  brand = "TINE",
  overrides: Partial<ReviewedFamilyCatalogMatch> = {},
): ReviewedFamilyCatalogMatch {
  const gtin = withEan13CheckDigit(`704${canonicalIndex.toString().padStart(9, "0")}`);
  return {
    canonicalProductId: `product:${canonicalIndex}`,
    family: {
      aliases: [],
      id: familyId,
      labelNo: familyLabel,
      slug: familyId.slice("family:".length),
      status: "active",
    },
    membership: {
      confidence: 100,
      decision: "approved",
      decisionId: `family-membership:${canonicalIndex + 1}`,
      method: "human-review",
      reviewedAt: "2026-07-16T12:00:00.000Z",
      reviewerAttested: true,
    },
    product: {
      brand,
      catalogEvidence: {
        observedAt: "2026-07-17T10:00:00.000Z",
        source: {
          contractVersion: 1,
          displayName: "Fixture catalog",
          id: "catalog-source",
          sourceClass: "catalog",
          state: "approved",
        },
        sourceRecordId: `source-record:${canonicalIndex.toString(16).padStart(64, "0")}`,
      },
      displayName: `${familyLabel} ${canonicalIndex}`,
      gtin,
      packageMeasure: { amount: 1_000, unit: "ml" },
      unitsPerPack: 1,
    },
    taxonomy,
    ...overrides,
  };
}

function snapshot(
  familyId: string,
  familyLabel: string,
  matches: ReviewedFamilyCatalogMatch[],
): ReviewedFamilySnapshot {
  return {
    complete: true,
    family: {
      aliases: [],
      id: familyId,
      labelNo: familyLabel,
      slug: familyId.slice("family:".length),
      status: "active",
    },
    familyId,
    matches,
    state: "active",
    taxonomy,
  };
}

function readerReturning(
  result: ReviewedFamilySnapshot[] | Error,
): ReviewedFamilyReader & { getSnapshots: ReturnType<typeof vi.fn> } {
  const getSnapshots = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return {
    getMany: vi.fn(),
    getSnapshots,
  } as unknown as ReviewedFamilyReader & { getSnapshots: ReturnType<typeof vi.fn> };
}

function serviceError(code: FamilyCandidateServiceError["code"]) {
  return { code, name: "FamilyCandidateServiceError" };
}

describe("FamilyCandidateService", () => {
  it("supports an internal caller-supplied evaluation instant", async () => {
    const candidate = match("family:melk", "Melk", 1, "TINE");
    const reader = readerReturning([
      snapshot("family:melk", "Melk", [candidate]),
    ]);
    const service = new FamilyCandidateService({
      reader,
      now: () => { throw new Error("inspectAt must not recapture time"); },
    });

    const result = await service.inspectAt({
      contractVersion: 2,
      families: [{ familyId: "family:melk" }],
    }, NOW);

    expect(result.generatedAt).toBe(NOW.toISOString());
    expect(reader.getSnapshots).toHaveBeenCalledWith(
      ["family:melk"],
      20,
      NOW,
      undefined,
    );
  });

  it("batches canonical families once, narrows by normalized brand, and returns server-owned evidence", async () => {
    const coffee = match("family:kaffe", "Kaffe", 3, "Evergood");
    const tine = match("family:melk", "Melk", 1, "TINE");
    const q = match("family:melk", "Melk", 2, "Q-Meieriene");
    const reader = readerReturning([
      snapshot("family:kaffe", "Kaffe", [coffee]),
      snapshot("family:melk", "Melk", [q, tine]),
    ]);
    const service = new FamilyCandidateService({ reader, now: () => NOW });

    const result = await service.inspect({
      contractVersion: 2,
      families: [
        { allowedBrands: [" TINE ", "tine"], familyId: "family:melk" },
        { familyId: "family:kaffe" },
      ],
    });

    expect(reader.getSnapshots).toHaveBeenCalledTimes(1);
    expect(reader.getSnapshots).toHaveBeenCalledWith(
      ["family:kaffe", "family:melk"],
      20,
      NOW,
      undefined,
    );
    expect(result.generatedAt).toBe(NOW.toISOString());
    expect(result.candidateSets.map(({ familyId }) => familyId)).toEqual([
      "family:kaffe",
      "family:melk",
    ]);
    expect(result.candidateSets[1]).toMatchObject({
      allowedBrands: ["tine"],
      candidateProductIds: ["product:1"],
      complete: true,
      family: { id: "family:melk", labelNo: "Melk" },
      taxonomyVersionId: taxonomy.versionId,
    });
    expect(result.candidateSets[1]?.candidateSetId).toMatch(
      /^candidate-set:[0-9a-f]{64}$/,
    );
    expect(result.productClaims.map(({ canonicalProductId }) => canonicalProductId)).toEqual([
      "product:1",
      "product:3",
    ]);
    expect(result.memberships).toEqual([
      expect.objectContaining({
        canonicalProductId: "product:3",
        familyId: "family:kaffe",
        reviewerAttested: true,
      }),
      expect.objectContaining({
        canonicalProductId: "product:1",
        familyId: "family:melk",
        reviewerAttested: true,
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("reviewerId");
    expect(result.sources).toEqual([coffee.product.catalogEvidence.source]);
  });

  it("distinguishes unknown, known-empty, and brand-filtered-empty families", async () => {
    const unknown = readerReturning([{
      complete: false,
      familyId: "family:ukjent",
      matches: [],
      state: "unknown",
    }]);
    await expect(new FamilyCandidateService({ reader: unknown, now: () => NOW }).inspect({
      contractVersion: 2,
      families: [{ familyId: "family:ukjent" }],
    })).rejects.toMatchObject(serviceError("UNKNOWN_FAMILY"));

    const empty = readerReturning([snapshot("family:melk", "Melk", [])]);
    await expect(new FamilyCandidateService({ reader: empty, now: () => NOW }).inspect({
      contractVersion: 2,
      families: [{ familyId: "family:melk" }],
    })).rejects.toMatchObject(serviceError("FAMILY_NO_CANDIDATES"));

    const branded = readerReturning([
      snapshot("family:melk", "Melk", [match("family:melk", "Melk", 1, "TINE")]),
    ]);
    await expect(new FamilyCandidateService({ reader: branded, now: () => NOW }).inspect({
      contractVersion: 2,
      families: [{ allowedBrands: ["Q-Meieriene"], familyId: "family:melk" }],
    })).rejects.toMatchObject(serviceError("NO_MATCHING_BRANDS"));
  });

  it("fails closed for incomplete, ambiguous, and oversized candidate evidence", async () => {
    const incomplete = readerReturning([{
      complete: false,
      family: {
        aliases: [], id: "family:melk", labelNo: "Melk", slug: "melk", status: "active",
      },
      familyId: "family:melk",
      matches: [],
      state: "active",
      taxonomy,
    } as unknown as ReviewedFamilySnapshot]);
    await expect(new FamilyCandidateService({ reader: incomplete, now: () => NOW }).inspect({
      contractVersion: 2,
      families: [{ familyId: "family:melk" }],
    })).rejects.toMatchObject(serviceError("CANDIDATE_SET_INCOMPLETE"));

    const shared = match("family:kaffe", "Kaffe", 1, "Evergood");
    const ambiguous = readerReturning([
      snapshot("family:kaffe", "Kaffe", [shared]),
      snapshot("family:melk", "Melk", [{
        ...shared,
        family: { aliases: [], id: "family:melk", labelNo: "Melk", slug: "melk", status: "active" },
      }]),
    ]);
    await expect(new FamilyCandidateService({ reader: ambiguous, now: () => NOW }).inspect({
      contractVersion: 2,
      families: [{ familyId: "family:kaffe" }, { familyId: "family:melk" }],
    })).rejects.toMatchObject(serviceError("AMBIGUOUS_FAMILY_MEMBERSHIP"));

    const tooMany = readerReturning([
      snapshot("family:brod", "Brød", Array.from({ length: 17 }, (_, index) =>
        match("family:brod", "Brød", index + 1, "Bakehuset"))),
      snapshot("family:kaffe", "Kaffe", Array.from({ length: 17 }, (_, index) =>
        match("family:kaffe", "Kaffe", index + 101, "Evergood"))),
      snapshot("family:melk", "Melk", Array.from({ length: 17 }, (_, index) =>
        match("family:melk", "Melk", index + 201, "TINE"))),
    ]);
    await expect(new FamilyCandidateService({ reader: tooMany, now: () => NOW }).inspect({
      contractVersion: 2,
      families: [
        { familyId: "family:brod" },
        { familyId: "family:kaffe" },
        { familyId: "family:melk" },
      ],
    })).rejects.toMatchObject(serviceError("CANDIDATE_SET_TOO_LARGE"));
  });

  it("rejects stale or malformed public evidence instead of serializing it", async () => {
    const stale = match("family:melk", "Melk", 1, "TINE", {
      product: {
        ...match("family:melk", "Melk", 1).product,
        catalogEvidence: {
          ...match("family:melk", "Melk", 1).product.catalogEvidence,
          observedAt: "2026-07-15T11:59:59.999Z",
        },
      },
    });
    const staleReader = readerReturning([snapshot("family:melk", "Melk", [stale])]);
    await expect(new FamilyCandidateService({ reader: staleReader, now: () => NOW }).inspect({
      contractVersion: 2,
      families: [{ familyId: "family:melk" }],
    })).rejects.toMatchObject(serviceError("EVIDENCE_UNAVAILABLE"));

    const malformed = match("family:melk", "Melk", 1, "TINE", {
      membership: {
        ...match("family:melk", "Melk", 1).membership,
        decisionId: "private-reviewer-id",
      },
    });
    const malformedReader = readerReturning([snapshot("family:melk", "Melk", [malformed])]);
    await expect(new FamilyCandidateService({ reader: malformedReader, now: () => NOW }).inspect({
      contractVersion: 2,
      families: [{ familyId: "family:melk" }],
    })).rejects.toMatchObject(serviceError("EVIDENCE_UNAVAILABLE"));
  });

  it("normalizes reader failure and preserves cancellation", async () => {
    const unavailable = readerReturning(new ReviewedFamilyReaderError("UNAVAILABLE"));
    await expect(new FamilyCandidateService({ reader: unavailable, now: () => NOW }).inspect({
      contractVersion: 2,
      families: [{ familyId: "family:melk" }],
    })).rejects.toMatchObject(serviceError("EVIDENCE_UNAVAILABLE"));

    const cancelled = readerReturning(new ReviewedFamilyReaderError("CANCELLED"));
    await expect(new FamilyCandidateService({ reader: cancelled, now: () => NOW }).inspect({
      contractVersion: 2,
      families: [{ familyId: "family:melk" }],
    })).rejects.toMatchObject(serviceError("REQUEST_CANCELLED"));

    const controller = new AbortController();
    controller.abort();
    const untouched = readerReturning([]);
    await expect(new FamilyCandidateService({ reader: untouched, now: () => NOW }).inspect({
      contractVersion: 2,
      families: [{ familyId: "family:melk" }],
    }, controller.signal)).rejects.toMatchObject(serviceError("REQUEST_CANCELLED"));
    expect(untouched.getSnapshots).not.toHaveBeenCalled();
  });
});
