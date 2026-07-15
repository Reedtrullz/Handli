import { formatNok, type PlanResult } from "@handleplan/domain";

interface PlanSummaryProps {
  plan: PlanResult;
  convenienceTotalOre: number;
  requiredItems: number;
}

export function PlanSummary({
  plan,
  convenienceTotalOre,
  requiredItems,
}: PlanSummaryProps) {
  const savingOre = convenienceTotalOre - plan.totalOre;
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
        <div><dt>Komplett dekning</dt><dd>Alle {requiredItems} nødvendige varer er med</dd></div>
        <div><dt>Bytter</dt><dd>{plan.substitutions.length}</dd></div>
      </dl>
    </section>
  );
}
