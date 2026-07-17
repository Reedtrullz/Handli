import {
  internalTravelBranchSchema,
  isFiniteDate,
  marketContextV1Schema,
  type InternalTravelBranch,
  type MarketContextV1,
  type TravelChainId,
} from "@handleplan/domain";

import type { HandleplanDatabase } from "./client";

export const MAX_BRANCH_DIRECTORY_BRANCHES = 5_000;
// The production sync is daily; two schedule intervals permit one missed run
// without treating a week-old directory as current routing evidence.
export const PHYSICAL_STORE_COVERAGE_MAX_AGE_MS = 48 * 60 * 60 * 1_000;

const CHAIN_ORDER: Readonly<Record<TravelChainId, number>> = {
  bunnpris: 0,
  extra: 1,
  "rema-1000": 2,
};

type CancelableQuery<T> = PromiseLike<T> & { cancel(): void };

interface PublicBranchRow {
  branch_id: unknown;
  chain: unknown;
  latitude: unknown;
  longitude: unknown;
  name: unknown;
  directory_evidence_reference?: unknown;
  directory_reviewed_at?: unknown;
  directory_version_id?: unknown;
  region_evidence_reference?: unknown;
  region_code?: unknown;
}

export interface BranchDirectoryQuery {
  eligibleChainIds: readonly TravelChainId[];
  evaluatedAt: Date;
  marketContext: MarketContextV1;
}

export interface BranchDirectorySnapshot {
  branches: InternalTravelBranch[];
  complete: boolean;
  contractVersion: 1;
  eligibleChainIds: TravelChainId[];
  marketContext: MarketContextV1;
  regionEvidence?: {
    contractVersion: 1;
    countryCode: "NO";
    directoryEvidenceReference: string;
    directoryVersionId: string;
    regionEvidenceReference: string;
    regionId: string;
    reviewedAt: string;
  };
}

export class BranchDirectoryReaderError extends Error {
  constructor(readonly code: "CANCELLED" | "INVALID_REQUEST" | "UNAVAILABLE") {
    super(`Branch directory ${code.toLowerCase().replace("_", " ")}`);
    this.name = "BranchDirectoryReaderError";
  }
}

function cancelledError(): BranchDirectoryReaderError {
  return new BranchDirectoryReaderError("CANCELLED");
}

async function awaitAbortable<T>(
  query: CancelableQuery<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw cancelledError();
  const onAbort = () => query.cancel();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    return await query;
  } catch (error) {
    if (signal?.aborted) throw cancelledError();
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

function canonicalChains(value: readonly TravelChainId[]): TravelChainId[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) return undefined;
  if (value.some((chain: unknown) =>
    chain !== "bunnpris" && chain !== "extra" && chain !== "rema-1000")) {
    return undefined;
  }
  const unique = [...new Set(value as readonly TravelChainId[])];
  if (unique.length !== value.length) return undefined;
  return unique.sort((left, right) => CHAIN_ORDER[left] - CHAIN_ORDER[right]);
}

function coordinateE6(value: unknown, maximum: number): number | undefined {
  if (
    (typeof value !== "number" && typeof value !== "string")
    || (typeof value === "string" && !/^-?\d+(?:\.\d{1,6})?$/.test(value))
  ) {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  const scaled = Math.round(parsed * 1_000_000);
  return Number.isFinite(parsed)
    && Number.isSafeInteger(scaled)
    && Math.abs(scaled) <= maximum
    ? scaled
    : undefined;
}

function branchFromRow(row: PublicBranchRow): InternalTravelBranch | undefined {
  const latitudeE6 = coordinateE6(row.latitude, 90_000_000);
  const longitudeE6 = coordinateE6(row.longitude, 180_000_000);
  if (latitudeE6 === undefined || longitudeE6 === undefined) return undefined;
  const parsed = internalTravelBranchSchema.safeParse({
    branchId: row.branch_id,
    chainId: row.chain,
    coordinate: { latitudeE6, longitudeE6 },
    name: row.name,
  });
  return parsed.success ? parsed.data : undefined;
}

function databaseDate(value: unknown): Date | undefined {
  if (value instanceof Date) return isFiniteDate(value) ? value : undefined;
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parsed = new Date(value);
  return isFiniteDate(parsed) ? parsed : undefined;
}

function regionEvidenceFromRows(
  rows: readonly PublicBranchRow[],
  marketContext: MarketContextV1,
  evaluatedAt: Date,
): BranchDirectorySnapshot["regionEvidence"] | null {
  if (marketContext.kind === "national") {
    return rows.every((row) =>
      row.directory_version_id == null
      && row.directory_evidence_reference == null
      && row.region_code == null
      && row.region_evidence_reference == null
      && row.directory_reviewed_at == null)
      ? undefined
      : null;
  }
  const first = rows[0];
  if (first === undefined) return null;
  const reviewedAt = databaseDate(first.directory_reviewed_at);
  if (
    typeof first.directory_version_id !== "string"
    || typeof first.directory_evidence_reference !== "string"
    || first.region_code !== marketContext.regionId
    || typeof first.region_evidence_reference !== "string"
    || reviewedAt === undefined
    || reviewedAt.getTime() > evaluatedAt.getTime()
    || rows.some((row) =>
      row.directory_version_id !== first.directory_version_id
      || row.directory_evidence_reference !== first.directory_evidence_reference
      || row.region_code !== first.region_code
      || row.region_evidence_reference !== first.region_evidence_reference
      || databaseDate(row.directory_reviewed_at)?.getTime() !== reviewedAt.getTime())
  ) {
    return null;
  }
  return {
    contractVersion: 1,
    countryCode: marketContext.countryCode,
    directoryEvidenceReference: first.directory_evidence_reference,
    directoryVersionId: first.directory_version_id,
    regionEvidenceReference: first.region_evidence_reference,
    regionId: marketContext.regionId,
    reviewedAt: reviewedAt.toISOString(),
  };
}

function incomplete(
  chains: TravelChainId[],
  marketContext: MarketContextV1,
): BranchDirectorySnapshot {
  return {
    branches: [],
    complete: false,
    contractVersion: 1,
    eligibleChainIds: chains,
    marketContext: { ...marketContext },
  };
}

export class PostgresBranchDirectory {
  constructor(private readonly db: HandleplanDatabase) {}

  async loadEligibleBranches(
    input: BranchDirectoryQuery,
    signal?: AbortSignal,
  ): Promise<BranchDirectorySnapshot> {
    if (signal?.aborted) throw cancelledError();
    const chains = canonicalChains(input.eligibleChainIds);
    const market = marketContextV1Schema.safeParse(input.marketContext);
    if (
      chains === undefined
      || !market.success
      || !(input.evaluatedAt instanceof Date)
      || !isFiniteDate(input.evaluatedAt)
    ) {
      throw new BranchDirectoryReaderError("INVALID_REQUEST");
    }

    const evaluatedAt = input.evaluatedAt.toISOString();
    const marketContext = market.data;
    const regionId = marketContext.kind === "launch-region"
      ? marketContext.regionId
      : null;
    const freshnessStartsAt = new Date(
      input.evaluatedAt.getTime() - PHYSICAL_STORE_COVERAGE_MAX_AGE_MS,
    ).toISOString();
    const query = this.db.$client<PublicBranchRow[]>`
      with requested_chains as (
        select value as chain
        from pg_catalog.jsonb_array_elements_text(${JSON.stringify(chains)}::jsonb)
      ), terminal_directory_candidates as (
        select version.*
        from public.geographic_postal_directory_versions version
        where version.country_code = ${marketContext.countryCode}
          and version.status <> 'building'
          and version.reviewed_at <= ${evaluatedAt}::timestamptz
          and version.sealed_at <= ${evaluatedAt}::timestamptz
      ), latest_directory_review as (
        select max(reviewed_at) as reviewed_at
        from terminal_directory_candidates
      ), selected_terminal_directory as (
        select candidate.*
        from terminal_directory_candidates candidate
        inner join latest_directory_review latest
          on latest.reviewed_at = candidate.reviewed_at
        where (
          select count(*)
          from terminal_directory_candidates sibling
          where sibling.reviewed_at = latest.reviewed_at
        ) = 1
      ), current_directory as (
        select terminal.*
        from selected_terminal_directory terminal
        where terminal.status = 'approved'
          and terminal.valid_from <= ${evaluatedAt}::timestamptz
          and (
            terminal.valid_until is null
            or terminal.valid_until > ${evaluatedAt}::timestamptz
          )
      ), current_region as (
        select region.*
        from public.geographic_postal_directory_regions region
        inner join current_directory directory
          on directory.version_id = region.version_id
        where ${regionId}::text is not null
          and region.region_code = ${regionId}::text
          and region.coverage_state = 'complete'
          and region.created_at <= ${evaluatedAt}::timestamptz
          and region.postal_count = (
            select count(*)
            from public.geographic_postal_directory_codes code
            where code.version_id = region.version_id
              and code.region_code = region.region_code
              and code.created_at <= ${evaluatedAt}::timestamptz
          )
      ), public_branches as (
        select
          branch.branch_id,
          branch.chain,
          branch.name,
          branch.latitude,
          branch.longitude,
          null::varchar as directory_version_id,
          null::varchar as directory_evidence_reference,
          null::varchar as region_code,
          null::varchar as region_evidence_reference,
          null::timestamptz as directory_reviewed_at,
          null::timestamptz as directory_sealed_at
        from public.physical_store_branches_public branch
        where ${regionId}::text is null

        union all

        select
          branch.branch_id,
          branch.chain,
          branch.name,
          branch.latitude,
          branch.longitude,
          branch.directory_version_id,
          branch.directory_evidence_reference,
          branch.region_code,
          branch.region_evidence_reference,
          branch.directory_reviewed_at,
          branch.directory_sealed_at
        from public.physical_store_region_branches_public branch
        inner join current_directory directory
          on directory.version_id = branch.directory_version_id
        inner join current_region region
          on region.version_id = branch.directory_version_id
         and region.region_code = branch.region_code
        where ${regionId}::text is not null
          and branch.region_code = ${regionId}::text
          and branch.branch_observed_at <= ${evaluatedAt}::timestamptz
          and branch.branch_created_at <= ${evaluatedAt}::timestamptz
          and branch.directory_created_at <= ${evaluatedAt}::timestamptz
          and branch.directory_sealed_at <= ${evaluatedAt}::timestamptz
          and branch.region_created_at <= ${evaluatedAt}::timestamptz
          and branch.postal_mapping_created_at <= ${evaluatedAt}::timestamptz
      ), source_runs as (
        select
          run.id,
          run.source_id,
          run.status,
          run.terminalized_at,
          row_number() over (
            partition by run.source_id
            order by run.terminalized_at desc, run.id desc
          ) as source_rank
        from public.ingestion_runs run
        inner join public.data_sources source on source.id = run.source_id
        inner join lateral (
          select
            permission.id,
            permission.decision,
            permission.permissions,
            permission.valid_until
          from public.source_permissions permission
          where permission.source_id = source.id
            and permission.created_at <= ${evaluatedAt}::timestamptz
            and permission.reviewed_at <= ${evaluatedAt}::timestamptz
          order by permission.reviewed_at desc, permission.id desc
          limit 1
        ) permission on true
        where run.run_type = 'physical-stores'
          and run.status <> 'running'
          and run.created_at <= ${evaluatedAt}::timestamptz
          and run.completed_at <= ${evaluatedAt}::timestamptz
          and run.terminalized_at <= ${evaluatedAt}::timestamptz
          and source.created_at <= ${evaluatedAt}::timestamptz
          and source.public_state_changed_at <= ${evaluatedAt}::timestamptz
          and source.runtime_state = 'approved'
          and permission.decision = 'approved'
          and permission.permissions @> '{"physicalStore":true}'::jsonb
          and (
            permission.valid_until is null
            or permission.valid_until > ${evaluatedAt}::timestamptz
          )
          and source.permission_reviewed_at is not null
          and source.permission_reviewed_at <= ${evaluatedAt}::timestamptz
          and (
            source.permission_expires_at is null
            or source.permission_expires_at > ${evaluatedAt}::timestamptz
          )
      ), eligible_runs as (
        select source_run.id
        from source_runs source_run
        where source_run.source_rank = 1
          and source_run.status = 'completed'
          and not exists (
            select 1
            from requested_chains requested
            where not exists (
              select 1
              from public.physical_store_coverage_checks coverage
              where coverage.ingestion_run_id = source_run.id
                and coverage.source_id = source_run.source_id
                and coverage.chain = requested.chain
                and coverage.state = 'complete'
                and coverage.checked_at >= ${freshnessStartsAt}::timestamptz
                and coverage.checked_at <= ${evaluatedAt}::timestamptz
                and coverage.created_at <= ${evaluatedAt}::timestamptz
            )
          )
        order by source_run.terminalized_at desc, source_run.id desc
        limit 1
      )
      select
        branch.branch_id,
        branch.chain,
        branch.name,
        branch.latitude,
        branch.longitude,
        branch.directory_version_id,
        branch.directory_evidence_reference,
        branch.region_code,
        branch.region_evidence_reference,
        branch.directory_reviewed_at
      from eligible_runs run
      inner join public_branches branch
        on branch.branch_id like 'branch:' || run.id::text || ':%'
      inner join requested_chains requested on requested.chain = branch.chain
      order by branch.chain, branch.branch_id
      limit ${MAX_BRANCH_DIRECTORY_BRANCHES + 1}
    `;
    let rows: PublicBranchRow[];
    try {
      rows = await awaitAbortable(query, signal);
    } catch (error) {
      if (error instanceof BranchDirectoryReaderError) throw error;
      throw new BranchDirectoryReaderError("UNAVAILABLE");
    }
    if (signal?.aborted) throw cancelledError();
    if (!Array.isArray(rows) || rows.length > MAX_BRANCH_DIRECTORY_BRANCHES) {
      throw new BranchDirectoryReaderError("UNAVAILABLE");
    }

    const branches = rows.map(branchFromRow);
    if (branches.some((branch) => branch === undefined)) {
      throw new BranchDirectoryReaderError("UNAVAILABLE");
    }
    const parsedBranches = branches as InternalTravelBranch[];
    if (
      new Set(parsedBranches.map(({ branchId }) => branchId)).size !== parsedBranches.length
      || chains.some((chain) => !parsedBranches.some(({ chainId }) => chainId === chain))
    ) {
      return incomplete(chains, marketContext);
    }
    const regionEvidence = regionEvidenceFromRows(rows, marketContext, input.evaluatedAt);
    if (regionEvidence === null) throw new BranchDirectoryReaderError("UNAVAILABLE");
    return {
      branches: parsedBranches,
      complete: true,
      contractVersion: 1,
      eligibleChainIds: chains,
      marketContext: { ...marketContext },
      ...(regionEvidence === undefined ? {} : { regionEvidence }),
    };
  }
}
