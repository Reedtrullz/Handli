// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DiscoveryImpactRequestV1,
  DiscoveryImpactResponseV1,
  MoneyOre,
} from "@handleplan/domain";

import {
  calculateDiscoveryImpactFromApi,
  DISCOVERY_IMPACT_BODY_MAX_BYTES,
} from "./discovery-impact-client";

const MARKET_CONTEXT = {
  contractVersion: 1,
  countryCode: "NO",
  kind: "national",
} as const;

const request: DiscoveryImpactRequestV1 = {
  actions: [{
    actionId: "impact:1:add",
    kind: "add",
    product: { kind: "gtin", value: "7038010000027" },
    userApproved: true,
  }],
  contractVersion: 1,
  convenienceWeightBasisPoints: 6_000,
  planning: {
    contractVersion: 1,
    enabledMembershipProgramIds: [],
    marketContext: MARKET_CONTEXT,
    maxStores: 3,
    needs: [{
      id: "need:milk",
      match: {
        kind: "exact-product",
        product: { kind: "gtin", value: "7038010000010" },
        userApproved: true,
      },
      quantity: 2,
      quantityUnit: "each",
      required: true,
    }],
  },
};

const response: DiscoveryImpactResponseV1 = {
  baseline: {
    kind: "complete",
    plan: {
      appliedOfficialOfferIds: [],
      chains: ["extra"],
      comparisonCoverage: "complete",
      requiredMembershipProgramIds: [],
      storeCount: 1,
      substitutionCount: 0,
      totalOre: 2_000 as MoneyOre,
    },
  },
  contractVersion: 1,
  evaluatedAt: "2026-07-17T12:00:00.000Z",
  evaluatedProductCount: 2,
  marketContext: MARKET_CONTEXT,
  outcomes: [{
    action: request.actions[0]!,
    actionId: "impact:1:add",
    actionKind: "add",
    comparison: {
      basis: "different-basket",
      chainsAdded: [],
      chainsRemoved: [],
      checkoutTotalDeltaOre: 1_000,
      claimScope: "declared-complete-coverage",
      kind: "comparable",
      storeCountDelta: 0,
      substitutionCountDelta: 0,
    },
    plan: {
      appliedOfficialOfferIds: [],
      chains: ["extra"],
      comparisonCoverage: "complete",
      requiredMembershipProgramIds: [],
      storeCount: 1,
      substitutionCount: 0,
      totalOre: 3_000 as MoneyOre,
    },
    state: "complete",
  }],
  travelImpact: { kind: "omitted", reason: "origin-not-retained" },
};

afterEach(() => vi.unstubAllGlobals());

describe("Oppdag impact API client", () => {
  it("posts one strict origin-free batch and validates the request-bound response", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(response), {
      headers: { "content-type": "application/json; charset=utf-8" },
    }));
    vi.stubGlobal("fetch", fetch);

    await expect(calculateDiscoveryImpactFromApi(
      request,
      new AbortController().signal,
    )).resolves.toEqual(response);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith("/api/discovery/impact", expect.objectContaining({
      cache: "no-store",
      method: "POST",
      signal: expect.any(AbortSignal),
    }));
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body).toEqual(request);
    expect(JSON.stringify(body)).not.toMatch(/origin|address|latitude|longitude|travel/i);
  });

  it("rejects responses that do not bind the requested action identity", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ...response,
      outcomes: [{ ...response.outcomes[0], actionId: "impact:forged" }],
    }), { headers: { "content-type": "application/json" } })));

    await expect(calculateDiscoveryImpactFromApi(
      request,
      new AbortController().signal,
    )).rejects.toThrow("DISCOVERY_IMPACT_FAILED");
  });

  it("rejects a stale response from another nonce-bound product request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify(response),
      { headers: { "content-type": "application/json" } },
    )));
    const nextRequest: DiscoveryImpactRequestV1 = {
      ...request,
      actions: [{
        ...request.actions[0]!,
        actionId: "impact:nonce-two:1:add:7038010000034",
        product: { kind: "gtin", value: "7038010000034" },
      }],
    };

    await expect(calculateDiscoveryImpactFromApi(
      nextRequest,
      new AbortController().signal,
    )).rejects.toThrow("DISCOVERY_IMPACT_FAILED");
  });

  it("cancels a declared response above 128 KiB before reading it", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => { cancelled = true; },
      start: (controller) => controller.enqueue(new TextEncoder().encode("{}")),
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, {
      headers: {
        "content-length": String(DISCOVERY_IMPACT_BODY_MAX_BYTES + 1),
        "content-type": "application/json",
      },
    })));

    await expect(calculateDiscoveryImpactFromApi(
      request,
      new AbortController().signal,
    )).rejects.toThrow("DISCOVERY_IMPACT_FAILED");
    expect(cancelled).toBe(true);
  });

  it("rejects strict-boundary additions such as origin without making a request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(calculateDiscoveryImpactFromApi(
      { ...request, origin: "Storgata 1" } as DiscoveryImpactRequestV1,
      new AbortController().signal,
    )).rejects.toThrow("DISCOVERY_IMPACT_FAILED");
    expect(fetch).not.toHaveBeenCalled();
  });
});
