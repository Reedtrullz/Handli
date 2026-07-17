import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  PublicApiRequestBudgetError,
  type PublicApiRequestBudgetContract,
} from "@handleplan/db/public-api-request-budget";

import { InFlightOperationCoalescer } from "./in-flight-operation-coalescer";
import {
  PublicApiRuntimeControlError,
  PublicApiRuntimeControls,
} from "./public-api-runtime-controls";

function budget(
  claim: PublicApiRequestBudgetContract["claim"],
): PublicApiRequestBudgetContract {
  return { claim };
}

describe("PublicApiRuntimeControls", () => {
  it("returns a bounded rate-limit decision before starting work", async () => {
    const operation = vi.fn(async () => "unused");
    const controls = new PublicApiRuntimeControls(
      budget(async () => ({ admitted: false, retryAfterSeconds: 23 })),
      new InFlightOperationCoalescer(),
    );
    await expect(controls.run("plans", {}, undefined, operation)).rejects.toEqual(
      new PublicApiRuntimeControlError("RATE_LIMITED", 23),
    );
    expect(operation).not.toHaveBeenCalled();
  });

  it("fails closed and sanitizes database outage details", async () => {
    const controls = new PublicApiRuntimeControls(
      budget(async () => {
        throw new Error("postgres password and private basket sentinel");
      }),
      new InFlightOperationCoalescer(),
    );
    const error = await controls.admit("discovery-search").catch((reason) => reason);
    expect(error).toEqual(new PublicApiRuntimeControlError("BUDGET_UNAVAILABLE"));
    expect(String(error)).not.toMatch(/password|basket|sentinel/iu);
  });

  it("preserves cancellation without converting it to an outage", async () => {
    const controls = new PublicApiRuntimeControls(
      budget(async () => { throw new PublicApiRequestBudgetError("CANCELLED"); }),
      new InFlightOperationCoalescer(),
    );
    await expect(controls.admit("plans"))
      .rejects.toEqual(new PublicApiRuntimeControlError("CANCELLED"));
  });
});
