import type { PublicSourceStatusResponse } from "@handleplan/domain";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  SourceStatusRequestCancelledError,
  SourceStatusUnavailableError,
  type SourceStatusServiceContract,
} from "../../../lib/server/source-status-service";
import type { PublicApiRuntimeControlsContract } from "../../../lib/server/public-api-runtime-controls";
import { createSourceStatusHandler } from "./route";

const response: PublicSourceStatusResponse = {
  claimBoundary: {
    priceCoverage: "not-established",
    publicRanking: "not-established",
    runtimeActivation: "not-established",
    stockStatus: "not-established",
  },
  completeness: "partial",
  contractVersion: 1,
  entries: [],
  generatedAt: "2026-07-17T12:00:00.000Z",
  hasMore: false,
  kind: "public-source-status",
  overall: "no-approved-sources",
};

function service(
  read: SourceStatusServiceContract["read"] = async () => response,
): SourceStatusServiceContract {
  return { read };
}

describe("GET /api/source-status", () => {
  it("returns a strict no-store public source-status contract", async () => {
    const read = vi.fn<SourceStatusServiceContract["read"]>().mockResolvedValue(response);
    const result = await createSourceStatusHandler(() => service(read))(
      new Request("https://handleplan.no/api/source-status"),
    );

    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("content-type")).toBe("application/json; charset=utf-8");
    await expect(result.json()).resolves.toEqual(response);
    expect(read).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it("uses the fixed source-status admission and coalescing key", async () => {
    const read = vi.fn<SourceStatusServiceContract["read"]>().mockResolvedValue(response);
    const runtimeControls = {
      admit: vi.fn(),
      run: vi.fn(async (_routeKey, _keyMaterial, signal, operation) => operation(signal)),
    } as PublicApiRuntimeControlsContract;

    const result = await createSourceStatusHandler(
      () => service(read),
      { runtimeControls },
    )(new Request("https://handleplan.no/api/source-status"));

    expect(result.status).toBe(200);
    expect(runtimeControls.run).toHaveBeenCalledWith(
      "source-status",
      { contractVersion: 1 },
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(read).toHaveBeenCalledOnce();
  });

  it("rejects every query parameter before reading", async () => {
    const read = vi.fn<SourceStatusServiceContract["read"]>();
    const result = await createSourceStatusHandler(() => service(read))(
      new Request("https://handleplan.no/api/source-status?source=private"),
    );
    expect(result.status).toBe(400);
    await expect(result.json()).resolves.toEqual({ code: "INVALID_REQUEST" });
    expect(read).not.toHaveBeenCalled();
  });

  it("fails closed for malformed service output and never serializes thrown details", async () => {
    const sentinels = [
      "SENTINEL-ADDRESS",
      "SENTINEL-BASKET",
      "SENTINEL-COORDINATE",
      "SENTINEL-ERROR",
      "SENTINEL-QUERY",
      "SENTINEL-USER-AGENT",
    ];
    const malformed = await createSourceStatusHandler(() => service(async () => ({
      ...response,
      providerError: sentinels.join(" "),
    } as never)))(new Request("https://handleplan.no/api/source-status"));
    expect(malformed.status).toBe(503);

    const failed = await createSourceStatusHandler(() => service(async () => {
      throw new Error(sentinels.join(" "));
    }))(new Request("https://handleplan.no/api/source-status", {
      headers: { "user-agent": sentinels.at(-1)! },
    }));
    expect(failed.status).toBe(503);
    const bodies = `${await malformed.text()}\n${await failed.text()}`;
    for (const sentinel of sentinels) expect(bodies).not.toContain(sentinel);
    expect(bodies).toContain("SOURCE_STATUS_UNAVAILABLE");
  });

  it("distinguishes cancellation, timeout, and dependency failure", async () => {
    const cancelled = await createSourceStatusHandler(() => service(async () => {
      throw new SourceStatusRequestCancelledError();
    }))(new Request("https://handleplan.no/api/source-status"));
    expect(cancelled.status).toBe(499);

    const unavailable = await createSourceStatusHandler(() => service(async () => {
      throw new SourceStatusUnavailableError();
    }))(new Request("https://handleplan.no/api/source-status"));
    expect(unavailable.status).toBe(503);

    vi.useFakeTimers();
    try {
      let dependencySignal: AbortSignal | undefined;
      const pending = createSourceStatusHandler(() => service(async (signal) => {
        dependencySignal = signal;
        return await new Promise<never>(() => undefined);
      }), { timeoutMs: 25 })(new Request("https://handleplan.no/api/source-status"));
      await vi.advanceTimersByTimeAsync(25);
      const timedOut = await pending;
      expect(timedOut.status).toBe(503);
      await expect(timedOut.json()).resolves.toEqual({ code: "REQUEST_TIMEOUT" });
      expect(dependencySignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
