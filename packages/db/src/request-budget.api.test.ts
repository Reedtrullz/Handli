import { describe, expect, it } from "vitest";

describe("PostgresProviderRequestBudget API", () => {
  it("exports the shared PostgreSQL request-budget coordinator", async () => {
    const requestBudget = await import("./request-budget").catch(() => ({}));

    expect(requestBudget).toHaveProperty("PostgresProviderRequestBudget");
    expect(requestBudget).toHaveProperty("ProviderRequestBudgetError");
  });
});
