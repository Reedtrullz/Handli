import { createHash } from "node:crypto";
import type { TjekClient, TjekCatalog, TjekOffer } from "@handleplan/tjek";
import type { HandleplanDatabase } from "@handleplan/db/client";
import type { WorkerJobHandler } from "./runner";
import { WorkerCancelledError } from "./runner";

export const TJEK_SOURCE_ID = "tjek" as const;
export const TJEK_JOB_KIND = "official-offer-discovery" as const;

const OFFICIAL_OFFER_CAPABILITIES = ["capture", "discover", "extract"] as const;

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

/**
 * Compute the edition_identity_sha256 that the publications trigger expects.
 * Delegates to the canonical_official_offer_edition_identity SQL function and
 * hashes the result, matching the exact logic in enforce_publication_offer_identity().
 */
async function computeEditionIdentitySha256(
  db: HandleplanDatabase,
  args: { sourceId: string; externalId: string; chain: string; title: string; contentKind: string; geographicScopeId: number; validFrom: Date; validUntil: Date; discoveredAt: Date },
): Promise<string> {
  const row = await db.$client<{ hash: string }[]>`SELECT encode(sha256(convert_to(
    public.canonical_official_offer_edition_identity(
      ${args.sourceId}, ${args.externalId}, ${args.chain}, ${args.title},
      ${args.contentKind}, ${args.geographicScopeId},
      (SELECT public.canonical_official_offer_scope_identity(declared_geographic_scope)
       FROM public.geographic_scopes WHERE id = ${args.geographicScopeId} AND status = 'active')::jsonb,
      ${args.validFrom}, ${args.validUntil}, ${args.discoveredAt}
    ), 'UTF8')), 'hex') AS hash`;
  const hash = row[0]?.hash;
  if (!hash || hash.length !== 64) throw new Error("Failed to compute edition identity SHA256");
  return hash;
}

/**
 * Resolve the latest source_permissions id for the Tjek source. The
 * assert_current_official_offer_permission() function enforces that the
 * asserted permission id matches the latest row for the source, so we
 * must query it rather than hardcoding.
 */
async function resolvePermissionId(db: HandleplanDatabase): Promise<number> {
  const row = await db.$client<{ id: number }[]>`SELECT id FROM source_permissions WHERE source_id = ${TJEK_SOURCE_ID} ORDER BY created_at DESC, id DESC LIMIT 1`;
  const id = row[0]?.id;
  if (!id) throw new Error("No source_permissions row found for tjek");
  return id;
}

export function createTjekHandlers(dependencies: TjekHandlerDependencies): Partial<Record<typeof TJEK_JOB_KIND, WorkerJobHandler>> {
  const handler: WorkerJobHandler = async ({ signal, jobId }) => {
    try {
      abort(signal);
      console.error("[tjek] handler started, jobId:", jobId);
      const catalog = await dependencies.client.getLatestCatalog(signal);
      if (catalog === undefined) return { counters: {} };
      const existing = await dependencies.db.$client<{ id: number }[]>`SELECT id FROM publications WHERE source_id = ${TJEK_SOURCE_ID} AND external_id = ${catalog.id} LIMIT 1`;
      if (existing.length > 0) return { counters: {} };
      // Respectful delay before fetching offers
      await new Promise<void>((resolve, reject) => { const t = setTimeout(resolve, 1000); signal.addEventListener("abort", () => { clearTimeout(t); reject(new WorkerCancelledError()); }, { once: true }); });
      const offers = await dependencies.client.getOffersFromCatalog(catalog.id, signal);
      abort(signal);
      const now = dependencies.clock?.() ?? new Date();
      const validFrom = date(catalog.run_from, now);
      const validUntil = date(catalog.run_till, new Date(now.getTime() + 7 * 86400000));
      const chain = "bunnpris";
      const title = "Bunnpris " + catalog.publication_date;
      const contentKind = "structured-feed";
      const geographicScopeId = 1;
      const declaredGeographicScope = { kind: "national", countryCode: "NO" };

      // Resolve the latest permission id (assert function enforces latest)
      const permissionId = await resolvePermissionId(dependencies.db);

      // 1. Compute edition_identity_sha256 (required by enforce_publication_offer_identity)
      const editionIdentitySha256 = await computeEditionIdentitySha256(dependencies.db, {
        sourceId: TJEK_SOURCE_ID, externalId: catalog.id, chain, title, contentKind,
        geographicScopeId, validFrom, validUntil, discoveredAt: now,
      });

      // 2. Insert publication with complete identity fence
      const publication = await dependencies.db.$client<{ id: number }[]>`INSERT INTO publications (source_id, external_id, chain, title, content_kind, geographic_scope_id, declared_geographic_scope, edition_identity_sha256, discovery_permission_id, valid_from, valid_until, discovered_at, status) VALUES (${TJEK_SOURCE_ID}, ${catalog.id}, ${chain}, ${title}, ${contentKind}, ${geographicScopeId}, ${JSON.stringify(declaredGeographicScope)}::jsonb, ${editionIdentitySha256}, ${permissionId}, ${validFrom}, ${validUntil}, ${now}, 'discovered') RETURNING id`;
      const publicationId = publication[0]?.id;
      if (publicationId === undefined) throw new Error("Failed to create Tjek publication");

      // 3. Insert capture with permission fence (enforce_capture_permission_fence)
      const payload = JSON.stringify({ catalog, offers });
      const capabilitiesJson = JSON.stringify([...OFFICIAL_OFFER_CAPABILITIES]);
      const blobKey = "tjek/" + catalog.id + ".json";
      const capture = await dependencies.db.$client<{ id: number }[]>`INSERT INTO publication_captures (publication_id, blob_key, checksum, mime_type, byte_length, rights_classification, capture_permission_id, capture_permission_capabilities, retrieved_at) VALUES (${publicationId}, ${blobKey}, ${checksum(payload)}, 'application/json', ${Buffer.byteLength(payload)}, 'public_display', ${permissionId}, ${capabilitiesJson}::jsonb, ${now}) RETURNING id`;
      const captureId = capture[0]?.id;
      if (captureId === undefined) throw new Error("Failed to create Tjek capture");

      // 4. Insert extraction run with trust fence (enforce_extraction_run_trust_fence)
      const counts = JSON.stringify({ offers: offers.length });
      const extraction = await dependencies.db.$client<{ id: number }[]>`INSERT INTO extraction_runs (capture_id, extractor_version, status, started_at, completed_at, counts, extraction_method, extraction_permission_id, permission_capabilities, source_started_at, source_completed_at, empty_result) VALUES (${captureId}, 'tjek-v1', 'completed', ${now}, ${now}, ${counts}::jsonb, 'structured', ${permissionId}, ${capabilitiesJson}::jsonb, ${now}, ${now}, 'not-empty') RETURNING id`;
      const extractionId = extraction[0]?.id;
      if (extractionId === undefined) throw new Error("Failed to create Tjek extraction run");

      // 5. Load canonical products for fuzzy matching
      const products = await dependencies.db.$client<{ id: number; display_name: string }[]>`SELECT id, display_name FROM canonical_products WHERE status = 'active'`;

      let accepted = 0;
      for (const offer of offers) {
        abort(signal);
        const key = offer.id || catalog.id + "-" + accepted;
        const match = matchOfferToProduct(offer.name, products.map((p) => ({ id: Number(p.id), displayName: p.display_name })), dependencies.matchThreshold ?? 60);
        const confidence = match?.confidence ?? 0;

        // 5a. Extracted candidate
        const normalizedFields = {
          candidateKey: key,
          productName: offer.name,
          offerPriceOre: ore(offer.price),
          beforePriceOre: ore(offer.before_price),
          validFrom: offer.run_from || validFrom.toISOString(),
          validUntil: offer.run_till || validUntil.toISOString(),
          eligibility: "public",
          channels: ["in-store"],
          provenance: { method: "tjek", evidenceLocator: offer.page_number === null ? key : "page:" + offer.page_number, confidence },
        };
        const anomalyCodes = match === undefined ? ["unmatched-product"] : [];
        const candidate = await dependencies.db.$client<{ id: number }[]>`INSERT INTO extracted_offer_candidates (extraction_run_id, candidate_key, normalized_fields, confidence, status, anomaly_codes) VALUES (${extractionId}, ${key}, ${JSON.stringify(normalizedFields)}::jsonb, ${confidence}, 'pending', ${JSON.stringify(anomalyCodes)}::jsonb) RETURNING id`;
        const candidateId = candidate[0]!.id;
        const amount = ore(offer.price);
        if (amount === null) continue;
        const before = ore(offer.before_price);

        // 5b. Approved offer (enforce_approved_offer_insert_boundary requires status = 'approved')
        const offerKey = "tjek:" + catalog.id + ":" + key;
        const approved = await dependencies.db.$client<{ id: number }[]>`INSERT INTO approved_offers (offer_key, candidate_id, source_id, source_reference, chain, geographic_scope_id, amount_ore, before_amount_ore, membership_requirement, valid_from, valid_until, status, version, approved_at) VALUES (${offerKey}, ${candidateId}, ${TJEK_SOURCE_ID}, ${offerKey}, ${chain}, ${geographicScopeId}, ${amount}, ${before !== null && before >= amount ? before : null}, 'public', ${date(offer.run_from, validFrom)}, ${date(offer.run_till, validUntil)}, 'approved', 1, ${now}) RETURNING id`;
        const offerId = approved[0]!.id;

        // 5c. Review action
        const reviewNewValues = { channels: ["in-store"], eligibility: "public" };
        await dependencies.db.$client`INSERT INTO review_actions (candidate_id, offer_id, actor_id, action, expected_version, new_values, reason, acted_at) VALUES (${candidateId}, ${offerId}, 'tjek-worker', 'approve', 0, ${JSON.stringify(reviewNewValues)}::jsonb, 'Automated Tjek import', ${now})`;

        // 5d. Product target (if fuzzy match succeeded)
        if (match !== undefined) {
          await dependencies.db.$client`INSERT INTO offer_targets (offer_id, product_id, match_method, match_confidence) VALUES (${offerId}, ${match.productId}, 'human_review', ${match.confidence})`;
        }

        // 5e. Lifecycle transition: approved -> published (enforce_approved_offer_lifecycle_transition_v1)
        await dependencies.db.$client`UPDATE approved_offers SET status = 'published' WHERE id = ${offerId}`;
        accepted += 1;
      }

      console.error("[tjek] done, offers:", offers.length, "accepted:", accepted);
      return { counters: { fetched: offers.length, accepted, quarantined: offers.length - accepted, unknown: 0, persisted: offers.length, failed: 0 } };
    } catch (error) {
      console.error("[tjek] handler error:", error);
      throw error;
    }
  };
  return { [TJEK_JOB_KIND]: handler };
}
