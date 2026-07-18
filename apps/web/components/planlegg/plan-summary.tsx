import {
  formatNok,
  type PlanDeltaExplanationV1,
  type PlanResultV2,
  type TravelRouteEvidence,
} from "@handleplan/domain";

import {
  formatTravelDistance,
  formatTravelDuration,
} from "./travel-presentation";

interface PlanSummaryProps {
  plan: PlanResultV2;
  explanation: PlanDeltaExplanationV1;
  explanationQualifier: string;
  requiredItems: number;
  travelRoute?: TravelRouteEvidence;
}

export function PlanSummary({
  plan,
  explanation,
  explanationQualifier,
  requiredItems,
  travelRoute,
}: PlanSummaryProps) {
  const changedNeeds = explanation.needs.filter((change) =>
    change.product.kind === "changed"
    || change.quantity.kind === "changed"
    || change.offer.kind !== "same"
    || change.chain.kind === "changed");

  return (
    <section className="result-summary" aria-labelledby="result-summary-title">
      <p className="result-eyebrow" id="result-summary-title">Anbefalt totalpris</p>
      <p className="result-total">{formatNok(plan.totalOre)}</p>
      <div className="saving-evidence">
        <span>Serverberegnet forskjell</span>
        <strong>{explanation.price.message}</strong>
        <small>{explanationQualifier}</small>
      </div>
      <dl className="result-metrics">
        <div><dt>Butikker</dt><dd>{plan.chains.length}</dd></div>
        <div>
          <dt>Komplett handlekurv</dt>
          <dd>{requiredItems === 1
            ? "1 nødvendig vare er med"
            : `Alle ${requiredItems} nødvendige varer er med`}</dd>
        </div>
        <div><dt>Dokumentert tilbudssparing</dt><dd>{explanation.offerSaving.message}</dd></div>
        <div><dt>Bytter</dt><dd>{plan.substitutions.length}</dd></div>
        {travelRoute === undefined ? null : (
          <>
            <div><dt>Estimert reisetid</dt><dd>{formatTravelDuration(travelRoute.aggregate.durationSeconds)}</dd></div>
            <div><dt>Avstand</dt><dd>{formatTravelDistance(travelRoute.aggregate.distanceMeters)}</dd></div>
            <div>
              <dt>Stopp</dt>
              <dd>{travelRoute.stops.map((stop) => `${stop.sequence}. ${stop.name}`).join(" · ")}</dd>
            </div>
          </>
        )}
      </dl>
      {explanation.travel === undefined ? null : (
        <p className="travel-summary-delta">
          {explanation.travel.message}
        </p>
      )}
      {changedNeeds.length === 0 ? null : (
        <div className="plan-need-deltas">
          <strong>Hva som endres i handlekurven</strong>
          <ul>
            {changedNeeds.map((change) => <li key={change.needId}>{change.message}</li>)}
          </ul>
        </div>
      )}
    </section>
  );
}
