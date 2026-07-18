import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = fileURLToPath(new URL(
  "../../../deploy/migrations/021_private_review_decision_boundary.sql",
  import.meta.url,
));
const migrationRunner = fileURLToPath(new URL(
  "../../../deploy/migrate.mjs",
  import.meta.url,
));
const repository = fileURLToPath(new URL("./review-queue.ts", import.meta.url));
const runtimeRoleProof = fileURLToPath(new URL(
  "../../../tests/acceptance/prove-runtime-database-role.mjs",
  import.meta.url,
));

describe("private review database decision boundary", () => {
  it("centralizes every eligibility read under current persisted permission semantics", async () => {
    const source = await readFile(migration, "utf8");

    expect(source).toContain("create function public.private_review_candidate_rows_v1(");
    expect(source).toContain("security definer");
    expect(source).toContain("set search_path = pg_catalog, pg_temp");
    expect(source).toContain("current_permission.created_at <= v_database_now");
    expect(source).toContain(
      "order by current_permission.created_at desc, current_permission.id desc",
    );
    expect(source).not.toMatch(
      /where current_permission\.source_id[\s\S]{0,200}current_permission\.reviewed_at\s*<=/iu,
    );
    expect(source).toContain("permission.created_at <= p_evaluation_as_of");
    expect(source).toContain("permission.reviewed_at <= p_evaluation_as_of");
    expect(source).toContain("permission.valid_until > p_evaluation_as_of");
    expect(source).toContain("permission.valid_until > v_database_now");
    expect(source).toContain("source.permission_reviewed_at = permission.reviewed_at");
    expect(source).toContain(
      "source.permission_expires_at is not distinct from permission.valid_until",
    );
    expect(source).toContain("publication.discovery_permission_id = permission.id");
    expect(source).toContain("capture.capture_permission_id = permission.id");
    expect(source).toContain("extraction.extraction_permission_id = permission.id");
    expect(source).toContain("extraction.ocr_permission_id = permission.id");
    expect(source).toContain("capture.capture_permission_capabilities");
    expect(source).toContain("extraction.permission_capabilities");
    expect(source).toContain(
      "candidate.normalized_fields #> '{candidate,geographicScope}'",
    );
    expect(source).toContain("= publication.declared_geographic_scope");
    expect(source).toContain("officialOfferCapabilities");
    expect(source).toContain("officialOfferRightsClassifications");
    expect(source).toContain("capture.rights_classification");
    expect(source).toContain('"privateReview": true');
    expect(source).toContain("scope.status = 'active'");
    expect(source).toContain("extraction.status in ('completed', 'degraded')");
    expect(source).toContain("not exists (");
    expect(source).toContain("from public.review_actions previous_action");
    for (const clock of [
      "source.created_at <= p_evaluation_as_of",
      "source.public_state_changed_at <= p_evaluation_as_of",
      "scope.created_at <= p_evaluation_as_of",
      "scope.public_state_changed_at <= p_evaluation_as_of",
      "publication.created_at <= p_evaluation_as_of",
      "publication.discovered_at <= p_evaluation_as_of",
      "capture.created_at <= p_evaluation_as_of",
      "capture.retrieved_at <= p_evaluation_as_of",
      "extraction.created_at <= p_evaluation_as_of",
      "extraction.completed_at <= p_evaluation_as_of",
      "extraction.source_completed_at <= p_evaluation_as_of",
      "candidate.created_at <= p_evaluation_as_of",
    ]) {
      expect(source).toContain(clock);
    }
  });

  it("locks, validates and appends one complete decision transaction", async () => {
    const source = await readFile(migration, "utf8");
    const decisionStart = source.indexOf("create function public.private_review_decide_v1(");
    const decision = source.slice(decisionStart);

    expect(decisionStart).toBeGreaterThan(0);
    expect(source).toContain("create trigger review_actions_z_decision_clock");
    expect(source).toContain("new.created_at := pg_catalog.clock_timestamp()");
    expect(source.indexOf("create trigger review_actions_z_decision_clock"))
      .toBeGreaterThan(source.indexOf("revoke all on function public.private_review_candidate_rows_v1"));
    expect(decision).toContain("security definer");
    expect(decision).toContain("set search_path = pg_catalog, pg_temp");
    expect(decision).toContain("pg_catalog.octet_length(p_reason) > 4000");
    expect(decision).toContain("pg_catalog.octet_length(p_membership_program_id) > 800");
    expect(decision).toContain("pg_catalog.octet_length(p_target_family_slug) > 320");
    expect(decision).toContain("pg_catalog.octet_length(channel) > 64");
    const stagedChannelShape = decision.indexOf(
      "if p_channels is not null then",
    );
    const firstChannelUnnest = decision.indexOf("pg_catalog.unnest(p_channels)");
    expect(stagedChannelShape).toBeGreaterThan(0);
    expect(decision.indexOf("pg_catalog.cardinality(p_channels)", stagedChannelShape))
      .toBeLessThan(firstChannelUnnest);
    expect(decision).toContain("for update of candidate");
    expect(decision).toContain("pg_catalog.pg_advisory_xact_lock");
    expect(decision).toContain("pg_catalog.hashtextextended(v_source_id, 7229164304)");
    expect(decision.indexOf("for update of candidate"))
      .toBeLessThan(decision.indexOf("pg_catalog.pg_advisory_xact_lock"));
    expect(decision.indexOf("pg_catalog.pg_advisory_xact_lock"))
      .toBeLessThan(decision.indexOf("public.private_review_candidate_rows_v1("));
    expect(decision).toContain("v_decision_now := pg_catalog.clock_timestamp()");
    expect(decision).toContain("HP_REVIEW_VERSION_CONFLICT");
    expect(decision).toContain("HP_REVIEW_DECISION_MISMATCH");
    expect(decision).toContain("HP_REVIEW_TARGET_NOT_FOUND");
    expect(decision).toContain("HP_REVIEW_EVIDENCE_UNAVAILABLE");
    expect(decision.indexOf("HP_REVIEW_EVIDENCE_UNAVAILABLE"))
      .toBeLessThan(decision.indexOf("insert into public.approved_offers"));
    expect(decision).toContain("p_action = 'approve'");
    expect(decision).toContain("'approve', 'correct_and_approve', 'reject'");
    expect(decision).toContain("p_target_kind <> 'exact-product'");
    expect(decision).toContain("p_target_family_slug is not null");
    expect(decision).not.toContain(
      "p_target_kind not in ('exact-product', 'reviewed-family')",
    );
    expect(decision).not.toContain("'kind', 'reviewed-family'");
    for (const requiredNullCheck of [
      "p_candidate_id is null",
      "p_expected_version is null",
      "p_action is null",
      "p_actor_id is null",
      "p_target_kind is null",
      "p_pricing_kind is null",
      "p_eligibility_kind is null",
      "p_valid_from is null",
      "p_valid_until is null",
      "p_channels is null",
      "p_multibuy_quantity is null",
      "p_multibuy_total_ore is null",
    ]) {
      expect(decision).toContain(requiredNullCheck);
    }
    expect(decision).toContain("p_before_price_ore < 0");
    expect(decision).toContain("pg_catalog.array_ndims(p_channels) is distinct from 1");
    expect(decision).toContain("p_membership_program_id is nfc normalized");
    expect(decision).toContain("pg_catalog.generate_series(");
    expect(decision.match(/pg_catalog\.ascii\(nullif\(/gu)).toHaveLength(4);
    expect(decision).toContain("> 65535");
    expect(decision).toContain("in (160, 5760, 8232, 8233, 8239, 8287, 12288)");
    expect(decision).toContain("between 8192 and 8202");
    expect(decision).toContain("2274");
    expect(decision).toContain("69821");
    expect(decision).not.toContain("69629");
    expect(decision).toContain("between 917536 and 917631");
    expect(decision).toContain("v_checksum_sum");
    expect(decision).toContain("pg_catalog.cardinality(v_product_ids) is distinct from 1");
    expect(decision).toContain("insert into public.approved_offers");
    expect(decision).toContain("insert into public.offer_targets");
    expect(decision).toContain("insert into public.offer_conditions");
    expect(decision).toContain("insert into public.review_actions");
    expect(decision).not.toMatch(
      /update\s+public\.(?:extracted_offer_candidates|publication_captures)/iu,
    );
    expect(decision).toContain("return query select");
  });

  it("removes direct write and sequence authority and grants only exact functions", async () => {
    const [source, runner, repo, proof] = await Promise.all([
      readFile(migration, "utf8"),
      readFile(migrationRunner, "utf8"),
      readFile(repository, "utf8"),
      readFile(runtimeRoleProof, "utf8"),
    ]);

    expect(source).toContain(
      "revoke all on function public.private_review_candidate_rows_v1(",
    );
    expect(source).toContain("revoke all on function public.private_review_decide_v1(");
    expect(source).toContain("do $private_review_upgrade_fail_closed$");
    expect(source).toContain(
      "revoke all privileges on all tables in schema public from handleplan_review",
    );
    expect(source).toContain(
      "revoke all privileges on all sequences in schema public from handleplan_review",
    );
    expect(source).toContain(
      "revoke all privileges on all functions in schema public from handleplan_review",
    );
    for (const legacyColumnAclTable of [
      "public.data_sources",
      "public.source_permissions",
      "public.geographic_scopes",
    ]) {
      expect(source).toContain(
        `) on table ${legacyColumnAclTable} from handleplan_review`,
      );
    }
    expect(source).toContain(
      "grant execute on function public.private_review_candidate_rows_v1(",
    );
    expect(source).toContain(
      "grant execute on function public.private_review_decide_v1(",
    );
    expect(runner).toContain("privateReviewDecisionBoundaryEnabled");
    expect(runner).toContain("revoke select (${identifiers(reviewDataSourceColumns)})");
    expect(runner).toContain("revoke select (${identifiers(reviewSourcePermissionColumns)})");
    expect(runner).toContain("revoke select (${identifiers(reviewGeographicScopeColumns)})");
    expect(runner).toContain(
      "grant execute on function public.private_review_candidate_rows_v1(",
    );
    expect(runner).toContain("grant execute on function public.private_review_decide_v1(");
    expect(repo.match(/public\.private_review_candidate_rows_v1\(/gu)).toHaveLength(3);
    expect(repo.match(/public\.private_review_decide_v2\(/gu)).toHaveLength(1);
    expect(repo).toContain("public.private_review_record_evidence_render_v1(");
    expect(repo).not.toMatch(/insert\s+into\s+(?:approved_offers|offer_targets|offer_conditions|review_actions)/iu);
    expect(repo).not.toContain(".$client.begin");
    expect(proof).toContain("review role must not insert approved offers directly");
    expect(proof).toContain("review role must not use review sequences directly");
    expect(proof).toContain("forged exact approval must be rejected by the decision boundary");
    expect(proof).toContain("review role must not invoke non-allowlisted functions");
    expect(proof).toContain("const reviewCandidateEnvelope = {");
    expect(proof).toContain('publicationRoute: "human-review-required"');
    expect(proof).toContain("ownershipAdmin.json(reviewCandidateEnvelope)");
  });
});
