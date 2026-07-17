import "server-only";

import { createHash } from "node:crypto";

const MAX_KEY_MATERIAL_BYTES = 256 * 1024;
const MAX_CANONICAL_NODES = 20_000;
const DEFAULT_MAX_OPERATION_MS = 10_000;
const MAX_OPERATION_MS = 60_000;

export type InFlightCoalescingErrorCode =
  | "CANCELLED"
  | "CAPACITY"
  | "DEADLINE"
  | "INVALID_KEY";

export class InFlightCoalescingError extends Error {
  constructor(readonly code: InFlightCoalescingErrorCode) {
    super(`In-flight operation coalescing failed: ${code}`);
    this.name = "InFlightCoalescingError";
  }
}

export interface InFlightOperationCoalescerOptions {
  maxKeys?: number;
  maxOperationMs?: number;
  maxSubscribersPerKey?: number;
}

export interface InFlightOperationRunOptions {
  maxOperationMs?: number;
}

interface SharedEntry {
  readonly controller: AbortController;
  promise: Promise<unknown>;
  settled: boolean;
  subscribers: number;
}

function boundedInteger(
  value: number,
  name: string,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer from 1 through ${maximum}`);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  let nodes = 0;

  const visit = (input: unknown): string => {
    nodes += 1;
    if (nodes > MAX_CANONICAL_NODES) {
      throw new InFlightCoalescingError("INVALID_KEY");
    }
    if (input === null) return "null";
    switch (typeof input) {
      case "boolean": return input ? "true" : "false";
      case "number": {
        if (!Number.isFinite(input)) throw new InFlightCoalescingError("INVALID_KEY");
        return JSON.stringify(input);
      }
      case "string": return JSON.stringify(input);
      case "object": break;
      default: throw new InFlightCoalescingError("INVALID_KEY");
    }

    const object = input as object;
    if (seen.has(object)) throw new InFlightCoalescingError("INVALID_KEY");
    seen.add(object);
    try {
      if (Array.isArray(input)) {
        return `[${input.map((item) => visit(item)).join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new InFlightCoalescingError("INVALID_KEY");
      }
      const record = input as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) => (
        `${JSON.stringify(key)}:${visit(record[key])}`
      )).join(",")}}`;
    } finally {
      seen.delete(object);
    }
  };

  const serialized = visit(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_KEY_MATERIAL_BYTES) {
    throw new InFlightCoalescingError("INVALID_KEY");
  }
  return serialized;
}

function digestOperationKey(namespace: string, keyMaterial: unknown): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(namespace)) {
    throw new InFlightCoalescingError("INVALID_KEY");
  }
  const hash = createHash("sha256");
  hash.update(namespace, "utf8");
  hash.update("\0", "utf8");
  hash.update(canonicalJson(keyMaterial), "utf8");
  return hash.digest("hex");
}

/**
 * Bounded, process-memory-only request collapsing. The map retains only
 * SHA-256 digests. Request/query/basket/address/coordinate/token material is
 * neither exposed by diagnostics nor written to logs or durable storage.
 */
export class InFlightOperationCoalescer {
  private readonly entries = new Map<string, SharedEntry>();
  private readonly maxKeys: number;
  private readonly maxOperationMs: number;
  private readonly maxSubscribersPerKey: number;

  constructor(options: InFlightOperationCoalescerOptions = {}) {
    this.maxKeys = boundedInteger(options.maxKeys ?? 128, "maxKeys", 1_024);
    this.maxOperationMs = boundedInteger(
      options.maxOperationMs ?? DEFAULT_MAX_OPERATION_MS,
      "maxOperationMs",
      MAX_OPERATION_MS,
    );
    this.maxSubscribersPerKey = boundedInteger(
      options.maxSubscribersPerKey ?? 64,
      "maxSubscribersPerKey",
      1_024,
    );
  }

  get activeKeyCount(): number {
    return this.entries.size;
  }

  async run<T>(
    namespace: string,
    keyMaterial: unknown,
    subscriberSignal: AbortSignal | undefined,
    operation: (sharedSignal: AbortSignal) => T | PromiseLike<T>,
    options: InFlightOperationRunOptions = {},
  ): Promise<T> {
    if (subscriberSignal?.aborted) {
      throw new InFlightCoalescingError("CANCELLED");
    }
    const maxOperationMs = options.maxOperationMs === undefined
      ? this.maxOperationMs
      : boundedInteger(options.maxOperationMs, "maxOperationMs", MAX_OPERATION_MS);
    const digest = digestOperationKey(namespace, keyMaterial);
    let entry = this.entries.get(digest);

    if (entry?.controller.signal.aborted) {
      // The last prior subscriber cancelled. Keep its bounded operation in the
      // map until it settles rather than starting an untracked duplicate.
      throw new InFlightCoalescingError("CAPACITY");
    }
    if (entry === undefined) {
      if (this.entries.size >= this.maxKeys) {
        throw new InFlightCoalescingError("CAPACITY");
      }
      entry = {
        controller: new AbortController(),
        promise: Promise.resolve(),
        settled: false,
        subscribers: 0,
      };
      this.entries.set(digest, entry);
      const createdEntry = entry;
      const operationPromise = Promise.resolve()
        .then(() => operation(createdEntry.controller.signal));
      createdEntry.promise = new Promise((resolve, reject) => {
        let resultDelivered = false;
        const deadlineError = new InFlightCoalescingError("DEADLINE");
        const deadline = setTimeout(() => {
          if (resultDelivered) return;
          resultDelivered = true;
          if (!createdEntry.controller.signal.aborted) {
            createdEntry.controller.abort(deadlineError);
          }
          reject(deadlineError);
        }, maxOperationMs);

        operationPromise.then(
          (value) => {
            clearTimeout(deadline);
            createdEntry.settled = true;
            if (this.entries.get(digest) === createdEntry) this.entries.delete(digest);
            if (resultDelivered) return;
            resultDelivered = true;
            resolve(value);
          },
          (error: unknown) => {
            clearTimeout(deadline);
            createdEntry.settled = true;
            if (this.entries.get(digest) === createdEntry) this.entries.delete(digest);
            if (resultDelivered) return;
            resultDelivered = true;
            reject(error);
          },
        );
      });
      // The promise remains observed if its only subscriber cancels before the
      // cooperative operation notices the shared abort signal. The underlying
      // operation also always has both settlement handlers attached, including
      // after the non-renewable shared deadline rejects subscribers.
      void createdEntry.promise.catch(() => undefined);
    }

    if (entry.subscribers >= this.maxSubscribersPerKey) {
      throw new InFlightCoalescingError("CAPACITY");
    }
    entry.subscribers += 1;

    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const finish = (callback: () => void) => {
        if (finished) return;
        finished = true;
        subscriberSignal?.removeEventListener("abort", onAbort);
        entry!.subscribers -= 1;
        if (
          entry!.subscribers === 0
          && !entry!.settled
          && !entry!.controller.signal.aborted
        ) {
          entry!.controller.abort(new InFlightCoalescingError("CANCELLED"));
        }
        callback();
      };
      const onAbort = () => finish(() => reject(
        new InFlightCoalescingError("CANCELLED"),
      ));
      subscriberSignal?.addEventListener("abort", onAbort, { once: true });
      if (subscriberSignal?.aborted) {
        onAbort();
        return;
      }
      entry!.promise.then(
        (value) => finish(() => resolve(value as T)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  }
}

let sharedCoalescer: InFlightOperationCoalescer | undefined;

export function getPublicApiOperationCoalescer(): InFlightOperationCoalescer {
  sharedCoalescer ??= new InFlightOperationCoalescer();
  return sharedCoalescer;
}
