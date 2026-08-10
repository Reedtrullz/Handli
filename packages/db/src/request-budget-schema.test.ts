import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import * as schema from "./schema";

describe("provider request budget schema", () => {
  it("declares the ephemeral provider/time index and provider-key check", () => {
    expect(schema).toHaveProperty("providerRequestBudgetEvents");

    const table = schema.providerRequestBudgetEvents;
    const config = getTableConfig(table);
    expect(config.name).toBe("provider_request_budget_events");
    expect(
      config.columns.find(({ name }) => name === "claimed_at")?.getSQLType(),
    ).toBe("timestamp with time zone");
    expect(config.indexes.map(({ config: index }) => index.name)).toContain(
      "provider_request_budget_events_provider_time_idx",
    );
    expect(config.checks.map(({ name }) => name)).toContain(
      "provider_request_budget_events_provider_key_shape",
    );
  });
});
