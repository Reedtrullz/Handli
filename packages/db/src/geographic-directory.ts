import {
  geographicDirectoryEvidenceSchema,
  isFiniteDate,
  type GeographicDirectoryEvidence,
} from "@handleplan/domain";

import type { HandleplanDatabase } from "./client";

const MAX_DIRECTORY_ROWS = 10_000;

type CancelableQuery<T> = PromiseLike<T> & { cancel(): void };

interface DirectoryRow {
  country_code: unknown;
  directory_created_at: unknown;
  directory_evidence_reference: unknown;
  directory_sealed_at: unknown;
  directory_status: unknown;
  postal_code: unknown;
  postal_count: unknown;
  region_code: unknown;
  region_coverage_state: unknown;
  region_created_at: unknown;
  region_evidence_reference: unknown;
  reviewed_at: unknown;
  valid_from: unknown;
  valid_until: unknown;
  version_id: unknown;
}

export interface GeographicDirectoryReader {
  read(
    countryCode: string,
    evaluatedAt: Date,
    signal?: AbortSignal,
  ): Promise<GeographicDirectoryEvidence>;
}

export class GeographicDirectoryReaderError extends Error {
  constructor(readonly code: "CANCELLED" | "INVALID_REQUEST") {
    super(`Geographic directory ${code.toLowerCase().replace("_", " ")}`);
    this.name = "GeographicDirectoryReaderError";
  }
}

function databaseDate(value: unknown): Date | undefined {
  if (value instanceof Date) return isFiniteDate(value) ? value : undefined;
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parsed = new Date(value);
  return isFiniteDate(parsed) ? parsed : undefined;
}

async function awaitAbortable<T>(
  query: CancelableQuery<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new GeographicDirectoryReaderError("CANCELLED");
  const onAbort = () => query.cancel();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    return await query;
  } catch (error) {
    if (signal?.aborted) throw new GeographicDirectoryReaderError("CANCELLED");
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

function unavailable(reason: string): GeographicDirectoryEvidence {
  return { state: "unknown", reason };
}

export class PostgresGeographicDirectoryReader implements GeographicDirectoryReader {
  constructor(private readonly db: HandleplanDatabase) {}

  async read(
    countryCode: string,
    evaluatedAt: Date,
    signal?: AbortSignal,
  ): Promise<GeographicDirectoryEvidence> {
    if (signal?.aborted) throw new GeographicDirectoryReaderError("CANCELLED");
    if (
      typeof countryCode !== "string"
      || !/^[A-Z]{2}$/u.test(countryCode)
      || !(evaluatedAt instanceof Date)
      || !isFiniteDate(evaluatedAt)
    ) {
      throw new GeographicDirectoryReaderError("INVALID_REQUEST");
    }

    const at = evaluatedAt.toISOString();
    const query = this.db.$client<DirectoryRow[]>`
      with terminal_candidates as (
        select version.*
        from public.geographic_postal_directory_versions version
        where version.country_code = ${countryCode}
          and version.status <> 'building'
          and version.reviewed_at <= ${at}::timestamptz
          and version.sealed_at <= ${at}::timestamptz
      ), latest_review as (
        select max(reviewed_at) as reviewed_at
        from terminal_candidates
      )
      select
        version.version_id,
        version.country_code,
        version.status as directory_status,
        version.reviewed_at,
        version.valid_from,
        version.valid_until,
        version.evidence_reference as directory_evidence_reference,
        version.created_at as directory_created_at,
        version.sealed_at as directory_sealed_at,
        region.region_code,
        region.coverage_state as region_coverage_state,
        region.postal_count,
        region.evidence_reference as region_evidence_reference,
        region.created_at as region_created_at,
        code.postal_code
      from terminal_candidates version
      inner join latest_review latest on latest.reviewed_at = version.reviewed_at
      left join public.geographic_postal_directory_regions region
        on region.version_id = version.version_id
       and region.created_at <= ${at}::timestamptz
      left join public.geographic_postal_directory_codes code
        on code.version_id = region.version_id
       and code.region_code = region.region_code
       and code.created_at <= ${at}::timestamptz
      order by version.version_id, region.region_code, code.postal_code
      limit ${MAX_DIRECTORY_ROWS + 1}
    `;

    let rows: DirectoryRow[];
    try {
      rows = await awaitAbortable(query, signal);
    } catch (error) {
      if (error instanceof GeographicDirectoryReaderError) throw error;
      return unavailable("postal-directory-unavailable");
    }
    if (!Array.isArray(rows) || rows.length > MAX_DIRECTORY_ROWS) {
      return unavailable("invalid-postal-directory");
    }
    if (rows.length === 0) return unavailable("postal-directory-unavailable");

    const versionIds = new Set(rows.map(({ version_id }) => version_id));
    if (
      versionIds.size !== 1
      || [...versionIds].some((value) => typeof value !== "string")
    ) {
      return { state: "ambiguous", reason: "overlapping-directory-versions" };
    }

    const first = rows[0]!;
    const reviewedAt = databaseDate(first.reviewed_at);
    const validFrom = databaseDate(first.valid_from);
    const validUntil = first.valid_until === null
      ? undefined
      : databaseDate(first.valid_until);
    const createdAt = databaseDate(first.directory_created_at);
    const publishedAt = databaseDate(first.directory_sealed_at);
    if (
      typeof first.version_id !== "string"
      || first.country_code !== countryCode
      || typeof first.directory_status !== "string"
      || typeof first.directory_evidence_reference !== "string"
      || reviewedAt === undefined
      || validFrom === undefined
      || (first.valid_until !== null && validUntil === undefined)
      || createdAt === undefined
      || publishedAt === undefined
      || createdAt.getTime() > publishedAt.getTime()
      || publishedAt.getTime() > evaluatedAt.getTime()
      || rows.some((row) =>
        row.version_id !== first.version_id
        || row.country_code !== first.country_code
        || row.directory_status !== first.directory_status
        || row.directory_evidence_reference !== first.directory_evidence_reference
        || databaseDate(row.reviewed_at)?.getTime() !== reviewedAt.getTime()
        || databaseDate(row.valid_from)?.getTime() !== validFrom.getTime()
        || (row.valid_until === null ? undefined : databaseDate(row.valid_until)?.getTime())
          !== validUntil?.getTime()
        || databaseDate(row.directory_created_at)?.getTime() !== createdAt.getTime()
        || databaseDate(row.directory_sealed_at)?.getTime() !== publishedAt.getTime())
    ) {
      return unavailable("invalid-postal-directory");
    }
    if (first.directory_status !== "approved") {
      return unavailable(`postal-directory-${first.directory_status}`);
    }
    if (
      validFrom.getTime() > evaluatedAt.getTime()
      || (validUntil !== undefined && validUntil.getTime() <= evaluatedAt.getTime())
    ) {
      return unavailable("postal-directory-not-current");
    }

    const regions = new Map<string, {
      coverageState: "complete" | "ambiguous";
      evidenceReference: string;
      postalCodes: string[];
      postalCount: number;
    }>();
    for (const row of rows) {
      if (
        typeof row.region_code !== "string"
        || (row.region_coverage_state !== "complete"
          && row.region_coverage_state !== "ambiguous")
        || typeof row.region_evidence_reference !== "string"
        || typeof row.postal_count !== "number"
        || !Number.isSafeInteger(row.postal_count)
        || databaseDate(row.region_created_at) === undefined
        || (row.postal_code !== null
          && (typeof row.postal_code !== "string" || !/^[0-9]{4}$/u.test(row.postal_code)))
      ) {
        return unavailable("invalid-postal-directory");
      }
      const previous = regions.get(row.region_code);
      const region = previous ?? {
        coverageState: row.region_coverage_state,
        evidenceReference: row.region_evidence_reference,
        postalCodes: [],
        postalCount: row.postal_count,
      };
      if (
        region.coverageState !== row.region_coverage_state
        || region.evidenceReference !== row.region_evidence_reference
        || region.postalCount !== row.postal_count
      ) {
        return unavailable("invalid-postal-directory");
      }
      if (typeof row.postal_code === "string") region.postalCodes.push(row.postal_code);
      regions.set(row.region_code, region);
    }

    const directory = {
      contractVersion: 1 as const,
      countryCode,
      directoryVersionId: first.version_id,
      evidenceReference: first.directory_evidence_reference,
      publishedAt: publishedAt.toISOString(),
      regions: [...regions.entries()].sort(([left], [right]) => left.localeCompare(right)).map(
        ([regionCode, region]) => ({
          coverageState: region.coverageState,
          evidenceReference: region.evidenceReference,
          postalCodes: [...region.postalCodes].sort(),
          regionCode,
        }),
      ),
      reviewedAt: reviewedAt.toISOString(),
      status: "approved" as const,
      validFrom: validFrom.toISOString(),
      ...(validUntil === undefined ? {} : { validUntil: validUntil.toISOString() }),
    };
    if ([...regions.values()].some((region) =>
      region.postalCodes.length !== region.postalCount
      || new Set(region.postalCodes).size !== region.postalCodes.length)) {
      return unavailable("invalid-postal-directory");
    }
    const parsed = geographicDirectoryEvidenceSchema.safeParse({
      state: "available",
      evaluatedAt: at,
      directory,
    });
    return parsed.success ? parsed.data : unavailable("invalid-postal-directory");
  }
}
