import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  awaitWithinRequest,
  createRequestLifetime,
  RequestOperationAbortedError,
} from "./request-lifetime";

describe("bounded server request lifetime", () => {
  it("cleans the deadline and every composed listener after success", async () => {
    vi.useFakeTimers();
    try {
      const client = new AbortController();
      const removeClientListener = vi.spyOn(client.signal, "removeEventListener");
      const lifetime = createRequestLifetime(client.signal, 25);
      const removeOperationListener = vi.spyOn(lifetime.signal, "removeEventListener");

      await expect(awaitWithinRequest(() => Promise.resolve("ok"), lifetime.signal))
        .resolves.toBe("ok");
      lifetime.cleanup();

      expect(removeOperationListener).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(removeClientListener).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects ignored work at the deadline while keeping its later rejection observed", async () => {
    vi.useFakeTimers();
    try {
      const client = new AbortController();
      const lifetime = createRequestLifetime(client.signal, 25);
      let rejectDependency: ((error: unknown) => void) | undefined;
      const dependency = new Promise<never>((_resolve, reject) => {
        rejectDependency = reject;
      });
      const pending = awaitWithinRequest(() => dependency, lifetime.signal);
      const abortExpectation = expect(pending).rejects.toBeInstanceOf(
        RequestOperationAbortedError,
      );

      await vi.advanceTimersByTimeAsync(25);
      await abortExpectation;
      expect(lifetime.deadlineExpired).toBe(true);
      expect(lifetime.signal.aborted).toBe(true);

      rejectDependency?.(new Error("late private dependency failure"));
      await Promise.resolve();
      lifetime.cleanup();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
