import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createDatabase, type DatabaseConnection } from "@handleplan/db/client";
import { PostgresOperationsRuntimeReader } from "@handleplan/db/operations-runtime";
import { canonicalizeOperationsSourceRosterV1, operationsSourceRosterV1Schema } from "@handleplan/domain";

import { OperationsRuntimeService } from "./operations-runtime-service";
import { createOperationsPostgresReadinessCheck, createReviewPostgresReadinessCheck } from "./private-runtime-readiness";

const integration = process.env.RUN_PRIVATE_RUNTIME_DB_INTEGRATION === "1"
  ? describe.sequential : describe.skip;
const rosterContent = {
  entries: [{
    sourceId: "meny",
    requiredEvidenceSignals: ["ordinary-price" as const],
    requiredWorkerJobKinds: ["catalog-refresh" as const],
  }],
  version: "readiness-regression:v1",
};
const roster = operationsSourceRosterV1Schema.parse({
  ...rosterContent,
  contentSha256: createHash("sha256")
    .update(canonicalizeOperationsSourceRosterV1(rosterContent)).digest("hex"),
});

integration("private runtime readiness after all production migrations", () => {
  let admin: DatabaseConnection;
  let review: DatabaseConnection;
  let operations: DatabaseConnection;
  beforeAll(() => {
    const connect = (name: string) => {
      const url = process.env[name];
      if (!url) throw new Error(`${name} is required for the isolated database proof`);
      return createDatabase(url);
    };
    admin = connect("DATABASE_MIGRATION_URL");
    review = connect("REVIEW_DATABASE_URL");
    operations = connect("OPERATIONS_DATABASE_URL");
  });
  afterAll(async () => {
    await Promise.all([admin?.close(), review?.close(), operations?.close()]);
  });

  async function readiness() {
    const signal = new AbortController().signal;
    const service = new OperationsRuntimeService(
      new PostgresOperationsRuntimeReader(operations.db, roster),
    );
    return Promise.all([
      createReviewPostgresReadinessCheck(review.db)(signal),
      createOperationsPostgresReadinessCheck(operations.db, service, roster.contentSha256)(signal),
    ]);
  }

  async function withoutValidatedMarker(unvalidated: boolean) {
    const [before] = await admin.sql<{ definition: string }[]>`
      select pg_catalog.pg_get_constraintdef(oid) as definition
      from pg_catalog.pg_constraint
      where conrelid = 'public.private_review_evidence_renders'::regclass
        and conname = 'private_review_evidence_renders_supported_mime'
    `;
    if (!before) throw new Error("Current MIME marker is missing before the negative proof");
    await admin.sql`alter table public.private_review_evidence_renders
      drop constraint private_review_evidence_renders_supported_mime`;
    try {
      if (unvalidated) {
        await admin.sql.unsafe(`alter table public.private_review_evidence_renders
          add constraint private_review_evidence_renders_supported_mime ${before.definition} not valid`);
      }
      expect(await readiness()).toEqual([false, false]);
    } finally {
      if (unvalidated) {
        await admin.sql`alter table public.private_review_evidence_renders
          drop constraint private_review_evidence_renders_supported_mime`;
      }
      // Restore the actual catalog definition captured before this isolated mutation.
      await admin.sql.unsafe(`alter table public.private_review_evidence_renders
        add constraint private_review_evidence_renders_supported_mime ${before.definition}`);
    }
  }

  it("accepts the current schema using the actual review and operations roles", async () => {
    expect(await readiness()).toEqual([true, true]);
  });

  it("rejects a missing current MIME marker for both private runtimes", async () => {
    await withoutValidatedMarker(false);
  });

  it("rejects an unvalidated current MIME marker for both private runtimes", async () => {
    await withoutValidatedMarker(true);
  });
});
