import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = fileURLToPath(new URL(
  "../../../deploy/migrations/025_private_review_evidence_renderer.sql",
  import.meta.url,
));
const runner = fileURLToPath(new URL("../../../deploy/migrate.mjs", import.meta.url));
const repository = fileURLToPath(new URL("./review-queue.ts", import.meta.url));
const compose = fileURLToPath(new URL(
  "../../../deploy/compose.production.yml",
  import.meta.url,
));

describe("private review evidence renderer database boundary", () => {
  it("records only append-only, candidate-bound render and one-time consumption facts", async () => {
    const source = await readFile(migration, "utf8");

    expect(source).toContain("create table public.private_review_evidence_renders");
    expect(source).toContain("create table public.private_review_evidence_consumptions");
    expect(source).toContain("private_review_evidence_renders_append_only");
    expect(source).toContain("private_review_evidence_consumptions_append_only");
    expect(source).toContain("decision_boundary_version in (1, 2)");
    expect(source).toContain("handleplan.review_decision_boundary_version");
    expect(source).toContain("private_review_decide_v1 action insert drifted");
    expect(source).toContain("before update or delete");
    expect(source).toContain("evidence_proof_sha256 char(64) not null unique");
    expect(source).not.toMatch(/\b(raw_token|proof_token|blob_bytes|capture_bytes)\b/iu);
    expect(source).toContain("presentation = 'full_capture'");
    expect(source).toContain("rights_classification in ('private_review', 'public_display')");
    expect(source).toContain("mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')");
    expect(source).toContain("byte_length between 1 and 52428800");
    // COALESCE/NULLIF/GREATEST/LEAST are PostgreSQL special syntax, not
    // schema-qualified functions. Guard the exact PG16 apply failure that
    // previously escaped text-only migration assertions.
    expect(source).not.toMatch(
      /pg_catalog\.(?:coalesce|nullif|greatest|least)\s*\(/iu,
    );
  });

  it("rechecks current candidate rights and exact checksum/reference before issuing a render receipt", async () => {
    const source = await readFile(migration, "utf8");
    const record = source.slice(source.indexOf(
      "create function public.private_review_record_evidence_render_v1(",
    ), source.indexOf("do $private_review_enable_renderer$"));

    expect(record).toContain("security definer");
    expect(record).toContain("set search_path = pg_catalog, pg_temp");
    expect(record).toContain("for update of candidate");
    expect(record).toContain("pg_catalog.pg_advisory_xact_lock");
    expect(record).toContain("public.private_review_candidate_rows_v1(");
    expect(record).toContain("p_capture_checksum is distinct from v_candidate.capture_checksum");
    expect(record).toContain("p_crop_reference is distinct from v_expected_crop_reference");
    expect(record).toContain("p_rights_classification is distinct from v_candidate.rights_classification");
    expect(record).toContain("{candidate,provenance,evidenceLocator}");
    expect(record).toContain("p_expires_at > v_render_now + interval '125 seconds'");
    expect(record).toContain("HP_REVIEW_EVIDENCE_UNAVAILABLE");
    expect(record).not.toMatch(/\bupdate\s+public\./iu);
    expect(record).not.toMatch(/\bdelete\s+from\s+public\./iu);
  });

  it("allows approval only through v2 with an unexpired, unconsumed candidate/version/session proof", async () => {
    const source = await readFile(migration, "utf8");
    const decision = source.slice(source.indexOf("create function public.private_review_decide_v2("));

    expect(source).toContain("private_review_decide_v1 evidence block drifted");
    expect(source).toContain("handleplan.review_evidence_authorized");
    expect(decision).toContain("for update");
    expect(decision).toContain("v_render.candidate_id is distinct from p_candidate_id");
    expect(decision).toContain("v_render.expected_version is distinct from p_expected_version");
    expect(decision).toContain("v_render.actor_id is distinct from p_actor_id");
    expect(decision).toContain("v_render.reviewer_session_id is distinct from p_reviewer_session_id");
    expect(decision).toContain("v_render.expires_at <= v_decision_now");
    expect(decision).toContain("private_review_evidence_consumptions consumption");
    expect(decision).toContain("insert into public.private_review_evidence_consumptions");
    expect(decision).toContain("set_config('handleplan.review_decision_boundary_version', '2', true)");
    expect(decision.indexOf("private_review_evidence_consumptions consumption"))
      .toBeLessThan(decision.indexOf("public.private_review_decide_v1("));
    expect(decision.indexOf("public.private_review_decide_v1("))
      .toBeLessThan(decision.indexOf("insert into public.private_review_evidence_consumptions"));
    expect(decision).toContain("p_action = 'reject' and p_evidence_proof_sha256 is not null");
  });

  it("keeps the review role EXECUTE-only on v2 and gives only review a read-only capture mount", async () => {
    const [source, migrationRunner, repo, deployment] = await Promise.all([
      readFile(migration, "utf8"),
      readFile(runner, "utf8"),
      readFile(repository, "utf8"),
      readFile(compose, "utf8"),
    ]);

    expect(source).toContain("revoke all privileges on all tables in schema public from handleplan_review");
    expect(source).toContain("revoke all privileges on all sequences in schema public from handleplan_review");
    expect(source).toContain("revoke all privileges on all functions in schema public from handleplan_review");
    expect(source).toContain("grant execute on function public.private_review_record_evidence_render_v1(");
    expect(source).toContain("grant execute on function public.private_review_decide_v2(");
    expect(source).not.toMatch(/grant execute on function public\.private_review_decide_v1[\s\S]*to handleplan_review/iu);
    expect(migrationRunner).toContain("privateReviewEvidenceRendererEnabled");
    expect(migrationRunner).toContain("grant execute on function public.private_review_decide_v2(");
    expect(repo).toContain("public.private_review_record_evidence_render_v1(");
    expect(repo).toContain("public.private_review_decide_v2(");
    expect(repo).not.toMatch(/insert into public\.private_review_evidence/iu);

    const app = deployment.match(/  app:\n([\s\S]*?)\n  review:/u)?.[1] ?? "";
    const review = deployment.match(/  review:\n([\s\S]*?)\n  worker:/u)?.[1] ?? "";
    const worker = deployment.match(/  worker:\n([\s\S]*?)\nnetworks:/u)?.[1] ?? "";
    expect(review).toContain("REVIEW_EVIDENCE_PROOF_SECRET");
    expect(review).toContain("REVIEW_PRIVATE_CAPTURE_ROOT");
    expect(review).toMatch(/source: private-captures[\s\S]*read_only: true/u);
    expect(worker).toMatch(/source: private-captures[\s\S]*read_only: false/u);
    expect(app).not.toContain("private-captures");
    expect(app).not.toContain("REVIEW_EVIDENCE_PROOF_SECRET");
  });
});
