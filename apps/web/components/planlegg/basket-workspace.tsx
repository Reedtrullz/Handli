"use client";

import type { MatchRule, Product } from "@handleplan/domain";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  loadBasket,
  removeBasketNeed,
  saveBasket,
  type BrowserBasket,
} from "../../lib/browser-basket";
import { BasketRow } from "./basket-row";
import {
  NeedComposer,
  genericCandidateFamily,
  searchProductsFromApi,
  type ProductSearch,
} from "./need-composer";

interface PendingGenericNeed {
  query: string;
  quantity: number;
  constrained: boolean;
  productFamily: string;
  candidates: Product[];
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
  const primaryApproval = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    saveBasket(basket, storage);
  }, [basket, storage]);

  useEffect(() => {
    if (pending) primaryApproval.current?.focus();
  }, [pending]);

  function addApprovedNeed(
    query: string,
    quantity: number,
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
          quantityUnit: "each",
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
      [product],
    );
  }

  function approveFlexible(): void {
    if (!pending) return;
    addApprovedNeed(pending.query, pending.quantity, {
      mode: "flexible",
      productFamily: pending.productFamily,
      userApproved: true,
      explanation: "Samme type, valgfritt merke",
    }, pending.candidates.filter(({ productFamily }) => productFamily === pending.productFamily));
    setPending(null);
  }

  function approveConstrained(): void {
    if (!pending) return;
    const brands = allowedBrands.split(",").map((brand) => brand.trim()).filter(Boolean);
    if (brands.length === 0) return;
    const allowed = new Set(brands.map((brand) => brand.toLocaleLowerCase("nb-NO")));
    const candidates = pending.candidates.filter((product) =>
      product.productFamily === pending.productFamily &&
      product.brand !== undefined &&
      allowed.has(product.brand.toLocaleLowerCase("nb-NO")),
    );
    if (candidates.length === 0) return;
    addApprovedNeed(pending.query, pending.quantity, {
      mode: "constrained",
      productFamily: pending.productFamily,
      allowedBrands: brands,
      userApproved: true,
      explanation: brands.join(" eller "),
    }, candidates);
    setPending(null);
    setAllowedBrands("");
  }

  function removeNeed(needId: string): void {
    setBasket((current) => removeBasketNeed(current, needId));
  }

  const quantities = basket.needs.reduce((sum, need) => sum + need.quantity, 0);

  return (
    <main className="planlegg-main">
      <div className="planner-grid">
        <div className="basket-column">
            <NeedComposer
              onGenericNeed={(query, quantity, candidates) => {
                const productFamily = genericCandidateFamily(query, candidates);
                if (!productFamily) return;
                setAllowedBrands("");
                setPending({ query, quantity, constrained: false, productFamily, candidates });
              }}
              onProduct={addExactProduct}
              searchProducts={searchProducts}
              searchDelayMs={searchDelayMs}
              disabled={basket.needs.length >= 50}
            />

            {pending ? (
              <section className="match-approval" role="group" aria-label={`Godkjenn treff for ${pending.query}`}>
                <h2>Godkjenn valg</h2>
                <p>{pending.query}</p>
                <div className="approval-actions">
                  <button ref={primaryApproval} className="secondary-button" type="button" onClick={approveFlexible}>
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
                    disabled={allowedBrands.split(",").every((brand) => !brand.trim()) || !pending.candidates.some((product) => {
                      const allowed = new Set(allowedBrands.split(",").map((brand) => brand.trim().toLocaleLowerCase("nb-NO")).filter(Boolean));
                      return product.productFamily === pending.productFamily && product.brand !== undefined && allowed.has(product.brand.toLocaleLowerCase("nb-NO"));
                    })}
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
                <div><dt>Varer i kurv</dt><dd>{quantities} stk</dd></div>
                <div><dt>Status på treff</dt><dd>{basket.needs.length > 0 ? "Alle klare" : "Ingen varer"}</dd></div>
              </dl>
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
