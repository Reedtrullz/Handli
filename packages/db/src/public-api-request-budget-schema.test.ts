import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { publicApiRequestBudgetEvents } from "./evidence-schema";

describe("public API request budget schema", () => {
  it("contains only one allowlisted route class and a server timestamp", () => {
    const config = getTableConfig(publicApiRequestBudgetEvents);
    expect(config.name).toBe("public_api_request_budget_events");
    expect(config.columns.map(({ name }) => name)).toEqual(["route_key", "claimed_at"]);
    expect(config.indexes.map(({ config: index }) => index.name)).toContain(
      "public_api_request_budget_events_route_time_idx",
    );
    expect(config.checks.map(({ name }) => name)).toContain(
      "public_api_request_budget_events_route_key_allowed",
    );
  });
});
