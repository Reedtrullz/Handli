"use client";

import type { MatchRule, Product } from "@handleplan/domain";
import { useEffect, useState, useSyncExternalStore } from "react";

import {
  addReviewedFamilyToBasket,
  loadBasket,
  removeBasketNeed,
  saveBasket,
  strictPlanRequestReadiness,
  type BrowserBasket,
} from "../../lib/browser-basket";
import type { ReviewedFamilyCandidateInspection } from "../../lib/reviewed-family-candidates";
import { MarketSelector } from "../market/market-selector";
import { BasketRow } from "./basket-row";
import { FamilyComposer } from "./family-composer";
import { NeedComposer, searchProductsFromApi, type ProductSearch } from "./need-composer";

interface BasketWorkspaceProps {
  storage?: Storage;
  searchProducts?: ProductSearch;
  searchDelayMs?: number;
  createId?: () => string;
  inspectFamilyCandidates?: ReviewedFamilyCandidateInspection;
}

function defaultId(): string {
  return globalThis.crypto.randomUUID();
}

const subscribeToClient = () => () => {};

function safeProduct(product: Product): Product {
  return {
    ean: product.ean,
    name: product.name,
    ...(product.brand ? { brand: product.brand } : {}),
    ...(product.packageQuantity ? { packageQuantity: product.packageQuantity } : {}),
    ...(product.packageUnit ? { packageUnit: product.packageUnit } : {}),
    ...(product.productFamily ? { productFamily: product.productFamily } : {}),
  };
}

export function BasketWorkspace({
  storage,
  searchProducts = searchProductsFromApi,
  searchDelayMs,
  createId = defaultId,
  inspectFamilyCandidates,
}: BasketWorkspaceProps) {
  const isClient = useSyncExternalStore(subscribeToClient, () => true, () => false);
  if (!isClient) return null;

  return (
    <BasketWorkspaceClient
      storage={storage}
      searchProducts={searchProducts}
      searchDelayMs={searchDelayMs}
      createId={createId}
      {...(inspectFamilyCandidates === undefined
        ? {}
        : { inspectFamilyCandidates })}
    />
  );
}

function BasketWorkspaceClient({
  storage,
  searchProducts,
  searchDelayMs,
  createId,
  inspectFamilyCandidates,
}: Required<Pick<BasketWorkspaceProps, "searchProducts" | "createId">> &
  Pick<BasketWorkspaceProps, "storage" | "searchDelayMs" | "inspectFamilyCandidates">) {
  const [basket, setBasket] = useState<BrowserBasket>(() => loadBasket(storage));
  const [invalidQuantityNeedIds, setInvalidQuantityNeedIds] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    saveBasket(basket, storage);
  }, [basket, storage]);

  function addApprovedNeed(
    query: string,
    quantity: number,
    quantityUnit: "piece" | "package" | "g" | "ml",
    rule: Omit<MatchRule, "id">,
    products: Product[] = [],
  ): void {
    const needId = createId();
    const ruleId = createId();
    setBasket((current) => ({
      ...current,
      needs: [
        ...current.needs,
        {
          id: needId,
          query,
          quantity,
          quantityUnit,
          matchRuleId: ruleId,
          required: true,
        },
      ],
      matchingRules: [...current.matchingRules, { ...rule, id: ruleId } as MatchRule],
      products: [...new Map(
        [...current.products, ...products.map(safeProduct)].map((candidate) => [candidate.ean, candidate]),
      ).values()],
    }));
  }

  function addExactProduct(
    product: Product,
    quantity: number,
    quantityUnit: "piece" | "package" | "g" | "ml",
  ): void {
    addApprovedNeed(
      product.name,
      quantity,
      quantityUnit,
      {
        mode: "exact",
        exactEan: product.ean,
        userApproved: true,
        explanation: "Eksakt produkt",
      },
      [product],
    );
  }

  function removeNeed(needId: string): void {
    setBasket((current) => removeBasketNeed(current, needId));
    setInvalidQuantityNeedIds((current) => {
      if (!current.has(needId)) return current;
      const next = new Set(current);
      next.delete(needId);
      return next;
    });
  }

  const readiness = strictPlanRequestReadiness(basket);
  const quantitiesAreValid = invalidQuantityNeedIds.size === 0;
  const canPlan = readiness.state === "ready" && quantitiesAreValid;
  const familyIds = new Set(basket.familyConfirmations.map(({ family }) => family.id));

  return (
    <main className="planlegg-main">
      <div className="planner-grid">
        <div className="basket-column">
            <MarketSelector
              id="planlegg-market"
              marketContext={basket.marketContext}
              onChange={(marketContext) => setBasket((current) => ({
                ...current,
                marketContext,
              }))}
            />
            <NeedComposer
              onProduct={addExactProduct}
              searchProducts={searchProducts}
              searchDelayMs={searchDelayMs}
              disabled={basket.needs.length >= 50}
            />

            <FamilyComposer
              disabled={basket.needs.length >= 50}
              existingFamilyIds={familyIds}
              {...(inspectFamilyCandidates === undefined
                ? {}
                : { inspectCandidates: inspectFamilyCandidates })}
              onApprove={(input) => setBasket((current) =>
                addReviewedFamilyToBasket(current, input, createId)
              )}
            />

            <section className="basket-section">
              <div className="section-heading-row">
                <h2>Din kurv ({basket.needs.length} varebehov)</h2>
                {basket.needs.length > 0 ? (
                  <button
                    className="clear-button"
                    type="button"
                    onClick={() => {
                      setBasket((current) => ({
                        ...current,
                        familyConfirmations: [],
                        needs: [],
                        matchingRules: [],
                        products: [],
                      }));
                      setInvalidQuantityNeedIds(new Set());
                    }}
                  >Tøm liste</button>
                ) : null}
              </div>
              {basket.needs.length === 0 ? (
                <div className="basket-empty">Kurven er tom.</div>
              ) : (
                <ul className="basket-list">
                  {basket.needs.map((need) => {
                    const rule = basket.matchingRules.find(({ id }) => id === need.matchRuleId);
                    if (!rule) return null;
                    const product = rule.mode === "exact"
                      ? basket.products.find(({ ean }) => ean === rule.exactEan)
                      : undefined;
                    const familyConfirmation = basket.familyConfirmations.find(
                      ({ matchRuleId }) => matchRuleId === rule.id,
                    );
                    return (
                      <BasketRow
                        key={need.id}
                        need={need}
                        rule={rule}
                        product={product}
                        familyConfirmation={familyConfirmation}
                        onQuantityChange={(quantity, quantityUnit) => setBasket((current) => ({
                          ...current,
                          needs: current.needs.map((candidate) =>
                            candidate.id === need.id
                              ? { ...candidate, quantity, quantityUnit }
                              : candidate,
                          ),
                        }))}
                        onQuantityValidityChange={(valid) => setInvalidQuantityNeedIds(
                          (current) => {
                            const next = new Set(current);
                            if (valid) next.delete(need.id);
                            else next.add(need.id);
                            return next;
                          },
                        )}
                        onRemove={() => removeNeed(need.id)}
                      />
                    );
                  })}
                </ul>
              )}
            </section>
        </div>

        <aside className="plan-rail" aria-labelledby="plan-summary-title">
            <div className="plan-card">
              <h2 id="plan-summary-title">Din handleplan</h2>
              <dl className="plan-stats">
                <div><dt>Varebehov i kurv</dt><dd>{basket.needs.length}</dd></div>
                <div><dt>Status på treff</dt><dd>{!quantitiesAreValid
                  ? "Korriger mengde"
                  : readiness.state === "ready"
                  ? "Alle klare"
                  : readiness.state === "requires-market-selection"
                    ? "Velg prisområde"
                    : basket.needs.length > 0
                      ? "Krever ny godkjenning"
                      : "Ingen varer"}</dd></div>
              </dl>
              <a
                className={`primary-button find-plan${canPlan ? "" : " disabled"}`}
                href={canPlan ? "/planlegg/resultat" : undefined}
                aria-disabled={!canPlan}
              >
                Finn handleplan <span aria-hidden="true">→</span>
              </a>
              {readiness.state === "requires-reviewed-approval" ? (
                <p role="status">Et eldre eller ufullstendig varetypevalg må fjernes og godkjennes mot den publiserte kandidatlisten på nytt.</p>
              ) : null}
              {readiness.state === "requires-market-selection" ? (
                <p role="status">Handlelisten er bevart, men velg et tilgjengelig prisområde før du beregner planen.</p>
              ) : null}
              {!quantitiesAreValid ? (
                <p role="alert">Korriger den ugyldige mengden i kurven før du beregner planen.</p>
              ) : null}
              <p className="plan-note">Vi sammenligner komplette kurver blant prisene vi kan verifisere, på tvers av inntil 3 butikker. Ukjent dekning vises i resultatet.</p>
            </div>
            <p className="local-note">Dine preferanser lagres lokalt i nettleseren. Ingen konto nødvendig.</p>
        </aside>
      </div>
    </main>
  );
}
