import {
  deriveExactProductPlanDeltaExplanationsV1,
  exactProductPlanApiEvidenceEnvelopeSchema,
  type ExactProductPlanApiRequest,
  planResultV2Schema,
  type PlanResultV2,
  type ReviewedFamilyPlanApiRequestV2,
} from "@handleplan/domain";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createServerContainer } from "../../../lib/server/container";
import { FamilyCandidateServiceError } from "../../../lib/server/family-candidate-service";
import type { PlanServiceContract } from "../../../lib/server/plan-service";
import {
  CatalogUnavailableError,
  PlanRequestCancelledError,
  PriceDataUnavailableError,
  ReviewedFamilyPlanError,
  UnknownExactProductError,
} from "../../../lib/server/plan-service";
import { createPlansHandler, PLAN_CAVEATS } from "./route";

const unusedCalculateReviewed: PlanServiceContract["calculateReviewed"] = async () => {
  throw new Error("reviewed planning must not be called by this exact-contract test");
};

function serviceWithExact(
  calculateExact: PlanServiceContract["calculateExact"],
): PlanServiceContract {
  return { calculateExact, calculateReviewed: unusedCalculateReviewed };
}

function serviceWithReviewed(
  calculateReviewed: PlanServiceContract["calculateReviewed"],
): PlanServiceContract {
  return { calculateExact: vi.fn(), calculateReviewed };
}

const body = {
  matchingRules: [
    {
      exactEan: "7038010000010",
      explanation: "Nøyaktig produkt",
      id: "melk-exact",
      mode: "exact",
      userApproved: true,
    },
  ],
  maxStores: 3,
  needs: [
    {
      id: "melk",
      matchRuleId: "melk-exact",
      query: "melk",
      quantity: 1,
      quantityUnit: "each",
      required: true,
    },
  ],
  products: [{ ean: "7038010000010", name: "Tine Lettmelk 1 %" }],
};

const exactBody: ExactProductPlanApiRequest = {
  contractVersion: 1,
  enabledMembershipProgramIds: [],
  marketContext: { contractVersion: 1, countryCode: "NO", kind: "national" },
  maxStores: 3,
  needs: [
    {
      id: "melk",
      match: {
        kind: "exact-product",
        product: { kind: "gtin", value: "7038010000010" },
        userApproved: true,
      },
      quantity: 1,
      quantityUnit: "each",
      required: true,
    },
  ],
};

const reviewedBody: ReviewedFamilyPlanApiRequestV2 = {
  contractVersion: 2,
  enabledMembershipProgramIds: [],
  marketContext: { contractVersion: 1, countryCode: "NO", kind: "national" },
  maxStores: 2,
  needs: [{
    id: "need:milk",
    match: {
      confirmation: {
        candidateSetId: `candidate-set:${"a".repeat(64)}`,
        taxonomyVersionId: "handleplan-reviewed-families@1.0.0",
        userApproved: true,
      },
      familyId: "family:melk",
      kind: "reviewed-family",
    },
    quantity: 1,
    quantityUnit: "package",
    required: true,
  }],
};

const canonicalProduct = {
  brand: "TINE",
  catalogEvidence: {
    observedAt: "2026-07-15T11:00:00.000Z",
    source: {
      contractVersion: 1 as const,
      displayName: "Kassalapp",
      id: "kassalapp",
      sourceClass: "ordinary-price" as const,
      state: "approved" as const,
    },
    sourceRecordId: `source-record:${"a".repeat(64)}`,
  },
  displayName: "Canonical TINE Lettmelk",
  gtin: "7038010000010",
  packageMeasure: { amount: 1_000, unit: "ml" as const },
  unitsPerPack: 1,
};

const exactPlan = planResultV2Schema.parse({
  assignments: [{
    canonicalProductId: "product:milk",
    chain: "extra",
    checkout: { ordinaryTotalOre: 2_190, savingOre: 0, totalOre: 2_190 },
    costOre: 2_190,
    ean: "7038010000010",
    fulfilment: {
      canonicalProductId: "product:milk",
      complete: true,
      contractVersion: 2,
      needId: "melk",
      packageCount: 1,
      packageMeasure: { amount: 1_000, unit: "ml" },
      purchased: { amount: 1, unit: "package" },
      requested: { amount: 1, unit: "package" },
      surplus: { amount: 0, unit: "package" },
    },
    needId: "melk",
    observedAt: "2026-07-15T11:00:00.000Z",
    source: "kassalapp",
  }],
  chains: ["extra"],
  coverage: 1,
  freshness: { melk: "eligible" },
  id: "plan-v2-1",
  substitutions: [],
  totalOre: 2_190,
});

const exactEvidence = exactProductPlanApiEvidenceEnvelopeSchema.parse({
  assignmentEvidence: [{
    chainId: "extra" as const,
    conditions: { kind: "ordinary-price" as const },
    evidenceId: "price:1",
    needId: "melk",
    planId: exactPlan.id,
  }],
  needs: [{
    comparisonScope: {
      completeness: "partial" as const,
      contractVersion: 1 as const,
      entries: [
        { chainId: "bunnpris", status: { kind: "unknown" as const, reason: "not-checked" as const } },
        { chainId: "extra", status: { evidenceId: "price:1", kind: "priced" as const } },
        { chainId: "rema-1000", status: { kind: "unknown" as const, reason: "not-checked" as const } },
      ],
      evaluatedAt: "2026-07-15T12:00:00.000Z",
      expectedChainIds: ["bunnpris", "extra", "rema-1000"],
    },
    excludedPriceEvidence: [],
    historicalComparisons: [],
    historicalPriceEvidence: [],
    needId: "melk",
    officialOffers: [],
    ordinaryPrices: [{
      amountOre: 2_190,
      chainId: "extra",
      contractVersion: 1 as const,
      evidenceLevel: "observed" as const,
      geographicScope: { countryCode: "NO", kind: "national" as const },
      id: "price:1",
      kind: "price-evidence" as const,
      observedAt: "2026-07-15T11:00:00.000Z",
      priceKind: "ordinary" as const,
      productMatch: { canonicalProductId: "product:milk", kind: "exact" as const },
      sourceId: "kassalapp",
      sourceRecordId: "record:1",
    }],
  }],
  sources: [{
    contractVersion: 1 as const,
    displayName: "Kassalapp",
    id: "kassalapp",
    sourceClass: "ordinary-price" as const,
    state: "approved" as const,
  }],
});

function exactExplanations(
  plans: readonly PlanResultV2[],
  evidence = exactEvidence,
) {
  const value = deriveExactProductPlanDeltaExplanationsV1({
    evidence,
    generatedAt: "2026-07-15T12:00:00.000Z",
    marketContext: exactBody.marketContext,
    plans,
  });
  if (value === undefined) throw new Error("invalid route explanation fixture");
  return value;
}

function request(
  value: unknown = body,
  headers: HeadersInit = { "content-type": "application/json" },
): Request {
  return new Request("https://handleplan.no/api/plans", {
    body: JSON.stringify(value),
    headers,
    method: "POST",
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
  return new Request("https://handleplan.no/api/plans", {
    body: stream,
    headers: { "content-type": "application/json" },
    method: "POST",
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("POST /api/plans", () => {
  it("rejects the unversioned browser-trusted contract before resolving the service", async () => {
    const getService = vi.fn<() => PlanServiceContract>(() =>
      serviceWithExact(vi.fn()));

    const response = await createPlansHandler(getService)(request());

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ code: "CONTRACT_VERSION_REQUIRED" });
    expect(getService).not.toHaveBeenCalled();
  });

  it("routes versioned requests to the exact-product service", async () => {
    const calculateExact = vi.fn(async () => ({
      completeCandidateSet: { evidence: exactEvidence, plans: [exactPlan] },
      evidence: exactEvidence,
      generatedAt: "2026-07-15T12:00:00.000Z",
      marketContext: exactBody.marketContext,
      planDeltaExplanations: exactExplanations([exactPlan]),
      plans: [exactPlan],
      priceDataSource: "cache" as const,
      products: [canonicalProduct],
    }));

    const response = await createPlansHandler(() => serviceWithExact(calculateExact))(
      request(exactBody),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(calculateExact).toHaveBeenCalledWith(exactBody, expect.any(AbortSignal));
    await expect(response.json()).resolves.toEqual({
      caveats: [
        "Resultatet gjelder prisene Handleplan kunne verifisere; ukjent kjededekning kan påvirke sammenligningen.",
        "Kjedepris betyr ikke at varen er på lager eller har samme hyllepris i din butikk.",
        "Verifiserte kundeavistilbud kan være med; medlemspriser brukes bare for medlemsprogrammer du selv har slått på.",
      ],
      contractVersion: 1,
      enabledMembershipProgramIds: [],
      evidence: exactEvidence,
      generatedAt: "2026-07-15T12:00:00.000Z",
      marketContext: exactBody.marketContext,
      planDeltaExplanations: exactExplanations([exactPlan]),
      plans: [exactPlan],
      priceDataSource: "cache",
      products: [canonicalProduct],
    });
  });

  it("rejects a service-owned explanation that is detached from its exact snapshot", async () => {
    const explanation = exactExplanations([exactPlan]);
    const entry = explanation.entries[0]!;
    const calculateExact = vi.fn(async () => ({
      completeCandidateSet: { evidence: exactEvidence, plans: [exactPlan] },
      evidence: exactEvidence,
      generatedAt: "2026-07-15T12:00:00.000Z",
      marketContext: exactBody.marketContext,
      planDeltaExplanations: {
        ...explanation,
        entries: [{ ...entry, summary: "Forged client-authoritative difference." }],
      },
      plans: [exactPlan],
      priceDataSource: "cache" as const,
      products: [canonicalProduct],
    }));

    const response = await createPlansHandler(() => serviceWithExact(calculateExact))(
      request(exactBody),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ code: "INVALID_SERVICE_RESPONSE" });
  });

  it("dispatches contract v2 to deterministic mixed reviewed-family planning", async () => {
    const container = createServerContainer({ mode: "fake" });
    const candidateInspection = await container.familyCandidateService.inspect({
      contractVersion: 2,
      families: [{ familyId: "family:melk" }],
    });
    const candidateSet = candidateInspection.candidateSets[0]!;
    const bodyWithFreshConfirmation: ReviewedFamilyPlanApiRequestV2 = {
      ...reviewedBody,
      needs: [{
        id: "need:milk",
        match: {
          confirmation: {
            candidateSetId: candidateSet.candidateSetId,
            taxonomyVersionId: candidateSet.taxonomyVersionId,
            userApproved: true,
          },
          familyId: "family:melk",
          kind: "reviewed-family",
        },
        quantity: 1,
        quantityUnit: "package",
        required: true,
      }],
    };

    const response = await createPlansHandler(() => container.planService)(
      request(bodyWithFreshConfirmation),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      caveats: PLAN_CAVEATS,
      contractVersion: 2,
      needMatches: [{
        candidateProductIds: ["product:7038010000010"],
        familyId: "family:melk",
        kind: "reviewed-family",
        needId: "need:milk",
      }],
      plans: [expect.objectContaining({
        substitutions: ["need:milk"],
      })],
      priceDataSource: "cache",
    });
  });

  it("rejects unsupported contract versions before resolving the service", async () => {
    const getService = vi.fn<() => PlanServiceContract>();
    const response = await createPlansHandler(getService)(request({
      ...reviewedBody,
      contractVersion: 3,
    }));

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ code: "UNSUPPORTED_CONTRACT_VERSION" });
    expect(getService).not.toHaveBeenCalled();
  });

  it("rejects a syntactically valid but unavailable launch market before planning", async () => {
    const calculateExact = vi.fn();
    const response = await createPlansHandler(() => serviceWithExact(calculateExact))(request({
      ...exactBody,
      marketContext: {
        contractVersion: 1,
        countryCode: "NO",
        kind: "launch-region",
        regionId: "no-9999-not-launched",
      },
    }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ code: "MARKET_UNAVAILABLE" });
    expect(calculateExact).not.toHaveBeenCalled();
  });

  it("rejects browser-owned reviewed product metadata before planning", async () => {
    const calculateReviewed = vi.fn();
    const familyNeed = reviewedBody.needs[0]!;
    const response = await createPlansHandler(() => serviceWithReviewed(calculateReviewed))(
      request({
        ...reviewedBody,
        needs: [{
          ...familyNeed,
          match: {
            ...familyNeed.match,
            candidateProductIds: ["product:forged"],
            packageMeasure: { amount: 1, unit: "piece" },
            query: "billigste melk",
            reviewerId: "private-reviewer",
          },
        }],
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_REQUEST" });
    expect(calculateReviewed).not.toHaveBeenCalled();
  });

  it.each([
    [new ReviewedFamilyPlanError("CANDIDATE_CONFIRMATION_STALE"), 409, "CANDIDATE_CONFIRMATION_STALE"],
    [new ReviewedFamilyPlanError("AMBIGUOUS_FAMILY_SELECTION"), 422, "AMBIGUOUS_FAMILY_SELECTION"],
    [new FamilyCandidateServiceError("UNKNOWN_FAMILY"), 422, "UNKNOWN_FAMILY"],
    [new FamilyCandidateServiceError("FAMILY_NO_CANDIDATES"), 422, "FAMILY_NO_CANDIDATES"],
    [new FamilyCandidateServiceError("NO_MATCHING_BRANDS"), 422, "NO_MATCHING_BRANDS"],
    [new FamilyCandidateServiceError("CANDIDATE_SET_TOO_LARGE"), 422, "CANDIDATE_SET_TOO_LARGE"],
    [new FamilyCandidateServiceError("AMBIGUOUS_FAMILY_MEMBERSHIP"), 422, "AMBIGUOUS_FAMILY_MEMBERSHIP"],
    [new FamilyCandidateServiceError("CANDIDATE_SET_INCOMPLETE"), 503, "CANDIDATE_SET_INCOMPLETE"],
    [new FamilyCandidateServiceError("EVIDENCE_UNAVAILABLE"), 503, "EVIDENCE_UNAVAILABLE"],
    [new CatalogUnavailableError(), 503, "CATALOG_UNAVAILABLE"],
    [new PriceDataUnavailableError(), 503, "PRICE_DATA_UNAVAILABLE"],
    [new PlanRequestCancelledError(), 499, "REQUEST_CANCELLED"],
  ] as const)("maps reviewed planning failures without leaking details", async (error, status, code) => {
    const response = await createPlansHandler(() => serviceWithReviewed(
      async () => { throw error; },
    ))(request(reviewedBody));

    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ code });
  });

  it("counts UTF-8 response bytes and rejects an oversized strict result", async () => {
    const wide = "ø".repeat(190);
    const offers = Array.from({ length: 50 }, (_, index) => ({
      applicability: {
        channels: ["in-store" as const, "online" as const],
        contractVersion: 1 as const,
        endsAt: "2026-07-17T12:00:00.000Z",
        geographicScope: { countryCode: "NO" as const, kind: "national" as const },
        startsAt: "2026-07-15T12:00:00.000Z",
      },
      capturedAt: "2026-07-15T11:00:00.000Z",
      chainId: "extra",
      beforePriceOre: 2_990,
      conditions: [
        { kind: "member" as const, programId: "ø".repeat(200) },
        { kind: "minimum-quantity" as const, quantity: 2 },
      ],
      contractVersion: 1 as const,
      evidenceLevel: "observed" as const,
      id: `offer:${index}:${"ø".repeat(191)}`,
      kind: "official-offer" as const,
      pricing: { kind: "unit" as const, unitPriceOre: 1_990 },
      productMatch: {
        canonicalProductId: `product:${"ø".repeat(192)}`,
        kind: "exact" as const,
      },
      sourceId: `source:${"ø".repeat(193)}`,
      sourceRecordId: `record:${index}:${wide}`,
    }));
    const strictEvidence = exactProductPlanApiEvidenceEnvelopeSchema.parse({
      assignmentEvidence: [],
      needs: [{
        ...exactEvidence.needs[0],
        comparisonScope: {
          ...exactEvidence.needs[0]!.comparisonScope,
          entries: [
            { chainId: "bunnpris", status: { kind: "unknown", reason: "not-checked" } },
            { chainId: "extra", status: { evidenceId: "price:1", kind: "priced" } },
            { chainId: "rema-1000", status: { kind: "unknown", reason: "not-checked" } },
          ],
        },
        officialOffers: offers,
        ordinaryPrices: exactEvidence.needs[0]!.ordinaryPrices.map((price) => ({
          ...price,
          productMatch: {
            canonicalProductId: `product:${"ø".repeat(192)}`,
            kind: "exact" as const,
          },
        })),
      }],
      sources: [...exactEvidence.sources, {
        contractVersion: 1,
        displayName: wide,
        id: `source:${"ø".repeat(193)}`,
        sourceClass: "offer",
        state: "approved",
      }],
    });
    const publicPayload = {
      caveats: PLAN_CAVEATS,
      contractVersion: 1,
      enabledMembershipProgramIds: [],
      evidence: strictEvidence,
      generatedAt: "2026-07-15T12:00:00.000Z",
      marketContext: exactBody.marketContext,
      planDeltaExplanations: exactExplanations([], strictEvidence),
      plans: [],
      priceDataSource: "cache",
      products: [canonicalProduct],
    };
    const serialized = JSON.stringify(publicPayload);
    expect(serialized.length).toBeLessThanOrEqual(128 * 1024);
    expect(new TextEncoder().encode(serialized).byteLength).toBeGreaterThan(128 * 1024);

    const response = await createPlansHandler(() => serviceWithExact(
      async () => ({
        completeCandidateSet: { evidence: strictEvidence, plans: [] },
        evidence: strictEvidence,
        generatedAt: "2026-07-15T12:00:00.000Z",
        planDeltaExplanations: exactExplanations([], strictEvidence),
        plans: [],
        priceDataSource: "cache" as const,
        products: [canonicalProduct],
      }),
    ))(request(exactBody));

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ code: "RESPONSE_TOO_LARGE" });
  });

  it("rejects the removed legacy shape even when it carries the exact contract version", async () => {
    const calculateExact = vi.fn();
    const response = await createPlansHandler(() => serviceWithExact(calculateExact))(
      request({ ...body, contractVersion: 1 }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_REQUEST" });
    expect(calculateExact).not.toHaveBeenCalled();
  });

  it("rejects a digit-shaped invalid GTIN before the exact service path", async () => {
    const calculateExact = vi.fn();
    const response = await createPlansHandler(() => serviceWithExact(calculateExact))(
      request({
        ...exactBody,
        needs: [{
          ...exactBody.needs[0],
          match: {
            ...exactBody.needs[0]!.match,
            product: { kind: "gtin", value: "7038010000013" },
          },
        }],
      }),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ code: "INVALID_EXACT_PRODUCT" });
    expect(calculateExact).not.toHaveBeenCalled();
  });

  it.each([
    [new UnknownExactProductError(), 422, "UNKNOWN_EXACT_PRODUCT"],
    [new CatalogUnavailableError(), 503, "CATALOG_UNAVAILABLE"],
  ] as const)("maps exact catalog errors without leaking details", async (error, status, code) => {
    const response = await createPlansHandler(() => serviceWithExact(
      async () => { throw error; },
    ))(request(exactBody));

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ code });
  });

  it("rejects non-JSON, malformed JSON, and oversized bodies before the service", async () => {
    const service: PlanServiceContract = serviceWithExact(vi.fn());
    const handler = createPlansHandler(() => service);

    const wrongType = await handler(request(body, { "content-type": "text/plain" }));
    const malformed = await handler(
      new Request("https://handleplan.no/api/plans", {
        body: "{",
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    const oversized = await handler(
      new Request("https://handleplan.no/api/plans", {
        body: JSON.stringify({ padding: "x".repeat(65_537) }),
        headers: { "content-type": "application/json", "content-length": "65560" },
        method: "POST",
      }),
    );

    expect(wrongType.status).toBe(415);
    expect(malformed.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(service.calculateExact).not.toHaveBeenCalled();
  });

  it("stops an oversized stream without trusting Content-Length", async () => {
    const service: PlanServiceContract = serviceWithExact(vi.fn());
    const cancelled = vi.fn();
    const response = await createPlansHandler(() => service)(
      streamingRequest([
        new Uint8Array(64 * 1024).fill(0x20),
        new Uint8Array([0x20]),
      ], cancelled, true),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ code: "REQUEST_TOO_LARGE" });
    expect(cancelled).toHaveBeenCalledOnce();
    expect(service.calculateExact).not.toHaveBeenCalled();
  });

  it.each([
    ["missing body", undefined],
    ["malformed UTF-8", new Uint8Array([0xff])],
  ] as const)("rejects %s with a sanitized response", async (_label, bytes) => {
    const service: PlanServiceContract = serviceWithExact(vi.fn());
    const incoming =
      bytes === undefined
        ? new Request("https://handleplan.no/api/plans", {
            headers: { "content-type": "application/json" },
            method: "POST",
          })
        : streamingRequest([bytes]);

    const response = await createPlansHandler(() => service)(incoming);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_REQUEST" });
    expect(service.calculateExact).not.toHaveBeenCalled();
  });

  it("sanitizes a locked request stream instead of throwing", async () => {
    const service: PlanServiceContract = serviceWithExact(vi.fn());
    const incoming = request();
    const lock = incoming.body!.getReader();

    const response = await createPlansHandler(() => service)(incoming);
    lock.releaseLock();

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_REQUEST" });
    expect(service.calculateExact).not.toHaveBeenCalled();
  });

  it("best-effort cancels an early Content-Length rejection without leaking cancel errors", async () => {
    const cancelled = vi.fn(() => {
      throw new Error("private cancellation detail");
    });
    const stream = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const incoming = new Request("https://handleplan.no/api/plans", {
      body: stream,
      duplex: "half",
      headers: {
        "content-length": String(64 * 1024 + 1),
        "content-type": "application/json",
      },
      method: "POST",
    } as RequestInit & { duplex: "half" });

    const response = await createPlansHandler(() => serviceWithExact(vi.fn()))(incoming);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ code: "REQUEST_TOO_LARGE" });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("rejects invalid public bodies without returning raw Zod details", async () => {
    const service: PlanServiceContract = serviceWithExact(vi.fn());
    const response = await createPlansHandler(() => service)(request({ ...exactBody, maxStores: 4 }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_REQUEST" });
    expect(service.calculateExact).not.toHaveBeenCalled();
  });

  it("maps an unsafe or incomplete fallback to the required sanitized 503", async () => {
    const service: PlanServiceContract = serviceWithExact(
      async () => {
        const error = new PriceDataUnavailableError();
        error.stack = "secret stack with ?query=milk";
        throw error;
      },
    );

    const response = await createPlansHandler(() => service)(request(exactBody));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "PRICE_DATA_UNAVAILABLE" });
  });

  it("maps cancellation to a sanitized best-effort client-closed response", async () => {
    const service: PlanServiceContract = serviceWithExact(
      async () => {
        throw new PlanRequestCancelledError();
      },
    );

    const response = await createPlansHandler(() => service)(request(exactBody));

    expect(response.status).toBe(499);
    expect(await response.json()).toEqual({ code: "REQUEST_CANCELLED" });
  });

  it("bounds body ingestion with a sanitized server deadline and cancels the stream", async () => {
    vi.useFakeTimers();
    try {
      const getService = vi.fn<() => PlanServiceContract>();
      const cancelled = vi.fn();
      const pending = createPlansHandler(getService, { timeoutMs: 25 })(
        streamingRequest([], cancelled, true),
      );

      await vi.advanceTimersByTimeAsync(25);
      const response = await pending;

      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ code: "REQUEST_TIMEOUT" });
      expect(cancelled).toHaveBeenCalledOnce();
      expect(getService).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid internal deadline configuration before serving requests", () => {
    expect(() => createPlansHandler(() => serviceWithExact(vi.fn()), { timeoutMs: 0 }))
      .toThrow(RangeError);
    expect(() => createPlansHandler(() => serviceWithExact(vi.fn()), { timeoutMs: 60_001 }))
      .toThrow(RangeError);
  });

  it("bounds service resolution as part of the same request deadline", async () => {
    vi.useFakeTimers();
    try {
      const pending = createPlansHandler(
        () => new Promise<PlanServiceContract>(() => undefined),
        { timeoutMs: 25 },
      )(request(exactBody));

      await vi.advanceTimersByTimeAsync(25);
      const response = await pending;

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: "REQUEST_TIMEOUT" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["exact", exactBody],
    ["reviewed", reviewedBody],
  ] as const)("bounds ignored cancellation in %s planning with a sanitized 503", async (
    version,
    requestBody,
  ) => {
    vi.useFakeTimers();
    try {
      let seenSignal: AbortSignal | undefined;
      const never = () => new Promise<never>(() => undefined);
      const service = version === "exact"
        ? serviceWithExact(async (_value, signal) => {
            seenSignal = signal;
            return never();
          })
        : serviceWithReviewed(async (_value, signal) => {
            seenSignal = signal;
            return never();
          });
      const pending = createPlansHandler(() => service, { timeoutMs: 25 })(
        request(requestBody),
      );

      await vi.advanceTimersByTimeAsync(25);
      const response = await pending;

      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ code: "REQUEST_TIMEOUT" });
      expect(seenSignal).toBeInstanceOf(AbortSignal);
      expect(seenSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps genuine client cancellation distinct from the server deadline", async () => {
    vi.useFakeTimers();
    try {
      const client = new AbortController();
      let seenSignal: AbortSignal | undefined;
      const service = serviceWithExact(async (_value, signal) => {
        seenSignal = signal;
        return new Promise<never>(() => undefined);
      });
      const incoming = new Request("https://handleplan.no/api/plans", {
        body: JSON.stringify(exactBody),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: client.signal,
      });
      const pending = createPlansHandler(() => service, { timeoutMs: 25 })(incoming);

      await vi.advanceTimersByTimeAsync(10);
      client.abort();
      const response = await pending;

      expect(response.status).toBe(499);
      expect(await response.json()).toEqual({ code: "REQUEST_CANCELLED" });
      expect(seenSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("composes incoming cancellation for planning and clears a successful deadline", async () => {
    vi.useFakeTimers();
    try {
      let seenSignal: AbortSignal | undefined;
      const service: PlanServiceContract = serviceWithExact(
        async (_value, signal) => {
          seenSignal = signal;
          return {
            completeCandidateSet: { evidence: exactEvidence, plans: [exactPlan] },
            evidence: exactEvidence,
            generatedAt: "2026-07-15T12:00:00.000Z",
            planDeltaExplanations: exactExplanations([exactPlan]),
            plans: [exactPlan],
            priceDataSource: "cache",
            products: [canonicalProduct],
          };
        },
      );

      const versionedIncoming = request(exactBody);
      const response = await createPlansHandler(() => service, { timeoutMs: 25 })(
        versionedIncoming,
      );

      expect(response.status).toBe(200);
      expect(seenSignal).not.toBe(versionedIncoming.signal);
      expect(seenSignal?.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
