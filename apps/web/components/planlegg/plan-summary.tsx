import { formatNok, type PlanResult } from "@handleplan/domain";

interface PlanSummaryProps {
  plan: PlanResult;
  convenienceTotalOre: number;
  requiredItems: number;
  travelRequested: boolean;
}

export function PlanSummary({
  plan,
  convenienceTotalOre,
  requiredItems,
  travelRequested,
}: PlanSummaryProps) {
  const savingOre = Math.max(0, convenienceTotalOre - plan.totalOre);

  return (
    <section className="result-summary" aria-labelledby="result-summary-title">
      <p className="result-eyebrow" id="result-summary-title">Anbefalt totalpris</p>
      <p className="result-total">{formatNok(plan.totalOre)}</p>
      <div className="saving-evidence">
        <span>Beregnet sparing</span>
        <strong>{formatNok(savingOre)}</strong>
      </div>
      <dl className="result-metrics">
        <div><dt>Butikker</dt><dd>{plan.chains.length}</dd></div>
        <div><dt>Komplett dekning</dt><dd>Alle {requiredItems} nødvendige varer er med</dd></div>
        <div><dt>Bytter</dt><dd>{plan.substitutions.length}</dd></div>
        <div>
          <dt>Reisetid</dt>
          <dd>{travelRequested ? "Utilgjengelig i denne versjonen" : "Ikke beregnet"}</dd>
        </div>
      </dl>
      <p className="travel-unavailable">
        {travelRequested
          ? "Reisetid er utilgjengelig i denne versjonen. Ingen tid er anslått."
          : "Reisetid er ikke beregnet. Slå på reiseberegning i en senere versjon."}
      </p>
    </section>
  );
}
