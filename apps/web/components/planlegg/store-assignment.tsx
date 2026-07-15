import { formatNok, type Need, type PlanResult, type Product } from "@handleplan/domain";

type Chain = PlanResult["chains"][number];

const CHAIN_NAMES: Record<Chain, string> = {
  bunnpris: "Bunnpris",
  extra: "Extra",
  "rema-1000": "REMA 1000",
};

interface StoreAssignmentProps {
  chain: Chain;
  order: number;
  assignments: PlanResult["assignments"];
  needs: readonly Need[];
  products: readonly Product[];
}

export function StoreAssignment({
  chain,
  order,
  assignments,
  needs,
  products,
}: StoreAssignmentProps) {
  const subtotal = assignments.reduce((sum, assignment) => sum + assignment.costOre, 0);
  const needsById = new Map(needs.map((need) => [need.id, need]));
  const productsByEan = new Map(products.map((product) => [product.ean, product]));

  return (
    <section className="result-store" aria-label={`Stopp ${order}: ${CHAIN_NAMES[chain]}`}>
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
          const product = productsByEan.get(assignment.ean);
          const need = needsById.get(assignment.needId);
          return (
            <li className="result-store-row" key={assignment.needId}>
              <span className="assignment-quantity">{assignment.quantity}×</span>
              <div>
                <strong>{product?.name ?? need?.query ?? "Ukjent vare"}</strong>
                <small>{product?.brand ? `${product.brand} · ` : ""}Dekker «{need?.query ?? assignment.needId}»</small>
              </div>
              <span>{formatNok(assignment.costOre)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
