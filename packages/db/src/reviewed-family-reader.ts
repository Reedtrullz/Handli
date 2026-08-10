import {
  EXACT_PRODUCT_CATALOG_MAX_AGE_MS,
  familyIdentifierSchema,
  familyTaxonomyVersionSchema,
  isFiniteDate,
  reviewedFamilyDescriptorSchema,
  type ExactProductPlanApiProductSummary,
} from "@handleplan/domain";

import {
  catalogSummaryFromRow,
  classifyCatalogRow,
  normalizeCatalogEligibilityRow,
  type CatalogEligibilityRow,
} from "./catalog-reader";
import type { HandleplanDatabase } from "./client";

const TAXONOMY_ID = "handleplan-reviewed-families";
const MAX_FAMILIES = 20;
const MAX_PRODUCTS_PER_FAMILY = 20;

export type ReviewedFamilyReaderErrorCode =
  | "CANCELLED"
  | "INVALID_REQUEST"
  | "UNAVAILABLE";

const errorMessages: Readonly<Record<ReviewedFamilyReaderErrorCode, string>> = {
  CANCELLED: "Reviewed family request cancelled",
  INVALID_REQUEST: "Reviewed family request is invalid",
  UNAVAILABLE: "Reviewed family evidence is unavailable",
};

export class ReviewedFamilyReaderError extends Error {
  readonly code: ReviewedFamilyReaderErrorCode;

  constructor(code: ReviewedFamilyReaderErrorCode) {
    super(errorMessages[code]);
    this.name = "ReviewedFamilyReaderError";
    this.code = code;
  }
}

export interface ReviewedFamilyTaxonomyEvidence {
  contentSha256: string;
  contractVersion: 1;
  publishedAt: string;
  taxonomyId: typeof TAXONOMY_ID;
  taxonomyVersion: string;
  versionId: string;
}

export interface ReviewedFamilyDescriptorEvidence {
  aliases: string[];
  id: string;
  labelNo: string;
  parentId?: string;
  slug: string;
  status: "active";
}

export type ReviewedFamilyMembershipEvidence =
  | {
      confidence: 100;
      decision: "approved";
      decisionId: string;
      method: "human-review";
      reviewedAt: string;
      reviewerAttested: true;
    }
  | {
      confidence: 100;
      decision: "approved";
      decisionId: string;
      method: "deterministic-rule";
      reviewedAt: string;
      ruleVersion: string;
    };

export interface ReviewedFamilyCatalogMatch {
  canonicalProductId: string;
  family: ReviewedFamilyDescriptorEvidence;
  membership: ReviewedFamilyMembershipEvidence;
  product: ExactProductPlanApiProductSummary;
  taxonomy: ReviewedFamilyTaxonomyEvidence;
}

export interface ReviewedFamilyReader {
  getSnapshots(
    familyIds: readonly string[],
    productsPerFamily: number,
    at: Date,
    signal?: AbortSignal,
  ): Promise<ReviewedFamilySnapshot[]>;
  getMany(
    familyIds: readonly string[],
    productsPerFamily: number,
    at: Date,
    signal?: AbortSignal,
  ): Promise<ReviewedFamilyCatalogMatch[]>;
}

export type ReviewedFamilySnapshot =
  | {
      complete: false;
      familyId: string;
      matches: [];
      state: "unknown";
    }
  | {
      complete: true;
      family: ReviewedFamilyDescriptorEvidence;
      familyId: string;
      matches: ReviewedFamilyCatalogMatch[];
      state: "active";
      taxonomy: ReviewedFamilyTaxonomyEvidence;
    };

export interface ReviewedFamilyEligibilityRow extends CatalogEligibilityRow {
  aliases: string[];
  content_sha256: string;
  contract_version: number;
  decision: string;
  decision_id: string;
  decision_method: string;
  family_id: string;
  family_status: string;
  label_no: string;
  parent_family_id: string | null;
  product_rank: number;
  published_at: Date;
  reviewed_at: Date;
  reviewer_attested: boolean;
  rule_version: string | null;
  slug: string;
  taxonomy_id: string;
  taxonomy_version: string;
  version_id: string;
}

interface ReviewedFamilySnapshotQueryRow {
  aliases: string[];
  content_sha256: string;
  contract_version: number;
  family_id: string;
  family_status: string;
  label_no: string;
  match_rows: unknown[];
  parent_family_id: string | null;
  published_at: Date;
  requested_order: number;
  slug: string;
  taxonomy_id: string;
  taxonomy_version: string;
  version_id: string;
}

type CancelableQuery<T> = PromiseLike<T> & { cancel(): void };

const reviewedFamilyTimestampFields = [
  "published_at",
  "reviewed_at",
] as const satisfies readonly (keyof ReviewedFamilyEligibilityRow)[];

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFamilyId(value: unknown): value is string {
  return familyIdentifierSchema.safeParse(value).success;
}

function requestIsValid(
  familyIds: readonly string[],
  productsPerFamily: number,
  at: Date,
): boolean {
  if (!Array.isArray(familyIds) || !(at instanceof Date) || !isFiniteDate(at)) {
    return false;
  }
  const values = [...familyIds];
  return values.length >= 1
    && values.length <= MAX_FAMILIES
    && values.every(isFamilyId)
    && new Set(values).size === values.length
    && Number.isSafeInteger(productsPerFamily)
    && productsPerFamily >= 1
    && productsPerFamily <= MAX_PRODUCTS_PER_FAMILY;
}

export function normalizeReviewedFamilyEligibilityRow(row: unknown): unknown {
  const catalogNormalized = normalizeCatalogEligibilityRow(row);
  if (!isRecord(catalogNormalized)) return catalogNormalized;
  const normalized = { ...catalogNormalized };
  for (const field of reviewedFamilyTimestampFields) {
    const value = normalized[field];
    if (typeof value !== "string") continue;
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) normalized[field] = parsed;
  }
  return normalized;
}

export function reviewedFamilyMatchFromRow(
  rawRow: unknown,
  requestedFamilyIds: ReadonlySet<string>,
  productsPerFamily: number,
  at: Date,
): ReviewedFamilyCatalogMatch | undefined {
  const normalized = normalizeReviewedFamilyEligibilityRow(rawRow);
  const catalogClassification = classifyCatalogRow(normalized, at);
  if (catalogClassification === "ineligible") return undefined;
  if (catalogClassification === "malformed" || !isRecord(normalized)) {
    throw new ReviewedFamilyReaderError("UNAVAILABLE");
  }

  const row = normalized as unknown as ReviewedFamilyEligibilityRow;
  const identity = reviewedFamilyIdentityFromRow(row, requestedFamilyIds, at);

  if (
    typeof row.decision_id !== "string"
    || !/^[1-9][0-9]{0,18}$/.test(row.decision_id)
    || row.decision !== "approved"
    || row.confidence !== 100
    || !(row.reviewed_at instanceof Date)
    || !isFiniteDate(row.reviewed_at)
    || row.reviewed_at.getTime() > at.getTime()
  ) {
    throw new ReviewedFamilyReaderError("UNAVAILABLE");
  }

  let membership: ReviewedFamilyMembershipEvidence;
  if (row.decision_method === "human_review") {
    if (
      row.reviewer_attested !== true
      || row.rule_version !== null
    ) {
      throw new ReviewedFamilyReaderError("UNAVAILABLE");
    }
    membership = {
      confidence: 100,
      decision: "approved",
      decisionId: `family-membership:${row.decision_id}`,
      method: "human-review",
      reviewedAt: row.reviewed_at.toISOString(),
      reviewerAttested: true,
    };
  } else if (row.decision_method === "deterministic_rule") {
    if (
      row.reviewer_attested !== false
      || typeof row.rule_version !== "string"
      || row.rule_version.trim().length === 0
    ) {
      throw new ReviewedFamilyReaderError("UNAVAILABLE");
    }
    membership = {
      confidence: 100,
      decision: "approved",
      decisionId: `family-membership:${row.decision_id}`,
      method: "deterministic-rule",
      reviewedAt: row.reviewed_at.toISOString(),
      ruleVersion: row.rule_version,
    };
  } else {
    throw new ReviewedFamilyReaderError("UNAVAILABLE");
  }

  if (
    typeof row.product_rank !== "number"
    || !Number.isSafeInteger(row.product_rank)
    || row.product_rank < 1
    || row.product_rank > productsPerFamily
  ) {
    throw new ReviewedFamilyReaderError("UNAVAILABLE");
  }

  return {
    canonicalProductId: `product:${row.canonical_product_id}`,
    family: identity.family,
    membership,
    product: catalogSummaryFromRow(row),
    taxonomy: identity.taxonomy,
  };
}

function reviewedFamilyIdentityFromRow(
  rawRow: unknown,
  requestedFamilyIds: ReadonlySet<string>,
  at: Date,
): {
  family: ReviewedFamilyDescriptorEvidence;
  taxonomy: ReviewedFamilyTaxonomyEvidence;
} {
  if (!isRecord(rawRow)) throw new ReviewedFamilyReaderError("UNAVAILABLE");
  const row = rawRow;
  const parsedTaxonomyVersion = familyTaxonomyVersionSchema.safeParse(
    row.taxonomy_version,
  );
  if (
    row.taxonomy_id !== TAXONOMY_ID
    || !parsedTaxonomyVersion.success
    || row.version_id !== `${TAXONOMY_ID}@${parsedTaxonomyVersion.data}`
    || row.contract_version !== 1
    || typeof row.content_sha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(row.content_sha256)
    || !(row.published_at instanceof Date)
    || !isFiniteDate(row.published_at)
    || row.published_at.getTime() > at.getTime()
  ) {
    throw new ReviewedFamilyReaderError("UNAVAILABLE");
  }

  const parsedFamily = reviewedFamilyDescriptorSchema.safeParse({
    aliases: row.aliases,
    id: row.family_id,
    labelNo: row.label_no,
    ...(row.parent_family_id === null ? {} : { parentId: row.parent_family_id }),
    slug: row.slug,
    status: row.family_status,
  });
  if (
    !parsedFamily.success
    || !requestedFamilyIds.has(parsedFamily.data.id)
    || parsedFamily.data.status !== "active"
    || parsedFamily.data.aliases.includes(parsedFamily.data.slug)
  ) {
    throw new ReviewedFamilyReaderError("UNAVAILABLE");
  }

  return {
    family: {
      aliases: [...parsedFamily.data.aliases].sort(compareText),
      id: parsedFamily.data.id,
      labelNo: parsedFamily.data.labelNo,
      ...(parsedFamily.data.parentId === undefined
        ? {}
        : { parentId: parsedFamily.data.parentId }),
      slug: parsedFamily.data.slug,
      status: "active",
    },
    taxonomy: {
      contentSha256: row.content_sha256,
      contractVersion: 1,
      publishedAt: row.published_at.toISOString(),
      taxonomyId: TAXONOMY_ID,
      taxonomyVersion: parsedTaxonomyVersion.data,
      versionId: `${TAXONOMY_ID}@${parsedTaxonomyVersion.data}`,
    },
  };
}

async function awaitAbortable<T>(
  query: CancelableQuery<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new ReviewedFamilyReaderError("CANCELLED");
  const onAbort = () => query.cancel();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    return await query;
  } catch (error) {
    if (signal?.aborted) throw new ReviewedFamilyReaderError("CANCELLED");
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export class PostgresReviewedFamilyReader implements ReviewedFamilyReader {
  constructor(private readonly db: HandleplanDatabase) {}

  async getMany(
    familyIds: readonly string[],
    productsPerFamily: number,
    at: Date,
    signal?: AbortSignal,
  ): Promise<ReviewedFamilyCatalogMatch[]> {
    const snapshots = await this.getSnapshots(
      familyIds,
      productsPerFamily,
      at,
      signal,
    );
    return snapshots.flatMap((snapshot) =>
      snapshot.state === "active" ? snapshot.matches : []);
  }

  async getSnapshots(
    familyIds: readonly string[],
    productsPerFamily: number,
    at: Date,
    signal?: AbortSignal,
  ): Promise<ReviewedFamilySnapshot[]> {
    if (signal?.aborted) throw new ReviewedFamilyReaderError("CANCELLED");
    if (!requestIsValid(familyIds, productsPerFamily, at)) {
      throw new ReviewedFamilyReaderError("INVALID_REQUEST");
    }

    const requested = [...familyIds];
    const requestedSet = new Set(requested);
    const atIso = at.toISOString();
    const freshnessStartsAtIso = new Date(
      at.getTime() - EXACT_PRODUCT_CATALOG_MAX_AGE_MS,
    ).toISOString();
    const scanLimitPerFamily = productsPerFamily + 1;
    const query = this.db.$client<ReviewedFamilySnapshotQueryRow[]>`
      with current_taxonomy as (
        select
          version.version_id,
          version.taxonomy_id,
          version.taxonomy_version,
          version.contract_version,
          version.published_at,
          version.content_sha256
        from family_taxonomy_versions version
        where version.taxonomy_id = ${TAXONOMY_ID}
          and version.published_at <= ${atIso}::timestamptz
          and version.created_at <= ${atIso}::timestamptz
        order by version.published_at desc, version.version_id desc
        limit 1
      ), requested_families as (
        select
          taxonomy.version_id,
          taxonomy.taxonomy_id,
          taxonomy.taxonomy_version,
          taxonomy.contract_version,
          taxonomy.published_at,
          taxonomy.content_sha256,
          family.family_id,
          family.slug,
          family.label_no,
          family.parent_family_id,
          family.status as family_status,
          coalesce(aliases.aliases, array[]::text[]) as aliases,
          requested.requested_order::integer as requested_order
        from current_taxonomy taxonomy
        cross join lateral jsonb_array_elements_text(
          ${JSON.stringify(requested)}::jsonb
        ) with ordinality requested(family_id, requested_order)
        inner join reviewed_family_definitions family
          on family.version_id = taxonomy.version_id
         and family.family_id = requested.family_id
         and family.status = 'active'
         and family.created_at <= ${atIso}::timestamptz
        left join lateral (
          select array_agg(alias.alias order by alias.alias asc) as aliases
          from reviewed_family_aliases alias
          where alias.version_id = family.version_id
            and alias.family_id = family.family_id
            and alias.created_at <= ${atIso}::timestamptz
        ) aliases on true
      ), ranked_decisions as (
        select
          family.*,
          decision.id::text as decision_id,
          decision.product_id,
          decision.decision,
          decision.method as decision_method,
          decision.confidence,
          decision.reviewer_attested,
          decision.reviewed_at,
          decision.rule_version,
          row_number() over (
            partition by decision.version_id, decision.family_id, decision.product_id
            order by decision.reviewed_at desc, decision.id desc
          ) as decision_rank
        from requested_families family
        inner join reviewed_family_membership_public decision
          on decision.version_id = family.version_id
         and decision.family_id = family.family_id
         and decision.reviewed_at <= ${atIso}::timestamptz
         and decision.created_at <= ${atIso}::timestamptz
      ), approved_memberships as (
        select *
        from ranked_decisions
        where decision_rank = 1
          and decision = 'approved'
          and confidence = 100
          and (
            (
              decision_method = 'human_review'
              and reviewer_attested = true
              and rule_version is null
            ) or (
              decision_method = 'deterministic_rule'
              and reviewer_attested = false
              and rule_version is not null
              and length(trim(rule_version)) > 0
            )
          )
      ), eligible_catalog as (
        select
          membership.*,
          observation.gtin,
          case char_length(observation.gtin)
            when 8 then 'ean8'::text
            else 'ean13'::text
          end as scheme,
          observation.retrieved_at as verified_at,
          observation.canonical_product_id::double precision as canonical_product_id,
          observation.display_name,
          observation.brand,
          observation.package_amount,
          observation.package_unit,
          observation.units_per_pack,
          'active'::text as status,
          run.source_id as catalog_source_id,
          source.display_name as catalog_source_display_name,
          source.source_kind as catalog_source_kind,
          source.runtime_state as catalog_runtime_state,
          source.permission_reviewed_at as source_permission_reviewed_at,
          source.permission_expires_at as source_permission_expires_at,
          observation.raw_record_hash as catalog_raw_record_hash,
          observation.retrieved_at as catalog_last_seen_at,
          permission.id::double precision as permission_id,
          permission.decision as permission_decision,
          permission.reviewed_at as permission_reviewed_at,
          permission.valid_until as permission_valid_until,
          (permission.permissions -> 'catalog') = 'true'::jsonb as permission_catalog,
          row_number() over (
            partition by membership.family_id, membership.product_id
            order by
              observation.gtin asc,
              observation.retrieved_at desc,
              run.completed_at desc,
              observation.id desc,
              run.source_id asc
          ) as alias_rank
        from approved_memberships membership
        inner join catalog_observations observation
          on observation.canonical_product_id = membership.product_id
        inner join ingestion_runs run
          on run.id = observation.ingestion_run_id
         and run.run_type = 'catalog'
         and run.status = 'completed'
         and run.completed_at is not null
         and run.completed_at <= ${atIso}::timestamptz
         and run.created_at <= ${atIso}::timestamptz
         and run.terminalized_at <= ${atIso}::timestamptz
        inner join data_sources source
          on source.id = run.source_id
         and source.runtime_state = 'approved'
         and source.created_at <= ${atIso}::timestamptz
         and source.public_state_changed_at <= ${atIso}::timestamptz
         and source.permission_reviewed_at is not null
         and source.permission_reviewed_at <= ${atIso}::timestamptz
         and (source.permission_expires_at is null or source.permission_expires_at > ${atIso}::timestamptz)
        inner join lateral (
          select
            candidate.id,
            candidate.decision,
            candidate.reviewed_at,
            candidate.valid_until,
            candidate.permissions
          from source_permissions candidate
          where candidate.source_id = source.id
            and candidate.created_at <= ${atIso}::timestamptz
          order by candidate.created_at desc, candidate.id desc
          limit 1
        ) permission on true
        where observation.retrieved_at >= ${freshnessStartsAtIso}::timestamptz
          and observation.retrieved_at <= ${atIso}::timestamptz
          and observation.retrieved_at <= run.completed_at
          and observation.created_at <= ${atIso}::timestamptz
          and permission.decision = 'approved'
          and permission.reviewed_at <= ${atIso}::timestamptz
          and source.permission_reviewed_at = permission.reviewed_at
          and source.permission_expires_at is not distinct from permission.valid_until
          and (permission.valid_until is null or permission.valid_until > ${atIso}::timestamptz)
          and permission.permissions @> '{"catalog": true}'::jsonb
      ), representatives as (
        select *
        from eligible_catalog
        where alias_rank = 1
      ), bounded as (
        select
          representatives.*,
          (row_number() over (
            partition by family_id
            order by lower(display_name), gtin, canonical_product_id
          ))::integer as product_rank
        from representatives
      )
      select
        family.version_id,
        family.taxonomy_id,
        family.taxonomy_version,
        family.contract_version,
        family.published_at,
        family.content_sha256,
        family.family_id,
        family.slug,
        family.label_no,
        family.parent_family_id,
        family.family_status,
        family.aliases,
        family.requested_order,
        coalesce((
          select jsonb_agg(to_jsonb(candidate) order by candidate.product_rank)
          from bounded candidate
          where candidate.family_id = family.family_id
            and candidate.product_rank <= ${scanLimitPerFamily}
        ), '[]'::jsonb) as match_rows
      from requested_families family
      order by family.requested_order asc
      limit ${requested.length}
    `;

    try {
      const rows = await awaitAbortable(query, signal);
      if (signal?.aborted) throw new ReviewedFamilyReaderError("CANCELLED");
      if (!Array.isArray(rows) || rows.length > requested.length) {
        throw new ReviewedFamilyReaderError("UNAVAILABLE");
      }

      const knownSnapshots = new Map<string, Extract<ReviewedFamilySnapshot, { state: "active" }>>();
      for (const rawRow of rows as unknown[]) {
        const normalized = normalizeReviewedFamilyEligibilityRow(rawRow);
        if (!isRecord(normalized)) throw new ReviewedFamilyReaderError("UNAVAILABLE");
        const row = normalized as unknown as ReviewedFamilySnapshotQueryRow;
        const identity = reviewedFamilyIdentityFromRow(row, requestedSet, at);
        const expectedOrder = requested.indexOf(identity.family.id) + 1;
        if (
          knownSnapshots.has(identity.family.id)
          || !Number.isSafeInteger(row.requested_order)
          || row.requested_order !== expectedOrder
          || !Array.isArray(row.match_rows)
          || row.match_rows.length > scanLimitPerFamily
        ) {
          throw new ReviewedFamilyReaderError("UNAVAILABLE");
        }

        const matches: ReviewedFamilyCatalogMatch[] = [];
        const canonicalKeys = new Set<string>();
        for (const matchRow of row.match_rows) {
          const match = reviewedFamilyMatchFromRow(
            matchRow,
            requestedSet,
            productsPerFamily,
            at,
          );
          if (match === undefined || match.family.id !== identity.family.id) {
            throw new ReviewedFamilyReaderError("UNAVAILABLE");
          }
          const key = match.canonicalProductId;
          if (canonicalKeys.has(key)) throw new ReviewedFamilyReaderError("UNAVAILABLE");
          canonicalKeys.add(key);
          matches.push(match);
        }
        matches.sort((left, right) =>
          compareText(left.product.displayName.toLocaleLowerCase("nb-NO"), right.product.displayName.toLocaleLowerCase("nb-NO"))
          || compareText(left.product.gtin, right.product.gtin));
        knownSnapshots.set(identity.family.id, {
          complete: true,
          family: identity.family,
          familyId: identity.family.id,
          matches,
          state: "active",
          taxonomy: identity.taxonomy,
        });
      }

      return requested.map((familyId) => knownSnapshots.get(familyId) ?? {
        complete: false,
        familyId,
        matches: [],
        state: "unknown",
      });
    } catch (error) {
      if (error instanceof ReviewedFamilyReaderError) throw error;
      if (signal?.aborted) throw new ReviewedFamilyReaderError("CANCELLED");
      throw new ReviewedFamilyReaderError("UNAVAILABLE");
    }
  }
}
