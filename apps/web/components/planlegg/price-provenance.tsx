import type {
  ExactProductPlanApiEvidenceEnvelope,
  PlanAssignmentV2,
  ReviewedFamilyPlanApiEvidenceEnvelopeV2,
} from "@handleplan/domain";

interface PriceProvenanceProps {
  generatedAt: string;
  caveats: readonly string[];
  assignments: readonly PlanAssignmentV2[];
  evidence: ExactProductPlanApiEvidenceEnvelope | ReviewedFamilyPlanApiEvidenceEnvelopeV2;
  priceDataSource: "cache";
}

const CHAIN_NAMES: Record<string, string> = {
  bunnpris: "Bunnpris",
  extra: "Extra",
  "rema-1000": "REMA 1000",
};

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("nb-NO", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Europe/Oslo",
  }).format(new Date(value));
}

export function PriceProvenance({
  generatedAt,
  caveats,
  assignments,
  evidence,
  priceDataSource,
}: PriceProvenanceProps) {
  const observations = assignments.map(({ observedAt }) => observedAt).sort();
  const first = observations[0];
  const last = observations.at(-1);
  const observed = first === last
    ? formatTimestamp(first!)
    : `${formatTimestamp(first!)}–${formatTimestamp(last!)}`;
  const selectedAssignmentKeys = new Set(
    assignments.map(({ canonicalProductId, needId }) => `${needId}\u0000${canonicalProductId}`),
  );
  const comparisonScopes = "needs" in evidence
    ? evidence.needs.map(({ comparisonScope }) => comparisonScope)
    : evidence.candidateCoverage
        .filter(({ canonicalProductId, needId }) =>
          selectedAssignmentKeys.has(`${needId}\u0000${canonicalProductId}`),
        )
        .map(({ comparisonScope }) => comparisonScope);
  const coverageComplete = comparisonScopes.length === assignments.length
    && comparisonScopes.every(({ completeness }) => completeness === "complete");
  const unresolvedChains = [...new Set(comparisonScopes.flatMap((comparisonScope) =>
    comparisonScope.entries.flatMap(({ chainId, status }) =>
      status.kind === "priced" || status.kind === "known-not-carried" ? [] : [chainId]),
  ))];
  const appliedOffers = assignments.filter(({ officialOffer }) => officialOffer !== undefined).length;
  return (
    <section className="price-provenance" aria-labelledby="price-provenance-title">
      <h2 className="sr-only" id="price-provenance-title">Prisgrunnlag og forbehold</h2>
      <p><span aria-hidden="true">ⓘ</span> Valgte priser observert {observed}.</p>
      <p><span aria-hidden="true">◷</span> {priceDataSource === "cache" && "Kun kontrollert, lagret prisgrunnlag ble brukt."} Beregnet {formatTimestamp(generatedAt)}.</p>
      <p><span aria-hidden="true">{coverageComplete ? "✓" : "△"}</span> Prisdekning: {coverageComplete ? "alle tre kjeder er kontrollert for alle varene." : "sammenligningen er delvis."}</p>
      {unresolvedChains.length > 0 && (
        <p><span aria-hidden="true">?</span> Uavklart dekning: {unresolvedChains.map((chain) => CHAIN_NAMES[chain] ?? chain).join(", ")}.</p>
      )}
      <p><span aria-hidden="true">⌁</span> Kilder: {evidence.sources.map(({ displayName }) => displayName).join(", ")}.</p>
      {appliedOffers > 0 && <p><span aria-hidden="true">%</span> {appliedOffers} {appliedOffers === 1 ? "offisielt tilbud er" : "offisielle tilbud er"} brukt i valgt plan.</p>}
      <p><span aria-hidden="true">⚠</span> Handleplan garanterer ikke lagerstatus eller hyllepris i den enkelte butikk.</p>
      <p><span aria-hidden="true">↗</span> Kjedepriser er ikke bevis på avdelingslager eller butikkspesifikk hyllepris.</p>
      {caveats.map((caveat) => <p key={caveat}><span aria-hidden="true">•</span>{caveat}</p>)}
    </section>
  );
}
