import "server-only";

import type { HandleplanDatabase } from "@handleplan/db/client";

import type { OperationsRuntimeServiceContract } from "./operations-runtime-service";
import { REQUIRED_DATABASE_MIGRATION } from "./readiness";

export type PrivateRuntimeKind = "operations" | "review";

export const PRIVATE_RUNTIME_DATABASE_ROLES = Object.freeze({
  operations: "handleplan_operations",
  review: "handleplan_review",
} as const satisfies Record<PrivateRuntimeKind, string>);

export interface PrivateRuntimeReadinessResult {
  databaseRole: (typeof PRIVATE_RUNTIME_DATABASE_ROLES)[PrivateRuntimeKind];
  requiredMigration: typeof REQUIRED_DATABASE_MIGRATION;
  runtime: PrivateRuntimeKind;
}

export interface PrivateRuntimeReadinessProbe {
  check(signal?: AbortSignal): Promise<PrivateRuntimeReadinessResult>;
}

export class PrivateRuntimeReadinessUnavailableError extends Error {
  constructor() {
    super("Private runtime dependencies are unavailable");
    this.name = "PrivateRuntimeReadinessUnavailableError";
  }
}

interface PrivateRuntimeReadinessProbeOptions {
  checkDependency: (signal: AbortSignal) => Promise<boolean>;
  expectedDatabaseRole: (typeof PRIVATE_RUNTIME_DATABASE_ROLES)[PrivateRuntimeKind];
  requiredMigration: typeof REQUIRED_DATABASE_MIGRATION;
  runtime: PrivateRuntimeKind;
  timeoutMs: number;
}

const MAX_READINESS_TIMEOUT_MS = 10_000;

export class BoundedPrivateRuntimeReadinessProbe implements PrivateRuntimeReadinessProbe {
  private readonly options: Readonly<PrivateRuntimeReadinessProbeOptions>;

  constructor(options: PrivateRuntimeReadinessProbeOptions) {
    if (
      !Number.isInteger(options.timeoutMs)
      || options.timeoutMs < 1
      || options.timeoutMs > MAX_READINESS_TIMEOUT_MS
    ) {
      throw new TypeError(
        `timeoutMs must be an integer from 1 through ${MAX_READINESS_TIMEOUT_MS}`,
      );
    }
    if (options.requiredMigration !== REQUIRED_DATABASE_MIGRATION) {
      throw new TypeError("Private runtime readiness must require the current migration");
    }
    if (options.expectedDatabaseRole !== PRIVATE_RUNTIME_DATABASE_ROLES[options.runtime]) {
      throw new TypeError("Private runtime readiness database role does not match its runtime");
    }
    this.options = Object.freeze({ ...options });
  }

  async check(signal?: AbortSignal): Promise<PrivateRuntimeReadinessResult> {
    const deadline = new AbortController();
    const combinedSignal = signal
      ? AbortSignal.any([signal, deadline.signal])
      : deadline.signal;
    const timer = setTimeout(() => deadline.abort(), this.options.timeoutMs);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new PrivateRuntimeReadinessUnavailableError());
      combinedSignal.addEventListener("abort", onAbort, { once: true });
      if (combinedSignal.aborted) onAbort();
    });

    try {
      const ready = await Promise.race([
        this.options.checkDependency(combinedSignal),
        aborted,
      ]);
      if (!ready || combinedSignal.aborted) {
        throw new PrivateRuntimeReadinessUnavailableError();
      }
      return {
        databaseRole: this.options.expectedDatabaseRole,
        requiredMigration: this.options.requiredMigration,
        runtime: this.options.runtime,
      };
    } catch {
      throw new PrivateRuntimeReadinessUnavailableError();
    } finally {
      clearTimeout(timer);
      if (onAbort !== undefined) {
        combinedSignal.removeEventListener("abort", onAbort);
      }
    }
  }
}

type CancelableQuery<T> = PromiseLike<T> & { cancel(): void };

async function awaitCancelable<T>(
  query: CancelableQuery<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw new PrivateRuntimeReadinessUnavailableError();
  const cancel = () => query.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    const value = await query;
    if (signal.aborted) throw new PrivateRuntimeReadinessUnavailableError();
    return value;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

interface ReviewReadinessRow {
  decision_v1_execute: boolean;
  decision_v2_execute: boolean;
  evidence_render_execute: boolean;
  lifecycle_execute: boolean;
  migration_028_marker: boolean;
  migration_ledger_select: boolean;
  publication_health_select: boolean;
  queue_execute: boolean;
  role_name: string;
}

const REVIEW_QUEUE_SIGNATURE =
  "public.private_review_candidate_rows_v1(bigint,timestamp with time zone,text,text,integer,integer,integer,integer,text,timestamp with time zone,bigint,integer)";
const REVIEW_EVIDENCE_RENDER_SIGNATURE =
  "public.private_review_record_evidence_render_v1(bigint,integer,text,text,text,text,text,text,text,timestamp with time zone)";
const REVIEW_DECISION_V1_SIGNATURE =
  "public.private_review_decide_v1(bigint,integer,text,text,text,text,text,text,text,integer,integer,integer,integer,text,text,timestamp with time zone,timestamp with time zone,text[])";
const REVIEW_DECISION_V2_SIGNATURE =
  "public.private_review_decide_v2(bigint,integer,text,text,text,text,text,text,text,text,text,integer,integer,integer,integer,text,text,timestamp with time zone,timestamp with time zone,text[])";
const LIFECYCLE_SIGNATURE =
  "public.official_offer_lifecycle_reconcile_v1(text,text,text,timestamp with time zone,text,integer,boolean)";
const MIGRATION_027_MARKER_RELATION =
  "public.official_offer_publication_health_facts";
const MIGRATION_028_MARKER_RELATION =
  "public.private_review_evidence_renders";

/**
 * Review is intentionally denied the migration ledger after the private
 * security-definer boundary. Prove the exact allowlist/denylist and use the
 * image-only evidence constraint only as a catalog marker for migration 028.
 */
export function createReviewPostgresReadinessCheck(
  db: HandleplanDatabase,
): PrivateRuntimeReadinessProbeOptions["checkDependency"] {
  return async (signal) => {
    const rows = await awaitCancelable(db.$client<ReviewReadinessRow[]>`
      select
        current_user::text as role_name,
        pg_catalog.has_function_privilege(
          current_user,
          ${REVIEW_QUEUE_SIGNATURE},
          'EXECUTE'
        ) as queue_execute,
        pg_catalog.has_function_privilege(
          current_user,
          ${REVIEW_EVIDENCE_RENDER_SIGNATURE},
          'EXECUTE'
        ) as evidence_render_execute,
        pg_catalog.has_function_privilege(
          current_user,
          ${REVIEW_DECISION_V1_SIGNATURE},
          'EXECUTE'
        ) as decision_v1_execute,
        pg_catalog.has_function_privilege(
          current_user,
          ${REVIEW_DECISION_V2_SIGNATURE},
          'EXECUTE'
        ) as decision_v2_execute,
        pg_catalog.to_regclass(${MIGRATION_027_MARKER_RELATION}) is not null
          and exists (
            select 1
            from pg_catalog.pg_constraint constraint_state
            where constraint_state.conrelid = pg_catalog.to_regclass(
              ${MIGRATION_028_MARKER_RELATION}
            )
              and constraint_state.conname = 'private_review_evidence_renders_image_mime'
              and constraint_state.convalidated
          ) as migration_028_marker,
        pg_catalog.has_function_privilege(
          current_user,
          ${LIFECYCLE_SIGNATURE},
          'EXECUTE'
        ) as lifecycle_execute,
        pg_catalog.has_table_privilege(
          current_user,
          ${MIGRATION_027_MARKER_RELATION},
          'SELECT'
        ) as publication_health_select,
        pg_catalog.has_table_privilege(
          current_user,
          'public.handleplan_schema_migrations',
          'SELECT'
        ) as migration_ledger_select
    `, signal);
    return rows.length === 1
      && rows[0]?.role_name === PRIVATE_RUNTIME_DATABASE_ROLES.review
      && rows[0]?.queue_execute === true
      && rows[0]?.evidence_render_execute === true
      && rows[0]?.decision_v1_execute === false
      && rows[0]?.decision_v2_execute === true
      && rows[0]?.migration_028_marker === true
      && rows[0]?.lifecycle_execute === false
      && rows[0]?.publication_health_select === false
      && rows[0]?.migration_ledger_select === false;
  };
}

interface OperationsReadinessRow {
  alert_append_execute: boolean;
  alert_export_execute: boolean;
  dashboard_execute: boolean;
  lifecycle_execute: boolean;
  migration_ledger_select: boolean;
  migration_028_marker: boolean;
  publication_health_select: boolean;
  role_name: string;
}

const OPERATIONS_DASHBOARD_SIGNATURE =
  "public.operations_dashboard_rows_v1(text[],integer)";
const OPERATIONS_ALERT_APPEND_SIGNATURE =
  "public.append_operations_alert_evaluation_v1(timestamp with time zone,jsonb,jsonb)";
const OPERATIONS_ALERT_EXPORT_SIGNATURE =
  "public.operations_alert_export_rows_v1(bigint,integer)";

/**
 * Operations intentionally has no SELECT privilege on the migration ledger.
 * Its readiness proof therefore checks the expected role, its one allowlisted
 * aggregate capability, the migration-028 marker, denied dormant alert
 * capabilities, and a real bounded aggregate read through the normal service.
 */
export function createOperationsPostgresReadinessCheck(
  db: HandleplanDatabase,
  operationsService: OperationsRuntimeServiceContract,
  expectedRosterSha256: string,
): PrivateRuntimeReadinessProbeOptions["checkDependency"] {
  return async (signal) => {
    const rows = await awaitCancelable(db.$client<OperationsReadinessRow[]>`
      select
        current_user::text as role_name,
        pg_catalog.has_function_privilege(
          current_user,
          ${OPERATIONS_DASHBOARD_SIGNATURE},
          'EXECUTE'
        ) as dashboard_execute,
        pg_catalog.has_function_privilege(
          current_user,
          ${OPERATIONS_ALERT_APPEND_SIGNATURE},
          'EXECUTE'
        ) as alert_append_execute,
        pg_catalog.has_function_privilege(
          current_user,
          ${OPERATIONS_ALERT_EXPORT_SIGNATURE},
          'EXECUTE'
        ) as alert_export_execute,
        pg_catalog.to_regclass(${MIGRATION_027_MARKER_RELATION}) is not null
          and exists (
            select 1
            from pg_catalog.pg_constraint constraint_state
            where constraint_state.conrelid = pg_catalog.to_regclass(
              ${MIGRATION_028_MARKER_RELATION}
            )
              and constraint_state.conname = 'private_review_evidence_renders_image_mime'
              and constraint_state.convalidated
          ) as migration_028_marker,
        pg_catalog.has_function_privilege(
          current_user,
          ${LIFECYCLE_SIGNATURE},
          'EXECUTE'
        ) as lifecycle_execute,
        pg_catalog.has_table_privilege(
          current_user,
          ${MIGRATION_027_MARKER_RELATION},
          'SELECT'
        ) as publication_health_select,
        pg_catalog.has_table_privilege(
          current_user,
          'public.handleplan_schema_migrations',
          'SELECT'
        ) as migration_ledger_select
    `, signal);
    const row = rows[0];
    if (
      rows.length !== 1
      || row?.role_name !== PRIVATE_RUNTIME_DATABASE_ROLES.operations
      || row.dashboard_execute !== true
      || row.alert_append_execute !== false
      || row.alert_export_execute !== false
      || row.migration_028_marker !== true
      || row.lifecycle_execute !== false
      || row.publication_health_select !== false
      || row.migration_ledger_select !== false
    ) return false;

    const snapshot = await operationsService.read(signal);
    return snapshot.kind === "internal-operations-snapshot"
      && snapshot.completeness === "bounded-aggregate"
      && snapshot.sourceRoster.contentSha256 === expectedRosterSha256
      && snapshot.sources.length === snapshot.sourceRoster.entries.length;
  };
}

const INTERNAL_HEALTH_PATHS = Object.freeze({
  operations: "/api/internal/health/operations",
  review: "/api/internal/health/review",
} as const satisfies Record<PrivateRuntimeKind, string>);

const INTERNAL_HEALTH_MARKERS = Object.freeze({
  operations: "handleplan-operations-health-v1",
  review: "handleplan-review-health-v1",
} as const satisfies Record<PrivateRuntimeKind, string>);

const PRIVATE_HEALTH_HEADERS = Object.freeze({
  "cache-control": "private, no-store",
  "content-type": "application/json; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
});

function privateHealthResponse(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    headers: PRIVATE_HEALTH_HEADERS,
    status,
  });
}

function hasProxyHeaders(headers: Headers): boolean {
  for (const [name] of headers) {
    if (
      name.startsWith("cf-")
      || name === "forwarded"
      || name === "via"
      || name.startsWith("x-forwarded-")
      || name === "x-real-ip"
    ) return true;
  }
  return false;
}

/**
 * Next's Fetch request does not expose the peer socket. The health contract is
 * therefore pinned to the exact loopback URL/Host and a healthcheck-only
 * marker, rejects proxy metadata, and is separately denied by Caddy.
 */
export function isLoopbackPrivateHealthRequest(
  request: Request,
  runtime: PrivateRuntimeKind,
): boolean {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  return request.method === "GET"
    && url.protocol === "http:"
    && url.hostname === "127.0.0.1"
    && url.port === "3000"
    && url.pathname === INTERNAL_HEALTH_PATHS[runtime]
    && url.search === ""
    && url.hash === ""
    && request.headers.get("host") === "127.0.0.1:3000"
    && request.headers.get("user-agent") === INTERNAL_HEALTH_MARKERS[runtime]
    && request.headers.get("x-handleplan-internal-health") === INTERNAL_HEALTH_MARKERS[runtime]
    && !hasProxyHeaders(request.headers);
}

type PrivateProbeProvider = () =>
  | PrivateRuntimeReadinessProbe
  | Promise<PrivateRuntimeReadinessProbe>;

export function createPrivateRuntimeReadyHandler(
  runtime: PrivateRuntimeKind,
  getProbe: PrivateProbeProvider,
) {
  return async function GET(request: Request): Promise<Response> {
    if (!isLoopbackPrivateHealthRequest(request, runtime)) {
      return privateHealthResponse({ code: "NOT_FOUND" }, 404);
    }
    try {
      const probe = await getProbe();
      const result = await probe.check(request.signal);
      if (
        result.runtime !== runtime
        || result.databaseRole !== PRIVATE_RUNTIME_DATABASE_ROLES[runtime]
        || result.requiredMigration !== REQUIRED_DATABASE_MIGRATION
      ) throw new PrivateRuntimeReadinessUnavailableError();
      return privateHealthResponse({
        database: {
          requiredMigration: result.requiredMigration,
          role: result.databaseRole,
          status: "ok",
        },
        runtime,
        status: "ok",
        version: 1,
      }, 200);
    } catch {
      return privateHealthResponse({
        code: "DEPENDENCY_UNAVAILABLE",
        status: "unavailable",
        version: 1,
      }, 503);
    }
  };
}

export function privateRuntimeHealthRequestHeaders(
  runtime: PrivateRuntimeKind,
): Readonly<Record<string, string>> {
  return Object.freeze({
    "user-agent": INTERNAL_HEALTH_MARKERS[runtime],
    "x-handleplan-internal-health": INTERNAL_HEALTH_MARKERS[runtime],
  });
}
