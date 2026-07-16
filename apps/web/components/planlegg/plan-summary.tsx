import { formatNok, type PlanResultV2 } from "@handleplan/domain";

interface PlanSummaryProps {
  plan: PlanResultV2;
  convenienceTotalOre: number;
  requiredItems: number;
}

export function PlanSummary({
  plan,
  convenienceTotalOre,
  requiredItems,
}: PlanSummaryProps) {
  const savingOre = convenienceTotalOre - plan.totalOre;
  const offerSavingOre = plan.assignments.reduce(
    (sum, assignment) => sum + assignment.checkout.savingOre,
    0,
  );
  const comparison = savingOre > 0
    ? { label: "Beregnet forskjell", value: `${formatNok(savingOre)} spart` }
    : savingOre < 0
      ? { label: "Beregnet forskjell", value: `${formatNok(-savingOre)} dyrere` }
      : { label: "Beregnet forskjell", value: "Samme pris" };

  return (
    <section className="result-summary" aria-labelledby="result-summary-title">
      <p className="result-eyebrow" id="result-summary-title">Anbefalt totalpris</p>
      <p className="result-total">{formatNok(plan.totalOre)}</p>
      <div className="saving-evidence">
        <span>{comparison.label}</span>
        <strong>{comparison.value}</strong>
      </div>
      <dl className="result-metrics">
        <div><dt>Butikker</dt><dd>{plan.chains.length}</dd></div>
        <div><dt>Komplett handlekurv</dt><dd>Alle {requiredItems} nødvendige varer er med</dd></div>
        <div><dt>Dokumentert tilbudssparing</dt><dd>{offerSavingOre > 0 ? formatNok(offerSavingOre) : "Ingen tilbud brukt"}</dd></div>
        <div><dt>Bytter</dt><dd>{plan.substitutions.length}</dd></div>
      </dl>
    </section>
  );
}
