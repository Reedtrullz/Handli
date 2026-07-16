interface PriceProvenanceProps {
  generatedAt: string;
  caveats: readonly string[];
  assignments: readonly { observedAt: string; source: "kassalapp" }[];
  priceDataSource: "upstream" | "cache";
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("nb-NO", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Europe/Oslo",
  }).format(new Date(value));
}

export function PriceProvenance({ generatedAt, caveats, assignments, priceDataSource }: PriceProvenanceProps) {
  const observations = assignments.map(({ observedAt }) => observedAt).sort();
  const first = observations[0];
  const last = observations.at(-1);
  const observed = first === last
    ? formatTimestamp(first!)
    : `${formatTimestamp(first!)}–${formatTimestamp(last!)}`;
  return (
    <section className="price-provenance" aria-labelledby="price-provenance-title">
      <h2 className="sr-only" id="price-provenance-title">Prisgrunnlag og forbehold</h2>
      <p><span aria-hidden="true">ⓘ</span> Valgte Kassalapp-priser observert {observed}.</p>
      <p><span aria-hidden="true">◷</span> {priceDataSource === "upstream" ? "Hentet fra Kassalapp og lest tilbake gjennom kontrollert prisgrunnlag." : "Hentet fra kontrollert lokal reservebuffer."} Beregnet {formatTimestamp(generatedAt)}.</p>
      <p><span aria-hidden="true">✓</span> Beregnet sparing sammenlignes med det rimeligste komplette alternativet med færrest butikker.</p>
      <p><span aria-hidden="true">⚠</span> Handleplan garanterer ikke lagerstatus eller hyllepris i den enkelte butikk.</p>
      <p><span aria-hidden="true">↗</span> Kjedepriser er ikke bevis på avdelingslager eller butikkspesifikk hyllepris.</p>
      {caveats.map((caveat) => <p key={caveat}><span aria-hidden="true">•</span>{caveat}</p>)}
    </section>
  );
}
