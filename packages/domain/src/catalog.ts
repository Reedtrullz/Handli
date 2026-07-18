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
const gtinShape = /^(?:\d{8}|\d{13})$/;

export function isValidGtin(input: string): boolean {
  if (!gtinShape.test(input)) return false;

  const digits = [...input].map(Number);
  const checkDigit = digits.pop();
  if (checkDigit === undefined) return false;

  const weightedSum = digits.reduce((sum, digit, index) => {
    const positionFromRight = digits.length - index;
    return sum + digit * (positionFromRight % 2 === 1 ? 3 : 1);
  }, 0);
  return (10 - (weightedSum % 10)) % 10 === checkDigit;
}

export const gtinSchema = z.string().regex(gtinShape).refine(isValidGtin, {
  message: "GTIN checksum is invalid",
});

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
    value: gtinSchema,
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
