import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  InFlightCoalescingError,
  InFlightOperationCoalescer,
} from "./in-flight-operation-coalescer";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("InFlightOperationCoalescer", () => {
  it("coalesces canonically identical inputs while retaining only one active key", async () => {
    const coalescer = new InFlightOperationCoalescer();
    const work = deferred<string>();
    const operation = vi.fn(() => work.promise);
    const first = coalescer.run(
      "plans",
      { basket: [{ quantity: 1, gtin: "7038010000010" }], maxStores: 3 },
      undefined,
      operation,
    );
    const second = coalescer.run(
      "plans",
      { maxStores: 3, basket: [{ gtin: "7038010000010", quantity: 1 }] },
      undefined,
      operation,
    );

    expect(coalescer.activeKeyCount).toBe(1);
    await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
    work.resolve("shared");
    await expect(Promise.all([first, second])).resolves.toEqual(["shared", "shared"]);
    expect(coalescer.activeKeyCount).toBe(0);
  });

  it("isolates subscriber cancellation and aborts shared work only after the last", async () => {
    const coalescer = new InFlightOperationCoalescer();
    const work = deferred<string>();
    let sharedSignal!: AbortSignal;
    const operation = vi.fn((signal: AbortSignal) => {
      sharedSignal = signal;
      return work.promise;
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = coalescer.run("plans", { id: 1 }, firstController.signal, operation);
    const second = coalescer.run("plans", { id: 1 }, secondController.signal, operation);
    await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());

    firstController.abort();
    await expect(first).rejects.toEqual(new InFlightCoalescingError("CANCELLED"));
    expect(sharedSignal.aborted).toBe(false);
    work.resolve("ok");
    await expect(second).resolves.toBe("ok");

    const lastWork = deferred<string>();
    let lastSignal!: AbortSignal;
    const lastController = new AbortController();
    const last = coalescer.run(
      "travel",
      { id: 2 },
      lastController.signal,
      (signal) => {
        lastSignal = signal;
        return lastWork.promise;
      },
    );
    await vi.waitFor(() => expect(lastSignal).toBeInstanceOf(AbortSignal));
    lastController.abort();
    await expect(last).rejects.toEqual(new InFlightCoalescingError("CANCELLED"));
    expect(lastSignal.aborted).toBe(true);
    lastWork.reject(new DOMException("aborted", "AbortError"));
    await vi.waitFor(() => expect(coalescer.activeKeyCount).toBe(0));
  });

  it("bounds active keys and subscribers without starting extra work", async () => {
    const coalescer = new InFlightOperationCoalescer({
      maxKeys: 1,
      maxSubscribersPerKey: 2,
    });
    const work = deferred<string>();
    const operation = vi.fn(() => work.promise);
    const first = coalescer.run("plans", { id: 1 }, undefined, operation);
    const second = coalescer.run("plans", { id: 1 }, undefined, operation);
    await expect(coalescer.run("plans", { id: 1 }, undefined, operation))
      .rejects.toEqual(new InFlightCoalescingError("CAPACITY"));
    await expect(coalescer.run("plans", { id: 2 }, undefined, operation))
      .rejects.toEqual(new InFlightCoalescingError("CAPACITY"));
    await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
    work.resolve("ok");
    await expect(Promise.all([first, second])).resolves.toEqual(["ok", "ok"]);
  });

  it("enforces a non-renewable shared deadline across staggered subscribers", async () => {
    vi.useFakeTimers();
    try {
      const coalescer = new InFlightOperationCoalescer({ maxOperationMs: 50 });
      const work = deferred<string>();
      let sharedSignal!: AbortSignal;
      const operation = vi.fn((signal: AbortSignal) => {
        sharedSignal = signal;
        return work.promise;
      });
      const first = coalescer.run("plans", { id: 1 }, undefined, operation)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(40);
      const second = coalescer.run("plans", { id: 1 }, undefined, operation)
        .catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(9);
      expect(sharedSignal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(first).resolves.toEqual(new InFlightCoalescingError("DEADLINE"));
      await expect(second).resolves.toEqual(new InFlightCoalescingError("DEADLINE"));
      expect(sharedSignal.aborted).toBe(true);
      expect(operation).toHaveBeenCalledOnce();
      expect(coalescer.activeKeyCount).toBe(1);
      await expect(coalescer.run("plans", { id: 1 }, undefined, operation))
        .rejects.toEqual(new InFlightCoalescingError("CAPACITY"));

      work.reject(new DOMException("aborted", "AbortError"));
      await vi.advanceTimersByTimeAsync(0);
      expect(coalescer.activeKeyCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects oversized or non-JSON key material without leaking sentinels", async () => {
    const coalescer = new InFlightOperationCoalescer();
    const sentinel = "Secretveien 42, 59.9127,10.7461 token-private";
    const cyclic: { self?: unknown; sentinel: string } = { sentinel };
    cyclic.self = cyclic;
    const errors = await Promise.all([
      coalescer.run("plans", cyclic, undefined, async () => "unused")
        .catch((error: unknown) => error),
      coalescer.run("plans", { sentinel: sentinel.repeat(20_000) }, undefined, async () => "unused")
        .catch((error: unknown) => error),
    ]);
    for (const error of errors) {
      expect(error).toEqual(new InFlightCoalescingError("INVALID_KEY"));
      expect(String(error)).not.toContain(sentinel);
    }
    expect(coalescer.activeKeyCount).toBe(0);
  });
});
