import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  CurrentLocationService,
  CurrentLocationServiceError,
  getProductionCurrentLocationService,
} from "./current-location-service";
import { InMemoryLocationChoiceStore } from "./location-search-service";
import { VALHALLA_SOURCE_KILL_SWITCH_ENV } from "./travel-runtime-gate";

const NOW = new Date("2026-07-17T12:00:00.000Z");
const coordinate = { latitudeE6: 59_913_900, longitudeE6: 10_752_200 };

describe("CurrentLocationService", () => {
  it("issues an opaque five-minute token and keeps the coordinate only in memory", async () => {
    const store = new InMemoryLocationChoiceStore({
      tokenSource: () => "a".repeat(43),
    });
    const service = new CurrentLocationService({ choices: store, now: () => NOW });

    const response = await service.issue({ contractVersion: 1, coordinate });

    expect(response).toEqual({
      contractVersion: 1,
      expiresAt: "2026-07-17T12:05:00.000Z",
      generatedAt: "2026-07-17T12:00:00.000Z",
      selectionToken: `location-choice:${"a".repeat(43)}`,
    });
    expect(JSON.stringify(response)).not.toMatch(
      /latitude|longitude|coordinate|59913900|10752200|provider|label/i,
    );
    expect(store.resolve(response.selectionToken, NOW)).toEqual(coordinate);
    expect(store.resolve(
      response.selectionToken,
      new Date("2026-07-17T12:05:00.000Z"),
    )).toBeUndefined();
  });

  it("rejects malformed, out-of-range, fractional, and authority-bearing input", async () => {
    const issueMany = vi.fn();
    const service = new CurrentLocationService({ choices: { issueMany }, now: () => NOW });
    const cases = [{
      contractVersion: 1,
      coordinate: { latitudeE6: 90_000_001, longitudeE6: 0 },
    }, {
      contractVersion: 1,
      coordinate: { latitudeE6: 59.9, longitudeE6: 10_752_200 },
    }, {
      contractVersion: 1,
      coordinate,
      providerUrl: "https://attacker.invalid",
    }];

    for (const input of cases) {
      await expect(service.issue(input as never)).rejects.toMatchObject({
        code: "INVALID_REQUEST",
      });
    }
    expect(issueMany).not.toHaveBeenCalled();
  });

  it("turns cancellation and private issuer failures into stable errors", async () => {
    const controller = new AbortController();
    controller.abort("private browser cancellation reason");
    const cancelled = new CurrentLocationService({
      choices: { issueMany: vi.fn() },
      now: () => NOW,
    });
    await expect(cancelled.issue(
      { contractVersion: 1, coordinate },
      controller.signal,
    )).rejects.toEqual(new CurrentLocationServiceError("REQUEST_CANCELLED"));

    const failed = new CurrentLocationService({
      choices: {
        issueMany: () => { throw new Error("private coordinate and token"); },
      },
      now: () => NOW,
    });
    await expect(failed.issue({ contractVersion: 1, coordinate })).rejects.toEqual(
      new CurrentLocationServiceError("UNAVAILABLE"),
    );
  });

  it("does not issue production origin tokens while the routing source is disabled", () => {
    expect(() => getProductionCurrentLocationService({})).toThrow(
      new CurrentLocationServiceError("UNAVAILABLE"),
    );
    expect(() => getProductionCurrentLocationService({
      [VALHALLA_SOURCE_KILL_SWITCH_ENV]: "false",
    })).toThrow(new CurrentLocationServiceError("UNAVAILABLE"));
    expect(() => getProductionCurrentLocationService({
      [VALHALLA_SOURCE_KILL_SWITCH_ENV]: "TRUE",
    })).toThrow(new CurrentLocationServiceError("UNAVAILABLE"));
    expect(getProductionCurrentLocationService({
      [VALHALLA_SOURCE_KILL_SWITCH_ENV]: "true",
    })).toBeInstanceOf(CurrentLocationService);
  });
});
