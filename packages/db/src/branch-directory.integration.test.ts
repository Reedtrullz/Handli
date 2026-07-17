import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresBranchDirectory } from "./branch-directory";
import { createDatabase, type DatabaseConnection } from "./client";
import { PostgresGeographicDirectoryReader } from "./geographic-directory";
import { physicalStoreBranchKey } from "./ingestion";

const runDatabaseIntegration = process.env.RUN_DB_INTEGRATION === "1";
const nonce = `branch-reader-${Date.now()}-${process.pid}`;
const sourceId = nonce.slice(0, 64);
const now = Date.now();
const evaluatedAt = new Date(now + 5 * 60_000);
const marketContext = {
  contractVersion: 1 as const,
  countryCode: "NO" as const,
  kind: "national" as const,
};
const regionalMarketContext = {
  contractVersion: 1 as const,
  countryCode: "NO" as const,
  kind: "launch-region" as const,
  regionId: "no-0301-oslo",
};

describe.skipIf(!runDatabaseIntegration).sequential(
  "branch directory integration",
  () => {
    let admin: DatabaseConnection;
    let web: DatabaseConnection;
    let completeRunId: number;

    async function createRun(label: string): Promise<number> {
      const [run] = await admin.sql`
        insert into ingestion_runs (
          job_id, source_id, run_type, status, started_at, counts
        ) values (
          ${`${nonce}:${label}`},
          ${sourceId},
          'physical-stores',
          'running',
          ${new Date(now - 60_000).toISOString()},
          '{}'::jsonb
        )
        returning id::integer as id
      `;
      if (typeof run?.id !== "number") throw new Error("Missing branch run fixture id");
      return run.id;
    }

    async function addBranch(input: {
      chain: "bunnpris" | "extra" | "rema-1000";
      externalId: string;
      name: string;
      postalCode?: string;
      runId: number;
    }): Promise<void> {
      await admin.sql`
        insert into physical_store_observations (
          ingestion_run_id, source_id, branch_key, external_id, chain, name,
          latitude, longitude, postal_code, status, observed_at
        ) values (
          ${input.runId},
          ${sourceId},
          ${physicalStoreBranchKey(sourceId, input.externalId)},
          ${input.externalId},
          ${input.chain},
          ${input.name},
          59.913900,
          10.752200,
          ${input.postalCode ?? null},
          'active',
          ${new Date(now - 30_000).toISOString()}
        )
      `;
    }

    async function addCoverage(input: {
      chain: "bunnpris" | "extra" | "rema-1000";
      reason?: "REQUEST_FAILED";
      runId: number;
      state: "complete" | "unknown";
    }): Promise<void> {
      await admin.sql`
        insert into physical_store_coverage_checks (
          ingestion_run_id, source_id, chain, state, reason, record_count,
          checked_at
        ) values (
          ${input.runId},
          ${sourceId},
          ${input.chain},
          ${input.state},
          ${input.reason ?? null},
          ${input.state === "complete" ? 1 : 0},
          ${new Date(now - 10_000).toISOString()}
        )
      `;
    }

    async function completeRun(runId: number): Promise<void> {
      await admin.sql`
        update ingestion_runs
        set status = 'completed',
            completed_at = ${new Date(now).toISOString()},
            counts = '{"accepted":2,"failed":0,"fetched":2,"persisted":2,"quarantined":0,"unknown":0}'::jsonb
        where id = ${runId}
      `;
    }

    async function databaseClock(): Promise<Date> {
      const [clock] = await admin.sql`select clock_timestamp() as current_time`;
      const current = clock?.current_time instanceof Date
        ? clock.current_time
        : new Date(String(clock?.current_time));
      if (!Number.isFinite(current.getTime())) throw new Error("Missing database clock");
      return current;
    }

    async function buildDirectory(input: {
      countryCode?: string;
      regionCode?: string;
      reviewedAt: Date;
      status: "approved" | "blocked" | "retired";
      validFrom: Date;
      validUntil?: Date;
      versionId: string;
    }): Promise<Date> {
      const countryCode = input.countryCode ?? "NO";
      const regionCode = input.regionCode ?? regionalMarketContext.regionId;
      await admin.sql`
        insert into public.geographic_postal_directory_versions (
          version_id, contract_version, country_code, status, reviewed_at,
          valid_from, valid_until, evidence_reference
        ) values (
          ${input.versionId}, 1, ${countryCode}, 'building', ${input.reviewedAt.toISOString()},
          ${input.validFrom.toISOString()}, ${input.validUntil?.toISOString() ?? null},
          ${`integration:${input.versionId}`}
        )
      `;
      if (input.status === "approved") {
        await admin.sql`
          insert into public.geographic_postal_directory_regions (
            version_id, region_code, coverage_state, postal_count, evidence_reference
          ) values (
            ${input.versionId}, ${regionCode}, 'complete', 1,
            ${`integration:${input.versionId}:${regionCode}`}
          )
        `;
        await admin.sql`
          insert into public.geographic_postal_directory_codes (
            version_id, region_code, postal_code
          ) values (${input.versionId}, ${regionCode}, '0152')
        `;
      }
      const [sealed] = await admin.sql`
        update public.geographic_postal_directory_versions
        set status = ${input.status}
        where version_id = ${input.versionId}
        returning sealed_at
      `;
      const sealedAt = sealed?.sealed_at instanceof Date
        ? sealed.sealed_at
        : new Date(String(sealed?.sealed_at));
      if (!Number.isFinite(sealedAt.getTime())) throw new Error("Missing directory seal clock");
      return sealedAt;
    }

    beforeAll(async () => {
      if (!process.env.DATABASE_URL || !process.env.WEB_DATABASE_URL) {
        throw new Error("DATABASE_URL and WEB_DATABASE_URL are required for DB integration");
      }
      admin = createDatabase(process.env.DATABASE_URL);
      web = createDatabase(process.env.WEB_DATABASE_URL);

      await admin.sql`
        insert into data_sources (
          id, display_name, source_kind, runtime_state,
          permission_reviewed_at, permission_expires_at
        ) values (
          ${sourceId},
          'Branch reader integration source',
          'store',
          'approved',
          ${new Date(now - 10 * 60_000).toISOString()},
          ${new Date(now + 24 * 60 * 60_000).toISOString()}
        )
      `;
      await admin.sql`
        insert into source_permissions (
          source_id, decision, reviewed_at, valid_until, permissions
        ) values (
          ${sourceId},
          'approved',
          ${new Date(now - 10 * 60_000).toISOString()},
          ${new Date(now + 24 * 60 * 60_000).toISOString()},
          '{"physicalStore":true}'::jsonb
        )
      `;

      completeRunId = await createRun("complete");
      await addBranch({
        chain: "extra",
        externalId: `${nonce}:extra`,
        name: "Extra Integration",
        postalCode: "0152",
        runId: completeRunId,
      });
      await addBranch({
        chain: "rema-1000",
        externalId: `${nonce}:rema`,
        name: "REMA Integration",
        postalCode: "0152",
        runId: completeRunId,
      });
      await addCoverage({ chain: "extra", runId: completeRunId, state: "complete" });
      await addCoverage({ chain: "rema-1000", runId: completeRunId, state: "complete" });
      await completeRun(completeRunId);

    });

    afterAll(async () => {
      await Promise.all([admin?.close(), web?.close()]);
    });

    it("reads only active public branch fields from one complete eligible run", async () => {
      const reader = new PostgresBranchDirectory(web.db);

      const snapshot = await reader.loadEligibleBranches({
        eligibleChainIds: ["rema-1000", "extra"],
        evaluatedAt,
        marketContext,
      });

      expect(snapshot).toEqual({
        branches: [
          expect.objectContaining({
            branchId: `branch:${completeRunId}:${physicalStoreBranchKey(sourceId, `${nonce}:extra`)}`,
            chainId: "extra",
            name: "Extra Integration",
          }),
          expect.objectContaining({
            branchId: `branch:${completeRunId}:${physicalStoreBranchKey(sourceId, `${nonce}:rema`)}`,
            chainId: "rema-1000",
            name: "REMA Integration",
          }),
        ],
        complete: true,
        contractVersion: 1,
        eligibleChainIds: ["extra", "rema-1000"],
        marketContext,
      });
      expect(snapshot.branches.every((entry) =>
        Object.keys(entry).sort().join(",") === "branchId,chainId,coordinate,name"
      )).toBe(true);
    });

    it("uses sealed_at for as-of authorization and never exposes a building directory", async () => {
      const existingCountryRows = await admin.sql`
        select distinct country_code
        from public.geographic_postal_directory_versions
      `;
      const existingCountries = new Set(existingCountryRows.map(({ country_code: code }) => code));
      const countryCode = Array.from({ length: 26 * 26 }, (_, index) =>
        String.fromCharCode(65 + Math.floor(index / 26), 65 + (index % 26)))
        .find((candidate) => candidate !== "NO" && !existingCountries.has(candidate));
      if (countryCode === undefined) throw new Error("No unused integration country code remains");
      const versionId = `${nonce}-pre-seal`;
      const reviewedAt = await databaseClock();
      await admin.sql`
        insert into public.geographic_postal_directory_versions (
          version_id, contract_version, country_code, status, reviewed_at,
          valid_from, evidence_reference
        ) values (
          ${versionId}, 1, ${countryCode}, 'building',
          ${reviewedAt.toISOString()},
          ${new Date(now - 2 * 60 * 60_000).toISOString()},
          ${`integration:${versionId}`}
        )
      `;
      await admin.sql`
        insert into public.geographic_postal_directory_regions (
          version_id, region_code, coverage_state, postal_count, evidence_reference
        ) values (${versionId}, 'se-stockholm', 'complete', 1, ${`integration:${versionId}:region`})
      `;
      await admin.sql`
        insert into public.geographic_postal_directory_codes (
          version_id, region_code, postal_code
        ) values (${versionId}, 'se-stockholm', '0152')
      `;
      const [preSealClock] = await admin.sql`select clock_timestamp() as evaluated_at`;
      const evaluatedBeforeSeal = preSealClock?.evaluated_at instanceof Date
        ? preSealClock.evaluated_at
        : new Date(String(preSealClock?.evaluated_at));
      expect(Number.isFinite(evaluatedBeforeSeal.getTime())).toBe(true);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      const [sealed] = await admin.sql`
        update public.geographic_postal_directory_versions
        set status = 'approved'
        where version_id = ${versionId}
        returning sealed_at
      `;
      const sealedAt = sealed?.sealed_at instanceof Date
        ? sealed.sealed_at
        : new Date(String(sealed?.sealed_at));
      expect(sealedAt.getTime()).toBeGreaterThan(evaluatedBeforeSeal.getTime());

      const reader = new PostgresGeographicDirectoryReader(web.db);
      await expect(reader.read(countryCode, evaluatedBeforeSeal)).resolves.toEqual({
        state: "unknown",
        reason: "postal-directory-unavailable",
      });
      await expect(reader.read(
        countryCode,
        new Date(sealedAt.getTime() + 1),
      )).resolves.toMatchObject({
        state: "available",
        directory: {
          directoryVersionId: versionId,
          publishedAt: sealedAt.toISOString(),
        },
      });
    });

    it("lets each newer terminal version shadow an older region approval before validity", async () => {
      const reader = new PostgresGeographicDirectoryReader(web.db);
      const branchDirectory = new PostgresBranchDirectory(web.db);
      const activeVersion = `${nonce}-active`;
      await buildDirectory({
        reviewedAt: await databaseClock(),
        status: "approved",
        validFrom: new Date(now - 7 * 24 * 60 * 60_000),
        versionId: activeVersion,
      });
      await expect(reader.read("NO", evaluatedAt)).resolves.toMatchObject({
        state: "available",
        directory: { directoryVersionId: activeVersion },
      });
      await expect(branchDirectory.loadEligibleBranches({
        eligibleChainIds: ["extra", "rema-1000"],
        evaluatedAt,
        marketContext: regionalMarketContext,
      })).resolves.toMatchObject({
        complete: true,
        regionEvidence: { directoryVersionId: activeVersion },
      });

      const futureVersion = `${nonce}-future`;
      await buildDirectory({
        reviewedAt: await databaseClock(),
        status: "approved",
        validFrom: new Date(evaluatedAt.getTime() + 24 * 60 * 60_000),
        versionId: futureVersion,
      });
      await expect(reader.read("NO", evaluatedAt)).resolves.toEqual({
        state: "unknown",
        reason: "postal-directory-not-current",
      });
      await expect(branchDirectory.loadEligibleBranches({
        eligibleChainIds: ["extra"],
        evaluatedAt,
        marketContext: regionalMarketContext,
      })).resolves.toMatchObject({ complete: false, branches: [] });

      const expiredVersion = `${nonce}-expired`;
      await buildDirectory({
        reviewedAt: await databaseClock(),
        status: "approved",
        validFrom: new Date(now - 7 * 24 * 60 * 60_000),
        validUntil: new Date(evaluatedAt.getTime() - 1),
        versionId: expiredVersion,
      });
      await expect(reader.read("NO", evaluatedAt)).resolves.toEqual({
        state: "unknown",
        reason: "postal-directory-not-current",
      });
      await expect(branchDirectory.loadEligibleBranches({
        eligibleChainIds: ["extra"],
        evaluatedAt,
        marketContext: regionalMarketContext,
      })).resolves.toMatchObject({ complete: false, branches: [] });

      for (const status of ["blocked", "retired"] as const) {
        const versionId = `${nonce}-${status}`;
        await buildDirectory({
          reviewedAt: await databaseClock(),
          status,
          validFrom: new Date(now - 7 * 24 * 60 * 60_000),
          versionId,
        });
        await expect(reader.read("NO", evaluatedAt)).resolves.toEqual({
          state: "unknown",
          reason: `postal-directory-${status}`,
        });
        await expect(branchDirectory.loadEligibleBranches({
          eligibleChainIds: ["extra"],
          evaluatedAt,
          marketContext: regionalMarketContext,
        })).resolves.toMatchObject({ complete: false, branches: [] });
      }
    });

    it("never promotes explicit unknown coverage to a complete directory", async () => {
      const unknownRunId = await createRun("unknown-bunnpris");
      await addCoverage({
        chain: "bunnpris",
        reason: "REQUEST_FAILED",
        runId: unknownRunId,
        state: "unknown",
      });
      await completeRun(unknownRunId);

      await expect(new PostgresBranchDirectory(web.db).loadEligibleBranches({
        eligibleChainIds: ["bunnpris"],
        evaluatedAt,
        marketContext,
      })).resolves.toEqual({
        branches: [],
        complete: false,
        contractVersion: 1,
        eligibleChainIds: ["bunnpris"],
        marketContext,
      });
      await expect(new PostgresBranchDirectory(web.db).loadEligibleBranches({
        eligibleChainIds: ["extra"],
        evaluatedAt,
        marketContext,
      })).resolves.toMatchObject({
        branches: [],
        complete: false,
      });
    });

    it("lets the latest as-of revocation shadow every older approval", async () => {
      await admin.sql`
        insert into source_permissions (
          source_id, decision, reviewed_at, permissions, notes
        ) values (
          ${sourceId},
          'revoked',
          ${new Date().toISOString()},
          '{"physicalStore":true}'::jsonb,
          'branch directory revocation proof'
        )
      `;

      await expect(new PostgresBranchDirectory(web.db).loadEligibleBranches({
        eligibleChainIds: ["extra"],
        evaluatedAt,
        marketContext,
      })).resolves.toEqual({
        branches: [],
        complete: false,
        contractVersion: 1,
        eligibleChainIds: ["extra"],
        marketContext,
      });
    });
  },
);
