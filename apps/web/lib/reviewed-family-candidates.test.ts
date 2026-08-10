// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  inspectReviewedFamilyCandidates,
  ReviewedFamilyCandidateClientError,
} from "./reviewed-family-candidates";

const request = {
  contractVersion: 2 as const,
  families: [{ allowedBrands: ["tine"], familyId: "family:melk" }],
};

const source = {
  contractVersion: 1 as const,
  displayName: "Publisert katalog",
  id: "catalog-source",
  sourceClass: "catalog" as const,
  state: "approved" as const,
};

const response = {
  candidateSets: [{
    allowedBrands: ["tine"],
    candidateProductIds: ["product:milk"],
    candidateSetId: `candidate-set:${"a".repeat(64)}`,
    complete: true as const,
    family: {
      aliases: ["mjølk"],
      id: "family:melk",
      labelNo: "Melk",
      slug: "melk",
      status: "active" as const,
    },
    familyId: "family:melk",
    taxonomyVersionId: "handleplan-reviewed-families@1.0.0",
  }],
  contractVersion: 2 as const,
  generatedAt: "2026-07-17T12:00:00.000Z",
  memberships: [{
    canonicalProductId: "product:milk",
    confidence: 100 as const,
    decision: "approved" as const,
    decisionId: "family-membership:11",
    familyId: "family:melk",
    method: "human-review" as const,
    reviewedAt: "2026-07-16T12:00:00.000Z",
    reviewerAttested: true as const,
  }],
  productClaims: [{
    canonicalProductId: "product:milk",
    product: {
      brand: "TINE",
      catalogEvidence: {
        observedAt: "2026-07-17T10:00:00.000Z",
        source,
        sourceRecordId: `source-record:${"b".repeat(64)}`,
      },
      displayName: "TINE Lettmelk",
      gtin: "7038010000010",
      packageMeasure: { amount: 1_000, unit: "ml" as const },
      unitsPerPack: 1,
    },
  }],
  sources: [source],
  taxonomy: {
    contentSha256: "1d917ee4268615ad510a622ea30d69977191cffc143313a7dbecbad37debf520",
    contractVersion: 1 as const,
    publishedAt: "2026-07-16T00:00:00.000Z",
    taxonomyId: "handleplan-reviewed-families",
    taxonomyVersion: "1.0.0",
    versionId: "handleplan-reviewed-families@1.0.0",
  },
};

afterEach(() => vi.unstubAllGlobals());

describe("reviewed-family candidate browser client", () => {
  it("posts only the bounded family selection and validates request-bound evidence", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(response), {
      headers: { "content-type": "application/json; charset=utf-8" },
    }));
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;

    await expect(inspectReviewedFamilyCandidates(request, signal)).resolves.toEqual(response);
    expect(fetch).toHaveBeenCalledWith("/api/plan-candidates", {
      body: expect.any(String),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal,
    });
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toEqual(request);
    expect(fetch.mock.calls[0]?.[1]?.body).not.toMatch(/query|price|reviewer|candidateProductIds/i);
  });

  it.each([
    [409, "STALE_OR_AMBIGUOUS"],
    [422, "NO_CANDIDATES"],
    [499, "CANCELLED"],
    [503, "UNAVAILABLE"],
  ] as const)("maps HTTP %s to %s without parsing backend details", async (status, code) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private backend detail", {
      status,
    })));

    await expect(inspectReviewedFamilyCandidates(request, new AbortController().signal))
      .rejects.toMatchObject({ code });
  });

  it("rejects malformed, oversized, or request-mismatched responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      ...response,
      candidateSets: [{ ...response.candidateSets[0], familyId: "family:brod" }],
    }), { headers: { "content-type": "application/json" } })));
    await expect(inspectReviewedFamilyCandidates(request, new AbortController().signal))
      .rejects.toBeInstanceOf(ReviewedFamilyCandidateClientError);

    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => { cancelled = true; },
      start: (controller) => controller.enqueue(new TextEncoder().encode("{}")),
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, {
      headers: {
        "content-length": String(128 * 1_024 + 1),
        "content-type": "application/json",
      },
    })));
    await expect(inspectReviewedFamilyCandidates(request, new AbortController().signal))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(cancelled).toBe(true);
  });

  it("maps an already-locked response body to a sanitized invalid response", async () => {
    const responseWithLockedBody = new Response("{}", {
      headers: { "content-type": "application/json" },
    });
    responseWithLockedBody.body?.getReader();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseWithLockedBody));

    await expect(inspectReviewedFamilyCandidates(request, new AbortController().signal))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
