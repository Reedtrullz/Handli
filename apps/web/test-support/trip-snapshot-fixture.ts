import {
  createTripSnapshot,
  planResultV2Schema,
  type TripSnapshotV1,
} from "@handleplan/domain";

export function tripSnapshotFixture(
  overrides: Partial<Pick<TripSnapshotV1, "createdAt" | "evaluatedAt" | "expiresAt" | "id">> = {},
): TripSnapshotV1 {
  const gtin = "7038010000010";
  const product = {
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
    gtin,
    packageMeasure: { amount: 1_000, unit: "ml" as const },
    unitsPerPack: 1,
  };
  const plan = planResultV2Schema.parse({
    assignments: [{
      canonicalProductId: "product:milk",
      chain: "extra",
      checkout: { ordinaryTotalOre: 2_490, savingOre: 0, totalOre: 2_490 },
      costOre: 2_490,
      ean: gtin,
      fulfilment: {
        canonicalProductId: "product:milk",
        complete: true,
        contractVersion: 2,
        needId: "need:milk",
        packageCount: 1,
        packageMeasure: { amount: 1_000, unit: "ml" },
        purchased: { amount: 1, unit: "package" },
        requested: { amount: 1, unit: "package" },
        surplus: { amount: 0, unit: "package" },
      },
      needId: "need:milk",
      observedAt: "2026-07-16T10:00:00.000Z",
      source: "fixture-source",
    }],
    chains: ["extra"],
    coverage: 1,
    freshness: { "need:milk": "eligible" },
    id: "plan-v2:trip-web-fixture",
    substitutions: [],
    totalOre: 2_490,
  });
  return createTripSnapshot({
    caveats: ["Pris dokumenterer ikke lagerstatus."],
    createdAt: overrides.createdAt ?? "2026-07-16T12:00:00.000Z",
    evaluatedAt: overrides.evaluatedAt ?? "2026-07-16T11:00:00.000Z",
    expiresAt: overrides.expiresAt ?? "2026-07-16T18:00:00.000Z",
    id: overrides.id ?? "trip:web-fixture",
    navigation: { kind: "price-only" },
    plan,
    products: [product],
  });
}
