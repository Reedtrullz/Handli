import type { HandleplanDatabase } from "./client";

export interface ProviderRequestBudgetOptions {
  providerKey: string;
  limit: number;
  windowMs: number;
  maxWaitMs: number;
}

export type ProviderRequestBudgetErrorCode = "CANCELLED" | "MAX_WAIT_EXCEEDED";

export class ProviderRequestBudgetError extends Error {
  readonly code: ProviderRequestBudgetErrorCode;

  constructor(code: ProviderRequestBudgetErrorCode, message: string) {
    super(message);
    this.name = "ProviderRequestBudgetError";
    this.code = code;
  }
}

interface RequestBudgetClaim {
  acquired: boolean;
  retryAfterMs: number;
}

const MAX_LIMIT = 10_000;
const MAX_DURATION_MS = 86_400_000;
const ADVISORY_LOCK_SEED = 7_229_164_302;

type CancelableQuery<T> = PromiseLike<T> & { cancel(): void };

function cancelledError(): ProviderRequestBudgetError {
  return new ProviderRequestBudgetError(
    "CANCELLED",
    "Provider request budget acquisition cancelled",
  );
}

function maxWaitError(): ProviderRequestBudgetError {
  return new ProviderRequestBudgetError(
    "MAX_WAIT_EXCEEDED",
    "Provider request budget wait limit exceeded",
  );
}

function requireIntegerInRange(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(
      `${name} must be an integer from ${minimum} through ${maximum}`,
    );
  }
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

export class PostgresProviderRequestBudget {
  protected readonly db: HandleplanDatabase;
  protected readonly options: Readonly<ProviderRequestBudgetOptions>;

  constructor(db: HandleplanDatabase, options: ProviderRequestBudgetOptions) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(options.providerKey)) {
      throw new TypeError(
        "providerKey must be a lowercase provider identifier of 1-64 characters",
      );
    }
    requireIntegerInRange(options.limit, "limit", 1, MAX_LIMIT);
    requireIntegerInRange(options.windowMs, "windowMs", 1, MAX_DURATION_MS);
    requireIntegerInRange(options.maxWaitMs, "maxWaitMs", 1, MAX_DURATION_MS);

    this.db = db;
    this.options = Object.freeze({ ...options });
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw cancelledError();

    const deadline = new AbortController();
    const acquisitionSignal = signal
      ? AbortSignal.any([signal, deadline.signal])
      : deadline.signal;
    const deadlineTimer = setTimeout(
      () => deadline.abort(),
      this.options.maxWaitMs,
    );

    try {
      await this.acquireWithinBudget(acquisitionSignal);
      if (signal?.aborted) throw cancelledError();
      if (deadline.signal.aborted) throw maxWaitError();
    } catch (error) {
      if (signal?.aborted) throw cancelledError();
      if (deadline.signal.aborted) throw maxWaitError();
      throw error;
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  private async acquireWithinBudget(signal: AbortSignal): Promise<void> {
    let waitedMs = 0;

    for (;;) {
      if (signal.aborted) throw cancelledError();

      let claim: RequestBudgetClaim;
      try {
        claim = await this.claim(signal);
      } catch (error) {
        if (signal.aborted) throw cancelledError();
        throw error;
      }

      if (claim.acquired) return;
      if (!Number.isInteger(claim.retryAfterMs) || claim.retryAfterMs < 1) {
        throw new Error("Provider request budget returned an invalid retry delay");
      }

      const remainingMs = this.options.maxWaitMs - waitedMs;
      if (remainingMs <= 0) throw maxWaitError();

      const delayMs = Math.min(claim.retryAfterMs, remainingMs);
      await this.waitFor(delayMs, signal);
      waitedMs += delayMs;
    }
  }

  protected async claim(signal?: AbortSignal): Promise<RequestBudgetClaim> {
    try {
      return await this.db.$client.begin(async (transaction) => {
        await awaitAbortable(
          transaction`
            select pg_advisory_xact_lock(
              hashtextextended(${this.options.providerKey}, ${ADVISORY_LOCK_SEED})
            )
          `,
          signal,
        );
        await awaitAbortable(
          transaction`
            delete from provider_request_budget_events
            where provider_key = ${this.options.providerKey}
              and claimed_at <= clock_timestamp()
                - (${this.options.windowMs}::double precision * interval '1 millisecond')
          `,
          signal,
        );

        const [state] = await awaitAbortable(
          transaction<
            [{ attempt_count: number; retry_after_ms: number | null }]
          >`
            select
              count(*)::integer as attempt_count,
              least(
                ${MAX_DURATION_MS},
                greatest(
                  1,
                  ceil(
                    extract(
                      epoch from (
                        min(claimed_at)
                          + (${this.options.windowMs}::double precision * interval '1 millisecond')
                          - clock_timestamp()
                      )
                    ) * 1000
                  )
                )
              )::integer as retry_after_ms
            from provider_request_budget_events
            where provider_key = ${this.options.providerKey}
          `,
          signal,
        );
        if (state === undefined) {
          throw new Error("Provider request budget did not return state");
        }

        if (state.attempt_count < this.options.limit) {
          await awaitAbortable(
            transaction`
              insert into provider_request_budget_events (provider_key)
              values (${this.options.providerKey})
            `,
            signal,
          );
          return { acquired: true, retryAfterMs: 0 };
        }
        if (state.retry_after_ms === null) {
          throw new Error("Provider request budget did not return a retry delay");
        }
        return { acquired: false, retryAfterMs: state.retry_after_ms };
      });
    } catch (error) {
      if (signal?.aborted) throw cancelledError();
      throw error;
    }
  }

  protected async waitFor(
    milliseconds: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) throw cancelledError();

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);
      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(cancelledError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }
}
