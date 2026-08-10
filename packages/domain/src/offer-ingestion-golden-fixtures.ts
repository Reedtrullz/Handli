// Rights-cleared synthetic fixtures only. These values are invented for tests
// and contain no retailer artwork, copy, prices, identifiers, or extracted text.

export const SYNTHETIC_OFFER_LAYOUT_FINGERPRINT = "1".repeat(64);
export const SYNTHETIC_OFFER_SCHEMA_FINGERPRINT = "2".repeat(64);
export const SYNTHETIC_OFFER_CAPTURE_CHECKSUM = "3".repeat(64);

export const syntheticAuthorizedLocalEdition = {
  contractVersion: 1,
  sourceId: "synthetic-rights-cleared-feed",
  externalEditionId: "synthetic-local-edition-2026-29",
  chain: "extra",
  title: "Synthetic local edition",
  contentKind: "structured-feed",
  geographicScopeId: 42,
  declaredGeographicScope: {
    kind: "postal-set",
    countryCode: "NO",
    postalCodes: ["0001", "0002"],
  },
  validFrom: "2026-07-13T00:00:00.000Z",
  validUntil: "2026-07-20T00:00:00.000Z",
  discoveredAt: "2026-07-12T12:00:00.000Z",
  authorization: {
    decision: "approved",
    capabilities: ["discover", "capture", "extract"],
    reviewedAt: "2026-07-01T00:00:00.000Z",
    validUntil: "2026-08-01T00:00:00.000Z",
  },
} as const;

const baseCandidate = {
  contractVersion: 1,
  package: { state: "parsed", amount: 500, unit: "g", unitsPerPack: 1 },
  eligibility: { kind: "public" },
  validity: {
    state: "parsed",
    startsAt: "2026-07-13T00:00:00.000Z",
    endsAt: "2026-07-20T00:00:00.000Z",
  },
  geographicScope: syntheticAuthorizedLocalEdition.declaredGeographicScope,
  channels: ["in-store"],
  provenance: {
    method: "structured",
    evidenceLocator: "synthetic-record-1",
    confidence: 100,
  },
  anomalyCodes: [],
} as const;

export const syntheticStructuredOfferCandidates = [
  {
    ...baseCandidate,
    candidateKey: "synthetic-ordinary-price",
    product: { kind: "exact-identifier", scheme: "gtin", value: "70000001" },
    pricing: { kind: "unit", offerPriceOre: 2_990 },
  },
  {
    ...baseCandidate,
    candidateKey: "synthetic-before-price",
    product: { kind: "exact-identifier", scheme: "gtin", value: "70000002" },
    pricing: { kind: "unit", offerPriceOre: 3_990, beforePriceOre: 4_990 },
  },
  {
    ...baseCandidate,
    candidateKey: "synthetic-multibuy",
    product: { kind: "exact-identifier", scheme: "gtin", value: "70000003" },
    pricing: { kind: "multibuy", quantity: 3, totalOre: 10_000, beforeUnitPriceOre: 3_990 },
  },
  {
    ...baseCandidate,
    candidateKey: "synthetic-member",
    product: { kind: "exact-identifier", scheme: "gtin", value: "70000004" },
    pricing: { kind: "unit", offerPriceOre: 1_990, beforePriceOre: 2_490 },
    eligibility: { kind: "member", programId: "synthetic-member-program" },
  },
  {
    ...baseCandidate,
    candidateKey: "synthetic-package-size",
    product: { kind: "exact-identifier", scheme: "gtin", value: "70000005" },
    package: { state: "parsed", amount: 750, unit: "ml", unitsPerPack: 2 },
    pricing: { kind: "unit", offerPriceOre: 5_490 },
  },
] as const;

export const syntheticUnreadableDateOfferCandidate = {
  ...baseCandidate,
  candidateKey: "synthetic-unreadable-date",
  product: { kind: "exact-identifier", scheme: "gtin", value: "70000001" },
  pricing: { kind: "unit", offerPriceOre: 2_990 },
  validity: { state: "unreadable", reasonCode: "OCR_AMBIGUOUS" },
} as const;

export const syntheticContradictoryBeforePriceCandidate = {
  ...baseCandidate,
  candidateKey: "synthetic-price-anomaly",
  product: { kind: "exact-identifier", scheme: "gtin", value: "70000002" },
  pricing: { kind: "unit", offerPriceOre: 5_000, beforePriceOre: 4_000 },
} as const;

export const syntheticStructuredExtractionEnvelope = {
  contractVersion: 1,
  captureChecksumSha256: SYNTHETIC_OFFER_CAPTURE_CHECKSUM,
  extractorVersion: "synthetic-structured-v1",
  method: "structured",
  layoutFingerprintSha256: SYNTHETIC_OFFER_LAYOUT_FINGERPRINT,
  schemaFingerprintSha256: SYNTHETIC_OFFER_SCHEMA_FINGERPRINT,
  startedAt: "2026-07-12T12:01:00.000Z",
  completedAt: "2026-07-12T12:01:01.000Z",
  emptyResult: "not-empty",
  candidates: syntheticStructuredOfferCandidates,
} as const;

export const syntheticExactProductIdsByGtin = Object.freeze({
  "70000001": ["product:synthetic-1"],
  "70000002": ["product:synthetic-2"],
  "70000003": ["product:synthetic-3"],
  "70000004": ["product:synthetic-4"],
  "70000005": ["product:synthetic-5"],
});
