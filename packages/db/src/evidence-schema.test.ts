import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  alertEvents,
  approvedOffers,
  canonicalProducts,
  dataSources,
  extractedOfferCandidates,
  extractionRuns,
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
  sourceHealthSnapshots,
  sourcePermissions,
  sourceProducts,
  workerLeases,
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
        ingestionRuns,
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
      "ingestion_runs",
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
      "alert_events",
    ]);
  });

  it("keeps source permission and coverage states fail closed", () => {
    expect(checkNames(dataSources)).toContain("data_sources_runtime_state");
    expect(checkNames(sourcePermissions)).toContain("source_permissions_decision");
    expect(checkNames(priceCoverageChecks)).toContain("price_coverage_checks_state");
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
