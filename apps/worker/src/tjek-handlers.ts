import { createHash } from "node:crypto";
import { officialOfferAuthorizationFenceV1Schema, officialOfferEditionDiscoveryInputV1Schema, type OfficialOfferEditionDiscoveryInputV1 } from "@handleplan/domain";
import type { TjekClient, TjekCatalog } from "@handleplan/tjek";
import { OfficialOfferFoundationPipeline, type OfficialOfferFoundationPipelineOptions } from "./official-offer-foundation";
import { WorkerCancelledError, type WorkerJobHandler } from "./runner";

export const TJEK_SOURCE_ID = "tjek" as const;
export const TJEK_JOB_KIND = "official-offer-discovery" as const;
const fingerprint = createHash("sha256").update("tjek-normalized-offers-review-v2").digest("hex");
export interface TjekFoundationDependencies extends Pick<OfficialOfferFoundationPipelineOptions, "repository" | "privateBlobStore" | "sourceAccessPolicy"> {
  isCaptureComplete?(externalEditionId: string, checksumSha256: string, signal: AbortSignal): Promise<"completed" | "degraded" | undefined>;
  resolveEdition(catalog: TjekCatalog, signal: AbortSignal): Promise<OfficialOfferEditionDiscoveryInputV1>;
}
export interface TjekHandlerDependencies {
  readonly client: Pick<TjekClient, "getOffersFromCatalog" | "getAllLatestCatalogs" | "canExtractOffers">;
  readonly foundation: TjekFoundationDependencies;
  readonly clock?: () => Date;
}
function abort(signal: AbortSignal): void { if (signal.aborted) throw new WorkerCancelledError(); }

export function createTjekHandlers(deps: TjekHandlerDependencies): Partial<Record<typeof TJEK_JOB_KIND, WorkerJobHandler>> {
  return { [TJEK_JOB_KIND]: async ({ signal }) => {
    abort(signal);
    const now = deps.clock ?? (() => new Date());
    const authorize = async (capability: "discover" | "capture") => {
      const asOf = now().toISOString();
      const fence = officialOfferAuthorizationFenceV1Schema.parse(await deps.foundation.sourceAccessPolicy.getDecision(TJEK_SOURCE_ID, capability, asOf, signal));
      if (fence.sourceId !== TJEK_SOURCE_ID || fence.evaluatedAt !== asOf || !fence.capabilities.includes(capability) || !fence.rightsClassifications.includes("public_display")) throw new Error("TJEK_SOURCE_DISABLED");
      abort(signal);
    };
    // The same persisted governance policy fences physical discovery and capture.
    await authorize("discover");
    const catalogs = await deps.client.getAllLatestCatalogs(signal);
    const counters = { fetched: 0, accepted: 0, quarantined: 0, unknown: 0, persisted: 0, failed: 0 };
    if (catalogs.length === 0) counters.failed = 1;
    for (const catalog of catalogs) {
      abort(signal);
      try {
        if (!deps.client.canExtractOffers(catalog)) throw new Error("TJEK_EXTRACTION_UNAVAILABLE");
        const edition = officialOfferEditionDiscoveryInputV1Schema.parse(await deps.foundation.resolveEdition(catalog, signal));
        if (edition.sourceId !== TJEK_SOURCE_ID || edition.externalEditionId !== catalog.id) throw new Error("TJEK_EDITION_MISMATCH");
        await authorize("capture");
        const offers = await deps.client.getOffersFromCatalog(catalog, signal);
        abort(signal);
        counters.fetched += offers.length;
        const bytes = Buffer.from(JSON.stringify({ catalog, offers }));
        const checksum = createHash("sha256").update(bytes).digest("hex");
        const existingStatus = await deps.foundation.isCaptureComplete?.(catalog.id, checksum, signal);
        if (existingStatus) {
          if (existingStatus === "degraded") counters.failed += 1;
          continue;
        }
        const pipeline = new OfficialOfferFoundationPipeline({
          ...deps.foundation, now,
          expectedLayoutFingerprintsSha256: [fingerprint], expectedSchemaFingerprintSha256: fingerprint,
          exactProductResolver: { async resolveGtins(gtins) {
            if (gtins.length) throw new Error("TJEK_EXACT_IDENTIFIERS_UNSUPPORTED");
            return { contractVersion: 1, matchesByGtin: {} };
          } },
          structuredExtractor: { method: "structured", extractorVersion: "tjek-review-v2", async extract(input) {
            const startedAt = now().toISOString();
            if (offers.some(offer => offer.currency && offer.currency !== "NOK")) throw new Error("TJEK_UNSUPPORTED_CURRENCY");
            return { contractVersion: 1, state: "available", envelope: {
              contractVersion: 1, captureChecksumSha256: input.captureMetadata.checksumSha256,
              method: "structured", extractorVersion: "tjek-review-v2",
              layoutFingerprintSha256: fingerprint, schemaFingerprintSha256: fingerprint,
              startedAt, completedAt: now().toISOString(),
              emptyResult: offers.length ? "not-empty" : "unexpected-empty",
              candidates: offers.map((offer, index) => ({
                contractVersion: 1, candidateKey: offer.id || `offer-${index}`,
                product: { kind: "unresolved-label", label: offer.name },
                package: { state: "unknown", reasonCode: "MISSING" },
                pricing: { kind: "unit", offerPriceOre: offer.price === null ? null : Math.round(offer.price * 100) },
                // These are review proposals, never approved product/eligibility claims.
                eligibility: { kind: "public" }, channels: ["in-store"],
                validity: offer.run_from && offer.run_till
                  ? { state: "parsed", startsAt: new Date(offer.run_from).toISOString(), endsAt: new Date(offer.run_till).toISOString() }
                  : { state: "unreadable", reasonCode: "MISSING" },
                geographicScope: edition.declaredGeographicScope,
                provenance: { method: "structured", evidenceLocator: `offers[${index}]`, confidence: 0 },
                anomalyCodes: ["EXTRACTOR_ANOMALY"],
              })),
            } };
          } },
        });
        const receipt = await pipeline.captureAndExtract({ contractVersion: 1, bytes, edition, mimeType: "application/json", rightsClassification: "public_display" }, signal);
        counters.persisted += receipt.counts.total;
        counters.quarantined += receipt.counts.reviewRequired + receipt.counts.rejected;
        if (receipt.status !== "completed") counters.failed += 1;
      } catch (error) {
        abort(signal);
        counters.failed += 1;
        console.error("[tjek] catalog ingestion failed", catalog.id, error instanceof Error ? error.message : "unknown error");
      }
    }
    return { counters };
  } };
}
