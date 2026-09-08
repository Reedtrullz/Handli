import type { HandleplanDatabase } from "@handleplan/db/client";
import { PostgresOfficialOfferFoundationRepository } from "@handleplan/db/official-offer-foundation";
import { PostgresSourceAccessReader } from "@handleplan/db/source-access";
import { officialOfferAuthorizationFenceV1Schema, officialOfferEditionDiscoveryInputV1Schema } from "@handleplan/domain";
import { FilesystemOfficialOfferPrivateBlobStore } from "./private-offer-blob-store";
import { WorkerCancelledError } from "./runner";
import type { TjekFoundationDependencies } from "./tjek-handlers";

const chains: Readonly<Record<string, string>> = { "5b11sm": "bunnpris", "80742m": "extra", "faa0Ym": "rema-1000" };
const timestamp = (value: Date | string) => new Date(value).toISOString();
export function createTjekFoundationDependencies(db: HandleplanDatabase, privateCaptureRoot: string): TjekFoundationDependencies {
  const reader = new PostgresSourceAccessReader(db);
  const sourceAccessPolicy: TjekFoundationDependencies["sourceAccessPolicy"] = {
    async getDecision(sourceId, capability, asOf, signal) {
      const access = await reader.getSourceAccess(sourceId, signal);
      if (access?.runtimeState !== "approved" || !access.permissionCurrent || !access.sourcePermissionCurrent || access.permissionDecision !== "approved" || access.permissions.officialOffers !== true) throw new Error("TJEK_SOURCE_DISABLED");
      const rows = await db.$client<{ id: number; reviewed_at: Date; valid_until: Date | null; permissions: Record<string, unknown> }[]>`
        select permission.id, permission.reviewed_at, permission.valid_until, permission.permissions
        from data_sources source join lateral (
          select * from source_permissions where source_id = source.id
          and created_at <= clock_timestamp() order by created_at desc, id desc limit 1
        ) permission on true
        where source.id = ${sourceId} and source.runtime_state = 'approved'
        and permission.decision = 'approved'
        and source.permission_reviewed_at = permission.reviewed_at
        and source.permission_expires_at is not distinct from permission.valid_until
        and permission.reviewed_at <= ${asOf}::timestamptz
        and permission.created_at <= ${asOf}::timestamptz
        and source.public_state_changed_at <= ${asOf}::timestamptz
        and (permission.valid_until is null or permission.valid_until > clock_timestamp())
        and permission.permissions @> '{"officialOffers": true}'::jsonb limit 1`;
      if (signal.aborted) throw new WorkerCancelledError();
      const row = rows[0];
      if (!row) throw new Error("TJEK_SOURCE_DISABLED");
      const fence = officialOfferAuthorizationFenceV1Schema.parse({
        contractVersion: 1, permissionId: Number(row.id), sourceId, decision: "approved",
        capabilities: row.permissions.officialOfferCapabilities,
        rightsClassifications: row.permissions.officialOfferRightsClassifications,
        reviewedAt: timestamp(row.reviewed_at), evaluatedAt: asOf,
        ...(row.valid_until ? { validUntil: timestamp(row.valid_until) } : {}),
      });
      if (!fence.capabilities.includes(capability) || !fence.rightsClassifications.includes("public_display")) throw new Error("TJEK_SOURCE_DISABLED");
      return fence;
    },
  };
  return {
    repository: new PostgresOfficialOfferFoundationRepository(db),
    privateBlobStore: new FilesystemOfficialOfferPrivateBlobStore({ rootDirectory: privateCaptureRoot }),
    sourceAccessPolicy,
    async isCaptureComplete(externalEditionId, checksumSha256, signal) {
      const rows = await db.$client<{ status: "completed" | "degraded" }[]>`
        select extraction.status from publications publication
        join publication_captures capture on capture.publication_id = publication.id
        join extraction_runs extraction on extraction.capture_id = capture.id
        where publication.source_id = 'tjek' and publication.external_id = ${externalEditionId}
        and capture.checksum = ${checksumSha256} and capture.rights_classification = 'public_display'
        and extraction.extractor_version = 'tjek-review-v2' and extraction.status in ('completed', 'degraded')
        and extraction.completed_at is not null and extraction.empty_result = 'not-empty'
        and (extraction.counts ->> 'total')::integer > 0
        and (extraction.counts ->> 'persistedCandidates')::integer =
          (select count(*) from extracted_offer_candidates candidate where candidate.extraction_run_id = extraction.id)
        limit 1`;
      if (signal.aborted) throw new WorkerCancelledError();
      return rows[0]?.status;
    },
    async resolveEdition(catalog, signal) {
      const chain = chains[catalog.dealer_id];
      if (!chain) throw new Error("TJEK_UNKNOWN_DEALER");
      const fence = officialOfferAuthorizationFenceV1Schema.parse(await sourceAccessPolicy.getDecision("tjek", "discover", new Date().toISOString(), signal));
      const rows = await db.$client<{ title: string; content_kind: string; chain: string; geographic_scope_id: number; declared_geographic_scope: unknown; valid_from: Date; valid_until: Date; discovered_at: Date }[]>`
        select title, content_kind, chain, geographic_scope_id, declared_geographic_scope, valid_from, valid_until, discovered_at
        from publications where source_id = 'tjek' and external_id = ${catalog.id} limit 1`;
      const existing = rows[0];
      const raw = catalog as typeof catalog & { all_stores?: boolean; dealer?: { country?: { id?: string }; markets?: { country_code?: string }[] } };
      // Legacy importer publications alone are not reviewed geographic evidence.
      if (raw.all_stores !== true || raw.dealer?.country?.id !== "NO" || !raw.dealer.markets?.length || raw.dealer.markets.some(market => market.country_code !== "NO")) throw new Error("TJEK_REVIEWED_SCOPE_UNAVAILABLE");
      let scopeId: number;
      if (existing) {
        if (existing.chain !== chain || timestamp(existing.valid_from) !== timestamp(catalog.run_from) || timestamp(existing.valid_until) !== timestamp(catalog.run_till)) throw new Error("TJEK_EDITION_CONFLICT");
        const scope = existing.declared_geographic_scope as { kind?: string; countryCode?: string };
        if (scope?.kind !== "national" || scope.countryCode !== "NO") throw new Error("TJEK_EDITION_CONFLICT");
        scopeId = Number(existing.geographic_scope_id);
      } else {
        const scopes = await db.$client<{ id: number }[]>`select id from geographic_scopes where scope_kind = 'national' and country_code = 'NO' and status = 'active' limit 2`;
        if (scopes.length !== 1) throw new Error("TJEK_REVIEWED_SCOPE_UNAVAILABLE");
        scopeId = Number(scopes[0]!.id);
      }
      if (signal.aborted) throw new WorkerCancelledError();
      return officialOfferEditionDiscoveryInputV1Schema.parse({
        contractVersion: 1, sourceId: "tjek", externalEditionId: catalog.id, chain,
        title: existing?.title ?? `${chain} ${catalog.publication_date}`,
        contentKind: existing?.content_kind ?? "structured-feed", geographicScopeId: scopeId,
        declaredGeographicScope: existing?.declared_geographic_scope ?? { kind: "national", countryCode: "NO" },
        validFrom: timestamp(catalog.run_from), validUntil: timestamp(catalog.run_till),
        discoveredAt: existing ? timestamp(existing.discovered_at) : new Date().toISOString(),
        authorization: { decision: "approved", capabilities: fence.capabilities, reviewedAt: fence.reviewedAt, ...(fence.validUntil ? { validUntil: fence.validUntil } : {}) },
      });
    },
  };
}
