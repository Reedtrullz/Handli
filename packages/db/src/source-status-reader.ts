import { createHash } from "node:crypto";

import {
  isFiniteDate,
  PUBLIC_SOURCE_HEALTH_MAX_AGE_MS,
  publicSourceStatusEntrySchema,
  type PublicSourceStatusEntry,
} from "@handleplan/domain";

import type { HandleplanDatabase } from "./client";

export const MAX_PUBLIC_SOURCE_STATUS_ROWS = 100;

export interface PublicSourceStatusDirectory {
  entries: PublicSourceStatusEntry[];
  hasMore: boolean;
}

export interface PublicSourceStatusReader {
  read(
    limit: number,
    at: Date,
    signal?: AbortSignal,
  ): Promise<PublicSourceStatusDirectory>;
}

export type PublicSourceStatusReaderErrorCode =
  | "CANCELLED"
  | "INVALID_REQUEST"
  | "UNAVAILABLE";

export class PublicSourceStatusReaderError extends Error {
  constructor(readonly code: PublicSourceStatusReaderErrorCode) {
    super(`Public source status ${code.toLowerCase().replace("_", " ")}`);
    this.name = "PublicSourceStatusReaderError";
  }
}

type CancelableQuery<T> = PromiseLike<T> & { cancel(): void };

interface SourceStatusRow {
  governance_approved: unknown;
  health_last_capture_success_at: unknown;
  health_last_discovery_success_at: unknown;
  health_last_publish_success_at: unknown;
  health_newest_eligible_evidence_at: unknown;
  health_recorded_at: unknown;
  health_status: unknown;
  ingestion_completed_at: unknown;
  ingestion_started_at: unknown;
  ingestion_status: unknown;
  runtime_state: unknown;
  scope_country_code: unknown;
  scope_database_id: unknown;
  scope_kind: unknown;
  scope_label: unknown;
  scope_state: unknown;
  source_display_name: unknown;
  source_id: unknown;
  source_kind: unknown;
}

function readerError(code: PublicSourceStatusReaderErrorCode): PublicSourceStatusReaderError {
  return new PublicSourceStatusReaderError(code);
}

async function awaitAbortable<T>(
  query: CancelableQuery<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw readerError("CANCELLED");
  const onAbort = () => query.cancel();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    return await query;
  } catch (error) {
    if (signal?.aborted) throw readerError("CANCELLED");
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

function boundedString(value: unknown, maximum: number): string | undefined {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= maximum
    && value.trim() === value
    ? value
    : undefined;
}

function timestamp(
  value: unknown,
  maximum: Date,
): string | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) && date <= maximum
    ? date.toISOString()
    : undefined;
}

function sourceKind(value: unknown): PublicSourceStatusEntry["source"]["kind"] | undefined {
  switch (value) {
    case "catalog":
    case "offer":
    case "store":
    case "geocoder":
    case "routing":
    case "legacy":
      return value;
    case "ordinary_price":
      return "ordinary-price";
    default:
      return undefined;
  }
}

function scopeKind(value: unknown): NonNullable<PublicSourceStatusEntry["scope"]>["kind"] | undefined {
  switch (value) {
    case "national":
    case "region":
      return value;
    case "postal_set":
      return "postal-set";
    case "store_set":
      return "store-set";
    default:
      return undefined;
  }
}

function databaseIdentifier(value: unknown): string | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  }
  return typeof value === "string" && /^[1-9][0-9]{0,18}$/u.test(value)
    ? value
    : undefined;
}

function publicScopeId(sourceId: string, databaseScopeId: string): string {
  return `scope:${createHash("sha256")
    .update(Buffer.byteLength(sourceId, "utf8").toString())
    .update(":")
    .update(sourceId)
    .update(":")
    .update(databaseScopeId)
    .digest("hex")}`;
}

function entryFromRow(row: SourceStatusRow, at: Date): PublicSourceStatusEntry | undefined {
  const id = boundedString(row.source_id, 64);
  const displayName = boundedString(row.source_display_name, 160);
  const kind = sourceKind(row.source_kind);
  const runtimeState = row.runtime_state;
  if (
    id === undefined
    || displayName === undefined
    || kind === undefined
    || typeof row.governance_approved !== "boolean"
    || !["approved", "conditional", "blocked", "revoked"].includes(String(runtimeState))
  ) {
    return undefined;
  }

  const scopeDatabaseId = row.scope_database_id;
  let scope: PublicSourceStatusEntry["scope"] = null;
  if (scopeDatabaseId !== null) {
    const databaseScopeId = databaseIdentifier(scopeDatabaseId);
    const mappedKind = scopeKind(row.scope_kind);
    const label = boundedString(row.scope_label, 200);
    const countryCode = typeof row.scope_country_code === "string"
      && /^[A-Z]{2}$/u.test(row.scope_country_code)
      ? row.scope_country_code
      : undefined;
    if (
      databaseScopeId === undefined
      || mappedKind === undefined
      || label === undefined
      || countryCode === undefined
      || (row.scope_state !== "active" && row.scope_state !== "retired")
    ) {
      return undefined;
    }
    scope = {
      countryCode,
      id: publicScopeId(id, databaseScopeId),
      kind: mappedKind,
      label,
      state: row.scope_state,
    };
  } else if (
    row.scope_country_code !== null
    || row.scope_kind !== null
    || row.scope_label !== null
    || row.scope_state !== null
  ) {
    return undefined;
  }

  const healthRecordedAt = timestamp(row.health_recorded_at, at);
  let health: PublicSourceStatusEntry["health"] = null;
  if (healthRecordedAt !== null) {
    if (
      healthRecordedAt === undefined
      || !["healthy", "degraded", "failed", "disabled"].includes(
        String(row.health_status),
      )
    ) {
      return undefined;
    }
    const discoveryAt = timestamp(row.health_last_discovery_success_at, at);
    const captureAt = timestamp(row.health_last_capture_success_at, at);
    const publishAt = timestamp(row.health_last_publish_success_at, at);
    const eligibleEvidenceAt = timestamp(row.health_newest_eligible_evidence_at, at);
    if (
      discoveryAt === undefined
      || captureAt === undefined
      || publishAt === undefined
      || eligibleEvidenceAt === undefined
    ) {
      return undefined;
    }
    health = {
      freshness: at.getTime() - Date.parse(healthRecordedAt)
        <= PUBLIC_SOURCE_HEALTH_MAX_AGE_MS
        ? "current"
        : "stale",
      lastSuccess: { captureAt, discoveryAt, eligibleEvidenceAt, publishAt },
      recordedAt: healthRecordedAt,
      state: row.health_status as NonNullable<PublicSourceStatusEntry["health"]>["state"],
    };
  } else if (
    row.health_status !== null
    || row.health_last_discovery_success_at !== null
    || row.health_last_capture_success_at !== null
    || row.health_last_publish_success_at !== null
    || row.health_newest_eligible_evidence_at !== null
    || scope !== null
  ) {
    return undefined;
  }

  const ingestionCompletedAt = timestamp(row.ingestion_completed_at, at);
  let latestTerminalIngestion: PublicSourceStatusEntry["latestTerminalIngestion"] = null;
  if (ingestionCompletedAt !== null) {
    const startedAt = timestamp(row.ingestion_started_at, at);
    if (
      ingestionCompletedAt === undefined
      || startedAt === undefined
      || startedAt === null
      || !["completed", "degraded", "failed", "cancelled"].includes(
        String(row.ingestion_status),
      )
    ) {
      return undefined;
    }
    latestTerminalIngestion = {
      completedAt: ingestionCompletedAt,
      scope: "source-wide",
      startedAt,
      state: row.ingestion_status as NonNullable<
        PublicSourceStatusEntry["latestTerminalIngestion"]
      >["state"],
    };
  } else if (row.ingestion_started_at !== null || row.ingestion_status !== null) {
    return undefined;
  }

  const parsed = publicSourceStatusEntrySchema.safeParse({
    governanceState: row.governance_approved ? "approved" : "not-approved",
    health,
    latestTerminalIngestion,
    scope,
    source: { displayName, id, kind, runtimeState },
  });
  return parsed.success ? parsed.data : undefined;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareEntries(left: PublicSourceStatusEntry, right: PublicSourceStatusEntry): number {
  return compareText(left.source.displayName, right.source.displayName)
    || compareText(left.source.id, right.source.id)
    || compareText(left.scope?.id ?? "", right.scope?.id ?? "");
}

export class PostgresPublicSourceStatusReader implements PublicSourceStatusReader {
  constructor(private readonly db: HandleplanDatabase) {}

  async read(
    limit: number,
    at: Date,
    signal?: AbortSignal,
  ): Promise<PublicSourceStatusDirectory> {
    if (signal?.aborted) throw readerError("CANCELLED");
    if (
      !Number.isSafeInteger(limit)
      || limit < 1
      || limit > MAX_PUBLIC_SOURCE_STATUS_ROWS
      || !(at instanceof Date)
      || !isFiniteDate(at)
    ) {
      throw readerError("INVALID_REQUEST");
    }
    const evaluatedAt = at.toISOString();
    try {
      const rows = await awaitAbortable(this.db.$client<SourceStatusRow[]>`
        with ranked_permissions as (
          select
            permission.source_id,
            permission.decision,
            permission.reviewed_at,
            permission.valid_until,
            row_number() over (
              partition by permission.source_id
              order by permission.created_at desc, permission.id desc
            ) as permission_rank
          from source_permissions permission
          where permission.created_at <= ${evaluatedAt}::timestamptz
        ), latest_permissions as (
          select source_id, decision, reviewed_at, valid_until
          from ranked_permissions
          where permission_rank = 1
        ), ranked_health as (
          select
            health.id,
            health.source_id,
            health.geographic_scope_id,
            health.status,
            health.last_discovery_success_at,
            health.last_capture_success_at,
            health.last_publish_success_at,
            health.newest_eligible_evidence_at,
            health.recorded_at,
            health.persisted_at,
            row_number() over (
              partition by health.source_id, health.geographic_scope_id
              order by health.persisted_at desc, health.id desc
            ) as health_rank
          from source_health_snapshots health
          where health.persisted_at <= ${evaluatedAt}::timestamptz
            and health.recorded_at <= health.persisted_at
        ), latest_health as (
          select *
          from ranked_health
          where health_rank = 1
        ), ranked_publication_health as (
          select
            fact.id,
            fact.source_id,
            fact.last_publish_success_at,
            fact.newest_eligible_evidence_at,
            fact.persisted_at,
            row_number() over (
              partition by fact.source_id
              order by fact.persisted_at desc, fact.id desc
            ) as publication_health_rank
          from official_offer_publication_health_facts fact
          where fact.persisted_at <= ${evaluatedAt}::timestamptz
            and fact.last_publish_success_at <= fact.persisted_at
            and fact.newest_eligible_evidence_at <= fact.last_publish_success_at
        ), latest_publication_health as (
          select *
          from ranked_publication_health
          where publication_health_rank = 1
        ), ranked_terminal_ingestion as (
          select
            run.source_id,
            run.status,
            run.started_at,
            run.completed_at,
            row_number() over (
              partition by run.source_id
              order by run.terminalized_at desc, run.id desc
            ) as ingestion_rank
          from ingestion_runs run
          where run.status <> 'running'
            and run.created_at <= ${evaluatedAt}::timestamptz
            and run.started_at <= ${evaluatedAt}::timestamptz
            and run.completed_at <= ${evaluatedAt}::timestamptz
            and run.terminalized_at <= ${evaluatedAt}::timestamptz
        ), latest_terminal_ingestion as (
          select source_id, status, started_at, completed_at
          from ranked_terminal_ingestion
          where ingestion_rank = 1
        )
        select
          source.id as source_id,
          source.display_name as source_display_name,
          source.source_kind,
          source.runtime_state,
          coalesce((
            source.runtime_state = 'approved'
            and source.permission_reviewed_at is not null
            and source.permission_reviewed_at <= ${evaluatedAt}::timestamptz
            and (
              source.permission_expires_at is null
              or source.permission_expires_at > ${evaluatedAt}::timestamptz
            )
            and permission.decision = 'approved'
            and permission.reviewed_at <= ${evaluatedAt}::timestamptz
            and source.permission_reviewed_at = permission.reviewed_at
            and source.permission_expires_at is not distinct from permission.valid_until
            and (
              permission.valid_until is null
              or permission.valid_until > ${evaluatedAt}::timestamptz
            )
          ), false) as governance_approved,
          scope.id::text as scope_database_id,
          scope.scope_kind,
          scope.label as scope_label,
          scope.country_code as scope_country_code,
          scope.status as scope_state,
          case
            when publication_health.persisted_at is not null
              and (
                health.persisted_at is null
                or publication_health.persisted_at > health.persisted_at
              ) then 'degraded'
            else health.status
          end as health_status,
          health.last_discovery_success_at as health_last_discovery_success_at,
          health.last_capture_success_at as health_last_capture_success_at,
          case
            when health.last_publish_success_at is null
              then publication_health.last_publish_success_at
            when publication_health.last_publish_success_at is null
              then health.last_publish_success_at
            else greatest(
              health.last_publish_success_at,
              publication_health.last_publish_success_at
            )
          end as health_last_publish_success_at,
          case
            when health.newest_eligible_evidence_at is null
              then publication_health.newest_eligible_evidence_at
            when publication_health.newest_eligible_evidence_at is null
              then health.newest_eligible_evidence_at
            else greatest(
              health.newest_eligible_evidence_at,
              publication_health.newest_eligible_evidence_at
            )
          end as health_newest_eligible_evidence_at,
          case
            when publication_health.persisted_at is not null
              and (
                health.persisted_at is null
                or publication_health.persisted_at > health.persisted_at
              ) then publication_health.last_publish_success_at
            else health.recorded_at
          end as health_recorded_at,
          ingestion.status as ingestion_status,
          ingestion.started_at as ingestion_started_at,
          ingestion.completed_at as ingestion_completed_at
        from data_sources source
        left join latest_permissions permission on permission.source_id = source.id
        left join latest_health health on health.source_id = source.id
        left join latest_publication_health publication_health
          on publication_health.source_id = source.id
         and health.geographic_scope_id is null
        left join geographic_scopes scope
          on scope.id = health.geographic_scope_id
         and scope.created_at <= ${evaluatedAt}::timestamptz
         and scope.public_state_changed_at <= ${evaluatedAt}::timestamptz
        left join latest_terminal_ingestion ingestion on ingestion.source_id = source.id
        where source.created_at <= ${evaluatedAt}::timestamptz
          and source.public_state_changed_at <= ${evaluatedAt}::timestamptz
        order by source.display_name, source.id, scope.id nulls first
        limit ${limit + 1}
      `, signal);
      if (signal?.aborted) throw readerError("CANCELLED");
      const hasMore = rows.length > limit;
      const selected = rows.slice(0, limit);
      const entries = selected.map((row) => entryFromRow(row, at));
      if (entries.some((entry) => entry === undefined)) throw readerError("UNAVAILABLE");
      const canonical = (entries as PublicSourceStatusEntry[]).sort(compareEntries);
      const keys = canonical.map(({ source, scope }) => `${source.id}\u0000${scope?.id ?? ""}`);
      if (new Set(keys).size !== keys.length) throw readerError("UNAVAILABLE");
      return { entries: canonical, hasMore };
    } catch (error) {
      if (error instanceof PublicSourceStatusReaderError) throw error;
      if (signal?.aborted) throw readerError("CANCELLED");
      throw readerError("UNAVAILABLE");
    }
  }
}
