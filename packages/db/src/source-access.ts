import type { HandleplanDatabase } from "./client";

export type SourceAccessState = "approved" | "blocked" | "conditional" | "revoked";

export interface SourceAccessSnapshot {
  permissionCurrent: boolean;
  permissionDecision?: SourceAccessState;
  permissions: Readonly<Record<string, unknown>>;
  runtimeState: SourceAccessState;
  sourcePermissionCurrent: boolean;
}

type CancelableQuery<T> = PromiseLike<T> & { cancel(): void };

export class SourceAccessReaderError extends Error {
  constructor(readonly code: "CANCELLED") {
    super("Source access query cancelled");
    this.name = "SourceAccessReaderError";
  }
}

function cancelledError(): SourceAccessReaderError {
  return new SourceAccessReaderError("CANCELLED");
}

function requireSourceId(value: unknown): asserts value is string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 64
    || value.trim().length < 1
  ) {
    throw new TypeError("sourceId must contain 1-64 nonblank characters");
  }
}

async function awaitAbortable<T>(query: CancelableQuery<T>, signal?: AbortSignal): Promise<T> {
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

function accessState(value: unknown, name: string): SourceAccessState {
  if (!["approved", "blocked", "conditional", "revoked"].includes(String(value))) {
    throw new TypeError(`PostgreSQL returned an invalid ${name}`);
  }
  return value as SourceAccessState;
}

function permissionsRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || value === undefined) return Object.freeze({});
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("PostgreSQL returned invalid source permissions");
  }
  return Object.freeze({ ...(value as Record<string, unknown>) });
}

interface SourceAccessRow {
  permission_current: boolean | null;
  permission_decision: string | null;
  permissions: unknown;
  runtime_state: string;
  source_permission_current: boolean;
}

export class PostgresSourceAccessReader {
  constructor(private readonly db: HandleplanDatabase) {}

  async getSourceAccess(
    sourceId: string,
    signal?: AbortSignal,
  ): Promise<SourceAccessSnapshot | undefined> {
    requireSourceId(sourceId);
    const rows = await awaitAbortable(this.db.$client<SourceAccessRow[]>`
      select
        source.runtime_state,
        (
          source.permission_reviewed_at is not null
          and source.permission_reviewed_at <= clock_timestamp()
          and (
            source.permission_expires_at is null
            or source.permission_expires_at > clock_timestamp()
          )
        ) as source_permission_current,
        permission.decision as permission_decision,
        permission.permissions,
        (
          permission.id is not null
          and (
            permission.valid_until is null
            or permission.valid_until > clock_timestamp()
          )
        ) as permission_current
      from data_sources source
      left join lateral (
        select id, decision, permissions, valid_until
        from source_permissions
        where source_id = source.id
          and reviewed_at <= clock_timestamp()
        order by reviewed_at desc, id desc
        limit 1
      ) permission on true
      where source.id = ${sourceId}
      limit 1
    `, signal);
    if (signal?.aborted) throw cancelledError();
    const row = rows[0];
    if (row === undefined) return undefined;
    if (
      typeof row.source_permission_current !== "boolean"
      || (row.permission_current !== null && typeof row.permission_current !== "boolean")
    ) {
      throw new TypeError("PostgreSQL returned invalid source permission freshness");
    }
    return Object.freeze({
      permissionCurrent: row.permission_current ?? false,
      ...(row.permission_decision === null
        ? {}
        : { permissionDecision: accessState(row.permission_decision, "permission decision") }),
      permissions: permissionsRecord(row.permissions),
      runtimeState: accessState(row.runtime_state, "source runtime state"),
      sourcePermissionCurrent: row.source_permission_current,
    });
  }
}
