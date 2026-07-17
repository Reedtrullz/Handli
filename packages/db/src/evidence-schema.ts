import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

const id = (name: string) => bigserial(name, { mode: "number" });
const foreignId = (name: string) => bigint(name, { mode: "number" });
const time = (name: string) => timestamp(name, { mode: "date", withTimezone: true });

export const dataSources = pgTable(
  "data_sources",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    displayName: varchar("display_name", { length: 160 }).notNull(),
    sourceKind: varchar("source_kind", { length: 32 }).notNull(),
    runtimeState: varchar("runtime_state", { length: 16 }).notNull().default("blocked"),
    publicReferenceUrl: text("public_reference_url"),
    permissionReviewedAt: time("permission_reviewed_at"),
    permissionExpiresAt: time("permission_expires_at"),
    killSwitchReason: text("kill_switch_reason"),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
    publicStateChangedAt: time("public_state_changed_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "data_sources_kind",
      sql`${table.sourceKind} in ('catalog', 'ordinary_price', 'offer', 'store', 'geocoder', 'routing', 'legacy')`,
    ),
    check(
      "data_sources_runtime_state",
      sql`${table.runtimeState} in ('approved', 'conditional', 'blocked', 'revoked')`,
    ),
    check(
      "data_sources_permission_range",
      sql`${table.permissionExpiresAt} is null or ${table.permissionReviewedAt} is null or ${table.permissionExpiresAt} > ${table.permissionReviewedAt}`,
    ),
    check(
      "data_sources_public_state_clock",
      sql`${table.publicStateChangedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const sourcePermissions = pgTable(
  "source_permissions",
  {
    id: id("id").primaryKey(),
    sourceId: varchar("source_id", { length: 64 })
      .notNull()
      .references(() => dataSources.id),
    decision: varchar("decision", { length: 16 }).notNull(),
    reviewedAt: time("reviewed_at").notNull(),
    validUntil: time("valid_until"),
    publicReferenceUrl: text("public_reference_url"),
    privateReferenceKey: text("private_reference_key"),
    permissions: jsonb("permissions")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    notes: text("notes"),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "source_permissions_decision",
      sql`${table.decision} in ('approved', 'conditional', 'blocked', 'revoked')`,
    ),
    check(
      "source_permissions_valid_range",
      sql`${table.validUntil} is null or ${table.validUntil} > ${table.reviewedAt}`,
    ),
  ],
);

export const canonicalProducts = pgTable(
  "canonical_products",
  {
    id: id("id").primaryKey(),
    displayName: varchar("display_name", { length: 240 }).notNull(),
    brand: varchar("brand", { length: 160 }),
    packageAmount: integer("package_amount").notNull(),
    packageUnit: varchar("package_unit", { length: 16 }).notNull(),
    unitsPerPack: integer("units_per_pack").notNull().default(1),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
    publicStateChangedAt: time("public_state_changed_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "canonical_products_package_amount_positive",
      sql`${table.packageAmount} > 0`,
    ),
    check(
      "canonical_products_package_unit",
      sql`${table.packageUnit} in ('g', 'ml', 'piece', 'package')`,
    ),
    check(
      "canonical_products_units_per_pack_positive",
      sql`${table.unitsPerPack} > 0`,
    ),
    check(
      "canonical_products_status",
      sql`${table.status} in ('active', 'quarantined', 'retired')`,
    ),
    check(
      "canonical_products_public_state_clock",
      sql`${table.publicStateChangedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const productIdentifiers = pgTable(
  "product_identifiers",
  {
    id: id("id").primaryKey(),
    productId: foreignId("product_id")
      .notNull()
      .references(() => canonicalProducts.id),
    scheme: varchar("scheme", { length: 16 }).notNull(),
    value: varchar("value", { length: 128 }).notNull(),
    sourceId: varchar("source_id", { length: 64 }).references(() => dataSources.id),
    confidence: smallint("confidence").notNull().default(100),
    verifiedAt: time("verified_at"),
    createdAt: time("created_at").notNull().defaultNow(),
    publicStateChangedAt: time("public_state_changed_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("product_identifiers_gtin_value_unique")
      .on(table.value)
      .where(sql`${table.scheme} in ('ean8', 'ean13')`),
    uniqueIndex("product_identifiers_source_value_unique")
      .on(table.sourceId, table.value)
      .where(sql`${table.scheme} = 'source'`),
    check(
      "product_identifiers_scheme",
      sql`${table.scheme} in ('ean8', 'ean13', 'source')`,
    ),
    check(
      "product_identifiers_confidence_range",
      sql`${table.confidence} between 0 and 100`,
    ),
    check(
      "product_identifiers_ean_shape",
      sql`(${table.scheme} = 'ean8' and ${table.value} ~ '^[0-9]{8}$') or (${table.scheme} = 'ean13' and ${table.value} ~ '^[0-9]{13}$') or (${table.scheme} = 'source' and length(${table.value}) between 1 and 128)`,
    ),
    check(
      "product_identifiers_source_scope",
      sql`(${table.scheme} in ('ean8', 'ean13') and ${table.sourceId} is null) or (${table.scheme} = 'source' and ${table.sourceId} is not null)`,
    ),
    check(
      "product_identifiers_public_state_clock",
      sql`${table.publicStateChangedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const sourceProducts = pgTable(
  "source_products",
  {
    sourceId: varchar("source_id", { length: 64 })
      .notNull()
      .references(() => dataSources.id),
    externalId: varchar("external_id", { length: 128 }).notNull(),
    canonicalProductId: foreignId("canonical_product_id").references(
      () => canonicalProducts.id,
    ),
    normalizedFields: jsonb("normalized_fields")
      .$type<Record<string, unknown>>()
      .notNull(),
    rawRecordHash: char("raw_record_hash", { length: 64 }).notNull(),
    matchState: varchar("match_state", { length: 16 }).notNull().default("unmatched"),
    firstSeenAt: time("first_seen_at").notNull(),
    lastSeenAt: time("last_seen_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sourceId, table.externalId] }),
    check(
      "source_products_hash_shape",
      sql`${table.rawRecordHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "source_products_match_state",
      sql`${table.matchState} in ('unmatched', 'candidate', 'matched', 'quarantined')`,
    ),
    check(
      "source_products_seen_range",
      sql`${table.lastSeenAt} >= ${table.firstSeenAt}`,
    ),
  ],
);

export const productFamilies = pgTable(
  "product_families",
  {
    slug: varchar("slug", { length: 80 }).primaryKey(),
    labelNo: varchar("label_no", { length: 160 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (table) => [
    check("product_families_status", sql`${table.status} in ('active', 'retired')`),
  ],
);

export const productFamilyMemberships = pgTable(
  "product_family_memberships",
  {
    productId: foreignId("product_id")
      .notNull()
      .references(() => canonicalProducts.id),
    familySlug: varchar("family_slug", { length: 80 })
      .notNull()
      .references(() => productFamilies.slug),
    confidence: smallint("confidence").notNull(),
    method: varchar("method", { length: 24 }).notNull(),
    reviewState: varchar("review_state", { length: 16 }).notNull(),
    ruleVersion: varchar("rule_version", { length: 64 }),
    reviewedAt: time("reviewed_at"),
  },
  (table) => [
    primaryKey({ columns: [table.productId, table.familySlug] }),
    check(
      "product_family_memberships_confidence_range",
      sql`${table.confidence} between 0 and 100`,
    ),
    check(
      "product_family_memberships_method",
      sql`${table.method} in ('exact_identifier', 'deterministic_rule', 'human_review')`,
    ),
    check(
      "product_family_memberships_review_state",
      sql`${table.reviewState} in ('approved', 'candidate', 'rejected')`,
    ),
  ],
);

/**
 * Immutable, source-controlled reviewed-family taxonomy publications.
 *
 * The legacy product_families/product_family_memberships projection above is
 * deliberately not trusted by the reviewed-family read path.  A publication
 * binds its stable identity to the checksum of the canonical domain artifact,
 * and every definition and membership decision below is version scoped.
 */
export const familyTaxonomyVersions = pgTable(
  "family_taxonomy_versions",
  {
    versionId: varchar("version_id", { length: 120 }).primaryKey(),
    taxonomyId: varchar("taxonomy_id", { length: 80 }).notNull(),
    taxonomyVersion: varchar("taxonomy_version", { length: 32 }).notNull(),
    contractVersion: smallint("contract_version").notNull(),
    publishedAt: time("published_at").notNull(),
    contentSha256: char("content_sha256", { length: 64 }).notNull(),
    contentJson: jsonb("content_json").notNull(),
    expectedFamilyCount: integer("expected_family_count").notNull(),
    expectedAliasCount: integer("expected_alias_count").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("family_taxonomy_versions_taxonomy_version_unique").on(
      table.taxonomyId,
      table.taxonomyVersion,
    ),
    unique("family_taxonomy_versions_taxonomy_publication_unique").on(
      table.taxonomyId,
      table.publishedAt,
    ),
    check(
      "family_taxonomy_versions_version_id_binding",
      sql`${table.versionId} = ${table.taxonomyId} || '@' || ${table.taxonomyVersion}`,
    ),
    check(
      "family_taxonomy_versions_taxonomy_id_shape",
      sql`${table.taxonomyId} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
    ),
    check(
      "family_taxonomy_versions_semver_shape",
      sql`${table.taxonomyVersion} ~ '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$'`,
    ),
    check(
      "family_taxonomy_versions_contract_version",
      sql`${table.contractVersion} = 1`,
    ),
    check(
      "family_taxonomy_versions_checksum_shape",
      sql`${table.contentSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "family_taxonomy_versions_content_array",
      sql`jsonb_typeof(${table.contentJson}) = 'array'`,
    ),
    check(
      "family_taxonomy_versions_family_count_range",
      sql`${table.expectedFamilyCount} between 1 and 500 and jsonb_array_length(${table.contentJson}) = ${table.expectedFamilyCount}`,
    ),
    check(
      "family_taxonomy_versions_alias_count_range",
      sql`${table.expectedAliasCount} between 0 and ${table.expectedFamilyCount} * 20`,
    ),
    check(
      "family_taxonomy_versions_publication_not_future_created",
      sql`${table.publishedAt} <= ${table.createdAt}`,
    ),
  ],
);

export const reviewedFamilyDefinitions = pgTable(
  "reviewed_family_definitions",
  {
    versionId: varchar("version_id", { length: 120 })
      .notNull()
      .references(() => familyTaxonomyVersions.versionId),
    familyId: varchar("family_id", { length: 80 }).notNull(),
    slug: varchar("slug", { length: 80 }).notNull(),
    labelNo: varchar("label_no", { length: 160 }).notNull(),
    parentFamilyId: varchar("parent_family_id", { length: 80 }),
    status: varchar("status", { length: 16 }).notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.versionId, table.familyId] }),
    unique("reviewed_family_definitions_version_slug_unique").on(
      table.versionId,
      table.slug,
    ),
    foreignKey({
      name: "reviewed_family_definitions_version_parent_fk",
      columns: [table.versionId, table.parentFamilyId],
      foreignColumns: [table.versionId, table.familyId],
    }),
    check(
      "reviewed_family_definitions_family_id_shape",
      sql`${table.familyId} ~ '^family:[a-z0-9]+(-[a-z0-9]+)*$'`,
    ),
    check(
      "reviewed_family_definitions_slug_shape",
      sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
    ),
    check(
      "reviewed_family_definitions_label_nonempty",
      sql`length(trim(${table.labelNo})) > 0`,
    ),
    check(
      "reviewed_family_definitions_parent_not_self",
      sql`${table.parentFamilyId} is null or ${table.parentFamilyId} <> ${table.familyId}`,
    ),
    check(
      "reviewed_family_definitions_status",
      sql`${table.status} in ('active', 'retired')`,
    ),
  ],
);

export const reviewedFamilyAliases = pgTable(
  "reviewed_family_aliases",
  {
    versionId: varchar("version_id", { length: 120 }).notNull(),
    familyId: varchar("family_id", { length: 80 }).notNull(),
    alias: varchar("alias", { length: 80 }).notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.versionId, table.alias] }),
    foreignKey({
      name: "reviewed_family_aliases_definition_fk",
      columns: [table.versionId, table.familyId],
      foreignColumns: [reviewedFamilyDefinitions.versionId, reviewedFamilyDefinitions.familyId],
    }),
    check(
      "reviewed_family_aliases_alias_nonempty",
      sql`length(trim(${table.alias})) > 0`,
    ),
    check(
      "reviewed_family_aliases_alias_shape",
      sql`${table.alias} ~ '^[a-z0-9æøå]+([ -][a-z0-9æøå]+)*$'`,
    ),
  ],
);

export const reviewedFamilyMembershipDecisions = pgTable(
  "reviewed_family_membership_decisions",
  {
    id: id("id").primaryKey(),
    versionId: varchar("version_id", { length: 120 }).notNull(),
    familyId: varchar("family_id", { length: 80 }).notNull(),
    productId: foreignId("product_id")
      .notNull()
      .references(() => canonicalProducts.id),
    decision: varchar("decision", { length: 16 }).notNull(),
    method: varchar("method", { length: 24 }).notNull(),
    confidence: smallint("confidence").notNull(),
    reviewerId: varchar("reviewer_id", { length: 160 }),
    reviewedAt: time("reviewed_at").notNull(),
    ruleVersion: varchar("rule_version", { length: 80 }),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "reviewed_family_membership_decisions_definition_fk",
      columns: [table.versionId, table.familyId],
      foreignColumns: [reviewedFamilyDefinitions.versionId, reviewedFamilyDefinitions.familyId],
    }),
    index("reviewed_family_membership_decisions_latest_idx").on(
      table.versionId,
      table.familyId,
      table.productId,
      table.reviewedAt,
      table.id,
    ),
    check(
      "reviewed_family_membership_decisions_decision",
      sql`${table.decision} in ('approved', 'candidate', 'rejected')`,
    ),
    check(
      "reviewed_family_membership_decisions_method",
      sql`${table.method} in ('deterministic_rule', 'human_review')`,
    ),
    check(
      "reviewed_family_membership_decisions_confidence_range",
      sql`${table.confidence} between 0 and 100`,
    ),
    check(
      "reviewed_family_membership_decisions_provenance",
      sql`(
        ${table.method} = 'human_review'
        and ${table.reviewerId} is not null
        and length(trim(${table.reviewerId})) > 0
        and ${table.ruleVersion} is null
      ) or (
        ${table.method} = 'deterministic_rule'
        and ${table.reviewerId} is null
        and ${table.ruleVersion} is not null
        and length(trim(${table.ruleVersion})) > 0
      )`,
    ),
    check(
      "reviewed_family_membership_decisions_review_not_future_created",
      sql`${table.reviewedAt} <= ${table.createdAt}`,
    ),
  ],
);

export const geographicScopes = pgTable(
  "geographic_scopes",
  {
    id: id("id").primaryKey(),
    scopeKey: varchar("scope_key", { length: 160 }).notNull().unique(),
    scopeKind: varchar("scope_kind", { length: 24 }).notNull(),
    label: varchar("label", { length: 200 }).notNull(),
    countryCode: char("country_code", { length: 2 }).notNull().default("NO"),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
    publicStateChangedAt: time("public_state_changed_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "geographic_scopes_kind",
      sql`${table.scopeKind} in ('national', 'region', 'postal_set', 'store_set')`,
    ),
    check(
      "geographic_scopes_country_shape",
      sql`${table.countryCode} ~ '^[A-Z]{2}$'`,
    ),
    check(
      "geographic_scopes_status",
      sql`${table.status} in ('active', 'retired')`,
    ),
    check(
      "geographic_scopes_public_state_clock",
      sql`${table.publicStateChangedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const physicalStores = pgTable(
  "physical_stores",
  {
    id: id("id").primaryKey(),
    sourceId: varchar("source_id", { length: 64 })
      .notNull()
      .references(() => dataSources.id),
    externalId: varchar("external_id", { length: 128 }).notNull(),
    chain: varchar("chain", { length: 32 }).notNull(),
    name: varchar("name", { length: 240 }).notNull(),
    addressLine: varchar("address_line", { length: 240 }),
    postalCode: varchar("postal_code", { length: 8 }),
    municipalityCode: varchar("municipality_code", { length: 8 }),
    latitude: numeric("latitude", { precision: 9, scale: 6 }).notNull(),
    longitude: numeric("longitude", { precision: 9, scale: 6 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    observedAt: time("observed_at").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("physical_stores_source_external_unique").on(table.sourceId, table.externalId),
    check(
      "physical_stores_chain_supported",
      sql`${table.chain} in ('bunnpris', 'rema-1000', 'extra')`,
    ),
    check(
      "physical_stores_latitude_range",
      sql`${table.latitude} between -90 and 90`,
    ),
    check(
      "physical_stores_longitude_range",
      sql`${table.longitude} between -180 and 180`,
    ),
    check(
      "physical_stores_status",
      sql`${table.status} in ('active', 'closed', 'unknown')`,
    ),
  ],
);

export const ingestionRuns = pgTable(
  "ingestion_runs",
  {
    id: id("id").primaryKey(),
    jobId: varchar("job_id", { length: 200 }),
    sourceId: varchar("source_id", { length: 64 })
      .notNull()
      .references(() => dataSources.id),
    runType: varchar("run_type", { length: 32 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    startedAt: time("started_at").notNull(),
    completedAt: time("completed_at"),
    terminalizedAt: time("terminalized_at"),
    counts: jsonb("counts").$type<Record<string, number>>().notNull().default({}),
    errorClass: varchar("error_class", { length: 80 }),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ingestion_runs_job_id_unique")
      .on(table.jobId)
      .where(sql`${table.jobId} is not null`),
    check(
      "ingestion_runs_status",
      sql`${table.status} in ('running', 'completed', 'degraded', 'failed', 'cancelled')`,
    ),
    check(
      "ingestion_runs_time_range",
      sql`${table.completedAt} is null or ${table.completedAt} >= ${table.startedAt}`,
    ),
    check(
      "ingestion_runs_terminalization_state",
      sql`(${table.status} = 'running' and ${table.completedAt} is null and ${table.terminalizedAt} is null) or (${table.status} <> 'running' and ${table.completedAt} is not null and ${table.terminalizedAt} is not null and ${table.terminalizedAt} >= ${table.createdAt})`,
    ),
    check(
      "ingestion_runs_completion_not_after_terminalization",
      sql`${table.status} = 'running' or ${table.completedAt} <= ${table.terminalizedAt}`,
    ),
  ],
);

export const physicalStoreObservations = pgTable(
  "physical_store_observations",
  {
    id: id("id").primaryKey(),
    ingestionRunId: foreignId("ingestion_run_id")
      .notNull()
      .references(() => ingestionRuns.id),
    sourceId: varchar("source_id", { length: 64 })
      .notNull()
      .references(() => dataSources.id),
    branchKey: char("branch_key", { length: 64 }).notNull(),
    externalId: varchar("external_id", { length: 128 }).notNull(),
    chain: varchar("chain", { length: 32 }).notNull(),
    name: varchar("name", { length: 240 }).notNull(),
    latitude: numeric("latitude", { precision: 9, scale: 6 }).notNull(),
    longitude: numeric("longitude", { precision: 9, scale: 6 }).notNull(),
    postalCode: varchar("postal_code", { length: 4 }),
    status: varchar("status", { length: 16 }).notNull(),
    observedAt: time("observed_at").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("physical_store_observations_run_external_unique").on(
      table.ingestionRunId,
      table.sourceId,
      table.externalId,
    ),
    unique("physical_store_observations_run_branch_unique").on(
      table.ingestionRunId,
      table.branchKey,
    ),
    index("physical_store_observations_run_chain_status_idx").on(
      table.ingestionRunId,
      table.chain,
      table.status,
      table.branchKey,
    ),
    check(
      "physical_store_observations_branch_key_shape",
      sql`${table.branchKey} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "physical_store_observations_branch_key_binding",
      sql`${table.branchKey} = encode(sha256(convert_to(octet_length(${table.sourceId})::text || ':' || ${table.sourceId} || ${table.externalId}, 'UTF8')), 'hex')`,
    ),
    check(
      "physical_store_observations_chain_supported",
      sql`${table.chain} in ('bunnpris', 'rema-1000', 'extra')`,
    ),
    check(
      "physical_store_observations_name_nonempty",
      sql`length(trim(${table.name})) > 0`,
    ),
    check(
      "physical_store_observations_latitude_range",
      sql`${table.latitude} between -90 and 90`,
    ),
    check(
      "physical_store_observations_longitude_range",
      sql`${table.longitude} between -180 and 180`,
    ),
    check(
      "physical_store_observations_status",
      sql`${table.status} in ('active', 'closed', 'unknown')`,
    ),
    check(
      "physical_store_observations_postal_shape",
      sql`${table.postalCode} is null or ${table.postalCode} ~ '^[0-9]{4}$'`,
    ),
    check(
      "physical_store_observations_observed_before_creation",
      sql`${table.observedAt} <= ${table.createdAt}`,
    ),
  ],
);

export const physicalStoreCoverageChecks = pgTable(
  "physical_store_coverage_checks",
  {
    id: id("id").primaryKey(),
    ingestionRunId: foreignId("ingestion_run_id")
      .notNull()
      .references(() => ingestionRuns.id),
    sourceId: varchar("source_id", { length: 64 })
      .notNull()
      .references(() => dataSources.id),
    chain: varchar("chain", { length: 32 }).notNull(),
    state: varchar("state", { length: 16 }).notNull(),
    reason: varchar("reason", { length: 40 }),
    recordCount: integer("record_count").notNull(),
    checkedAt: time("checked_at").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("physical_store_coverage_checks_run_chain_unique").on(
      table.ingestionRunId,
      table.chain,
    ),
    index("physical_store_coverage_checks_run_chain_state_idx").on(
      table.ingestionRunId,
      table.chain,
      table.state,
      table.checkedAt,
    ),
    check(
      "physical_store_coverage_checks_chain_supported",
      sql`${table.chain} in ('bunnpris', 'rema-1000', 'extra')`,
    ),
    check(
      "physical_store_coverage_checks_state",
      sql`${table.state} in ('complete', 'unknown')`,
    ),
    check(
      "physical_store_coverage_checks_reason_state",
      sql`(${table.state} = 'complete' and ${table.reason} is null and ${table.recordCount} > 0) or (${table.state} = 'unknown' and ${table.reason} in ('DUPLICATE_IDENTITY', 'INVALID_RECORDS', 'MISSING_SUPPORTED_CHAIN', 'POSSIBLY_TRUNCATED', 'REQUEST_FAILED'))`,
    ),
    check(
      "physical_store_coverage_checks_record_count_range",
      sql`${table.recordCount} between 0 and 1000`,
    ),
    check(
      "physical_store_coverage_checks_checked_before_creation",
      sql`${table.checkedAt} <= ${table.createdAt}`,
    ),
  ],
);

export const sourceRecordOutcomes = pgTable(
  "source_record_outcomes",
  {
    id: id("id").primaryKey(),
    ingestionRunId: foreignId("ingestion_run_id")
      .notNull()
      .references(() => ingestionRuns.id),
    recordKind: varchar("record_kind", { length: 32 }).notNull(),
    sourceRecordId: varchar("source_record_id", { length: 200 }).notNull(),
    outcomeState: varchar("outcome_state", { length: 16 }).notNull(),
    reason: varchar("reason", { length: 80 }),
    subjectEan: varchar("subject_ean", { length: 14 }),
    subjectChain: varchar("subject_chain", { length: 32 }),
    rawChainCode: varchar("raw_chain_code", { length: 100 }),
    normalizedRecord: jsonb("normalized_record").$type<Record<string, unknown>>(),
    outcomeHash: char("outcome_hash", { length: 64 }).notNull(),
    recordedAt: time("recorded_at").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("source_record_outcomes_run_kind_record_unique").on(
      table.ingestionRunId,
      table.recordKind,
      table.sourceRecordId,
    ),
    check(
      "source_record_outcomes_state",
      sql`${table.outcomeState} in ('accepted', 'quarantined', 'unknown')`,
    ),
    check(
      "source_record_outcomes_reason_state",
      sql`(${table.outcomeState} = 'accepted' and ${table.reason} is null) or (${table.outcomeState} in ('quarantined', 'unknown') and ${table.reason} is not null)`,
    ),
    check(
      "source_record_outcomes_ean_shape",
      sql`${table.subjectEan} is null or ${table.subjectEan} ~ '^([0-9]{8}|[0-9]{13})$'`,
    ),
    check(
      "source_record_outcomes_chain_supported",
      sql`${table.subjectChain} is null or ${table.subjectChain} in ('bunnpris', 'rema-1000', 'extra')`,
    ),
    check(
      "source_record_outcomes_hash_shape",
      sql`${table.outcomeHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const catalogObservations = pgTable(
  "catalog_observations",
  {
    id: id("id").primaryKey(),
    ingestionRunId: foreignId("ingestion_run_id")
      .notNull()
      .references(() => ingestionRuns.id),
    sourceRecordId: varchar("source_record_id", { length: 128 }).notNull(),
    canonicalProductId: foreignId("canonical_product_id")
      .notNull()
      .references(() => canonicalProducts.id),
    gtin: varchar("gtin", { length: 14 }).notNull(),
    displayName: varchar("display_name", { length: 240 }).notNull(),
    brand: varchar("brand", { length: 160 }),
    packageAmount: integer("package_amount").notNull(),
    packageUnit: varchar("package_unit", { length: 16 }).notNull(),
    unitsPerPack: integer("units_per_pack").notNull().default(1),
    retrievedAt: time("retrieved_at").notNull(),
    sourceUpdatedAt: time("source_updated_at"),
    rawRecordHash: char("raw_record_hash", { length: 64 }).notNull(),
    categoryPath: jsonb("category_path").$type<Array<{
      sourceCategoryId: string;
      depth: number;
      name: string;
    }>>(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("catalog_observations_run_record_unique").on(
      table.ingestionRunId,
      table.sourceRecordId,
    ),
    index("catalog_observations_gtin_retrieved_idx").on(
      table.gtin,
      table.retrievedAt,
      table.id,
    ),
    index("catalog_observations_product_retrieved_idx").on(
      table.canonicalProductId,
      table.retrievedAt,
      table.id,
    ),
    index("catalog_observations_category_path_gin_idx")
      .using("gin", table.categoryPath.op("jsonb_path_ops"))
      .where(sql`${table.categoryPath} is not null`),
    check(
      "catalog_observations_category_path_shape",
      sql`${table.categoryPath} is null or case when jsonb_typeof(${table.categoryPath}) = 'array' then jsonb_array_length(${table.categoryPath}) <= 100 else false end`,
    ),
    check(
      "catalog_observations_gtin_shape",
      sql`${table.gtin} ~ '^([0-9]{8}|[0-9]{13})$'`,
    ),
    check(
      "catalog_observations_display_name_nonempty",
      sql`length(trim(${table.displayName})) > 0`,
    ),
    check(
      "catalog_observations_package_amount_positive",
      sql`${table.packageAmount} > 0`,
    ),
    check(
      "catalog_observations_package_unit",
      sql`${table.packageUnit} in ('g', 'ml', 'piece', 'package')`,
    ),
    check(
      "catalog_observations_units_per_pack_positive",
      sql`${table.unitsPerPack} > 0`,
    ),
    check(
      "catalog_observations_source_time_order",
      sql`${table.sourceUpdatedAt} is null or ${table.sourceUpdatedAt} <= ${table.retrievedAt}`,
    ),
    check(
      "catalog_observations_hash_shape",
      sql`${table.rawRecordHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const priceObservations = pgTable(
  "price_observations",
  {
    id: id("id").primaryKey(),
    evidenceKey: varchar("evidence_key", { length: 255 }).notNull().unique(),
    productId: foreignId("product_id")
      .notNull()
      .references(() => canonicalProducts.id),
    chain: varchar("chain", { length: 32 }).notNull(),
    amountOre: integer("amount_ore").notNull(),
    observedAt: time("observed_at").notNull(),
    fetchedAt: time("fetched_at").notNull(),
    sourceId: varchar("source_id", { length: 64 })
      .notNull()
      .references(() => dataSources.id),
    sourceReference: text("source_reference"),
    ingestionRunId: foreignId("ingestion_run_id")
      .notNull()
      .references(() => ingestionRuns.id),
    geographicScopeId: foreignId("geographic_scope_id").references(
      () => geographicScopes.id,
    ),
    evidenceLevel: varchar("evidence_level", { length: 16 }).notNull(),
    confidence: smallint("confidence").notNull(),
    claimEligibility: varchar("claim_eligibility", { length: 24 })
      .notNull()
      .default("ordinary_only"),
    rawRecordHash: char("raw_record_hash", { length: 64 }),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("price_observations_product_chain_time_idx").on(
      table.productId,
      table.chain,
      table.observedAt,
    ),
    index("price_observations_source_run_idx").on(table.sourceId, table.ingestionRunId),
    check(
      "price_observations_chain_supported",
      sql`${table.chain} in ('bunnpris', 'rema-1000', 'extra')`,
    ),
    check(
      "price_observations_amount_ore_nonnegative",
      sql`${table.amountOre} >= 0`,
    ),
    check(
      "price_observations_time_range",
      sql`${table.fetchedAt} >= ${table.observedAt}`,
    ),
    check(
      "price_observations_evidence_level",
      sql`${table.evidenceLevel} in ('chain', 'branch')`,
    ),
    check(
      "price_observations_confidence_range",
      sql`${table.confidence} between 0 and 100`,
    ),
    check(
      "price_observations_claim_eligibility",
      sql`${table.claimEligibility} in ('ordinary_only', 'historical_eligible')`,
    ),
  ],
);

export const priceCoverageChecks = pgTable(
  "price_coverage_checks",
  {
    id: id("id").primaryKey(),
    ingestionRunId: foreignId("ingestion_run_id")
      .notNull()
      .references(() => ingestionRuns.id),
    productId: foreignId("product_id")
      .notNull()
      .references(() => canonicalProducts.id),
    chain: varchar("chain", { length: 32 }).notNull(),
    geographicScopeId: foreignId("geographic_scope_id").references(
      () => geographicScopes.id,
    ),
    state: varchar("state", { length: 24 }).notNull(),
    reason: varchar("reason", { length: 160 }).notNull(),
    checkedAt: time("checked_at").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "price_coverage_checks_chain_supported",
      sql`${table.chain} in ('bunnpris', 'rema-1000', 'extra')`,
    ),
    check(
      "price_coverage_checks_state",
      sql`${table.state} in ('priced', 'known_not_carried', 'stale', 'ineligible', 'unknown')`,
    ),
  ],
);

export const publications = pgTable(
  "publications",
  {
    id: id("id").primaryKey(),
    sourceId: varchar("source_id", { length: 64 })
      .notNull()
      .references(() => dataSources.id),
    externalId: varchar("external_id", { length: 160 }).notNull(),
    chain: varchar("chain", { length: 32 }).notNull(),
    title: varchar("title", { length: 240 }).notNull(),
    validFrom: time("valid_from").notNull(),
    validUntil: time("valid_until").notNull(),
    geographicScopeId: foreignId("geographic_scope_id")
      .notNull()
      .references(() => geographicScopes.id),
    status: varchar("status", { length: 16 }).notNull().default("discovered"),
    discoveredAt: time("discovered_at").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("publications_source_external_unique").on(table.sourceId, table.externalId),
    check(
      "publications_chain_supported",
      sql`${table.chain} in ('bunnpris', 'rema-1000', 'extra')`,
    ),
    check(
      "publications_valid_range",
      sql`${table.validUntil} > ${table.validFrom}`,
    ),
    check(
      "publications_status",
      sql`${table.status} in ('discovered', 'captured', 'published', 'expired', 'failed')`,
    ),
  ],
);

export const publicationCaptures = pgTable(
  "publication_captures",
  {
    id: id("id").primaryKey(),
    publicationId: foreignId("publication_id")
      .notNull()
      .references(() => publications.id),
    blobKey: text("blob_key").notNull(),
    checksum: char("checksum", { length: 64 }).notNull(),
    mimeType: varchar("mime_type", { length: 120 }).notNull(),
    byteLength: integer("byte_length").notNull(),
    rightsClassification: varchar("rights_classification", { length: 24 })
      .notNull()
      .default("private_review"),
    retrievedAt: time("retrieved_at").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("publication_captures_checksum_unique").on(
      table.publicationId,
      table.checksum,
    ),
    check(
      "publication_captures_checksum_shape",
      sql`${table.checksum} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "publication_captures_byte_length_positive",
      sql`${table.byteLength} > 0`,
    ),
    check(
      "publication_captures_rights_classification",
      sql`${table.rightsClassification} in ('private_review', 'extract_only', 'public_display')`,
    ),
  ],
);

export const extractionRuns = pgTable(
  "extraction_runs",
  {
    id: id("id").primaryKey(),
    captureId: foreignId("capture_id")
      .notNull()
      .references(() => publicationCaptures.id),
    extractorVersion: varchar("extractor_version", { length: 80 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    startedAt: time("started_at").notNull(),
    completedAt: time("completed_at"),
    counts: jsonb("counts").$type<Record<string, number>>().notNull().default({}),
    errorClass: varchar("error_class", { length: 80 }),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("extraction_runs_capture_version_unique").on(
      table.captureId,
      table.extractorVersion,
    ),
    check(
      "extraction_runs_status",
      sql`${table.status} in ('running', 'completed', 'degraded', 'failed')`,
    ),
    check(
      "extraction_runs_time_range",
      sql`${table.completedAt} is null or ${table.completedAt} >= ${table.startedAt}`,
    ),
  ],
);

export const extractedOfferCandidates = pgTable(
  "extracted_offer_candidates",
  {
    id: id("id").primaryKey(),
    extractionRunId: foreignId("extraction_run_id")
      .notNull()
      .references(() => extractionRuns.id),
    candidateKey: varchar("candidate_key", { length: 160 }).notNull(),
    normalizedFields: jsonb("normalized_fields")
      .$type<Record<string, unknown>>()
      .notNull(),
    confidence: smallint("confidence").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    anomalyCodes: jsonb("anomaly_codes").$type<string[]>().notNull().default([]),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("extracted_offer_candidates_run_key_unique").on(
      table.extractionRunId,
      table.candidateKey,
    ),
    check(
      "extracted_offer_candidates_confidence_range",
      sql`${table.confidence} between 0 and 100`,
    ),
    check(
      "extracted_offer_candidates_status",
      sql`${table.status} in ('pending', 'approved', 'rejected', 'superseded')`,
    ),
  ],
);

export const approvedOffers = pgTable(
  "approved_offers",
  {
    id: id("id").primaryKey(),
    offerKey: varchar("offer_key", { length: 255 }).notNull().unique(),
    candidateId: foreignId("candidate_id").references(() => extractedOfferCandidates.id),
    sourceId: varchar("source_id", { length: 64 })
      .notNull()
      .references(() => dataSources.id),
    sourceReference: text("source_reference").notNull(),
    chain: varchar("chain", { length: 32 }).notNull(),
    geographicScopeId: foreignId("geographic_scope_id")
      .notNull()
      .references(() => geographicScopes.id),
    amountOre: integer("amount_ore").notNull(),
    beforeAmountOre: integer("before_amount_ore"),
    multibuyQuantity: integer("multibuy_quantity"),
    multibuyGroupAmountOre: integer("multibuy_group_amount_ore"),
    membershipRequirement: varchar("membership_requirement", { length: 24 })
      .notNull()
      .default("public"),
    validFrom: time("valid_from").notNull(),
    validUntil: time("valid_until").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("approved"),
    version: integer("version").notNull().default(1),
    approvedAt: time("approved_at").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("approved_offers_candidate_unique")
      .on(table.candidateId)
      .where(sql`${table.candidateId} is not null`),
    check(
      "approved_offers_chain_supported",
      sql`${table.chain} in ('bunnpris', 'rema-1000', 'extra')`,
    ),
    check("approved_offers_amount_ore_nonnegative", sql`${table.amountOre} >= 0`),
    check(
      "approved_offers_before_amount_ore_nonnegative",
      sql`${table.beforeAmountOre} is null or ${table.beforeAmountOre} >= 0`,
    ),
    check(
      "approved_offers_before_not_lower",
      sql`${table.beforeAmountOre} is null or ${table.beforeAmountOre} >= ${table.amountOre}`,
    ),
    check(
      "approved_offers_multibuy_pair",
      sql`(${table.multibuyQuantity} is null and ${table.multibuyGroupAmountOre} is null) or (${table.multibuyQuantity} > 1 and ${table.multibuyGroupAmountOre} >= 0)`,
    ),
    check(
      "approved_offers_membership_requirement",
      sql`${table.membershipRequirement} in ('public', 'member')`,
    ),
    check(
      "approved_offers_valid_range",
      sql`${table.validUntil} > ${table.validFrom}`,
    ),
    check(
      "approved_offers_status",
      sql`${table.status} in ('approved', 'published', 'expired', 'revoked')`,
    ),
    check(
      "approved_offers_published_candidate_binding",
      sql`${table.status} <> 'published' or ${table.candidateId} is not null`,
    ),
    check("approved_offers_version_positive", sql`${table.version} > 0`),
  ],
);

export const offerTargets = pgTable(
  "offer_targets",
  {
    offerId: foreignId("offer_id")
      .primaryKey()
      .references(() => approvedOffers.id),
    productId: foreignId("product_id").references(() => canonicalProducts.id),
    familySlug: varchar("family_slug", { length: 80 }).references(
      () => productFamilies.slug,
    ),
    matchMethod: varchar("match_method", { length: 24 }).notNull(),
    matchConfidence: smallint("match_confidence").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "offer_targets_exactly_one_target",
      sql`(${table.productId} is not null and ${table.familySlug} is null) or (${table.productId} is null and ${table.familySlug} is not null)`,
    ),
    check(
      "offer_targets_match_method",
      sql`${table.matchMethod} in ('exact_identifier', 'deterministic_rule', 'human_review')`,
    ),
    check(
      "offer_targets_confidence_range",
      sql`${table.matchConfidence} between 0 and 100`,
    ),
  ],
);

export const offerConditions = pgTable(
  "offer_conditions",
  {
    id: id("id").primaryKey(),
    offerId: foreignId("offer_id")
      .notNull()
      .references(() => approvedOffers.id),
    conditionType: varchar("condition_type", { length: 32 }).notNull(),
    conditionValue: jsonb("condition_value").$type<Record<string, unknown>>().notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "offer_conditions_type",
      sql`${table.conditionType} in ('membership', 'quantity', 'channel', 'payment', 'other')`,
    ),
  ],
);

export const reviewActions = pgTable(
  "review_actions",
  {
    id: id("id").primaryKey(),
    candidateId: foreignId("candidate_id")
      .notNull()
      .references(() => extractedOfferCandidates.id),
    offerId: foreignId("offer_id").references(() => approvedOffers.id),
    actorId: varchar("actor_id", { length: 160 }).notNull(),
    action: varchar("action", { length: 24 }).notNull(),
    expectedVersion: integer("expected_version").notNull(),
    decisionBoundaryVersion: smallint("decision_boundary_version").default(1),
    previousValues: jsonb("previous_values").$type<Record<string, unknown>>(),
    newValues: jsonb("new_values").$type<Record<string, unknown>>(),
    reason: text("reason").notNull(),
    actedAt: time("acted_at").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("review_actions_candidate_version_unique").on(
      table.candidateId,
      table.expectedVersion,
    ),
    index("review_actions_candidate_time_idx").on(
      table.candidateId,
      table.actedAt,
      table.id,
    ),
    check(
      "review_actions_action",
      sql`${table.action} in ('approve', 'correct_and_approve', 'reject', 'revoke')`,
    ),
    check(
      "review_actions_expected_version_nonnegative",
      sql`${table.expectedVersion} >= 0`,
    ),
    check(
      "review_actions_decision_boundary_version",
      sql`${table.decisionBoundaryVersion} is null or ${table.decisionBoundaryVersion} = 1`,
    ),
  ],
);

export const sourceHealthSnapshots = pgTable(
  "source_health_snapshots",
  {
    id: id("id").primaryKey(),
    sourceId: varchar("source_id", { length: 64 })
      .notNull()
      .references(() => dataSources.id),
    workerJobId: varchar("worker_job_id", { length: 200 }),
    geographicScopeId: foreignId("geographic_scope_id").references(
      () => geographicScopes.id,
    ),
    status: varchar("status", { length: 16 }).notNull(),
    lastDiscoverySuccessAt: time("last_discovery_success_at"),
    lastCaptureSuccessAt: time("last_capture_success_at"),
    lastPublishSuccessAt: time("last_publish_success_at"),
    newestEligibleEvidenceAt: time("newest_eligible_evidence_at"),
    reviewQueueCount: integer("review_queue_count").notNull().default(0),
    oldestReviewAgeSeconds: integer("oldest_review_age_seconds"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    recordedAt: time("recorded_at").notNull(),
  },
  (table) => [
    index("source_health_snapshots_source_time_idx").on(
      table.sourceId,
      table.recordedAt,
    ),
    uniqueIndex("source_health_snapshots_worker_job_uidx")
      .on(table.workerJobId)
      .where(sql`${table.workerJobId} is not null`),
    foreignKey({
      columns: [table.workerJobId],
      foreignColumns: [workerJobResults.jobId],
      name: "source_health_snapshots_worker_job_fk",
    }),
    check(
      "source_health_snapshots_status",
      sql`${table.status} in ('healthy', 'degraded', 'failed', 'disabled')`,
    ),
    check(
      "source_health_snapshots_queue_nonnegative",
      sql`${table.reviewQueueCount} >= 0`,
    ),
    check(
      "source_health_snapshots_review_age_nonnegative",
      sql`${table.oldestReviewAgeSeconds} is null or ${table.oldestReviewAgeSeconds} >= 0`,
    ),
    check(
      "source_health_snapshots_worker_payload_allowlist",
      sql`${table.workerJobId} is null or (${table.details} = '{}'::jsonb and ${table.reviewQueueCount} = 0 and ${table.oldestReviewAgeSeconds} is null)`,
    ),
    check(
      "source_health_snapshots_success_clocks_not_future",
      sql`${table.workerJobId} is null or ((${table.lastDiscoverySuccessAt} is null or ${table.lastDiscoverySuccessAt} <= ${table.recordedAt}) and (${table.lastCaptureSuccessAt} is null or ${table.lastCaptureSuccessAt} <= ${table.recordedAt}) and (${table.lastPublishSuccessAt} is null or ${table.lastPublishSuccessAt} <= ${table.recordedAt}) and (${table.newestEligibleEvidenceAt} is null or ${table.newestEligibleEvidenceAt} <= ${table.recordedAt}))`,
    ),
  ],
);

export const workerLeases = pgTable(
  "worker_leases",
  {
    leaseKey: varchar("lease_key", { length: 120 }).primaryKey(),
    ownerId: varchar("owner_id", { length: 160 }).notNull(),
    acquiredAt: time("acquired_at").notNull(),
    expiresAt: time("expires_at").notNull(),
    heartbeatAt: time("heartbeat_at").notNull(),
  },
  (table) => [
    check("worker_leases_valid_range", sql`${table.expiresAt} > ${table.acquiredAt}`),
    check(
      "worker_leases_heartbeat_range",
      sql`${table.heartbeatAt} >= ${table.acquiredAt} and ${table.heartbeatAt} <= ${table.expiresAt}`,
    ),
  ],
);

export const workerJobResults = pgTable(
  "worker_job_results",
  {
    id: id("id").primaryKey(),
    jobId: varchar("job_id", { length: 200 }).notNull(),
    sourceId: varchar("source_id", { length: 64 })
      .notNull()
      .references(() => dataSources.id),
    jobKind: varchar("job_kind", { length: 40 }).notNull(),
    scheduledAt: time("scheduled_at").notNull(),
    runId: varchar("run_id", { length: 200 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    startedAt: time("started_at").notNull(),
    completedAt: time("completed_at").notNull(),
    counts: jsonb("counts").$type<Record<string, number>>().notNull(),
    resultHash: char("result_hash", { length: 64 }).notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("worker_job_results_job_id_unique").on(table.jobId),
    index("worker_job_results_source_kind_schedule_idx").on(
      table.sourceId,
      table.jobKind,
      table.scheduledAt,
      table.id,
    ),
    check(
      "worker_job_results_job_kind",
      sql`${table.jobKind} in ('catalog-refresh', 'benchmark-price-refresh', 'physical-store-sync', 'historical-observation-collection', 'official-offer-discovery', 'official-offer-fetch', 'official-offer-ingestion', 'official-offer-lifecycle-reconcile')`,
    ),
    check(
      "worker_job_results_status",
      sql`${table.status} in ('succeeded', 'partial', 'cancelled', 'timed-out', 'failed')`,
    ),
    check(
      "worker_job_results_time_range",
      sql`${table.completedAt} >= ${table.startedAt} and ${table.completedAt} >= ${table.scheduledAt}`,
    ),
    check(
      "worker_job_results_counts_object",
      sql`jsonb_typeof(${table.counts}) = 'object'`,
    ),
    check(
      "worker_job_results_hash_shape",
      sql`${table.resultHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const alertEvents = pgTable(
  "alert_events",
  {
    id: id("id").primaryKey(),
    alertKey: varchar("alert_key", { length: 160 }).notNull(),
    severity: varchar("severity", { length: 16 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    sourceId: varchar("source_id", { length: 64 }).references(() => dataSources.id),
    openedAt: time("opened_at").notNull(),
    closedAt: time("closed_at"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => [
    index("alert_events_key_time_idx").on(table.alertKey, table.openedAt),
    check(
      "alert_events_severity",
      sql`${table.severity} in ('info', 'warning', 'critical')`,
    ),
    check(
      "alert_events_status",
      sql`${table.status} in ('open', 'acknowledged', 'closed')`,
    ),
    check(
      "alert_events_time_range",
      sql`${table.closedAt} is null or ${table.closedAt} >= ${table.openedAt}`,
    ),
  ],
);

export const historicalPriceStatistics = pgTable(
  "historical_price_statistics",
  {
    productId: foreignId("product_id")
      .notNull()
      .references(() => canonicalProducts.id),
    chain: varchar("chain", { length: 32 }).notNull(),
    geographicScopeId: foreignId("geographic_scope_id").references(
      () => geographicScopes.id,
    ),
    windowStart: time("window_start").notNull(),
    windowEnd: time("window_end").notNull(),
    medianAmountOre: integer("median_amount_ore").notNull(),
    observationCount: integer("observation_count").notNull(),
    distinctObservationDays: integer("distinct_observation_days").notNull(),
    computedAt: time("computed_at").notNull(),
  },
  (table) => [
    check(
      "historical_price_statistics_chain_supported",
      sql`${table.chain} in ('bunnpris', 'rema-1000', 'extra')`,
    ),
    check(
      "historical_price_statistics_window_range",
      sql`${table.windowEnd} > ${table.windowStart}`,
    ),
    check(
      "historical_price_statistics_amount_nonnegative",
      sql`${table.medianAmountOre} >= 0`,
    ),
    check(
      "historical_price_statistics_counts",
      sql`${table.observationCount} >= ${table.distinctObservationDays} and ${table.distinctObservationDays} >= 7`,
    ),
  ],
);

export const providerRequestBudgetEvents = pgTable(
  "provider_request_budget_events",
  {
    providerKey: varchar("provider_key", { length: 64 }).notNull(),
    claimedAt: timestamp("claimed_at", { mode: "date", withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    index("provider_request_budget_events_provider_time_idx").on(
      table.providerKey,
      table.claimedAt,
    ),
    check(
      "provider_request_budget_events_provider_key_shape",
      sql`${table.providerKey} ~ '^[a-z][a-z0-9_-]{0,63}$'`,
    ),
  ],
);

export const publicApiRequestBudgetEvents = pgTable(
  "public_api_request_budget_events",
  {
    routeKey: varchar("route_key", { length: 32 }).notNull(),
    claimedAt: timestamp("claimed_at", { mode: "date", withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    index("public_api_request_budget_events_route_time_idx").on(
      table.routeKey,
      table.claimedAt,
    ),
    check(
      "public_api_request_budget_events_route_key_allowed",
      sql`${table.routeKey} in ('discovery-impact', 'discovery-search', 'locations-current', 'locations-search', 'plan-candidates', 'plans', 'plans-travel', 'products-search')`,
    ),
  ],
);

export type DataSourceRow = typeof dataSources.$inferSelect;
export type NewDataSourceRow = typeof dataSources.$inferInsert;
export type CanonicalProductRow = typeof canonicalProducts.$inferSelect;
export type PriceEvidenceRow = typeof priceObservations.$inferSelect;
export type NewPriceEvidenceRow = typeof priceObservations.$inferInsert;
export type CoverageCheckRow = typeof priceCoverageChecks.$inferSelect;
export type SourceRecordOutcomeRow = typeof sourceRecordOutcomes.$inferSelect;
export type NewSourceRecordOutcomeRow = typeof sourceRecordOutcomes.$inferInsert;
export type CatalogObservationRow = typeof catalogObservations.$inferSelect;
export type NewCatalogObservationRow = typeof catalogObservations.$inferInsert;
export type FamilyTaxonomyVersionRow = typeof familyTaxonomyVersions.$inferSelect;
export type ReviewedFamilyDefinitionRow = typeof reviewedFamilyDefinitions.$inferSelect;
export type ReviewedFamilyAliasRow = typeof reviewedFamilyAliases.$inferSelect;
export type ReviewedFamilyMembershipDecisionRow =
  typeof reviewedFamilyMembershipDecisions.$inferSelect;
export type ApprovedOfferRow = typeof approvedOffers.$inferSelect;
