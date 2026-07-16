import { describe, expect, it } from "vitest";

import {
  createTripSnapshot,
  tripSnapshotV1Schema,
  type CreateTripSnapshotInput,
} from "./trip-snapshot";
import { planResultV2Schema } from "./planner-v2-contracts";

const products = [
  {
    brand: "TINE",
    catalogEvidence: {
      observedAt: "2026-07-16T10:00:00.000Z",
      source: {
        contractVersion: 1 as const,
        displayName: "Fixture source",
        id: "fixture-source",
        sourceClass: "ordinary-price" as const,
        state: "approved" as const,
      },
      sourceRecordId: `source-record:${"a".repeat(64)}`,
    },
    displayName: "TINE Lettmelk 1 l",
    gtin: "7038010000010",
    packageMeasure: { amount: 1_000, unit: "ml" as const },
    unitsPerPack: 1,
  },
  {
    catalogEvidence: {
      observedAt: "2026-07-16T10:00:00.000Z",
      source: {
        contractVersion: 1 as const,
        displayName: "Fixture source",
        id: "fixture-source",
        sourceClass: "ordinary-price" as const,
        state: "approved" as const,
      },
      sourceRecordId: `source-record:${"b".repeat(64)}`,
    },
    displayName: "Norsk grovbrød",
    gtin: "7038010000034",
    packageMeasure: { amount: 1, unit: "piece" as const },
    unitsPerPack: 1,
  },
];

const plan = planResultV2Schema.parse({
  assignments: [
    {
      canonicalProductId: "product:milk",
      chain: "extra" as const,
      checkout: { ordinaryTotalOre: 2_490, savingOre: 0, totalOre: 2_490 },
      costOre: 2_490,
      ean: products[0]!.gtin,
      fulfilment: {
        canonicalProductId: "product:milk",
        complete: true as const,
        contractVersion: 2 as const,
        needId: "need:milk",
        packageCount: 1,
        packageMeasure: { amount: 1_000, unit: "ml" as const },
        purchased: { amount: 1, unit: "package" as const },
        requested: { amount: 1, unit: "package" as const },
        surplus: { amount: 0, unit: "package" as const },
      },
      needId: "need:milk",
      observedAt: "2026-07-16T10:00:00.000Z",
      source: "source-neutral-fixture",
    },
    {
      canonicalProductId: "product:bread",
      chain: "bunnpris" as const,
      checkout: { ordinaryTotalOre: 3_500, savingOre: 0, totalOre: 3_500 },
      costOre: 3_500,
      ean: products[1]!.gtin,
      fulfilment: {
        canonicalProductId: "product:bread",
        complete: true as const,
        contractVersion: 2 as const,
        needId: "need:bread",
        packageCount: 1,
        packageMeasure: { amount: 1, unit: "piece" as const },
        purchased: { amount: 1, unit: "piece" as const },
        requested: { amount: 1, unit: "piece" as const },
        surplus: { amount: 0, unit: "piece" as const },
      },
      needId: "need:bread",
      observedAt: "2026-07-16T10:00:00.000Z",
      source: "another-source",
    },
  ],
  chains: ["bunnpris", "extra"],
  coverage: 1 as const,
  freshness: { "need:bread": "eligible" as const, "need:milk": "eligible" as const },
  id: "plan-v2:trip-fixture",
  substitutions: [],
  totalOre: 5_990,
});

function input(overrides: Partial<CreateTripSnapshotInput> = {}): CreateTripSnapshotInput {
  return {
    caveats: ["Pris dokumenterer ikke lagerstatus."],
    createdAt: "2026-07-16T12:00:00.000Z",
    evaluatedAt: "2026-07-16T11:00:00.000Z",
    expiresAt: "2026-07-16T18:00:00.000Z",
    id: "trip:fixture",
    navigation: { kind: "price-only" },
    plan,
    products,
    ...overrides,
  };
}

describe("TripSnapshotV1", () => {
  it("creates an immutable source-neutral price-only snapshot with stable checklist IDs", () => {
    const first = createTripSnapshot(input());
    const second = createTripSnapshot(input({ id: "trip:another" }));

    expect(first).toMatchObject({
      contractVersion: 1,
      kind: "trip-snapshot",
      navigation: {
        kind: "price-only",
        stops: [
          { chainId: "bunnpris", kind: "chain-stop", name: "Bunnpris" },
          { chainId: "extra", kind: "chain-stop", name: "Extra" },
        ],
      },
      plan: { assignments: [{ source: "source-neutral-fixture" }, { source: "another-source" }] },
    });
    expect(first.checklistItems.map(({ id }) => id)).toEqual(
      second.checklistItems.map(({ id }) => id),
    );
    expect(new Set(first.checklistItems.map(({ id }) => id)).size).toBe(2);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.plan.assignments)).toBe(true);
    expect(Object.isFrozen(first.products)).toBe(true);
  });

  it("stores only a route aggregate and ordered public branch identities", () => {
    const snapshot = createTripSnapshot(input({
      navigation: {
        aggregate: {
          calculatedAt: "2026-07-16T11:30:00.000Z",
          distanceMeters: 4_200,
          durationSeconds: 900,
          sourceId: "route-source",
          sourceRecordId: "route-record:fixture",
        },
        kind: "route",
        stops: [
          { branchId: "branch:1", chainId: "bunnpris", kind: "branch-stop", name: "Bunnpris Sentrum", sequence: 1 },
          { branchId: "branch:2", chainId: "extra", kind: "branch-stop", name: "Extra Torget", sequence: 2 },
        ],
      },
    }));

    expect(snapshot.navigation).toMatchObject({
      aggregate: { distanceMeters: 4_200, durationSeconds: 900 },
      kind: "route",
    });
    expect(JSON.stringify(snapshot.navigation)).not.toMatch(/origin|latitude|longitude|address/i);
  });

  it("rejects origin, address, and coordinate injection at every route boundary", () => {
    const valid = createTripSnapshot(input({
      navigation: {
        aggregate: {
          calculatedAt: "2026-07-16T11:30:00.000Z",
          distanceMeters: 4_200,
          durationSeconds: 900,
          sourceId: "route-source",
          sourceRecordId: "route-record:fixture",
        },
        kind: "route",
        stops: [
          { branchId: "branch:1", chainId: "bunnpris", kind: "branch-stop", name: "Bunnpris Sentrum", sequence: 1 },
          { branchId: "branch:2", chainId: "extra", kind: "branch-stop", name: "Extra Torget", sequence: 2 },
        ],
      },
    }));

    expect(tripSnapshotV1Schema.safeParse({
      ...valid,
      navigation: { ...valid.navigation, origin: { latitude: 59.9, longitude: 10.7 } },
    }).success).toBe(false);
    if (valid.navigation.kind !== "route") throw new Error("route fixture expected");
    expect(tripSnapshotV1Schema.safeParse({
      ...valid,
      navigation: {
        ...valid.navigation,
        stops: valid.navigation.stops.map((stop, index) =>
          index === 0 ? { ...stop, address: "Privatveien 1", latitude: 59.9 } : stop),
      },
    }).success).toBe(false);
  });

  it("rejects duplicate checklist IDs, product gaps, invalid expiry, and incomplete stops", () => {
    const snapshot = createTripSnapshot(input());
    expect(tripSnapshotV1Schema.safeParse({
      ...snapshot,
      checklistItems: snapshot.checklistItems.map((item) => ({
        ...item,
        id: snapshot.checklistItems[0]!.id,
      })),
    }).success).toBe(false);
    expect(tripSnapshotV1Schema.safeParse({ ...snapshot, products: [snapshot.products[0]] })
      .success).toBe(false);
    expect(tripSnapshotV1Schema.safeParse({ ...snapshot, expiresAt: snapshot.evaluatedAt }).success)
      .toBe(false);
    expect(tripSnapshotV1Schema.safeParse({
      ...snapshot,
      navigation: { ...snapshot.navigation, stops: snapshot.navigation.stops.slice(0, 1) },
    }).success).toBe(false);
  });
});
