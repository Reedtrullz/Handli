import { createHash } from "node:crypto";
import type { TjekClient, TjekCatalog, TjekOffer } from "@handleplan/tjek";
import type { HandleplanDatabase } from "@handleplan/db/client";
import type { WorkerJobHandler } from "./runner";
import { WorkerCancelledError } from "./runner";

export const TJEK_SOURCE_ID = "tjek" as const;
export const TJEK_JOB_KIND = "official-offer-discovery" as const;

export function normalizeOfferName(value: string): string {
  return value.toLocaleLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\b(stk|pk|pakke|kg|g|gram|ml|l|liter|cl|tilbud|kr)\b/gu, " ")
    .replace(/\s+/gu, " ").trim();
}

export function scoreProductMatch(offerName: string, productName: string): number {
  const a = new Set(normalizeOfferName(offerName).split(" "));
  const b = new Set(normalizeOfferName(productName).split(" "));
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0; for (const token of a) if (b.has(token)) overlap += 1;
  const score = overlap / Math.max(a.size, b.size);
  return normalizeOfferName(productName).includes(normalizeOfferName(offerName)) || normalizeOfferName(offerName).includes(normalizeOfferName(productName))
    ? Math.max(0.8, score) * 100 : score * 100;
}

export interface TjekProductMatch { productId: number; confidence: number; displayName: string }
export function matchOfferToProduct(offerName: string, products: readonly { id: number; displayName: string }[], threshold = 60): TjekProductMatch | undefined {
  let best: TjekProductMatch | undefined;
  for (const product of products) { const confidence = Math.round(scoreProductMatch(offerName, product.displayName)); if (confidence >= threshold && (best === undefined || confidence > best.confidence)) best = { productId: product.id, confidence, displayName: product.displayName }; }
  return best;
}

export interface TjekHandlerDependencies {
  readonly apiKey?: string;
  readonly client: Pick<TjekClient, "getLatestCatalog" | "getOffersFromCatalog">;
  readonly db: HandleplanDatabase;
  readonly clock?: () => Date;
  readonly matchThreshold?: number;
}

function ore(value: number | null): number | null { return value === null || !Number.isFinite(value) || value < 0 ? null : Math.round(value * 100); }
function date(value: string, fallback: Date): Date { const d = new Date(value); return Number.isFinite(d.getTime()) ? d : fallback; }
function checksum(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function abort(signal: AbortSignal): void { if (signal.aborted) throw new WorkerCancelledError(); }

export function createTjekHandlers(dependencies: TjekHandlerDependencies): Partial<Record<typeof TJEK_JOB_KIND, WorkerJobHandler>> {
  const handler: WorkerJobHandler = async ({ signal, jobId }) => {
    abort(signal);
    const catalog = await dependencies.client.getLatestCatalog(signal);
    if (catalog === undefined) return { counters: {} };
    const existing = await dependencies.db.$client<{ id: number }[]>`select id from publications where source_id = ${TJEK_SOURCE_ID} and external_id = ${catalog.id} limit 1`;
    if (existing.length > 0) return { counters: {} };
    await new Promise<void>((resolve, reject) => { const t = setTimeout(resolve, 1000); signal.addEventListener("abort", () => { clearTimeout(t); reject(new WorkerCancelledError()); }, { once: true }); });
    const offers = await dependencies.client.getOffersFromCatalog(catalog.id, signal); abort(signal);
    const now = dependencies.clock?.() ?? new Date();
    const validFrom = date(catalog.run_from, now); const validUntil = date(catalog.run_till, new Date(now.getTime() + 7 * 86400000));
    const publication = await dependencies.db.$client<{ id: number }[]>`insert into publications (source_id, external_id, chain, title, content_kind, geographic_scope_id, declared_geographic_scope, valid_from, valid_until, discovered_at, status) values (${TJEK_SOURCE_ID}, ${catalog.id}, 'bunnpris', ${`Bunnpris ${catalog.publication_date}`}, 'structured-feed', 1, ${JSON.stringify({ kind: 'national', countryCode: 'NO' })}::jsonb, ${validFrom}, ${validUntil}, ${now}, 'discovered') returning id`;
    const publicationId = publication[0]?.id; if (publicationId === undefined) throw new Error("Failed to create Tjek publication");
    const payload = JSON.stringify({ catalog, offers });
    const capture = await dependencies.db.$client<{ id: number }[]>`insert into publication_captures (publication_id, blob_key, checksum, mime_type, byte_length, rights_classification, retrieved_at) values (${publicationId}, ${`tjek/${catalog.id}.json`}, ${checksum(payload)}, 'application/json', ${Buffer.byteLength(payload)}, 'public_display', ${now}) returning id`;
    const extraction = await dependencies.db.$client<{ id: number }[]>`insert into extraction_runs (capture_id, extractor_version, status, started_at, completed_at, counts) values (${capture[0]!.id}, 'tjek-v1', 'completed', ${now}, ${now}, ${JSON.stringify({ offers: offers.length })}::jsonb) returning id`;
    const products = await dependencies.db.$client<{ id: number; display_name: string }[]>`select id, display_name from canonical_products where status = 'active'`;
    let accepted = 0;
    for (const offer of offers) {
      abort(signal); const key = offer.id || `${catalog.id}-${accepted}`; const match = matchOfferToProduct(offer.name, products.map((p) => ({ id: Number(p.id), displayName: p.display_name })), dependencies.matchThreshold ?? 60);
      const confidence = match?.confidence ?? 0;
      const candidate = await dependencies.db.$client<{ id: number }[]>`insert into extracted_offer_candidates (extraction_run_id, candidate_key, normalized_fields, confidence, status, anomaly_codes) values (${extraction[0]!.id}, ${key}, ${JSON.stringify({ candidateKey: key, productName: offer.name, offerPriceOre: ore(offer.price), beforePriceOre: ore(offer.before_price), validFrom: offer.run_from || validFrom.toISOString(), validUntil: offer.run_till || validUntil.toISOString(), eligibility: 'public', channels: ['in-store'], provenance: { method: 'tjek', evidenceLocator: offer.page_number === null ? key : `page:${offer.page_number}`, confidence } })}::jsonb, ${confidence}, 'pending', ${JSON.stringify(match === undefined ? ['unmatched-product'] : [])}::jsonb) returning id`;
      const candidateId = candidate[0]!.id; const amount = ore(offer.price); if (amount === null) continue; const before = ore(offer.before_price);
      const approved = await dependencies.db.$client<{ id: number }[]>`insert into approved_offers (offer_key, candidate_id, source_id, source_reference, chain, geographic_scope_id, amount_ore, before_amount_ore, membership_requirement, valid_from, valid_until, status, version, approved_at) values (${`tjek:${catalog.id}:${key}`}, ${candidateId}, ${TJEK_SOURCE_ID}, ${`tjek:${catalog.id}:${key}`}, 'bunnpris', 1, ${amount}, ${before !== null && before >= amount ? before : null}, 'public', ${date(offer.run_from, validFrom)}, ${date(offer.run_till, validUntil)}, 'approved', 1, ${now}) returning id`;
      const offerId = approved[0]!.id;
      await dependencies.db.$client`insert into review_actions (candidate_id, offer_id, actor_id, action, expected_version, new_values, reason, acted_at) values (${candidateId}, ${offerId}, 'tjek-worker', 'approve', 0, ${JSON.stringify({ channels: ['in-store'], eligibility: 'public' })}::jsonb, 'Automated Tjek import', ${now})`;
      if (match !== undefined) await dependencies.db.$client`insert into offer_targets (offer_id, product_id, match_method, match_confidence) values (${offerId}, ${match.productId}, 'human_review', ${match.confidence})`;
      await dependencies.db.$client`update approved_offers set status = 'published' where id = ${offerId}`; accepted += 1;
    }
    return { counters: { fetched: offers.length, accepted, quarantined: offers.length - accepted, unknown: 0, persisted: accepted, failed: 0 } };
  };
  return { [TJEK_JOB_KIND]: handler };
}
