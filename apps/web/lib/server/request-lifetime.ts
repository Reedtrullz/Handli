import "server-only";

export const DEFAULT_BOUNDED_REQUEST_TIMEOUT_MS = 10_000;
export const MAX_BOUNDED_REQUEST_TIMEOUT_MS = 60_000;

export interface BoundedRequestOptions {
  timeoutMs?: number;
}

export class RequestOperationAbortedError extends Error {
  constructor() {
    super("Bounded request operation aborted");
    this.name = "RequestOperationAbortedError";
  }
}

export interface RequestLifetime {
  cleanup(): void;
  readonly deadlineExpired: boolean;
  readonly signal: AbortSignal;
}

export function resolveRequestTimeoutMs(
  options: BoundedRequestOptions,
  defaultTimeoutMs = DEFAULT_BOUNDED_REQUEST_TIMEOUT_MS,
): number {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  if (
    !Number.isInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > MAX_BOUNDED_REQUEST_TIMEOUT_MS
  ) {
    throw new RangeError(
      `timeoutMs must be an integer from 1 through ${MAX_BOUNDED_REQUEST_TIMEOUT_MS}`,
    );
  }
  return timeoutMs;
}

export function createRequestLifetime(
  clientSignal: AbortSignal,
  timeoutMs: number,
): RequestLifetime {
  const controller = new AbortController();
  let deadlineExpired = false;
  let clientListenerAttached = false;
  const onClientAbort = () => {
    if (!controller.signal.aborted) controller.abort(clientSignal.reason);
  };

  if (clientSignal.aborted) {
    onClientAbort();
  } else {
    clientSignal.addEventListener("abort", onClientAbort, { once: true });
    clientListenerAttached = true;
  }

  const timer = setTimeout(() => {
    if (controller.signal.aborted) return;
    deadlineExpired = true;
    controller.abort(new RequestOperationAbortedError());
  }, timeoutMs);

  return {
    cleanup() {
      clearTimeout(timer);
      if (clientListenerAttached) {
        clientSignal.removeEventListener("abort", onClientAbort);
        clientListenerAttached = false;
      }
    },
    get deadlineExpired() {
      return deadlineExpired;
    },
    signal: controller.signal,
  };
}

/**
 * Bounds even dependencies that accidentally ignore the composed signal. The
 * dependency promise remains observed after abort so a later rejection cannot
 * become unhandled, while cooperative database readers receive the same signal
 * and cancel their underlying query.
 */
export function awaitWithinRequest<T>(
  operation: () => T | PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(new RequestOperationAbortedError());

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new RequestOperationAbortedError()));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    let pending: PromiseLike<T> | T;
    try {
      pending = operation();
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    Promise.resolve(pending).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}
