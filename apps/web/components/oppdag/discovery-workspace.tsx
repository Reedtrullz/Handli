"use client";

import {
  DISCOVERY_IMPACT_ACTION_MAX,
  publicDiscoveryRequestV1Schema,
  publicDiscoveryResponseSchemaFor,
  type ExactProductPlanApiEvidenceSource,
  type ExactProductPlanApiProductSummary,
  type HistoricalComparison,
  type OfficialOffer,
  type PriceEvidence,
  type Product,
  type PublicDiscoveryProduct,
  type PublicDiscoveryRequestV1,
  type PublicDiscoveryResponse,
} from "@handleplan/domain";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
  addExactProductToBasket,
  loadBasket,
  saveBasket,
  type BrowserBasket,
} from "../../lib/browser-basket";
import type { DiscoveryImpactCalculation } from "../../lib/discovery-impact-client";
import { launchMarketLabel } from "../../lib/launch-markets";
import { membershipOfferConditionCopy } from "../../lib/membership-presentation";
import { MarketSelector } from "../market/market-selector";
import { DiscoveryImpactBatch } from "./discovery-impact-batch";

const MAX_DISCOVERY_RESPONSE_BYTES = 128 * 1024;
const DISCOVERY_PAGE_SIZE = DISCOVERY_IMPACT_ACTION_MAX;
const chains = ["bunnpris", "rema-1000", "extra"] as const;
type Chain = (typeof chains)[number];
type ChainFilter = PublicDiscoveryRequestV1["chain"];
type DiscoveryTypeFilter = PublicDiscoveryRequestV1["resultType"];
type VisibleProduct = PublicDiscoveryProduct & {
  visibleComparisons: HistoricalComparison[];
  visibleOffers: OfficialOffer[];
  visiblePrices: PriceEvidence[];
};

export type DiscoverySearch = (
  request: PublicDiscoveryRequestV1,
  signal: AbortSignal,
) => Promise<PublicDiscoveryResponse>;

const chainLabels: Record<Chain, string> = {
  bunnpris: "Bunnpris",
  extra: "Extra",
  "rema-1000": "REMA 1000",
};
const suggestions = ["melk", "kaffe", "brød", "ost"];
const subscribeToClient = () => () => {};

function isChain(value: string): value is Chain {
  return (chains as readonly string[]).includes(value);
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (body === null) return;
  try {
    await body.cancel();
  } catch {
    // Cleanup is best effort; the UI exposes one generic unavailable state.
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  const token = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
  const quotedString = '"(?:[^"\\\\\\r\\n]|\\\\[\\t\\x20-\\x7e])*"';
  const parameter = `(?:${token})\\s*=\\s*(?:${token}|${quotedString})`;
  if (!new RegExp(`^application/json(?:\\s*;\\s*${parameter})*\\s*$`, "i").test(contentType)) {
    await cancelBody(response.body);
    throw new Error("DISCOVERY_SEARCH_FAILED");
  }
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null
    && /^\d+$/.test(contentLength)
    && Number(contentLength) > MAX_DISCOVERY_RESPONSE_BYTES
  ) {
    await cancelBody(response.body);
    throw new Error("DISCOVERY_SEARCH_FAILED");
  }
  if (response.body === null) throw new Error("DISCOVERY_SEARCH_FAILED");

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const fragments: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_DISCOVERY_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("DISCOVERY_SEARCH_FAILED");
      }
      fragments.push(decoder.decode(value, { stream: true }));
    }
    fragments.push(decoder.decode());
    return JSON.parse(fragments.join("")) as unknown;
  } catch {
    try { await reader.cancel(); } catch { /* Cleanup only. */ }
    throw new Error("DISCOVERY_SEARCH_FAILED");
  }
}

export async function searchDiscoveryFromApi(
  request: PublicDiscoveryRequestV1,
  signal: AbortSignal,
): Promise<PublicDiscoveryResponse> {
  const parsedRequest = publicDiscoveryRequestV1Schema.safeParse(request);
  if (!parsedRequest.success) throw new Error("DISCOVERY_SEARCH_FAILED");
  const input = parsedRequest.data;
  const params = new URLSearchParams({
    chain: input.chain,
    market: input.marketContext.kind === "national"
      ? "national"
      : input.marketContext.regionId,
    pageSize: String(input.pageSize),
    type: input.resultType,
  });
  if (input.query !== undefined) params.set("q", input.query);
  if (input.categoryId !== undefined) params.set("category", input.categoryId);
  if (input.cursor !== undefined) params.set("cursor", input.cursor);
  const url = `/api/discovery/search?${params.toString()}`;
  const response = await fetch(url, { signal });
  if (!response.ok) {
    await cancelBody(response.body);
    throw new Error("DISCOVERY_SEARCH_FAILED");
  }
  const parsed = publicDiscoveryResponseSchemaFor(input)
    .safeParse(await readBoundedJson(response));
  if (!parsed.success) throw new Error("DISCOVERY_SEARCH_FAILED");
  return parsed.data;
}

function formatNok(amountOre: number): string {
  return new Intl.NumberFormat("nb-NO", { style: "currency", currency: "NOK" }).format(amountOre / 100);
}

function formatPercentFromBasisPoints(basisPoints: number): string {
  return `${new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 1 }).format(basisPoints / 100)} %`;
}

function formatObservedAt(value: string): string {
  return new Intl.DateTimeFormat("nb-NO", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("nb-NO", { dateStyle: "medium" }).format(new Date(value));
}

function packageLabel(product: ExactProductPlanApiProductSummary): string {
  const unit = product.packageMeasure.unit === "piece"
    ? "stk"
    : product.packageMeasure.unit === "package"
      ? "pakke"
      : product.packageMeasure.unit;
  const units = product.unitsPerPack > 1 ? ` • ${product.unitsPerPack} enheter` : "";
  return `${product.packageMeasure.amount} ${unit}${units}`;
}

function legacyProductFromCatalog(product: ExactProductPlanApiProductSummary): Product {
  return {
    ean: product.gtin,
    name: product.displayName,
    ...(product.brand === undefined ? {} : { brand: product.brand }),
    packageQuantity: product.packageMeasure.amount,
    packageUnit:
      product.packageMeasure.unit === "g" || product.packageMeasure.unit === "ml"
        ? product.packageMeasure.unit
        : "each",
  };
}

function unitPrice(product: ExactProductPlanApiProductSummary, amountOre: number): string | undefined {
  const { amount, unit } = product.packageMeasure;
  if (unit === "g") return `${formatNok(amountOre / (amount / 1_000))} / kg`;
  if (unit === "ml") return `${formatNok(amountOre / (amount / 1_000))} / l`;
  if (unit === "piece" && amount > 1) return `${formatNok(amountOre / amount)} / stk`;
  return undefined;
}

function sourceFor(
  sources: readonly ExactProductPlanApiEvidenceSource[],
  sourceId: string,
): ExactProductPlanApiEvidenceSource | undefined {
  return sources.find(({ id }) => id === sourceId);
}

function sourceLabel(
  sources: readonly ExactProductPlanApiEvidenceSource[],
  sourceId: string,
): string {
  return sourceFor(sources, sourceId)?.displayName ?? sourceId;
}

function matchingComparison(
  comparisons: readonly HistoricalComparison[],
  evidenceId: string,
): HistoricalComparison | undefined {
  return comparisons.find(({ currentEvidenceId }) => currentEvidenceId === evidenceId);
}

function officialOfferPrice(offer: OfficialOffer): number {
  return offer.pricing.kind === "unit" ? offer.pricing.unitPriceOre : offer.pricing.totalOre;
}

function officialOfferPriceLabel(offer: OfficialOffer): string {
  return offer.pricing.kind === "unit"
    ? formatNok(offer.pricing.unitPriceOre)
    : `${offer.pricing.quantity} for ${formatNok(offer.pricing.totalOre)}`;
}

function officialOfferBeforeTotal(offer: OfficialOffer): number | undefined {
  if (offer.beforePriceOre === undefined) return undefined;
  return offer.pricing.kind === "unit"
    ? offer.beforePriceOre
    : offer.beforePriceOre * offer.pricing.quantity;
}

function officialOfferSavingsBasisPoints(offer: OfficialOffer): number {
  const before = officialOfferBeforeTotal(offer);
  if (before === undefined || before <= officialOfferPrice(offer)) return 0;
  return Math.floor(((before - officialOfferPrice(offer)) * 10_000) / before);
}

function offerConditions(offer: OfficialOffer): string {
  return [...new Set(offer.conditions.map((condition) => {
    if (condition.kind === "public") return "Åpent tilbud";
    if (condition.kind === "member") return membershipOfferConditionCopy(offer.chainId);
    return `Minst ${condition.quantity} stk`;
  }))].join(" • ");
}

function offerScope(offer: OfficialOffer): string {
  const scope = offer.applicability.geographicScope;
  if (scope.kind === "national") return `Hele ${scope.countryCode === "NO" ? "Norge" : scope.countryCode}`;
  if (scope.kind === "regions") return `Regioner: ${scope.regionCodes.join(", ")}`;
  if (scope.kind === "stores") {
    return `${scope.storeIds.length} ${scope.storeIds.length === 1 ? "oppgitt butikk" : "oppgitte butikker"}`;
  }
  return "Geografisk omfang er ikke avklart";
}

function unresolvedCoverage(entry: PublicDiscoveryProduct): Chain[] {
  return entry.comparisonScope.entries.flatMap(({ chainId, status }) =>
    isChain(chainId) && status.kind !== "priced" && status.kind !== "known-not-carried"
      ? [chainId]
      : []);
}

function coverageText(entry: PublicDiscoveryProduct): string {
  if (entry.comparisonScope.completeness === "complete") {
    return "Dekning: alle tre kjeder er avklart for varen.";
  }
  const unresolved = unresolvedCoverage(entry).map((chainId) => chainLabels[chainId]);
  return unresolved.length === 0
    ? "Dekning: avklart, men ikke merket komplett av datagrunnlaget."
    : `Delvis dekning. Uavklart: ${unresolved.join(", ")}.`;
}

function categoryPathText(entry: PublicDiscoveryProduct): string {
  const source = entry.catalog.catalogEvidence.source.displayName;
  if (entry.categoryPath === null) {
    return `Observert kildekategori: ikke fanget i kataloggrunnlaget fra ${source}.`;
  }
  if (entry.categoryPath.length === 0) {
    return `Observert kildekategori: ${source} oppga ingen kategori.`;
  }
  return `Observert kildekategori: ${entry.categoryPath.map(({ name }) => name).join(" › ")} • kilde: ${source}.`;
}

interface DiscoveryWorkspaceProps {
  calculateImpact?: DiscoveryImpactCalculation;
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
  calculateImpact,
  createId = () => globalThis.crypto.randomUUID(),
  searchDiscovery = searchDiscoveryFromApi,
  storage,
}: DiscoveryWorkspaceProps) {
  const [basket, setBasket] = useState<BrowserBasket>(() => loadBasket(storage));
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState<string | undefined>();
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | undefined>();
  const [searchRevision, setSearchRevision] = useState(0);
  const [chain, setChain] = useState<ChainFilter>("all");
  const [discoveryType, setDiscoveryType] = useState<DiscoveryTypeFilter>("all");
  const [pageCursors, setPageCursors] = useState<Array<string | undefined>>([undefined]);
  const [result, setResult] = useState<PublicDiscoveryResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    if (basket.marketContext === null) {
      controller.current?.abort();
      return;
    }
    const marketContext = basket.marketContext;
    const cursor = pageCursors.at(-1);
    const request = publicDiscoveryRequestV1Schema.parse({
      ...(selectedCategoryId === undefined ? {} : { categoryId: selectedCategoryId }),
      chain,
      contractVersion: 1,
      ...(cursor === undefined ? {} : { cursor }),
      marketContext,
      pageSize: DISCOVERY_PAGE_SIZE,
      ...(submittedQuery === undefined ? {} : { query: submittedQuery }),
      resultType: discoveryType,
    });
    const nextController = new AbortController();
    controller.current?.abort();
    controller.current = nextController;
    void searchDiscovery(
      request,
      nextController.signal,
    )
      .then((nextResult) => {
        if (nextController.signal.aborted) return;
        const parsed = publicDiscoveryResponseSchemaFor(request)
          .safeParse(nextResult);
        if (!parsed.success) throw new Error("DISCOVERY_SEARCH_FAILED");
        setResult(parsed.data);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (nextController.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
        setResult(null);
        setStatus("error");
      });
    return () => nextController.abort();
  }, [
    basket.marketContext,
    chain,
    discoveryType,
    pageCursors,
    searchDiscovery,
    searchRevision,
    selectedCategoryId,
    submittedQuery,
  ]);

  const effectiveStatus = basket.marketContext === null ? "market-required" : status;

  const visible = useMemo<VisibleProduct[]>(() => (
    basket.marketContext === null ? [] : result?.products ?? []
  ).map((entry) => {
    const visiblePrices = entry.ordinaryPrices.filter(({ chainId }) =>
      isChain(chainId) && (chain === "all" || chainId === chain));
    const chainOffers = entry.officialOffers.filter(({ chainId }) =>
      isChain(chainId) && (chain === "all" || chainId === chain));
    const visiblePriceIds = new Set(visiblePrices.map(({ id }) => id));
    const chainComparisons = entry.historicalComparisons.filter(({ currentEvidenceId, chainId }) =>
      isChain(chainId)
      && (chain === "all" || chainId === chain)
      && visiblePriceIds.has(currentEvidenceId));
    const visibleOffers = discoveryType === "historical-comparison" ? [] : chainOffers;
    const visibleComparisons = discoveryType === "official-offer" ? [] : chainComparisons;
    return { ...entry, visibleComparisons, visibleOffers, visiblePrices };
  }), [basket.marketContext, chain, discoveryType, result]);

  const basketEans = new Set(basket.matchingRules.flatMap((rule) =>
    rule.mode === "exact" && rule.exactEan ? [rule.exactEan] : [],
  ));
  const needCount = basket.needs.length;
  const hasCompleteCoverage = result !== null
    && result.products.length > 0
    && result.products.every(({ comparisonScope }) => comparisonScope.completeness === "complete");
  const marketLabel = basket.marketContext === null
    ? "valgt prisområde"
    : launchMarketLabel(basket.marketContext);
  const currentPage = pageCursors.length - 1;
  const visiblePage = visible;
  const impactProducts = useMemo(
    () => visiblePage.map(({ catalog }) => catalog),
    [visiblePage],
  );

  function submitSearch(nextQuery = query): void {
    const trimmed = nextQuery.trim();
    if (trimmed.length < 2 || trimmed.length > 120) return;
    setStatus("loading");
    setQuery(trimmed);
    setSubmittedQuery(trimmed);
    setSelectedCategoryId(undefined);
    setPageCursors([undefined]);
    setSearchRevision((current) => current + 1);
  }

  function selectCategory(categoryId: string): void {
    setStatus("loading");
    setQuery("");
    setSubmittedQuery(undefined);
    setSelectedCategoryId(categoryId === "" ? undefined : categoryId);
    setPageCursors([undefined]);
    setSearchRevision((current) => current + 1);
  }

  function browseAll(): void {
    setStatus("loading");
    setQuery("");
    setSubmittedQuery(undefined);
    setSelectedCategoryId(undefined);
    setPageCursors([undefined]);
    setSearchRevision((current) => current + 1);
  }

  function retryCurrentView(): void {
    setStatus("loading");
    setSearchRevision((current) => current + 1);
  }

  function addProduct(product: ExactProductPlanApiProductSummary): void {
    setBasket((current) => {
      const next = addExactProductToBasket(current, legacyProductFromCatalog(product), createId);
      saveBasket(next, storage);
      return next;
    });
  }

  function replaceBasket(next: BrowserBasket): void {
    saveBasket(next, storage);
    setBasket(next);
  }

  return (
    <main className="oppdag-main">
      <section className="oppdag-heading" aria-labelledby="oppdag-title">
        <div>
          <p>Kontrollert prisgrunnlag</p>
          <h1 id="oppdag-title">Oppdag</h1>
          <span>Bla i den godkjente varekatalogen, se ordinærpriser og vurder dokumenterte tilbud og historiske sammenligninger hver for seg.</span>
        </div>
        <span className="discovery-badge">Ikke sponset</span>
      </section>

      <section className="coverage-notice" aria-label="Dekningsstatus">
        <p>{hasCompleteCoverage
          ? `For ${marketLabel} er alle tre kjeder avklart for akkurat varene som vises. Dette er ikke en lanserings- eller totaldekningspåstand.`
          : `For ${marketLabel} varierer dekningen per vare. Manglende kjeder vises som uavklart og regnes aldri som dyrere, billigere eller uten varen.`}</p>
      </section>

      <div className="oppdag-grid">
        <div className="discovery-column">
          <section className="discovery-controls" aria-label="Finn prisfunn">
            <MarketSelector
              id="oppdag-market"
              marketContext={basket.marketContext}
              onChange={(marketContext) => {
                const next = { ...basket, marketContext };
                saveBasket(next, storage);
                setBasket(next);
                setStatus("loading");
                setPageCursors([undefined]);
              }}
            />
            <form onSubmit={(event) => { event.preventDefault(); submitSearch(); }}>
              <label htmlFor="discovery-query">Filtrer varene (valgfritt)</label>
              <div className="discovery-search-row">
                <input
                  id="discovery-query"
                  value={query}
                  minLength={2}
                  maxLength={120}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Søk etter melk, kaffe eller ost"
                />
                <button className="primary-button" type="submit" disabled={query.trim().length < 2 || query.trim().length > 120}>Søk</button>
              </div>
            </form>
            <div className="discovery-suggestions" aria-label="Forslag">
              {suggestions.map((suggestion) => (
                <button key={suggestion} type="button" onClick={() => submitSearch(suggestion)}>{suggestion}</button>
              ))}
            </div>
            <div className="discovery-category-control">
              <label htmlFor="discovery-category">Observert kategori (valgfritt)</label>
              <select
                id="discovery-category"
                value={selectedCategoryId ?? ""}
                onChange={(event) => selectCategory(event.target.value)}
                disabled={status === "loading" && result === null}
              >
                <option value="">Alle observerte kategorier</option>
                {(result?.observedCategories.facets ?? []).map((facet) => (
                  <option key={facet.id} value={facet.id}>
                    {facet.name} • kilde: {sourceLabel(result?.sources ?? [], facet.sourceId)} • {facet.productCount} {facet.productCount === 1 ? "vare" : "varer"}
                  </option>
                ))}
              </select>
              <small>
                Listen viser bare kategorier observert i godkjent, ferskt kataloggrunnlag.
                Den er ikke en komplett butikktaksonomi
                {result?.observedCategories.hasMore ? ", og flere kategorier finnes enn de som vises" : ""}.
              </small>
            </div>
            {submittedQuery || selectedCategoryId ? <button className="browse-reset" type="button" onClick={browseAll}>Fjern søk eller kategori</button> : null}
            <div className="chain-tabs" role="group" aria-label="Velg butikk">
              {(["all", ...chains] as const).map((option) => (
                <button
                  aria-pressed={chain === option}
                  key={option}
                  type="button"
                  onClick={() => {
                    setStatus("loading");
                    setChain(option);
                    setPageCursors([undefined]);
                  }}
                >{option === "all" ? "Alle viste kjeder" : chainLabels[option]}</button>
              ))}
            </div>
            <div className="discovery-type-tabs" role="group" aria-label="Velg funntype">
              {([
                ["all", "Alle funn"],
                ["official-offer", "Offisielle tilbud"],
                ["historical-comparison", "Historiske sammenligninger"],
              ] as const).map(([option, label]) => (
                <button
                  aria-pressed={discoveryType === option}
                  key={option}
                  type="button"
                  onClick={() => {
                    setStatus("loading");
                    setDiscoveryType(option);
                    setPageCursors([undefined]);
                  }}
                >{label}</button>
              ))}
            </div>
          </section>

          <section className="discovery-results" aria-labelledby="discovery-results-title" aria-live="polite">
            <div className="discovery-section-heading">
              <div>
                <h2 id="discovery-results-title">{submittedQuery
                  ? `Treff for «${submittedQuery}»`
                  : selectedCategoryId
                    ? `Observert kategori: ${result?.observedCategories.facets.find(({ id }) => id === selectedCategoryId)?.name ?? "valgt kategori"}`
                  : chain === "all" ? "Varekatalog og prisgrunnlag" : `Prisgrunnlag hos ${chainLabels[chain]}`}</h2>
                <p>{chain === "all"
                  ? "Siden følger stabil katalognavn-rekkefølge. Historiske avvik bygger bare på validerte 30-dagers medianer."
                  : `Viser ordinærpriser og offisielle tilbud som faktisk gjelder hos ${chainLabels[chain]}.`}</p>
              </div>
              {effectiveStatus === "ready" ? <span>{visible.length} {visible.length === 1 ? "vare" : "varer"} på denne siden</span> : null}
            </div>

            {effectiveStatus === "loading" ? <div className="discovery-message" role="status">Henter kontrollert katalog og prisgrunnlag …</div> : null}
            {effectiveStatus === "market-required" ? (
              <div className="discovery-message" role="status">Handlelisten er bevart. Velg et tilgjengelig prisområde før Oppdag henter prisgrunnlaget.</div>
            ) : null}
            {effectiveStatus === "error" ? (
              <div className="discovery-message" role="alert">
                <strong>Kunne ikke hente katalogen akkurat nå.</strong>
                <button className="secondary-button" type="button" onClick={retryCurrentView}>Prøv igjen</button>
              </div>
            ) : null}
            {effectiveStatus === "ready" && visible.length === 0 ? (
              <div className="discovery-message">{submittedQuery
                ? result?.page.hasMore
                  ? "Ingen godkjente katalogvarer traff filteret i denne avgrensede katalogdelen. Flere deler finnes; velg Neste for å fortsette."
                  : "Ingen godkjente katalogvarer traff filteret. Prøv et annet søk eller fjern søket."
                : selectedCategoryId
                  ? result?.page.hasMore
                    ? "Ingen godkjente katalogvarer i denne avgrensede delen traff den valgte observerte kategorien. Flere deler finnes; velg Neste."
                    : "Ingen godkjente katalogvarer er tilgjengelige i den valgte observerte kategorien akkurat nå."
                : discoveryType === "official-offer"
                  ? result?.page.hasMore
                    ? "Ingen verifiserte offisielle tilbud ble funnet i denne avgrensede katalogdelen. Flere deler finnes; velg Neste."
                    : "Ingen verifiserte offisielle tilbud er tilgjengelige med de valgte filtrene akkurat nå."
                  : discoveryType === "historical-comparison"
                    ? result?.page.hasMore
                      ? "Ingen validerte historiske sammenligninger ble funnet i denne avgrensede katalogdelen. Flere deler finnes; velg Neste."
                      : "Ingen validerte historiske sammenligninger er tilgjengelige med de valgte filtrene akkurat nå."
                : chain === "all"
                  ? result?.page.hasMore
                    ? "Denne avgrensede katalogdelen ga ingen visbare varer. Flere deler finnes; velg Neste for å fortsette."
                    : "Ingen godkjente katalogvarer er tilgjengelige akkurat nå."
                  : result?.page.hasMore
                    ? `Ingen ordinærpriser eller offisielle tilbud fra ${chainLabels[chain]} ble funnet i denne avgrensede katalogdelen. Flere deler finnes; velg Neste.`
                    : `Ingen ordinærpriser eller offisielle tilbud er tilgjengelige fra ${chainLabels[chain]} akkurat nå.`}</div>
            ) : null}
            {effectiveStatus === "ready" && visible.length > 0 ? (
              <>
                <DiscoveryImpactBatch
                  basket={basket}
                  {...(calculateImpact === undefined ? {} : { calculateImpact })}
                  createId={createId}
                  key={JSON.stringify({
                    basket,
                    pageGtins: impactProducts.map(({ gtin }) => gtin),
                  })}
                  onBasketChange={replaceBasket}
                  products={impactProducts}
                />
                <div className="opportunity-list">
                {visiblePage.map((entry) => {
                  const prices = [...entry.visiblePrices].sort((left, right) =>
                    left.amountOre - right.amountOre || left.chainId.localeCompare(right.chainId));
                  const best = prices[0];
                  const offers = [...entry.visibleOffers].sort((left, right) =>
                    officialOfferSavingsBasisPoints(right) - officialOfferSavingsBasisPoints(left)
                    || officialOfferPrice(left) - officialOfferPrice(right)
                    || left.id.localeCompare(right.id));
                  const added = basketEans.has(entry.catalog.gtin);
                  return (
                    <article className="opportunity-card" key={entry.catalog.gtin}>
                      <div className="opportunity-mark" aria-hidden="true">{entry.catalog.displayName.slice(0, 1).toLocaleUpperCase("nb-NO")}</div>
                      <div className="opportunity-copy">
                        <div className="opportunity-title-row">
                          <div>
                            <h3>{entry.catalog.displayName}</h3>
                            <p>{entry.catalog.brand ?? "Merke ikke oppgitt"} • {packageLabel(entry.catalog)}</p>
                          </div>
                          <div className="opportunity-best-price">
                            {best ? (
                              <>
                                <strong>{formatNok(best.amountOre)}</strong>
                                <span>Laveste viste ordinærpris • {chainLabels[best.chainId as Chain]}</span>
                                {matchingComparison(entry.visibleComparisons, best.id) ? (() => {
                                  const comparison = matchingComparison(entry.visibleComparisons, best.id)!;
                                  return (
                                    <>
                                      <small>Historisk median (30 dager): {formatNok(comparison.baselineOre)}</small>
                                      <small className="observation-change">Nå: {formatNok(comparison.currentOre)} — {formatNok(comparison.savingsOre)} lavere enn historisk median ({formatPercentFromBasisPoints(comparison.savingsBasisPoints)})</small>
                                    </>
                                  );
                                })() : null}
                              </>
                            ) : (
                              <>
                                <strong>Pris mangler</strong>
                                <span>Ingen fersk ordinærpris</span>
                              </>
                            )}
                          </div>
                        </div>

                        {offers.map((offer) => {
                          const beforeTotal = officialOfferBeforeTotal(offer);
                          const offerTotal = officialOfferPrice(offer);
                          const savingsOre = beforeTotal === undefined ? undefined : beforeTotal - offerTotal;
                          const savingsBasisPoints = officialOfferSavingsBasisPoints(offer);
                          return (
                            <section className="official-offer-panel" aria-label={`Offisielt tilbud hos ${chainLabels[offer.chainId as Chain]}`} key={offer.id}>
                              <div>
                                <p>Offisielt tilbud • {chainLabels[offer.chainId as Chain]}</p>
                                <strong>{officialOfferPriceLabel(offer)}</strong>
                                <span>{offerConditions(offer)}</span>
                              </div>
                              <div>
                                {beforeTotal !== undefined ? <small>Oppgitt førpris: {formatNok(beforeTotal)}</small> : <small>Tilbudskilden oppgir ikke førpris.</small>}
                                {savingsOre !== undefined && savingsOre > 0 ? <small>Spar {formatNok(savingsOre)} ({formatPercentFromBasisPoints(savingsBasisPoints)}) basert på tilbudets oppgitte førpris.</small> : null}
                                <small>Gjelder fra {formatDate(offer.applicability.startsAt)} til {formatDate(offer.applicability.endsAt)} • {offerScope(offer)} • i butikk</small>
                                <small>Fanget {formatObservedAt(offer.capturedAt)} • {sourceLabel(result?.sources ?? [], offer.sourceId)}</small>
                              </div>
                            </section>
                          );
                        })}

                        {prices.length > 0 ? (
                          <ul className="chain-price-list" aria-label={`Ordinærpriser for ${entry.catalog.displayName}`}>
                            {prices.map((price) => {
                              const comparison = matchingComparison(entry.visibleComparisons, price.id);
                              return (
                                <li key={price.id}>
                                  <span>{chainLabels[price.chainId as Chain]}</span>
                                  <strong>{formatNok(price.amountOre)}</strong>
                                  <small>Ordinærpris • {sourceLabel(result?.sources ?? [], price.sourceId)} • {formatObservedAt(price.observedAt)}</small>
                                  {comparison ? (
                                    <section
                                      className="historical-comparison-panel"
                                      aria-label={`Historisk prissammenligning hos ${chainLabels[price.chainId as Chain]}`}
                                    >
                                      <p>Historisk sammenligning • {chainLabels[price.chainId as Chain]}</p>
                                      <small>Median siste 30 dager: {formatNok(comparison.baselineOre)}.</small>
                                      <small>Nå {formatNok(comparison.savingsOre)} lavere enn den validerte medianen ({formatPercentFromBasisPoints(comparison.savingsBasisPoints)}). Dette er ikke butikkens førpris.</small>
                                    </section>
                                  ) : null}
                                </li>
                              );
                            })}
                          </ul>
                        ) : null}

                        <div className="discovery-evidence-summary">
                          <p>{coverageText(entry)}</p>
                          <small>{categoryPathText(entry)}</small>
                          <small>Katalog: {entry.catalog.catalogEvidence.source.displayName} • observert {formatObservedAt(entry.catalog.catalogEvidence.observedAt)} • dekning vurdert {formatObservedAt(entry.comparisonScope.evaluatedAt)}</small>
                        </div>
                        <div className="opportunity-action-row">
                          <p>{best
                            ? unitPrice(entry.catalog, best.amountOre) ?? "Enhetspris kan ikke beregnes for denne pakningstypen."
                            : "Varen kan legges til eksakt med GTIN selv om ordinærpris mangler."}</p>
                          <button
                            className={added ? "secondary-button added" : "primary-button"}
                            type="button"
                            disabled={added || basket.needs.length >= 50}
                            onClick={() => addProduct(entry.catalog)}
                          >{added ? "I handlelisten" : "Legg til i handlelisten"}</button>
                        </div>
                      </div>
                    </article>
                  );
                })}
                </div>
              </>
            ) : null}
            {effectiveStatus === "ready" && result !== null && (currentPage > 0 || result.page.hasMore) ? (
              <nav className="discovery-pagination" aria-label="Sider med prisfunn">
                <button
                  className="secondary-button"
                  disabled={currentPage === 0}
                  onClick={() => {
                    setStatus("loading");
                    setPageCursors((values) => values.length <= 1 ? values : values.slice(0, -1));
                  }}
                  type="button"
                >Forrige</button>
                <span aria-live="polite">
                  Side {currentPage + 1} • inntil {DISCOVERY_PAGE_SIZE} varer per side • {result.page.scannedCatalogProducts} katalogvarer vurdert i dette serversnittet
                </span>
                <button
                  className="secondary-button"
                  disabled={!result.page.hasMore || result.page.nextCursor === undefined}
                  onClick={() => {
                    if (result.page.nextCursor === undefined) return;
                    setStatus("loading");
                    setPageCursors((values) => [...values, result.page.nextCursor]);
                  }}
                  type="button"
                >Neste</button>
              </nav>
            ) : null}
          </section>
        </div>

        <aside className="discovery-rail" aria-labelledby="discovery-basket-title">
          <div className="discovery-basket-card">
            <p>Felles med Planlegg</p>
            <h2 id="discovery-basket-title">Din handleliste</h2>
            <strong>{needCount} varebehov</strong>
            <span>{basket.needs.length === 0
              ? "Legg til en katalogvare for å starte listen."
              : "Nye varer lagres lokalt som eksakte GTIN-valg og tas med i neste beregning."}</span>
            <a className="primary-button" href="/planlegg">Gå til Planlegg <span aria-hidden="true">→</span></a>
          </div>
          <div className="discovery-trust-card">
            <h2>Slik leser du prisfunnene</h2>
            <p>Ordinærpris, offisielt tilbud og historisk sammenligning er tre forskjellige påstander. De blandes ikke.</p>
            <p>«Historisk median» krever minst sju observasjonsdager i et validert 30-dagers vindu. Den er ikke butikkens førpris og kalles ikke rabatt.</p>
            <p>Manglende historisk sammenligning betyr ikke at prisen er uendret. Et stort kildegrunnlag kan være utelatt fra Oppdag-snapshotet for å bevare ordinærprisene innenfor størrelsesgrensen.</p>
            <p>Offisielle tilbud viser vilkår og oppgitt førpris bare når det finnes i det godkjente tilbudsgrunnlaget.</p>
            <p>Kategorier er kildeobservasjoner fra ferske katalograder. De er ikke en påstand om en fullstendig butikktaksonomi, og ukjent kategori holdes forskjellig fra en eksplisitt tom kategori.</p>
            {result ? <small>Lesemodell: kontrollert lokal cache • kilder: {result.sources.map(({ displayName }) => displayName).join(", ") || "ingen priskilder"} • snapshot {formatObservedAt(result.generatedAt)}</small> : null}
          </div>
        </aside>
      </div>
    </main>
  );
}
