import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { FakeGeocoderGateway } from "./fakes";
import { InFlightOperationCoalescer } from "../in-flight-operation-coalescer";
import {
  InMemoryLocationChoiceStore,
  KARTVERKET_RUNTIME_ENABLE_ENV,
  LOCATION_GEOCODER_MAX_OPERATION_MS,
  LocationSearchService,
  LocationSearchServiceError,
  getProductionLocationSearchService,
} from "./location-search-service";
import { VALHALLA_SOURCE_KILL_SWITCH_ENV } from "./travel-runtime-gate";

const NOW = new Date("2026-07-17T12:00:00.000Z");
const coordinate = { latitudeE6: 59_913_900, longitudeE6: 10_752_200 };

function tokenValues(...characters: string[]): () => string {
  const values = characters.map((character) => character.repeat(43));
  return () => {
    const value = values.shift();
    if (value === undefined) throw new Error("token fixture exhausted");
    return value;
  };
}

describe("LocationSearchService", () => {
  it("returns a bounded canonical label while keeping coordinates and provider IDs private", async () => {
    const gateway = new FakeGeocoderGateway({
      candidates: [{
        coordinate,
        label: "Storgata 1, 0155 OSLO",
        selectionId: "provider-private-id",
      }],
      contractVersion: 1,
      providerSourceId: "kartverket-address-api",
    });
    const store = new InMemoryLocationChoiceStore({
      tokenSource: tokenValues("a", "b"),
    });
    const service = new LocationSearchService({
      choices: store,
      geocoder: gateway,
      now: () => NOW,
    });

    const response = await service.search({
      contractVersion: 1,
      query: " Storgata 1, Oslo ",
    });

    expect(response).toEqual({
      candidates: [{
        label: "Storgata 1, 0155 OSLO",
        matchQuality: "exact",
        selectionToken: `location-choice:${"a".repeat(43)}`,
      }],
      contractVersion: 1,
      expiresAt: "2026-07-17T12:05:00.000Z",
      generatedAt: "2026-07-17T12:00:00.000Z",
      source: { displayName: "©Kartverket", id: "kartverket-address-api" },
    });
    expect(gateway.calls).toEqual(["Storgata 1, Oslo"]);
    expect(JSON.stringify(response)).not.toMatch(/latitude|longitude|coordinate|provider-private-id/i);
    expect(store.resolve(response.candidates[0]!.selectionToken, NOW)).toEqual(coordinate);
    expect(store.resolve(
      response.candidates[0]!.selectionToken,
      new Date("2026-07-17T12:05:00.000Z"),
    )).toBeUndefined();

    await expect(service.search({
      contractVersion: 1,
      query: "Storgata 1, 5000 Oslo",
    })).resolves.toMatchObject({
      candidates: [{ label: "Storgata 1, 0155 OSLO", matchQuality: "approximate" }],
    });
  });

  it("returns exact and approximate choices and removes duplicate labels", async () => {
    const gateway = new FakeGeocoderGateway({
      candidates: [{ coordinate, label: "Storgata 1", selectionId: "one" }, {
        coordinate: { latitudeE6: 59_914_000, longitudeE6: 10_753_000 },
        label: "Storgata 10",
        selectionId: "two",
      }],
      contractVersion: 1,
      providerSourceId: "kartverket-address-api",
    });
    const service = new LocationSearchService({
      choices: new InMemoryLocationChoiceStore({ tokenSource: tokenValues("a", "b") }),
      geocoder: gateway,
      now: () => NOW,
    });

    const result = await service.search({ contractVersion: 1, query: "storgata 1" });

    expect(result.candidates).toEqual([{
      label: "Storgata 1",
      matchQuality: "exact",
      selectionToken: `location-choice:${"a".repeat(43)}`,
    }, {
      label: "Storgata 10",
      matchQuality: "approximate",
      selectionToken: `location-choice:${"b".repeat(43)}`,
    }]);

    const ambiguous = new LocationSearchService({
      choices: new InMemoryLocationChoiceStore({ tokenSource: tokenValues("c") }),
      geocoder: new FakeGeocoderGateway({
        candidates: [{ coordinate, label: "Storgata 1", selectionId: "one" }, {
          coordinate: { latitudeE6: 59_914_000, longitudeE6: 10_753_000 },
          label: "Storgata 1",
          selectionId: "two",
        }],
        contractVersion: 1,
        providerSourceId: "kartverket-address-api",
      }),
      now: () => NOW,
    });
    await expect(ambiguous.search({ contractVersion: 1, query: "Storgata 1" }))
      .resolves.toMatchObject({ candidates: [{ label: "Storgata 1", matchQuality: "exact" }] });
  });

  it("coalesces only the provider lookup while minting distinct caller tokens", async () => {
    const gateway = new FakeGeocoderGateway({
      candidates: [{ coordinate, label: "Storgata 1", selectionId: "private" }],
      contractVersion: 1,
      providerSourceId: "kartverket-address-api",
    });
    const service = new LocationSearchService({
      choices: new InMemoryLocationChoiceStore({ tokenSource: tokenValues("a", "b") }),
      geocoder: gateway,
      geocoderCoalescer: new InFlightOperationCoalescer(),
      now: () => NOW,
    });

    const [first, second] = await Promise.all([
      service.search({ contractVersion: 1, query: "Storgata 1" }),
      service.search({ contractVersion: 1, query: "Storgata 1" }),
    ]);

    expect(gateway.calls).toEqual(["Storgata 1"]);
    expect(first.candidates[0]?.selectionToken).not.toBe(
      second.candidates[0]?.selectionToken,
    );
    expect(JSON.stringify([first, second])).not.toMatch(/latitude|longitude|coordinate|private/iu);
  });

  it("does not let a staggered caller renew the five-second geocoder deadline", async () => {
    vi.useFakeTimers();
    try {
      let sharedSignal!: AbortSignal;
      const search = vi.fn((_query: string, signal?: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          sharedSignal = signal!;
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }));
      const service = new LocationSearchService({
        choices: new InMemoryLocationChoiceStore({ tokenSource: tokenValues("a", "b") }),
        geocoder: { search },
        geocoderCoalescer: new InFlightOperationCoalescer(),
        now: () => NOW,
      });
      const first = service.search({ contractVersion: 1, query: "Storgata 1" })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(4_000);
      const second = service.search({ contractVersion: 1, query: "Storgata 1" })
        .catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(999);
      expect(sharedSignal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(first).resolves.toEqual(
        new LocationSearchServiceError("PROVIDER_UNAVAILABLE"),
      );
      await expect(second).resolves.toEqual(
        new LocationSearchServiceError("PROVIDER_UNAVAILABLE"),
      );
      expect(sharedSignal.aborted).toBe(true);
      expect(search).toHaveBeenCalledOnce();
      expect(LOCATION_GEOCODER_MAX_OPERATION_MS).toBe(5_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("validates requests, provider identity, gateway output, and bounded store capacity", async () => {
    const search = vi.fn();
    const invalid = new LocationSearchService({
      choices: new InMemoryLocationChoiceStore({ tokenSource: tokenValues("a") }),
      geocoder: { search },
      now: () => NOW,
    });
    await expect(invalid.search({ contractVersion: 1, query: "x" })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await expect(invalid.search({ contractVersion: 1, query: "Storgata\n1" }))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(search).not.toHaveBeenCalled();

    const wrongProvider = new LocationSearchService({
      choices: new InMemoryLocationChoiceStore({ tokenSource: tokenValues("b") }),
      geocoder: new FakeGeocoderGateway({
        candidates: [{ coordinate, label: "Storgata 1", selectionId: "one" }],
        contractVersion: 1,
        providerSourceId: "attacker-provider",
      }),
      now: () => NOW,
    });
    await expect(wrongProvider.search({ contractVersion: 1, query: "Storgata" }))
      .rejects.toBeInstanceOf(LocationSearchServiceError);

    const store = new InMemoryLocationChoiceStore({
      maxEntries: 1,
      tokenSource: tokenValues("c", "d"),
    });
    const first = store.issueMany([coordinate], NOW)[0]!;
    const second = store.issueMany([coordinate], NOW)[0]!;
    expect(store.resolve(first, NOW)).toBeUndefined();
    expect(store.resolve(second, NOW)).toEqual(coordinate);
  });

  it("turns aborts and private gateway failures into stable service errors", async () => {
    const controller = new AbortController();
    controller.abort("private cancellation reason");
    const cancelled = new LocationSearchService({
      choices: new InMemoryLocationChoiceStore({ tokenSource: tokenValues("a") }),
      geocoder: new FakeGeocoderGateway({
        candidates: [], contractVersion: 1, providerSourceId: "kartverket-address-api",
      }),
      now: () => NOW,
    });
    await expect(cancelled.search({ contractVersion: 1, query: "Storgata" }, controller.signal))
      .rejects.toMatchObject({ code: "REQUEST_CANCELLED" });

    const failed = new LocationSearchService({
      choices: new InMemoryLocationChoiceStore({ tokenSource: tokenValues("b") }),
      geocoder: new FakeGeocoderGateway(new Error("private provider URL and address")),
      now: () => NOW,
    });
    await expect(failed.search({ contractVersion: 1, query: "Storgata" }))
      .rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("keeps the live Kartverket GET adapter off unless deployment explicitly enables it", () => {
    expect(() => getProductionLocationSearchService({})).toThrowError(
      new LocationSearchServiceError("PROVIDER_UNAVAILABLE"),
    );
    expect(KARTVERKET_RUNTIME_ENABLE_ENV).toBe(
      "HANDLEPLAN_KARTVERKET_ADDRESS_API_ENABLED",
    );
    expect(() => getProductionLocationSearchService({
      [KARTVERKET_RUNTIME_ENABLE_ENV]: "true",
    })).toThrowError(new LocationSearchServiceError("PROVIDER_UNAVAILABLE"));
    expect(() => getProductionLocationSearchService({
      [KARTVERKET_RUNTIME_ENABLE_ENV]: "TRUE",
      [VALHALLA_SOURCE_KILL_SWITCH_ENV]: "true",
    })).toThrowError(new LocationSearchServiceError("PROVIDER_UNAVAILABLE"));
  });
});
