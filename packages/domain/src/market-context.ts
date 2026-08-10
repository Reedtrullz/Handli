import { z } from "zod";

import type { GeographicContext } from "./geography";

export const MARKET_CONTEXT_CONTRACT_VERSION = 1 as const;

export const launchRegionIdSchema = z
  .string()
  .regex(/^no-[0-9]{4}-[a-z0-9]+(?:-[a-z0-9]+)*$/u);

const nationalMarketContextV1Schema = z
  .object({
    contractVersion: z.literal(MARKET_CONTEXT_CONTRACT_VERSION),
    countryCode: z.literal("NO"),
    kind: z.literal("national"),
  })
  .strict();

const launchRegionMarketContextV1Schema = z
  .object({
    contractVersion: z.literal(MARKET_CONTEXT_CONTRACT_VERSION),
    countryCode: z.literal("NO"),
    kind: z.literal("launch-region"),
    regionId: launchRegionIdSchema,
  })
  .strict();

/**
 * The first public market contract is deliberately region-only. It cannot
 * carry a branch/store ID, postal code, address, coordinate, or inferred
 * location. `national` means national-scope evidence only; it is not a claim
 * that Handleplan has complete national coverage.
 */
export const marketContextV1Schema = z.discriminatedUnion("kind", [
  nationalMarketContextV1Schema,
  launchRegionMarketContextV1Schema,
]);

export type MarketContextV1 = z.infer<typeof marketContextV1Schema>;

export const NATIONAL_MARKET_CONTEXT_V1: MarketContextV1 = {
  contractVersion: MARKET_CONTEXT_CONTRACT_VERSION,
  countryCode: "NO",
  kind: "national",
};

export function marketContextToGeographicContext(
  market: MarketContextV1,
): GeographicContext {
  return market.kind === "national"
    ? { countryCode: market.countryCode }
    : { countryCode: market.countryCode, regionCode: market.regionId };
}

export function marketContextsEqual(
  left: MarketContextV1,
  right: MarketContextV1,
): boolean {
  return left.contractVersion === right.contractVersion
    && left.countryCode === right.countryCode
    && left.kind === right.kind
    && (left.kind === "national"
      ? right.kind === "national"
      : right.kind === "launch-region" && left.regionId === right.regionId);
}
