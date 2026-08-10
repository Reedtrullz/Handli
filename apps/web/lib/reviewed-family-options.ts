import type { ReviewedFamilyDescriptor } from "@handleplan/domain";

/**
 * Browser discovery labels for the published v1 taxonomy. These labels are
 * navigation only: the server remains authoritative for descriptor details,
 * membership, candidates, and the taxonomy version used by a confirmation.
 */
export const REVIEWED_FAMILY_OPTIONS = [
  {
    aliases: ["brød"],
    id: "family:brod",
    labelNo: "Brød",
    slug: "brod",
    status: "active",
  },
  {
    aliases: [],
    id: "family:kaffe",
    labelNo: "Kaffe",
    slug: "kaffe",
    status: "active",
  },
  {
    aliases: ["mjølk"],
    id: "family:melk",
    labelNo: "Melk",
    slug: "melk",
    status: "active",
  },
] as const satisfies readonly ReviewedFamilyDescriptor[];

export type ReviewedFamilyOption = (typeof REVIEWED_FAMILY_OPTIONS)[number];

function normalize(value: string): string {
  return value.normalize("NFC").trim().toLocaleLowerCase("nb-NO");
}

export function reviewedFamilyOptionForQuery(
  query: string,
): ReviewedFamilyOption | undefined {
  const normalized = normalize(query);
  return REVIEWED_FAMILY_OPTIONS.find((family) =>
    normalize(family.slug) === normalized
    || normalize(family.labelNo) === normalized
    || family.aliases.some((alias) => normalize(alias) === normalized)
  );
}
