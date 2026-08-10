import type { TravelCoordinate } from "@handleplan/domain";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { TravelGatewayTimeoutError } from "./gateways";
import {
  VALHALLA_MATRIX_URL,
  ValhallaRouteMatrixGateway,
} from "./valhalla-route-matrix-gateway";

const points: TravelCoordinate[] = [
  { latitudeE6: 59_913_900, longitudeE6: 10_752_200 },
  { latitudeE6: 59_923_900, longitudeE6: 10_762_200 },
];

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

describe("ValhallaRouteMatrixGateway", () => {
  it.each([
    ["car", "auto"],
    ["bike", "bicycle"],
  ] as const)("posts a bounded %s matrix only to the fixed self-hosted endpoint", async (mode, costing) => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => jsonResponse({
      sources_to_targets: {
        distances: [[0, 1.234], [1.25, 0]],
        durations: [[0, 125.4], [130.6, 0]],
      },
      units: "kilometers",
    }));
    const gateway = new ValhallaRouteMatrixGateway({ fetch: fetchImplementation });

    await expect(gateway.calculateMatrix({ mode, points })).resolves.toEqual({
      cells: [
        [
          { distanceMeters: 0, durationSeconds: 0 },
          { distanceMeters: 1_234, durationSeconds: 125 },
        ],
        [
          { distanceMeters: 1_250, durationSeconds: 131 },
          { distanceMeters: 0, durationSeconds: 0 },
        ],
      ],
      contractVersion: 1,
    });
    expect(gateway.providerSourceId).toBe("valhalla-openstreetmap-self-hosted");
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(url).toBe(VALHALLA_MATRIX_URL);
    expect(init).toMatchObject({
      cache: "no-store",
      credentials: "omit",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      method: "POST",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      costing,
      sources: [
        { lat: 59.9139, lon: 10.7522 },
        { lat: 59.9239, lon: 10.7622 },
      ],
      targets: [
        { lat: 59.9139, lon: 10.7522 },
        { lat: 59.9239, lon: 10.7622 },
      ],
      units: "kilometers",
      verbose: false,
    });
  });

  it("preserves unreachable cells without accepting mismatched partial values", async () => {
    const gateway = new ValhallaRouteMatrixGateway({
      fetch: async () => jsonResponse({
        sources_to_targets: {
          distances: [[0, null], [null, 0]],
          durations: [[0, null], [null, 0]],
        },
        units: "kilometers",
      }),
    });
    await expect(gateway.calculateMatrix({ mode: "car", points })).resolves.toEqual({
      cells: [
        [{ distanceMeters: 0, durationSeconds: 0 }, null],
        [null, { distanceMeters: 0, durationSeconds: 0 }],
      ],
      contractVersion: 1,
    });

    const mismatched = new ValhallaRouteMatrixGateway({
      fetch: async () => jsonResponse({
        sources_to_targets: {
          distances: [[0, null], [1, 0]],
          durations: [[0, 1], [1, 0]],
        },
        units: "kilometers",
      }),
    });
    await expect(mismatched.calculateMatrix({ mode: "car", points }))
      .rejects.toThrow("Routing provider response is invalid");
  });

  it.each([
    ["non-square", { distances: [[0, 1]], durations: [[0, 1]] }],
    ["wrong dimensions", { distances: [[0]], durations: [[0]] }],
    ["negative", { distances: [[0, -1], [1, 0]], durations: [[0, 1], [1, 0]] }],
    ["non-finite string", { distances: [[0, "Infinity"], [1, 0]], durations: [[0, 1], [1, 0]] }],
  ])("fails closed for a %s matrix", async (_name, sourcesToTargets) => {
    const gateway = new ValhallaRouteMatrixGateway({
      fetch: async () => jsonResponse({ sources_to_targets: sourcesToTargets, units: "kilometers" }),
    });

    await expect(gateway.calculateMatrix({ mode: "car", points }))
      .rejects.toThrow("Routing provider response is invalid");
  });

  it("rejects a provider response whose declared distance unit is not kilometers", async () => {
    const gateway = new ValhallaRouteMatrixGateway({
      fetch: async () => jsonResponse({
        sources_to_targets: {
          distances: [[0, 1], [1, 0]],
          durations: [[0, 60], [60, 0]],
        },
        units: "miles",
      }),
    });

    await expect(gateway.calculateMatrix({ mode: "car", points }))
      .rejects.toThrow("Routing provider response is invalid");
  });

  it("bounds declared and streaming response bodies and never leaks the upstream body", async () => {
    const sentinel = "private-upstream-sentinel";
    let declaredCancelled = false;
    const declaredStream = new ReadableStream<Uint8Array>({
      cancel() { declaredCancelled = true; },
    });
    const declared = new ValhallaRouteMatrixGateway({
      fetch: async () => new Response(declaredStream, {
        headers: {
          "content-length": String(128 * 1_024 + 1),
          "content-type": "application/json",
        },
      }),
    });
    const declaredError = await declared.calculateMatrix({ mode: "car", points })
      .catch((error: unknown) => error);
    expect(String(declaredError)).not.toContain(sentinel);
    expect(String(declaredError)).toContain("Routing provider response is invalid");
    expect(declaredCancelled).toBe(true);

    let streamingCancelled = false;
    const streamingBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(sentinel.repeat(8_192)));
      },
      cancel() { streamingCancelled = true; },
    });
    const streaming = new ValhallaRouteMatrixGateway({
      fetch: async () => new Response(streamingBody, {
        headers: { "content-type": "application/json" },
      }),
    });
    const streamingError = await streaming.calculateMatrix({ mode: "car", points })
      .catch((error: unknown) => error);
    expect(String(streamingError)).not.toContain(sentinel);
    expect(String(streamingError)).toContain("Routing provider response is invalid");
    expect(streamingCancelled).toBe(true);
  });

  it("maps its server-owned deadline to timeout and preserves caller cancellation", async () => {
    vi.useFakeTimers();
    try {
      const pendingFetch = vi.fn<typeof fetch>(async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }));
      const gateway = new ValhallaRouteMatrixGateway({
        fetch: pendingFetch,
        timeoutMs: 25,
      });
      const pending = gateway.calculateMatrix({ mode: "car", points });
      const timeoutExpectation = expect(pending).rejects
        .toBeInstanceOf(TravelGatewayTimeoutError);
      await vi.advanceTimersByTimeAsync(25);
      await timeoutExpectation;

      const controller = new AbortController();
      const cancelled = gateway.calculateMatrix({ mode: "car", points }, controller.signal);
      controller.abort(new DOMException("caller cancelled", "AbortError"));
      await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects non-JSON, non-success, and malformed JSON responses with sanitized errors", async () => {
    const cases = [
      new Response("router-secret", { status: 503 }),
      new Response("router-secret", { headers: { "content-type": "text/plain" } }),
      new Response("{", { headers: { "content-type": "application/json" } }),
    ];
    for (const response of cases) {
      const gateway = new ValhallaRouteMatrixGateway({ fetch: async () => response });
      const error = await gateway.calculateMatrix({ mode: "car", points })
        .catch((caught: unknown) => caught);
      expect(String(error)).toContain("Routing provider response is invalid");
      expect(String(error)).not.toContain("router-secret");
    }
  });
});
