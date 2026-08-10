import { describe, expect, it, vi } from "vitest";

import type { HandleplanDatabase } from "./client";
import {
  BranchDirectoryReaderError,
  MAX_BRANCH_DIRECTORY_BRANCHES,
  PHYSICAL_STORE_COVERAGE_MAX_AGE_MS,
  PostgresBranchDirectory,
} from "./branch-directory";

const AT = new Date("2026-07-17T12:00:00.000Z");
const MARKET = { contractVersion: 1 as const, countryCode: "NO" as const, kind: "national" as const };

interface CapturedQuery {
  parameters: unknown[];
  sql: string;
}

type TestQuery = Promise<unknown[]> & { cancel: ReturnType<typeof vi.fn> };

function branch(overrides: Record<string, unknown> = {}) {
  return {
    branch_id: "branch:" + "a".repeat(64),
    chain: "extra",
    latitude: "59.913900",
    longitude: "10.752200",
    name: "Extra Sentrum",
    ...overrides,
  };
}

function resolvedQuery(rows: unknown[]): TestQuery {
  const query = Promise.resolve(rows) as TestQuery;
  query.cancel = vi.fn();
  return query;
}

function rejectedQuery(error: Error): TestQuery {
  const query = Promise.reject(error) as TestQuery;
  query.cancel = vi.fn();
  return query;
}

function databaseWith(queryFactory: () => TestQuery): {
  captures: CapturedQuery[];
  db: HandleplanDatabase;
} {
  const captures: CapturedQuery[] = [];
  const client = (strings: TemplateStringsArray, ...parameters: unknown[]) => {
    captures.push({ parameters, sql: strings.join("?") });
    return queryFactory();
  };
  return { captures, db: { $client: client } as unknown as HandleplanDatabase };
}

describe("PostgresBranchDirectory", () => {
  it("loads a bounded canonical snapshot from one current eligible completed run", async () => {
    const { captures, db } = databaseWith(() => resolvedQuery([
      branch({ branch_id: "branch:" + "b".repeat(64), chain: "bunnpris", name: "Bunnpris" }),
      branch(),
    ]));

    await expect(new PostgresBranchDirectory(db).loadEligibleBranches({
      eligibleChainIds: ["extra", "bunnpris"],
      evaluatedAt: AT,
      marketContext: MARKET,
    })).resolves.toEqual({
      branches: [
        {
          branchId: "branch:" + "b".repeat(64),
          chainId: "bunnpris",
          coordinate: { latitudeE6: 59_913_900, longitudeE6: 10_752_200 },
          name: "Bunnpris",
        },
        {
          branchId: "branch:" + "a".repeat(64),
          chainId: "extra",
          coordinate: { latitudeE6: 59_913_900, longitudeE6: 10_752_200 },
          name: "Extra Sentrum",
        },
      ],
      complete: true,
      contractVersion: 1,
      eligibleChainIds: ["bunnpris", "extra"],
      marketContext: MARKET,
    });

    expect(captures).toHaveLength(1);
    const query = captures[0]!;
    expect(query.parameters).toContain('["bunnpris","extra"]');
    expect(query.parameters).toContain(AT.toISOString());
    expect(query.parameters).toContain(
      new Date(AT.getTime() - PHYSICAL_STORE_COVERAGE_MAX_AGE_MS).toISOString(),
    );
    expect(query.sql).toContain("public.physical_store_branches_public");
    expect(query.sql).toContain("public.physical_store_coverage_checks");
    expect(query.sql).toContain("run.run_type = 'physical-stores'");
    expect(query.sql).toContain("source_run.status = 'completed'");
    expect(query.sql).toContain("source_run.source_rank = 1");
    expect(query.sql).toContain("run.terminalized_at <=");
    expect(query.sql).toContain("source.public_state_changed_at <=");
    expect(query.sql).toContain("source.runtime_state = 'approved'");
    expect(query.sql).toContain("permission.created_at <=");
    expect(query.sql).toContain("order by permission.created_at desc, permission.id desc");
    expect(query.sql).not.toContain("order by permission.reviewed_at desc");
    expect(query.sql).toContain("permission.decision = 'approved'");
    expect(query.sql).toContain("source.permission_reviewed_at = permission.reviewed_at");
    expect(query.sql).toContain(
      "source.permission_expires_at is not distinct from permission.valid_until",
    );
    expect(query.sql).toContain("permission.permissions @> '{\"physicalStore\":true}'::jsonb");
    expect(query.sql).toContain("coverage.state = 'complete'");
    expect(query.sql).toContain("coverage.created_at <=");
    expect(query.sql).toContain("limit ?");
    expect(query.parameters).toContain(MAX_BRANCH_DIRECTORY_BRANCHES + 1);
    expect(query.sql).not.toContain("address_line");
    expect(query.sql).not.toContain("postal_code");
    expect(query.sql).not.toContain("municipality_code");
    expect(query.sql.indexOf(") permission on true")).toBeLessThan(
      query.sql.indexOf("permission.decision = 'approved'"),
    );
  });

  it("fails closed when the selected run has no active branch for every requested chain", async () => {
    const { db } = databaseWith(() => resolvedQuery([branch()]));

    await expect(new PostgresBranchDirectory(db).loadEligibleBranches({
      eligibleChainIds: ["extra", "rema-1000"],
      evaluatedAt: AT,
      marketContext: MARKET,
    })).resolves.toEqual({
      branches: [],
      complete: false,
      contractVersion: 1,
      eligibleChainIds: ["extra", "rema-1000"],
      marketContext: MARKET,
    });
  });

  it("requires one current persisted directory proof for every regional branch", async () => {
    const regionalMarket = {
      contractVersion: 1 as const,
      countryCode: "NO" as const,
      kind: "launch-region" as const,
      regionId: "no-0301-oslo",
    };
    const proof = {
      directory_evidence_reference: "manifest:directory",
      directory_reviewed_at: "2026-07-16T12:00:00.000Z",
      directory_version_id: "postal-directory-2026-07",
      region_code: regionalMarket.regionId,
      region_evidence_reference: "manifest:oslo",
    };
    const { captures, db } = databaseWith(() => resolvedQuery([
      branch({ ...proof, chain: "extra" }),
      branch({
        ...proof,
        branch_id: "branch:" + "b".repeat(64),
        chain: "rema-1000",
      }),
    ]));

    await expect(new PostgresBranchDirectory(db).loadEligibleBranches({
      eligibleChainIds: ["extra", "rema-1000"],
      evaluatedAt: AT,
      marketContext: regionalMarket,
    })).resolves.toMatchObject({
      complete: true,
      marketContext: regionalMarket,
      regionEvidence: {
        contractVersion: 1,
        countryCode: "NO",
        directoryEvidenceReference: "manifest:directory",
        directoryVersionId: "postal-directory-2026-07",
        regionEvidenceReference: "manifest:oslo",
        regionId: regionalMarket.regionId,
        reviewedAt: "2026-07-16T12:00:00.000Z",
      },
    });
    const regionalSql = captures[0]?.sql ?? "";
    expect(regionalSql).toContain("public.physical_store_region_branches_public");
    expect(regionalSql).toContain("version.reviewed_at <=");
    expect(regionalSql).toContain("version.sealed_at <=");
    expect(regionalSql).toContain("terminal.valid_until >");
    expect(regionalSql.indexOf("selected_terminal_directory")).toBeLessThan(
      regionalSql.indexOf("terminal.valid_from <="),
    );

    await expect(new PostgresBranchDirectory(databaseWith(() => resolvedQuery([
      branch({ ...proof }),
      branch({
        ...proof,
        branch_id: "branch:" + "b".repeat(64),
        directory_version_id: "conflicting-directory",
      }),
    ])).db).loadEligibleBranches({
      eligibleChainIds: ["extra"],
      evaluatedAt: AT,
      marketContext: regionalMarket,
    })).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("rejects malformed, duplicate, and over-limit public branch rows", async () => {
    const malformed = databaseWith(() => resolvedQuery([
      branch({ latitude: "59.9139000" }),
    ]));
    await expect(new PostgresBranchDirectory(malformed.db).loadEligibleBranches({
      eligibleChainIds: ["extra"],
      evaluatedAt: AT,
      marketContext: MARKET,
    })).rejects.toMatchObject({ code: "UNAVAILABLE" });

    const duplicate = databaseWith(() => resolvedQuery([branch(), branch()]));
    await expect(new PostgresBranchDirectory(duplicate.db).loadEligibleBranches({
      eligibleChainIds: ["extra"],
      evaluatedAt: AT,
      marketContext: MARKET,
    })).resolves.toMatchObject({ branches: [], complete: false });

    const overLimit = databaseWith(() => resolvedQuery(
      Array.from({ length: MAX_BRANCH_DIRECTORY_BRANCHES + 1 }, (_, index) =>
        branch({ branch_id: `branch:${String(index).padStart(64, "0")}` })),
    ));
    await expect(new PostgresBranchDirectory(overLimit.db).loadEligibleBranches({
      eligibleChainIds: ["extra"],
      evaluatedAt: AT,
      marketContext: MARKET,
    })).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("rejects invalid requests before querying", async () => {
    const { captures, db } = databaseWith(() => resolvedQuery([]));
    const reader = new PostgresBranchDirectory(db);

    await expect(reader.loadEligibleBranches({
      eligibleChainIds: [],
      evaluatedAt: AT,
      marketContext: MARKET,
    })).rejects.toEqual(expect.objectContaining({
      code: "INVALID_REQUEST",
      name: "BranchDirectoryReaderError",
    }));
    await expect(reader.loadEligibleBranches({
      eligibleChainIds: ["extra", "extra"],
      evaluatedAt: AT,
      marketContext: MARKET,
    })).rejects.toBeInstanceOf(BranchDirectoryReaderError);
    await expect(reader.loadEligibleBranches({
      eligibleChainIds: ["extra"],
      evaluatedAt: new Date(Number.NaN),
      marketContext: MARKET,
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(captures).toHaveLength(0);
  });

  it("cancels the PostgreSQL query and reports cancellation", async () => {
    const controller = new AbortController();
    let rejectQuery: (error: Error) => void = () => undefined;
    const pending = new Promise<unknown[]>((_resolve, reject) => {
      rejectQuery = reject;
    }) as TestQuery;
    pending.cancel = vi.fn(() => rejectQuery(new Error("cancelled by postgres")));
    const { db } = databaseWith(() => pending);

    const result = new PostgresBranchDirectory(db).loadEligibleBranches({
      eligibleChainIds: ["extra"],
      evaluatedAt: AT,
      marketContext: MARKET,
    }, controller.signal);
    controller.abort();

    await expect(result).rejects.toMatchObject({ code: "CANCELLED" });
    expect(pending.cancel).toHaveBeenCalledTimes(1);

    const preAborted = new AbortController();
    preAborted.abort();
    await expect(new PostgresBranchDirectory(db).loadEligibleBranches({
      eligibleChainIds: ["extra"],
      evaluatedAt: AT,
      marketContext: MARKET,
    }, preAborted.signal)).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("sanitizes database failures without leaking provider details", async () => {
    const { db } = databaseWith(() => rejectedQuery(
      new Error("postgresql://private-user:private-password@private-host/internal"),
    ));

    const error = await new PostgresBranchDirectory(db).loadEligibleBranches({
      eligibleChainIds: ["extra"],
      evaluatedAt: AT,
      marketContext: MARKET,
    }).catch((fault: unknown) => fault);

    expect(error).toMatchObject({
      code: "UNAVAILABLE",
      message: "Branch directory unavailable",
      name: "BranchDirectoryReaderError",
    });
    expect(String(error)).not.toContain("private-password");
  });
});
