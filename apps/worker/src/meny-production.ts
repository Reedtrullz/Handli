import { createHash } from "node:crypto";
import type { HandleplanDatabase } from "@handleplan/db/client";
import { PostgresOfficialOfferFoundationRepository } from "@handleplan/db/official-offer-foundation";
import { PostgresSourceAccessReader } from "@handleplan/db/source-access";
import {
  canonicalOfficialOfferEditionIdentity,
  officialOfferAuthorizationFenceV1Schema,
  officialOfferEditionDiscoveryInputV1Schema,
  type OfficialOfferAuthorizationFenceV1,
} from "@handleplan/domain";
import { FilesystemOfficialOfferPrivateBlobStore } from "./private-offer-blob-store";
import { WorkerCancelledError } from "./runner";
import { MENY_EXTRACTOR_VERSION, MENY_SOURCE_ID, parseMenyStaticSettings } from "./meny-offers";
import type { MenyFoundationDependencies } from "./meny-handlers";

const timestamp = (value: Date | string) => new Date(value).toISOString();
const editionIdentitySha256 = (edition: Parameters<typeof canonicalOfficialOfferEditionIdentity>[0]) => createHash("sha256").update(canonicalOfficialOfferEditionIdentity(edition), "utf8").digest("hex");

const MONTH_BY_NAME: Readonly<Record<string, string>> = {
  JANUAR: "01", FEBRUAR: "02", MARS: "03", APRIL: "04", MAI: "05", JUNI: "06",
  JULI: "07", AUGUST: "08", SEPTEMBER: "09", OKTOBER: "10", NOVEMBER: "11", DESEMBER: "12",
};

/** Parses the front-page validity headline, e.g.
 *  "MANDAG 21. SEPTEMBER - LØRDAG 26. SEPTEMBER UKE 39, 2026".
 *  Validity ends at the second date + 1 day (the edition runs through its
 *  final day). Fail closed when the headline is missing or ambiguous. */
export function parseMenyValidityHeadline(headline: string): { validFrom: string; validUntil: string } | undefined {
  const pattern = /(\d{1,2})\.?\s+(JANUAR|FEBRUAR|MARS|APRIL|MAI|JUNI|JULI|AUGUST|SEPTEMBER|OKTOBER|NOVEMBER|DESEMBER)\b[^\d]*?(\d{1,2})\.?\s+(JANUAR|FEBRUAR|MARS|APRIL|MAI|JUNI|JULI|AUGUST|SEPTEMBER|OKTOBER|NOVEMBER|DESEMBER)\b(?:(?!\d{4}).)*?(\d{4})/i;
  const match = pattern.exec(headline);
  if (!match) return undefined;
  const days = [Number(match[1]), Number(match[3])];
  const months = [match[2]!.toUpperCase(), match[4]!.toUpperCase()];
  const year = match[5]!;
  if (days.some((day) => day < 1 || day > 31)) return undefined;
  const fromMonth = MONTH_BY_NAME[months[0]!];
  const untilMonth = MONTH_BY_NAME[months[1]!];
  if (fromMonth === undefined || untilMonth === undefined) return undefined;
  const validFrom = new Date(Date.UTC(Number(year), Number(fromMonth) - 1, days[0]!));
  const validUntil = new Date(Date.UTC(Number(year), Number(untilMonth) - 1, days[1]!) + 24 * 60 * 60 * 1_000);
  if (Number.isNaN(validFrom.getTime()) || Number.isNaN(validUntil.getTime()) || validUntil <= validFrom) return undefined;
  return { validFrom: validFrom.toISOString(), validUntil: validUntil.toISOString() };
}

export function createMenyFoundationDependencies(db: HandleplanDatabase, privateCaptureRoot: string): MenyFoundationDependencies {
  const reader = new PostgresSourceAccessReader(db);
  const sourceAccessPolicy: MenyFoundationDependencies["sourceAccessPolicy"] = {
    async getDecision(sourceId, capability, asOf, signal) {
      const access = await reader.getSourceAccess(sourceId, signal);
      if (access?.runtimeState !== "approved" || !access.permissionCurrent || !access.sourcePermissionCurrent || access.permissionDecision !== "approved" || access.permissions.officialOffers !== true) throw new Error("MENY_SOURCE_DISABLED");
      const rows = await db.$client<{
        id: number;
        reviewed_at_exact: string;
        valid_until_exact: string | null;
        permissions: Record<string, unknown>;
      }[]>`
        select
          permission.id,
          to_char(permission.reviewed_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as reviewed_at_exact,
          to_char(permission.valid_until at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as valid_until_exact,
          permission.permissions
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
      if (!row) throw new Error("MENY_SOURCE_DISABLED");
      const fence = officialOfferAuthorizationFenceV1Schema.parse({
        contractVersion: 1, permissionId: Number(row.id), sourceId, decision: "approved",
        capabilities: row.permissions.officialOfferCapabilities,
        rightsClassifications: row.permissions.officialOfferRightsClassifications,
        reviewedAt: row.reviewed_at_exact, evaluatedAt: asOf,
        ...(row.valid_until_exact ? { validUntil: row.valid_until_exact } : {}),
      });
      if (!fence.capabilities.includes(capability) || !fence.rightsClassifications.includes("public_display")) throw new Error("MENY_SOURCE_DISABLED");
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
        where publication.source_id = 'meny' and publication.external_id = ${externalEditionId}
        and capture.checksum = ${checksumSha256} and capture.rights_classification = 'public_display'
        and extraction.extractor_version = ${MENY_EXTRACTOR_VERSION} and extraction.status in ('completed', 'degraded')
        and extraction.completed_at is not null and extraction.empty_result = 'not-empty'
        and (extraction.counts ->> 'total')::integer > 0
        and (extraction.counts ->> 'persistedCandidates')::integer =
          (select count(*) from extracted_offer_candidates candidate where candidate.extraction_run_id = extraction.id)
        limit 1`;
      if (signal.aborted) throw new WorkerCancelledError();
      return rows[0]?.status;
    },
    async resolveEdition(viewerHtml, signal) {
      const settings = parseMenyStaticSettings(viewerHtml);
      if (!settings) throw new Error("MENY_VIEWER_UNREADABLE");
      const fence: OfficialOfferAuthorizationFenceV1 = officialOfferAuthorizationFenceV1Schema.parse(
        await sourceAccessPolicy.getDecision(MENY_SOURCE_ID, "discover", new Date().toISOString(), signal),
      );
      const externalEditionId = String(settings.paperId);
      const rows = await db.$client<{ title: string; content_kind: string; chain: string; geographic_scope_id: number; declared_geographic_scope: unknown; valid_from: Date; valid_until: Date; discovered_at: Date; edition_identity_sha256: string | null }[]>`
        select title, content_kind, chain, geographic_scope_id, declared_geographic_scope, valid_from, valid_until, discovered_at, edition_identity_sha256
        from publications where source_id = 'meny' and external_id = ${externalEditionId} limit 1`;
      const existing = rows[0];
      const validity = parseMenyValidityHeadline(settings.pageTexts[0] ?? "");
      if (!validity) throw new Error("MENY_VALIDITY_UNREADABLE");
      let scopeId: number;
      if (existing) {
        if (timestamp(existing.valid_from) !== validity.validFrom || timestamp(existing.valid_until) !== validity.validUntil) throw new Error("MENY_EDITION_CONFLICT");
        const scope = existing.declared_geographic_scope as { kind?: string; countryCode?: string };
        if (scope?.kind !== "national" || scope.countryCode !== "NO") throw new Error("MENY_EDITION_CONFLICT");
        scopeId = Number(existing.geographic_scope_id);
      } else {
        const scopes = await db.$client<{ id: number }[]>`select id from geographic_scopes where scope_kind = 'national' and country_code = 'NO' and status = 'active' limit 2`;
        if (scopes.length !== 1) throw new Error("MENY_REVIEWED_SCOPE_UNAVAILABLE");
        scopeId = Number(scopes[0]!.id);
      }
      if (signal.aborted) throw new WorkerCancelledError();
      const resolved = officialOfferEditionDiscoveryInputV1Schema.parse({
        contractVersion: 1, sourceId: MENY_SOURCE_ID, externalEditionId, chain: MENY_SOURCE_ID,
        title: settings.name, contentKind: "publication", geographicScopeId: scopeId,
        declaredGeographicScope: existing?.declared_geographic_scope ?? { kind: "national", countryCode: "NO" },
        validFrom: validity.validFrom, validUntil: validity.validUntil,
        discoveredAt: existing ? timestamp(existing.discovered_at) : new Date().toISOString(),
        authorization: { decision: "approved", capabilities: fence.capabilities, reviewedAt: fence.reviewedAt, ...(fence.validUntil ? { validUntil: fence.validUntil } : {}) },
      });
      if (existing && existing.edition_identity_sha256 !== editionIdentitySha256(resolved)) throw new Error("MENY_EDITION_CONFLICT");
      return resolved;
    },
  };
}
