import {
  type DiscoveryImpactRequestV1,
  type DiscoveryImpactResponseV1,
  type MoneyOre,
} from "@handleplan/domain";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createServerContainer } from "../../../../lib/server/container";
import type { DiscoveryImpactServiceContract } from "../../../../lib/server/discovery-impact-service";
import { ReviewedFamilyPlanError } from "../../../../lib/server/plan-service";
import { createDiscoveryImpactHandler } from "./route";

const MILK = "7038010000010";
const COFFEE = "7038010000027";

const impactRequest: DiscoveryImpactRequestV1 = {
  actions: [{
    actionId: "action:add-coffee",
    kind: "add",
    product: { kind: "gtin", value: COFFEE },
    userApproved: true,
  }],
  contractVersion: 1,
  convenienceWeightBasisPoints: 5_000,
  planning: {
    contractVersion: 1,
    enabledMembershipProgramIds: [],
    marketContext: { contractVersion: 1, countryCode: "NO", kind: "national" },
    maxStores: 3,
    needs: [{
      id: "need:milk",
      match: {
        kind: "exact-product",
        product: { kind: "gtin", value: MILK },
        userApproved: true,
      },
      quantity: 1,
      quantityUnit: "package",
      required: true,
    }],
  },
};

function request(
  value: unknown = impactRequest,
  headers: HeadersInit = { "content-type": "application/json" },
): Request {
  return new Request("https://handleplan.no/api/discovery/impact", {
    body: JSON.stringify(value),
    headers,
    method: "POST",
  });
}

function service(
  calculate: DiscoveryImpactServiceContract["calculate"],
): DiscoveryImpactServiceContract {
  return { calculate };
}

function ean13(index: number): string {
  const body = `703802${String(index).padStart(6, "0")}`;
  const weighted = [...body].reduce(
    (sum, digit, digitIndex) =>
      sum + Number(digit) * (digitIndex % 2 === 0 ? 1 : 3),
    0,
  );
  return `${body}${(10 - (weighted % 10)) % 10}`;
}

describe("POST /api/discovery/impact", () => {
  it("returns one strict, private no-store impact batch", async () => {
    const container = createServerContainer({ mode: "fake" });

    const response = await createDiscoveryImpactHandler(
      () => container.discoveryImpactService,
    )(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toMatchObject({
      contractVersion: 1,
      outcomes: [{
        actionId: "action:add-coffee",
        actionKind: "add",
        state: "complete",
      }],
      travelImpact: { kind: "omitted", reason: "origin-not-retained" },
    });
  });

  it("rejects an unavailable planning market before impact calculation", async () => {
    const calculate = vi.fn<DiscoveryImpactServiceContract["calculate"]>();
    const response = await createDiscoveryImpactHandler(() => service(calculate))(request({
      ...impactRequest,
      planning: {
        ...impactRequest.planning,
        marketContext: {
          contractVersion: 1,
          countryCode: "NO",
          kind: "launch-region",
          regionId: "no-9999-not-launched",
        },
      },
    }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ code: "MARKET_UNAVAILABLE" });
    expect(calculate).not.toHaveBeenCalled();
  });

  it("rejects malformed, oversized, and non-JSON bodies before resolving the service", async () => {
    const getService = vi.fn<() => DiscoveryImpactServiceContract>();
    const handler = createDiscoveryImpactHandler(getService);
    const malformed = await handler(new Request(
      "https://handleplan.no/api/discovery/impact",
      {
        body: "{",
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    ));
    const nonJson = await handler(request(impactRequest, {
      "content-type": "text/plain",
    }));
    const oversized = await handler(new Request(
      "https://handleplan.no/api/discovery/impact",
      {
        body: JSON.stringify({ padding: "x".repeat(64 * 1024) }),
        headers: {
          "content-length": String(64 * 1024 + 20),
          "content-type": "application/json",
        },
        method: "POST",
      },
    ));

    expect(malformed.status).toBe(400);
    expect(nonJson.status).toBe(415);
    expect(oversized.status).toBe(413);
    expect(getService).not.toHaveBeenCalled();
  });

  it("rejects more than eight actions and browser-forged mutation fields", async () => {
    const calculate = vi.fn();
    const handler = createDiscoveryImpactHandler(() => service(calculate));
    const actions = Array.from({ length: 9 }, (_, index) => ({
      actionId: `action:${index}`,
      kind: "add",
      product: { kind: "gtin", value: ean13(index + 1) },
      userApproved: true,
    }));
    const tooMany = await handler(request({ ...impactRequest, actions }));
    const forged = await handler(request({
      ...impactRequest,
      actions: [{ ...impactRequest.actions[0], impactOre: -99_999 }],
    }));

    expect(tooMany.status).toBe(400);
    expect(forged.status).toBe(400);
    expect(calculate).not.toHaveBeenCalled();
  });

  it("maps stale confirmation and unknown failures without leaking details", async () => {
    const stale = await createDiscoveryImpactHandler(() => service(
      async () => {
        const error = new ReviewedFamilyPlanError("CANDIDATE_CONFIRMATION_STALE");
        error.stack = "private candidate rows and address";
        throw error;
      },
    ))(request());
    const unknown = await createDiscoveryImpactHandler(() => service(
      async () => {
        throw new Error("private database detail with basket content");
      },
    ))(request());

    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ code: "CANDIDATE_CONFIRMATION_STALE" });
    expect(unknown.status).toBe(503);
    expect(await unknown.json()).toEqual({ code: "IMPACT_UNAVAILABLE" });
  });

  it("rejects an invalid or oversized strict-looking service response", async () => {
    const invalid = await createDiscoveryImpactHandler(() => service(
      async () => ({ privateQuery: "milk" }) as unknown as DiscoveryImpactResponseV1,
    ))(request());

    const actions = Array.from({ length: 8 }, (_, index) => ({
      actionId: `action:${index}`,
      kind: "add" as const,
      product: { kind: "gtin" as const, value: ean13(index + 1) },
      userApproved: true as const,
    }));
    const wideRequest: DiscoveryImpactRequestV1 = {
      ...impactRequest,
      actions,
    };
    const offerIds = Array.from({ length: 50 }, (_, index) =>
      `offer:${index}:${"ø".repeat(175)}`);
    const summary = {
      appliedOfficialOfferIds: offerIds,
      chains: ["extra" as const],
      comparisonCoverage: "partial" as const,
      requiredMembershipProgramIds: [],
      storeCount: 1 as const,
      substitutionCount: 0,
      totalOre: 2_000 as MoneyOre,
    };
    const oversizedResult: DiscoveryImpactResponseV1 = {
      baseline: { kind: "complete", plan: summary },
      contractVersion: 1,
      evaluatedAt: "2026-07-17T12:00:00.000Z",
      evaluatedProductCount: 9,
      marketContext: wideRequest.planning.marketContext,
      outcomes: actions.map((action) => ({
        action,
        actionId: action.actionId,
        actionKind: "add" as const,
        comparison: {
          basis: "different-basket" as const,
          chainsAdded: [],
          chainsRemoved: [],
          checkoutTotalDeltaOre: 0,
          claimScope: "among-verified-prices" as const,
          kind: "comparable" as const,
          storeCountDelta: 0,
          substitutionCountDelta: 0,
        },
        plan: summary,
        state: "complete" as const,
      })),
      travelImpact: { kind: "omitted", reason: "origin-not-retained" },
    };
    expect(new TextEncoder().encode(JSON.stringify(oversizedResult)).byteLength)
      .toBeGreaterThan(64 * 1024);
    const oversized = await createDiscoveryImpactHandler(() => service(
      async () => oversizedResult,
    ))(request(wideRequest));

    expect(invalid.status).toBe(503);
    expect(await invalid.json()).toEqual({ code: "INVALID_SERVICE_RESPONSE" });
    expect(oversized.status).toBe(503);
    expect(await oversized.json()).toEqual({ code: "RESPONSE_TOO_LARGE" });
  });

  it("bounds a dependency that ignores cancellation", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const pending = createDiscoveryImpactHandler(
        () => service(async (_request, seenSignal) => {
          signal = seenSignal;
          return new Promise<never>(() => undefined);
        }),
        { timeoutMs: 25 },
      )(request());

      await vi.advanceTimersByTimeAsync(25);
      const response = await pending;

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: "REQUEST_TIMEOUT" });
      expect(signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
