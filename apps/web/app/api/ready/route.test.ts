import { describe, expect, it } from "vitest";

import type { DatabaseReadinessProbe } from "../../../lib/server/readiness";
import { createReadyHandler } from "./route";

describe("GET /api/ready", () => {
  it("returns a no-store dependency-readiness contract", async () => {
    const probe: DatabaseReadinessProbe = {
      check: async () => ({ requiredMigration: "011_catalog_observations.sql" }),
    };

    const response = await createReadyHandler(async () => probe)();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      database: {
        requiredMigration: "011_catalog_observations.sql",
        status: "ok",
      },
      status: "ok",
      version: 1,
    });
  });

  it("collapses configuration and database details into a sanitized unavailable state", async () => {
    const response = await createReadyHandler(async () => {
      throw new Error("postgres://private-user:private-password@private-host/database");
    })();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      code: "DEPENDENCY_UNAVAILABLE",
      status: "unavailable",
      version: 1,
    });
  });
});
