import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseConnection } from "./client";
import { PostgresReviewedFamilyReader } from "./reviewed-family-reader";

const runDatabaseIntegration = process.env.RUN_DB_INTEGRATION === "1";
const nonce = `${Date.now()}-${process.pid}`;
const sourceId = `family-reader-${String(Date.now() % 1_000_000)}-${process.pid}`;
const now = Date.now();
const AT = new Date(now + 60_000);
const REVIEWED_AT = new Date(now - 10 * 60_000);
const RETRIEVED_AT = new Date(now - 2 * 60_000);
const COMPLETED_AT = new Date(now - 60_000);

function checksum(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function withCheckDigit(body: string): string {
  const weighted = [...body].reduce(
    (sum, digit, index) =>
      sum + Number(digit) * ((body.length - index) % 2 === 1 ? 3 : 1),
    0,
  );
  return `${body}${(10 - (weighted % 10)) % 10}`;
}

// Reserve the leading digit for this integration file so parallel Vitest files
// cannot manufacture the same valid GTIN from one process/millisecond nonce.
const nonceDigits = `2${String((Date.now() + process.pid) % 1_000_000).padStart(6, "0")}`;
const gtin13 = (variant: number) =>
  withCheckDigit(`704${nonceDigits}${String(variant).padStart(2, "0")}`);
const gtin8 = (variant: number) =>
  withCheckDigit(`${nonceDigits.slice(0, 5)}${String(variant).padStart(2, "0")}`);

function databaseDate(value: unknown): Date {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Reviewed-family integration fixture returned an invalid database timestamp");
  }
  return parsed;
}

describe.skipIf(!runDatabaseIntegration).sequential(
  "reviewed family reader integration",
  () => {
    let connection: DatabaseConnection;
    let reader: PostgresReviewedFamilyReader;
    let completedRunId: number;
    let runningRunId: number;

    const products = new Map<string, number>();
    const gtins = {
      aliasLarge: gtin8(2),
      aliasRepresentative: gtin13(1),
      candidate: gtin13(4),
      deterministic: gtin13(3),
      legacyOnly: gtin13(6),
      lowConfidence: gtin13(5),
      rejected: gtin13(7),
      running: gtin13(8),
    } as const;

    async function createProduct(key: string, displayName: string): Promise<number> {
      const [product] = await connection.sql`
        insert into canonical_products (
          display_name, package_amount, package_unit, units_per_pack, status
        ) values (${displayName}, 1, 'package', 1, 'active')
        returning id::integer as id
      `;
      if (typeof product?.id !== "number") throw new Error("Missing product fixture id");
      products.set(key, product.id);
      return product.id;
    }

    async function createRun(label: string, createdAt?: Date): Promise<number> {
      const [run] = await connection.sql`
        insert into ingestion_runs (
          job_id, source_id, run_type, status, started_at, completed_at, counts,
          created_at
        ) values (
          ${`${sourceId}:${label}:${nonce}`},
          ${sourceId},
          'catalog',
          'running',
          ${new Date(now - 5 * 60_000).toISOString()},
          null,
          '{}'::jsonb,
          coalesce(${createdAt?.toISOString() ?? null}::timestamptz, now())
        )
        returning id::integer as id
      `;
      if (typeof run?.id !== "number") throw new Error("Missing run fixture id");
      return run.id;
    }

    async function completeRun(runId: number): Promise<void> {
      await connection.sql`
        update ingestion_runs
        set status = 'completed',
            completed_at = ${COMPLETED_AT.toISOString()},
            counts = '{"accepted":8,"failed":0,"fetched":8,"persisted":8,"quarantined":0,"unknown":0}'::jsonb
        where id = ${runId}
      `;
    }

    async function observe(input: {
      displayName: string;
      gtin: string;
      productId: number;
      runId?: number;
      suffix: string;
      createdAt?: Date;
    }): Promise<void> {
      await connection.sql`
        insert into catalog_observations (
          ingestion_run_id, source_record_id, canonical_product_id, gtin,
          display_name, brand, package_amount, package_unit, units_per_pack,
          retrieved_at, source_updated_at, raw_record_hash, created_at
        ) values (
          ${input.runId ?? completedRunId},
          ${`family-reader:${nonce}:${input.suffix}`},
          ${input.productId},
          ${input.gtin},
          ${input.displayName},
          'Integration fixture',
          1000,
          'ml',
          1,
          ${RETRIEVED_AT.toISOString()},
          ${new Date(RETRIEVED_AT.getTime() - 60_000).toISOString()},
          ${input.suffix.slice(0, 1).padEnd(64, "a").replace(/[^0-9a-f]/g, "a")},
          coalesce(${input.createdAt?.toISOString() ?? null}::timestamptz, now())
        )
      `;
    }

    async function decide(input: {
      confidence?: number;
      decision: "approved" | "candidate" | "rejected";
      familyId: "family:kaffe" | "family:melk";
      method?: "deterministic_rule" | "human_review";
      productId: number;
      reviewedAt?: Date;
    }): Promise<void> {
      const method = input.method ?? "human_review";
      await connection.sql`
        insert into reviewed_family_membership_decisions (
          version_id, family_id, product_id, decision, method, confidence,
          reviewer_id, reviewed_at, rule_version
        ) values (
          'handleplan-reviewed-families@1.0.0',
          ${input.familyId},
          ${input.productId},
          ${input.decision},
          ${method},
          ${input.confidence ?? 100},
          ${method === "human_review" ? "integration-reviewer" : null},
          ${(input.reviewedAt ?? REVIEWED_AT).toISOString()},
          ${method === "deterministic_rule" ? "integration-rule@1" : null}
        )
      `;
    }

    beforeAll(async () => {
      if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is required when RUN_DB_INTEGRATION=1");
      }
      connection = createDatabase(process.env.DATABASE_URL);
      reader = new PostgresReviewedFamilyReader(connection.db);

      await connection.sql`
        insert into data_sources (
          id, display_name, source_kind, runtime_state,
          permission_reviewed_at, permission_expires_at
        ) values (
          ${sourceId},
          'Reviewed family integration catalog',
          'catalog',
          'approved',
          ${new Date(now - 30 * 60_000).toISOString()},
          ${new Date(now + 24 * 60 * 60_000).toISOString()}
        )
      `;
      await connection.sql`
        insert into source_permissions (
          source_id, decision, reviewed_at, valid_until,
          public_reference_url, permissions
        ) values (
          ${sourceId},
          'approved',
          ${new Date(now - 30 * 60_000).toISOString()},
          ${new Date(now + 24 * 60 * 60_000).toISOString()},
          'https://example.invalid/reviewed-family-fixture',
          '{"catalog":true}'::jsonb
        )
      `;

      completedRunId = await createRun("completed");
      runningRunId = await createRun("running");

      const alias = await createProduct("alias", `Alias milk ${nonce}`);
      const deterministic = await createProduct("deterministic", `Deterministic coffee ${nonce}`);
      const candidate = await createProduct("candidate", `Candidate milk ${nonce}`);
      const lowConfidence = await createProduct("lowConfidence", `Low confidence milk ${nonce}`);
      const legacyOnly = await createProduct("legacyOnly", `Legacy family milk ${nonce}`);
      const rejected = await createProduct("rejected", `Rejected milk ${nonce}`);
      const running = await createProduct("running", `Running catalog milk ${nonce}`);

      await observe({ displayName: `Alias milk ${nonce}`, gtin: gtins.aliasLarge, productId: alias, suffix: "b-alias" });
      await observe({ displayName: `Alias milk ${nonce}`, gtin: gtins.aliasRepresentative, productId: alias, suffix: "a-representative" });
      await observe({ displayName: `Deterministic coffee ${nonce}`, gtin: gtins.deterministic, productId: deterministic, suffix: "c-deterministic" });
      await observe({ displayName: `Candidate milk ${nonce}`, gtin: gtins.candidate, productId: candidate, suffix: "d-candidate" });
      await observe({ displayName: `Low confidence milk ${nonce}`, gtin: gtins.lowConfidence, productId: lowConfidence, suffix: "e-low" });
      await observe({ displayName: `Legacy family milk ${nonce}`, gtin: gtins.legacyOnly, productId: legacyOnly, suffix: "f-legacy" });
      await observe({ displayName: `Rejected milk ${nonce}`, gtin: gtins.rejected, productId: rejected, suffix: "a-rejected" });
      await observe({
        displayName: `Running catalog milk ${nonce}`,
        gtin: gtins.running,
        productId: running,
        runId: runningRunId,
        suffix: "b-running",
      });
      await completeRun(completedRunId);

      await decide({ decision: "approved", familyId: "family:melk", productId: alias });
      await decide({
        decision: "approved",
        familyId: "family:kaffe",
        method: "deterministic_rule",
        productId: deterministic,
      });
      await decide({
        decision: "approved",
        familyId: "family:melk",
        method: "deterministic_rule",
        productId: deterministic,
      });
      await decide({ decision: "candidate", familyId: "family:melk", productId: candidate });
      await decide({
        confidence: 99,
        decision: "approved",
        familyId: "family:melk",
        productId: lowConfidence,
      });
      await decide({
        decision: "approved",
        familyId: "family:melk",
        productId: rejected,
        reviewedAt: new Date(REVIEWED_AT.getTime() - 60_000),
      });
      await decide({
        decision: "rejected",
        familyId: "family:melk",
        productId: rejected,
      });
      await decide({ decision: "approved", familyId: "family:melk", productId: running });

      const legacySlug = `legacy-${String(Date.now() % 1_000_000)}-${process.pid}`;
      await connection.sql`
        insert into product_families (slug, label_no, status)
        values (${legacySlug}, ${`Legacy only ${nonce}`}, 'active')
      `;
      await connection.sql`
        insert into product_family_memberships (
          product_id, family_slug, confidence, method, review_state, reviewed_at
        ) values (
          ${legacyOnly}, ${legacySlug}, 100, 'human_review', 'approved', ${REVIEWED_AT.toISOString()}
        )
      `;
    });

    afterAll(async () => {
      await connection?.close();
    });

    it("admits only latest approved reviewed decisions and deterministic canonical representatives", async () => {
      const matches = await reader.getMany(["family:melk", "family:kaffe"], 20, AT);

      expect(matches).toHaveLength(3);
      expect(matches.map(({ family, product }) => [family.id, product.gtin])).toEqual([
        ["family:melk", gtins.aliasLarge],
        ["family:melk", gtins.deterministic],
        ["family:kaffe", gtins.deterministic],
      ]);
      expect(matches[2]).toMatchObject({
        canonicalProductId: `product:${products.get("deterministic")}`,
        family: { aliases: [], id: "family:kaffe" },
        membership: {
          method: "deterministic-rule",
          ruleVersion: "integration-rule@1",
        },
      });
      expect(matches[0]).toMatchObject({
        canonicalProductId: `product:${products.get("alias")}`,
        family: { aliases: ["mjølk"], id: "family:melk" },
        membership: { method: "human-review", reviewerAttested: true },
        taxonomy: {
          contentSha256: "1d917ee4268615ad510a622ea30d69977191cffc143313a7dbecbad37debf520",
          publishedAt: "2026-07-16T00:00:00.000Z",
          versionId: "handleplan-reviewed-families@1.0.0",
        },
      });
      expect(new Set(matches
        .filter(({ family }) => family.id === "family:melk")
        .map(({ canonicalProductId }) => canonicalProductId)).size).toBe(2);
      await expect(
        reader.getMany(["family:melk"], 1, AT),
      ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    });

    it("distinguishes known-empty, unknown, and not-yet-published family snapshots", async () => {
      await expect(
        reader.getSnapshots(["family:brod", "family:unknown"], 5, AT),
      ).resolves.toMatchObject([
        { complete: true, familyId: "family:brod", matches: [], state: "active" },
        { complete: false, familyId: "family:unknown", matches: [], state: "unknown" },
      ]);
      await expect(
        reader.getSnapshots(
          ["family:melk"],
          5,
          new Date("2026-07-15T23:59:59.999Z"),
        ),
      ).resolves.toEqual([
        { complete: false, familyId: "family:melk", matches: [], state: "unknown" },
      ]);
    });

    it("keeps reviewed-family snapshots closed against later backdated catalog completion", async () => {
      const runningProductId = products.get("running");
      if (runningProductId === undefined) throw new Error("Missing running product fixture");
      const snapshotAt = new Date(Date.now() - 100);
      const persistedAt = new Date(snapshotAt.getTime() - 1_000);
      const lateRunId = await createRun("late-backdated", persistedAt);
      await observe({
        createdAt: persistedAt,
        displayName: `Late backdated milk ${nonce}`,
        gtin: gtins.running,
        productId: runningProductId,
        runId: lateRunId,
        suffix: "c-late-running",
      });
      await completeRun(lateRunId);

      const matches = await reader.getMany(["family:melk"], 20, snapshotAt);
      expect(matches.map(({ product }) => product.gtin)).not.toContain(gtins.running);
      const [run] = await connection.sql`
        select terminalized_at > ${snapshotAt.toISOString()}::timestamptz as terminalized_later
        from ingestion_runs
        where id = ${lateRunId}
      `;
      expect(run?.terminalized_later).toBe(true);
    });

    it("database-stamps later membership decisions so old snapshots cannot gain matches", async () => {
      const candidateProductId = products.get("candidate");
      if (candidateProductId === undefined) throw new Error("Missing candidate product fixture");
      const [snapshotClock] = await connection.sql`
        select clock_timestamp() as snapshot_at
      `;
      const snapshotAt = databaseDate(snapshotClock!.snapshot_at);
      const baseline = await reader.getMany(["family:melk"], 20, snapshotAt);
      expect(baseline.map(({ canonicalProductId }) => canonicalProductId))
        .not.toContain(`product:${candidateProductId}`);

      const [decision] = await connection.sql`
        insert into reviewed_family_membership_decisions (
          version_id, family_id, product_id, decision, method, confidence,
          reviewer_id, reviewed_at, created_at
        ) values (
          'handleplan-reviewed-families@1.0.0', 'family:melk',
          ${candidateProductId}, 'approved', 'human_review', 100,
          'late-integration-reviewer',
          ${new Date(snapshotAt.getTime() - 1_000).toISOString()},
          '2000-01-01T00:00:00Z'
        )
        returning
          created_at,
          created_at > ${snapshotAt.toISOString()}::timestamptz as created_later
      `;
      expect(decision!.created_later).toBe(true);
      await expect(reader.getMany(["family:melk"], 20, snapshotAt)).resolves.toEqual(
        baseline,
      );
    });

    it("blocks current family eligibility on later future-dated and backdated source revocations", async () => {
      const [snapshotClock] = await connection.sql`
        select clock_timestamp() as snapshot_at
      `;
      const snapshotAt = databaseDate(snapshotClock!.snapshot_at);
      const baseline = await reader.getMany(["family:melk"], 20, snapshotAt);
      expect(baseline.length).toBeGreaterThan(0);

      const [futureRevocation] = await connection.sql`
        insert into source_permissions (
          source_id, decision, reviewed_at, valid_until, permissions, notes
        ) values (
          ${sourceId}, 'revoked',
          ${new Date(snapshotAt.getTime() + 24 * 60 * 60_000).toISOString()},
          null, '{}'::jsonb, ${`family-future-revocation-${nonce}`}
        )
        returning created_at > ${snapshotAt.toISOString()}::timestamptz as created_later
      `;
      expect(futureRevocation?.created_later).toBe(true);
      const [afterFutureClock] = await connection.sql`
        select clock_timestamp() + interval '1 millisecond' as current_at
      `;
      await expect(reader.getMany(
        ["family:melk"],
        20,
        databaseDate(afterFutureClock!.current_at),
      )).resolves.toEqual([]);

      const [revocation] = await connection.sql`
        insert into source_permissions (
          source_id, decision, reviewed_at, valid_until, permissions, notes,
          created_at
        ) values (
          ${sourceId}, 'revoked',
          ${new Date(now - 60 * 60_000).toISOString()}, null,
          '{}'::jsonb, ${`family-backdated-revocation-${nonce}`},
          '2000-01-01T00:00:00Z'
        )
        returning created_at > ${snapshotAt.toISOString()}::timestamptz as created_later
      `;
      expect(revocation?.created_later).toBe(true);
      await expect(reader.getMany(["family:melk"], 20, snapshotAt)).resolves.toEqual(
        baseline,
      );

      const [currentClock] = await connection.sql`
        select clock_timestamp() + interval '1 millisecond' as current_at
      `;
      await expect(reader.getMany(
        ["family:melk"],
        20,
        databaseDate(currentClock!.current_at),
      )).resolves.toEqual([]);

      await connection.sql.begin(async (transaction) => {
        const [restored] = await transaction`
          insert into source_permissions (
            source_id, decision, reviewed_at, valid_until, permissions, notes
          ) values (
            ${sourceId}, 'approved', clock_timestamp(),
            clock_timestamp() + interval '1 day', '{"catalog":true}'::jsonb,
            ${`family-restored-approval-${nonce}`}
          )
          returning reviewed_at, valid_until
        `;
        if (restored === undefined) throw new Error("Missing restored family permission");
        await transaction`
          update data_sources
          set permission_reviewed_at = ${restored.reviewed_at},
              permission_expires_at = ${restored.valid_until}
          where id = ${sourceId}
        `;
      });
    });

    it("enforces immutable provenance and seals published definition sets", async () => {
      const aliasProductId = products.get("alias");
      if (aliasProductId === undefined) throw new Error("Missing alias product fixture");
      await expect(
        connection.sql`
          insert into reviewed_family_membership_decisions (
            version_id, family_id, product_id, decision, method, confidence,
            reviewer_id, reviewed_at
          ) values (
            'handleplan-reviewed-families@1.0.0', 'family:melk', ${aliasProductId},
            'approved', 'human_review', 100, null, ${REVIEWED_AT.toISOString()}
          )
        `,
      ).rejects.toThrow();
      await expect(
        connection.sql`
          update reviewed_family_membership_decisions
          set decision = 'rejected'
          where version_id = 'handleplan-reviewed-families@1.0.0'
            and family_id = 'family:melk'
            and product_id = ${aliasProductId}
        `,
      ).rejects.toThrow(/append-only/i);
      await expect(
        connection.sql`
          insert into reviewed_family_definitions (
            version_id, family_id, slug, label_no, status
          ) values (
            'handleplan-reviewed-families@1.0.0', 'family:late', 'late', 'Late', 'active'
          )
        `,
      ).rejects.toThrow(/only be appended while creating their version/i);
      await expect(
        connection.sql`
          insert into reviewed_family_aliases (version_id, family_id, alias)
          values ('handleplan-reviewed-families@1.0.0', 'family:melk', 'sen melk')
        `,
      ).rejects.toThrow(/only be appended while creating their version/i);
    });

    it("rejects empty, subset, and content-mismatched taxonomy publications at commit", async () => {
      const publicationCases = [
        {
          content: [{
            aliases: [],
            id: "family:test-empty",
            labelNo: "Empty",
            slug: "test-empty",
            status: "active",
          }],
          definitions: [],
          suffix: 1,
        },
        {
          content: [
            {
              aliases: [],
              id: "family:test-subset-a",
              labelNo: "Subset A",
              slug: "test-subset-a",
              status: "active",
            },
            {
              aliases: [],
              id: "family:test-subset-b",
              labelNo: "Subset B",
              slug: "test-subset-b",
              status: "active",
            },
          ],
          definitions: [{
            id: "family:test-subset-a",
            labelNo: "Subset A",
            slug: "test-subset-a",
          }],
          suffix: 2,
        },
        {
          content: [{
            aliases: [],
            id: "family:test-mismatch",
            labelNo: "Expected label",
            slug: "test-mismatch",
            status: "active",
          }],
          definitions: [{
            id: "family:test-mismatch",
            labelNo: "Different label",
            slug: "test-mismatch",
          }],
          suffix: 3,
        },
      ] as const;

      for (const publication of publicationCases) {
        const taxonomyVersion = `91.0.${publication.suffix}`;
        const versionId = `handleplan-reviewed-families@${taxonomyVersion}`;
        await expect(connection.sql.begin(async (transaction) => {
          await transaction`
            insert into family_taxonomy_versions (
              version_id, taxonomy_id, taxonomy_version, contract_version,
              published_at, content_sha256, content_json,
              expected_family_count, expected_alias_count
            ) values (
              ${versionId}, 'handleplan-reviewed-families', ${taxonomyVersion}, 1,
              ${new Date(Date.now() - 1_000).toISOString()},
              ${checksum(publication.content)},
              ${JSON.stringify(publication.content)}::jsonb,
              ${publication.content.length}, 0
            )
          `;
          for (const definition of publication.definitions) {
            await transaction`
              insert into reviewed_family_definitions (
                version_id, family_id, slug, label_no, status
              ) values (
                ${versionId}, ${definition.id}, ${definition.slug},
                ${definition.labelNo}, 'active'
              )
            `;
          }
        })).rejects.toThrow(/does not match its sealed content/i);
      }
    });
  },
);
