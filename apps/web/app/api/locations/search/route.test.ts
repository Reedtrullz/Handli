import type { LocationSearchResponse } from "@handleplan/domain";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  LocationSearchServiceError,
  type LocationSearchServiceContract,
} from "../../../../lib/server/travel/location-search-service";
import { createLocationSearchHandler } from "./route";

const responseBody: LocationSearchResponse = {
  candidates: [{
    label: "Storgata 1, 0155 Oslo",
    matchQuality: "exact",
    selectionToken: `location-choice:${"a".repeat(43)}`,
  }],
  contractVersion: 1,
  expiresAt: "2026-07-17T12:05:00.000Z",
  generatedAt: "2026-07-17T12:00:00.000Z",
  source: { displayName: "©Kartverket", id: "kartverket-address-api" },
};

function request(
  value: unknown = { contractVersion: 1, query: "Storgata 1, Oslo" },
  headers: HeadersInit = { "content-type": "application/json" },
  signal?: AbortSignal,
): Request {
  return new Request("https://handleplan.no/api/locations/search", {
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
  return new Request("https://handleplan.no/api/locations/search", {
    body: stream,
    duplex: "half",
    headers: { "content-type": "application/json" },
    method: "POST",
  } as RequestInit & { duplex: "half" });
}

describe("POST /api/locations/search", () => {
  it("returns bounded labels with opaque choices, attribution, and no caching", async () => {
    const search = vi.fn(async () => responseBody);
    const response = await createLocationSearchHandler(() => ({ search }))(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(search).toHaveBeenCalledWith(
      { contractVersion: 1, query: "Storgata 1, Oslo" },
      expect.any(AbortSignal),
    );
    const body = JSON.stringify(await response.json());
    expect(body).toBe(JSON.stringify(responseBody));
    expect(body).not.toMatch(/latitude|longitude|coordinate|provider-selection/i);
  });

  it("requires JSON and the exact strict contract without caller authority fields", async () => {
    const search = vi.fn();
    const handler = createLocationSearchHandler(() => ({ search }));
    const cases: Array<[Request, number, string]> = [
      [request({ query: "Storgata" }), 400, "CONTRACT_VERSION_REQUIRED"],
      [request({ contractVersion: 2, query: "Storgata" }), 400, "UNSUPPORTED_CONTRACT_VERSION"],
      [request({
        contractVersion: 1,
        providerUrl: "https://attacker.invalid",
        query: "Storgata",
      }), 400, "INVALID_REQUEST"],
      [request({ contractVersion: 1, query: "Storgata", coordinates: [1, 2] }), 400, "INVALID_REQUEST"],
      [request(undefined, { "content-type": "text/plain" }), 415, "UNSUPPORTED_MEDIA_TYPE"],
    ];

    for (const [incoming, status, code] of cases) {
      const response = await handler(incoming);
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      await expect(response.json()).resolves.toEqual({ code });
    }
    expect(search).not.toHaveBeenCalled();
  });

  it("bounds declared, streamed, malformed, and non-UTF-8 bodies", async () => {
    const handler = createLocationSearchHandler(() => ({ search: vi.fn() }));
    const declared = await handler(request({}, {
      "content-length": String(2 * 1024 + 1),
      "content-type": "application/json",
    }));
    expect(declared.status).toBe(413);
    await expect(declared.json()).resolves.toEqual({ code: "REQUEST_TOO_LARGE" });

    const cancelled = vi.fn();
    const streamed = await handler(streamingRequest([
      new Uint8Array(2 * 1024),
      new Uint8Array([1]),
    ], cancelled, true));
    expect(streamed.status).toBe(413);
    expect(cancelled).toHaveBeenCalledOnce();

    const malformed = await handler(new Request("https://handleplan.no/api/locations/search", {
      body: "{",
      headers: { "content-type": "application/json" },
      method: "POST",
    }));
    expect(malformed.status).toBe(400);

    const invalidUtf8 = await handler(streamingRequest([new Uint8Array([0xff])]));
    expect(invalidUtf8.status).toBe(400);
  });

  it("bounds body ingestion, service construction, and lookup with one deadline", async () => {
    vi.useFakeTimers();
    try {
      const provider = vi.fn<() => LocationSearchServiceContract>();
      const cancelBody = vi.fn();
      const bodyPending = createLocationSearchHandler(provider, { timeoutMs: 25 })(
        streamingRequest([], cancelBody, true),
      );
      await vi.advanceTimersByTimeAsync(25);
      const bodyTimeout = await bodyPending;
      expect(bodyTimeout.status).toBe(503);
      expect(await bodyTimeout.json()).toEqual({ code: "REQUEST_TIMEOUT" });
      expect(cancelBody).toHaveBeenCalledOnce();
      expect(provider).not.toHaveBeenCalled();

      const servicePending = createLocationSearchHandler(
        () => new Promise<LocationSearchServiceContract>(() => undefined),
        { timeoutMs: 25 },
      )(request());
      await vi.advanceTimersByTimeAsync(25);
      const serviceTimeout = await servicePending;
      expect(serviceTimeout.status).toBe(503);
      expect(await serviceTimeout.json()).toEqual({ code: "REQUEST_TIMEOUT" });

      let seenSignal: AbortSignal | undefined;
      const lookupPending = createLocationSearchHandler(() => ({
        search: async (_input, signal) => {
          seenSignal = signal;
          return new Promise<never>(() => undefined);
        },
      }), { timeoutMs: 25 })(request());
      await vi.advanceTimersByTimeAsync(25);
      const lookupTimeout = await lookupPending;
      expect(lookupTimeout.status).toBe(503);
      expect(await lookupTimeout.json()).toEqual({ code: "REQUEST_TIMEOUT" });
      expect(seenSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("distinguishes client cancellation and sanitizes every service/provider failure", async () => {
    const controller = new AbortController();
    const pending = createLocationSearchHandler(() => ({
      search: async () => new Promise<never>(() => undefined),
    }))(request(undefined, { "content-type": "application/json" }, controller.signal));
    controller.abort("private cancellation detail");
    const cancelled = await pending;
    expect(cancelled.status).toBe(499);
    expect(await cancelled.json()).toEqual({ code: "REQUEST_CANCELLED" });

    for (const code of ["INVALID_REQUEST", "PROVIDER_UNAVAILABLE", "REQUEST_CANCELLED"] as const) {
      const response = await createLocationSearchHandler(() => ({
        search: async () => {
          const error = new LocationSearchServiceError(code);
          error.stack = "private address and upstream URL";
          throw error;
        },
      }))(request());
      const expected = code === "INVALID_REQUEST"
        ? [400, "INVALID_REQUEST"]
        : code === "REQUEST_CANCELLED"
          ? [499, "REQUEST_CANCELLED"]
          : [503, "LOCATION_SEARCH_UNAVAILABLE"];
      expect(response.status).toBe(expected[0]);
      expect(await response.text()).toBe(JSON.stringify({ code: expected[1] }));
    }

    const unexpected = await createLocationSearchHandler(() => ({
      search: async () => { throw new Error("https://private.example/address?q=sentinel"); },
    }))(request());
    expect(unexpected.status).toBe(503);
    expect(await unexpected.text()).toBe('{"code":"LOCATION_SEARCH_UNAVAILABLE"}');
  });

  it("rejects malformed or oversized service output at the public boundary", async () => {
    const malformed = await createLocationSearchHandler(() => ({
      search: async () => ({
        ...responseBody,
        candidates: [{ ...responseBody.candidates[0], address: "private" }],
      }) as unknown as LocationSearchResponse,
    }))(request());
    expect(malformed.status).toBe(503);
    await expect(malformed.json()).resolves.toEqual({ code: "LOCATION_SEARCH_UNAVAILABLE" });

    const oversized = await createLocationSearchHandler(() => ({
      search: async () => ({
        ...responseBody,
        source: { ...responseBody.source, displayName: "x".repeat(501) },
      }),
    }))(request());
    expect(oversized.status).toBe(503);
  });
});
