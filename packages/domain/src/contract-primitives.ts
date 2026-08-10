import { z } from "zod";

export const DOMAIN_CONTRACT_VERSION = 1 as const;

export const contractVersionSchema = z.literal(DOMAIN_CONTRACT_VERSION);
export const canonicalTimestampSchema = z.iso.datetime({ offset: false, precision: 3 });
export const nonEmptyStringSchema = z.string().trim().min(1).max(500);
export const identifierSchema = z.string().trim().min(1).max(200);
export const sourceIdSchema = identifierSchema;
export const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const nonNegativeSafeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export const basisPointsSchema = z.number().int().min(0).max(10_000);

export function hasUniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export function isFiniteDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}
