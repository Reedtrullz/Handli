import { createHash } from "node:crypto";
import { officialOfferAuthorizationFenceV1Schema, officialOfferEditionDiscoveryInputV1Schema, type OfficialOfferEditionDiscoveryInputV1 } from "@handleplan/domain";
import { MENY_LAYOUT_FINGERPRINT, MENY_SOURCE_ID, createMenyEmbeddedTextExtractor, parseMenyStaticSettings } from "./meny-offers";
import { OfficialOfferFoundationPipeline, type OfficialOfferFoundationPipelineOptions } from "./official-offer-foundation";
import { WorkerCancelledError, type WorkerJobHandler } from "./runner";

export const MENY_JOB_KIND = "official-offer-discovery" as const;
const MENY_VIEWER_URL = "https://kundeavis.meny.no/";
const MENY_NO_STRUCTURED_CONTENT = {
  contractVersion: 1,
  state: "unavailable" as const,
  reason: "NO_STRUCTURED_CONTENT" as const,
};

export interface MenyFoundationDependencies
  extends Pick<OfficialOfferFoundationPipelineOptions, "repository" | "privateBlobStore" | "sourceAccessPolicy"> {
  isCaptureComplete?(externalEditionId: string, checksumSha256: string, signal: AbortSignal): Promise<"completed" | "degraded" | undefined>;
  resolveEdition(viewerHtml: string, signal: AbortSignal): Promise<OfficialOfferEditionDiscoveryInputV1>;
}

export interface MenyHandlerDependencies {
  readonly foundation: MenyFoundationDependencies;
  readonly fetchViewerHtml?: (url: string, signal: AbortSignal) => Promise<string>;
  readonly clock?: () => Date;
}

function abort(signal: AbortSignal): void { if (signal.aborted) throw new WorkerCancelledError(); }

async function defaultFetchViewerHtml(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal, redirect: "follow" });
  if (!response.ok) throw new Error("MENY_VIEWER_FETCH_FAILED");
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) throw new Error("MENY_VIEWER_NOT_HTML");
  return await response.text();
}

export function createMenyHandlers(deps: MenyHandlerDependencies): Partial<Record<typeof MENY_JOB_KIND, WorkerJobHandler>> {
  return { [MENY_JOB_KIND]: async ({ signal }) => {
    abort(signal);
    const now = deps.clock ?? (() => new Date());
    const fetchViewerHtml = deps.fetchViewerHtml ?? defaultFetchViewerHtml;
    const authorize = async (capability: "discover" | "capture") => {
      const asOf = now().toISOString();
      const fence = officialOfferAuthorizationFenceV1Schema.parse(await deps.foundation.sourceAccessPolicy.getDecision(MENY_SOURCE_ID, capability, asOf, signal));
      if (fence.sourceId !== MENY_SOURCE_ID || fence.evaluatedAt !== asOf || !fence.capabilities.includes(capability) || !fence.rightsClassifications.includes("public_display")) throw new Error("MENY_SOURCE_DISABLED");
      abort(signal);
    };
    await authorize("discover");
    const viewerHtml = await fetchViewerHtml(MENY_VIEWER_URL, signal);
    abort(signal);
    if (!parseMenyStaticSettings(viewerHtml)) throw new Error("MENY_VIEWER_UNREADABLE");
    const counters = { fetched: 0, accepted: 0, quarantined: 0, unknown: 0, persisted: 0, failed: 0 };
    try {
      const edition = officialOfferEditionDiscoveryInputV1Schema.parse(await deps.foundation.resolveEdition(viewerHtml, signal));
      if (edition.sourceId !== MENY_SOURCE_ID) throw new Error("MENY_EDITION_MISMATCH");
      await authorize("capture");
      abort(signal);
      counters.fetched += 1;
      const bytes = Buffer.from(viewerHtml, "utf8");
      const checksum = createHash("sha256").update(bytes).digest("hex");
      const existingStatus = await deps.foundation.isCaptureComplete?.(edition.externalEditionId, checksum, signal);
      if (existingStatus) {
        if (existingStatus === "degraded") counters.failed += 1;
        return { counters };
      }
      const pipeline = new OfficialOfferFoundationPipeline({
        ...deps.foundation, now,
        expectedLayoutFingerprintsSha256: [MENY_LAYOUT_FINGERPRINT], expectedSchemaFingerprintSha256: MENY_LAYOUT_FINGERPRINT,
        exactProductResolver: { async resolveGtins(gtins) {
          if (gtins.length) throw new Error("MENY_EXACT_IDENTIFIERS_UNSUPPORTED");
          return { contractVersion: 1, matchesByGtin: {} };
        } },
        structuredExtractor: { method: "structured", extractorVersion: "meny-structured-none-v1", async extract() {
          return MENY_NO_STRUCTURED_CONTENT;
        } },
        embeddedTextExtractor: createMenyEmbeddedTextExtractor(parseMenyStaticSettings(viewerHtml)!, now),
      });
      const receipt = await pipeline.captureAndExtract({ contractVersion: 1, bytes, edition, mimeType: "text/html", rightsClassification: "public_display" }, signal);
      counters.persisted += receipt.counts.total;
      counters.quarantined += receipt.counts.reviewRequired + receipt.counts.rejected;
      if (receipt.status !== "completed") counters.failed += 1;
    } catch (error) {
      abort(signal);
      counters.failed += 1;
      console.error("[meny] edition ingestion failed", error instanceof Error ? error.message : "unknown error");
    }
    return { counters };
  } };
}
