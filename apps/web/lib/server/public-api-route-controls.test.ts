import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  publicApiRuntimeControlResponse,
  runControlledPublicApiOperation,
} from "./public-api-route-controls";
import { PublicApiRuntimeControlError } from "./public-api-runtime-controls";

describe("public API route controls", () => {
  it("emits a bounded 429 and Retry-After without request metadata", async () => {
    const response = publicApiRuntimeControlResponse(
      new PublicApiRuntimeControlError("RATE_LIMITED", 19),
    );
    expect(response?.status).toBe(429);
    expect(response?.headers.get("retry-after")).toBe("19");
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    await expect(response?.json()).resolves.toEqual({ code: "RATE_LIMITED" });
  });

  it("fails closed instead of reflecting malformed retry values", async () => {
    for (const retryAfter of [0, 61, Number.MAX_SAFE_INTEGER + 1]) {
      const response = publicApiRuntimeControlResponse(
        new PublicApiRuntimeControlError("RATE_LIMITED", retryAfter),
      );
      expect(response?.status).toBe(503);
      expect(response?.headers.get("retry-after")).toBeNull();
      await expect(response?.json()).resolves.toEqual({
        code: "REQUEST_BUDGET_UNAVAILABLE",
      });
    }
  });

  it("keeps direct handler factories usable for bounded unit tests", async () => {
    const controller = new AbortController();
    const operation = vi.fn(async (signal: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      return "ok";
    });
    await expect(runControlledPublicApiOperation(
      {},
      "plans",
      { private: "sentinel" },
      controller.signal,
      operation,
    )).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledOnce();
  });
});
