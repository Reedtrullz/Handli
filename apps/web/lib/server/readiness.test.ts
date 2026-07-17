import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  BoundedDatabaseReadinessProbe,
  ReadinessUnavailableError,
} from "./readiness";

describe("database readiness", () => {
  it("reports the exact required migration only after the database confirms it", async () => {
    const checkMigration = vi.fn(async () => true);
    const probe = new BoundedDatabaseReadinessProbe({
      checkMigration,
      requiredMigration: "026_official_offer_publication_runtime.sql",
      timeoutMs: 100,
    });

    await expect(probe.check()).resolves.toEqual({
      requiredMigration: "026_official_offer_publication_runtime.sql",
    });
    expect(checkMigration).toHaveBeenCalledWith(
      "026_official_offer_publication_runtime.sql",
      expect.any(AbortSignal),
    );
  });

  it("fails closed when the required migration is absent", async () => {
    const probe = new BoundedDatabaseReadinessProbe({
      checkMigration: async () => false,
      requiredMigration: "026_official_offer_publication_runtime.sql",
      timeoutMs: 100,
    });

    await expect(probe.check()).rejects.toBeInstanceOf(ReadinessUnavailableError);
  });

  it("bounds an uncooperative dependency check and aborts its signal", async () => {
    vi.useFakeTimers();
    let dependencySignal: AbortSignal | undefined;
    const probe = new BoundedDatabaseReadinessProbe({
      checkMigration: async (_migration, signal) => {
        dependencySignal = signal;
        return await new Promise<boolean>(() => undefined);
      },
      requiredMigration: "026_official_offer_publication_runtime.sql",
      timeoutMs: 25,
    });

    const result = probe.check();
    const rejection = expect(result).rejects.toBeInstanceOf(ReadinessUnavailableError);
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(dependencySignal?.aborted).toBe(true);
    vi.useRealTimers();
  });
});
