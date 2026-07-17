import { createHash } from "node:crypto";

import {
  MAX_OFFICIAL_OFFER_CLOCK_SKEW_MS,
  MAX_OFFICIAL_OFFER_EXTRACTION_DURATION_MS,
  canonicalOfficialOfferEditionIdentity,
  geographicScopeSchema,
  officialOfferAuthorizationFenceV1Schema,
  officialOfferCaptureMetadataV1Schema,
  officialOfferEditionDiscoveryInputV1Schema,
  officialOfferExtractionEnvelopeV1Schema,
  officialOfferExtractionTimingV1Schema,
  officialOfferExtractionValidationContextV1Schema,
  validateOfficialOfferExtraction,
  type GeographicScope,
  type OfficialOfferAuthorizationCapability,
  type OfficialOfferAuthorizationFenceV1,
  type OfficialOfferCaptureMetadataV1,
  type OfficialOfferEditionDiscoveryInputV1,
  type OfficialOfferExtractionEnvelopeV1,
  type OfficialOfferExtractionTimingV1,
  type OfficialOfferExtractionValidationContext,
  type OfficialOfferExtractionValidation,
} from "@handleplan/domain";

import type { HandleplanDatabase } from "./client";
import { SOURCE_GOVERNANCE_ADVISORY_LOCK_SEED } from "./source-governance-lock";
import type postgres from "postgres";

type CancelableQuery<T> = PromiseLike<T> & { cancel(): void };
type OfficialOfferSqlClient = HandleplanDatabase["$client"];
type OfficialOfferTransaction = postgres.TransactionSql;

export const MAX_CURRENT_PUBLISHED_OFFERS = 500;

export type OfficialOfferFoundationErrorCode =
  | "CANCELLED"
  | "CAPTURE_CONFLICT"
  | "EDITION_CONFLICT"
  | "EXTRACTION_CONFLICT"
  | "FUTURE_AS_OF"
  | "RESULT_LIMIT_EXCEEDED"
  | "SOURCE_AUTHORIZATION_STALE";

export class OfficialOfferFoundationError extends Error {
  constructor(readonly code: OfficialOfferFoundationErrorCode) {
    super(`Official-offer foundation operation failed: ${code}`);
    this.name = "OfficialOfferFoundationError";
  }
}

export interface RecordedOfficialOfferEdition {
  created: boolean;
  id: number;
  status: "captured" | "discovered" | "expired" | "failed" | "published";
}

export interface RecordedOfficialOfferCapture {
  blobKey: string;
  created: boolean;
  id: number;
  retrievedAt: string;
}

export interface RecordedOfficialOfferExtraction {
  counts: OfficialOfferExtractionValidation["counts"];
  created: boolean;
  id: number;
  status: "completed" | "degraded" | "failed";
}

export interface CurrentPublishedOfficialOffer {
  amountOre: number;
  beforeAmountOre: number | null;
  capturedAt: Date;
  chain: "bunnpris" | "extra" | "rema-1000";
  channels: readonly ("in-store" | "online")[];
  contentKind: "publication" | "structured-feed";
  declaredGeographicScope: GeographicScope;
  evidenceLevel: "reviewed";
  externalEditionId: string;
  familySlug: string | null;
  geographicScopeId: number;
  id: number;
  matchConfidence: number;
  matchMethod: "deterministic_rule" | "exact_identifier" | "human_review";
  memberProgramId: string | null;
  membershipRequirement: "member" | "public";
  multibuyGroupAmountOre: number | null;
  multibuyQuantity: number | null;
  offerKey: string;
  productId: number | null;
  sourceRecordId: string;
  sourceId: string;
  validFrom: Date;
  validUntil: Date;
}

interface PublicationRow {
  chain: string;
  content_kind: string | null;
  declared_geographic_scope: unknown;
  discovered_at: Date;
  discovery_permission_id: unknown;
  edition_identity_sha256: string | null;
  external_id: string;
  geographic_scope_id: unknown;
  id: unknown;
  source_id: string;
  status: string;
  title: string;
  valid_from: Date;
  valid_until: Date;
}

interface CaptureRow {
  blob_key: string;
  byte_length: number;
  checksum: string;
  capture_permission_capabilities: unknown;
  capture_permission_id: unknown;
  id: unknown;
  mime_type: string;
  retrieved_at: Date;
  rights_classification: string;
}

interface PublicationIdentityRow {
  external_id: string;
  id: unknown;
  source_id: string;
}

interface ExtractionRow {
  completed_at: Date | null;
  counts: unknown;
  empty_confirmation: unknown;
  empty_confirmation_observed_at: Date | null;
  empty_result: string | null;
  error_class: string | null;
  extraction_method: string | null;
  extraction_permission_id: unknown;
  id: unknown;
  ocr_permission_id: unknown;
  permission_capabilities: unknown;
  source_completed_at: Date | null;
  source_started_at: Date | null;
  started_at: Date;
  status: string;
}

interface CaptureExtractionBindingRow extends PublicationRow {
  capture_permission_id: unknown;
  checksum: string;
  capture_retrieved_at: Date;
  database_clock: Date;
  rights_classification: string;
}

interface GeographicScopeRow {
  country_code: string;
  postal_codes: unknown;
  region_codes: unknown;
  scope_kind: string;
  status: string;
  store_ids: unknown;
}

interface AuthorizationRow {
  capabilities: unknown;
  database_clock: Date;
  id: unknown;
  rights_classifications: unknown;
}

interface PublishedOfferRow {
  amount_ore: unknown;
  before_amount_ore: unknown;
  capture_retrieved_at: Date;
  chain: string;
  content_kind: string;
  declared_geographic_scope: unknown;
  external_id: string;
  family_slug: string | null;
  geographic_scope_id: unknown;
  id: unknown;
  match_confidence: unknown;
  match_method: string;
  member_program_id: string | null;
  membership_requirement: string;
  multibuy_group_amount_ore: unknown;
  multibuy_quantity: unknown;
  offer_key: string;
  product_id: unknown;
  review_channels: unknown;
  source_reference: string;
  source_id: string;
  valid_from: Date;
  valid_until: Date;
}

function cancelledError(): OfficialOfferFoundationError {
  return new OfficialOfferFoundationError("CANCELLED");
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelledError();
}

async function awaitAbortable<T>(
  query: CancelableQuery<T>,
  signal?: AbortSignal,
): Promise<T> {
  throwIfCancelled(signal);
  const onAbort = () => query.cancel();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    return await query;
  } catch (error) {
    if (signal?.aborted) throw cancelledError();
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

function dateValue(value: unknown, label: string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new TypeError(`Invalid ${label} from PostgreSQL`);
  return date;
}

function sameDate(left: unknown, right: string): boolean {
  return dateValue(left, "timestamp").toISOString() === right;
}

function jsonKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(jsonKey).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${jsonKey(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function requirePositiveId(value: unknown, label: string): number {
  const numeric = typeof value === "string" && /^[1-9][0-9]*$/u.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(numeric) || Number(numeric) <= 0) {
    throw new TypeError(`PostgreSQL returned an invalid ${label}`);
  }
  return Number(numeric);
}

function requireOptionalPositiveId(value: unknown, label: string): number | null {
  return value === null ? null : requirePositiveId(value, label);
}

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`PostgreSQL returned an invalid ${label}`);
  }
  return Number(value);
}

function requireOptionalNonNegativeSafeInteger(
  value: unknown,
  label: string,
): number | null {
  return value === null ? null : requireNonNegativeSafeInteger(value, label);
}

function requireBoundedText(value: unknown, label: string, maxLength: number): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value.trim() !== value
    || value.length > maxLength
  ) {
    throw new TypeError(`PostgreSQL returned an invalid ${label}`);
  }
  return value;
}

function requireEnumValue<const T extends readonly string[]>(
  value: unknown,
  label: string,
  allowed: T,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new TypeError(`PostgreSQL returned an invalid ${label}`);
  }
  return value as T[number];
}

function requireBlobKey(value: unknown): asserts value is string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 1_024
    || value.startsWith("/")
    || value.includes("..")
    || !/^[A-Za-z0-9_./:-]+$/u.test(value)
  ) {
    throw new TypeError("blobKey must be a bounded relative private-storage key");
  }
}

function publicationStatus(value: unknown): RecordedOfficialOfferEdition["status"] {
  if (!["captured", "discovered", "expired", "failed", "published"].includes(String(value))) {
    throw new TypeError("PostgreSQL returned an invalid publication status");
  }
  return value as RecordedOfficialOfferEdition["status"];
}

function requireStringArray(
  value: unknown,
  label: string,
  maximum: number,
): readonly string[] {
  if (
    !Array.isArray(value)
    || value.length > maximum
    || value.some((entry) => typeof entry !== "string" || entry.trim() !== entry)
    || new Set(value).size !== value.length
  ) {
    throw new TypeError(`PostgreSQL returned invalid ${label}`);
  }
  return Object.freeze((value as string[]).slice().sort());
}

function requireOfferChannels(value: unknown): readonly ("in-store" | "online")[] {
  const channels = requireStringArray(value, "offer channels", 2);
  if (
    channels.length < 1
    || channels.some((channel) => channel !== "in-store" && channel !== "online")
  ) {
    throw new TypeError("PostgreSQL returned invalid offer channels");
  }
  return channels as readonly ("in-store" | "online")[];
}

function canonicalScope(scopeInput: unknown): GeographicScope {
  const scope = geographicScopeSchema.parse(scopeInput);
  switch (scope.kind) {
    case "regions":
      return { ...scope, regionCodes: [...scope.regionCodes].sort() };
    case "postal-set":
      return { ...scope, postalCodes: [...scope.postalCodes].sort() };
    case "stores":
      return { ...scope, storeIds: [...scope.storeIds].sort() };
    default:
      return scope;
  }
}

function scopeFromDatabase(row: GeographicScopeRow | undefined): GeographicScope {
  if (row === undefined || row.status !== "active") {
    throw new OfficialOfferFoundationError("EDITION_CONFLICT");
  }
  switch (row.scope_kind) {
    case "national":
      return geographicScopeSchema.parse({ kind: "national", countryCode: row.country_code });
    case "region":
      return geographicScopeSchema.parse({
        kind: "regions",
        countryCode: row.country_code,
        regionCodes: requireStringArray(row.region_codes, "scope regions", 100),
      });
    case "postal_set":
      return geographicScopeSchema.parse({
        kind: "postal-set",
        countryCode: row.country_code,
        postalCodes: requireStringArray(row.postal_codes, "scope postal codes", 10_000),
      });
    case "store_set":
      return geographicScopeSchema.parse({
        kind: "stores",
        storeIds: requireStringArray(row.store_ids, "scope stores", 1_000),
      });
    default:
      throw new OfficialOfferFoundationError("EDITION_CONFLICT");
  }
}

function sameScope(left: unknown, right: unknown): boolean {
  try {
    return jsonKey(canonicalScope(left)) === jsonKey(canonicalScope(right));
  } catch {
    return false;
  }
}

function editionIdentitySha256(edition: OfficialOfferEditionDiscoveryInputV1): string {
  return createHash("sha256")
    .update(canonicalOfficialOfferEditionIdentity(edition), "utf8")
    .digest("hex");
}

function extractionStatus(value: unknown): RecordedOfficialOfferExtraction["status"] {
  if (!["completed", "degraded", "failed"].includes(String(value))) {
    throw new TypeError("PostgreSQL returned an invalid extraction status");
  }
  return value as RecordedOfficialOfferExtraction["status"];
}

function exactEditionMatch(
  row: PublicationRow,
  edition: OfficialOfferEditionDiscoveryInputV1,
): boolean {
  return row.source_id === edition.sourceId
    && row.external_id === edition.externalEditionId
    && row.chain === edition.chain
    && row.title === edition.title
    && requirePositiveId(row.geographic_scope_id, "publication geographic scope id")
      === edition.geographicScopeId
    && sameDate(row.valid_from, edition.validFrom)
    && sameDate(row.valid_until, edition.validUntil)
    && sameDate(row.discovered_at, edition.discoveredAt)
    && row.content_kind === edition.contentKind
    && sameScope(row.declared_geographic_scope, edition.declaredGeographicScope)
    && row.edition_identity_sha256 === editionIdentitySha256(edition)
    && requirePositiveId(row.discovery_permission_id, "discovery permission id") > 0;
}

function exactCaptureMatch(
  row: CaptureRow,
  metadata: OfficialOfferCaptureMetadataV1,
  blobKey: string,
): boolean {
  return row.blob_key === blobKey
    && row.checksum === metadata.checksumSha256
    && row.mime_type === metadata.mimeType
    && row.byte_length === metadata.byteLength
    && row.rights_classification === metadata.rightsClassification
    && requirePositiveId(row.capture_permission_id, "capture permission id") > 0
    && requireStringArray(
      row.capture_permission_capabilities,
      "capture permission capabilities",
      4,
    ).includes("capture");
}

function validateExtractionTiming(
  envelope: OfficialOfferExtractionEnvelopeV1,
  timingInput: OfficialOfferExtractionTimingV1,
  captureRetrievedAtInput: unknown,
  databaseClockInput: unknown,
): OfficialOfferExtractionTimingV1 {
  const timing = officialOfferExtractionTimingV1Schema.parse(timingInput);
  const captureRetrievedAt = dateValue(captureRetrievedAtInput, "capture retrieval clock").getTime();
  const databaseClock = dateValue(databaseClockInput, "database clock").getTime();
  const serverStartedAt = Date.parse(timing.serverStartedAt);
  const serverCompletedAt = Date.parse(timing.serverCompletedAt);
  const sourceStartedAt = Date.parse(envelope.startedAt);
  const sourceCompletedAt = Date.parse(envelope.completedAt);
  if (
    serverStartedAt < captureRetrievedAt - MAX_OFFICIAL_OFFER_CLOCK_SKEW_MS
    || serverCompletedAt > databaseClock + MAX_OFFICIAL_OFFER_CLOCK_SKEW_MS
    || databaseClock - serverStartedAt
      > MAX_OFFICIAL_OFFER_EXTRACTION_DURATION_MS + MAX_OFFICIAL_OFFER_CLOCK_SKEW_MS
    || sourceStartedAt < captureRetrievedAt - MAX_OFFICIAL_OFFER_CLOCK_SKEW_MS
    || sourceStartedAt < serverStartedAt - MAX_OFFICIAL_OFFER_CLOCK_SKEW_MS
    || sourceCompletedAt > serverCompletedAt + MAX_OFFICIAL_OFFER_CLOCK_SKEW_MS
    || sourceCompletedAt - sourceStartedAt > MAX_OFFICIAL_OFFER_EXTRACTION_DURATION_MS
  ) {
    throw new OfficialOfferFoundationError("EXTRACTION_CONFLICT");
  }
  return timing;
}

function extractionCounts(
  envelope: OfficialOfferExtractionEnvelopeV1,
  validation: OfficialOfferExtractionValidation,
  persistedCandidates: number,
): Record<string, number | string> {
  return {
    envelopeSha256: createHash("sha256").update(jsonKey(envelope), "utf8").digest("hex"),
    exactMatch: validation.counts.exactMatch,
    persistedCandidates,
    rejected: validation.counts.rejected,
    reviewRequired: validation.counts.reviewRequired,
    total: validation.counts.total,
    validationSha256: createHash("sha256").update(jsonKey(validation), "utf8").digest("hex"),
  };
}

function canonicalCapabilities(
  capabilities: readonly OfficialOfferAuthorizationCapability[],
): readonly OfficialOfferAuthorizationCapability[] {
  return Object.freeze([...capabilities].sort());
}

function assertEditionAuthorizationFence(
  edition: OfficialOfferEditionDiscoveryInputV1,
  authorization: OfficialOfferAuthorizationFenceV1,
): void {
  if (
    authorization.sourceId !== edition.sourceId
    || jsonKey(canonicalCapabilities(authorization.capabilities))
      !== jsonKey(canonicalCapabilities(edition.authorization.capabilities))
    || authorization.reviewedAt !== edition.authorization.reviewedAt
    || authorization.validUntil !== edition.authorization.validUntil
  ) {
    throw new OfficialOfferFoundationError("SOURCE_AUTHORIZATION_STALE");
  }
}

async function lockSourceGovernance(
  transaction: OfficialOfferTransaction,
  sourceId: string,
  signal?: AbortSignal,
): Promise<void> {
  await awaitAbortable(transaction`
    select pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        ${sourceId},
        ${SOURCE_GOVERNANCE_ADVISORY_LOCK_SEED}
      )
    )
  `, signal);
}

async function requireCurrentAuthorization(
  transaction: OfficialOfferTransaction,
  authorizationInput: OfficialOfferAuthorizationFenceV1,
  requiredCapability: OfficialOfferAuthorizationCapability,
  rightsClassification?: OfficialOfferCaptureMetadataV1["rightsClassification"],
  signal?: AbortSignal,
): Promise<AuthorizationRow> {
  const authorization = officialOfferAuthorizationFenceV1Schema.parse(authorizationInput);
  if (
    !authorization.capabilities.includes(requiredCapability)
    || (
      rightsClassification !== undefined
      && !authorization.rightsClassifications.includes(rightsClassification)
    )
  ) {
    throw new OfficialOfferFoundationError("SOURCE_AUTHORIZATION_STALE");
  }
  const validUntil = authorization.validUntil ?? null;
  const rows = await awaitAbortable(transaction<AuthorizationRow[]>`
    select
      permission.id,
      permission.permissions -> 'officialOfferCapabilities' as capabilities,
      permission.permissions -> 'officialOfferRightsClassifications' as rights_classifications,
      clock_timestamp() as database_clock
    from data_sources source
    inner join source_permissions permission
      on permission.id = (
        select current_permission.id
        from source_permissions current_permission
        where current_permission.source_id = source.id
          and current_permission.created_at <= clock_timestamp()
        order by current_permission.created_at desc, current_permission.id desc
        limit 1
      )
    where source.id = ${authorization.sourceId}
      and source.runtime_state = 'approved'
      and source.public_state_changed_at <= ${authorization.evaluatedAt}::timestamptz
      and source.permission_reviewed_at = permission.reviewed_at
      and source.permission_expires_at is not distinct from permission.valid_until
      and permission.id = ${authorization.permissionId}
      and permission.decision = 'approved'
      and permission.reviewed_at = ${authorization.reviewedAt}::timestamptz
      and permission.valid_until is not distinct from ${validUntil}::timestamptz
      and permission.created_at <= ${authorization.evaluatedAt}::timestamptz
      and permission.reviewed_at <= ${authorization.evaluatedAt}::timestamptz
      and (permission.valid_until is null or permission.valid_until > clock_timestamp())
      and ${authorization.evaluatedAt}::timestamptz
        between clock_timestamp() - (${MAX_OFFICIAL_OFFER_CLOCK_SKEW_MS} * interval '1 millisecond')
            and clock_timestamp() + (${MAX_OFFICIAL_OFFER_CLOCK_SKEW_MS} * interval '1 millisecond')
      and permission.permissions @> '{"officialOffers": true}'::jsonb
      and permission.permissions -> 'officialOfferCapabilities'
        = ${JSON.stringify(authorization.capabilities)}::jsonb
      and permission.permissions -> 'officialOfferRightsClassifications'
        = ${JSON.stringify(authorization.rightsClassifications)}::jsonb
    limit 1
  `, signal);
  const row = rows[0];
  if (
    row === undefined
    || requirePositiveId(row.id, "permission id") !== authorization.permissionId
    || jsonKey(requireStringArray(row.capabilities, "permission capabilities", 4))
      !== jsonKey(authorization.capabilities)
    || jsonKey(requireStringArray(
      row.rights_classifications,
      "permission rights classifications",
      3,
    )) !== jsonKey(authorization.rightsClassifications)
  ) {
    throw new OfficialOfferFoundationError("SOURCE_AUTHORIZATION_STALE");
  }
  return row;
}

async function requireStoredGeographicScope(
  transaction: OfficialOfferTransaction,
  scopeId: number,
  signal?: AbortSignal,
): Promise<GeographicScope> {
  const rows = await awaitAbortable(transaction<GeographicScopeRow[]>`
    select
      scope.scope_kind,
      scope.country_code,
      scope.status,
      coalesce((
        select array_agg(region.region_code order by region.region_code)
        from (
          select membership.region_code
          from geographic_scope_regions membership
          where membership.scope_id = scope.id
          order by membership.region_code
          limit 101
        ) region
      ), array[]::text[]) as region_codes,
      coalesce((
        select array_agg(postal.postal_code::text order by postal.postal_code)
        from (
          select membership.postal_code
          from geographic_scope_postal_codes membership
          where membership.scope_id = scope.id
          order by membership.postal_code
          limit 10001
        ) postal
      ), array[]::text[]) as postal_codes,
      coalesce((
        select array_agg(store.store_id::text order by store.store_id)
        from (
          select membership.store_id
          from geographic_scope_stores membership
          where membership.scope_id = scope.id
          order by membership.store_id
          limit 1001
        ) store
      ), array[]::text[]) as store_ids
    from geographic_scopes scope
    where scope.id = ${scopeId}
    limit 1
    for share of scope
  `, signal);
  return canonicalScope(scopeFromDatabase(rows[0]));
}

export class PostgresOfficialOfferFoundationRepository {
  constructor(private readonly db: HandleplanDatabase) {}

  async recordEdition(
    input: unknown,
    authorizationInput: unknown,
    signal?: AbortSignal,
  ): Promise<RecordedOfficialOfferEdition> {
    const edition = officialOfferEditionDiscoveryInputV1Schema.parse(input);
    const authorization = officialOfferAuthorizationFenceV1Schema.parse(authorizationInput);
    assertEditionAuthorizationFence(edition, authorization);
    throwIfCancelled(signal);
    return this.db.$client.begin(async (transaction) => {
      await lockSourceGovernance(transaction, edition.sourceId, signal);
      await requireCurrentAuthorization(transaction, authorization, "discover", undefined, signal);
      const storedScope = await requireStoredGeographicScope(
        transaction,
        edition.geographicScopeId,
        signal,
      );
      if (!sameScope(storedScope, edition.declaredGeographicScope)) {
        throw new OfficialOfferFoundationError("EDITION_CONFLICT");
      }
      const declaredScope = canonicalScope(edition.declaredGeographicScope);
      const identitySha256 = editionIdentitySha256(edition);
      const inserted = await awaitAbortable(transaction<PublicationRow[]>`
        insert into publications (
          source_id, external_id, chain, title, valid_from, valid_until,
          geographic_scope_id, status, discovered_at, content_kind,
          declared_geographic_scope, edition_identity_sha256,
          discovery_permission_id
        ) values (
          ${edition.sourceId}, ${edition.externalEditionId}, ${edition.chain},
          ${edition.title}, ${edition.validFrom}, ${edition.validUntil},
          ${edition.geographicScopeId}, 'discovered', ${edition.discoveredAt},
          ${edition.contentKind}, ${JSON.stringify(declaredScope)}::jsonb,
          ${identitySha256}, ${authorization.permissionId}
        )
        on conflict (source_id, external_id) do nothing
        returning id, source_id, external_id, chain, title, valid_from, valid_until,
                  geographic_scope_id, status, discovered_at, content_kind,
                  declared_geographic_scope, edition_identity_sha256,
                  discovery_permission_id
      `, signal);
      const created = inserted.length === 1;
      const rows = created ? inserted : await awaitAbortable(transaction<PublicationRow[]>`
        select id, source_id, external_id, chain, title, valid_from, valid_until,
               geographic_scope_id, status, discovered_at, content_kind,
               declared_geographic_scope, edition_identity_sha256,
               discovery_permission_id
        from publications
        where source_id = ${edition.sourceId}
          and external_id = ${edition.externalEditionId}
        limit 1
        for update
      `, signal);
      const row = rows[0];
      if (row === undefined || !exactEditionMatch(row, edition)) {
        throw new OfficialOfferFoundationError("EDITION_CONFLICT");
      }
      await requireCurrentAuthorization(transaction, authorization, "discover", undefined, signal);
      throwIfCancelled(signal);
      return Object.freeze({
        created,
        id: requirePositiveId(row.id, "publication id"),
        status: publicationStatus(row.status),
      });
    });
  }

  async recordCapture(
    input: unknown,
    blobKeyInput: unknown,
    authorizationInput: unknown,
    signal?: AbortSignal,
  ): Promise<RecordedOfficialOfferCapture> {
    const metadata = officialOfferCaptureMetadataV1Schema.parse(input);
    const authorization = officialOfferAuthorizationFenceV1Schema.parse(authorizationInput);
    if (authorization.sourceId !== metadata.sourceId) {
      throw new OfficialOfferFoundationError("SOURCE_AUTHORIZATION_STALE");
    }
    requireBlobKey(blobKeyInput);
    const blobKey = blobKeyInput;
    throwIfCancelled(signal);
    return this.db.$client.begin(async (transaction) => {
      await lockSourceGovernance(transaction, metadata.sourceId, signal);
      await requireCurrentAuthorization(
        transaction,
        authorization,
        "capture",
        metadata.rightsClassification,
        signal,
      );
      const [publication] = await awaitAbortable(transaction<PublicationIdentityRow[]>`
        select id, source_id, external_id
        from publications
        where id = ${metadata.publicationId}
        limit 1
        for update
      `, signal);
      if (
        publication === undefined
        || publication.source_id !== metadata.sourceId
        || publication.external_id !== metadata.externalEditionId
      ) {
        throw new OfficialOfferFoundationError("CAPTURE_CONFLICT");
      }
      const inserted = await awaitAbortable(transaction<CaptureRow[]>`
        insert into publication_captures (
          publication_id, blob_key, checksum, mime_type, byte_length,
          rights_classification, retrieved_at, capture_permission_id,
          capture_permission_capabilities
        ) values (
          ${metadata.publicationId}, ${blobKey}, ${metadata.checksumSha256},
          ${metadata.mimeType}, ${metadata.byteLength},
          ${metadata.rightsClassification}, clock_timestamp(),
          ${authorization.permissionId}, ${JSON.stringify(authorization.capabilities)}::jsonb
        )
        on conflict (publication_id, checksum) do nothing
        returning id, blob_key, checksum, mime_type, byte_length,
                  rights_classification, retrieved_at, capture_permission_id,
                  capture_permission_capabilities
      `, signal);
      const created = inserted.length === 1;
      const rows = created ? inserted : await awaitAbortable(transaction<CaptureRow[]>`
        select id, blob_key, checksum, mime_type, byte_length,
               rights_classification, retrieved_at, capture_permission_id,
               capture_permission_capabilities
        from publication_captures
        where publication_id = ${metadata.publicationId}
          and checksum = ${metadata.checksumSha256}
        limit 1
      `, signal);
      const row = rows[0];
      if (row === undefined || !exactCaptureMatch(row, metadata, blobKey)) {
        throw new OfficialOfferFoundationError("CAPTURE_CONFLICT");
      }
      await awaitAbortable(transaction`
        update publications
        set status = case when status = 'discovered' then 'captured' else status end,
            updated_at = clock_timestamp()
        where id = ${metadata.publicationId}
      `, signal);
      await requireCurrentAuthorization(
        transaction,
        authorization,
        "capture",
        metadata.rightsClassification,
        signal,
      );
      throwIfCancelled(signal);
      return Object.freeze({
        blobKey,
        created,
        id: requirePositiveId(row.id, "capture id"),
        retrievedAt: dateValue(row.retrieved_at, "capture retrieval clock").toISOString(),
      });
    });
  }

  async recordExtraction(
    captureIdInput: unknown,
    envelopeInput: unknown,
    editionInput: unknown,
    validationContextInput: unknown,
    timingInput: unknown,
    authorizationInput: unknown,
    ocrAuthorizationInput?: unknown,
    signal?: AbortSignal,
  ): Promise<RecordedOfficialOfferExtraction> {
    const captureId = requirePositiveId(captureIdInput, "capture id");
    const envelope = officialOfferExtractionEnvelopeV1Schema.parse(envelopeInput);
    const edition = officialOfferEditionDiscoveryInputV1Schema.parse(editionInput);
    const validationContext = officialOfferExtractionValidationContextV1Schema.parse(
      validationContextInput,
    );
    const timing = officialOfferExtractionTimingV1Schema.parse(timingInput);
    const authorization = officialOfferAuthorizationFenceV1Schema.parse(authorizationInput);
    const ocrAuthorization = ocrAuthorizationInput === undefined
      ? undefined
      : officialOfferAuthorizationFenceV1Schema.parse(ocrAuthorizationInput);
    assertEditionAuthorizationFence(edition, authorization);
    if ((envelope.method === "ocr") !== (ocrAuthorization !== undefined)) {
      throw new OfficialOfferFoundationError("SOURCE_AUTHORIZATION_STALE");
    }
    throwIfCancelled(signal);
    return this.db.$client.begin(async (transaction) => {
      await lockSourceGovernance(transaction, edition.sourceId, signal);
      await requireCurrentAuthorization(
        transaction,
        authorization,
        "extract",
        undefined,
        signal,
      );
      if (ocrAuthorization !== undefined) {
        await requireCurrentAuthorization(
          transaction,
          ocrAuthorization,
          "ocr",
          undefined,
          signal,
        );
      }
      const [capture] = await awaitAbortable(transaction<CaptureExtractionBindingRow[]>`
        select
          capture.checksum, capture.retrieved_at as capture_retrieved_at,
          capture.capture_permission_id, capture.rights_classification,
          clock_timestamp() as database_clock,
          publication.id, publication.source_id, publication.chain,
          publication.external_id, publication.title,
          publication.valid_from, publication.valid_until,
          publication.geographic_scope_id, publication.status,
          publication.discovered_at, publication.content_kind,
          publication.declared_geographic_scope,
          publication.edition_identity_sha256,
          publication.discovery_permission_id
        from publication_captures capture
        inner join publications publication on publication.id = capture.publication_id
        where capture.id = ${captureId}
        limit 1
        for update
      `, signal);
      if (
        capture?.checksum !== envelope.captureChecksumSha256
        || capture?.external_id !== edition.externalEditionId
        || !exactEditionMatch(capture, edition)
        || requirePositiveId(capture.capture_permission_id, "capture permission id") <= 0
      ) {
        throw new OfficialOfferFoundationError("EXTRACTION_CONFLICT");
      }
      validateExtractionTiming(
        envelope,
        timing,
        capture.capture_retrieved_at,
        capture.database_clock,
      );
      const storedEdition = officialOfferEditionDiscoveryInputV1Schema.parse({
        contractVersion: 1,
        sourceId: capture.source_id,
        externalEditionId: capture.external_id,
        chain: capture.chain,
        title: capture.title,
        contentKind: capture.content_kind,
        geographicScopeId: requirePositiveId(
          capture.geographic_scope_id,
          "publication geographic scope id",
        ),
        declaredGeographicScope: canonicalScope(capture.declared_geographic_scope),
        validFrom: dateValue(capture.valid_from, "publication start").toISOString(),
        validUntil: dateValue(capture.valid_until, "publication end").toISOString(),
        discoveredAt: dateValue(capture.discovered_at, "publication discovery").toISOString(),
        authorization: {
          decision: "approved",
          capabilities: authorization.capabilities,
          reviewedAt: authorization.reviewedAt,
          ...(authorization.validUntil === undefined
            ? {}
            : { validUntil: authorization.validUntil }),
        },
      });
      const validation = validateOfficialOfferExtraction(
        envelope,
        storedEdition,
        validationContext,
      );
      const uniqueCandidates = [...new Map(
        validation.candidates.map((candidate) => [candidate.candidate.candidateKey, candidate]),
      ).values()];
      const counts = extractionCounts(envelope, validation, uniqueCandidates.length);
      const inserted = await awaitAbortable(transaction<ExtractionRow[]>`
        insert into extraction_runs (
          capture_id, extractor_version, status, started_at, completed_at,
          counts, error_class, extraction_method, extraction_permission_id,
          ocr_permission_id, permission_capabilities,
          source_started_at, source_completed_at, empty_result,
          empty_confirmation, empty_confirmation_observed_at
        ) values (
          ${captureId}, ${envelope.extractorVersion}, ${validation.status},
          ${timing.serverStartedAt}, clock_timestamp(),
          ${JSON.stringify(counts)}::jsonb, ${validation.errorClass ?? null},
          ${envelope.method}, ${authorization.permissionId},
          ${ocrAuthorization?.permissionId ?? null},
          ${JSON.stringify(authorization.capabilities)}::jsonb,
          ${envelope.startedAt}, ${envelope.completedAt}, ${envelope.emptyResult},
          ${envelope.emptyConfirmation === undefined
            ? null
            : JSON.stringify(envelope.emptyConfirmation)}::jsonb, null
        )
        on conflict (capture_id, extractor_version) do nothing
        returning id, status, started_at, completed_at, counts, error_class,
                  extraction_method, extraction_permission_id, ocr_permission_id,
                  permission_capabilities, source_started_at, source_completed_at,
                  empty_result, empty_confirmation, empty_confirmation_observed_at
      `, signal);
      const created = inserted.length === 1;
      const rows = created ? inserted : await awaitAbortable(transaction<ExtractionRow[]>`
        select id, status, started_at, completed_at, counts, error_class,
               extraction_method, extraction_permission_id, ocr_permission_id,
               permission_capabilities, source_started_at, source_completed_at,
               empty_result, empty_confirmation, empty_confirmation_observed_at
        from extraction_runs
        where capture_id = ${captureId}
          and extractor_version = ${envelope.extractorVersion}
        limit 1
        for update
      `, signal);
      const row = rows[0];
      if (
        row === undefined
        || row.status !== validation.status
        || row.completed_at === null
        || dateValue(row.completed_at, "extraction completion")
          < dateValue(row.started_at, "extraction start")
        || row.error_class !== (validation.errorClass ?? null)
        || jsonKey(row.counts) !== jsonKey(counts)
        || row.extraction_method !== envelope.method
        || requirePositiveId(row.extraction_permission_id, "extraction permission id") <= 0
        || !requireStringArray(
          row.permission_capabilities,
          "extraction permission capabilities",
          4,
        ).includes("extract")
        || row.source_started_at === null
        || !sameDate(row.source_started_at, envelope.startedAt)
        || row.source_completed_at === null
        || !sameDate(row.source_completed_at, envelope.completedAt)
        || row.empty_result !== envelope.emptyResult
        || jsonKey(row.empty_confirmation) !== jsonKey(envelope.emptyConfirmation ?? null)
        || (envelope.emptyResult === "confirmed-empty")
          !== (row.empty_confirmation_observed_at !== null)
        || (
          row.empty_confirmation_observed_at !== null
          && dateValue(
            row.empty_confirmation_observed_at,
            "empty confirmation observation",
          ).getTime() !== dateValue(row.completed_at, "extraction completion").getTime()
        )
        || (envelope.method === "ocr")
          !== (requireOptionalPositiveId(row.ocr_permission_id, "OCR permission id") !== null)
        || (created && !sameDate(row.started_at, timing.serverStartedAt))
      ) {
        throw new OfficialOfferFoundationError("EXTRACTION_CONFLICT");
      }

      if (created) {
        const extractionId = requirePositiveId(row.id, "extraction id");
        for (const candidate of uniqueCandidates) {
          await awaitAbortable(transaction`
            insert into extracted_offer_candidates (
              extraction_run_id, candidate_key, normalized_fields,
              confidence, status, anomaly_codes
            ) values (
              ${extractionId}, ${candidate.candidate.candidateKey},
              ${JSON.stringify(candidate)}::jsonb,
              ${candidate.candidate.provenance.confidence},
              ${candidate.publicationRoute === "human-review-required" ? "pending" : "rejected"},
              ${JSON.stringify(candidate.anomalyCodes)}::jsonb
            )
          `, signal);
        }
      }
      await requireCurrentAuthorization(
        transaction,
        authorization,
        "extract",
        capture.rights_classification as OfficialOfferCaptureMetadataV1["rightsClassification"],
        signal,
      );
      if (ocrAuthorization !== undefined) {
        await requireCurrentAuthorization(
          transaction,
          ocrAuthorization,
          "ocr",
          capture.rights_classification as OfficialOfferCaptureMetadataV1["rightsClassification"],
          signal,
        );
      }
      throwIfCancelled(signal);
      return Object.freeze({
        counts: validation.counts,
        created,
        id: requirePositiveId(row.id, "extraction id"),
        status: extractionStatus(row.status),
      });
    });
  }

  async readCurrentPublishedOffers(
    asOfInput: unknown,
    signal?: AbortSignal,
  ): Promise<readonly CurrentPublishedOfficialOffer[]> {
    const asOf = dateValue(asOfInput, "offer eligibility clock");
    const databaseClocks = await awaitAbortable(this.db.$client<Array<{ database_clock: Date }>>`
      select clock_timestamp() as database_clock
    `, signal);
    const databaseClock = databaseClocks[0]?.database_clock;
    if (databaseClock === undefined || asOf > dateValue(databaseClock, "database clock")) {
      throw new OfficialOfferFoundationError("FUTURE_AS_OF");
    }
    const rows = await awaitAbortable(this.db.$client<PublishedOfferRow[]>`
      select
        offer.id, offer.offer_key, offer.source_id, offer.chain,
        offer.source_reference,
        offer.geographic_scope_id, offer.amount_ore, offer.before_amount_ore,
        offer.multibuy_quantity, offer.multibuy_group_amount_ore,
        offer.membership_requirement, offer.valid_from, offer.valid_until,
        target.product_id, target.family_slug, target.match_method,
        target.match_confidence,
        capture.retrieved_at as capture_retrieved_at,
        publication.external_id, publication.content_kind,
        publication.declared_geographic_scope,
        review.new_values #> '{decision,channels}' as review_channels,
        review.new_values #>> '{decision,eligibility,programId}' as member_program_id
      from approved_offers offer
      inner join offer_targets target on target.offer_id = offer.id
      inner join extracted_offer_candidates candidate on candidate.id = offer.candidate_id
      inner join extraction_runs extraction on extraction.id = candidate.extraction_run_id
      inner join publication_captures capture on capture.id = extraction.capture_id
      inner join publications publication on publication.id = capture.publication_id
      inner join data_sources source on source.id = offer.source_id
      inner join geographic_scopes scope on scope.id = offer.geographic_scope_id
      inner join lateral (
        select current_review.*
        from review_actions current_review
        where current_review.candidate_id = candidate.id
          and current_review.created_at <= clock_timestamp()
        order by current_review.created_at desc,
                 current_review.id desc,
                 current_review.expected_version desc
        limit 1
      ) review on true
      where offer.status = 'published'
        and offer.valid_from <= ${asOf}
        and offer.valid_until > ${asOf}
        and offer.created_at <= ${asOf}
        and offer.approved_at <= ${asOf}
        and offer.updated_at <= ${asOf}
        and target.created_at <= ${asOf}
        and candidate.created_at <= ${asOf}
        and extraction.created_at <= ${asOf}
        and capture.created_at <= ${asOf}
        and capture.retrieved_at <= ${asOf}
        and publication.created_at <= ${asOf}
        and publication.source_id = offer.source_id
        and publication.chain = offer.chain
        and publication.geographic_scope_id = offer.geographic_scope_id
        and publication.content_kind is not null
        and publication.declared_geographic_scope is not null
        and publication.edition_identity_sha256 is not null
        and publication.discovery_permission_id is not null
        and capture.capture_permission_id is not null
        and capture.capture_permission_capabilities ? 'capture'
        and capture.rights_classification = 'public_display'
        and extraction.status in ('completed', 'degraded')
        and extraction.completed_at is not null
        and extraction.completed_at <= ${asOf}
        and extraction.extraction_method is not null
        and extraction.extraction_permission_id is not null
        and extraction.permission_capabilities ? 'extract'
        and (extraction.extraction_method <> 'ocr' or extraction.ocr_permission_id is not null)
        and source.runtime_state = 'approved'
        and source.public_state_changed_at <= ${asOf}
        and source.permission_reviewed_at is not null
        and source.permission_reviewed_at <= ${asOf}
        and (source.permission_expires_at is null or source.permission_expires_at > ${asOf})
        and scope.status = 'active'
        and scope.public_state_changed_at <= ${asOf}
        and review.candidate_id = candidate.id
        and review.offer_id = offer.id
        and review.action in ('approve', 'correct_and_approve')
        and review.expected_version = offer.version - 1
        and review.created_at <= ${asOf}
        and review.acted_at <= ${asOf}
        and exists (
          select 1
          from source_permissions permission
          where permission.id = (
            select current_permission.id
            from source_permissions current_permission
            where current_permission.source_id = offer.source_id
              and current_permission.created_at <= clock_timestamp()
            order by current_permission.created_at desc, current_permission.id desc
            limit 1
          )
            and permission.decision = 'approved'
            and permission.created_at <= ${asOf}
            and permission.reviewed_at <= ${asOf}
            and (permission.valid_until is null or permission.valid_until > ${asOf})
            and (permission.valid_until is null or permission.valid_until > clock_timestamp())
            and source.permission_reviewed_at = permission.reviewed_at
            and source.permission_expires_at is not distinct from permission.valid_until
            and permission.permissions @> '{"officialOffers": true, "publicDisplay": true}'::jsonb
            and permission.permissions -> 'officialOfferCapabilities' in (
              '["capture", "discover", "extract"]'::jsonb,
              '["capture", "discover", "extract", "ocr"]'::jsonb
            )
            and permission.permissions -> 'officialOfferRightsClassifications' in (
              '["public_display"]'::jsonb,
              '["extract_only", "public_display"]'::jsonb,
              '["private_review", "public_display"]'::jsonb,
              '["extract_only", "private_review", "public_display"]'::jsonb
            )
        )
      order by offer.valid_until, offer.offer_key, offer.id
      limit ${MAX_CURRENT_PUBLISHED_OFFERS + 1}
    `, signal);
    if (rows.length > MAX_CURRENT_PUBLISHED_OFFERS) {
      throw new OfficialOfferFoundationError("RESULT_LIMIT_EXCEEDED");
    }
    return Object.freeze(rows.map((row) => {
      const amountOre = requireNonNegativeSafeInteger(row.amount_ore, "offer amount");
      const beforeAmountOre = requireOptionalNonNegativeSafeInteger(
        row.before_amount_ore,
        "before amount",
      );
      const multibuyQuantity = requireOptionalNonNegativeSafeInteger(
        row.multibuy_quantity,
        "multibuy quantity",
      );
      const multibuyGroupAmountOre = requireOptionalNonNegativeSafeInteger(
        row.multibuy_group_amount_ore,
        "multibuy group amount",
      );
      if ((multibuyQuantity === null) !== (multibuyGroupAmountOre === null)) {
        throw new TypeError("PostgreSQL returned incomplete multibuy pricing");
      }
      if (multibuyQuantity !== null && multibuyQuantity < 2) {
        throw new TypeError("PostgreSQL returned an invalid multibuy quantity");
      }
      if (beforeAmountOre !== null && beforeAmountOre < amountOre) {
        throw new TypeError("PostgreSQL returned a before amount below the offer amount");
      }
      const membershipRequirement = requireEnumValue(
        row.membership_requirement,
        "membership",
        ["member", "public"] as const,
      );
      const memberProgramId = row.member_program_id === null
        ? null
        : requireBoundedText(row.member_program_id, "member program id", 160);
      if ((membershipRequirement === "member") !== (memberProgramId !== null)) {
        throw new TypeError("PostgreSQL returned an invalid membership decision");
      }
      const productId = requireOptionalPositiveId(row.product_id, "product id");
      const familySlug = row.family_slug === null
        ? null
        : requireBoundedText(row.family_slug, "family slug", 80);
      if ((productId === null) === (familySlug === null)) {
        throw new TypeError("PostgreSQL returned an invalid offer target");
      }
      const validFrom = dateValue(row.valid_from, "offer start");
      const validUntil = dateValue(row.valid_until, "offer end");
      if (!(validFrom <= asOf && asOf < validUntil)) {
        throw new TypeError("PostgreSQL returned an offer outside the requested eligibility clock");
      }
      const capturedAt = dateValue(row.capture_retrieved_at, "capture retrieval clock");
      if (capturedAt > asOf) {
        throw new TypeError("PostgreSQL returned a future offer capture");
      }
      const matchConfidence = requireNonNegativeSafeInteger(
        row.match_confidence,
        "match confidence",
      );
      if (matchConfidence > 100) {
        throw new TypeError("PostgreSQL returned an invalid match confidence");
      }
      const sourceReference = requireBoundedText(
        row.source_reference,
        "source record reference",
        1_024,
      );
      return Object.freeze({
        amountOre,
        beforeAmountOre,
        capturedAt,
        chain: requireEnumValue(row.chain, "chain", ["bunnpris", "extra", "rema-1000"] as const),
        channels: requireOfferChannels(row.review_channels),
        contentKind: requireEnumValue(row.content_kind, "content kind", [
          "publication",
          "structured-feed",
        ] as const),
        declaredGeographicScope: canonicalScope(row.declared_geographic_scope),
        evidenceLevel: "reviewed" as const,
        externalEditionId: requireBoundedText(row.external_id, "external edition id", 160),
        familySlug,
        geographicScopeId: requirePositiveId(row.geographic_scope_id, "geographic scope id"),
        id: requirePositiveId(row.id, "offer id"),
        matchConfidence,
        matchMethod: requireEnumValue(row.match_method, "match method", [
          "deterministic_rule",
          "exact_identifier",
          "human_review",
        ] as const),
        memberProgramId,
        membershipRequirement,
        multibuyGroupAmountOre,
        multibuyQuantity,
        offerKey: requireBoundedText(row.offer_key, "offer key", 255),
        productId,
        sourceRecordId: `official-source-record:${createHash("sha256")
          .update(sourceReference, "utf8")
          .digest("hex")}`,
        sourceId: requireBoundedText(row.source_id, "source id", 64),
        validFrom,
        validUntil,
      });
    }));
  }
}

export type {
  OfficialOfferCaptureMetadataV1,
  OfficialOfferEditionDiscoveryInputV1,
  OfficialOfferExtractionEnvelopeV1,
  OfficialOfferExtractionValidationContext,
};
