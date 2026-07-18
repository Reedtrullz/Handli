import type { RouteMatrix } from "@handleplan/domain";
import { describe, expect, it } from "vitest";

import {
  MAX_GEOCODER_CANDIDATES,
  MAX_ROUTE_MATRIX_POINTS,
  geocoderGatewayResultSchema,
  routeMatrixGatewayRequestSchema,
} from "./gateways";
import {
  FakeGeocoderGateway,
  FakeRouteFingerprintSource,
  FakeRouteMatrixGateway,
} from "./fakes";

function squareMatrix(size: number): RouteMatrix {
  return {
    cells: Array.from({ length: size }, (_row, from) =>
      Array.from({ length: size }, (_cell, to) => ({
        distanceMeters: from === to ? 0 : 100,
        durationSeconds: from === to ? 0 : 10,
      }))),
    contractVersion: 1,
  };
}

describe("deterministic travel fakes", () => {
  it("enforces the five-result internal geocoder boundary", async () => {
    const candidates = Array.from({ length: MAX_GEOCODER_CANDIDATES }, (_, index) => ({
      coordinate: { latitudeE6: 59_900_000 + index, longitudeE6: 10_700_000 },
      label: `Address ${index + 1}`,
      selectionId: `location:${index + 1}`,
    }));
    const gateway = new FakeGeocoderGateway({
      candidates,
      contractVersion: 1,
      providerSourceId: "fixture-geocoder",
    });

    await expect(gateway.search("Storgata 1")).resolves.toMatchObject({ candidates });
    expect(geocoderGatewayResultSchema.safeParse({
      candidates: [...candidates, {
        coordinate: { latitudeE6: 59_900_999, longitudeE6: 10_700_000 },
        label: "Too many",
        selectionId: "location:too-many",
      }],
      contractVersion: 1,
      providerSourceId: "fixture-geocoder",
    }).success).toBe(false);
  });

  it("accepts only car/bike and two-to-ten points without a caller URL", async () => {
    const points = Array.from({ length: MAX_ROUTE_MATRIX_POINTS }, (_, index) => ({
      latitudeE6: 59_900_000 + index,
      longitudeE6: 10_700_000,
    }));
    const gateway = new FakeRouteMatrixGateway(
      "fixture-router",
      squareMatrix(MAX_ROUTE_MATRIX_POINTS),
    );

    await gateway.calculateMatrix({ mode: "bike", points });
    expect(gateway.calls[0]).toEqual({ mode: "bike", points });
    expect("url" in gateway.calls[0]!).toBe(false);
    expect(routeMatrixGatewayRequestSchema.safeParse({
      mode: "walk",
      points: points.slice(0, 2),
    }).success).toBe(false);
    expect(routeMatrixGatewayRequestSchema.safeParse({
      mode: "car",
      points: [...points, points[0]],
    }).success).toBe(false);
    expect(routeMatrixGatewayRequestSchema.safeParse({
      mode: "car",
      points: points.slice(0, 2),
      url: "https://attacker.invalid",
    }).success).toBe(false);
  });

  it("uses an explicit finite fingerprint sequence and never implicit randomness", () => {
    const source = new FakeRouteFingerprintSource(["route:fixture-a", "route:fixture-b"]);

    expect(source.next()).toBe("route:fixture-a");
    expect(source.next()).toBe("route:fixture-b");
    expect(() => source.next()).toThrow(/exhausted/i);
    expect(source.calls).toBe(3);
  });
});
