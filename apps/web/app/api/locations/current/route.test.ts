import type { CurrentLocationResponse } from "@handleplan/domain";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  CurrentLocationServiceError,
  type CurrentLocationServiceContract,
} from "../../../../lib/server/travel/current-location-service";
import { InFlightOperationCoalescer } from "../../../../lib/server/in-flight-operation-coalescer";
import { PublicApiRuntimeControls } from "../../../../lib/server/public-api-runtime-controls";
import { createCurrentLocationHandler } from "./route";

const coordinate = { latitudeE6: 59_913_900, longitudeE6: 10_752_200 };
const responseBody: CurrentLocationResponse = {
  contractVersion: 1,
  expiresAt: "2026-07-17T12:05:00.000Z",
  generatedAt: "2026-07-17T12:00:00.000Z",
  selectionToken: `location-choice:${"a".repeat(43)}`,
};

function request(
  value: unknown = { contractVersion: 1, coordinate },
  headers: HeadersInit = { "content-type": "application/json" },
  signal?: AbortSignal,
): Request {
  return new Request("https://handleplan.no/api/locations/current", {
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
  return new Request("https://handleplan.no/api/locations/current", {
    body: stream,
    duplex: "half",
    headers: { "content-type": "application/json" },
    method: "POST",
  } as RequestInit & { duplex: "half" });
}

describe("POST /api/locations/current", () => {
  it("rate-limits before minting an in-memory location token", async () => {
    const issue = vi.fn<CurrentLocationServiceContract["issue"]>();
    const getService = vi.fn(() => ({ issue }));
    const response = await createCurrentLocationHandler(
      getService,
      {
        runtimeControls: new PublicApiRuntimeControls(
          { claim: async () => ({ admitted: false, retryAfterSeconds: 7 }) },
          new InFlightOperationCoalescer(),
        ),
      },
    )(request());

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
    await expect(response.json()).resolves.toEqual({ code: "RATE_LIMITED" });
    expect(getService).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
  });

  it("returns only an opaque token and timestamps with private no-store", async () => {
    const issue = vi.fn(async () => responseBody);
    const response = await createCurrentLocationHandler(() => ({ issue }))(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(issue).toHaveBeenCalledWith(
      { contractVersion: 1, coordinate },
      expect.any(AbortSignal),
    );
    const body = JSON.stringify(await response.json());
    expect(body).toBe(JSON.stringify(responseBody));
    expect(body).not.toMatch(/latitude|longitude|coordinate|59913900|10752200|provider|label/i);
  });

  it("requires JSON and the exact strict E6 coordinate contract", async () => {
    const issue = vi.fn();
    const handler = createCurrentLocationHandler(() => ({ issue }));
    const cases: Array<[Request, number, string]> = [
      [request({ coordinate }), 400, "CONTRACT_VERSION_REQUIRED"],
      [request({ contractVersion: 2, coordinate }), 400, "UNSUPPORTED_CONTRACT_VERSION"],
      [request({ contractVersion: 1, coordinate, providerUrl: "https://attacker.invalid" }), 400, "INVALID_REQUEST"],
      [request({ contractVersion: 1, coordinate: { ...coordinate, latitudeE6: 59.9 } }), 400, "INVALID_REQUEST"],
      [request({ contractVersion: 1, coordinate: { latitudeE6: 90_000_001, longitudeE6: 0 } }), 400, "INVALID_REQUEST"],
      [request(undefined, { "content-type": "text/plain" }), 415, "UNSUPPORTED_MEDIA_TYPE"],
    ];

    for (const [incoming, status, code] of cases) {
      const response = await handler(incoming);
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      await expect(response.json()).resolves.toEqual({ code });
    }
    expect(issue).not.toHaveBeenCalled();
  });

  it("bounds declared, streamed, malformed, and non-UTF-8 bodies", async () => {
    const handler = createCurrentLocationHandler(() => ({ issue: vi.fn() }));
    const declared = await handler(request({}, {
      "content-length": String(512 + 1),
      "content-type": "application/json",
    }));
    expect(declared.status).toBe(413);
    await expect(declared.json()).resolves.toEqual({ code: "REQUEST_TOO_LARGE" });

    const cancelled = vi.fn();
    const streamed = await handler(streamingRequest([
      new Uint8Array(512),
      new Uint8Array([1]),
    ], cancelled, true));
    expect(streamed.status).toBe(413);
    expect(cancelled).toHaveBeenCalledOnce();

    const malformed = await handler(new Request("https://handleplan.no/api/locations/current", {
      body: "{",
      headers: { "content-type": "application/json" },
      method: "POST",
    }));
    expect(malformed.status).toBe(400);

    const invalidUtf8 = await handler(streamingRequest([new Uint8Array([0xff])]));
    expect(invalidUtf8.status).toBe(400);
  });

  it("bounds body ingestion, service construction, and issuance with one deadline", async () => {
    vi.useFakeTimers();
    try {
      const provider = vi.fn<() => CurrentLocationServiceContract>();
      const cancelBody = vi.fn();
      const bodyPending = createCurrentLocationHandler(provider, { timeoutMs: 25 })(
        streamingRequest([], cancelBody, true),
      );
      await vi.advanceTimersByTimeAsync(25);
      const bodyTimeout = await bodyPending;
      expect(bodyTimeout.status).toBe(503);
      expect(await bodyTimeout.json()).toEqual({ code: "REQUEST_TIMEOUT" });
      expect(cancelBody).toHaveBeenCalledOnce();
      expect(provider).not.toHaveBeenCalled();

      const servicePending = createCurrentLocationHandler(
        () => new Promise<CurrentLocationServiceContract>(() => undefined),
        { timeoutMs: 25 },
      )(request());
      await vi.advanceTimersByTimeAsync(25);
      const serviceTimeout = await servicePending;
      expect(serviceTimeout.status).toBe(503);
      expect(await serviceTimeout.json()).toEqual({ code: "REQUEST_TIMEOUT" });

      let seenSignal: AbortSignal | undefined;
      const issuePending = createCurrentLocationHandler(() => ({
        issue: async (_input, signal) => {
          seenSignal = signal;
          return new Promise<never>(() => undefined);
        },
      }), { timeoutMs: 25 })(request());
      await vi.advanceTimersByTimeAsync(25);
      const issueTimeout = await issuePending;
      expect(issueTimeout.status).toBe(503);
      expect(await issueTimeout.json()).toEqual({ code: "REQUEST_TIMEOUT" });
      expect(seenSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("distinguishes cancellation and sanitizes service failures", async () => {
    const controller = new AbortController();
    const pending = createCurrentLocationHandler(() => ({
      issue: async () => new Promise<never>(() => undefined),
    }))(request(undefined, { "content-type": "application/json" }, controller.signal));
    controller.abort("private cancellation detail");
    const cancelled = await pending;
    expect(cancelled.status).toBe(499);
    expect(await cancelled.json()).toEqual({ code: "REQUEST_CANCELLED" });

    for (const code of ["INVALID_REQUEST", "UNAVAILABLE", "REQUEST_CANCELLED"] as const) {
      const response = await createCurrentLocationHandler(() => ({
        issue: async () => {
          const error = new CurrentLocationServiceError(code);
          error.stack = "private coordinate and browser detail";
          throw error;
        },
      }))(request());
      const expected = code === "INVALID_REQUEST"
        ? [400, "INVALID_REQUEST"]
        : code === "REQUEST_CANCELLED"
          ? [499, "REQUEST_CANCELLED"]
          : [503, "CURRENT_LOCATION_UNAVAILABLE"];
      expect(response.status).toBe(expected[0]);
      expect(await response.text()).toBe(JSON.stringify({ code: expected[1] }));
    }
  });

  it("rejects malformed or oversized service output at the public boundary", async () => {
    const malformed = await createCurrentLocationHandler(() => ({
      issue: async () => ({
        ...responseBody,
        coordinate,
      }) as unknown as CurrentLocationResponse,
    }))(request());
    expect(malformed.status).toBe(503);
    await expect(malformed.json()).resolves.toEqual({ code: "CURRENT_LOCATION_UNAVAILABLE" });

    const oversized = await createCurrentLocationHandler(() => ({
      issue: async () => ({
        ...responseBody,
        selectionToken: `location-choice:${"x".repeat(600)}`,
      }),
    }))(request());
    expect(oversized.status).toBe(503);
    expect(await oversized.text()).not.toMatch(/x{20}|coordinate|latitude|longitude/i);
  });
});
