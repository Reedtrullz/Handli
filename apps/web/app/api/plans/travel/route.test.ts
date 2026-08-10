import type {
  ReviewedFamilyPlanApiRequestV2,
  TravelPlanApiRequest,
  TravelPlanApiResponse,
} from "@handleplan/domain";
import { PermissivePublicApiRequestBudget } from "@handleplan/db/public-api-request-budget";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createServerContainer } from "../../../../lib/server/container";
import { InFlightOperationCoalescer } from "../../../../lib/server/in-flight-operation-coalescer";
import { PublicApiRuntimeControls } from "../../../../lib/server/public-api-runtime-controls";
import { PlanRequestCancelledError } from "../../../../lib/server/plan-service";
import {
  TravelPlanCoordinator,
  type TravelPlanCoordinatorContract,
} from "../../../../lib/server/travel/travel-plan-service";
import { createTravelPlansHandler } from "./route";

const TOKEN = `location-choice:${"a".repeat(43)}`;

const exactPlanning: Extract<TravelPlanApiRequest["planning"], { contractVersion: 1 }> = {
  contractVersion: 1,
  enabledMembershipProgramIds: [],
  marketContext: { contractVersion: 1, countryCode: "NO", kind: "national" },
  maxStores: 2,
  needs: [{
    id: "need:milk",
    match: {
      kind: "exact-product",
      product: { kind: "gtin", value: "7038010000010" },
      userApproved: true,
    },
    quantity: 1,
    quantityUnit: "package",
    required: true,
  }],
};

function body(
  planning: TravelPlanApiRequest["planning"] = exactPlanning,
): TravelPlanApiRequest {
  return {
    contractVersion: 1,
    locationSelectionToken: TOKEN,
    planning,
    travelMode: "bike",
  };
}

function request(
  value: unknown = body(),
  headers: HeadersInit = { "content-type": "application/json" },
  signal?: AbortSignal,
): Request {
  return new Request("https://handleplan.no/api/plans/travel", {
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
  return new Request("https://handleplan.no/api/plans/travel", {
    body: stream,
    duplex: "half",
    headers: { "content-type": "application/json" },
    method: "POST",
  } as RequestInit & { duplex: "half" });
}

function disabledCoordinator(): TravelPlanCoordinator {
  return new TravelPlanCoordinator({
    planService: createServerContainer({ mode: "fake" }).planService,
    travelEnabled: false,
  });
}

async function reviewedPlanning(): Promise<ReviewedFamilyPlanApiRequestV2> {
  const container = createServerContainer({ mode: "fake" });
  const inspected = await container.familyCandidateService.inspect({
    contractVersion: 2,
    families: [{ familyId: "family:melk" }],
  });
  const candidate = inspected.candidateSets[0]!;
  return {
    contractVersion: 2,
    enabledMembershipProgramIds: [],
    marketContext: { contractVersion: 1, countryCode: "NO", kind: "national" },
    maxStores: 2,
    needs: [{
      id: "need:milk",
      match: {
        confirmation: {
          candidateSetId: candidate.candidateSetId,
          taxonomyVersionId: candidate.taxonomyVersionId,
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
}

describe("POST /api/plans/travel", () => {
  it("coalesces identical admitted calculations without sharing cancellation state", async () => {
    const coordinator = disabledCoordinator();
    const calculateOriginal = coordinator.calculate.bind(coordinator);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calculate = vi.fn<TravelPlanCoordinatorContract["calculate"]>(
      async (input, signal) => {
        await gate;
        return calculateOriginal(input, signal);
      },
    );
    const handler = createTravelPlansHandler(
      () => ({ calculate }),
      {
        runtimeControls: new PublicApiRuntimeControls(
          new PermissivePublicApiRequestBudget(),
          new InFlightOperationCoalescer(),
        ),
      },
    );
    const first = handler(request());
    const second = handler(request());
    await vi.waitFor(() => expect(calculate).toHaveBeenCalledOnce());
    release();

    const responses = await Promise.all([first, second]);
    expect(responses.map(({ status }) => status)).toEqual([200, 200]);
    expect(await responses[0]!.text()).toBe(await responses[1]!.text());
  });

  it("returns a complete exact planning response plus explicit default-off travel state", async () => {
    const response = await createTravelPlansHandler(disabledCoordinator)(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const result = await response.json() as TravelPlanApiResponse;
    expect(result).toMatchObject({
      contractVersion: 1,
      planning: {
        contractVersion: 1,
        evidence: expect.any(Object),
        plans: expect.any(Array),
        priceDataSource: "cache",
        products: expect.any(Array),
      },
      travel: {
        contractVersion: 1,
        kind: "unavailable",
        reason: "provider-unavailable",
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/latitude|longitude|coordinate|address/i);
  });

  it("dispatches a reviewed-family request and returns its complete evidence contract", async () => {
    const planning = await reviewedPlanning();
    const response = await createTravelPlansHandler(disabledCoordinator)(
      request(body(planning)),
    );

    expect(response.status).toBe(200);
    const result = await response.json() as TravelPlanApiResponse;
    expect(result.planning).toMatchObject({
      contractVersion: 2,
      evidence: expect.any(Object),
      needMatches: [{ kind: "reviewed-family", needId: "need:milk" }],
      plans: expect.any(Array),
      priceDataSource: "cache",
      productClaims: expect.any(Array),
      taxonomy: expect.any(Object),
    });
    expect(result.travel).toMatchObject({ kind: "unavailable" });
  });

  it("rejects malformed versions, tokens, and caller-controlled travel authority before resolving service", async () => {
    const provider = vi.fn<() => TravelPlanCoordinatorContract>();
    const handler = createTravelPlansHandler(provider);
    const cases: Array<[unknown, number, string]> = [
      [{ planning: exactPlanning }, 400, "CONTRACT_VERSION_REQUIRED"],
      [{ ...body(), contractVersion: 2 }, 400, "UNSUPPORTED_CONTRACT_VERSION"],
      [{ ...body(), locationSelectionToken: "location-choice:guessable" }, 400, "INVALID_REQUEST"],
      [{ ...body(), origin: { latitude: 59, longitude: 10 } }, 400, "INVALID_REQUEST"],
      [{ ...body(), providerUrl: "https://attacker.invalid" }, 400, "INVALID_REQUEST"],
      [{ ...body(), travelMode: "walk" }, 400, "INVALID_REQUEST"],
      [{
        ...body(),
        planning: {
          ...exactPlanning,
          marketContext: {
            contractVersion: 1,
            countryCode: "NO",
            kind: "launch-region",
            regionId: "no-9999-not-launched",
          },
        },
      }, 422, "MARKET_UNAVAILABLE"],
    ];

    for (const [value, status, code] of cases) {
      const response = await handler(request(value));
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      await expect(response.json()).resolves.toEqual({ code });
    }
    expect(provider).not.toHaveBeenCalled();
  });

  it("bounds media type, declared/streamed size, malformed JSON, and invalid UTF-8", async () => {
    const provider = vi.fn<() => TravelPlanCoordinatorContract>();
    const handler = createTravelPlansHandler(provider);

    const unsupported = await handler(request(body(), { "content-type": "text/plain" }));
    expect(unsupported.status).toBe(415);
    await expect(unsupported.json()).resolves.toEqual({ code: "UNSUPPORTED_MEDIA_TYPE" });

    const declared = await handler(request(body(), {
      "content-length": String(64 * 1024 + 1),
      "content-type": "application/json",
    }));
    expect(declared.status).toBe(413);

    const cancelled = vi.fn();
    const streamed = await handler(streamingRequest([
      new Uint8Array(64 * 1024),
      new Uint8Array([1]),
    ], cancelled, true));
    expect(streamed.status).toBe(413);
    expect(cancelled).toHaveBeenCalledOnce();

    const malformed = await handler(new Request("https://handleplan.no/api/plans/travel", {
      body: "{",
      headers: { "content-type": "application/json" },
      method: "POST",
    }));
    expect(malformed.status).toBe(400);

    const invalidUtf8 = await handler(streamingRequest([new Uint8Array([0xff])]));
    expect(invalidUtf8.status).toBe(400);
    expect(provider).not.toHaveBeenCalled();
  });

  it("bounds body ingestion, service creation, and coordination with one deadline", async () => {
    vi.useFakeTimers();
    try {
      const provider = vi.fn<() => TravelPlanCoordinatorContract>();
      const cancelBody = vi.fn();
      const bodyPending = createTravelPlansHandler(provider, { timeoutMs: 25 })(
        streamingRequest([], cancelBody, true),
      );
      await vi.advanceTimersByTimeAsync(25);
      const bodyTimeout = await bodyPending;
      expect(bodyTimeout.status).toBe(503);
      await expect(bodyTimeout.json()).resolves.toEqual({ code: "REQUEST_TIMEOUT" });
      expect(cancelBody).toHaveBeenCalledOnce();
      expect(provider).not.toHaveBeenCalled();

      const providerPending = createTravelPlansHandler(
        () => new Promise<TravelPlanCoordinatorContract>(() => undefined),
        { timeoutMs: 25 },
      )(request());
      await vi.advanceTimersByTimeAsync(25);
      const providerTimeout = await providerPending;
      expect(providerTimeout.status).toBe(503);
      await expect(providerTimeout.json()).resolves.toEqual({ code: "REQUEST_TIMEOUT" });

      let seenSignal: AbortSignal | undefined;
      const calculatePending = createTravelPlansHandler(() => ({
        calculate: async (_input, signal) => {
          seenSignal = signal;
          return new Promise<never>(() => undefined);
        },
      }), { timeoutMs: 25 })(request());
      await vi.advanceTimersByTimeAsync(25);
      const calculateTimeout = await calculatePending;
      expect(calculateTimeout.status).toBe(503);
      await expect(calculateTimeout.json()).resolves.toEqual({ code: "REQUEST_TIMEOUT" });
      expect(seenSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("distinguishes client cancellation and never exposes dependency errors", async () => {
    const controller = new AbortController();
    const pending = createTravelPlansHandler(() => ({
      calculate: async () => new Promise<never>(() => undefined),
    }))(request(body(), { "content-type": "application/json" }, controller.signal));
    controller.abort("private browser detail");
    const cancelled = await pending;
    expect(cancelled.status).toBe(499);
    await expect(cancelled.json()).resolves.toEqual({ code: "REQUEST_CANCELLED" });

    const cooperative = await createTravelPlansHandler(() => ({
      calculate: async () => { throw new PlanRequestCancelledError(); },
    }))(request());
    expect(cooperative.status).toBe(499);

    const failed = await createTravelPlansHandler(() => ({
      calculate: async () => {
        throw new Error("https://router.internal/private?origin=sentinel");
      },
    }))(request());
    expect(failed.status).toBe(503);
    expect(await failed.text()).toBe('{"code":"EVIDENCE_UNAVAILABLE"}');
  });

  it("rejects an incoherent coordinator response at the route boundary", async () => {
    const valid = await disabledCoordinator().calculate(body());
    const response = await createTravelPlansHandler(() => ({
      calculate: async () => ({
        ...valid,
        travel: { contractVersion: 1, kind: "not-requested" },
      } as TravelPlanApiResponse),
    }))(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ code: "INVALID_SERVICE_RESPONSE" });
  });

  it("rejects travel-aware explanation copy detached from its route-bound snapshot", async () => {
    const valid = await disabledCoordinator().calculate(body());
    const entry = valid.planning.planDeltaExplanations.entries[0]!;
    const response = await createTravelPlansHandler(() => ({
      calculate: async () => ({
        ...valid,
        planning: {
          ...valid.planning,
          planDeltaExplanations: {
            ...valid.planning.planDeltaExplanations,
            entries: [{ ...entry, summary: "Forged route difference." }],
          },
        },
      } as TravelPlanApiResponse),
    }))(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ code: "INVALID_SERVICE_RESPONSE" });
  });

  it("rejects a misordered price-only frontier when travel is unavailable", async () => {
    const valid = await disabledCoordinator().calculate(body({
      ...exactPlanning,
      needs: [
        ...exactPlanning.needs,
        {
          id: "need:coffee",
          match: {
            kind: "exact-product",
            product: { kind: "gtin", value: "7038010000027" },
            userApproved: true,
          },
          quantity: 1,
          quantityUnit: "package",
          required: true,
        },
      ],
    }));
    expect(valid.planning.plans.length).toBeGreaterThan(1);
    const response = await createTravelPlansHandler(() => ({
      calculate: async () => ({
        ...valid,
        planning: {
          ...valid.planning,
          plans: [...valid.planning.plans].reverse(),
        },
      } as TravelPlanApiResponse),
    }))(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ code: "INVALID_SERVICE_RESPONSE" });
  });
});
