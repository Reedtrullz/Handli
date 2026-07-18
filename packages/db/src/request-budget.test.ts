import { describe, expect, it } from "vitest";

import type { HandleplanDatabase } from "./client";
import {
  PostgresProviderRequestBudget,
  ProviderRequestBudgetError,
  type ProviderRequestBudgetOptions,
} from "./request-budget";

const validOptions: ProviderRequestBudgetOptions = {
  limit: 60,
  maxWaitMs: 2_000,
  providerKey: "kassalapp",
  windowMs: 60_000,
};

type Claim = { acquired: boolean; retryAfterMs: number };

class ScriptedBudget extends PostgresProviderRequestBudget {
  readonly waits: number[] = [];
  claimCount = 0;

  constructor(
    private readonly claims: Claim[],
    options: ProviderRequestBudgetOptions = validOptions,
  ) {
    super({} as HandleplanDatabase, options);
  }

  protected override async claim(): Promise<Claim> {
    const claim = this.claims[this.claimCount];
    this.claimCount += 1;
    if (claim === undefined) throw new Error("Missing scripted claim");
    return claim;
  }

  protected override async waitFor(milliseconds: number): Promise<void> {
    this.waits.push(milliseconds);
  }
}

class AbortableBudget extends PostgresProviderRequestBudget {
  claimCount = 0;

  constructor() {
    super({} as HandleplanDatabase, {
      ...validOptions,
      maxWaitMs: 60_000,
    });
  }

  protected override async claim(): Promise<Claim> {
    this.claimCount += 1;
    return { acquired: false, retryAfterMs: 60_000 };
  }
}

describe("PostgresProviderRequestBudget", () => {
  it("rejects malformed provider keys without echoing them", () => {
    for (const providerKey of [
      "",
      "Kassalapp",
      "kassalapp/api",
      `k${"x".repeat(64)}`,
    ]) {
      expect(
        () =>
          new PostgresProviderRequestBudget({} as HandleplanDatabase, {
            ...validOptions,
            providerKey,
          }),
      ).toThrowError(
        "providerKey must be a lowercase provider identifier of 1-64 characters",
      );
    }
  });

  it("rejects limits and time bounds outside the supported range", () => {
    const invalidOptions: ProviderRequestBudgetOptions[] = [
      { ...validOptions, limit: 0 },
      { ...validOptions, limit: 1.5 },
      { ...validOptions, limit: 10_001 },
      { ...validOptions, windowMs: 0 },
      { ...validOptions, windowMs: 86_400_001 },
      { ...validOptions, maxWaitMs: 0 },
      { ...validOptions, maxWaitMs: 86_400_001 },
    ];

    for (const options of invalidOptions) {
      expect(
        () => new PostgresProviderRequestBudget({} as HandleplanDatabase, options),
      ).toThrow(TypeError);
    }
  });

  it("waits for the database-provided retry delay before claiming again", async () => {
    const budget = new ScriptedBudget([
      { acquired: false, retryAfterMs: 400 },
      { acquired: true, retryAfterMs: 0 },
    ]);

    await expect(budget.acquire()).resolves.toBeUndefined();
    expect(budget.claimCount).toBe(2);
    expect(budget.waits).toEqual([400]);
  });

  it("uses the remaining wait budget for one final claim and fails closed", async () => {
    const budget = new ScriptedBudget(
      [
        { acquired: false, retryAfterMs: 600 },
        { acquired: false, retryAfterMs: 100 },
      ],
      { ...validOptions, maxWaitMs: 500 },
    );

    await expect(budget.acquire()).rejects.toMatchObject({
      code: "MAX_WAIT_EXCEEDED",
      message: "Provider request budget wait limit exceeded",
      name: "ProviderRequestBudgetError",
    });
    expect(budget.claimCount).toBe(2);
    expect(budget.waits).toEqual([500]);
  });

  it("stops before querying when cancellation is already requested", async () => {
    const controller = new AbortController();
    const budget = new AbortableBudget();
    controller.abort();

    await expect(budget.acquire(controller.signal)).rejects.toEqual(
      new ProviderRequestBudgetError(
        "CANCELLED",
        "Provider request budget acquisition cancelled",
      ),
    );
    expect(budget.claimCount).toBe(0);
  });

  it("cancels an in-progress wait without another claim", async () => {
    const controller = new AbortController();
    const budget = new AbortableBudget();
    const acquisition = budget.acquire(controller.signal);

    queueMicrotask(() => controller.abort());

    await expect(acquisition).rejects.toMatchObject({
      code: "CANCELLED",
      message: "Provider request budget acquisition cancelled",
      name: "ProviderRequestBudgetError",
    });
    expect(budget.claimCount).toBe(1);
  });
});
