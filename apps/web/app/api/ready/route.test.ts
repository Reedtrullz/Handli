import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { DatabaseReadinessProbe } from "../../../lib/server/readiness";
import { createOperationalEventLogger } from "../../../lib/server/operational-events";
import { createReadyHandler } from "./route";

describe("GET /api/ready", () => {
  it("returns a no-store dependency-readiness contract", async () => {
    const probe: DatabaseReadinessProbe = {
      check: async () => ({ requiredMigration: "028_private_review_image_evidence_only.sql" }),
    };

    const response = await createReadyHandler(async () => probe)();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      database: {
        requiredMigration: "028_private_review_image_evidence_only.sql",
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

  it("cannot emit request, header, address, coordinate, IP, user-agent, basket, query, or error sentinels", async () => {
    const sentinels = {
      address: "SENTINEL-ADDRESS-RASMUS-MEYERS-ALLE-9",
      basket: "SENTINEL-BASKET-BANAN-MELK",
      coordinate: "SENTINEL-COORDINATE-60.3913-5.3221",
      ip: "SENTINEL-IP-203.0.113.247",
      query: "SENTINEL-QUERY-HEMMELIG-OST",
      userAgent: "SENTINEL-UA-HANDLEPLAN-PRIVATE",
    } as const;
    const lines: string[] = [];
    const events = createOperationalEventLogger((line) => {
      lines.push(line);
      return undefined;
    });
    const request = new Request(
      `https://handleplan.no/api/ready?q=${encodeURIComponent(sentinels.query)}&address=${encodeURIComponent(sentinels.address)}&coordinates=${encodeURIComponent(sentinels.coordinate)}&basket=${encodeURIComponent(sentinels.basket)}`,
      {
        headers: {
          "user-agent": sentinels.userAgent,
          "x-forwarded-for": sentinels.ip,
        },
      },
    );
    const response = await createReadyHandler(async () => {
      throw new Error(Object.values(sentinels).join(" "));
    }, events)(request);

    expect(response.status).toBe(503);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      component: "postgresql",
      contractVersion: 1,
      event: "dependency.readiness.checked",
      outcome: "unavailable",
    });
    for (const sentinel of Object.values(sentinels)) {
      expect(lines.join("\n")).not.toContain(sentinel);
    }
  });

  it("keeps the readiness response independent from telemetry export failure", async () => {
    const response = await createReadyHandler(async () => ({
      check: async () => ({ requiredMigration: "028_private_review_image_evidence_only.sql" }),
    }), {
      dependencyReadinessChecked: (): never => {
        throw new Error("export unavailable");
      },
    })();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok" });
  });
});
