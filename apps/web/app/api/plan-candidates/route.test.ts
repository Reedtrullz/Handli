import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  FamilyCandidateServiceError,
  type FamilyCandidateServiceContract,
} from "../../../lib/server/family-candidate-service";
import { createPlanCandidatesHandler } from "./route";

const requestBody = {
  contractVersion: 2,
  families: [{ allowedBrands: [" TINE ", "tine"], familyId: "family:melk" }],
};

const source = {
  contractVersion: 1 as const,
  displayName: "Fixture catalog",
  id: "catalog-source",
  sourceClass: "catalog" as const,
  state: "approved" as const,
};

const responseBody = {
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

function request(
  value: unknown = requestBody,
  headers: HeadersInit = { "content-type": "application/json" },
  signal?: AbortSignal,
): Request {
  return new Request("https://handleplan.no/api/plan-candidates", {
    body: JSON.stringify(value),
    headers,
    method: "POST",
    signal,
  });
}

function streamingRequest(
  chunks: Uint8Array[],
  onCancel?: (reason: unknown) => void,
  keepOpen = false,
): Request {
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    cancel: onCancel,
    pull(controller) {
      const chunk = chunks[index];
      if (chunk === undefined) {
        if (!keepOpen) controller.close();
        return;
      }
      controller.enqueue(chunk);
      index += 1;
      if (!keepOpen && index === chunks.length) controller.close();
    },
  });
  return new Request("https://handleplan.no/api/plan-candidates", {
    body: stream,
    headers: { "content-type": "application/json" },
    method: "POST",
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("POST /api/plan-candidates", () => {
  it("returns a request-bound strict public response without caching", async () => {
    const inspect = vi.fn(async () => responseBody);
    const response = await createPlanCandidatesHandler(() => ({ inspect }))(
      request(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(inspect).toHaveBeenCalledWith({
      contractVersion: 2,
      families: [{ allowedBrands: ["tine"], familyId: "family:melk" }],
    }, expect.any(AbortSignal));
    await expect(response.json()).resolves.toEqual(responseBody);
  });

  it("requires the exact candidate-inspection contract version and rejects authority injection", async () => {
    const inspect = vi.fn();
    const handler = createPlanCandidatesHandler(() => ({ inspect }));
    const cases: Array<[unknown, number, string]> = [
      [{ families: [{ familyId: "family:melk" }] }, 400, "CONTRACT_VERSION_REQUIRED"],
      [{ ...requestBody, contractVersion: 1 }, 400, "UNSUPPORTED_CONTRACT_VERSION"],
      [{ ...requestBody, contractVersion: 3 }, 400, "UNSUPPORTED_CONTRACT_VERSION"],
      [{
        ...requestBody,
        families: [{ familyId: "family:melk", reviewerId: "private-user" }],
      }, 400, "INVALID_REQUEST"],
      [{
        ...requestBody,
        families: [{ familyId: "family:melk", candidates: ["product:milk"] }],
      }, 400, "INVALID_REQUEST"],
    ];

    for (const [body, status, code] of cases) {
      const response = await handler(request(body));
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      await expect(response.json()).resolves.toEqual({ code });
    }
    expect(inspect).not.toHaveBeenCalled();
  });

  it("accepts only bounded UTF-8 JSON request bodies", async () => {
    const handler = createPlanCandidatesHandler(() => ({ inspect: vi.fn() }));
    const unsupported = await handler(request(requestBody, { "content-type": "text/plain" }));
    expect(unsupported.status).toBe(415);
    await expect(unsupported.json()).resolves.toEqual({ code: "UNSUPPORTED_MEDIA_TYPE" });

    const declaredLarge = await handler(request(requestBody, {
      "content-length": String(64 * 1024 + 1),
      "content-type": "application/json",
    }));
    expect(declaredLarge.status).toBe(413);
    await expect(declaredLarge.json()).resolves.toEqual({ code: "REQUEST_TOO_LARGE" });

    const cancelled = vi.fn();
    const streamedLarge = await handler(streamingRequest([
      new Uint8Array(64 * 1024),
      new Uint8Array([1]),
    ], cancelled, true));
    expect(streamedLarge.status).toBe(413);
    expect(cancelled).toHaveBeenCalledTimes(1);
    await expect(streamedLarge.json()).resolves.toEqual({ code: "REQUEST_TOO_LARGE" });

    const malformed = await handler(new Request("https://handleplan.no/api/plan-candidates", {
      body: "{",
      headers: { "content-type": "application/json" },
      method: "POST",
    }));
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ code: "INVALID_REQUEST" });
  });

  it("bounds body ingestion and candidate inspection with one server deadline", async () => {
    vi.useFakeTimers();
    try {
      const getService = vi.fn<() => FamilyCandidateServiceContract>();
      const cancelled = vi.fn();
      const bodyPending = createPlanCandidatesHandler(getService, { timeoutMs: 25 })(
        streamingRequest([], cancelled, true),
      );
      await vi.advanceTimersByTimeAsync(25);
      const bodyTimeout = await bodyPending;

      expect(bodyTimeout.status).toBe(503);
      expect(await bodyTimeout.json()).toEqual({ code: "REQUEST_TIMEOUT" });
      expect(cancelled).toHaveBeenCalledOnce();
      expect(getService).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);

      let seenSignal: AbortSignal | undefined;
      const inspectionPending = createPlanCandidatesHandler(() => ({
        inspect: async (_input, signal) => {
          seenSignal = signal;
          return new Promise<never>(() => undefined);
        },
      }), { timeoutMs: 25 })(request());
      await vi.advanceTimersByTimeAsync(25);
      const inspectionTimeout = await inspectionPending;

      expect(inspectionTimeout.status).toBe(503);
      expect(await inspectionTimeout.json()).toEqual({ code: "REQUEST_TIMEOUT" });
      expect(seenSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["INVALID_REQUEST", 400],
    ["UNKNOWN_FAMILY", 422],
    ["FAMILY_NO_CANDIDATES", 422],
    ["NO_MATCHING_BRANDS", 422],
    ["CANDIDATE_SET_TOO_LARGE", 422],
    ["AMBIGUOUS_FAMILY_MEMBERSHIP", 409],
    ["CANDIDATE_SET_INCOMPLETE", 503],
    ["EVIDENCE_UNAVAILABLE", 503],
    ["REQUEST_CANCELLED", 499],
  ] as const)("maps %s to a sanitized stable response", async (code, status) => {
    const response = await createPlanCandidatesHandler(() => ({
      inspect: async () => {
        throw new FamilyCandidateServiceError(code);
      },
    }))(request());

    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ code });
  });

  it("keeps genuine client cancellation distinct and never exposes backend details", async () => {
    const controller = new AbortController();
    controller.abort();
    const inspect = vi.fn();
    const cancelled = await createPlanCandidatesHandler(() => ({ inspect }))(
      request(requestBody, { "content-type": "application/json" }, controller.signal),
    );
    expect(cancelled.status).toBe(499);
    expect(await cancelled.json()).toEqual({ code: "REQUEST_CANCELLED" });
    expect(inspect).not.toHaveBeenCalled();

    const unexpected = await createPlanCandidatesHandler(() => ({
      inspect: async () => {
        throw new Error("postgresql://secret@private.internal:5432/handleplan");
      },
    }))(request());
    expect(unexpected.status).toBe(503);
    expect(await unexpected.text()).toBe('{"code":"EVIDENCE_UNAVAILABLE"}');
  });

  it("rejects a malformed service response at the public boundary", async () => {
    const response = await createPlanCandidatesHandler(() => ({
      inspect: async () => ({
        ...responseBody,
        memberships: [{ ...responseBody.memberships[0], reviewerId: "private-user" }],
      }) as unknown as Awaited<ReturnType<FamilyCandidateServiceContract["inspect"]>>,
    }))(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ code: "EVIDENCE_UNAVAILABLE" });
  });
});
