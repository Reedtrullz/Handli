import {
  createTripSnapshot,
  createTripSnapshotV2,
  planResultV2Schema,
  type CreateTripSnapshotInput,
  type CreateTripSnapshotV2Input,
  type TripSnapshotV1,
  type TripSnapshotV2,
} from "@handleplan/domain";

const GTIN = "7038010000010";
const ORDINARY_PRICE = {
  amountOre: 2_490,
  chainId: "extra",
  contractVersion: 1 as const,
  evidenceLevel: "observed" as const,
  geographicScope: { countryCode: "NO", kind: "national" as const },
  id: "price:extra:milk:web-fixture",
  kind: "price-evidence" as const,
  observedAt: "2026-07-16T10:00:00.000Z",
  priceKind: "ordinary" as const,
  productMatch: { canonicalProductId: "product:milk", kind: "exact" as const },
  sourceId: "fixture-price-source",
  sourceRecordId: "source-record:price:extra:milk:web-fixture",
};
const APPLIED_OFFER = {
  applicability: {
    channels: ["in-store" as const],
    contractVersion: 1 as const,
    endsAt: "2026-07-17T18:00:00.000Z",
    geographicScope: { countryCode: "NO", kind: "national" as const },
    startsAt: "2026-07-15T00:00:00.000Z",
  },
  beforePriceOre: 2_490,
  capturedAt: "2026-07-16T10:00:00.000Z",
  chainId: "extra",
  conditions: [{ kind: "public" as const }],
  contractVersion: 1 as const,
  evidenceLevel: "observed" as const,
  id: "offer:extra:milk:web-fixture",
  kind: "official-offer" as const,
  pricing: { kind: "unit" as const, unitPriceOre: 1_990 },
  productMatch: { canonicalProductId: "product:milk", kind: "exact" as const },
  sourceId: "fixture-price-source",
  sourceRecordId: "source-record:offer:extra:milk:web-fixture",
};

function fixtureData(offer: boolean) {
  const product = {
    brand: "TINE",
    catalogEvidence: {
      observedAt: "2026-07-16T10:00:00.000Z",
      source: {
        contractVersion: 1 as const,
        displayName: "Fixture catalog source",
        id: "fixture-catalog-source",
        sourceClass: "catalog" as const,
        state: "approved" as const,
      },
      sourceRecordId: `source-record:${"a".repeat(64)}`,
    },
    displayName: "TINE Lettmelk 1 l",
    gtin: GTIN,
    packageMeasure: { amount: 1_000, unit: "ml" as const },
    unitsPerPack: 1,
  };
  const checkout = offer
    ? {
        appliedOfferId: APPLIED_OFFER.id,
        ordinaryTotalOre: 2_490,
        savingOre: 500,
        totalOre: 1_990,
      }
    : { ordinaryTotalOre: 2_490, savingOre: 0, totalOre: 2_490 };
  const plan = planResultV2Schema.parse({
    assignments: [{
      canonicalProductId: "product:milk",
      chain: "extra",
      checkout,
      costOre: checkout.totalOre,
      ean: GTIN,
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
      observedAt: ORDINARY_PRICE.observedAt,
      ...(offer
        ? {
            officialOffer: {
              capturedAt: APPLIED_OFFER.capturedAt,
              id: APPLIED_OFFER.id,
              sourceId: APPLIED_OFFER.sourceId,
              sourceRecordId: APPLIED_OFFER.sourceRecordId,
            },
          }
        : {}),
      source: ORDINARY_PRICE.sourceId,
    }],
    chains: ["extra"],
    coverage: 1,
    freshness: { "need:milk": "eligible" },
    id: "plan-v2:trip-web-fixture",
    substitutions: [],
    totalOre: checkout.totalOre,
  });
  return { plan, product };
}

export interface TripSnapshotFixtureOptions {
  createdAt?: string;
  evaluatedAt?: string;
  expiresAt?: string;
  id?: string;
  navigation?: CreateTripSnapshotV2Input["navigation"];
  offer?: boolean;
}

export function tripSnapshotFixture(
  options: TripSnapshotFixtureOptions = {},
): TripSnapshotV2 {
  const offer = options.offer ?? false;
  const { plan, product } = fixtureData(offer);
  return createTripSnapshotV2({
    caveats: ["Pris dokumenterer ikke lagerstatus."],
    createdAt: options.createdAt ?? "2026-07-16T12:00:00.000Z",
    evaluatedAt: options.evaluatedAt ?? "2026-07-16T11:00:00.000Z",
    enabledMembershipProgramIds: [],
    expiresAt: options.expiresAt ?? "2026-07-16T18:00:00.000Z",
    id: options.id ?? "trip:web-fixture",
    marketContext: {
      contractVersion: 1,
      countryCode: "NO",
      kind: "national",
    },
    navigation: options.navigation ?? { kind: "price-only" },
    plan,
    products: [product],
    purchaseEvidence: [{
      ...(offer ? { appliedOffer: APPLIED_OFFER } : {}),
      needId: "need:milk",
      ordinaryPrice: ORDINARY_PRICE,
    }],
  });
}

export function legacyTripSnapshotFixture(
  overrides: Partial<Pick<TripSnapshotV1, "createdAt" | "evaluatedAt" | "expiresAt" | "id">>
    & { navigation?: CreateTripSnapshotInput["navigation"] } = {},
): TripSnapshotV1 {
  const { plan, product } = fixtureData(false);
  return createTripSnapshot({
    caveats: ["Pris dokumenterer ikke lagerstatus."],
    createdAt: overrides.createdAt ?? "2026-07-16T12:00:00.000Z",
    evaluatedAt: overrides.evaluatedAt ?? "2026-07-16T11:00:00.000Z",
    expiresAt: overrides.expiresAt ?? "2026-07-16T18:00:00.000Z",
    id: overrides.id ?? "trip:web-legacy-fixture",
    navigation: overrides.navigation ?? { kind: "price-only" },
    plan,
    products: [product],
  });
}
