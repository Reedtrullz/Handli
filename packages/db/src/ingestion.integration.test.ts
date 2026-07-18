import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DrizzleQueryError } from "drizzle-orm";

import { createDatabase, type DatabaseConnection } from "./client";
import {
  IngestionOutcomeConflictError,
  PostgresIngestionRepository,
  type CatalogIngestionOutcome,
  type IngestionFenceVerifier,
  type IngestionRunHandle,
  type PhysicalStoreIngestionOutcome,
  type PriceIngestionOutcome,
  type SourceRecordOutcomeInput,
} from "./ingestion";
import { SOURCE_GOVERNANCE_ADVISORY_LOCK_SEED } from "./source-governance-lock";

const runDatabaseIntegration = process.env.RUN_DB_INTEGRATION === "1";
const nonce = `${process.pid}-${Date.now()}`;
const now = new Date("2026-07-16T12:00:00.000Z");

function expectSameInstant(actual: unknown, expected: Date): void {
  const parsed = actual instanceof Date ? actual : new Date(String(actual));
  expect(Number.isFinite(parsed.getTime())).toBe(true);
  expect(parsed.toISOString()).toBe(expected.toISOString());
}

function databaseDate(value: unknown): Date {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Ingestion integration fixture returned an invalid database timestamp");
  }
  return parsed;
}

function gtin13(variant: number): string {
  const digits = String(Date.now() % 100_000_000).padStart(8, "0");
  const body = `704${digits}${variant}`;
  let sum = 0;
  for (let index = body.length - 1, position = 1; index >= 0; index -= 1, position += 1) {
    sum += Number(body[index]) * (position % 2 === 1 ? 3 : 1);
  }
  return `${body}${(10 - (sum % 10)) % 10}`;
}

async function waitForAdvisoryLockWaiters(
  observer: DatabaseConnection,
  holderPid: number,
  expectedCount: number,
): Promise<number[]> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [state] = await observer.sql`
      select
        count(distinct waiting.pid)::integer as waiter_count,
        coalesce(
          array_agg(distinct waiting.pid order by waiting.pid)
            filter (where waiting.pid is not null),
          array[]::integer[]
        ) as waiter_pids
      from pg_catalog.pg_locks waiting
      inner join pg_catalog.pg_locks held
        on held.locktype = waiting.locktype
       and held.database is not distinct from waiting.database
       and held.classid = waiting.classid
       and held.objid = waiting.objid
       and held.objsubid = waiting.objsubid
      where waiting.locktype = 'advisory'
        and not waiting.granted
        and held.granted
        and held.pid = ${holderPid}
        and waiting.pid <> held.pid
    `;
    if (
      typeof state?.waiter_count === "number"
      && state.waiter_count >= expectedCount
      && Array.isArray(state.waiter_pids)
    ) {
      return state.waiter_pids.map(Number);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected ${expectedCount} transaction(s) to wait on the held advisory lock`);
}

async function waitForAdvisoryLockWaiter(
  observer: DatabaseConnection,
  holderPid: number,
): Promise<number> {
  const [waitingPid] = await waitForAdvisoryLockWaiters(observer, holderPid, 1);
  if (waitingPid === undefined) {
    throw new Error("Expected transaction did not wait on the held advisory lock");
  }
  return waitingPid;
}

type GovernanceRace = "kill-switch-only" | "permission-only";

describe.skipIf(!runDatabaseIntegration).sequential(
  "PostgresIngestionRepository integration",
  () => {
    let connection: DatabaseConnection;
    let contender: DatabaseConnection;
    let repository: PostgresIngestionRepository;
    let scopeId: number;
    const fenceCalls: string[] = [];

    const verifyFence: IngestionFenceVerifier = async (transaction, context, phase) => {
      await transaction.execute("select 1");
      if (context.fenceToken !== `fence-${nonce}`) {
        throw new Error("stale ingestion fence");
      }
      fenceCalls.push(`${context.jobId}:${context.ingestionRunId ?? "begin"}:${phase}`);
    };

    async function beginRun(
      label: string,
      runType = "integration",
      sourceId = "kassalapp",
    ): Promise<IngestionRunHandle> {
      const begun = await repository.beginRun({
        fenceToken: `fence-${nonce}`,
        jobId: `integration-${nonce}-${label}`,
        runType,
        sourceId,
        startedAt: now,
      });
      expect(begun.created).toBe(true);
      return begun.handle;
    }

    async function seedApprovedSource(
      sourceId: string,
      label: string,
      sourceKind: "catalog" | "ordinary_price" | "store",
      permissions: Readonly<Record<string, true>>,
    ): Promise<void> {
      await connection.sql`
        insert into data_sources (
          id, display_name, source_kind, runtime_state,
          permission_reviewed_at, permission_expires_at
        ) values (
          ${sourceId}, ${label}, ${sourceKind}, 'approved',
          '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z'
        )
      `;
      await connection.sql`
        insert into source_permissions (
          source_id, decision, reviewed_at, valid_until, permissions, notes
        ) values (
          ${sourceId}, 'approved', '2026-01-01T00:00:00Z',
          '2099-01-01T00:00:00Z', ${JSON.stringify(permissions)}::jsonb,
          ${`ingestion-approved-${sourceId}`}
        )
      `;
    }

    async function seedApprovedCatalogSource(
      sourceId: string,
      label: string,
    ): Promise<void> {
      await seedApprovedSource(sourceId, label, "catalog", { catalog: true });
    }

    async function approveExistingSource(
      sourceId: string,
      permissions: Readonly<Record<string, true>>,
    ): Promise<void> {
      await connection.sql.begin(async (transaction) => {
        const [permission] = await transaction`
          insert into source_permissions (
            source_id, decision, reviewed_at, valid_until, permissions, notes
          ) values (
            ${sourceId}, 'approved', clock_timestamp(),
            clock_timestamp() + interval '1 day', ${JSON.stringify(permissions)}::jsonb,
            ${`ingestion-race-approved-${sourceId}-${nonce}`}
          )
          returning reviewed_at, valid_until
        `;
        if (permission === undefined) throw new Error("Missing source approval fixture");
        await transaction`
          update data_sources
          set runtime_state = 'approved',
              permission_reviewed_at = ${permission.reviewed_at},
              permission_expires_at = ${permission.valid_until},
              kill_switch_reason = null
          where id = ${sourceId}
        `;
      });
    }

    async function racePersistenceAgainstGovernance<T>(
      sourceId: string,
      governanceRace: GovernanceRace,
      mutate: () => Promise<T>,
    ): Promise<T> {
      let releaseGovernance!: () => void;
      const governanceMayCommit = new Promise<void>((resolve) => {
        releaseGovernance = resolve;
      });
      let signalGovernanceReady!: (holderPid: number) => void;
      let signalGovernanceFailure!: (error: unknown) => void;
      const governanceReady = new Promise<number>((resolve, reject) => {
        signalGovernanceReady = resolve;
        signalGovernanceFailure = reject;
      });
      const governance = contender.sql.begin(async (transaction) => {
        const [session] = await transaction`
          select pg_backend_pid()::integer as holder_pid
        `;
        if (typeof session?.holder_pid !== "number") {
          throw new Error("Missing governance lock holder PID");
        }
        if (governanceRace === "permission-only") {
          // The INSERT trigger, not this test, acquires the shared governance
          // lock and stamps persistence order after serialization.
          await transaction`
            insert into source_permissions (
              source_id, decision, reviewed_at, permissions, notes
            ) values (
              ${sourceId}, 'revoked', '2098-01-01T00:00:00Z', '{}'::jsonb,
              ${`ingestion-future-revoked-${sourceId}-${nonce}`}
            )
          `;
        } else {
          // The UPDATE trigger independently acquires the same lock for a
          // runtime kill switch without appending a permission decision.
          await transaction`
            update data_sources
            set runtime_state = 'revoked',
                kill_switch_reason = 'concurrent ingestion governance race proof'
            where id = ${sourceId}
          `;
        }
        signalGovernanceReady(session.holder_pid);
        await governanceMayCommit;
      });
      void governance.catch(signalGovernanceFailure);

      const holderPid = await governanceReady;
      const mutation = mutate();
      let waitError: unknown;
      try {
        await waitForAdvisoryLockWaiter(connection, holderPid);
      } catch (error) {
        waitError = error;
      } finally {
        releaseGovernance();
      }
      await governance;
      const result = await mutation;
      if (waitError !== undefined) throw waitError;
      const [boundary] = await connection.sql`
        select
          source.runtime_state,
          permission.decision,
          permission.reviewed_at > clock_timestamp() as permission_future
        from data_sources source
        inner join lateral (
          select decision, reviewed_at
          from source_permissions
          where source_id = source.id
          order by created_at desc, id desc
          limit 1
        ) permission on true
        where source.id = ${sourceId}
      `;
      expect(boundary).toMatchObject(
        governanceRace === "permission-only"
          ? {
              decision: "revoked",
              permission_future: true,
              runtime_state: "approved",
            }
          : {
              decision: "approved",
              permission_future: false,
              runtime_state: "revoked",
            },
      );
      return result;
    }

    beforeAll(async () => {
      if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is required when RUN_DB_INTEGRATION=1");
      }
      connection = createDatabase(process.env.DATABASE_URL);
      contender = createDatabase(process.env.DATABASE_URL);
      repository = new PostgresIngestionRepository(connection.db, { verifyFence });

      const [scope] = await connection.sql`
        insert into geographic_scopes (scope_key, scope_kind, label)
        values (${`ingestion-integration-${nonce}`}, 'national', 'Ingestion integration')
        on conflict (scope_key) do update set label = excluded.label
        returning id::integer as id
      `;
      scopeId = scope!.id;
      await connection.sql.begin(async (transaction) => {
        const [permission] = await transaction`
          insert into source_permissions (
            source_id, decision, reviewed_at, valid_until, permissions, notes
          ) values (
            'kassalapp', 'approved', clock_timestamp(),
            clock_timestamp() + interval '1 day',
            '{"catalog":true,"ordinaryPrice":true,"priceHistory":true,"physicalStore":true}'::jsonb,
            ${`ingestion-integration-approved-${nonce}`}
          )
          returning reviewed_at, valid_until
        `;
        if (permission === undefined) {
          throw new Error("Missing ingestion integration source permission");
        }
        await transaction`
          update data_sources
          set runtime_state = 'approved',
              permission_reviewed_at = ${permission.reviewed_at},
              permission_expires_at = ${permission.valid_until},
              kill_switch_reason = null
          where id = 'kassalapp'
        `;
      });
    });

    afterAll(async () => {
      if (connection !== undefined) {
        await connection.sql`
          update data_sources
          set runtime_state = 'conditional',
              permission_reviewed_at = null,
              permission_expires_at = null
          where id = 'kassalapp'
        `;
      }
      await Promise.all([connection?.close(), contender?.close()]);
    });

    it("converges duplicate job starts and rejects a conflicting job identity", async () => {
      const input = {
        fenceToken: `fence-${nonce}`,
        jobId: `integration-${nonce}-idempotency`,
        runType: "catalog",
        sourceId: "kassalapp",
        startedAt: now,
      } as const;

      const first = await repository.beginRun(input);
      const duplicate = await repository.beginRun(input);

      expect(first.created).toBe(true);
      expect(duplicate).toMatchObject({ created: false, handle: { id: first.handle.id } });
      await expect(
        repository.beginRun({ ...input, runType: "prices" }),
      ).rejects.toThrow(/job identity/i);

      const rows = await connection.sql`
        select id from ingestion_runs where job_id = ${input.jobId}
      `;
      expect(rows).toHaveLength(1);
      const idempotencyFenceCalls = fenceCalls.filter((call) => call.startsWith(input.jobId));
      expect(idempotencyFenceCalls).toHaveLength(5);
      expect(idempotencyFenceCalls.filter((call) => call.endsWith(":initial"))).toHaveLength(3);
      expect(idempotencyFenceCalls.filter((call) => call.endsWith(":before-commit")))
        .toHaveLength(2);
    });

    it("audits all outcomes append-only, detects conflicting replay, and reconstructs counters", async () => {
      const handle = await beginRun("audit");
      const outcomes: SourceRecordOutcomeInput[] = [
        {
          outcomeState: "accepted",
          recordKind: "product",
          recordedAt: now,
          sourceRecordId: `accepted-${nonce}`,
          subjectEan: gtin13(0),
        },
        {
          normalizedRecord: { rawEan: "invalid" },
          outcomeState: "quarantined",
          reason: "INVALID_GTIN",
          recordKind: "product",
          recordedAt: now,
          sourceRecordId: `quarantined-${nonce}`,
        },
        {
          outcomeState: "unknown",
          rawChainCode: "UNKNOWN_CHAIN",
          reason: "UNSUPPORTED_CHAIN",
          recordKind: "price",
          recordedAt: now,
          sourceRecordId: `unknown-${nonce}`,
        },
      ];

      await expect(repository.auditOutcomes(handle, outcomes)).resolves.toEqual({
        inserted: 3,
        received: 3,
      });
      await expect(repository.auditOutcomes(handle, outcomes)).resolves.toEqual({
        inserted: 0,
        received: 3,
      });
      await expect(
        repository.auditOutcomes(handle, [
          { ...outcomes[1]!, normalizedRecord: { rawEan: "different" } },
        ]),
      ).rejects.toBeInstanceOf(IngestionOutcomeConflictError);

      const finalized = await repository.finalizeRun(handle, {
        completedAt: new Date("2026-07-16T12:05:00.000Z"),
        errorClass: "PARTIAL_SOURCE_FAILURE",
        failed: 2,
        status: "degraded",
      });
      expect(finalized).toEqual({
        counts: {
          accepted: 1,
          failed: 2,
          fetched: 3,
          persisted: 3,
          quarantined: 1,
          unknown: 1,
        },
        status: "degraded",
      });
      const [terminalClock] = await connection.sql`
        select created_at, completed_at, terminalized_at
        from ingestion_runs
        where id = ${handle.id}
      `;
      const terminalizedAt = databaseDate(terminalClock?.terminalized_at);
      const createdAt = databaseDate(terminalClock?.created_at);
      const completedAt = databaseDate(terminalClock?.completed_at);
      expect(terminalizedAt.getTime()).toBeGreaterThanOrEqual(createdAt.getTime());
      expect(terminalizedAt.getTime()).toBeGreaterThanOrEqual(completedAt.getTime());
    });

    it("canonicalizes catalog records only by exact valid GTIN", async () => {
      const handle = await beginRun("catalog", "catalog");
      const sharedEan = gtin13(1);
      const sameNameDifferentEan = gtin13(2);
      const outcomes: CatalogIngestionOutcome[] = [
        {
          outcomeState: "accepted",
          product: {
            brand: "Testbrand",
            categoryPath: [
              { depth: 1, name: "Meieri", sourceCategoryId: "10" },
              { depth: 2, name: "Melk", sourceCategoryId: "20" },
            ],
            displayName: "Exact milk",
            retrievedAt: now,
            sourceUpdatedAt: new Date("2026-07-16T11:55:00.000Z"),
            packageAmount: 1_000,
            packageUnit: "ml",
            unitsPerPack: 1,
          },
          recordKind: "product",
          recordedAt: now,
          sourceRecordId: `catalog-a-${nonce}`,
          subjectEan: sharedEan,
        },
        {
          outcomeState: "accepted",
          product: {
            displayName: "Completely different name",
            retrievedAt: now,
            packageAmount: 1_000,
            packageUnit: "ml",
          },
          recordKind: "product",
          recordedAt: now,
          sourceRecordId: `catalog-b-${nonce}`,
          subjectEan: sharedEan,
        },
        {
          outcomeState: "accepted",
          product: {
            displayName: "Exact milk",
            retrievedAt: now,
            packageAmount: 1_000,
            packageUnit: "ml",
          },
          recordKind: "product",
          recordedAt: now,
          sourceRecordId: `catalog-c-${nonce}`,
          subjectEan: sameNameDifferentEan,
        },
      ];

      await expect(repository.persistCatalogOutcomes(handle, outcomes)).resolves.toEqual({
        inserted: 3,
        received: 3,
      });

      const products = await connection.sql`
        select pi.value, pi.product_id, pi.verified_at, cp.display_name, cp.status
        from product_identifiers pi
        join canonical_products cp on cp.id = pi.product_id
        where pi.value in (${sharedEan}, ${sameNameDifferentEan})
          and pi.scheme in ('ean8', 'ean13')
        order by pi.value
      `;
      expect(products).toHaveLength(2);
      expect(products.find(({ value }) => value === sharedEan)).toMatchObject({
        display_name: "Exact milk",
        status: "active",
      });
      expect(products.find(({ value }) => value === sharedEan)!.verified_at).not.toBeNull();
      expect(new Set(products.map(({ product_id: productId }) => productId)).size).toBe(2);

      const catalogEvidence = await connection.sql`
        select source_record_id, category_path, display_name, retrieved_at, source_updated_at
        from catalog_observations
        where ingestion_run_id = ${handle.id}
        order by source_record_id
      `;
      expect(catalogEvidence.map(({ display_name: displayName, source_record_id: sourceRecordId }) =>
        ({ displayName, sourceRecordId }))).toEqual([
        { displayName: "Exact milk", sourceRecordId: `catalog-a-${nonce}` },
        { displayName: "Exact milk", sourceRecordId: `catalog-c-${nonce}` },
      ]);
      expectSameInstant(catalogEvidence[0]!.retrieved_at, now);
      expectSameInstant(
        catalogEvidence[0]!.source_updated_at,
        new Date("2026-07-16T11:55:00.000Z"),
      );
      expect(catalogEvidence[1]!.source_updated_at).toBeNull();
      expect(catalogEvidence[0]!.category_path).toEqual([
        { depth: 1, name: "Meieri", sourceCategoryId: "10" },
        { depth: 2, name: "Melk", sourceCategoryId: "20" },
      ]);
      expect(catalogEvidence[1]!.category_path).toBeNull();

      const sourceLinks = await connection.sql`
        select external_id, canonical_product_id, normalized_fields->'categoryPath' as category_path
        from source_products
        where source_id = 'kassalapp'
          and external_id in (${`catalog-a-${nonce}`}, ${`catalog-b-${nonce}`})
        order by external_id
      `;
      expect(sourceLinks).toEqual([{
        category_path: [
          { depth: 1, name: "Meieri", sourceCategoryId: "10" },
          { depth: 2, name: "Melk", sourceCategoryId: "20" },
        ],
        canonical_product_id: products.find(({ value }) => value === sharedEan)!.product_id,
        external_id: `catalog-a-${nonce}`,
      }]);
      const [unmatchedCorrection] = await connection.sql`
        select outcome_state, reason, normalized_record->>'displayName' as proposed_name
        from source_record_outcomes
        where ingestion_run_id = ${handle.id}
          and source_record_id = ${`catalog-b-${nonce}`}
      `;
      expect(unmatchedCorrection).toEqual({
        outcome_state: "quarantined",
        proposed_name: "Completely different name",
        reason: "CATALOG_CORRECTION_REVIEW_REQUIRED",
      });

      const originalCatalog = outcomes[0]!;
      if (originalCatalog.outcomeState !== "accepted") {
        throw new Error("Expected accepted catalog integration fixture");
      }
      const olderHandle = await beginRun("catalog-older", "catalog");
      await repository.persistCatalogOutcomes(olderHandle, [
        {
          ...originalCatalog,
          product: {
            ...originalCatalog.product,
            displayName: "Older stale name",
            retrievedAt: new Date("2026-07-15T12:00:00.000Z"),
            sourceUpdatedAt: new Date("2026-07-15T11:55:00.000Z"),
          },
        },
      ]);
      const [sourceAfterOlderReplay] = await connection.sql`
        select last_seen_at, normalized_fields->>'displayName' as display_name
        from source_products
        where source_id = 'kassalapp'
          and external_id = ${`catalog-a-${nonce}`}
      `;
      expect(sourceAfterOlderReplay).toMatchObject({ display_name: "Exact milk" });
      expectSameInstant(sourceAfterOlderReplay!.last_seen_at, now);

      await expect(
        repository.persistCatalogOutcomes(handle, [
          {
            ...outcomes[0]!,
            sourceRecordId: `invalid-gtin-${nonce}`,
            subjectEan: "7038010000011",
          },
        ]),
      ).rejects.toThrow(/valid GTIN/i);
    });

    it.each<GovernanceRace>(["permission-only", "kill-switch-only"])(
      "applies only newer same-source corrections and quarantines after a concurrent %s governance change",
      async (governanceRace) => {
      const sourceId = `catalog-correction-${governanceRace}-${nonce}`;
      const ean = gtin13(governanceRace === "permission-only" ? 8 : 9);
      const externalId = `trusted-correction-${governanceRace}-${nonce}`;
      await seedApprovedCatalogSource(sourceId, "Catalog correction integration");

      const initialHandle = await beginRun(
        `catalog-correction-initial-${governanceRace}`,
        "catalog",
        sourceId,
      );
      await repository.persistCatalogOutcomes(initialHandle, [{
        outcomeState: "accepted",
        product: {
          brand: "Trusted brand",
          displayName: "Trusted product 500 g",
          retrievedAt: new Date("2026-07-14T12:05:00.000Z"),
          sourceUpdatedAt: new Date("2026-07-14T12:00:00.000Z"),
          packageAmount: 500,
          packageUnit: "g",
        },
        recordKind: "product",
        recordedAt: now,
        sourceRecordId: externalId,
        subjectEan: ean,
      }]);
      await repository.finalizeRun(initialHandle, {
        completedAt: now,
        status: "completed",
      });

      const correctedHandle = await beginRun(
        `catalog-correction-newer-${governanceRace}`,
        "catalog",
        sourceId,
      );
      await repository.persistCatalogOutcomes(correctedHandle, [{
        outcomeState: "accepted",
        product: {
          brand: "Trusted brand",
          displayName: "Trusted product 750 g",
          retrievedAt: new Date("2026-07-16T12:05:00.000Z"),
          sourceUpdatedAt: new Date("2026-07-16T12:00:00.000Z"),
          packageAmount: 750,
          packageUnit: "g",
        },
        recordKind: "product",
        recordedAt: now,
        sourceRecordId: externalId,
        subjectEan: ean,
      }]);

      const [corrected] = await connection.sql`
        select product.display_name, product.package_amount, product.package_unit,
               product.updated_at, source.last_seen_at,
               outcome.outcome_state, outcome.reason
        from product_identifiers identifier
        inner join canonical_products product on product.id = identifier.product_id
        inner join source_products source
          on source.canonical_product_id = product.id
         and source.source_id = ${sourceId}
         and source.external_id = ${externalId}
        inner join source_record_outcomes outcome
          on outcome.ingestion_run_id = ${correctedHandle.id}
         and outcome.source_record_id = ${externalId}
        where identifier.value = ${ean}
          and identifier.scheme = 'ean13'
      `;
      expect(corrected).toMatchObject({
        display_name: "Trusted product 750 g",
        outcome_state: "accepted",
        package_amount: 750,
        package_unit: "g",
        reason: null,
      });
      expectSameInstant(corrected!.last_seen_at, new Date("2026-07-16T12:05:00.000Z"));
      expectSameInstant(corrected!.updated_at, new Date("2026-07-16T12:05:00.000Z"));

      const revokedHandle = await beginRun(
        `catalog-correction-revoked-${governanceRace}`,
        "catalog",
        sourceId,
      );
      const revokedOutcome: CatalogIngestionOutcome = {
        outcomeState: "accepted",
        product: {
          brand: "Untrusted brand",
          displayName: "Must remain in review",
          retrievedAt: new Date("2026-07-17T12:05:00.000Z"),
          sourceUpdatedAt: new Date("2026-07-17T12:00:00.000Z"),
          packageAmount: 1,
          packageUnit: "package",
        },
        recordKind: "product",
        recordedAt: now,
        sourceRecordId: externalId,
        subjectEan: ean,
      };

      await racePersistenceAgainstGovernance(
        sourceId,
        governanceRace,
        () => repository.persistCatalogOutcomes(revokedHandle, [revokedOutcome]),
      );

      const [afterRevocation] = await connection.sql`
        select product.display_name, product.package_amount, product.package_unit,
               source.last_seen_at, outcome.outcome_state, outcome.reason,
               outcome.normalized_record->>'displayName' as proposed_name,
               permission.created_at <= outcome.created_at as permission_preceded_outcome,
               governed_source.runtime_state as source_runtime_state
        from product_identifiers identifier
        inner join canonical_products product on product.id = identifier.product_id
        inner join source_products source
          on source.canonical_product_id = product.id
         and source.source_id = ${sourceId}
         and source.external_id = ${externalId}
        inner join data_sources governed_source on governed_source.id = source.source_id
        inner join source_record_outcomes outcome
          on outcome.ingestion_run_id = ${revokedHandle.id}
         and outcome.source_record_id = ${externalId}
        inner join lateral (
          select created_at
          from source_permissions
          where source_id = ${sourceId}
          order by created_at desc, id desc
          limit 1
        ) permission on true
        where identifier.value = ${ean}
          and identifier.scheme = 'ean13'
      `;
      expect(afterRevocation).toMatchObject({
        display_name: "Trusted product 750 g",
        outcome_state: "quarantined",
        package_amount: 750,
        package_unit: "g",
        proposed_name: "Must remain in review",
        permission_preceded_outcome: true,
        reason: "CATALOG_CORRECTION_REVIEW_REQUIRED",
        source_runtime_state: governanceRace === "permission-only" ? "approved" : "revoked",
      });
      expectSameInstant(
        afterRevocation!.last_seen_at,
        new Date("2026-07-16T12:05:00.000Z"),
      );
      },
    );

    it.each<GovernanceRace>(["permission-only", "kill-switch-only"])(
      "keeps a quarantined canonical unchanged when activation loses a %s governance race",
      async (governanceRace) => {
      const sourceId = `catalog-activation-${governanceRace}-${nonce}`;
      const ean = gtin13(governanceRace === "permission-only" ? 4 : 3);
      const externalId = `activation-${governanceRace}-${nonce}`;
      await seedApprovedCatalogSource(sourceId, "Catalog activation integration");
      const [product] = await connection.sql`
        insert into canonical_products (
          display_name, brand, package_amount, package_unit,
          units_per_pack, status, updated_at
        ) values (
          'Quarantined original', 'Original brand', 250, 'g', 1,
          'quarantined', '2026-07-15T12:00:00Z'
        )
        returning id::integer as id
      `;
      if (typeof product?.id !== "number") throw new Error("Missing activation product");
      await connection.sql`
        insert into product_identifiers (
          product_id, scheme, value, confidence, verified_at
        ) values (
          ${product.id}, 'ean13', ${ean}, 100, '2026-07-15T12:00:00Z'
        )
      `;

      const handle = await beginRun(
        `catalog-activation-race-${governanceRace}`,
        "catalog",
        sourceId,
      );
      await racePersistenceAgainstGovernance(
        sourceId,
        governanceRace,
        () => repository.persistCatalogOutcomes(handle, [{
          outcomeState: "accepted",
          product: {
            brand: "Proposed brand",
            displayName: "Proposed activated product",
            packageAmount: 500,
            packageUnit: "g",
            retrievedAt: new Date("2026-07-17T12:05:00.000Z"),
            sourceUpdatedAt: new Date("2026-07-17T12:00:00.000Z"),
          },
          recordKind: "product",
          recordedAt: now,
          sourceRecordId: externalId,
          subjectEan: ean,
        }]),
      );

      const [result] = await connection.sql`
        select product.display_name, product.brand, product.package_amount,
          product.package_unit, product.status,
          outcome.outcome_state, outcome.reason,
          (select count(*)::integer from source_products
           where source_id = ${sourceId}) as source_product_count,
          (select count(*)::integer from catalog_observations
           where ingestion_run_id = ${handle.id}) as observation_count
        from canonical_products product
        inner join source_record_outcomes outcome
          on outcome.ingestion_run_id = ${handle.id}
         and outcome.source_record_id = ${externalId}
        where product.id = ${product.id}
      `;
      expect(result).toMatchObject({
        brand: "Original brand",
        display_name: "Quarantined original",
        observation_count: 0,
        outcome_state: "quarantined",
        package_amount: 250,
        package_unit: "g",
        reason: "CATALOG_CORRECTION_REVIEW_REQUIRED",
        source_product_count: 0,
        status: "quarantined",
      });
      },
    );

    it.each<GovernanceRace>(["permission-only", "kill-switch-only"])(
      "creates only a quarantined review record when a new product loses a %s governance race",
      async (governanceRace) => {
      const sourceId = `catalog-new-product-${governanceRace}-${nonce}`;
      const ean = gtin13(governanceRace === "permission-only" ? 5 : 6);
      const externalId = `new-product-${governanceRace}-${nonce}`;
      await seedApprovedCatalogSource(sourceId, "Catalog new-product integration");
      const handle = await beginRun(
        `catalog-new-product-race-${governanceRace}`,
        "catalog",
        sourceId,
      );

      await racePersistenceAgainstGovernance(
        sourceId,
        governanceRace,
        () => repository.persistCatalogOutcomes(handle, [{
          outcomeState: "accepted",
          product: {
            brand: "Proposed brand",
            displayName: "Proposed new product",
            packageAmount: 750,
            packageUnit: "g",
            retrievedAt: new Date("2026-07-17T12:05:00.000Z"),
            sourceUpdatedAt: new Date("2026-07-17T12:00:00.000Z"),
          },
          recordKind: "product",
          recordedAt: now,
          sourceRecordId: externalId,
          subjectEan: ean,
        }]),
      );

      const [result] = await connection.sql`
        select outcome.outcome_state, outcome.reason,
          (select count(*)::integer
           from product_identifiers identifier
           where identifier.value = ${ean}
             and identifier.scheme = 'ean13') as identifier_count,
          (select count(*)::integer from source_products
           where source_id = ${sourceId}) as source_product_count,
          (select count(*)::integer from catalog_observations
           where ingestion_run_id = ${handle.id}) as observation_count
        from source_record_outcomes outcome
        where outcome.ingestion_run_id = ${handle.id}
          and outcome.source_record_id = ${externalId}
      `;
      expect(result).toMatchObject({
        identifier_count: 0,
        observation_count: 0,
        outcome_state: "quarantined",
        reason: "CATALOG_CORRECTION_REVIEW_REQUIRED",
        source_product_count: 0,
      });
      },
    );

    it.each<GovernanceRace>(["permission-only", "kill-switch-only"])(
      "does not verify a matching active GTIN after a concurrent %s governance change",
      async (governanceRace) => {
      const sourceId = `catalog-identifier-${governanceRace}-${nonce}`;
      const ean = gtin13(7);
      const externalId = `identifier-${governanceRace}-${nonce}`;
      await seedApprovedCatalogSource(sourceId, "Catalog identifier integration");
      const [product] = await connection.sql`
        insert into canonical_products (
          display_name, brand, package_amount, package_unit,
          units_per_pack, status, updated_at
        ) values (
          'Existing exact product', 'Existing brand', 1, 'package', 1,
          'active', '2026-07-15T12:00:00Z'
        )
        returning id::integer as id
      `;
      if (typeof product?.id !== "number") throw new Error("Missing identifier product");
      await connection.sql`
        insert into product_identifiers (
          product_id, scheme, value, confidence, verified_at
        ) values (
          ${product.id}, 'ean13', ${ean}, 0, null
        )
      `;

      const handle = await beginRun(
        `catalog-identifier-race-${governanceRace}`,
        "catalog",
        sourceId,
      );
      await racePersistenceAgainstGovernance(
        sourceId,
        governanceRace,
        () => repository.persistCatalogOutcomes(handle, [{
          outcomeState: "accepted",
          product: {
            brand: "Existing brand",
            categoryPath: [{ depth: 1, name: "Private proposal", sourceCategoryId: "91" }],
            displayName: "Existing exact product",
            packageAmount: 1,
            packageUnit: "package",
            retrievedAt: new Date("2026-07-17T12:05:00.000Z"),
            sourceUpdatedAt: new Date("2026-07-17T12:00:00.000Z"),
          },
          recordKind: "product",
          recordedAt: now,
          sourceRecordId: externalId,
          subjectEan: ean,
        }]),
      );

      const [result] = await connection.sql`
        select identifier.confidence, identifier.verified_at,
          outcome.outcome_state, outcome.reason,
          (select count(*)::integer from source_products
           where source_id = ${sourceId}) as source_product_count,
          (select count(*)::integer from catalog_observations
           where ingestion_run_id = ${handle.id}) as observation_count
        from product_identifiers identifier
        inner join source_record_outcomes outcome
          on outcome.ingestion_run_id = ${handle.id}
         and outcome.source_record_id = ${externalId}
        where identifier.product_id = ${product.id}
          and identifier.value = ${ean}
      `;
      expect(result).toEqual({
        confidence: 0,
        observation_count: 0,
        outcome_state: "quarantined",
        reason: "CATALOG_CORRECTION_REVIEW_REQUIRED",
        source_product_count: 0,
        verified_at: null,
      });
      },
    );

    it("pre-acquires sorted GTIN locks so reversed cross-source catalog batches cannot deadlock", async () => {
      const firstSourceId = `catalog-lock-a-${nonce}`;
      const secondSourceId = `catalog-lock-b-${nonce}`;
      await seedApprovedCatalogSource(firstSourceId, "Catalog lock order A");
      await seedApprovedCatalogSource(secondSourceId, "Catalog lock order B");
      const firstHandle = await beginRun(
        "catalog-lock-order-a",
        "catalog",
        firstSourceId,
      );
      const secondHandle = await beginRun(
        "catalog-lock-order-b",
        "catalog",
        secondSourceId,
      );
      const contenderRepository = new PostgresIngestionRepository(contender.db, {
        verifyFence,
      });
      const [firstGtin, secondGtin] = [gtin13(0), gtin13(1)].sort();
      if (firstGtin === undefined || secondGtin === undefined) {
        throw new Error("Missing catalog lock-order GTIN fixture");
      }
      const outcome = (
        gtin: string,
        sourceRecordId: string,
      ): CatalogIngestionOutcome => ({
        outcomeState: "accepted",
        product: {
          brand: "Lock order",
          displayName: `Lock order product ${gtin}`,
          packageAmount: 1,
          packageUnit: "package",
          retrievedAt: new Date("2026-07-17T12:05:00.000Z"),
          sourceUpdatedAt: new Date("2026-07-17T12:00:00.000Z"),
        },
        recordKind: "product",
        recordedAt: now,
        sourceRecordId,
        subjectEan: gtin,
      });

      let releaseBlocker!: () => void;
      const blockerMayCommit = new Promise<void>((resolve) => {
        releaseBlocker = resolve;
      });
      let signalBlockerReady!: (holderPid: number) => void;
      let signalBlockerFailure!: (error: unknown) => void;
      const blockerReady = new Promise<number>((resolve, reject) => {
        signalBlockerReady = resolve;
        signalBlockerFailure = reject;
      });
      const blocker = contender.sql.begin(async (transaction) => {
        const [session] = await transaction`
          select pg_backend_pid()::integer as holder_pid
        `;
        if (typeof session?.holder_pid !== "number") {
          throw new Error("Missing GTIN lock holder PID");
        }
        await transaction`
          select pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended(${firstGtin}, 0)
          )
        `;
        signalBlockerReady(session.holder_pid);
        await blockerMayCommit;
      });
      void blocker.catch(signalBlockerFailure);

      const holderPid = await blockerReady;
      const pending: Promise<unknown>[] = [];
      let proofError: unknown;
      try {
        const firstBatch = repository.persistCatalogOutcomes(firstHandle, [
          outcome(firstGtin, `lock-a-first-${nonce}`),
          outcome(secondGtin, `lock-a-second-${nonce}`),
        ]);
        pending.push(firstBatch);
        void firstBatch.catch(() => undefined);
        await waitForAdvisoryLockWaiters(connection, holderPid, 1);

        const reversedBatch = contenderRepository.persistCatalogOutcomes(secondHandle, [
          outcome(secondGtin, `lock-b-second-${nonce}`),
          outcome(firstGtin, `lock-b-first-${nonce}`),
        ]);
        pending.push(reversedBatch);
        void reversedBatch.catch(() => undefined);
        await waitForAdvisoryLockWaiters(connection, holderPid, 2);
      } catch (error) {
        proofError = error;
      } finally {
        releaseBlocker();
      }
      await blocker;
      const settled = await Promise.allSettled(pending);
      if (proofError !== undefined) throw proofError;
      expect(settled).toEqual([
        { status: "fulfilled", value: { inserted: 2, received: 2 } },
        { status: "fulfilled", value: { inserted: 2, received: 2 } },
      ]);
      const [counts] = await connection.sql`
        select
          (select count(*)::integer
             from source_products
            where source_id in (${firstSourceId}, ${secondSourceId})) as source_products,
          (select count(*)::integer
             from source_record_outcomes
            where ingestion_run_id in (${firstHandle.id}, ${secondHandle.id})) as outcomes
      `;
      expect(counts).toEqual({ outcomes: 4, source_products: 4 });
    });

    it.each<"price-price" | "catalog-price">(["price-price", "catalog-price"])(
      "pre-acquires one sorted GTIN order for reversed cross-source %s batches",
      async (pair) => {
        const firstSourceId = `${pair}-lock-a-${nonce}`;
        const secondSourceId = `${pair}-lock-b-${nonce}`;
        if (pair === "catalog-price") {
          await seedApprovedSource(
            firstSourceId,
            "Catalog/price lock order catalog",
            "catalog",
            { catalog: true },
          );
        } else {
          await seedApprovedSource(
            firstSourceId,
            "Price lock order A",
            "ordinary_price",
            { ordinaryPrice: true },
          );
        }
        await seedApprovedSource(
          secondSourceId,
          "Price lock order B",
          "ordinary_price",
          { ordinaryPrice: true },
        );
        const firstHandle = await beginRun(
          `${pair}-lock-order-a`,
          pair === "catalog-price" ? "catalog" : "benchmark-prices",
          firstSourceId,
        );
        const secondHandle = await beginRun(
          `${pair}-lock-order-b`,
          "benchmark-prices",
          secondSourceId,
        );
        const contenderRepository = new PostgresIngestionRepository(contender.db, {
          verifyFence,
        });
        const [firstGtin, secondGtin] = [gtin13(1), gtin13(2)].sort();
        if (firstGtin === undefined || secondGtin === undefined) {
          throw new Error("Missing cross-kind lock-order GTIN fixture");
        }
        const priceOutcome = (
          gtin: string,
          sourceRecordId: string,
          sourceReference: string,
        ): PriceIngestionOutcome => ({
          outcomeState: "accepted",
          price: {
            amountOre: 2_490,
            fetchedAt: now,
            observedAt: now,
            sourceReference,
          },
          recordKind: "price",
          recordedAt: now,
          sourceRecordId,
          subjectChain: "extra",
          subjectEan: gtin,
        });
        const catalogOutcome = (
          gtin: string,
          sourceRecordId: string,
        ): CatalogIngestionOutcome => ({
          outcomeState: "accepted",
          product: {
            displayName: `Cross-kind lock product ${gtin}`,
            packageAmount: 1,
            packageUnit: "package",
            retrievedAt: now,
          },
          recordKind: "product",
          recordedAt: now,
          sourceRecordId,
          subjectEan: gtin,
        });

        let releaseBlocker!: () => void;
        const blockerMayCommit = new Promise<void>((resolve) => {
          releaseBlocker = resolve;
        });
        let signalBlockerReady!: (holderPid: number) => void;
        let signalBlockerFailure!: (error: unknown) => void;
        const blockerReady = new Promise<number>((resolve, reject) => {
          signalBlockerReady = resolve;
          signalBlockerFailure = reject;
        });
        const blocker = contender.sql.begin(async (transaction) => {
          const [session] = await transaction`
            select pg_backend_pid()::integer as holder_pid
          `;
          if (typeof session?.holder_pid !== "number") {
            throw new Error("Missing cross-kind GTIN lock holder PID");
          }
          await transaction`
            select pg_catalog.pg_advisory_xact_lock(
              pg_catalog.hashtextextended(${firstGtin}, 0)
            )
          `;
          signalBlockerReady(session.holder_pid);
          await blockerMayCommit;
        });
        void blocker.catch(signalBlockerFailure);

        const holderPid = await blockerReady;
        const pending: Promise<unknown>[] = [];
        let proofError: unknown;
        try {
          const firstBatch = pair === "catalog-price"
            ? repository.persistCatalogOutcomes(firstHandle, [
                catalogOutcome(firstGtin, `${pair}-a-first-${nonce}`),
                catalogOutcome(secondGtin, `${pair}-a-second-${nonce}`),
              ])
            : repository.persistPriceOutcomes(firstHandle, [
                priceOutcome(
                  firstGtin,
                  `${pair}-a-first-${nonce}`,
                  `${pair}:a:first:${nonce}`,
                ),
                priceOutcome(
                  secondGtin,
                  `${pair}-a-second-${nonce}`,
                  `${pair}:a:second:${nonce}`,
                ),
              ]);
          pending.push(firstBatch);
          void firstBatch.catch(() => undefined);
          await waitForAdvisoryLockWaiters(connection, holderPid, 1);

          const reversedBatch = contenderRepository.persistPriceOutcomes(secondHandle, [
            priceOutcome(
              secondGtin,
              `${pair}-b-second-${nonce}`,
              `${pair}:b:second:${nonce}`,
            ),
            priceOutcome(
              firstGtin,
              `${pair}-b-first-${nonce}`,
              `${pair}:b:first:${nonce}`,
            ),
          ]);
          pending.push(reversedBatch);
          void reversedBatch.catch(() => undefined);
          await waitForAdvisoryLockWaiters(connection, holderPid, 2);
        } catch (error) {
          proofError = error;
        } finally {
          releaseBlocker();
        }
        await blocker;
        const settled = await Promise.allSettled(pending);
        if (proofError !== undefined) throw proofError;
        expect(settled).toEqual([
          { status: "fulfilled", value: { inserted: 2, received: 2 } },
          { status: "fulfilled", value: { inserted: 2, received: 2 } },
        ]);
        const [counts] = await connection.sql`
          select count(*)::integer as outcomes
          from source_record_outcomes
          where ingestion_run_id in (${firstHandle.id}, ${secondHandle.id})
        `;
        expect(counts).toEqual({ outcomes: 4 });
      },
    );

    it("atomically audits known prices into evidence, coverage, and the legacy cache", async () => {
      const handle = await beginRun("prices", "benchmark-prices");
      const ean = gtin13(3);
      const acceptedPrice: Extract<
        PriceIngestionOutcome,
        { outcomeState: "accepted" }
      > = {
        outcomeState: "accepted",
        price: {
          amountOre: 2_490,
          fetchedAt: new Date("2026-07-16T12:01:00.000Z"),
          geographicScopeId: scopeId,
          observedAt: now,
          sourceReference: `integration:${nonce}`,
        },
        recordKind: "price",
        recordedAt: now,
        sourceRecordId: `price-accepted-${nonce}`,
        subjectChain: "extra",
        subjectEan: ean,
      };
      const outcomes: PriceIngestionOutcome[] = [
        acceptedPrice,
        {
          geographicScopeId: scopeId,
          outcomeState: "unknown",
          rawChainCode: "COOP_MEGA",
          reason: "UNSUPPORTED_CHAIN",
          recordKind: "price",
          recordedAt: now,
          sourceRecordId: `price-unknown-chain-${nonce}`,
          subjectEan: ean,
        },
        {
          geographicScopeId: scopeId,
          outcomeState: "unknown",
          reason: "PRICE_UNAVAILABLE",
          recordKind: "price",
          recordedAt: now,
          sourceRecordId: `price-known-unavailable-${nonce}`,
          subjectChain: "extra",
          subjectEan: ean,
        },
      ];

      await expect(repository.persistPriceOutcomes(handle, outcomes)).resolves.toEqual({
        inserted: 3,
        received: 3,
      });

      const [counts] = await connection.sql`
        select
          (select count(*)::integer from source_record_outcomes where ingestion_run_id = ${handle.id}) as outcomes,
          (select count(*)::integer from price_observations where ingestion_run_id = ${handle.id}) as observations,
          (select count(*)::integer from price_coverage_checks where ingestion_run_id = ${handle.id}) as coverage,
          (select count(*)::integer from price_cache where ean = ${ean} and chain = 'extra') as cache
      `;
      expect(counts).toEqual({ cache: 1, coverage: 1, observations: 1, outcomes: 3 });

      const [coverage] = await connection.sql`
        select state, reason
        from price_coverage_checks
        where ingestion_run_id = ${handle.id}
      `;
      expect(coverage).toEqual({ reason: "source_price_observed", state: "priced" });

      const [evidence] = await connection.sql`
        select evidence_level, confidence, claim_eligibility, source_reference
        from price_observations
        where ingestion_run_id = ${handle.id}
      `;
      expect(evidence).toEqual({
        claim_eligibility: "ordinary_only",
        confidence: 100,
        evidence_level: "chain",
        source_reference: `integration:${nonce}`,
      });

      const rollbackRecordId = `price-rollback-${nonce}`;
      await expect(
        repository.persistPriceOutcomes(handle, [
          {
            ...acceptedPrice,
            price: { ...acceptedPrice.price, geographicScopeId: 2_147_483_647 },
            sourceRecordId: rollbackRecordId,
          },
        ]),
      ).rejects.toThrow();
      const [rollback] = await connection.sql`
        select count(*)::integer as count
        from source_record_outcomes
        where ingestion_run_id = ${handle.id} and source_record_id = ${rollbackRecordId}
      `;
      expect(rollback!.count).toBe(0);

      const historicalHandle = await beginRun("historical-prices", "historical-prices");
      await expect(repository.persistPriceOutcomes(historicalHandle, [{
        ...acceptedPrice,
        price: {
          ...acceptedPrice.price,
          sourceReference: `historical-integration:${nonce}`,
        },
        sourceRecordId: `historical-price-accepted-${nonce}`,
      }])).resolves.toEqual({ inserted: 1, received: 1 });

      const eligibility = await connection.sql`
        select run.run_type, observation.claim_eligibility
        from price_observations observation
        inner join ingestion_runs run on run.id = observation.ingestion_run_id
        where run.id in (${handle.id}, ${historicalHandle.id})
        order by run.run_type
      `;
      expect(eligibility).toEqual([
        { claim_eligibility: "ordinary_only", run_type: "benchmark-prices" },
        { claim_eligibility: "historical_eligible", run_type: "historical-prices" },
      ]);
      const [historicalProjectionCounts] = await connection.sql`
        select
          (select count(*)::integer
             from price_coverage_checks
            where ingestion_run_id = ${historicalHandle.id}) as coverage,
          (select count(*)::integer
             from price_observations
            where ingestion_run_id = ${historicalHandle.id}
              and claim_eligibility = 'historical_eligible') as history
      `;
      expect(historicalProjectionCounts).toEqual({ coverage: 0, history: 1 });
    });

    it("requires the exact price capability and rejects unknown price run types", async () => {
      const sourceId = `price-capability-${nonce}`;
      const ean = gtin13(6);
      await seedApprovedSource(
        sourceId,
        "Exact price capability integration",
        "ordinary_price",
        { ordinaryPrice: true },
      );
      const outcome: PriceIngestionOutcome = {
        outcomeState: "accepted",
        price: {
          amountOre: 2_990,
          fetchedAt: now,
          observedAt: now,
          sourceReference: `exact-price-capability:${nonce}`,
        },
        recordKind: "price",
        recordedAt: now,
        sourceRecordId: `exact-price-capability-${nonce}`,
        subjectChain: "extra",
        subjectEan: ean,
      };

      const historicalHandle = await beginRun(
        "exact-price-capability-history",
        "historical-prices",
        sourceId,
      );
      await expect(repository.persistPriceOutcomes(historicalHandle, [outcome])).resolves.toEqual({
        inserted: 1,
        received: 1,
      });
      const [historicalResult] = await connection.sql`
        select outcome.outcome_state, outcome.reason,
          (select count(*)::integer from price_observations
           where ingestion_run_id = ${historicalHandle.id}) as observations
        from source_record_outcomes outcome
        where outcome.ingestion_run_id = ${historicalHandle.id}
      `;
      expect(historicalResult).toEqual({
        observations: 0,
        outcome_state: "quarantined",
        reason: "SOURCE_ACCESS_REVIEW_REQUIRED",
      });

      const unsupportedHandle = await beginRun(
        "unsupported-price-run-type",
        "prices",
        sourceId,
      );
      await expect(repository.persistPriceOutcomes(unsupportedHandle, [{
        ...outcome,
        sourceRecordId: `unsupported-price-run-type-${nonce}`,
      }])).rejects.toThrow(/exact supported ingestion run type/i);
      const [unsupportedAudit] = await connection.sql`
        select count(*)::integer as count
        from source_record_outcomes
        where ingestion_run_id = ${unsupportedHandle.id}
      `;
      expect(unsupportedAudit).toEqual({ count: 0 });
    });

    it("rejects stale fences before any write", async () => {
      const handle = await beginRun("stale-fence", "prices");
      const staleRepository = new PostgresIngestionRepository(connection.db, {
        verifyFence: async () => {
          throw new Error("stale ingestion fence");
        },
      });
      const sourceRecordId = `stale-fence-${nonce}`;

      await expect(
        staleRepository.auditOutcomes(handle, [
          {
            outcomeState: "unknown",
            reason: "PRICE_UNAVAILABLE",
            recordKind: "price",
            recordedAt: now,
            sourceRecordId,
          },
        ]),
      ).rejects.toThrow("stale ingestion fence");

      const [row] = await connection.sql`
        select count(*)::integer as count
        from source_record_outcomes
        where ingestion_run_id = ${handle.id} and source_record_id = ${sourceRecordId}
      `;
      expect(row!.count).toBe(0);
    });

    it("database-stamps append-only evidence and rejects inserts after terminalization", async () => {
      const handle = await beginRun("database-running-guard", "catalog");
      const ean = gtin13(9);
      const [product] = await connection.sql`
        insert into canonical_products (
          display_name, package_amount, package_unit, units_per_pack, status
        ) values (${`Running guard ${nonce}`}, 1, 'package', 1, 'active')
        returning id
      `;
      const [persisted] = await connection.sql`
        insert into source_record_outcomes (
          ingestion_run_id, record_kind, source_record_id, outcome_state,
          reason, subject_ean, outcome_hash, recorded_at, created_at
        ) values (
          ${handle.id}, 'product', ${`guard-legitimate-${nonce}`}, 'accepted',
          null, ${ean}, ${"d".repeat(64)}, ${now.toISOString()},
          '2000-01-01T00:00:00Z'
        )
        returning created_at
      `;
      expect(databaseDate(persisted!.created_at).getTime()).toBeGreaterThan(
        new Date("2000-01-01T00:00:00Z").getTime(),
      );

      await repository.finalizeRun(handle, {
        completedAt: new Date("2026-07-16T12:05:00.000Z"),
        status: "completed",
      });

      const lateInsertions = [
        () => connection.sql`
          insert into source_record_outcomes (
            ingestion_run_id, record_kind, source_record_id, outcome_state,
            reason, subject_ean, outcome_hash, recorded_at, created_at
          ) values (
            ${handle.id}, 'product', ${`guard-late-${nonce}`}, 'accepted',
            null, ${ean}, ${"e".repeat(64)}, ${now.toISOString()},
            '2000-01-01T00:00:00Z'
          )
        `,
        () => connection.sql`
          insert into catalog_observations (
            ingestion_run_id, source_record_id, canonical_product_id, gtin,
            display_name, package_amount, package_unit, units_per_pack,
            retrieved_at, raw_record_hash, created_at
          ) values (
            ${handle.id}, ${`guard-late-catalog-${nonce}`}, ${product!.id}, ${ean},
            'Late catalog evidence', 1, 'package', 1, ${now.toISOString()},
            ${"f".repeat(64)}, '2000-01-01T00:00:00Z'
          )
        `,
        () => connection.sql`
          insert into price_observations (
            evidence_key, product_id, chain, amount_ore, observed_at, fetched_at,
            source_id, source_reference, ingestion_run_id, geographic_scope_id,
            evidence_level, confidence, claim_eligibility, raw_record_hash,
            created_at
          ) values (
            ${`guard-late-price-${nonce}`}, ${product!.id}, 'extra', 100,
            ${now.toISOString()}, ${now.toISOString()}, 'kassalapp', 'guard-late',
            ${handle.id}, ${scopeId}, 'chain', 100, 'ordinary_only',
            ${"a".repeat(64)}, '2000-01-01T00:00:00Z'
          )
        `,
        () => connection.sql`
          insert into price_coverage_checks (
            ingestion_run_id, product_id, chain, geographic_scope_id,
            state, reason, checked_at, created_at
          ) values (
            ${handle.id}, ${product!.id}, 'extra', ${scopeId}, 'priced',
            'guard_late', ${now.toISOString()}, '2000-01-01T00:00:00Z'
          )
        `,
      ];
      for (const insertion of lateInsertions) {
        await expect(insertion()).rejects.toThrow(/running ingestion run/i);
      }
      const [lateCounts] = await connection.sql`
        select
          (select count(*)::integer from source_record_outcomes
            where ingestion_run_id = ${handle.id}
              and source_record_id = ${`guard-late-${nonce}`}) as outcomes,
          (select count(*)::integer from catalog_observations
            where ingestion_run_id = ${handle.id}) as catalog,
          (select count(*)::integer from price_observations
            where ingestion_run_id = ${handle.id}) as prices,
          (select count(*)::integer from price_coverage_checks
            where ingestion_run_id = ${handle.id}) as coverage
      `;
      expect(lateCounts).toEqual({ catalog: 0, coverage: 0, outcomes: 0, prices: 0 });
    });

    it("serializes an evidence append against concurrent finalization", async () => {
      const handle = await beginRun("database-running-guard-race", "catalog");
      let reportTerminalUpdate!: () => void;
      let releaseTerminalUpdate!: () => void;
      const terminalUpdated = new Promise<void>((resolve) => {
        reportTerminalUpdate = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseTerminalUpdate = resolve;
      });
      const finalization = connection.sql.begin(async (transaction) => {
        await transaction`
          update ingestion_runs
          set status = 'completed',
              completed_at = ${new Date("2026-07-16T12:05:00.000Z").toISOString()},
              counts = '{}'::jsonb
          where id = ${handle.id}
        `;
        reportTerminalUpdate();
        await release;
      });
      await terminalUpdated;

      try {
        await expect(contender.sql.begin(async (transaction) => {
          await transaction`set local lock_timeout = '250ms'`;
          await transaction`
            insert into source_record_outcomes (
              ingestion_run_id, record_kind, source_record_id, outcome_state,
              reason, outcome_hash, recorded_at, created_at
            ) values (
              ${handle.id}, 'product', ${`guard-race-${nonce}`}, 'accepted', null,
              ${"b".repeat(64)}, ${now.toISOString()}, '2000-01-01T00:00:00Z'
            )
          `;
        })).rejects.toThrow(/lock timeout/i);
      } finally {
        releaseTerminalUpdate();
      }
      await finalization;
      await expect(contender.sql`
        insert into source_record_outcomes (
          ingestion_run_id, record_kind, source_record_id, outcome_state,
          reason, outcome_hash, recorded_at, created_at
        ) values (
          ${handle.id}, 'product', ${`guard-race-after-${nonce}`}, 'accepted', null,
          ${"c".repeat(64)}, ${now.toISOString()}, '2000-01-01T00:00:00Z'
        )
      `).rejects.toThrow(/running ingestion run/i);
    });

    it("binds price evidence and coverage to their run provenance", async () => {
      const [product] = await connection.sql`
        insert into canonical_products (
          display_name, package_amount, package_unit, units_per_pack, status
        ) values (${`Run provenance ${nonce}`}, 1, 'package', 1, 'active')
        returning id
      `;
      const catalogHandle = await beginRun("price-on-catalog-run", "catalog");
      await expect(connection.sql`
        insert into price_observations (
          evidence_key, product_id, chain, amount_ore, observed_at, fetched_at,
          source_id, source_reference, ingestion_run_id, evidence_level,
          confidence, claim_eligibility, raw_record_hash
        ) values (
          ${`price-on-catalog-${nonce}`}, ${product!.id}, 'extra', 100,
          ${now.toISOString()}, ${now.toISOString()}, 'kassalapp', 'invalid-run',
          ${catalogHandle.id}, 'chain', 100, 'ordinary_only', ${"1".repeat(64)}
        )
      `).rejects.toThrow(/price ingestion run/i);

      const historicalHandle = await beginRun("coverage-on-history", "historical-prices");
      await expect(connection.sql`
        insert into price_coverage_checks (
          ingestion_run_id, product_id, chain, geographic_scope_id,
          state, reason, checked_at
        ) values (
          ${historicalHandle.id}, ${product!.id}, 'extra', ${scopeId},
          'priced', 'invalid_history_coverage', ${now.toISOString()}
        )
      `).rejects.toThrow(/ordinary-price ingestion run/i);

      const benchmarkHandle = await beginRun("history-on-benchmark", "benchmark-prices");
      await expect(connection.sql`
        insert into price_observations (
          evidence_key, product_id, chain, amount_ore, observed_at, fetched_at,
          source_id, source_reference, ingestion_run_id, evidence_level,
          confidence, claim_eligibility, raw_record_hash
        ) values (
          ${`history-on-benchmark-${nonce}`}, ${product!.id}, 'extra', 100,
          ${now.toISOString()}, ${now.toISOString()}, 'kassalapp', 'invalid-claim',
          ${benchmarkHandle.id}, 'chain', 100, 'historical_eligible',
          ${"2".repeat(64)}
        )
      `).rejects.toThrow(/eligibility must match/i);

      await expect(connection.sql`
        insert into price_observations (
          evidence_key, product_id, chain, amount_ore, observed_at, fetched_at,
          source_id, source_reference, ingestion_run_id, evidence_level,
          confidence, claim_eligibility, raw_record_hash
        ) values (
          ${`wrong-source-on-benchmark-${nonce}`}, ${product!.id}, 'extra', 100,
          ${now.toISOString()}, ${now.toISOString()}, 'legacy-import', 'invalid-source',
          ${benchmarkHandle.id}, 'chain', 100, 'ordinary_only',
          ${"3".repeat(64)}
        )
      `).rejects.toThrow(/source must match/i);

      for (const handle of [catalogHandle, historicalHandle, benchmarkHandle]) {
        await repository.finalizeRun(handle, {
          completedAt: new Date("2026-07-16T12:05:00.000Z"),
          status: "cancelled",
        });
      }
    });

    it("audits coordinate-less stores as unknown and persists only complete locations", async () => {
      const handle = await beginRun("stores", "physical-stores");
      const missingId = `store-missing-${nonce}`;
      const completeId = `store-complete-${nonce}`;
      const outcomes: PhysicalStoreIngestionOutcome[] = [
        {
          outcomeState: "accepted",
          recordKind: "physical-store",
          recordedAt: now,
          sourceRecordId: missingId,
          store: { addressLine: "Testveien 1", name: "Missing", observedAt: now },
          subjectChain: "extra",
        },
        {
          outcomeState: "accepted",
          recordKind: "physical-store",
          recordedAt: now,
          sourceRecordId: completeId,
          store: {
            addressLine: "Testveien 2",
            latitude: 59.911_491,
            longitude: 10.757_933,
            municipalityCode: "0301",
            name: "Complete",
            observedAt: now,
            postalCode: "0152",
          },
          subjectChain: "extra",
        },
      ];

      await expect(repository.persistPhysicalStoreOutcomes(handle, outcomes, [{
        chain: "extra",
        checkedAt: now,
        reason: "INVALID_RECORDS",
        recordCount: 2,
        state: "unknown",
      }])).resolves.toEqual({
        inserted: 2,
        received: 2,
      });

      const audit = await connection.sql`
        select source_record_id, outcome_state, reason
        from source_record_outcomes
        where ingestion_run_id = ${handle.id}
        order by source_record_id
      `;
      expect(audit).toEqual([
        { outcome_state: "accepted", reason: null, source_record_id: completeId },
        {
          outcome_state: "unknown",
          reason: "MISSING_COORDINATES",
          source_record_id: missingId,
        },
      ]);
      const stores = await connection.sql`
        select external_id, name, observed_at from physical_stores
        where source_id = 'kassalapp' and external_id in (${missingId}, ${completeId})
      `;
      expect(stores).toEqual([expect.objectContaining({
        external_id: completeId,
        name: "Complete",
      })]);
      expectSameInstant(stores[0]!.observed_at, now);
      const [branchEvidence] = await connection.sql`
        select
          branch_key,
          external_id,
          chain,
          name,
          latitude,
          longitude,
          status,
          created_at
        from physical_store_observations
        where ingestion_run_id = ${handle.id}
      `;
      expect(branchEvidence).toMatchObject({
        chain: "extra",
        external_id: completeId,
        name: "Complete",
        status: "active",
      });
      expect(branchEvidence?.branch_key).toMatch(/^[0-9a-f]{64}$/);
      expect(new Date(String(branchEvidence?.created_at)).getTime()).toBeGreaterThan(
        now.getTime(),
      );
      const [branchCoverage] = await connection.sql`
        select chain, state, reason, record_count, created_at
        from physical_store_coverage_checks
        where ingestion_run_id = ${handle.id}
      `;
      expect(branchCoverage).toMatchObject({
        chain: "extra",
        reason: "INVALID_RECORDS",
        record_count: 2,
        state: "unknown",
      });
      expect(new Date(String(branchCoverage?.created_at)).getTime()).toBeGreaterThan(
        now.getTime(),
      );
      await expect(connection.sql`
        update physical_store_observations
        set name = 'Rewritten branch evidence'
        where ingestion_run_id = ${handle.id}
      `).rejects.toThrow(/append-only/i);
      await expect(connection.sql`
        delete from physical_store_coverage_checks
        where ingestion_run_id = ${handle.id}
      `).rejects.toThrow(/append-only/i);

      const originalStore = outcomes[1]!;
      if (originalStore.outcomeState !== "accepted") {
        throw new Error("Expected accepted store integration fixture");
      }
      const olderHandle = await beginRun("stores-older", "physical-stores");
      await repository.persistPhysicalStoreOutcomes(olderHandle, [
        {
          ...originalStore,
          store: {
            ...originalStore.store,
            name: "Older stale store name",
            observedAt: new Date("2026-07-15T12:00:00.000Z"),
          },
        },
      ], [{
        chain: "extra",
        checkedAt: now,
        recordCount: 1,
        state: "complete",
      }]);
      const [storeAfterOlderReplay] = await connection.sql`
        select name, observed_at
        from physical_stores
        where source_id = 'kassalapp' and external_id = ${completeId}
      `;
      expect(storeAfterOlderReplay).toMatchObject({ name: "Complete" });
      expectSameInstant(storeAfterOlderReplay!.observed_at, now);
    });

    it("rolls outcomes and branch rows back when complete coverage is inconsistent", async () => {
      const handle = await beginRun("stores-atomic-rollback", "physical-stores");
      const externalId = `store-atomic-${nonce}`;

      await expect(repository.persistPhysicalStoreOutcomes(handle, [{
        outcomeState: "accepted",
        recordKind: "physical-store",
        recordedAt: now,
        sourceRecordId: externalId,
        store: {
          name: "Must roll back",
          observedAt: now,
        },
        subjectChain: "extra",
      }], [{
        chain: "extra",
        checkedAt: now,
        recordCount: 1,
        state: "complete",
      }])).rejects.toThrow(/every counted routing record/i);

      const [counts] = await connection.sql`
        select
          (select count(*)::integer from source_record_outcomes
            where ingestion_run_id = ${handle.id}) as outcomes,
          (select count(*)::integer from physical_store_observations
            where ingestion_run_id = ${handle.id}) as observations,
          (select count(*)::integer from physical_store_coverage_checks
            where ingestion_run_id = ${handle.id}) as coverage
      `;
      expect(counts).toEqual({ coverage: 0, observations: 0, outcomes: 0 });
      let finalizationError: unknown;
      try {
        await repository.finalizeRun(handle, {
          completedAt: new Date("2026-07-16T12:05:00.000Z"),
          status: "completed",
        });
      } catch (error) {
        finalizationError = error;
      }
      expect(finalizationError).toBeInstanceOf(DrizzleQueryError);
      expect((finalizationError as DrizzleQueryError).cause).toMatchObject({
        code: "23514",
        message: "completed physical-store run requires coverage evidence",
        name: "PostgresError",
      });
    });

    it.each<GovernanceRace>(["permission-only", "kill-switch-only"])(
      "leaves price evidence, coverage, identity, and cache untouched after a concurrent %s governance change",
      async (governanceRace) => {
        await approveExistingSource("kassalapp", {
          catalog: true,
          ordinaryPrice: true,
          physicalStore: true,
          priceHistory: true,
        });
        const ean = gtin13(governanceRace === "permission-only" ? 7 : 8);
        await connection.sql`
          insert into price_cache (ean, chain, amount_ore, observed_at, fetched_at)
          values (
            ${ean}, 'extra', 1111, '2026-07-15T12:00:00Z', '2026-07-15T12:00:00Z'
          )
          on conflict (ean, chain) do update
          set amount_ore = 1111,
              observed_at = '2026-07-15T12:00:00Z',
              fetched_at = '2026-07-15T12:00:00Z'
        `;
        const handle = await beginRun(
          `price-governance-${governanceRace}`,
          "benchmark-prices",
        );
        const outcomes: PriceIngestionOutcome[] = [
          {
            outcomeState: "accepted",
            price: {
              amountOre: 3_490,
              fetchedAt: now,
              observedAt: now,
              sourceReference: `price-governance:${governanceRace}:${nonce}`,
            },
            recordKind: "price",
            recordedAt: now,
            sourceRecordId: `price-governance-accepted-${governanceRace}-${nonce}`,
            subjectChain: "extra",
            subjectEan: ean,
          },
          {
            outcomeState: "unknown",
            reason: "PRICE_UNAVAILABLE",
            recordKind: "price",
            recordedAt: now,
            sourceRecordId: `price-governance-unknown-${governanceRace}-${nonce}`,
            subjectChain: "extra",
            subjectEan: ean,
          },
        ];

        await expect(racePersistenceAgainstGovernance(
          "kassalapp",
          governanceRace,
          () => repository.persistPriceOutcomes(handle, outcomes),
        )).resolves.toEqual({ inserted: 2, received: 2 });

        const audited = await connection.sql`
          select source_record_id, outcome_state, reason
          from source_record_outcomes
          where ingestion_run_id = ${handle.id}
          order by source_record_id
        `;
        expect(audited).toEqual([
          {
            outcome_state: "quarantined",
            reason: "SOURCE_ACCESS_REVIEW_REQUIRED",
            source_record_id: `price-governance-accepted-${governanceRace}-${nonce}`,
          },
          {
            outcome_state: "unknown",
            reason: "PRICE_UNAVAILABLE",
            source_record_id: `price-governance-unknown-${governanceRace}-${nonce}`,
          },
        ]);
        const [counts] = await connection.sql`
          select
            (select count(*)::integer from price_observations
             where ingestion_run_id = ${handle.id}) as observations,
            (select count(*)::integer from price_coverage_checks
             where ingestion_run_id = ${handle.id}) as coverage,
            (select count(*)::integer from product_identifiers
             where value = ${ean} and scheme = 'ean13') as identifiers,
            (select amount_ore::integer from price_cache
             where ean = ${ean} and chain = 'extra') as cached_amount
        `;
        expect(counts).toEqual({
          cached_amount: 1111,
          coverage: 0,
          identifiers: 0,
          observations: 0,
        });
      },
    );

    it.each<GovernanceRace>(["permission-only", "kill-switch-only"])(
      "leaves store observations, projection, and even empty coverage untouched after a concurrent %s governance change",
      async (governanceRace) => {
        const sourceId = `store-governance-${governanceRace}-${nonce}`;
        await seedApprovedSource(
          sourceId,
          "Store governance integration",
          "store",
          { physicalStore: true },
        );
        const externalId = `store-governance-${governanceRace}-${nonce}`;
        const handle = await beginRun(
          `store-governance-${governanceRace}`,
          "physical-stores",
          sourceId,
        );
        await expect(racePersistenceAgainstGovernance(
          sourceId,
          governanceRace,
          () => repository.persistPhysicalStoreOutcomes(handle, [{
            outcomeState: "accepted",
            recordKind: "physical-store",
            recordedAt: now,
            sourceRecordId: externalId,
            store: {
              latitude: 59.911_491,
              longitude: 10.757_933,
              name: "Must remain audit-only",
              observedAt: now,
              postalCode: "0152",
            },
            subjectChain: "extra",
          }], [{
            chain: "extra",
            checkedAt: now,
            recordCount: 1,
            state: "complete",
          }]),
        )).resolves.toEqual({ inserted: 1, received: 1 });

        const [result] = await connection.sql`
          select outcome.outcome_state, outcome.reason,
            (select count(*)::integer from physical_store_observations
             where ingestion_run_id = ${handle.id}) as observations,
            (select count(*)::integer from physical_store_coverage_checks
             where ingestion_run_id = ${handle.id}) as coverage,
            (select count(*)::integer from physical_stores
             where source_id = ${sourceId}) as stores
          from source_record_outcomes outcome
          where outcome.ingestion_run_id = ${handle.id}
        `;
        expect(result).toEqual({
          coverage: 0,
          observations: 0,
          outcome_state: "quarantined",
          reason: "SOURCE_ACCESS_REVIEW_REQUIRED",
          stores: 0,
        });

        const emptyCoverageHandle = await beginRun(
          `store-governance-empty-${governanceRace}`,
          "physical-stores",
          sourceId,
        );
        await expect(repository.persistPhysicalStoreOutcomes(
          emptyCoverageHandle,
          [],
          [{
            chain: "extra",
            checkedAt: now,
            reason: "REQUEST_FAILED",
            recordCount: 0,
            state: "unknown",
          }],
        )).resolves.toEqual({ inserted: 0, received: 0 });
        const [emptyCoverage] = await connection.sql`
          select count(*)::integer as count
          from physical_store_coverage_checks
          where ingestion_run_id = ${emptyCoverageHandle.id}
        `;
        expect(emptyCoverage).toEqual({ count: 0 });
      },
    );

    it.each<"source-governance" | "gtin">(["source-governance", "gtin"])(
      "bounds a held %s advisory lock after caller abort and leaves no price side effects",
      async (heldLock) => {
        await approveExistingSource("kassalapp", {
          catalog: true,
          ordinaryPrice: true,
          physicalStore: true,
          priceHistory: true,
        });
        const ean = gtin13(heldLock === "source-governance" ? 1 : 2);
        const handle = await beginRun(
          `bounded-${heldLock}-lock`,
          "benchmark-prices",
        );

        let releaseHolder!: () => void;
        const holderMayCommit = new Promise<void>((resolve) => {
          releaseHolder = resolve;
        });
        let signalHolderReady!: (holderPid: number) => void;
        let signalHolderFailure!: (error: unknown) => void;
        const holderReady = new Promise<number>((resolve, reject) => {
          signalHolderReady = resolve;
          signalHolderFailure = reject;
        });
        const holder = contender.sql.begin(async (transaction) => {
          const [session] = await transaction`
            select pg_backend_pid()::integer as holder_pid
          `;
          if (typeof session?.holder_pid !== "number") {
            throw new Error("Missing bounded-lock holder PID");
          }
          await transaction`
            select pg_catalog.pg_advisory_xact_lock(
              pg_catalog.hashtextextended(
                ${heldLock === "source-governance" ? "kassalapp" : ean},
                ${heldLock === "source-governance"
                  ? SOURCE_GOVERNANCE_ADVISORY_LOCK_SEED
                  : 0}
              )
            )
          `;
          signalHolderReady(session.holder_pid);
          await holderMayCommit;
        });
        void holder.catch(signalHolderFailure);

        const holderPid = await holderReady;
        const controller = new AbortController();
        const startedAt = Date.now();
        const persistence = repository.persistPriceOutcomes(handle, [{
          outcomeState: "accepted",
          price: {
            amountOre: 3_290,
            fetchedAt: now,
            geographicScopeId: scopeId,
            observedAt: now,
            sourceReference: `bounded-${heldLock}-lock:${nonce}`,
          },
          recordKind: "price",
          recordedAt: now,
          sourceRecordId: `bounded-${heldLock}-lock-${nonce}`,
          subjectChain: "extra",
          subjectEan: ean,
        }], controller.signal);
        void persistence.catch(() => undefined);

        let persistenceError: unknown;
        let proofError: unknown;
        try {
          await waitForAdvisoryLockWaiter(connection, holderPid);
          controller.abort();
          try {
            await persistence;
          } catch (error) {
            persistenceError = error;
          }
        } catch (error) {
          proofError = error;
          controller.abort();
        } finally {
          releaseHolder();
        }
        await holder;
        if (proofError !== undefined) {
          await persistence.catch(() => undefined);
          throw proofError;
        }

        expect(controller.signal.aborted).toBe(true);
        expect(persistenceError).toBeInstanceOf(DrizzleQueryError);
        expect((persistenceError as DrizzleQueryError).cause).toMatchObject({
          code: "55P03",
          name: "PostgresError",
        });
        expect(Date.now() - startedAt).toBeLessThan(12_000);

        const [counts] = await connection.sql`
          select
            (select count(*)::integer from source_record_outcomes
             where ingestion_run_id = ${handle.id}) as outcomes,
            (select count(*)::integer from price_observations
             where ingestion_run_id = ${handle.id}) as observations,
            (select count(*)::integer from price_coverage_checks
             where ingestion_run_id = ${handle.id}) as coverage,
            (select count(*)::integer from product_identifiers
             where value = ${ean} and scheme = 'ean13') as identifiers,
            (select count(*)::integer from price_cache
             where ean = ${ean} and chain = 'extra') as cache
        `;
        expect(counts).toEqual({
          cache: 0,
          coverage: 0,
          identifiers: 0,
          observations: 0,
          outcomes: 0,
        });
      },
      15_000,
    );
  },
);
