import { planResultSchema } from "@handleplan/domain";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { PlanServiceContract } from "../../../lib/server/plan-service";
import {
  PlanRequestCancelledError,
  PriceDataUnavailableError,
} from "../../../lib/server/plan-service";
import { createPlansHandler } from "./route";

const body = {
  matchingRules: [
    {
      exactEan: "7038010000013",
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
  products: [{ ean: "7038010000013", name: "Tine Lettmelk 1 %" }],
};

const plan = planResultSchema.parse({
  assignments: [
    {
      chain: "extra",
      costOre: 2190,
      ean: "7038010000013",
      needId: "melk",
      quantity: 1,
      observedAt: "2026-07-15T11:00:00.000Z",
      source: "kassalapp",
    },
  ],
  chains: ["extra"],
  coverage: 1,
  freshness: { melk: "eligible" },
  id: "plan-1",
  substitutions: [],
  totalOre: 2190,
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
  it("returns complete plans, canonical UTC time, and the mandatory Norwegian caveats", async () => {
    const service: PlanServiceContract = {
      calculate: async () => ({
        generatedAt: "2026-07-15T12:00:00.000Z",
        plans: [plan],
        priceDataSource: "upstream",
      }),
    };

    const response = await createPlansHandler(() => service)(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      caveats: [
        "Kjedepris betyr ikke at varen er på lager eller har samme hyllepris i din butikk.",
        "Medlemspriser og kundeavis-tilbud er ikke med i denne beregningen.",
      ],
      generatedAt: "2026-07-15T12:00:00.000Z",
      priceDataSource: "upstream",
      plans: [plan],
    });
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

  it.each(["g", "ml"] as const)("rejects required %s quantities before planning", async (quantityUnit) => {
    const service: PlanServiceContract = { calculate: vi.fn() };
    const response = await createPlansHandler(() => service)(request({
      ...body,
      needs: [{ ...body.needs[0], quantity: 500, quantityUnit }],
    }));

    expect(response.status).toBe(400);
    expect(service.calculate).not.toHaveBeenCalled();
  });

  it("accepts a generic-only basket when its approved family has a catalog candidate", async () => {
    const calculate = vi.fn(async () => ({ generatedAt: "2026-07-15T12:00:00.000Z", plans: [plan], priceDataSource: "upstream" as const }));
    const response = await createPlansHandler(() => ({ calculate }))(request({
      ...body,
      needs: [{ ...body.needs[0], query: "lettmelk", matchRuleId: "melk-flex" }],
      matchingRules: [{ id: "melk-flex", mode: "flexible", productFamily: "lettmelk", userApproved: true, explanation: "Samme type" }],
      products: [{ ...body.products[0], productFamily: "lettmelk" }],
    }));

    expect(response.status).toBe(200);
    expect(calculate).toHaveBeenCalledOnce();
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

  it("decodes UTF-8 split across stream chunks", async () => {
    const encoded = new TextEncoder().encode(
      JSON.stringify({
        ...body,
        products: [{ ...body.products[0], name: "Melk 🥛" }],
      }),
    );
    const emojiStart = encoded.findIndex((byte) => byte === 0xf0);
    const chunks = [encoded.slice(0, emojiStart + 2), encoded.slice(emojiStart + 2)];
    let seenName: string | undefined;
    const service: PlanServiceContract = {
      calculate: async (value) => {
        seenName = value.products[0]?.name;
        return {
          generatedAt: "2026-07-15T12:00:00.000Z",
          plans: [],
          priceDataSource: "upstream",
        };
      },
    };

    const response = await createPlansHandler(() => service)(streamingRequest(chunks));

    expect(response.status).toBe(200);
    expect(seenName).toBe("Melk 🥛");
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
    const response = await createPlansHandler(() => service)(request({ ...body, maxStores: 4 }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_REQUEST" });
    expect(service.calculate).not.toHaveBeenCalled();
  });

  it("maps an unsafe or incomplete fallback to the required sanitized 503", async () => {
    const service: PlanServiceContract = {
      calculate: async () => {
        const error = new PriceDataUnavailableError();
        error.stack = "secret stack with ?query=milk";
        throw error;
      },
    };

    const response = await createPlansHandler(() => service)(request());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "PRICE_DATA_UNAVAILABLE" });
  });

  it("maps cancellation to a sanitized best-effort client-closed response", async () => {
    const service: PlanServiceContract = {
      calculate: async () => {
        throw new PlanRequestCancelledError();
      },
    };

    const response = await createPlansHandler(() => service)(request());

    expect(response.status).toBe(499);
    expect(await response.json()).toEqual({ code: "REQUEST_CANCELLED" });
  });

  it("forwards the incoming cancellation signal to planning", async () => {
    let seenSignal: AbortSignal | undefined;
    const incoming = request();
    const service: PlanServiceContract = {
      calculate: async (_value, signal) => {
        seenSignal = signal;
        return {
          generatedAt: "2026-07-15T12:00:00.000Z",
          plans: [],
          priceDataSource: "upstream",
        };
      },
    };

    await createPlansHandler(() => service)(incoming);

    expect(seenSignal).toBe(incoming.signal);
  });
});
