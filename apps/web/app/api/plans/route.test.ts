import {
  exactProductPlanApiEvidenceEnvelopeSchema,
  type ExactProductPlanApiRequest,
  planResultV2Schema,
} from "@handleplan/domain";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { PlanServiceContract } from "../../../lib/server/plan-service";
import {
  CatalogUnavailableError,
  PlanRequestCancelledError,
  PriceDataUnavailableError,
  UnknownExactProductError,
} from "../../../lib/server/plan-service";
import { createPlansHandler, PLAN_CAVEATS } from "./route";

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
    const getService = vi.fn<() => PlanServiceContract>(() => ({
      calculate: vi.fn(),
    }));

    const response = await createPlansHandler(getService)(request());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "CONTRACT_VERSION_REQUIRED" });
    expect(getService).not.toHaveBeenCalled();
  });

  it("routes versioned requests to the exact-product service", async () => {
    const calculate = vi.fn();
    const calculateExact = vi.fn(async () => ({
      evidence: exactEvidence,
      generatedAt: "2026-07-15T12:00:00.000Z",
      plans: [exactPlan],
      priceDataSource: "cache" as const,
      products: [canonicalProduct],
    }));

    const response = await createPlansHandler(() => ({ calculate, calculateExact }))(
      request(exactBody),
    );

    expect(response.status).toBe(200);
    expect(calculate).not.toHaveBeenCalled();
    expect(calculateExact).toHaveBeenCalledWith(exactBody, expect.any(AbortSignal));
    await expect(response.json()).resolves.toEqual({
      caveats: [
        "Resultatet gjelder prisene Handleplan kunne verifisere; ukjent kjededekning kan påvirke sammenligningen.",
        "Kjedepris betyr ikke at varen er på lager eller har samme hyllepris i din butikk.",
        "Medlemspriser og kundeavis-tilbud er ikke med i denne beregningen.",
      ],
      contractVersion: 1,
      evidence: exactEvidence,
      generatedAt: "2026-07-15T12:00:00.000Z",
      plans: [exactPlan],
      priceDataSource: "cache",
      products: [canonicalProduct],
    });
  });

  it("counts UTF-8 response bytes and rejects an oversized strict result", async () => {
    const wide = "ø".repeat(180);
    const offers = Array.from({ length: 50 }, (_, index) => ({
      applicability: {
        channels: ["in-store" as const],
        contractVersion: 1 as const,
        endsAt: "2026-07-17T12:00:00.000Z",
        geographicScope: { kind: "unknown" as const, reason: "ø".repeat(500) },
        startsAt: "2026-07-15T12:00:00.000Z",
      },
      capturedAt: "2026-07-15T11:00:00.000Z",
      chainId: `chain:${wide}`,
      conditions: [{ kind: "public" as const }],
      contractVersion: 1 as const,
      evidenceLevel: "observed" as const,
      id: `offer:${index}:${wide}`,
      kind: "official-offer" as const,
      pricing: { kind: "unit" as const, unitPriceOre: 1_990 },
      productMatch: {
        canonicalProductId: `product:${wide}`,
        kind: "exact" as const,
      },
      sourceId: "kassalapp",
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
            { chainId: "extra", status: { kind: "unknown", reason: "not-checked" } },
            { chainId: "rema-1000", status: { kind: "unknown", reason: "not-checked" } },
          ],
        },
        officialOffers: offers,
        ordinaryPrices: [],
      }],
      sources: exactEvidence.sources,
    });
    const publicPayload = {
      caveats: PLAN_CAVEATS,
      contractVersion: 1,
      evidence: strictEvidence,
      generatedAt: "2026-07-15T12:00:00.000Z",
      plans: [],
      priceDataSource: "cache",
      products: [canonicalProduct],
    };
    const serialized = JSON.stringify(publicPayload);
    expect(serialized.length).toBeLessThanOrEqual(128 * 1024);
    expect(new TextEncoder().encode(serialized).byteLength).toBeGreaterThan(128 * 1024);

    const response = await createPlansHandler(() => ({
      calculate: vi.fn(),
      calculateExact: async () => ({
        evidence: strictEvidence,
        generatedAt: "2026-07-15T12:00:00.000Z",
        plans: [],
        priceDataSource: "cache" as const,
        products: [canonicalProduct],
      }),
    }))(request(exactBody));

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ code: "RESPONSE_TOO_LARGE" });
  });

  it("never downgrades a body with its own contractVersion to the legacy parser", async () => {
    const calculate = vi.fn();
    const calculateExact = vi.fn();
    const response = await createPlansHandler(() => ({ calculate, calculateExact }))(
      request({ ...body, contractVersion: 1 }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_REQUEST" });
    expect(calculate).not.toHaveBeenCalled();
    expect(calculateExact).not.toHaveBeenCalled();
  });

  it("rejects a digit-shaped invalid GTIN before either service or gateway path", async () => {
    const calculate = vi.fn();
    const calculateExact = vi.fn();
    const response = await createPlansHandler(() => ({ calculate, calculateExact }))(
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
    expect(calculate).not.toHaveBeenCalled();
    expect(calculateExact).not.toHaveBeenCalled();
  });

  it.each([
    [new UnknownExactProductError(), 422, "UNKNOWN_EXACT_PRODUCT"],
    [new CatalogUnavailableError(), 503, "CATALOG_UNAVAILABLE"],
  ] as const)("maps exact catalog errors without leaking details", async (error, status, code) => {
    const response = await createPlansHandler(() => ({
      calculate: vi.fn(),
      calculateExact: async () => { throw error; },
    }))(request(exactBody));

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ code });
  });

  it("rejects non-JSON, malformed JSON, and oversized bodies before the service", async () => {
    const service: PlanServiceContract = { calculate: vi.fn() };
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
    expect(service.calculate).not.toHaveBeenCalled();
  });

  it("stops an oversized stream without trusting Content-Length", async () => {
    const service: PlanServiceContract = { calculate: vi.fn() };
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
    expect(service.calculate).not.toHaveBeenCalled();
  });

  it.each([
    ["missing body", undefined],
    ["malformed UTF-8", new Uint8Array([0xff])],
  ] as const)("rejects %s with a sanitized response", async (_label, bytes) => {
    const service: PlanServiceContract = { calculate: vi.fn() };
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
    expect(service.calculate).not.toHaveBeenCalled();
  });

  it("sanitizes a locked request stream instead of throwing", async () => {
    const service: PlanServiceContract = { calculate: vi.fn() };
    const incoming = request();
    const lock = incoming.body!.getReader();

    const response = await createPlansHandler(() => service)(incoming);
    lock.releaseLock();

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_REQUEST" });
    expect(service.calculate).not.toHaveBeenCalled();
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

    const response = await createPlansHandler(() => ({ calculate: vi.fn() }))(incoming);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ code: "REQUEST_TOO_LARGE" });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("rejects invalid public bodies without returning raw Zod details", async () => {
    const service: PlanServiceContract = { calculate: vi.fn() };
    const response = await createPlansHandler(() => service)(request({ ...exactBody, maxStores: 4 }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_REQUEST" });
    expect(service.calculate).not.toHaveBeenCalled();
  });

  it("maps an unsafe or incomplete fallback to the required sanitized 503", async () => {
    const service: PlanServiceContract = {
      calculate: vi.fn(),
      calculateExact: async () => {
        const error = new PriceDataUnavailableError();
        error.stack = "secret stack with ?query=milk";
        throw error;
      },
    };

    const response = await createPlansHandler(() => service)(request(exactBody));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "PRICE_DATA_UNAVAILABLE" });
  });

  it("maps cancellation to a sanitized best-effort client-closed response", async () => {
    const service: PlanServiceContract = {
      calculate: vi.fn(),
      calculateExact: async () => {
        throw new PlanRequestCancelledError();
      },
    };

    const response = await createPlansHandler(() => service)(request(exactBody));

    expect(response.status).toBe(499);
    expect(await response.json()).toEqual({ code: "REQUEST_CANCELLED" });
  });

  it("forwards the incoming cancellation signal to planning", async () => {
    let seenSignal: AbortSignal | undefined;
    const service: PlanServiceContract = {
      calculate: vi.fn(),
      calculateExact: async (_value, signal) => {
        seenSignal = signal;
        return {
          evidence: exactEvidence,
          generatedAt: "2026-07-15T12:00:00.000Z",
          plans: [exactPlan],
          priceDataSource: "cache",
          products: [canonicalProduct],
        };
      },
    };

    const versionedIncoming = request(exactBody);
    await createPlansHandler(() => service)(versionedIncoming);

    expect(seenSignal).toBe(versionedIncoming.signal);
  });
});
