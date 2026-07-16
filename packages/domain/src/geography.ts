import { z } from "zod";

import {
  canonicalTimestampSchema,
  contractVersionSchema,
  hasUniqueStrings,
  identifierSchema,
  nonEmptyStringSchema,
} from "./contract-primitives";

const countryCodeSchema = z.string().regex(/^[A-Z]{2}$/);

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
    regionCodes: z.array(identifierSchema).min(1),
  })
  .strict()
  .refine(({ regionCodes }) => hasUniqueStrings(regionCodes), {
    message: "Region codes must be unique",
    path: ["regionCodes"],
  });

const storesScopeSchema = z
  .object({
    kind: z.literal("stores"),
    storeIds: z.array(identifierSchema).min(1),
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
  storesScopeSchema,
  unknownScopeSchema,
]);

export type GeographicScope = z.infer<typeof geographicScopeSchema>;

export const geographicContextSchema = z
  .object({
    countryCode: countryCodeSchema,
    regionCode: identifierSchema.optional(),
    storeId: identifierSchema.optional(),
  })
  .strict();

export type GeographicContext = z.infer<typeof geographicContextSchema>;

export function geographicScopeIncludes(
  scope: GeographicScope,
  location: GeographicContext,
): boolean {
  switch (scope.kind) {
    case "national":
      return scope.countryCode === location.countryCode;
    case "regions":
      return (
        scope.countryCode === location.countryCode &&
        location.regionCode !== undefined &&
        scope.regionCodes.includes(location.regionCode)
      );
    case "stores":
      return location.storeId !== undefined && scope.storeIds.includes(location.storeId);
    case "unknown":
      return false;
  }
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
