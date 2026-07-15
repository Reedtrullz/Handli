"use client";

import type { MatchRule, Product } from "@handleplan/domain";
import { useEffect, useState, useSyncExternalStore } from "react";

import {
  loadBasket,
  saveBasket,
  type BrowserBasket,
} from "../../lib/browser-basket";
import { BasketRow } from "./basket-row";
import {
  NeedComposer,
  searchProductsFromApi,
  type ProductSearch,
} from "./need-composer";
import { TravelPreference } from "./travel-preference";

interface PendingGenericNeed {
  query: string;
  quantity: number;
  constrained: boolean;
}

interface BasketWorkspaceProps {
  storage?: Storage;
  searchProducts?: ProductSearch;
  searchDelayMs?: number;
  createId?: () => string;
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
}: BasketWorkspaceProps) {
  const isClient = useSyncExternalStore(subscribeToClient, () => true, () => false);
  if (!isClient) return null;

  return (
    <BasketWorkspaceClient
      storage={storage}
      searchProducts={searchProducts}
      searchDelayMs={searchDelayMs}
      createId={createId}
    />
  );
}

function BasketWorkspaceClient({
  storage,
  searchProducts,
  searchDelayMs,
  createId,
}: Required<Pick<BasketWorkspaceProps, "searchProducts" | "createId">> &
  Pick<BasketWorkspaceProps, "storage" | "searchDelayMs">) {
  const [basket, setBasket] = useState<BrowserBasket>(() => loadBasket(storage));
  const [pending, setPending] = useState<PendingGenericNeed | null>(null);
  const [allowedBrands, setAllowedBrands] = useState("");

  useEffect(() => {
    saveBasket(basket, storage);
  }, [basket, storage]);

  function addApprovedNeed(
    query: string,
    quantity: number,
    rule: Omit<MatchRule, "id">,
    product?: Product,
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
          quantityUnit: "each",
          matchRuleId: ruleId,
          required: true,
        },
      ],
      matchingRules: [...current.matchingRules, { ...rule, id: ruleId } as MatchRule],
      products: product && !current.products.some(({ ean }) => ean === product.ean)
        ? [...current.products, safeProduct(product)]
        : current.products,
    }));
  }

  function addExactProduct(product: Product, quantity: number): void {
    addApprovedNeed(
      product.name,
      quantity,
      {
        mode: "exact",
        exactEan: product.ean,
        userApproved: true,
        explanation: "Eksakt produkt",
      },
      product,
    );
  }

  function approveFlexible(): void {
    if (!pending) return;
    addApprovedNeed(pending.query, pending.quantity, {
      mode: "flexible",
      productFamily: pending.query.toLocaleLowerCase("nb-NO"),
      userApproved: true,
      explanation: "Samme type, valgfritt merke",
    });
    setPending(null);
  }

  function approveConstrained(): void {
    if (!pending) return;
    const brands = allowedBrands.split(",").map((brand) => brand.trim()).filter(Boolean);
    if (brands.length === 0) return;
    addApprovedNeed(pending.query, pending.quantity, {
      mode: "constrained",
      productFamily: pending.query.toLocaleLowerCase("nb-NO"),
      allowedBrands: brands,
      userApproved: true,
      explanation: brands.join(" eller "),
    });
    setPending(null);
    setAllowedBrands("");
  }

  function removeNeed(needId: string, ruleId: string): void {
    setBasket((current) => {
      const nextRules = current.matchingRules.filter(({ id }) => id !== ruleId);
      const exactEans = new Set(
        nextRules.flatMap((rule) => rule.mode === "exact" ? [rule.exactEan] : []),
      );
      return {
        ...current,
        needs: current.needs.filter(({ id }) => id !== needId),
        matchingRules: nextRules,
        products: current.products.filter(({ ean }) => exactEans.has(ean)),
      };
    });
  }

  const quantities = basket.needs.reduce((sum, need) => sum + need.quantity, 0);

  return (
    <main className="planlegg-main">
      <div className="planner-grid">
        <div className="basket-column">
            <NeedComposer
              onGenericNeed={(query, quantity) => {
                setAllowedBrands("");
                setPending({ query, quantity, constrained: false });
              }}
              onProduct={addExactProduct}
              searchProducts={searchProducts}
              searchDelayMs={searchDelayMs}
            />

            {pending ? (
              <section className="match-approval" role="group" aria-label={`Godkjenn treff for ${pending.query}`}>
                <h2>Godkjenn valg</h2>
                <p>{pending.query}</p>
                <div className="approval-actions">
                  <button className="secondary-button" type="button" onClick={approveFlexible}>
                    Samme type, valgfritt merke
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => setPending({ ...pending, constrained: true })}
                  >
                    Begrens merker
                  </button>
                </div>
                {pending.constrained ? (
                  <div className="brand-approval">
                    <label htmlFor="allowed-brands">Tillatte merker</label>
                    <input
                      id="allowed-brands"
                      value={allowedBrands}
                      onChange={(event) => setAllowedBrands(event.target.value)}
                      placeholder="F.eks. Old El Paso, Santa Maria"
                    />
                    <button
                      className="primary-button"
                      type="button"
                      disabled={allowedBrands.split(",").every((brand) => !brand.trim())}
                      onClick={approveConstrained}
                    >
                      Godkjenn begrensning
                    </button>
                  </div>
                ) : null}
              </section>
            ) : null}

            <section className="basket-section">
              <div className="section-heading-row">
                <h2>Din kurv ({quantities} varer)</h2>
                {basket.needs.length > 0 ? (
                  <button
                    className="clear-button"
                    type="button"
                    onClick={() => setBasket((current) => ({
                      ...current,
                      needs: [],
                      matchingRules: [],
                      products: [],
                    }))}
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
                    return (
                      <BasketRow
                        key={need.id}
                        need={need}
                        rule={rule}
                        product={product}
                        onQuantityChange={(quantity) => setBasket((current) => ({
                          ...current,
                          needs: current.needs.map((candidate) =>
                            candidate.id === need.id ? { ...candidate, quantity } : candidate,
                          ),
                        }))}
                        onRemove={() => removeNeed(need.id, rule.id)}
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
                <div><dt>Varer i kurv</dt><dd>{quantities} stk</dd></div>
                <div><dt>Status på treff</dt><dd>{basket.needs.length > 0 ? "Alle klare" : "Ingen varer"}</dd></div>
              </dl>
              <TravelPreference
                enabled={basket.travel.enabled}
                mode={basket.travel.mode}
                onChange={(travel) => setBasket((current) => ({ ...current, travel }))}
              />
              <a
                className={`primary-button find-plan${basket.needs.length === 0 ? " disabled" : ""}`}
                href={basket.needs.length > 0 ? "/planlegg/resultat" : undefined}
                aria-disabled={basket.needs.length === 0}
              >
                Finn beste handleplan <span aria-hidden="true">→</span>
              </a>
              <p className="plan-note">Vi sammenligner komplette kurver på tvers av inntil 3 butikker for å gi deg lavest mulig totalpris.</p>
            </div>
            <p className="local-note">Dine preferanser lagres lokalt i nettleseren. Ingen konto nødvendig.</p>
        </aside>
      </div>
    </main>
  );
}
