import {
  formatNok,
  type ExactProductPlanApiProductSummary,
  type PlanAssignmentV2,
  type PlanResultV2,
} from "@handleplan/domain";

type Chain = PlanResultV2["chains"][number];

const CHAIN_NAMES: Record<Chain, string> = {
  bunnpris: "Bunnpris",
  extra: "Extra",
  "rema-1000": "REMA 1000",
};

interface StoreAssignmentProps {
  chain: Chain;
  order: number;
  assignments: readonly PlanAssignmentV2[];
  products: readonly ExactProductPlanApiProductSummary[];
}

function formatMeasure(measure: { amount: number; unit: "g" | "ml" | "piece" | "package" }): string {
  const amount = measure.amount.toLocaleString("nb-NO");
  if (measure.unit === "piece") return `${amount} stk`;
  if (measure.unit === "package") return `${amount} ${measure.amount === 1 ? "pakke" : "pakker"}`;
  return `${amount} ${measure.unit}`;
}

function fulfilmentCopy(assignment: PlanAssignmentV2): string {
  const { fulfilment } = assignment;
  if (fulfilment.surplus.amount > 0) {
    return `Kjøper ${formatMeasure(fulfilment.purchased)} · ${formatMeasure(fulfilment.surplus)} til overs`;
  }
  return `${fulfilment.packageCount} ${fulfilment.packageCount === 1 ? "pakke" : "pakker"} dekker hele behovet`;
}

export function StoreAssignment({
  chain,
  order,
  assignments,
  products,
}: StoreAssignmentProps) {
  const subtotal = assignments.reduce((sum, assignment) => sum + assignment.costOre, 0);
  const productsByGtin = new Map(products.map((product) => [product.gtin, product]));

  return (
    <section className="result-store" aria-label={`Butikk ${order}: ${CHAIN_NAMES[chain]}`}>
      <header className="result-store-header">
        <div>
          <span className="route-number" aria-hidden="true">{order}</span>
          <div>
            <h2>{CHAIN_NAMES[chain]}</h2>
            <p>Kjedepris · {assignments.length} {assignments.length === 1 ? "vare" : "varer"}</p>
          </div>
        </div>
        <div className="store-subtotal"><span>Delsum</span><strong>{formatNok(subtotal)}</strong></div>
      </header>
      <ul className="result-store-items">
        {assignments.map((assignment) => {
          const product = productsByGtin.get(assignment.ean)!;
          return (
            <li className="result-store-row" key={assignment.needId}>
              <span className="assignment-quantity">{formatMeasure(assignment.fulfilment.requested)}</span>
              <div>
                <strong>{product.displayName}</strong>
                <small>{product.brand ? `${product.brand} · ` : ""}{formatMeasure(product.packageMeasure)} per pakke</small>
                <small>{fulfilmentCopy(assignment)}</small>
                {assignment.officialOffer !== undefined && (
                  <small>Offisielt tilbud brukt · kilde {assignment.officialOffer.sourceId}</small>
                )}
              </div>
              <span className="assignment-checkout">
                {assignment.checkout.savingOre > 0 && (
                  <small>Før {formatNok(assignment.checkout.ordinaryTotalOre)}</small>
                )}
                <strong>{formatNok(assignment.checkout.totalOre)}</strong>
                {assignment.checkout.savingOre > 0 && (
                  <small>{formatNok(assignment.checkout.savingOre)} spart</small>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
