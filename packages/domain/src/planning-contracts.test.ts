import { describe, expect, it } from "vitest";

import {
  fulfilmentSchema,
  planExplanationSchema,
  planObjectivesSchema,
  travelResultSchema,
} from "./index";

describe("fulfilment and planning contracts", () => {
  it("accepts exact integer fulfilment and exposes surplus explicitly", () => {
    expect(
      fulfilmentSchema.safeParse({
        contractVersion: 1,
        needId: "need:milk",
        canonicalProductId: "product:milk",
        requested: { amount: 1_500, unit: "ml" },
        packageMeasure: { amount: 1_000, unit: "ml" },
        packageCount: 2,
        fulfilledAmount: 2_000,
        surplusAmount: 500,
        complete: true,
      }).success,
    ).toBe(true);
  });

  it("rejects unit mismatch, inconsistent arithmetic, and multiplication overflow", () => {
    const base = {
      contractVersion: 1,
      needId: "need:milk",
      canonicalProductId: "product:milk",
      requested: { amount: 1_500, unit: "ml" },
      packageMeasure: { amount: 1_000, unit: "ml" },
      packageCount: 2,
      fulfilledAmount: 2_000,
      surplusAmount: 500,
      complete: true,
    };

    expect(
      fulfilmentSchema.safeParse({
        ...base,
        packageMeasure: { amount: 1_000, unit: "g" },
      }).success,
    ).toBe(false);
    expect(fulfilmentSchema.safeParse({ ...base, surplusAmount: 499 }).success).toBe(false);
    expect(
      fulfilmentSchema.safeParse({
        ...base,
        requested: { amount: 1, unit: "piece" },
        packageMeasure: { amount: Number.MAX_SAFE_INTEGER, unit: "piece" },
        packageCount: 2,
        fulfilledAmount: Number.MAX_SAFE_INTEGER,
        surplusAmount: Number.MAX_SAFE_INTEGER - 1,
      }).success,
    ).toBe(false);
  });

  it("requires objective weights to be an exact basis-point ratio", () => {
    expect(
      planObjectivesSchema.safeParse({
        contractVersion: 1,
        savingsWeightBasisPoints: 6_000,
        convenienceWeightBasisPoints: 4_000,
        maxStores: 2,
        includeTravel: true,
      }).success,
    ).toBe(true);
    expect(
      planObjectivesSchema.safeParse({
        contractVersion: 1,
        savingsWeightBasisPoints: 6_000,
        convenienceWeightBasisPoints: 3_999,
        maxStores: 2,
        includeTravel: true,
      }).success,
    ).toBe(false);
  });

  it("keeps calculated travel evidence free of raw origin coordinates", () => {
    expect(
      travelResultSchema.safeParse({
        contractVersion: 1,
        kind: "calculated",
        durationSeconds: 1_200,
        distanceMeters: 7_500,
        providerSourceId: "route-provider",
        calculatedAt: "2026-07-16T12:00:00.000Z",
        routeFingerprint: "route:privacy-safe:abc",
        origin: { latitude: 59.9, longitude: 10.7 },
      }).success,
    ).toBe(false);
    expect(
      travelResultSchema.safeParse({
        contractVersion: 1,
        kind: "calculated",
        durationSeconds: 1_200,
        distanceMeters: 7_500,
        providerSourceId: "route-provider",
        calculatedAt: "2026-07-16T12:00:00.000Z",
        routeFingerprint: "route:privacy-safe:abc",
      }).success,
    ).toBe(true);
  });

  it("requires explanations to cite evidence for evidence-backed claims", () => {
    expect(
      planExplanationSchema.safeParse({
        contractVersion: 1,
        kind: "savings",
        message: "Sparer 40 kr mot ett butikkalternativ.",
        evidenceIds: ["price:1", "price:2"],
      }).success,
    ).toBe(true);
    expect(
      planExplanationSchema.safeParse({
        contractVersion: 1,
        kind: "savings",
        message: "Sparer 40 kr.",
        evidenceIds: [],
      }).success,
    ).toBe(false);
  });
});
