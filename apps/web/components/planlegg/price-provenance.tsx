interface PriceProvenanceProps {
  generatedAt: string;
  caveats: readonly string[];
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("nb-NO", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Europe/Oslo",
  }).format(new Date(value));
}

export function PriceProvenance({ generatedAt, caveats }: PriceProvenanceProps) {
  return (
    <section className="price-provenance" aria-labelledby="price-provenance-title">
      <h2 className="sr-only" id="price-provenance-title">Prisgrunnlag og forbehold</h2>
      <p><span aria-hidden="true">ⓘ</span> Kassalapp-kjedepriser, beregnet {formatTimestamp(generatedAt)}.</p>
      <p><span aria-hidden="true">✓</span> Beregnet sparing sammenlignes med det rimeligste komplette alternativet med færrest butikker.</p>
      <p><span aria-hidden="true">⚠</span> Handleplan garanterer ikke lagerstatus eller hyllepris i den enkelte butikk.</p>
      <p><span aria-hidden="true">↗</span> Kjedepriser er ikke bevis på avdelingslager eller butikkspesifikk hyllepris.</p>
      {caveats.map((caveat) => <p key={caveat}><span aria-hidden="true">•</span>{caveat}</p>)}
    </section>
  );
}
