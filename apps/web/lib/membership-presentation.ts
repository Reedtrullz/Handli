import type { OfficialOffer } from "@handleplan/domain";

const CHAIN_LABELS = {
  bunnpris: "Bunnpris",
  extra: "Extra",
  "rema-1000": "REMA 1000",
} as const satisfies Readonly<Record<string, string>>;

const CHAIN_ORDER = ["bunnpris", "extra", "rema-1000"] as const;

/**
 * Membership program IDs are opaque eligibility keys. This module is the only
 * customer-facing projection for those keys and deliberately returns labels
 * derived from verified offer/store context instead of the IDs themselves.
 */
export function membershipChainLabel(chainId: string): string | undefined {
  return CHAIN_LABELS[chainId as keyof typeof CHAIN_LABELS];
}

export function membershipChainLabels(chainIds: readonly string[]): string[] {
  const present = new Set(chainIds);
  return CHAIN_ORDER.flatMap((chainId) =>
    present.has(chainId) ? [CHAIN_LABELS[chainId]] : []
  );
}

export function joinNorwegianLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  if (labels.length === 2) return `${labels[0]} og ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")} og ${labels.at(-1)}`;
}

export function hasMembershipCondition(offer: OfficialOffer | undefined): boolean {
  return offer?.conditions.some(({ kind }) => kind === "member") === true;
}

export function membershipRequirementCopy(chainIds: readonly string[]): string {
  const labels = membershipChainLabels(chainIds);
  if (labels.length === 0) return "Medlemspris krever medlemskap.";
  if (labels.length === 1) return `Medlemspris hos ${labels[0]} krever medlemskap.`;
  return `Medlemspriser hos ${joinNorwegianLabels(labels)} krever medlemskap.`;
}

export function membershipOfferConditionCopy(chainId: string): string {
  const label = membershipChainLabel(chainId);
  return label === undefined
    ? "Medlemspris – medlemskap kreves"
    : `Medlemspris hos ${label} – medlemskap kreves`;
}

export interface MembershipPreferencePresentation {
  /** Internal-only eligibility key. Never interpolate this into customer copy. */
  programId: string;
  available: boolean;
  detail: string;
  label: string;
}

/**
 * Produces bounded customer labels while retaining opaque IDs only as control
 * keys. Previously saved IDs without a current offer remain removable, but the
 * caller must not allow them to be newly enabled.
 */
export function membershipPreferencePresentations(
  offers: readonly OfficialOffer[],
  enabledProgramIds: readonly string[],
): MembershipPreferencePresentation[] {
  const chainIdsByProgramId = new Map<string, Set<string>>();
  for (const offer of offers) {
    for (const condition of offer.conditions) {
      if (condition.kind !== "member") continue;
      const chainIds = chainIdsByProgramId.get(condition.programId) ?? new Set<string>();
      chainIds.add(offer.chainId);
      chainIdsByProgramId.set(condition.programId, chainIds);
    }
  }

  const visibleProgramIds = [...new Set([
    ...chainIdsByProgramId.keys(),
    ...enabledProgramIds,
  ])].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const unavailableCount = visibleProgramIds.filter(
    (programId) => !chainIdsByProgramId.has(programId),
  ).length;
  let unavailableIndex = 0;

  const provisional = visibleProgramIds.map((programId) => {
    const chainIds = chainIdsByProgramId.get(programId);
    if (chainIds === undefined) {
      unavailableIndex += 1;
      return {
        available: false,
        detail: "Ingen verifiserte medlemstilbud er tilgjengelige nå. Du kan fjerne valget.",
        label: unavailableCount === 1
          ? "Lagret medlemsvalg uten aktivt tilbud"
          : `Lagret medlemsvalg ${unavailableIndex} uten aktivt tilbud`,
        programId,
      } satisfies MembershipPreferencePresentation;
    }

    const labels = membershipChainLabels([...chainIds]);
    return {
      available: true,
      detail: labels.length === 0
        ? "Et verifisert medlemstilbud er tilgjengelig nå."
        : `Verifisert medlemstilbud er tilgjengelig hos ${joinNorwegianLabels(labels)} nå.`,
      label: labels.length === 0
        ? "Verifisert medlemstilbud"
        : `${labels.length === 1 ? "Medlemspris" : "Medlemspriser"} hos ${joinNorwegianLabels(labels)}`,
      programId,
    } satisfies MembershipPreferencePresentation;
  });

  // If the evidence contains more than one opaque program for the same visible
  // chain context, distinguish controls with neutral ordinals, never with IDs.
  const labelCounts = new Map<string, number>();
  for (const entry of provisional) {
    labelCounts.set(entry.label, (labelCounts.get(entry.label) ?? 0) + 1);
  }
  const labelIndexes = new Map<string, number>();
  return provisional.map((entry) => {
    if ((labelCounts.get(entry.label) ?? 0) <= 1) return entry;
    const index = (labelIndexes.get(entry.label) ?? 0) + 1;
    labelIndexes.set(entry.label, index);
    return { ...entry, label: `${entry.label} – valg ${index}` };
  });
}
