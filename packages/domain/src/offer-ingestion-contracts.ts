import { z } from "zod";

import {
  canonicalTimestampSchema,
  contractVersionSchema,
  hasUniqueStrings,
  identifierSchema,
  nonEmptyStringSchema,
  positiveSafeIntegerSchema,
  sourceIdSchema,
} from "./contract-primitives";
import { MAX_PERSISTED_MONEY_ORE } from "./contracts";
import { geographicScopeSchema, type GeographicScope } from "./geography";

export const OFFICIAL_OFFER_FOUNDATION_ACTIVATION = Object.freeze({
  contractVersion: 1 as const,
  enabled: false as const,
  reason: "No rights-cleared production source or public-ranking activation approval",
});

export const officialOfferFoundationActivationSchema = z
  .object({
    contractVersion: contractVersionSchema,
    enabled: z.literal(false),
    reason: nonEmptyStringSchema,
  })
  .strict();

export const officialOfferRightsClassificationSchema = z.enum([
  "private_review",
  "extract_only",
  "public_display",
]);

export const MAX_OFFICIAL_OFFER_SCOPE_MEMBERS_PER_ENVELOPE = 10_000;
export const MAX_OFFICIAL_OFFER_EXTRACTION_DURATION_MS = 10 * 60 * 1_000;
export const MAX_OFFICIAL_OFFER_CLOCK_SKEW_MS = 5_000;

export const officialOfferExtractionMethodSchema = z.enum([
  "structured",
  "embedded-text",
  "ocr",
]);

export const officialOfferAnomalyCodeSchema = z.enum([
  "AMBIGUOUS_PRODUCT",
  "BEFORE_PRICE_BELOW_OFFER",
  "DUPLICATE_CANDIDATE_KEY",
  "DUPLICATE_OFFER",
  "EXTRACTOR_ANOMALY",
  "LAYOUT_DRIFT",
  "OCR_REVIEW_REQUIRED",
  "PACKAGE_UNKNOWN",
  "SCHEMA_DRIFT",
  "SCOPE_MISMATCH",
  "UNEXPECTED_EMPTY",
  "UNKNOWN_SCOPE",
  "UNMATCHED_PRODUCT",
  "UNREADABLE_DATE",
  "VALIDITY_OUTSIDE_EDITION",
]);

export type OfficialOfferAnomalyCode = z.infer<typeof officialOfferAnomalyCodeSchema>;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const chainSchema = z.enum(["bunnpris", "rema-1000", "extra"]);
const databaseMoneySchema = z.number().int().nonnegative().max(MAX_PERSISTED_MONEY_ORE);
const boundedMimeTypeSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu);

export const officialOfferAuthorizationCapabilitySchema = z.enum([
  "capture",
  "discover",
  "extract",
  "ocr",
]);

export type OfficialOfferAuthorizationCapability = z.infer<
  typeof officialOfferAuthorizationCapabilitySchema
>;

function hasCanonicalStringOrder(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

export const officialOfferAuthorizationFenceV1Schema = z
  .object({
    contractVersion: contractVersionSchema,
    permissionId: positiveSafeIntegerSchema,
    sourceId: sourceIdSchema.max(64),
    decision: z.literal("approved"),
    capabilities: z.array(officialOfferAuthorizationCapabilitySchema).min(3).max(4),
    rightsClassifications: z.array(officialOfferRightsClassificationSchema).min(1).max(3),
    reviewedAt: canonicalTimestampSchema,
    validUntil: canonicalTimestampSchema.optional(),
    evaluatedAt: canonicalTimestampSchema,
  })
  .strict()
  .superRefine((fence, context) => {
    if (!hasUniqueStrings(fence.capabilities) || !hasCanonicalStringOrder(fence.capabilities)) {
      context.addIssue({
        code: "custom",
        message: "Authorization-fence capabilities must be unique and canonically ordered",
        path: ["capabilities"],
      });
    }
    for (const required of ["capture", "discover", "extract"] as const) {
      if (!fence.capabilities.includes(required)) {
        context.addIssue({
          code: "custom",
          message: `Authorization fence must include ${required}`,
          path: ["capabilities"],
        });
      }
    }
    if (
      !hasUniqueStrings(fence.rightsClassifications)
      || !hasCanonicalStringOrder(fence.rightsClassifications)
    ) {
      context.addIssue({
        code: "custom",
        message: "Authorization-fence rights classifications must be unique and canonically ordered",
        path: ["rightsClassifications"],
      });
    }
    if (Date.parse(fence.reviewedAt) > Date.parse(fence.evaluatedAt)) {
      context.addIssue({
        code: "custom",
        message: "Authorization-fence review cannot occur after evaluation",
        path: ["reviewedAt"],
      });
    }
    if (
      fence.validUntil !== undefined
      && Date.parse(fence.validUntil) <= Date.parse(fence.evaluatedAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "Authorization fence must remain current at evaluation",
        path: ["validUntil"],
      });
    }
  });

export type OfficialOfferAuthorizationFenceV1 = z.infer<
  typeof officialOfferAuthorizationFenceV1Schema
>;

const editionAuthorizationSchema = z
  .object({
    decision: z.literal("approved"),
    capabilities: z.array(officialOfferAuthorizationCapabilitySchema).min(3).max(4),
    reviewedAt: canonicalTimestampSchema,
    validUntil: canonicalTimestampSchema.optional(),
  })
  .strict()
  .superRefine(({ capabilities, reviewedAt, validUntil }, context) => {
    if (!hasUniqueStrings(capabilities)) {
      context.addIssue({
        code: "custom",
        message: "Authorization capabilities must be unique",
        path: ["capabilities"],
      });
    }
    for (const required of ["discover", "capture", "extract"] as const) {
      if (!capabilities.includes(required)) {
        context.addIssue({
          code: "custom",
          message: `Authorization must include ${required}`,
          path: ["capabilities"],
        });
      }
    }
    if (validUntil !== undefined && Date.parse(reviewedAt) >= Date.parse(validUntil)) {
      context.addIssue({
        code: "custom",
        message: "Authorization validity must end after review",
        path: ["validUntil"],
      });
    }
  });

export const officialOfferEditionDiscoveryInputV1Schema = z
  .object({
    contractVersion: contractVersionSchema,
    sourceId: sourceIdSchema.max(64),
    externalEditionId: identifierSchema.max(160),
    chain: chainSchema,
    title: nonEmptyStringSchema.max(240),
    contentKind: z.enum(["structured-feed", "publication"]),
    geographicScopeId: positiveSafeIntegerSchema,
    declaredGeographicScope: geographicScopeSchema,
    validFrom: canonicalTimestampSchema,
    validUntil: canonicalTimestampSchema,
    discoveredAt: canonicalTimestampSchema,
    authorization: editionAuthorizationSchema,
  })
  .strict()
  .superRefine((edition, context) => {
    if (Date.parse(edition.validFrom) >= Date.parse(edition.validUntil)) {
      context.addIssue({
        code: "custom",
        message: "Edition validity must end after it begins",
        path: ["validUntil"],
      });
    }
    if (
      edition.authorization.validUntil !== undefined
      && Date.parse(edition.discoveredAt) >= Date.parse(edition.authorization.validUntil)
    ) {
      context.addIssue({
        code: "custom",
        message: "Edition discovery requires current authorization",
        path: ["authorization", "validUntil"],
      });
    }
    if (Date.parse(edition.authorization.reviewedAt) > Date.parse(edition.discoveredAt)) {
      context.addIssue({
        code: "custom",
        message: "Edition discovery cannot rely on a future authorization review",
        path: ["authorization", "reviewedAt"],
      });
    }
  });

export type OfficialOfferEditionDiscoveryInputV1 = z.infer<
  typeof officialOfferEditionDiscoveryInputV1Schema
>;

export function canonicalOfficialOfferEditionIdentity(
  input: OfficialOfferEditionDiscoveryInputV1,
): string {
  const edition = officialOfferEditionDiscoveryInputV1Schema.parse(input);
  return JSON.stringify([
    edition.contractVersion,
    edition.sourceId,
    edition.externalEditionId,
    edition.chain,
    edition.title,
    edition.contentKind,
    edition.geographicScopeId,
    geographicScopeIdentity(edition.declaredGeographicScope),
    edition.validFrom,
    edition.validUntil,
    edition.discoveredAt,
  ]);
}

export const officialOfferCaptureMetadataV1Schema = z
  .object({
    contractVersion: contractVersionSchema,
    publicationId: positiveSafeIntegerSchema,
    sourceId: sourceIdSchema.max(64),
    externalEditionId: identifierSchema.max(160),
    checksumSha256: sha256Schema,
    mimeType: boundedMimeTypeSchema,
    byteLength: positiveSafeIntegerSchema.max(50 * 1024 * 1024),
    rightsClassification: officialOfferRightsClassificationSchema,
    retrievedAt: canonicalTimestampSchema,
  })
  .strict();

export type OfficialOfferCaptureMetadataV1 = z.infer<
  typeof officialOfferCaptureMetadataV1Schema
>;

export const officialOfferExtractionTimingV1Schema = z
  .object({
    contractVersion: contractVersionSchema,
    serverStartedAt: canonicalTimestampSchema,
    serverCompletedAt: canonicalTimestampSchema,
  })
  .strict()
  .superRefine(({ serverStartedAt, serverCompletedAt }, context) => {
    const duration = Date.parse(serverCompletedAt) - Date.parse(serverStartedAt);
    if (duration < 0 || duration > MAX_OFFICIAL_OFFER_EXTRACTION_DURATION_MS) {
      context.addIssue({
        code: "custom",
        message: "Server-owned extraction timing is outside the bounded duration",
        path: ["serverCompletedAt"],
      });
    }
  });

export type OfficialOfferExtractionTimingV1 = z.infer<
  typeof officialOfferExtractionTimingV1Schema
>;

const exactIdentifierProductSchema = z
  .object({
    kind: z.literal("exact-identifier"),
    scheme: z.literal("gtin"),
    value: z.string().regex(/^(?:[0-9]{8}|[0-9]{13})$/u),
  })
  .strict();

const unresolvedProductSchema = z
  .object({
    kind: z.literal("unresolved-label"),
    label: nonEmptyStringSchema.max(240),
    brand: nonEmptyStringSchema.max(160).optional(),
  })
  .strict();

const parsedPackageSchema = z
  .object({
    state: z.literal("parsed"),
    amount: positiveSafeIntegerSchema.max(1_000_000),
    unit: z.enum(["g", "ml", "piece", "package"]),
    unitsPerPack: positiveSafeIntegerSchema.max(10_000),
  })
  .strict();

const unknownPackageSchema = z
  .object({
    state: z.literal("unknown"),
    reasonCode: z.enum(["MISSING", "UNREADABLE", "UNSUPPORTED_UNIT"]),
  })
  .strict();

const unitPricingSchema = z
  .object({
    kind: z.literal("unit"),
    offerPriceOre: databaseMoneySchema,
    beforePriceOre: databaseMoneySchema.optional(),
  })
  .strict();

const multibuyPricingSchema = z
  .object({
    kind: z.literal("multibuy"),
    quantity: positiveSafeIntegerSchema.min(2).max(100),
    totalOre: databaseMoneySchema,
    beforeUnitPriceOre: databaseMoneySchema.optional(),
  })
  .strict();

const parsedValiditySchema = z
  .object({
    state: z.literal("parsed"),
    startsAt: canonicalTimestampSchema,
    endsAt: canonicalTimestampSchema,
  })
  .strict()
  .refine(({ startsAt, endsAt }) => Date.parse(startsAt) < Date.parse(endsAt), {
    message: "Candidate validity must end after it begins",
    path: ["endsAt"],
  });

const unreadableValiditySchema = z
  .object({
    state: z.literal("unreadable"),
    reasonCode: z.enum(["MISSING", "OCR_AMBIGUOUS", "UNSUPPORTED_FORMAT"]),
  })
  .strict();

const publicEligibilitySchema = z.object({ kind: z.literal("public") }).strict();
const memberEligibilitySchema = z
  .object({
    kind: z.literal("member"),
    programId: identifierSchema,
  })
  .strict();

const extractionProvenanceSchema = z
  .object({
    method: officialOfferExtractionMethodSchema,
    evidenceLocator: identifierSchema,
    confidence: z.number().int().min(0).max(100),
  })
  .strict();

export const extractedOfficialOfferCandidateV1Schema = z
  .object({
    contractVersion: contractVersionSchema,
    candidateKey: identifierSchema.max(160),
    product: z.discriminatedUnion("kind", [
      exactIdentifierProductSchema,
      unresolvedProductSchema,
    ]),
    package: z.discriminatedUnion("state", [parsedPackageSchema, unknownPackageSchema]),
    pricing: z.discriminatedUnion("kind", [unitPricingSchema, multibuyPricingSchema]),
    eligibility: z.discriminatedUnion("kind", [
      publicEligibilitySchema,
      memberEligibilitySchema,
    ]),
    validity: z.discriminatedUnion("state", [
      parsedValiditySchema,
      unreadableValiditySchema,
    ]),
    geographicScope: geographicScopeSchema,
    channels: z.array(z.enum(["in-store", "online"])).min(1).max(2),
    provenance: extractionProvenanceSchema,
    anomalyCodes: z.array(officialOfferAnomalyCodeSchema).max(20),
  })
  .strict()
  .superRefine(({ anomalyCodes, channels }, context) => {
    if (!hasUniqueStrings(anomalyCodes)) {
      context.addIssue({
        code: "custom",
        message: "Candidate anomaly codes must be unique",
        path: ["anomalyCodes"],
      });
    }
    if (!hasUniqueStrings(channels)) {
      context.addIssue({
        code: "custom",
        message: "Candidate channels must be unique",
        path: ["channels"],
      });
    }
  });

export type ExtractedOfficialOfferCandidateV1 = z.infer<
  typeof extractedOfficialOfferCandidateV1Schema
>;

const confirmedEmptyEvidenceSchema = z
  .object({
    sourceId: sourceIdSchema.max(64),
    externalEditionId: identifierSchema.max(160),
    basis: z.enum(["source-declared-empty", "source-record-count-zero"]),
    evidenceLocator: identifierSchema,
  })
  .strict();

export const officialOfferExtractionEnvelopeV1Schema = z
  .object({
    contractVersion: contractVersionSchema,
    captureChecksumSha256: sha256Schema,
    extractorVersion: identifierSchema.max(80),
    method: officialOfferExtractionMethodSchema,
    layoutFingerprintSha256: sha256Schema,
    schemaFingerprintSha256: sha256Schema,
    startedAt: canonicalTimestampSchema,
    completedAt: canonicalTimestampSchema,
    emptyResult: z.enum(["not-empty", "confirmed-empty", "unexpected-empty"]),
    emptyConfirmation: confirmedEmptyEvidenceSchema.optional(),
    candidates: z.array(extractedOfficialOfferCandidateV1Schema).max(500),
  })
  .strict()
  .superRefine((envelope, context) => {
    if (Date.parse(envelope.startedAt) > Date.parse(envelope.completedAt)) {
      context.addIssue({
        code: "custom",
        message: "Extraction completion cannot precede its start",
        path: ["completedAt"],
      });
    }
    if ((envelope.candidates.length === 0) !== (envelope.emptyResult !== "not-empty")) {
      context.addIssue({
        code: "custom",
        message: "Extraction empty-result state must match candidate cardinality",
        path: ["emptyResult"],
      });
    }
    if (
      (envelope.emptyResult === "confirmed-empty")
      !== (envelope.emptyConfirmation !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "A confirmed-empty result requires source-bound confirmation evidence",
        path: ["emptyConfirmation"],
      });
    }
    for (const [index, candidate] of envelope.candidates.entries()) {
      if (candidate.provenance.method !== envelope.method) {
        context.addIssue({
          code: "custom",
          message: "Candidate provenance must match the extraction method",
          path: ["candidates", index, "provenance", "method"],
        });
      }
    }
    const totalScopeMembers = envelope.candidates.reduce((total, candidate) => {
      switch (candidate.geographicScope.kind) {
        case "regions":
          return total + candidate.geographicScope.regionCodes.length;
        case "postal-set":
          return total + candidate.geographicScope.postalCodes.length;
        case "stores":
          return total + candidate.geographicScope.storeIds.length;
        default:
          return total + 1;
      }
    }, 0);
    if (totalScopeMembers > MAX_OFFICIAL_OFFER_SCOPE_MEMBERS_PER_ENVELOPE) {
      context.addIssue({
        code: "custom",
        message: "Extraction envelope geographic scope cardinality is too large",
        path: ["candidates"],
      });
    }
  });

export type OfficialOfferExtractionEnvelopeV1 = z.infer<
  typeof officialOfferExtractionEnvelopeV1Schema
>;

export type ValidatedOfficialOfferCandidateV1 = {
  contractVersion: 1;
  anomalyCodes: readonly OfficialOfferAnomalyCode[];
  candidate: ExtractedOfficialOfferCandidateV1;
  disposition: "exact-match" | "rejected" | "review-required";
  publicationRoute: "blocked" | "human-review-required";
  exactCanonicalProductId?: string;
};

export type OfficialOfferExtractionValidation = {
  candidates: readonly ValidatedOfficialOfferCandidateV1[];
  counts: Readonly<{
    exactMatch: number;
    rejected: number;
    reviewRequired: number;
    total: number;
  }>;
  errorClass?: "INVALID_CONTRACT" | "LAYOUT_DRIFT" | "SCHEMA_DRIFT" | "UNEXPECTED_EMPTY";
  status: "completed" | "degraded" | "failed";
};

const exactProductIdsByGtinSchema = z
  .record(
    z.string().regex(/^(?:[0-9]{8}|[0-9]{13})$/u),
    z.array(identifierSchema.max(200)).max(20).refine(hasUniqueStrings, {
      message: "Canonical product matches must be unique",
    }),
  )
  .superRefine((lookups, context) => {
    if (Object.keys(lookups).length > 500) {
      context.addIssue({
        code: "custom",
        message: "Exact-product lookup context cannot exceed 500 GTINs",
      });
    }
  });

export const officialOfferExtractionValidationContextV1Schema = z
  .object({
    contractVersion: contractVersionSchema,
    expectedLayoutFingerprintsSha256: z.array(sha256Schema).min(1).max(20),
    expectedSchemaFingerprintSha256: sha256Schema,
    exactProductIdsByGtin: exactProductIdsByGtinSchema,
  })
  .strict();

export interface OfficialOfferExtractionValidationContext {
  readonly contractVersion: 1;
  readonly exactProductIdsByGtin: Readonly<Record<string, readonly string[]>>;
  readonly expectedLayoutFingerprintsSha256: readonly string[];
  readonly expectedSchemaFingerprintSha256: string;
}

function addAnomaly(
  anomalies: OfficialOfferAnomalyCode[],
  anomaly: OfficialOfferAnomalyCode,
): void {
  if (!anomalies.includes(anomaly)) anomalies.push(anomaly);
}

function geographicScopeKey(scope: GeographicScope): string {
  switch (scope.kind) {
    case "national":
      return `national:${scope.countryCode}`;
    case "regions":
      return `regions:${scope.countryCode}:${[...scope.regionCodes].sort().join(",")}`;
    case "postal-set":
      return `postal-set:${scope.countryCode}:${[...scope.postalCodes].sort().join(",")}`;
    case "stores":
      return `stores:${[...scope.storeIds].sort().join(",")}`;
    case "unknown":
      return `unknown:${scope.reason}`;
  }
}

function geographicScopeIdentity(scope: GeographicScope): readonly unknown[] {
  switch (scope.kind) {
    case "national":
      return ["national", scope.countryCode];
    case "regions":
      return ["regions", scope.countryCode, [...scope.regionCodes].sort()];
    case "postal-set":
      return ["postal-set", scope.countryCode, [...scope.postalCodes].sort()];
    case "stores":
      return ["stores", [...scope.storeIds].sort()];
    case "unknown":
      return ["unknown", scope.reason];
  }
}

function candidateSignature(candidate: ExtractedOfficialOfferCandidateV1): string {
  const product = candidate.product.kind === "exact-identifier"
    ? ["gtin", candidate.product.value]
    : ["label", candidate.product.label, candidate.product.brand ?? null];
  const pricing = candidate.pricing.kind === "unit"
    ? ["unit", candidate.pricing.offerPriceOre, candidate.pricing.beforePriceOre ?? null]
    : [
        "multi",
        candidate.pricing.quantity,
        candidate.pricing.totalOre,
        candidate.pricing.beforeUnitPriceOre ?? null,
      ];
  const validity = candidate.validity.state === "parsed"
    ? ["parsed", candidate.validity.startsAt, candidate.validity.endsAt]
    : ["unreadable", candidate.validity.reasonCode];
  const packageIdentity = candidate.package.state === "parsed"
    ? [
        "parsed",
        candidate.package.amount,
        candidate.package.unit,
        candidate.package.unitsPerPack,
      ]
    : ["unknown", candidate.package.reasonCode];
  const eligibility = candidate.eligibility.kind === "public"
    ? ["public"]
    : ["member", candidate.eligibility.programId];
  return JSON.stringify([
    product,
    packageIdentity,
    pricing,
    eligibility,
    validity,
    geographicScopeIdentity(candidate.geographicScope),
    [...candidate.channels].sort(),
  ]);
}

function pricingIsInvalid(candidate: ExtractedOfficialOfferCandidateV1): boolean {
  if (candidate.pricing.kind === "unit") {
    return candidate.pricing.beforePriceOre !== undefined
      && candidate.pricing.beforePriceOre < candidate.pricing.offerPriceOre;
  }
  return candidate.pricing.beforeUnitPriceOre !== undefined
    && BigInt(candidate.pricing.beforeUnitPriceOre) * BigInt(candidate.pricing.quantity)
      < BigInt(candidate.pricing.totalOre);
}

function emptyCounts() {
  return Object.freeze({ exactMatch: 0, rejected: 0, reviewRequired: 0, total: 0 });
}

export function validateOfficialOfferExtraction(
  envelopeInput: unknown,
  editionInput: unknown,
  validationContextInput: unknown,
): OfficialOfferExtractionValidation {
  const envelope = officialOfferExtractionEnvelopeV1Schema.safeParse(envelopeInput);
  const edition = officialOfferEditionDiscoveryInputV1Schema.safeParse(editionInput);
  const validationContext = officialOfferExtractionValidationContextV1Schema.safeParse(
    validationContextInput,
  );
  if (!envelope.success || !edition.success || !validationContext.success) {
    return Object.freeze({
      candidates: Object.freeze([]),
      counts: emptyCounts(),
      errorClass: "INVALID_CONTRACT",
      status: "failed",
    });
  }
  const requestedGtins = [...new Set(envelope.data.candidates.flatMap((candidate) =>
    candidate.product.kind === "exact-identifier" ? [candidate.product.value] : []))].sort();
  const lookupGtins = Object.keys(validationContext.data.exactProductIdsByGtin).sort();
  if (
    requestedGtins.length !== lookupGtins.length
    || requestedGtins.some((gtin, index) => gtin !== lookupGtins[index])
  ) {
    return Object.freeze({
      candidates: Object.freeze([]),
      counts: emptyCounts(),
      errorClass: "INVALID_CONTRACT",
      status: "failed",
    });
  }
  if (envelope.data.schemaFingerprintSha256 !== validationContext.data.expectedSchemaFingerprintSha256) {
    return Object.freeze({
      candidates: Object.freeze([]),
      counts: emptyCounts(),
      errorClass: "SCHEMA_DRIFT",
      status: "failed",
    });
  }
  if (!validationContext.data.expectedLayoutFingerprintsSha256.includes(
    envelope.data.layoutFingerprintSha256,
  )) {
    return Object.freeze({
      candidates: Object.freeze([]),
      counts: emptyCounts(),
      errorClass: "LAYOUT_DRIFT",
      status: "degraded",
    });
  }
  if (
    envelope.data.emptyResult === "confirmed-empty"
    && (
      envelope.data.emptyConfirmation?.sourceId !== edition.data.sourceId
      || envelope.data.emptyConfirmation?.externalEditionId !== edition.data.externalEditionId
    )
  ) {
    return Object.freeze({
      candidates: Object.freeze([]),
      counts: emptyCounts(),
      errorClass: "INVALID_CONTRACT",
      status: "failed",
    });
  }
  if (
    envelope.data.emptyResult === "unexpected-empty"
    || (envelope.data.method === "ocr" && envelope.data.candidates.length === 0)
  ) {
    return Object.freeze({
      candidates: Object.freeze([]),
      counts: emptyCounts(),
      errorClass: "UNEXPECTED_EMPTY",
      status: "degraded",
    });
  }
  if (envelope.data.candidates.length === 0) {
    return Object.freeze({
      candidates: Object.freeze([]),
      counts: emptyCounts(),
      status: "completed",
    });
  }

  const keyCounts = new Map<string, number>();
  const signatureCounts = new Map<string, number>();
  for (const candidate of envelope.data.candidates) {
    keyCounts.set(candidate.candidateKey, (keyCounts.get(candidate.candidateKey) ?? 0) + 1);
    const signature = candidateSignature(candidate);
    signatureCounts.set(signature, (signatureCounts.get(signature) ?? 0) + 1);
  }

  const validated = envelope.data.candidates.map((candidate) => {
    const anomalies = [...candidate.anomalyCodes];
    if ((keyCounts.get(candidate.candidateKey) ?? 0) > 1) {
      addAnomaly(anomalies, "DUPLICATE_CANDIDATE_KEY");
    }
    if ((signatureCounts.get(candidateSignature(candidate)) ?? 0) > 1) {
      addAnomaly(anomalies, "DUPLICATE_OFFER");
    }
    if (pricingIsInvalid(candidate)) addAnomaly(anomalies, "BEFORE_PRICE_BELOW_OFFER");
    if (candidate.validity.state === "unreadable") addAnomaly(anomalies, "UNREADABLE_DATE");
    if (
      candidate.validity.state === "parsed"
      && (
        Date.parse(candidate.validity.startsAt) < Date.parse(edition.data.validFrom)
        || Date.parse(candidate.validity.endsAt) > Date.parse(edition.data.validUntil)
      )
    ) {
      addAnomaly(anomalies, "VALIDITY_OUTSIDE_EDITION");
    }
    if (candidate.package.state === "unknown") addAnomaly(anomalies, "PACKAGE_UNKNOWN");
    if (candidate.geographicScope.kind === "unknown") {
      addAnomaly(anomalies, "UNKNOWN_SCOPE");
    } else if (
      geographicScopeKey(candidate.geographicScope)
      !== geographicScopeKey(edition.data.declaredGeographicScope)
    ) {
      addAnomaly(anomalies, "SCOPE_MISMATCH");
    }
    if (candidate.provenance.method === "ocr") {
      addAnomaly(anomalies, "OCR_REVIEW_REQUIRED");
    }

    let exactCanonicalProductId: string | undefined;
    if (candidate.product.kind === "exact-identifier") {
      const matches = validationContext.data.exactProductIdsByGtin[candidate.product.value] ?? [];
      if (matches.length === 1) exactCanonicalProductId = matches[0];
      else if (matches.length === 0) addAnomaly(anomalies, "UNMATCHED_PRODUCT");
      else addAnomaly(anomalies, "AMBIGUOUS_PRODUCT");
    } else {
      addAnomaly(anomalies, "UNMATCHED_PRODUCT");
    }

    const rejected = anomalies.some((anomaly) => [
      "BEFORE_PRICE_BELOW_OFFER",
      "DUPLICATE_CANDIDATE_KEY",
    ].includes(anomaly));
    const disposition = rejected
      ? "rejected" as const
      : anomalies.length > 0
        ? "review-required" as const
        : "exact-match" as const;
    const normalizedAnomalies = anomalies.sort();
    const normalizedCandidate = extractedOfficialOfferCandidateV1Schema.parse({
      ...candidate,
      anomalyCodes: normalizedAnomalies,
    });
    Object.freeze(normalizedCandidate.anomalyCodes);
    Object.freeze(normalizedCandidate);
    return Object.freeze({
      contractVersion: 1 as const,
      anomalyCodes: Object.freeze([...normalizedAnomalies]),
      candidate: normalizedCandidate,
      disposition,
      // `exact-match` describes product-resolution quality only. V1 never
      // turns that classifier into publication authority: every usable
      // candidate crosses the same evidence-bound human review transaction.
      publicationRoute: rejected ? "blocked" as const : "human-review-required" as const,
      ...(exactCanonicalProductId === undefined ? {} : { exactCanonicalProductId }),
    });
  });

  const counts = Object.freeze({
    exactMatch: validated.filter(({ disposition }) => disposition === "exact-match").length,
    rejected: validated.filter(({ disposition }) => disposition === "rejected").length,
    reviewRequired: validated.filter(({ disposition }) => disposition === "review-required").length,
    total: validated.length,
  });
  const degraded = validated.some(({ anomalyCodes, disposition }) =>
    disposition === "rejected"
    || anomalyCodes.some((anomaly) => [
      "EXTRACTOR_ANOMALY",
      "SCOPE_MISMATCH",
      "UNKNOWN_SCOPE",
      "UNREADABLE_DATE",
      "VALIDITY_OUTSIDE_EDITION",
    ].includes(anomaly)));
  return Object.freeze({
    candidates: Object.freeze(validated),
    counts,
    status: degraded ? "degraded" : "completed",
  });
}
