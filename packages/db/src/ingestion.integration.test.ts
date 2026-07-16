import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

const runDatabaseIntegration = process.env.RUN_DB_INTEGRATION === "1";
const nonce = `${process.pid}-${Date.now()}`;
const now = new Date("2026-07-16T12:00:00.000Z");

function expectSameInstant(actual: unknown, expected: Date): void {
  const parsed = actual instanceof Date ? actual : new Date(String(actual));
  expect(Number.isFinite(parsed.getTime())).toBe(true);
  expect(parsed.toISOString()).toBe(expected.toISOString());
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

describe.skipIf(!runDatabaseIntegration).sequential(
  "PostgresIngestionRepository integration",
  () => {
    let connection: DatabaseConnection;
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

    beforeAll(async () => {
      if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is required when RUN_DB_INTEGRATION=1");
      }
      connection = createDatabase(process.env.DATABASE_URL);
      repository = new PostgresIngestionRepository(connection.db, { verifyFence });

      const [scope] = await connection.sql`
        insert into geographic_scopes (scope_key, scope_kind, label)
        values (${`ingestion-integration-${nonce}`}, 'national', 'Ingestion integration')
        on conflict (scope_key) do update set label = excluded.label
        returning id::integer as id
      `;
      scopeId = scope!.id;
    });

    afterAll(async () => {
      await connection?.close();
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
        select source_record_id, display_name, retrieved_at, source_updated_at
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

      const sourceLinks = await connection.sql`
        select external_id, canonical_product_id
        from source_products
        where source_id = 'kassalapp'
          and external_id in (${`catalog-a-${nonce}`}, ${`catalog-b-${nonce}`})
        order by external_id
      `;
      expect(sourceLinks).toEqual([{
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

    it("applies only newer same-source catalog corrections under current approval", async () => {
      const sourceId = `catalog-correction-${nonce}`;
      const ean = gtin13(8);
      const externalId = `trusted-correction-${nonce}`;
      await connection.sql`
        insert into data_sources (
          id, display_name, source_kind, runtime_state,
          permission_reviewed_at, permission_expires_at
        ) values (
          ${sourceId}, 'Catalog correction integration', 'catalog', 'approved',
          clock_timestamp() - interval '1 minute', '2099-01-01T00:00:00Z'
        )
      `;
      await connection.sql`
        insert into source_permissions (
          source_id, decision, reviewed_at, valid_until, permissions, notes
        ) values (
          ${sourceId}, 'approved', clock_timestamp() - interval '30 seconds',
          '2099-01-01T00:00:00Z', '{"catalog":true}'::jsonb,
          ${`catalog-correction-approved-${nonce}`}
        )
      `;

      const initialHandle = await beginRun("catalog-correction-initial", "catalog", sourceId);
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

      const correctedHandle = await beginRun("catalog-correction-newer", "catalog", sourceId);
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

      await connection.sql`
        insert into source_permissions (
          source_id, decision, reviewed_at, permissions, notes
        ) values (
          ${sourceId}, 'revoked', clock_timestamp(), '{}'::jsonb,
          ${`catalog-correction-revoked-${nonce}`}
        )
      `;
      const revokedHandle = await beginRun("catalog-correction-revoked", "catalog", sourceId);
      await repository.persistCatalogOutcomes(revokedHandle, [{
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
      }]);

      const [afterRevocation] = await connection.sql`
        select product.display_name, product.package_amount, product.package_unit,
               source.last_seen_at, outcome.outcome_state, outcome.reason,
               outcome.normalized_record->>'displayName' as proposed_name
        from product_identifiers identifier
        inner join canonical_products product on product.id = identifier.product_id
        inner join source_products source
          on source.canonical_product_id = product.id
         and source.source_id = ${sourceId}
         and source.external_id = ${externalId}
        inner join source_record_outcomes outcome
          on outcome.ingestion_run_id = ${revokedHandle.id}
         and outcome.source_record_id = ${externalId}
        where identifier.value = ${ean}
          and identifier.scheme = 'ean13'
      `;
      expect(afterRevocation).toMatchObject({
        display_name: "Trusted product 750 g",
        outcome_state: "quarantined",
        package_amount: 750,
        package_unit: "g",
        proposed_name: "Must remain in review",
        reason: "CATALOG_CORRECTION_REVIEW_REQUIRED",
      });
      expectSameInstant(
        afterRevocation!.last_seen_at,
        new Date("2026-07-16T12:05:00.000Z"),
      );
    });

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

    it("audits coordinate-less stores as unknown and persists only complete locations", async () => {
      const handle = await beginRun("stores", "stores");
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

      await expect(repository.persistPhysicalStoreOutcomes(handle, outcomes)).resolves.toEqual({
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

      const originalStore = outcomes[1]!;
      if (originalStore.outcomeState !== "accepted") {
        throw new Error("Expected accepted store integration fixture");
      }
      const olderHandle = await beginRun("stores-older", "stores");
      await repository.persistPhysicalStoreOutcomes(olderHandle, [
        {
          ...originalStore,
          store: {
            ...originalStore.store,
            name: "Older stale store name",
            observedAt: new Date("2026-07-15T12:00:00.000Z"),
          },
        },
      ]);
      const [storeAfterOlderReplay] = await connection.sql`
        select name, observed_at
        from physical_stores
        where source_id = 'kassalapp' and external_id = ${completeId}
      `;
      expect(storeAfterOlderReplay).toMatchObject({ name: "Complete" });
      expectSameInstant(storeAfterOlderReplay!.observed_at, now);
    });
  },
);
