"use client";

import {
  DISCOVERY_IMPACT_ACTION_MAX,
  DISCOVERY_IMPACT_PRODUCT_UNION_MAX,
  discoveryImpactRequestV1Schema,
  discoveryImpactResponseV1SchemaFor,
  type DiscoveryImpactActionV1,
  type DiscoveryImpactOutcomeV1,
  type DiscoveryImpactPlanSummaryV1,
  type DiscoveryImpactRequestV1,
  type DiscoveryImpactResponseV1,
  type ExactProductPlanApiProductSummary,
  type Product,
} from "@handleplan/domain";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  addExactProductToBasket,
  BASKET_NEEDS_MAX,
  setBasketNeedToExactProduct,
  strictPlanRequestReadiness,
  type BrowserBasket,
} from "../../lib/browser-basket";
import {
  calculateDiscoveryImpactFromApi,
  type DiscoveryImpactCalculation,
} from "../../lib/discovery-impact-client";
import {
  joinNorwegianLabels,
  membershipChainLabels,
} from "../../lib/membership-presentation";

const PAGE_ACTION_LIMIT = DISCOVERY_IMPACT_ACTION_MAX;

type ImpactChoice =
  | { kind: "add" }
  | { kind: "replace" | "lock"; needId: string };

interface ChoiceOption {
  label: string;
  value: string;
}

interface CompletedBatch {
  request: DiscoveryImpactRequestV1;
  response: DiscoveryImpactResponseV1;
}

interface DiscoveryImpactBatchProps {
  basket: BrowserBasket;
  calculateImpact?: DiscoveryImpactCalculation;
  createId?: () => string;
  createRequestNonce?: () => string;
  onBasketChange: (basket: BrowserBasket) => void;
  products: readonly ExactProductPlanApiProductSummary[];
}

function formatNok(amountOre: number): string {
  return new Intl.NumberFormat("nb-NO", {
    currency: "NOK",
    style: "currency",
  }).format(amountOre / 100);
}

function productForBasket(product: ExactProductPlanApiProductSummary): Product {
  return {
    ...(product.brand === undefined ? {} : { brand: product.brand }),
    ean: product.gtin,
    name: product.displayName,
    packageQuantity: product.packageMeasure.amount,
    packageUnit:
      product.packageMeasure.unit === "g" || product.packageMeasure.unit === "ml"
        ? product.packageMeasure.unit
        : "each",
  };
}

function parseChoice(value: string): ImpactChoice | undefined {
  if (value === "add") return { kind: "add" };
  const separator = value.indexOf(":");
  if (separator <= 0) return undefined;
  const kind = value.slice(0, separator);
  const needId = value.slice(separator + 1);
  return (kind === "replace" || kind === "lock") && needId.trim().length > 0
    ? { kind, needId }
    : undefined;
}

function isExactSelection(
  basket: BrowserBasket,
  needId: string,
  gtin: string,
): boolean {
  const need = basket.needs.find(({ id }) => id === needId);
  const rule = basket.matchingRules.find(({ id }) => id === need?.matchRuleId);
  return rule?.mode === "exact" && rule.exactEan === gtin;
}

function hasReviewedCandidateContext(
  basket: BrowserBasket,
  needId: string,
  gtin: string,
): boolean {
  const need = basket.needs.find(({ id }) => id === needId);
  if (need === undefined) return false;
  const rule = basket.matchingRules.find(({ id }) => id === need.matchRuleId);
  if (rule === undefined || rule.mode === "exact" || rule.productFamily === undefined) {
    return false;
  }
  const confirmation = basket.familyConfirmations.find(
    ({ matchRuleId }) => matchRuleId === rule.id,
  );
  if (confirmation === undefined || confirmation.family.id !== rule.productFamily) {
    return false;
  }
  return basket.products.some(
    (candidate) => candidate.ean === gtin && candidate.productFamily === rule.productFamily,
  );
}

export function discoveryImpactChoices(
  basket: BrowserBasket,
  product: ExactProductPlanApiProductSummary,
): ChoiceOption[] {
  const options: ChoiceOption[] = [];
  const alreadyExact = basket.matchingRules.some(
    (rule) => rule.mode === "exact" && rule.exactEan === product.gtin,
  );
  if (basket.needs.length < BASKET_NEEDS_MAX && !alreadyExact) {
    options.push({
      label: "Legg til som ny vare (1 pakke)",
      value: "add",
    });
  }

  for (const need of basket.needs) {
    if (isExactSelection(basket, need.id, product.gtin)) continue;
    options.push({
      label: `Erstatt «${need.query}» med denne varen`,
      value: `replace:${need.id}`,
    });
    if (hasReviewedCandidateContext(basket, need.id, product.gtin)) {
      options.push({
        label: `Lås «${need.query}» til denne gjennomgåtte kandidaten`,
        value: `lock:${need.id}`,
      });
    }
  }
  return options;
}

function selectedChoice(
  choices: Readonly<Record<string, string>>,
  options: readonly ChoiceOption[],
  gtin: string,
): ImpactChoice | undefined {
  const selected = choices[gtin] ?? "";
  if (!options.some(({ value }) => value === selected)) return undefined;
  return parseChoice(selected);
}

export function buildDiscoveryImpactRequest(
  basket: BrowserBasket,
  products: readonly ExactProductPlanApiProductSummary[],
  selectedValues: Readonly<Record<string, string>>,
  requestNonce: string,
): DiscoveryImpactRequestV1 | undefined {
  const readiness = strictPlanRequestReadiness(basket);
  if (
    readiness.state !== "ready"
    || !/^[A-Za-z0-9-]{1,80}$/u.test(requestNonce)
  ) return undefined;
  const uniqueProducts = [...new Map(
    products.slice(0, PAGE_ACTION_LIMIT).map((product) => [product.gtin, product]),
  ).values()];
  const actions: DiscoveryImpactActionV1[] = [];
  for (const product of uniqueProducts) {
    const choice = selectedChoice(
      selectedValues,
      discoveryImpactChoices(basket, product),
      product.gtin,
    );
    if (choice === undefined) continue;
    const actionId = [
      "impact",
      requestNonce,
      String(actions.length + 1),
      choice.kind,
      product.gtin,
    ].join(":");
    actions.push(choice.kind === "add"
      ? {
          actionId,
          kind: "add",
          product: { kind: "gtin", value: product.gtin },
          userApproved: true,
        }
      : {
          actionId,
          kind: choice.kind,
          needId: choice.needId,
          product: { kind: "gtin", value: product.gtin },
          userApproved: true,
        });
  }
  if (actions.length === 0) return undefined;
  const parsed = discoveryImpactRequestV1Schema.safeParse({
    actions,
    contractVersion: 1,
    convenienceWeightBasisPoints: basket.convenienceWeightBasisPoints,
    planning: readiness.request,
  });
  return parsed.success ? parsed.data : undefined;
}

function chainLabel(chain: string): string {
  if (chain === "bunnpris") return "Bunnpris";
  if (chain === "extra") return "Extra";
  if (chain === "rema-1000") return "REMA 1000";
  return chain;
}

function checkoutComparisonCopy(
  actionKind: DiscoveryImpactActionV1["kind"],
  amountOre: number,
): string {
  if (amountOre === 0) {
    return actionKind === "add"
      ? "Med varen lagt til er beregnet kassetotal uendret sammenlignet med den nåværende handlelisten."
      : "Med dette valget er beregnet kassetotal uendret for det samme behovet.";
  }
  const delta = `${formatNok(Math.abs(amountOre))} ${amountOre < 0 ? "lavere" : "høyere"}`;
  return actionKind === "add"
    ? `Med varen lagt til blir beregnet kassetotal ${delta} enn for den nåværende handlelisten.`
    : `Med dette valget blir beregnet kassetotal ${delta} for det samme behovet.`;
}

function chainChangeCopy(
  comparison: Extract<
    Extract<DiscoveryImpactOutcomeV1, { state: "complete" }>["comparison"],
    { kind: "comparable" }
  >,
): string {
  if (comparison.chainsAdded.length === 0 && comparison.chainsRemoved.length === 0) {
    return "Butikkjedene i planen er uendret.";
  }
  return [
    comparison.chainsAdded.length > 0
      ? `Butikkjeder inn i planen: ${comparison.chainsAdded.map(chainLabel).join(", ")}.`
      : undefined,
    comparison.chainsRemoved.length > 0
      ? `Butikkjeder ut av planen: ${comparison.chainsRemoved.map(chainLabel).join(", ")}.`
      : undefined,
  ].filter((part): part is string => part !== undefined).join(" ");
}

function ineligibleCopy(reason: Extract<DiscoveryImpactOutcomeV1, { state: "ineligible" }>["reason"]): string {
  if (reason === "already-present" || reason === "already-exact") {
    return "Valget finnes allerede i handlelisten. Ingen effekt er beregnet.";
  }
  if (reason === "basket-limit") {
    return "Handlelisten har nådd varegrensen. Ingen effekt er beregnet.";
  }
  if (reason === "not-reviewed-family-candidate" || reason === "not-lockable-need") {
    return "Varen kan ikke låses til dette varetypevalget. Ingen effekt er beregnet.";
  }
  return "Valget er ikke tilgjengelig med den nåværende handlelisten. Ingen effekt er beregnet.";
}

function ImpactOutcome({
  action,
  baselinePlan,
  onApply,
  outcome,
}: {
  action: DiscoveryImpactActionV1;
  baselinePlan: DiscoveryImpactPlanSummaryV1 | undefined;
  onApply: () => void;
  outcome: DiscoveryImpactOutcomeV1;
}) {
  if (outcome.state === "incomplete") {
    return (
      <div className="discovery-impact-outcome unavailable" role="status">
        <p>Ingen komplett handleplan finnes for dette valget. Beløpsforskjell vises derfor ikke.</p>
        <p>Reisetid er ikke med. Gå til Planlegg for å beregne pris og eventuell reise på nytt.</p>
      </div>
    );
  }
  if (outcome.state === "ineligible") {
    return <div className="discovery-impact-outcome unavailable" role="status"><p>{ineligibleCopy(outcome.reason)}</p></div>;
  }
  if (outcome.comparison.kind === "unavailable") {
    return (
      <div className="discovery-impact-outcome unavailable" role="status">
        <p>Valget gir en komplett variant, men dagens handleliste mangler en komplett sammenligningsplan. Beløpsforskjell vises ikke.</p>
        <p>Reisetid er ikke med. Beregn planen på nytt i Planlegg.</p>
        <button className="secondary-button" type="button" onClick={onApply}>Bruk valget i handlelisten</button>
      </div>
    );
  }

  const comparison = outcome.comparison;
  const scope = comparison.claimScope === "among-verified-prices"
    ? " Sammenligningen gjelder blant verifiserte priser."
    : " Sammenligningen bruker erklært komplett prisdekning.";
  const comparisonCopy = checkoutComparisonCopy(
    action.kind,
    comparison.checkoutTotalDeltaOre,
  );
  const baselineUsesMembership = (baselinePlan?.requiredMembershipProgramIds.length ?? 0) > 0;
  const outcomeUsesMembership = outcome.plan.requiredMembershipProgramIds.length > 0;
  const comparisonMembershipChains = membershipChainLabels([
    ...(baselineUsesMembership ? baselinePlan?.chains ?? [] : []),
    ...(outcomeUsesMembership ? outcome.plan.chains : []),
  ]);
  const comparisonUsesMembership = baselineUsesMembership || outcomeUsesMembership;
  const outcomeMembershipCopy = outcome.plan.requiredMembershipProgramIds.length === 0
    ? undefined
    : (() => {
        const labels = membershipChainLabels(outcome.plan.chains);
        return labels.length === 0
          ? "Medlemspris er inkludert i denne totalen og krever medlemskap."
          : `Medlemspris er inkludert i denne totalen og krever medlemskap. Planens butikkjeder: ${joinNorwegianLabels(labels)}.`;
      })();
  return (
    <div className="discovery-impact-outcome" role="status">
      <p><strong>{comparisonCopy}</strong>{scope}</p>
      {!comparisonUsesMembership ? null : (
        <p><strong>
          Beløpssammenligningen forutsetter medlemskap.
          {comparisonMembershipChains.length === 0
            ? null
            : ` Butikkjedene i planene som bruker medlemspris: ${joinNorwegianLabels(comparisonMembershipChains)}.`}
        </strong></p>
      )}
      <p>
        Ny beregnet kassetotal: {formatNok(outcome.plan.totalOre)} • {outcome.plan.storeCount} {outcome.plan.storeCount === 1 ? "butikkjede" : "butikkjeder"}.
        {outcomeMembershipCopy === undefined ? null : <> <strong>{outcomeMembershipCopy}</strong></>}
      </p>
      <p>{chainChangeCopy(comparison)}</p>
      <p>Reisetid er ikke med i overslaget. Beregn på nytt i Planlegg for en reiserute fra et sted du selv velger.</p>
      <button className="secondary-button" type="button" onClick={onApply}>Bruk valget i handlelisten</button>
    </div>
  );
}

function actionStillValid(
  basket: BrowserBasket,
  action: DiscoveryImpactActionV1,
): boolean {
  if (action.kind === "add") {
    return basket.needs.length < BASKET_NEEDS_MAX && !basket.matchingRules.some(
      (rule) => rule.mode === "exact" && rule.exactEan === action.product.value,
    );
  }
  if (isExactSelection(basket, action.needId, action.product.value)) return false;
  if (!basket.needs.some(({ id }) => id === action.needId)) return false;
  return action.kind !== "lock"
    || hasReviewedCandidateContext(basket, action.needId, action.product.value);
}

export function DiscoveryImpactBatch({
  basket,
  calculateImpact = calculateDiscoveryImpactFromApi,
  createId = () => globalThis.crypto.randomUUID(),
  createRequestNonce = () => globalThis.crypto.randomUUID(),
  onBasketChange,
  products,
}: DiscoveryImpactBatchProps) {
  const pageProducts = useMemo(() => [...new Map(
    products.slice(0, PAGE_ACTION_LIMIT).map((product) => [product.gtin, product]),
  ).values()], [products]);
  const [selectedValues, setSelectedValues] = useState<Record<string, string>>({});
  const [pendingRequest, setPendingRequest] = useState<DiscoveryImpactRequestV1 | null>(null);
  const [completed, setCompleted] = useState<CompletedBatch | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [appliedStatus, setAppliedStatus] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const readiness = useMemo(() => strictPlanRequestReadiness(basket), [basket]);

  useEffect(() => () => controller.current?.abort(), []);

  function changeChoice(gtin: string, value: string): void {
    setSelectedValues((current) => ({ ...current, [gtin]: value }));
    setPendingRequest(null);
    setCompleted(null);
    setStatus("idle");
    setAppliedStatus(null);
  }

  async function execute(request: DiscoveryImpactRequestV1): Promise<void> {
    const nextController = new AbortController();
    controller.current?.abort();
    controller.current = nextController;
    setPendingRequest(null);
    setCompleted(null);
    setStatus("loading");
    setAppliedStatus(null);
    try {
      const response = await calculateImpact(request, nextController.signal);
      if (nextController.signal.aborted) return;
      const parsed = discoveryImpactResponseV1SchemaFor(request).safeParse(response);
      if (!parsed.success) throw new Error("DISCOVERY_IMPACT_FAILED");
      setCompleted({ request, response: parsed.data });
      setStatus("idle");
    } catch (error: unknown) {
      if (
        nextController.signal.aborted
        || (error instanceof DOMException && error.name === "AbortError")
      ) return;
      setStatus("error");
    }
  }

  function beginCalculation(): void {
    const request = buildDiscoveryImpactRequest(
      basket,
      pageProducts,
      selectedValues,
      createRequestNonce(),
    );
    if (request === undefined) {
      setStatus("error");
      return;
    }
    if (request.actions.some(({ kind }) => kind === "replace" || kind === "lock")) {
      setPendingRequest(request);
      setCompleted(null);
      setStatus("idle");
      return;
    }
    void execute(request);
  }

  function applyAction(action: DiscoveryImpactActionV1): void {
    const product = pageProducts.find(({ gtin }) => gtin === action.product.value);
    if (product === undefined || !actionStillValid(basket, action)) {
      setAppliedStatus("Handlelisten har endret seg. Beregn effekten på nytt før du bruker valget.");
      return;
    }
    const next = action.kind === "add"
      ? addExactProductToBasket(basket, productForBasket(product), createId)
      : setBasketNeedToExactProduct(basket, action.needId, productForBasket(product));
    if (next === basket) {
      setAppliedStatus("Valget kunne ikke brukes. Handlelisten er ikke endret.");
      return;
    }
    onBasketChange(next);
    setCompleted(null);
    setAppliedStatus("Valget er lagret lokalt i handlelisten. Beregn på nytt i Planlegg.");
  }

  const actionCount = buildDiscoveryImpactRequest(
    basket,
    pageProducts,
    selectedValues,
    "preview",
  )?.actions.length ?? 0;
  const hasSelectedButInvalidBatch = readiness.state === "ready"
    && actionCount === 0
    && pageProducts.some((product) => {
      const value = selectedValues[product.gtin] ?? "";
      return value !== "";
    });

  function selectAllAdds(): void {
    setSelectedValues(Object.fromEntries(pageProducts.flatMap((product) =>
      discoveryImpactChoices(basket, product).some(({ value }) => value === "add")
        ? [[product.gtin, "add"]]
        : []
    )));
    setPendingRequest(null);
    setCompleted(null);
    setStatus("idle");
    setAppliedStatus(null);
  }

  function confirmationText(action: DiscoveryImpactActionV1): string | undefined {
    if (action.kind === "add") return undefined;
    const product = pageProducts.find(({ gtin }) => gtin === action.product.value);
    const need = basket.needs.find(({ id }) => id === action.needId);
    if (product === undefined || need === undefined) return undefined;
    return action.kind === "replace"
      ? `Erstatt «${need.query}» med «${product.displayName}».`
      : `Lås «${need.query}» til «${product.displayName}».`;
  }

  return (
    <section className="discovery-impact-batch" aria-labelledby="discovery-impact-title">
      <div className="discovery-impact-heading">
        <div>
          <p>Komplett handleliste, én kontrollert batch</p>
          <h3 id="discovery-impact-title">Hva skjer med handleplanen?</h3>
        </div>
        <span>Maks {PAGE_ACTION_LIMIT} valg</span>
      </div>
      <p>
        Velg én handling per synlig vare. Hele siden beregnes i én forespørsel mot
        den lokale handlelisten og den nåværende balansen mellom bekvemmelighet og pris.
      </p>
      <p className="discovery-impact-travel-note">
        Reisetid sendes ikke med og er ikke del av overslaget. Beregn eventuell reise på nytt i Planlegg.
      </p>

      {readiness.state === "empty" ? (
        <p className="discovery-impact-readiness" role="status">Legg minst én vare i handlelisten før du sammenligner effekten.</p>
      ) : readiness.state === "requires-reviewed-approval" ? (
        <p className="discovery-impact-readiness" role="status">Handlelisten har et varetypevalg som må godkjennes på nytt i Planlegg før effekten kan beregnes.</p>
      ) : (
        <ul className="discovery-impact-choice-list">
          {pageProducts.map((product) => {
            const options = discoveryImpactChoices(basket, product);
            const value = selectedValues[product.gtin] ?? "";
            const completedAction = completed?.request.actions.find(
              ({ product: actionProduct }) => actionProduct.value === product.gtin,
            );
            const outcome = completedAction === undefined
              ? undefined
              : completed?.response.outcomes.find(
                  ({ actionId }) => actionId === completedAction.actionId,
                );
            return (
              <li key={product.gtin}>
                <div>
                  <strong>{product.displayName}</strong>
                  <small>GTIN {product.gtin}</small>
                </div>
                <label htmlFor={`impact-choice-${product.gtin}`}>Valg for {product.displayName}</label>
                <select
                  disabled={status === "loading"}
                  id={`impact-choice-${product.gtin}`}
                  onChange={(event) => changeChoice(product.gtin, event.target.value)}
                  value={value}
                >
                  <option value="">Ikke beregn denne varen</option>
                  {options.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                {completedAction !== undefined && outcome !== undefined ? (
                  <ImpactOutcome
                    action={completedAction}
                    baselinePlan={completed?.response.baseline.kind === "complete"
                      ? completed.response.baseline.plan
                      : undefined}
                    outcome={outcome}
                    onApply={() => applyAction(completedAction)}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {readiness.state === "ready" ? (
        <div className="discovery-impact-actions">
          <button
            className="secondary-button"
            disabled={status === "loading" || !pageProducts.some((product) =>
              discoveryImpactChoices(basket, product).some(({ value }) => value === "add")
            )}
            onClick={selectAllAdds}
            type="button"
          >Velg «Legg til» for alle tilgjengelige</button>
          <button
            className="secondary-button"
            disabled={actionCount === 0 || status === "loading"}
            onClick={beginCalculation}
            type="button"
          >{status === "loading" ? "Beregner hele batchen …" : `Beregn effekten (${actionCount} ${actionCount === 1 ? "valg" : "valg"})`}</button>
          <small>Ingen adresse, posisjon eller reiserute sendes.</small>
        </div>
      ) : null}
      {hasSelectedButInvalidBatch ? (
        <p className="discovery-impact-error" role="status">
          Hele valget får ikke plass i den strenge {DISCOVERY_IMPACT_PRODUCT_UNION_MAX}-produktgrensen. Velg «Ikke beregn» for noen varer og prøv igjen.
        </p>
      ) : null}

      {pendingRequest !== null ? (
        <div className="discovery-impact-confirmation" role="alert">
          <p><strong>Bekreft erstatning eller låsing.</strong> Valgene endrer hvilket eksakt produkt som dekker et eksisterende behov. Mengde og enhet bevares. Beregningen endrer ikke handlelisten ennå.</p>
          <ul>
            {pendingRequest.actions.flatMap((action) => {
              const text = confirmationText(action);
              return text === undefined ? [] : [<li key={action.actionId}>{text}</li>];
            })}
          </ul>
          <div>
            <button className="primary-button" type="button" onClick={() => void execute(pendingRequest)}>Bekreft og beregn én batch</button>
            <button className="secondary-button" type="button" onClick={() => setPendingRequest(null)}>Avbryt</button>
          </div>
        </div>
      ) : null}
      {status === "error" ? (
        <p className="discovery-impact-error" role="alert">Effekten kan ikke beregnes sikkert akkurat nå. Handlelisten er ikke endret.</p>
      ) : null}
      {completed !== null ? (
        <p className="discovery-impact-evaluated" role="status">
          Hele batchen ble vurdert {new Intl.DateTimeFormat("nb-NO", { dateStyle: "short", timeStyle: "short" }).format(new Date(completed.response.evaluatedAt))}.
        </p>
      ) : null}
      {appliedStatus !== null ? <p role="status">{appliedStatus}</p> : null}
    </section>
  );
}
