import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createCandidateSetId } from "./candidate-set";

const taxonomy = {
  contentSha256: "1d917ee4268615ad510a622ea30d69977191cffc143313a7dbecbad37debf520",
  contractVersion: 1 as const,
  publishedAt: "2026-07-16T00:00:00.000Z",
  taxonomyId: "handleplan-reviewed-families",
  taxonomyVersion: "1.0.0",
  versionId: "handleplan-reviewed-families@1.0.0",
};

const membership = {
  canonicalProductId: "product:milk",
  confidence: 100 as const,
  decision: "approved" as const,
  decisionId: "family-membership:11",
  familyId: "family:melk",
  method: "human-review" as const,
  reviewedAt: "2026-07-16T12:00:00.000Z",
  reviewerAttested: true as const,
};

const product = {
  brand: "TINE",
  catalogEvidence: {
    observedAt: "2026-07-17T10:00:00.000Z",
    source: {
      contractVersion: 1 as const,
      displayName: "Fixture catalog",
      id: "catalog-source",
      sourceClass: "catalog" as const,
      state: "approved" as const,
    },
    sourceRecordId: `source-record:${"a".repeat(64)}`,
  },
  displayName: "TINE Lettmelk",
  gtin: "7038010000010",
  packageMeasure: { amount: 1_000, unit: "ml" as const },
  unitsPerPack: 1,
};

const input = {
  allowedBrands: ["tine"],
  candidates: [{
    canonicalProductId: "product:milk",
    membership,
    product,
  }],
  familyId: "family:melk",
  taxonomy,
};

describe("createCandidateSetId", () => {
  it("creates a deterministic namespaced SHA-256 digest", () => {
    const first = createCandidateSetId(input);
    const second = createCandidateSetId(input);

    expect(first).toMatch(/^candidate-set:[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });

  it("does not change for display, retrieval-time, or catalog-source presentation updates", () => {
    const changedPresentation = createCandidateSetId({
      ...input,
      candidates: [{
        ...input.candidates[0],
        product: {
          ...product,
          catalogEvidence: {
            ...product.catalogEvidence,
            observedAt: "2026-07-17T11:00:00.000Z",
            source: {
              ...product.catalogEvidence.source,
              displayName: "Renamed catalog",
            },
          },
          displayName: "Updated product label",
        },
      }],
    });

    expect(changedPresentation).toBe(createCandidateSetId(input));
  });

  it("changes for taxonomy, selection, product, package, brand, or membership facts", () => {
    const baseline = createCandidateSetId(input);
    const variants = [
      { ...input, allowedBrands: undefined },
      { ...input, taxonomy: { ...taxonomy, contentSha256: "b".repeat(64) } },
      {
        ...input,
        familyId: "family:kaffe",
        candidates: [{
          ...input.candidates[0],
          membership: { ...membership, familyId: "family:kaffe" },
        }],
      },
      {
        ...input,
        candidates: [{
          ...input.candidates[0],
          canonicalProductId: "product:milk-new",
          membership: {
            ...membership,
            canonicalProductId: "product:milk-new",
          },
        }],
      },
      {
        ...input,
        candidates: [{
          ...input.candidates[0],
          product: { ...product, brand: "Q-Meieriene" },
        }],
      },
      {
        ...input,
        candidates: [{
          ...input.candidates[0],
          product: {
            ...product,
            packageMeasure: { amount: 1_500, unit: "ml" as const },
          },
        }],
      },
      {
        ...input,
        candidates: [{
          ...input.candidates[0],
          membership: { ...membership, decisionId: "family-membership:12" },
        }],
      },
    ];

    for (const variant of variants) {
      expect(createCandidateSetId(variant)).not.toBe(baseline);
    }
  });
});
