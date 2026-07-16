import { z } from "zod";

import {
  contractVersionSchema,
  hasUniqueStrings,
  identifierSchema,
  nonEmptyStringSchema,
  positiveSafeIntegerSchema,
  sourceIdSchema,
} from "./contract-primitives";

const normalizedMeasureUnitSchema = z.enum(["g", "ml", "piece", "package"]);

export const packageMeasureSchema = z
  .object({
    amount: positiveSafeIntegerSchema,
    unit: normalizedMeasureUnitSchema,
  })
  .strict();

export type PackageMeasure = z.infer<typeof packageMeasureSchema>;

const gtinIdentifierSchema = z
  .object({
    kind: z.literal("gtin"),
    value: z.string().regex(/^(?:\d{8}|\d{13})$/),
  })
  .strict();

const sourceIdentifierSchema = z
  .object({
    kind: z.literal("source"),
    sourceId: sourceIdSchema,
    value: identifierSchema,
  })
  .strict();

export const productIdentifierSchema = z.discriminatedUnion("kind", [
  gtinIdentifierSchema,
  sourceIdentifierSchema,
]);

export type ProductIdentifier = z.infer<typeof productIdentifierSchema>;

export const productFamilySchema = z
  .object({
    contractVersion: contractVersionSchema,
    id: identifierSchema,
    displayName: nonEmptyStringSchema,
    parentId: identifierSchema.optional(),
  })
  .strict()
  .refine(({ id, parentId }) => parentId === undefined || id !== parentId, {
    message: "A product family cannot be its own parent",
    path: ["parentId"],
  });

export type ProductFamily = z.infer<typeof productFamilySchema>;

function identifierKey(identifier: ProductIdentifier): string {
  return identifier.kind === "gtin"
    ? `gtin:${identifier.value}`
    : `source:${identifier.sourceId}:${identifier.value}`;
}

export const canonicalProductSchema = z
  .object({
    contractVersion: contractVersionSchema,
    id: identifierSchema,
    displayName: nonEmptyStringSchema,
    brand: nonEmptyStringSchema.optional(),
    identifiers: z.array(productIdentifierSchema).min(1),
    familyId: identifierSchema.optional(),
    packageMeasure: packageMeasureSchema,
    status: z.enum(["active", "quarantined", "retired"]),
  })
  .strict()
  .refine(({ identifiers }) => hasUniqueStrings(identifiers.map(identifierKey)), {
    message: "Canonical product identifiers must be unique",
    path: ["identifiers"],
  });

export type CanonicalProduct = z.infer<typeof canonicalProductSchema>;
