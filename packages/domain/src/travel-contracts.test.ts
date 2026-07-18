import { describe, expect, it } from "vitest";

import {
  currentLocationRequestSchema,
  currentLocationResponseSchema,
  internalTravelBranchSchema,
  locationSearchRequestSchema,
  locationSearchResponseSchema,
  routeMatrixSchema,
  travelCalculationStateSchema,
  travelCoordinateSchema,
  travelRouteEvidenceSchema,
} from "./travel-contracts";

describe("travel contracts", () => {
  it("bounds internal coordinates to integer microdegrees", () => {
    expect(travelCoordinateSchema.parse({ latitudeE6: 59_913_900, longitudeE6: 10_752_200 }))
      .toEqual({ latitudeE6: 59_913_900, longitudeE6: 10_752_200 });
    expect(travelCoordinateSchema.safeParse({ latitudeE6: 90_000_001, longitudeE6: 0 }).success)
      .toBe(false);
    expect(travelCoordinateSchema.safeParse({ latitudeE6: 1.5, longitudeE6: 0 }).success)
      .toBe(false);
  });

  it("keeps public location candidates bounded, coordinate-free, opaque, and short-lived", () => {
    expect(locationSearchRequestSchema.safeParse({
      contractVersion: 1,
      query: " Storgata 1, Oslo ",
    }).success).toBe(true);
    expect(locationSearchRequestSchema.safeParse({
      contractVersion: 1,
      query: "Storgata 1",
      providerUrl: "https://attacker.invalid",
    }).success).toBe(false);

    const response = {
      candidates: [{
        label: "Storgata 1, 0155 Oslo",
        matchQuality: "exact",
        selectionToken: `location-choice:${"a".repeat(43)}`,
      }],
      contractVersion: 1,
      expiresAt: "2026-07-17T12:05:00.000Z",
      generatedAt: "2026-07-17T12:00:00.000Z",
      source: { displayName: "Kartverket", id: "kartverket-geocoder" },
    };
    expect(locationSearchResponseSchema.safeParse(response).success).toBe(true);
    expect(locationSearchResponseSchema.safeParse({
      ...response,
      candidates: [{ ...response.candidates[0], latitude: 59.9 }],
    }).success).toBe(false);
    expect(locationSearchResponseSchema.safeParse({
      ...response,
      candidates: [{ ...response.candidates[0], label: "x".repeat(161) }],
    }).success).toBe(false);
    expect(locationSearchResponseSchema.safeParse({
      ...response,
      candidates: [{ ...response.candidates[0], label: "Storgata 1\nOslo" }],
    }).success).toBe(false);
    expect(locationSearchResponseSchema.safeParse({
      ...response,
      candidates: [{
        matchQuality: "exact",
        selectionToken: "provider-selection-id",
      }],
    }).success).toBe(false);
    expect(locationSearchResponseSchema.safeParse({
      ...response,
      expiresAt: "2026-07-17T12:05:00.001Z",
    }).success).toBe(false);
  });

  it("accepts browser coordinates only as strict E6 input and returns only a short-lived token", () => {
    const request = {
      contractVersion: 1,
      coordinate: { latitudeE6: 59_913_900, longitudeE6: 10_752_200 },
    };
    expect(currentLocationRequestSchema.safeParse(request).success).toBe(true);
    expect(currentLocationRequestSchema.safeParse({
      ...request,
      coordinate: { ...request.coordinate, latitudeE6: 59.9139 },
    }).success).toBe(false);
    expect(currentLocationRequestSchema.safeParse({
      ...request,
      providerUrl: "https://attacker.invalid",
    }).success).toBe(false);

    const response = {
      contractVersion: 1,
      expiresAt: "2026-07-17T12:05:00.000Z",
      generatedAt: "2026-07-17T12:00:00.000Z",
      selectionToken: `location-choice:${"a".repeat(43)}`,
    };
    expect(currentLocationResponseSchema.safeParse(response).success).toBe(true);
    expect(currentLocationResponseSchema.safeParse({
      ...response,
      coordinate: request.coordinate,
    }).success).toBe(false);
    expect(currentLocationResponseSchema.safeParse({
      ...response,
      expiresAt: "2026-07-17T12:05:00.001Z",
    }).success).toBe(false);
  });

  it("accepts only a bounded square route matrix", () => {
    expect(routeMatrixSchema.safeParse({
      cells: [
        [{ distanceMeters: 0, durationSeconds: 0 }, { distanceMeters: 900, durationSeconds: 120 }],
        [{ distanceMeters: 1_000, durationSeconds: 150 }, { distanceMeters: 0, durationSeconds: 0 }],
      ],
      contractVersion: 1,
    }).success).toBe(true);
    expect(routeMatrixSchema.safeParse({
      cells: [[{ distanceMeters: 0, durationSeconds: 0 }], []],
      contractVersion: 1,
    }).success).toBe(false);
    expect(routeMatrixSchema.safeParse({
      cells: Array.from({ length: 11 }, () => Array.from({ length: 11 }, () => null)),
      contractVersion: 1,
    }).success).toBe(false);
  });

  it("separates internal branches from public coordinate-free route evidence", () => {
    expect(internalTravelBranchSchema.safeParse({
      branchId: "branch:extra-1",
      chainId: "extra",
      coordinate: { latitudeE6: 59_913_900, longitudeE6: 10_752_200 },
      name: "Extra Storgata",
    }).success).toBe(true);

    const route = {
      aggregate: {
        calculatedAt: "2026-07-17T12:00:00.000Z",
        distanceMeters: 2_000,
        durationSeconds: 300,
        mode: "bike",
        providerSourceId: "fake-router",
        routeFingerprint: "route:opaque-random",
      },
      planId: "plan:one",
      stops: [{
        branchId: "branch:extra-1",
        chainId: "extra",
        name: "Extra Storgata",
        sequence: 1,
      }],
    };
    expect(travelRouteEvidenceSchema.safeParse(route).success).toBe(true);
    expect(travelRouteEvidenceSchema.safeParse({
      ...route,
      aggregate: { ...route.aggregate, mode: undefined },
    }).success).toBe(false);
    expect(travelRouteEvidenceSchema.safeParse({
      ...route,
      stops: [{ ...route.stops[0], coordinate: { latitudeE6: 1, longitudeE6: 2 } }],
    }).success).toBe(false);
    expect(travelCalculationStateSchema.safeParse({
      contractVersion: 1,
      kind: "calculated",
      routes: [route, { ...route, planId: "plan:two" }],
    }).success).toBe(false);
  });
});
