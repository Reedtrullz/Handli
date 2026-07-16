import { describe, expect, it, vi } from "vitest";

import type { HandleplanDatabase } from "./client";
import { PostgresSourceAccessReader } from "./source-access";

function databaseWith(rows: unknown[]) {
  const query = Object.assign(Promise.resolve(rows), { cancel: vi.fn() });
  const client = vi.fn((..._args: unknown[]) => query);
  return {
    client,
    db: { $client: client } as unknown as HandleplanDatabase,
    query,
  };
}

describe("PostgresSourceAccessReader", () => {
  it("returns the current source state and latest permission without exposing private references", async () => {
    const { db, client } = databaseWith([{
      permission_current: true,
      permission_decision: "approved",
      permissions: { catalog: true, ordinaryPrice: true },
      runtime_state: "approved",
      source_permission_current: true,
    }]);
    const reader = new PostgresSourceAccessReader(db);

    await expect(reader.getSourceAccess("kassalapp")).resolves.toEqual({
      permissionCurrent: true,
      permissionDecision: "approved",
      permissions: { catalog: true, ordinaryPrice: true },
      runtimeState: "approved",
      sourcePermissionCurrent: true,
    });
    const rendered = (client.mock.calls[0]?.[0] as readonly string[]).join("?");
    expect(rendered).toContain("source.permission_reviewed_at <= clock_timestamp()");
    expect(rendered).toContain("reviewed_at <= clock_timestamp()");
  });

  it("returns undefined for a missing source and rejects unbounded identities", async () => {
    const missing = databaseWith([]);
    const reader = new PostgresSourceAccessReader(missing.db);
    await expect(reader.getSourceAccess("kassalapp")).resolves.toBeUndefined();
    await expect(reader.getSourceAccess("x".repeat(65))).rejects.toBeInstanceOf(TypeError);
    expect(missing.query.cancel).not.toHaveBeenCalled();
  });

  it("cancels a pending PostgreSQL query on shutdown", async () => {
    let reject!: (error: unknown) => void;
    const pending = Object.assign(new Promise((_resolve, rejectPromise) => {
      reject = rejectPromise;
    }), { cancel: vi.fn(() => reject(new Error("cancelled"))) });
    const db = { $client: vi.fn(() => pending) } as unknown as HandleplanDatabase;
    const reader = new PostgresSourceAccessReader(db);
    const controller = new AbortController();

    const access = reader.getSourceAccess("kassalapp", controller.signal);
    controller.abort();
    await expect(access).rejects.toMatchObject({ code: "CANCELLED" });
    expect(pending.cancel).toHaveBeenCalledOnce();
  });
});
