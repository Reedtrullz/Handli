import { z } from "zod";

import {
  canonicalTimestampSchema,
  contractVersionSchema,
  hasUniqueStrings,
  identifierSchema,
  nonEmptyStringSchema,
} from "./contract-primitives";

const countryCodeSchema = z.string().regex(/^[A-Z]{2}$/);
export const postalCodeSchema = z.string().regex(/^[0-9]{4}$/u);
export const MAX_GEOGRAPHIC_REGION_CODES = 100;
export const MAX_GEOGRAPHIC_STORE_IDS = 1_000;
export const MAX_GEOGRAPHIC_POSTAL_CODES = 10_000;

function hasCanonicalStringOrder(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

const nationalScopeSchema = z
  .object({
    kind: z.literal("national"),
    countryCode: countryCodeSchema,
  })
  .strict();

const regionsScopeSchema = z
  .object({
    kind: z.literal("regions"),
    countryCode: countryCodeSchema,
    regionCodes: z.array(identifierSchema).min(1).max(MAX_GEOGRAPHIC_REGION_CODES),
  })
  .strict()
  .refine(({ regionCodes }) => hasUniqueStrings(regionCodes), {
    message: "Region codes must be unique",
    path: ["regionCodes"],
  });

const postalSetScopeSchema = z
  .object({
    kind: z.literal("postal-set"),
    countryCode: countryCodeSchema,
    postalCodes: z.array(postalCodeSchema).min(1).max(MAX_GEOGRAPHIC_POSTAL_CODES),
  })
  .strict()
  .refine(({ postalCodes }) => hasUniqueStrings(postalCodes), {
    message: "Postal codes must be unique",
    path: ["postalCodes"],
  })
  .refine(({ postalCodes }) => hasCanonicalStringOrder(postalCodes), {
    message: "Postal codes must use canonical ascending order",
    path: ["postalCodes"],
  });

const storesScopeSchema = z
  .object({
    kind: z.literal("stores"),
    storeIds: z.array(identifierSchema).min(1).max(MAX_GEOGRAPHIC_STORE_IDS),
  })
  .strict()
  .refine(({ storeIds }) => hasUniqueStrings(storeIds), {
    message: "Store IDs must be unique",
    path: ["storeIds"],
  });

const unknownScopeSchema = z
  .object({
    kind: z.literal("unknown"),
    reason: nonEmptyStringSchema,
  })
  .strict();

export const geographicScopeSchema = z.discriminatedUnion("kind", [
  nationalScopeSchema,
  regionsScopeSchema,
  postalSetScopeSchema,
  storesScopeSchema,
  unknownScopeSchema,
]);

export type GeographicScope = z.infer<typeof geographicScopeSchema>;

export const geographicContextSchema = z
  .object({
    countryCode: countryCodeSchema,
    regionCode: identifierSchema.optional(),
    postalCode: postalCodeSchema.optional(),
    storeId: identifierSchema.optional(),
  })
  .strict();

export type GeographicContext = z.infer<typeof geographicContextSchema>;

const postalDirectoryRegionSchema = z
  .object({
    coverageState: z.enum(["complete", "ambiguous"]),
    evidenceReference: nonEmptyStringSchema,
    postalCodes: z.array(postalCodeSchema).max(MAX_GEOGRAPHIC_POSTAL_CODES),
    regionCode: identifierSchema,
  })
  .strict()
  .superRefine(({ coverageState, postalCodes }, context) => {
    if (!hasUniqueStrings(postalCodes)) {
      context.addIssue({
        code: "custom",
        message: "Directory postal codes must be unique",
        path: ["postalCodes"],
      });
    }
    if (!hasCanonicalStringOrder(postalCodes)) {
      context.addIssue({
        code: "custom",
        message: "Directory postal codes must use canonical ascending order",
        path: ["postalCodes"],
      });
    }
    if (coverageState === "complete" && postalCodes.length === 0) {
      context.addIssue({
        code: "custom",
        message: "A complete directory region requires postal codes",
        path: ["postalCodes"],
      });
    }
  });

export const geographicPostalDirectorySchema = z
  .object({
    contractVersion: z.literal(1),
    countryCode: countryCodeSchema,
    directoryVersionId: identifierSchema,
    evidenceReference: nonEmptyStringSchema,
    publishedAt: canonicalTimestampSchema,
    regions: z.array(postalDirectoryRegionSchema).min(1).max(100),
    reviewedAt: canonicalTimestampSchema,
    status: z.literal("approved"),
    validFrom: canonicalTimestampSchema,
    validUntil: canonicalTimestampSchema.optional(),
  })
  .strict()
  .superRefine(({ publishedAt, regions, reviewedAt, validFrom, validUntil }, context) => {
    if (!hasUniqueStrings(regions.map(({ regionCode }) => regionCode))) {
      context.addIssue({
        code: "custom",
        message: "Directory region codes must be unique",
        path: ["regions"],
      });
    }
    if (!hasCanonicalStringOrder(regions.map(({ regionCode }) => regionCode))) {
      context.addIssue({
        code: "custom",
        message: "Directory regions must use canonical ascending order",
        path: ["regions"],
      });
    }
    if (validUntil !== undefined && Date.parse(validFrom) >= Date.parse(validUntil)) {
      context.addIssue({
        code: "custom",
        message: "Directory validity must end after it begins",
        path: ["validUntil"],
      });
    }
    if (Date.parse(reviewedAt) > Date.parse(publishedAt)) {
      context.addIssue({
        code: "custom",
        message: "Directory review cannot occur after publication",
        path: ["reviewedAt"],
      });
    }
  });

export type GeographicPostalDirectory = z.infer<typeof geographicPostalDirectorySchema>;

export const geographicDirectoryEvidenceSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("available"),
    directory: geographicPostalDirectorySchema,
    evaluatedAt: canonicalTimestampSchema,
  }).strict(),
  z.object({ state: z.literal("unknown"), reason: nonEmptyStringSchema }).strict(),
  z.object({ state: z.literal("ambiguous"), reason: nonEmptyStringSchema }).strict(),
]);

export type GeographicDirectoryEvidence = z.infer<typeof geographicDirectoryEvidenceSchema>;

/**
 * A bounded public projection of the reviewed directory facts needed to
 * authorize one launch region. Responses never need to expose the complete
 * national directory: the selected region and at most 10,000 canonical postal
 * codes are sufficient to independently re-run postal-set applicability.
 */
export const geographicDirectoryRegionAttestationV1Schema = z
  .object({
    contractVersion: z.literal(1),
    countryCode: countryCodeSchema,
    directoryVersionId: identifierSchema,
    evaluatedAt: canonicalTimestampSchema,
    evidenceReference: nonEmptyStringSchema,
    publishedAt: canonicalTimestampSchema,
    region: postalDirectoryRegionSchema,
    reviewedAt: canonicalTimestampSchema,
    status: z.literal("approved"),
    validFrom: canonicalTimestampSchema,
    validUntil: canonicalTimestampSchema.optional(),
  })
  .strict()
  .superRefine((attestation, context) => {
    if (attestation.region.coverageState !== "complete") {
      context.addIssue({
        code: "custom",
        message: "A public directory attestation requires complete region coverage",
        path: ["region", "coverageState"],
      });
    }
    const evaluatedAt = Date.parse(attestation.evaluatedAt);
    if (
      Date.parse(attestation.publishedAt) > evaluatedAt
      || Date.parse(attestation.reviewedAt) > evaluatedAt
      || Date.parse(attestation.validFrom) > evaluatedAt
      || Date.parse(attestation.reviewedAt) > Date.parse(attestation.publishedAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "A public directory attestation must be current at evaluation",
        path: ["evaluatedAt"],
      });
    }
    if (
      attestation.validUntil !== undefined
      && Date.parse(attestation.validUntil) <= evaluatedAt
    ) {
      context.addIssue({
        code: "custom",
        message: "A public directory attestation cannot be expired",
        path: ["validUntil"],
      });
    }
  });

export type GeographicDirectoryRegionAttestationV1 = z.infer<
  typeof geographicDirectoryRegionAttestationV1Schema
>;

/** Projects only the selected complete region from trusted directory evidence. */
export function attestGeographicDirectoryRegionV1(
  evidence: GeographicDirectoryEvidence | undefined,
  regionCode: string | undefined,
): GeographicDirectoryRegionAttestationV1 | undefined {
  if (evidence?.state !== "available" || regionCode === undefined) return undefined;
  const region = evidence.directory.regions.find(
    (candidate) => candidate.regionCode === regionCode,
  );
  if (region?.coverageState !== "complete") return undefined;
  const parsed = geographicDirectoryRegionAttestationV1Schema.safeParse({
    contractVersion: 1,
    countryCode: evidence.directory.countryCode,
    directoryVersionId: evidence.directory.directoryVersionId,
    evaluatedAt: evidence.evaluatedAt,
    evidenceReference: evidence.directory.evidenceReference,
    publishedAt: evidence.directory.publishedAt,
    region,
    reviewedAt: evidence.directory.reviewedAt,
    status: evidence.directory.status,
    validFrom: evidence.directory.validFrom,
    ...(evidence.directory.validUntil === undefined
      ? {}
      : { validUntil: evidence.directory.validUntil }),
  });
  return parsed.success ? parsed.data : undefined;
}

/**
 * Rehydrates the existing applicability input only when the attestation is
 * bound to the exact selected region and evaluation clock.
 */
export function geographicDirectoryEvidenceFromRegionAttestationV1(
  attestation: GeographicDirectoryRegionAttestationV1,
  location: GeographicContext,
  evaluatedAt: string,
): GeographicDirectoryEvidence | undefined {
  const parsed = geographicDirectoryRegionAttestationV1Schema.safeParse(attestation);
  if (
    !parsed.success
    || parsed.data.evaluatedAt !== evaluatedAt
    || location.regionCode === undefined
    || parsed.data.countryCode !== location.countryCode
    || parsed.data.region.regionCode !== location.regionCode
  ) {
    return undefined;
  }
  return {
    state: "available",
    evaluatedAt: parsed.data.evaluatedAt,
    directory: {
      contractVersion: 1,
      countryCode: parsed.data.countryCode,
      directoryVersionId: parsed.data.directoryVersionId,
      evidenceReference: parsed.data.evidenceReference,
      publishedAt: parsed.data.publishedAt,
      regions: [parsed.data.region],
      reviewedAt: parsed.data.reviewedAt,
      status: parsed.data.status,
      validFrom: parsed.data.validFrom,
      ...(parsed.data.validUntil === undefined
        ? {}
        : { validUntil: parsed.data.validUntil }),
    },
  };
}

export type GeographicApplicability =
  | { state: "applicable"; specificity: 0 | 1 | 2 | 3 }
  | { state: "not-applicable" }
  | { state: "unknown"; reason: string }
  | { state: "ambiguous"; reason: string };

/**
 * Resolves a scope without collapsing missing directory proof or partial
 * postal overlap into a positive match. Region-level selection may admit a
 * postal set only when a current, versioned directory proves the set covers
 * every postal code in that region.
 */
export function resolveGeographicApplicability(
  scope: GeographicScope,
  location: GeographicContext,
  directoryEvidence?: GeographicDirectoryEvidence,
): GeographicApplicability {
  switch (scope.kind) {
    case "national":
      return scope.countryCode === location.countryCode
        ? { state: "applicable", specificity: 0 }
        : { state: "not-applicable" };
    case "regions":
      return scope.countryCode === location.countryCode
        && location.regionCode !== undefined
        && scope.regionCodes.includes(location.regionCode)
        ? { state: "applicable", specificity: 1 }
        : { state: "not-applicable" };
    case "postal-set": {
      if (scope.countryCode !== location.countryCode) return { state: "not-applicable" };
      if (location.postalCode !== undefined) {
        return scope.postalCodes.includes(location.postalCode)
          ? { state: "applicable", specificity: 2 }
          : { state: "not-applicable" };
      }
      if (location.regionCode === undefined) {
        return { state: "unknown", reason: "postal-location-unavailable" };
      }
      if (directoryEvidence === undefined || directoryEvidence.state === "unknown") {
        return {
          state: "unknown",
          reason: directoryEvidence?.reason ?? "postal-directory-unavailable",
        };
      }
      if (directoryEvidence.state === "ambiguous") {
        return { state: "ambiguous", reason: directoryEvidence.reason };
      }
      const parsedDirectory = geographicPostalDirectorySchema.safeParse(
        directoryEvidence.directory,
      );
      if (!parsedDirectory.success) {
        return { state: "unknown", reason: "invalid-postal-directory" };
      }
      const directory = parsedDirectory.data;
      const evaluatedAtMs = Date.parse(directoryEvidence.evaluatedAt);
      if (
        Date.parse(directory.publishedAt) > evaluatedAtMs
        || Date.parse(directory.reviewedAt) > evaluatedAtMs
        || Date.parse(directory.validFrom) > evaluatedAtMs
      ) {
        return { state: "unknown", reason: "postal-directory-not-current" };
      }
      if (
        directory.validUntil !== undefined
        && Date.parse(directory.validUntil) <= evaluatedAtMs
      ) {
        return { state: "unknown", reason: "postal-directory-not-current" };
      }
      if (directory.countryCode !== location.countryCode) {
        return { state: "not-applicable" };
      }
      const region = directory.regions.find(
        ({ regionCode }) => regionCode === location.regionCode,
      );
      if (region === undefined) {
        return { state: "unknown", reason: "postal-directory-region-unavailable" };
      }
      if (region.coverageState === "ambiguous") {
        return { state: "ambiguous", reason: "postal-directory-region-ambiguous" };
      }
      const scopeCodes = new Set(scope.postalCodes);
      const overlapCount = region.postalCodes.reduce(
        (count, postalCode) => count + (scopeCodes.has(postalCode) ? 1 : 0),
        0,
      );
      if (overlapCount === region.postalCodes.length) {
        return { state: "applicable", specificity: 2 };
      }
      return overlapCount === 0
        ? { state: "not-applicable" }
        : { state: "ambiguous", reason: "partial-postal-region-overlap" };
    }
    case "stores":
      return location.storeId !== undefined && scope.storeIds.includes(location.storeId)
        ? { state: "applicable", specificity: 3 }
        : { state: "not-applicable" };
    case "unknown":
      return { state: "unknown", reason: scope.reason };
  }
}

export function geographicScopeIncludes(
  scope: GeographicScope,
  location: GeographicContext,
  directoryEvidence?: GeographicDirectoryEvidence,
): boolean {
  return resolveGeographicApplicability(scope, location, directoryEvidence).state
    === "applicable";
}

/**
 * Returns the specificity of an applicable scope. A more specific regional
 * observation must beat a national observation for the same selected market,
 * regardless of which one was captured most recently. Store scope remains
 * unreachable unless the caller explicitly supplies a store ID.
 */
export function geographicScopeSpecificity(
  scope: GeographicScope,
  location: GeographicContext,
  directoryEvidence?: GeographicDirectoryEvidence,
): 0 | 1 | 2 | 3 | undefined {
  const result = resolveGeographicApplicability(scope, location, directoryEvidence);
  return result.state === "applicable" ? result.specificity : undefined;
}

export const offerApplicabilitySchema = z
  .object({
    contractVersion: contractVersionSchema,
    startsAt: canonicalTimestampSchema,
    endsAt: canonicalTimestampSchema,
    geographicScope: geographicScopeSchema,
    channels: z.array(z.enum(["in-store", "online"])).min(1),
  })
  .strict()
  .superRefine(({ startsAt, endsAt, channels }, context) => {
    if (Date.parse(startsAt) >= Date.parse(endsAt)) {
      context.addIssue({
        code: "custom",
        message: "Offer applicability cannot end before it starts",
        path: ["endsAt"],
      });
    }
    if (!hasUniqueStrings(channels)) {
      context.addIssue({
        code: "custom",
        message: "Offer channels must be unique",
        path: ["channels"],
      });
    }
  });

export type OfferApplicability = z.infer<typeof offerApplicabilitySchema>;
