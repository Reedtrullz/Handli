import "server-only";

import type { HandleplanDatabase } from "@handleplan/db/client";

export const REQUIRED_DATABASE_MIGRATION = "028_private_review_image_evidence_only.sql" as const;

export interface DatabaseReadinessResult {
  requiredMigration: typeof REQUIRED_DATABASE_MIGRATION;
}

export interface DatabaseReadinessProbe {
  check(signal?: AbortSignal): Promise<DatabaseReadinessResult>;
}

export class ReadinessUnavailableError extends Error {
  constructor() {
    super("Required dependencies are unavailable");
    this.name = "ReadinessUnavailableError";
  }
}

export interface DatabaseReadinessProbeOptions {
  checkMigration: (requiredMigration: string, signal: AbortSignal) => Promise<boolean>;
  requiredMigration: typeof REQUIRED_DATABASE_MIGRATION;
  timeoutMs: number;
}

const MAX_READINESS_TIMEOUT_MS = 30_000;

export class BoundedDatabaseReadinessProbe implements DatabaseReadinessProbe {
  private readonly options: Readonly<DatabaseReadinessProbeOptions>;

  constructor(options: DatabaseReadinessProbeOptions) {
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
      throw new TypeError("The readiness probe must require the current database migration");
    }
    this.options = Object.freeze({ ...options });
  }

  async check(signal?: AbortSignal): Promise<DatabaseReadinessResult> {
    const deadline = new AbortController();
    const combinedSignal = signal
      ? AbortSignal.any([signal, deadline.signal])
      : deadline.signal;
    const timer = setTimeout(() => deadline.abort(), this.options.timeoutMs);

    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new ReadinessUnavailableError());
      combinedSignal.addEventListener("abort", onAbort, { once: true });
      if (combinedSignal.aborted) onAbort();
    });

    try {
      const available = await Promise.race([
        this.options.checkMigration(this.options.requiredMigration, combinedSignal),
        aborted,
      ]);
      if (!available || combinedSignal.aborted) throw new ReadinessUnavailableError();
      return { requiredMigration: this.options.requiredMigration };
    } catch {
      throw new ReadinessUnavailableError();
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
  if (signal.aborted) throw new ReadinessUnavailableError();
  const onAbort = () => query.cancel();
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    return await query;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export function createPostgresMigrationCheck(
  db: HandleplanDatabase,
): DatabaseReadinessProbeOptions["checkMigration"] {
  return async (requiredMigration, signal) => {
    const rows = await awaitCancelable(
      db.$client<[{ ready: boolean }]>`
        select exists (
          select 1
          from handleplan_schema_migrations
          where id = ${requiredMigration}
        ) as ready
      `,
      signal,
    );
    return rows[0]?.ready === true;
  };
}
