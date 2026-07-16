"use client";

import {
  priceObservationSchema,
  productSchema,
  type PriceObservation,
  type Product,
} from "@handleplan/domain";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { z } from "zod";

import {
  addExactProductToBasket,
  loadBasket,
  saveBasket,
  type BrowserBasket,
} from "../../lib/browser-basket";

const discoveryResponseSchema = z.object({
  generatedAt: z.iso.datetime({ offset: false, precision: 3 }),
  opportunities: z.array(z.object({
    product: productSchema,
    prices: z.array(priceObservationSchema).min(1).max(3),
    previousPrices: z.array(priceObservationSchema).max(3).optional().default([]),
  }).strict()).max(36),
  priceDataSource: z.enum(["upstream", "cache"]),
}).strict();

type DiscoveryResponse = z.infer<typeof discoveryResponseSchema>;
type Chain = PriceObservation["chain"];
type ChainFilter = "all" | Chain;
export type DiscoverySearch = (query: string | undefined, signal: AbortSignal) => Promise<DiscoveryResponse>;

const chainLabels: Record<Chain, string> = {
  bunnpris: "Bunnpris",
  extra: "Extra",
  "rema-1000": "REMA 1000",
};
const suggestions = ["melk", "kaffe", "brød", "ost"];
const subscribeToClient = () => () => {};

async function searchDiscoveryFromApi(query: string | undefined, signal: AbortSignal): Promise<DiscoveryResponse> {
  const url = query === undefined ? "/api/discovery/search" : `/api/discovery/search?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error("DISCOVERY_SEARCH_FAILED");
  return discoveryResponseSchema.parse(await response.json());
}

function formatNok(amountOre: number): string {
  return new Intl.NumberFormat("nb-NO", { style: "currency", currency: "NOK" }).format(amountOre / 100);
}

function formatObservedAt(value: string): string {
  return new Intl.DateTimeFormat("nb-NO", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function unitPrice(product: Product, amountOre: number): string | undefined {
  if (!product.packageQuantity || !product.packageUnit) return undefined;
  if (product.packageUnit === "g") {
    return `${formatNok(amountOre / (product.packageQuantity / 1000))} / kg`;
  }
  if (product.packageUnit === "ml") {
    return `${formatNok(amountOre / (product.packageQuantity / 1000))} / l`;
  }
  if (product.packageUnit === "each" && product.packageQuantity > 1) {
    return `${formatNok(amountOre / product.packageQuantity)} / stk`;
  }
  return undefined;
}

function priceSpread(prices: PriceObservation[]): number {
  if (prices.length < 2) return 0;
  const amounts = prices.map(({ amountOre }) => amountOre);
  return Math.max(...amounts) - Math.min(...amounts);
}

function priceDrop(prices: PriceObservation[], previousPrices: PriceObservation[]) {
  return prices.flatMap((price) => {
    const previous = previousPrices.find((candidate) => candidate.chain === price.chain);
    if (!previous || previous.amountOre <= price.amountOre) return [];
    const savingOre = previous.amountOre - price.amountOre;
    return [{ price, previous, savingOre, rate: savingOre / previous.amountOre }];
  }).sort((left, right) => right.rate - left.rate || right.savingOre - left.savingOre)[0];
}

function formatPercent(rate: number): string {
  return new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 1 }).format(rate * 100) + " %";
}

interface DiscoveryWorkspaceProps {
  createId?: () => string;
  searchDiscovery?: DiscoverySearch;
  storage?: Storage;
}

export function DiscoveryWorkspace(props: DiscoveryWorkspaceProps) {
  const isClient = useSyncExternalStore(subscribeToClient, () => true, () => false);
  if (!isClient) return null;
  return <DiscoveryWorkspaceClient {...props} />;
}

function DiscoveryWorkspaceClient({
  createId = () => globalThis.crypto.randomUUID(),
  searchDiscovery = searchDiscoveryFromApi,
  storage,
}: DiscoveryWorkspaceProps) {
  const [basket, setBasket] = useState<BrowserBasket>(() => loadBasket(storage));
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState<string | undefined>();
  const [searchRevision, setSearchRevision] = useState(0);
  const [chain, setChain] = useState<ChainFilter>("all");
  const [result, setResult] = useState<DiscoveryResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    const nextController = new AbortController();
    controller.current?.abort();
    controller.current = nextController;
    void searchDiscovery(submittedQuery, nextController.signal)
      .then((nextResult) => {
        if (nextController.signal.aborted) return;
        setResult(nextResult);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (nextController.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
        setResult(null);
        setStatus("error");
      });
    return () => nextController.abort();
  }, [searchDiscovery, searchRevision, submittedQuery]);

  const visible = useMemo(() => (result?.opportunities ?? []).flatMap((opportunity) => {
    const prices = chain === "all"
      ? opportunity.prices
      : opportunity.prices.filter((price) => price.chain === chain);
    const previousPrices = chain === "all"
      ? opportunity.previousPrices
      : opportunity.previousPrices.filter((price) => price.chain === chain);
    return prices.length > 0 ? [{ ...opportunity, prices, previousPrices }] : [];
  }).sort((left, right) => {
    const leftDrop = priceDrop(left.prices, left.previousPrices);
    const rightDrop = priceDrop(right.prices, right.previousPrices);
    return (rightDrop?.rate ?? 0) - (leftDrop?.rate ?? 0) ||
      (rightDrop?.savingOre ?? 0) - (leftDrop?.savingOre ?? 0) ||
      priceSpread(right.prices) - priceSpread(left.prices) ||
      Math.min(...left.prices.map(({ amountOre }) => amountOre)) - Math.min(...right.prices.map(({ amountOre }) => amountOre)) ||
      left.product.name.localeCompare(right.product.name, "nb-NO");
  }), [chain, result]);
  const basketEans = new Set(basket.matchingRules.flatMap((rule) =>
    rule.mode === "exact" && rule.exactEan ? [rule.exactEan] : [],
  ));
  const quantity = basket.needs.reduce((sum, need) => sum + need.quantity, 0);

  function submitSearch(nextQuery = query): void {
    const trimmed = nextQuery.trim();
    if (trimmed.length < 2) return;
    setStatus("loading");
    setQuery(trimmed);
    setSubmittedQuery(trimmed);
    setSearchRevision((current) => current + 1);
  }

  function browseAll(): void {
    setStatus("loading");
    setQuery("");
    setSubmittedQuery(undefined);
    setSearchRevision((current) => current + 1);
  }

  function addProduct(product: Product): void {
    setBasket((current) => {
      const next = addExactProductToBasket(current, product, createId);
      saveBasket(next, storage);
      return next;
    });
  }

  return (
    <main className="oppdag-main">
      <section className="oppdag-heading" aria-labelledby="oppdag-title">
        <div>
          <p>Live kjedepriser</p>
          <h1 id="oppdag-title">Oppdag</h1>
          <span>Bla gjennom ferske kjedepriser, sammenlign de prisene som faktisk er vist og legg funn rett i handlelisten.</span>
        </div>
        <span className="discovery-badge">Ikke sponset</span>
      </section>

      <section className="coverage-notice" aria-label="Dekningsstatus">
        <p>Beskyttet alfa: Dekningen er ufullstendig. En kjede kan mangle for enkelte varer, og Handleplan kårer derfor ikke en landsdekkende vinner.</p>
      </section>

      <div className="oppdag-grid">
        <div className="discovery-column">
          <section className="discovery-controls" aria-label="Finn prisfunn">
            <form onSubmit={(event) => { event.preventDefault(); submitSearch(); }}>
              <label htmlFor="discovery-query">Filtrer varene (valgfritt)</label>
              <div className="discovery-search-row">
                <input
                  id="discovery-query"
                  value={query}
                  minLength={2}
                  maxLength={80}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Søk etter melk, kaffe eller ost"
                />
                <button className="primary-button" type="submit" disabled={query.trim().length < 2}>Søk</button>
              </div>
            </form>
            <div className="discovery-suggestions" aria-label="Forslag">
              {suggestions.map((suggestion) => (
                <button key={suggestion} type="button" onClick={() => submitSearch(suggestion)}>{suggestion}</button>
              ))}
            </div>
            {submittedQuery ? <button className="browse-reset" type="button" onClick={browseAll}>Vis alle prisfunn</button> : null}
            <div className="chain-tabs" role="group" aria-label="Velg butikk">
              {(["all", "bunnpris", "rema-1000", "extra"] as const).map((option) => (
                <button
                  aria-pressed={chain === option}
                  key={option}
                  type="button"
                  onClick={() => setChain(option)}
                >{option === "all" ? "Alle viste kjeder" : chainLabels[option]}</button>
              ))}
            </div>
          </section>

          <section className="discovery-results" aria-labelledby="discovery-results-title" aria-live="polite">
            <div className="discovery-section-heading">
              <div>
                <h2 id="discovery-results-title">{submittedQuery
                  ? `Prisfunn for «${submittedQuery}»`
                  : chain === "all" ? "Prisoversikt akkurat nå" : `Aktuelle priser hos ${chainLabels[chain]}`}</h2>
                <p>{chain === "all"
                  ? "Observerte prisendringer vises først, deretter prisforskjeller mellom kjedene som finnes i datagrunnlaget."
                  : `Tidligere og ferske prisobservasjoner fra ${chainLabels[chain]} – ingen søk nødvendig.`}</p>
              </div>
              {status === "ready" ? <span>{visible.length} funn</span> : null}
            </div>

            {status === "loading" ? <div className="discovery-message" role="status">Henter ferske prisfunn …</div> : null}
            {status === "error" ? (
              <div className="discovery-message" role="alert">
                <strong>Kunne ikke hente priser akkurat nå.</strong>
                <button className="secondary-button" type="button" onClick={() => submittedQuery ? submitSearch(submittedQuery) : browseAll()}>Prøv igjen</button>
              </div>
            ) : null}
            {status === "ready" && visible.length === 0 ? (
              <div className="discovery-message">{submittedQuery
                ? "Ingen ferske priser traff dette filteret. Prøv et annet søk eller vis alle prisfunn."
                : chain === "all"
                  ? "Ingen ferske katalogpriser er tilgjengelige akkurat nå."
                  : `Kassalapp har ingen ferske katalogpriser fra ${chainLabels[chain]} akkurat nå.`}</div>
            ) : null}
            {status === "ready" && visible.length > 0 ? (
              <div className="opportunity-list">
                {visible.map(({ product, prices, previousPrices }) => {
                  const best = [...prices].sort((left, right) => left.amountOre - right.amountOre)[0]!;
                  const previous = previousPrices.find((candidate) => candidate.chain === best.chain);
                  const savingOre = previous ? previous.amountOre - best.amountOre : 0;
                  const spread = priceSpread(prices);
                  const added = basketEans.has(product.ean);
                  return (
                    <article className="opportunity-card" key={product.ean}>
                      <div className="opportunity-mark" aria-hidden="true">{product.name.slice(0, 1).toLocaleUpperCase("nb-NO")}</div>
                      <div className="opportunity-copy">
                        <div className="opportunity-title-row">
                          <div>
                            <h3>{product.name}</h3>
                            <p>{product.brand ?? "Merke ikke oppgitt"}{product.packageQuantity ? ` • ${product.packageQuantity} ${product.packageUnit ?? ""}` : ""}</p>
                          </div>
                          <div className="opportunity-best-price">
                            <strong>{formatNok(best.amountOre)}</strong>
                            <span>{previous
                              ? `lavere enn en tidligere observasjon hos ${chainLabels[best.chain]}`
                              : chain === "all" && prices.length > 1
                              ? `lavest av viste priser hos ${chainLabels[best.chain]}`
                              : `observert hos ${chainLabels[best.chain]}`}</span>
                            {previous ? <small className="previous-observation">Tidligere observert: {formatNok(previous.amountOre)}</small> : null}
                            {previous ? <small className="observation-change">{formatNok(savingOre)} lavere enn denne observasjonen ({formatPercent(savingOre / previous.amountOre)})</small> : null}
                            {spread > 0 ? <small>{formatNok(spread)} lavere enn høyeste kjedepris</small> : null}
                          </div>
                        </div>
                        <ul className="chain-price-list" aria-label={`Priser for ${product.name}`}>
                          {prices.map((price) => (
                            <li key={price.chain}>
                              <span>{chainLabels[price.chain]}</span>
                              <strong>{formatNok(price.amountOre)}</strong>
                              <small>{formatObservedAt(price.observedAt)}</small>
                            </li>
                          ))}
                        </ul>
                        <div className="opportunity-action-row">
                          <p>{unitPrice(product, best.amountOre) ?? "Pakningsstørrelse mangler – enhetspris kan ikke beregnes."}</p>
                          <button
                            className={added ? "secondary-button added" : "primary-button"}
                            type="button"
                            disabled={added || basket.needs.length >= 50}
                            onClick={() => addProduct(product)}
                          >{added ? "I handlelisten" : "Legg til i handlelisten"}</button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : null}
          </section>
        </div>

        <aside className="discovery-rail" aria-labelledby="discovery-basket-title">
          <div className="discovery-basket-card">
            <p>Felles med Planlegg</p>
            <h2 id="discovery-basket-title">Din handleliste</h2>
            <strong>{quantity} {quantity === 1 ? "vare" : "varer"}</strong>
            <span>{basket.needs.length === 0
              ? "Legg til et prisfunn for å starte listen."
              : "Nye varer lagres lokalt og tas med i neste beregning."}</span>
            <a className="primary-button" href="/planlegg">Gå til Planlegg <span aria-hidden="true">→</span></a>
          </div>
          <div className="discovery-trust-card">
            <h2>Hva betyr et prisfunn?</h2>
            <p>Dette er observerte kjedepriser og prisforskjeller, ikke nødvendigvis en offisiell rabatt eller et løfte om lager og hyllepris.</p>
            <p>«Tidligere observert» er én eldre prisobservasjon, ikke butikkens offisielle førpris og ikke en rabattberegning. Medlemspriser og kundeavistilbud vises først når Handleplan har et rettighetsavklart og verifisert datagrunnlag.</p>
            {result ? <small>Datakilde: {result.priceDataSource === "upstream" ? "Kassalapp via kontrollert prisgrunnlag" : "kontrollert lokal reservebuffer"} • beregnet {formatObservedAt(result.generatedAt)}</small> : null}
          </div>
        </aside>
      </div>
    </main>
  );
}
