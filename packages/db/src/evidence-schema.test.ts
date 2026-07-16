import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  alertEvents,
  approvedOffers,
  catalogObservations,
  canonicalProducts,
  dataSources,
  extractedOfferCandidates,
  extractionRuns,
  familyTaxonomyVersions,
  geographicScopes,
  ingestionRuns,
  offerTargets,
  physicalStores,
  priceCoverageChecks,
  priceObservations,
  productFamilies,
  productFamilyMemberships,
  productIdentifiers,
  publicationCaptures,
  publications,
  reviewActions,
  reviewedFamilyAliases,
  reviewedFamilyDefinitions,
  reviewedFamilyMembershipDecisions,
  sourceHealthSnapshots,
  sourcePermissions,
  sourceProducts,
  sourceRecordOutcomes,
  workerLeases,
  workerJobResults,
} from "./schema";

function checkNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).checks.map(({ name }) => name).sort();
}

describe("v1 evidence schema", () => {
  it("declares every durable evidence boundary", () => {
    expect(
      [
        dataSources,
        sourcePermissions,
        canonicalProducts,
        productIdentifiers,
        sourceProducts,
        productFamilies,
        productFamilyMemberships,
        familyTaxonomyVersions,
        reviewedFamilyDefinitions,
        reviewedFamilyAliases,
        reviewedFamilyMembershipDecisions,
        ingestionRuns,
        sourceRecordOutcomes,
        catalogObservations,
        priceObservations,
        priceCoverageChecks,
        geographicScopes,
        physicalStores,
        publications,
        publicationCaptures,
        extractionRuns,
        extractedOfferCandidates,
        approvedOffers,
        offerTargets,
        reviewActions,
        sourceHealthSnapshots,
        workerLeases,
        workerJobResults,
        alertEvents,
      ].map((table) => getTableConfig(table).name),
    ).toEqual([
      "data_sources",
      "source_permissions",
      "canonical_products",
      "product_identifiers",
      "source_products",
      "product_families",
      "product_family_memberships",
      "family_taxonomy_versions",
      "reviewed_family_definitions",
      "reviewed_family_aliases",
      "reviewed_family_membership_decisions",
      "ingestion_runs",
      "source_record_outcomes",
      "catalog_observations",
      "price_observations",
      "price_coverage_checks",
      "geographic_scopes",
      "physical_stores",
      "publications",
      "publication_captures",
      "extraction_runs",
      "extracted_offer_candidates",
      "approved_offers",
      "offer_targets",
      "review_actions",
      "source_health_snapshots",
      "worker_leases",
      "worker_job_results",
      "alert_events",
    ]);
  });

  it("maps immutable reviewed-family publications and provenance decisions", () => {
    const versionConfig = getTableConfig(familyTaxonomyVersions);
    const definitionConfig = getTableConfig(reviewedFamilyDefinitions);
    const aliasConfig = getTableConfig(reviewedFamilyAliases);
    const decisionConfig = getTableConfig(reviewedFamilyMembershipDecisions);

    expect(versionConfig.uniqueConstraints.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "family_taxonomy_versions_taxonomy_publication_unique",
        "family_taxonomy_versions_taxonomy_version_unique",
      ]),
    );
    expect(checkNames(familyTaxonomyVersions)).toEqual(
      expect.arrayContaining([
        "family_taxonomy_versions_alias_count_range",
        "family_taxonomy_versions_checksum_shape",
        "family_taxonomy_versions_contract_version",
        "family_taxonomy_versions_family_count_range",
        "family_taxonomy_versions_version_id_binding",
      ]),
    );
    expect(versionConfig.columns.find(({ name }) => name === "content_json")?.notNull).toBe(true);
    expect(definitionConfig.primaryKeys).toHaveLength(1);
    expect(definitionConfig.foreignKeys.map(({ reference }) => reference().name)).toContain(
      "reviewed_family_definitions_version_parent_fk",
    );
    expect(aliasConfig.primaryKeys).toHaveLength(1);
    expect(checkNames(reviewedFamilyAliases)).toContain(
      "reviewed_family_aliases_alias_shape",
    );
    expect(decisionConfig.indexes.map(({ config }) => config.name)).toContain(
      "reviewed_family_membership_decisions_latest_idx",
    );
    expect(checkNames(reviewedFamilyMembershipDecisions)).toEqual(
      expect.arrayContaining([
        "reviewed_family_membership_decisions_confidence_range",
        "reviewed_family_membership_decisions_decision",
        "reviewed_family_membership_decisions_method",
        "reviewed_family_membership_decisions_provenance",
      ]),
    );
  });

  it("keeps worker schedule outcomes append-only, bounded, and source scoped", () => {
    const config = getTableConfig(workerJobResults);

    expect(config.indexes.map(({ config: index }) => index.name)).toEqual(
      expect.arrayContaining([
        "worker_job_results_job_id_unique",
        "worker_job_results_source_kind_schedule_idx",
      ]),
    );
    expect(checkNames(workerJobResults)).toEqual(
      expect.arrayContaining([
        "worker_job_results_hash_shape",
        "worker_job_results_job_kind",
        "worker_job_results_status",
        "worker_job_results_time_range",
      ]),
    );
  });

  it("keeps source permission and coverage states fail closed", () => {
    expect(checkNames(dataSources)).toContain("data_sources_runtime_state");
    expect(checkNames(sourcePermissions)).toContain("source_permissions_decision");
    expect(checkNames(priceCoverageChecks)).toContain("price_coverage_checks_state");
  });

  it("records a database-owned public-state clock for every mutable eligibility row", () => {
    for (const table of [
      dataSources,
      canonicalProducts,
      productIdentifiers,
      geographicScopes,
    ]) {
      const config = getTableConfig(table);
      expect(config.columns.find(({ name }) => name === "public_state_changed_at")?.notNull)
        .toBe(true);
      expect(checkNames(table)).toContain(`${config.name}_public_state_clock`);
    }
  });

  it("gives scheduled runs stable job identities and audited outcome identities", () => {
    const runIndexes = getTableConfig(ingestionRuns).indexes.map(
      ({ config: index }) => index.name,
    );
    const outcomeConfig = getTableConfig(sourceRecordOutcomes);

    expect(runIndexes).toContain("ingestion_runs_job_id_unique");
    expect(getTableConfig(ingestionRuns).columns.find(({ name }) => name === "terminalized_at")?.notNull)
      .toBe(false);
    expect(checkNames(ingestionRuns)).toContain("ingestion_runs_terminalization_state");
    expect(outcomeConfig.uniqueConstraints.map(({ name }) => name)).toContain(
      "source_record_outcomes_run_kind_record_unique",
    );
    expect(outcomeConfig.columns.find(({ name }) => name === "created_at")?.notNull)
      .toBe(true);
    expect(checkNames(sourceRecordOutcomes)).toEqual(
      expect.arrayContaining([
        "source_record_outcomes_chain_supported",
        "source_record_outcomes_ean_shape",
        "source_record_outcomes_hash_shape",
        "source_record_outcomes_reason_state",
        "source_record_outcomes_state",
      ]),
    );
  });

  it("versions complete catalog payloads with separate retrieval and source clocks", () => {
    const config = getTableConfig(catalogObservations);

    expect(config.uniqueConstraints.map(({ name }) => name)).toContain(
      "catalog_observations_run_record_unique",
    );
    expect(config.indexes.map(({ config: index }) => index.name)).toEqual(
      expect.arrayContaining([
        "catalog_observations_gtin_retrieved_idx",
        "catalog_observations_product_retrieved_idx",
      ]),
    );
    expect(checkNames(catalogObservations)).toEqual(
      expect.arrayContaining([
        "catalog_observations_gtin_shape",
        "catalog_observations_hash_shape",
        "catalog_observations_source_time_order",
      ]),
    );
    expect(config.columns.find(({ name }) => name === "retrieved_at")?.notNull).toBe(true);
    expect(config.columns.find(({ name }) => name === "source_updated_at")?.notNull).toBe(false);
  });

  it("scopes canonical and source-owned product identifiers independently", () => {
    const config = getTableConfig(productIdentifiers);

    expect(checkNames(productIdentifiers)).toContain(
      "product_identifiers_source_scope",
    );
    expect(config.indexes.map(({ config: index }) => index.name)).toEqual(
      expect.arrayContaining([
        "product_identifiers_gtin_value_unique",
        "product_identifiers_source_value_unique",
      ]),
    );
    expect(config.uniqueConstraints.map(({ name }) => name)).not.toContain(
      "product_identifiers_scheme_value_unique",
    );
  });

  it("protects package, money, confidence, and validity arithmetic", () => {
    expect(checkNames(canonicalProducts)).toEqual(
      expect.arrayContaining([
        "canonical_products_package_amount_positive",
        "canonical_products_package_unit",
        "canonical_products_units_per_pack_positive",
      ]),
    );
    expect(checkNames(priceObservations)).toEqual(
      expect.arrayContaining([
        "price_observations_amount_ore_nonnegative",
        "price_observations_chain_supported",
        "price_observations_confidence_range",
        "price_observations_evidence_level",
      ]),
    );
    expect(checkNames(approvedOffers)).toEqual(
      expect.arrayContaining([
        "approved_offers_amount_ore_nonnegative",
        "approved_offers_before_amount_ore_nonnegative",
        "approved_offers_chain_supported",
        "approved_offers_valid_range",
      ]),
    );
  });

  it("keeps captures private-by-default and reviews append-only", () => {
    expect(checkNames(publicationCaptures)).toContain(
      "publication_captures_rights_classification",
    );
    expect(checkNames(reviewActions)).toContain("review_actions_action");
  });

  it("requires stable offer identities for concurrent approval convergence", () => {
    const offerConfig = getTableConfig(approvedOffers);
    const reviewConfig = getTableConfig(reviewActions);

    expect(offerConfig.columns.find(({ name }) => name === "offer_key")?.notNull).toBe(true);
    expect(offerConfig.indexes.map(({ config }) => config.name)).toContain(
      "approved_offers_candidate_unique",
    );
    expect(reviewConfig.uniqueConstraints.map(({ name }) => name)).toContain(
      "review_actions_candidate_version_unique",
    );
  });
});
