import {
  NATIONAL_MARKET_CONTEXT_V1,
  marketContextV1Schema,
  type MarketContextV1,
} from "@handleplan/domain";

import coverageManifest from "../../../docs/data/launch-coverage.v1.json";

export interface LaunchMarketOption {
  candidateUnverified: boolean;
  label: string;
  marketContext: MarketContextV1;
}

const knownRegionStatuses = new Set([
  "candidate_unverified",
  "selected",
  "rejected",
  "suspended",
]);
const manifestRegions: ReadonlyArray<{
  id: string;
  name: string;
  selectionStatus: string;
}> = coverageManifest.candidateRegions;
for (const region of manifestRegions) {
  if (!knownRegionStatuses.has(region.selectionStatus)) {
    throw new Error("Launch coverage manifest contains an unknown region status");
  }
}

const candidateOptions: LaunchMarketOption[] = manifestRegions.flatMap((region) =>
  region.selectionStatus === "candidate_unverified" || region.selectionStatus === "selected"
    ? [{
        candidateUnverified: region.selectionStatus === "candidate_unverified",
        label: region.name,
        marketContext: marketContextV1Schema.parse({
          contractVersion: 1,
          countryCode: "NO",
          kind: "launch-region",
          regionId: region.id,
        }),
      }]
    : []);

/**
 * Protected-alpha selection list. Candidate regions stay explicitly marked as
 * unverified; their presence here must never be interpreted as launch proof.
 */
export const launchMarketOptions: readonly LaunchMarketOption[] = [
  {
    candidateUnverified: false,
    label: "Kun nasjonalt omfang",
    marketContext: NATIONAL_MARKET_CONTEXT_V1,
  },
  ...candidateOptions,
];

const allowedRegionIds = new Set(candidateOptions.flatMap(({ marketContext }) =>
  marketContext.kind === "launch-region" ? [marketContext.regionId] : []));

export function isAllowedLaunchMarketContext(value: unknown): value is MarketContextV1 {
  const parsed = marketContextV1Schema.safeParse(value);
  return parsed.success
    && (parsed.data.kind === "national" || allowedRegionIds.has(parsed.data.regionId));
}

export function marketContextQueryValue(market: MarketContextV1): string {
  return market.kind === "national" ? "national" : market.regionId;
}

export function allowedLaunchMarketFromQueryValue(
  value: string,
): MarketContextV1 | undefined {
  if (value === "national") return NATIONAL_MARKET_CONTEXT_V1;
  if (!allowedRegionIds.has(value)) return undefined;
  const parsed = marketContextV1Schema.safeParse({
    contractVersion: 1,
    countryCode: "NO",
    kind: "launch-region",
    regionId: value,
  });
  return parsed.success ? parsed.data : undefined;
}

export function launchMarketLabel(market: MarketContextV1): string {
  return launchMarketOptions.find((option) =>
    marketContextQueryValue(option.marketContext) === marketContextQueryValue(market))?.label
    ?? "Ukjent prisområde";
}

export function launchMarketIsCandidateUnverified(market: MarketContextV1): boolean {
  return launchMarketOptions.some((option) =>
    option.candidateUnverified
    && marketContextQueryValue(option.marketContext) === marketContextQueryValue(market));
}
