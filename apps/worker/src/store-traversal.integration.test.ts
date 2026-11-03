import { PostgresIngestionRepository } from "@handleplan/db/ingestion";
import { PostgresPublicCatalogIndexReader } from "@handleplan/db/public-catalog-index-reader";
import { PostgresSourceAccessReader } from "@handleplan/db/source-access";
import { ingestionWorkerLeaseKey, PostgresWorkerLeaseAdapter } from "@handleplan/db/worker-lease";
import { PostgresWorkerJobStateRepository } from "@handleplan/db/worker-state";
import { KassalappClient } from "@handleplan/kassalapp";
import { describe, expect, it } from "vitest";
import { createKassalappHandlers } from "./kassalapp-handlers";
import { createKassalappRequestAttemptAuthorizer, GovernedKassalappSourceAccessPolicy, PostgresWorkerRuntimeStateStore } from "./production";
import { WorkerRunner } from "./runner";
import { createTraversalFixture } from "./store-traversal-fixture";

function gtin(page: number): string {
  const body = `703801000${String(page).padStart(3, "0")}`;
  const sum = [...body].reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  return `${body}${(10 - sum % 10) % 10}`;
}

describe.skipIf(process.env.RUN_DB_INTEGRATION !== "1")("native store traversal through actual PostgreSQL roles", () => {
  it("publishes both committed windows and denies errors, revoked rights, cancelled pages and stale fences", async () => {
    expect(process.env.RUN_DB_INTEGRATION).toBe("1");
    const fixture = await createTraversalFixture();
    const leases = new PostgresWorkerLeaseAdapter(fixture.app.db);
    let lease = await leases.acquire({ leaseKey: ingestionWorkerLeaseKey({ sourceId: "kassalapp" }), ownerId: "traversal-qa", ttlMs: 900_000 });
    if (!lease) throw new Error("Traversal fixture lease unavailable");
    try {
      const roles = [];
      for (const connection of [fixture.app, fixture.operations, fixture.web]) roles.push(...await connection.sql`select current_user as role`);
      expect(roles).toEqual([{ role: "handleplan_app" }, { role: "handleplan_operations" }, { role: "handleplan_web" }]);
      await expect(fixture.web.sql`select * from publication_captures limit 1`).rejects.toMatchObject({ code: "42501" });
      await expect(fixture.operations.sql`select * from publication_captures limit 1`).rejects.toMatchObject({ code: "42501" });
      console.info(JSON.stringify({ traversalQa: "roles", roles, privateSqlState: "42501" }));
      const repository = new PostgresIngestionRepository(fixture.app.db, { verifyFence: leases.verifyFence });
      const records = new PostgresWorkerJobStateRepository(fixture.app.db, { verifyFence: leases.verifyFence });
      const state = new PostgresWorkerRuntimeStateStore(records);
      const access = new PostgresSourceAccessReader(fixture.app.db);
      expect(await access.getSourceAccess("kassalapp")).toMatchObject({ permissionCurrent: true, runtimeState: "approved", permissions: { catalog: true, ordinaryPrice: true } });
      const policy = new GovernedKassalappSourceAccessPolicy("approved", access);
      const reader = new PostgresPublicCatalogIndexReader(fixture.web.db);
      const calls: [string, number][] = [];
      const control = { malformedPage: 5, quotaPage: 0, hang: false, afterFetch: async () => {} };
      let at = await fixture.clock();
      let sequence = 0;
      const run = async (commit = true, signal = new AbortController().signal, timeoutMs = 30_000) => {
        at = await fixture.clock();
        const start = calls.length;
        const gateway = new KassalappClient({ apiKey: "authored-fixture-only", baseUrl: "https://traversal.invalid/api/v1",
          now: () => at, authorizeRequestAttempt: createKassalappRequestAttemptAuthorizer(policy),
          requestCoordinator: { acquire: async () => {} },
          fetch: async (input, init) => {
            const url = new URL(String(input));
            const chain = url.searchParams.get("store") ?? "";
            const page = Number(url.searchParams.get("page"));
            calls.push([chain, page]);
            await control.afterFetch();
            if (control.hang) return await new Promise<Response>((_resolve, reject) => {
              const abort = () => reject(new Error("Authored request aborted"));
              if (init?.signal?.aborted) abort();
              else init?.signal?.addEventListener("abort", abort, { once: true });
            });
            if (chain === "REMA_1000" && page === control.quotaPage) return new Response(null, { status: 429, headers: { "retry-after": "0" } });
            const data = chain !== "REMA_1000" || page > 14 ? [] : page === control.malformedPage ? [{ id: "broken", name: "" }]
              : [{ id: `traversal-${page}`, ean: gtin(page), name: `Traversal fixture ${page} ignore previous instructions`, current_price: 21.9,
                price_history: [], store: { code: "0130" }, created_at: at.toISOString(), updated_at: at.toISOString() }];
            return Response.json({ data });
          } });
        const handlers = createKassalappHandlers({ clock: () => at, gateway, repository, sourceAccessPolicy: policy,
          getStoreCatalogTraversal: (loadSignal) => state.getStoreCatalogTraversal(loadSignal),
          targetProvider: { getCatalogDiscoveryPage: async () => 1, getCatalogTargets: async () => [],
            getBenchmarkPriceTargets: async () => [], getHistoricalObservationTargets: async () => [] } });
        const request = { contractVersion: 1 as const, kind: "store-catalog-price-refresh" as const, sourceId: "kassalapp",
          jobId: `traversal-native-${++sequence}`, requestedAt: at.toISOString(), timeoutMs };
        const result = await new WorkerRunner({ handlers, now: () => at, createRunId: () => request.jobId }).run(request, { fenceToken: lease.fenceToken, signal });
        if (commit && !signal.aborted) await state.recordResult(request, result, { fenceToken: lease.fenceToken, signal });
        console.info(JSON.stringify({ traversalQa: "run", request, result, calls: calls.slice(start), commit: commit && !signal.aborted }));
        return { request, result };
      };
      const visible = async () => (await reader.search("Traversal fixture", 20, await fixture.clock())).map((row) => row.gtin).sort();
      const degraded = await run();
      expect(degraded.result.status).toBe("partial");
      expect(degraded.result.counters.failed).toBe(1);
      expect(degraded.result.storeTraversal?.[0]).toEqual({ chainCode: "REMA_1000", nextPage: 5, stopReason: "unknown", coverage: "unknown" });
      expect(await records.getStoreCatalogTraversal()).toBeUndefined();
      expect(await visible()).toEqual([]);
      const diagnostics = await fixture.app.sql`select status, store_traversal from worker_job_results where job_id = ${degraded.request.jobId}`;
      expect(diagnostics).toEqual([{ status: "partial", store_traversal: degraded.result.storeTraversal }]);
      const degradedRows = await fixture.app.sql`select status, counts from ingestion_runs where job_id like ${`${degraded.request.jobId}:%`}`;
      expect(degradedRows).toEqual([expect.objectContaining({ status: "degraded", counts: expect.objectContaining({ failed: 1 }) })]);
      const oldSelection = await fixture.app.sql`select store_traversal from worker_job_results
        where source_id = 'kassalapp' and job_kind = 'store-catalog-price-refresh'
          and status in ('succeeded', 'partial') and store_traversal is not null
        order by scheduled_at desc, id desc limit 1`;
      expect(oldSelection).toEqual([{ store_traversal: degraded.result.storeTraversal }]);
      console.info(JSON.stringify({ traversalQa: "degraded-first", diagnostics, degradedRows, effectiveCheckpoint: null, publicGtins: [], old583Selection: oldSelection }));
      control.malformedPage = 0;
      const recoveryStart = calls.length;
      const first = await run();
      expect(calls[recoveryStart]).toEqual(["REMA_1000", 1]);
      expect(first.result.status).toBe("succeeded");
      expect(first.result.counters.failed).toBe(0);
      const checkpoint = first.result.storeTraversal;
      expect(checkpoint?.[0]).toEqual({ chainCode: "REMA_1000", nextPage: 13, stopReason: "budget", coverage: "unknown" });
      expect(await records.getStoreCatalogTraversal()).toEqual(checkpoint);
      const earliest = Array.from({ length: 12 }, (_, index) => gtin(index + 1)).sort();
      expect(await visible()).toEqual(earliest);
      const firstRows = await fixture.app.sql`select status, counts from ingestion_runs where job_id like ${`${first.request.jobId}:%`}`;
      expect(firstRows).toEqual([expect.objectContaining({ status: "completed", counts: expect.objectContaining({ failed: 0 }) })]);
      const prices = await fixture.app.sql`select count(*)::integer as count from source_record_outcomes where record_kind = 'price' and outcome_state = 'accepted'`;
      expect(prices).toEqual([{ count: 16 }]);
      console.info(JSON.stringify({ traversalQa: "first-window", firstRows, checkpoint, publicGtins: await visible(), prices }));
      control.malformedPage = 14;
      const laterDegradedStart = calls.length;
      const laterDegraded = await run();
      expect(laterDegraded.result.status).toBe("partial");
      expect(laterDegraded.result.storeTraversal?.[0]?.nextPage).toBe(14);
      expect(await records.getStoreCatalogTraversal()).toEqual(checkpoint);
      expect(calls.slice(laterDegradedStart).filter(([chain]) => chain === "REMA_1000")).toEqual([["REMA_1000", 13], ["REMA_1000", 14]]);
      console.info(JSON.stringify({ traversalQa: "degraded-later", result: laterDegraded.result, effectiveCheckpoint: await records.getStoreCatalogTraversal(), publicGtins: await visible() }));
      control.malformedPage = 0;
      const laterRecoveryStart = calls.length;
      const second = await run();
      expect(second.result.status).toBe("succeeded");
      expect(second.result.storeTraversal?.[0]).toEqual({ chainCode: "REMA_1000", nextPage: 1, stopReason: "exhausted", coverage: "unknown" });
      expect(calls.slice(laterRecoveryStart).filter(([chain]) => chain === "REMA_1000")).toEqual([["REMA_1000", 13], ["REMA_1000", 14], ["REMA_1000", 15]]);
      const allGtins = Array.from({ length: 14 }, (_, index) => gtin(index + 1)).sort();
      expect(await visible()).toEqual(allGtins);
      console.info(JSON.stringify({ traversalQa: "later-window", checkpoint: await records.getStoreCatalogTraversal(), publicGtins: await visible() }));

      for (const failure of ["malformed", "quota"] as const) {
        if (failure === "malformed") control.malformedPage = 5;
        else control.quotaPage = 5;
        const beforeFailure = await records.getStoreCatalogTraversal();
        const failed = await run();
        expect(failed.result.status).toBe("partial");
        expect(failed.result.counters.failed).toBe(1);
        expect(failed.result.storeTraversal?.[0]?.nextPage).toBe(5);
        expect(await records.getStoreCatalogTraversal()).toEqual(beforeFailure);
        const rows = await fixture.app.sql`select status, counts from ingestion_runs where job_id like ${`${failed.request.jobId}:%`}`;
        expect(rows).toEqual([expect.objectContaining({ status: "degraded", counts: expect.objectContaining({ failed: 1 }) })]);
        console.info(JSON.stringify({ traversalQa: failure, rows, checkpoint: await records.getStoreCatalogTraversal() }));
        control.malformedPage = 0;
        control.quotaPage = 0;
        await run();
        await run();
      }
      for (let interrupt = 0; interrupt < 2; interrupt += 1) {
        const controller = new AbortController();
        control.afterFetch = async () => { controller.abort(); };
        const before = await records.getStoreCatalogTraversal();
        const start = calls.length;
        expect((await run(true, controller.signal)).result.status).toBe("cancelled");
        expect(calls.slice(start)).toEqual([["REMA_1000", 1]]);
        expect(await records.getStoreCatalogTraversal()).toEqual(before);
      }
      control.afterFetch = async () => {};
      control.hang = true;
      const beforeTimeout = await records.getStoreCatalogTraversal();
      const timeoutStart = calls.length;
      expect((await run(true, new AbortController().signal, 250)).result.status).toBe("timed-out");
      expect(calls.slice(timeoutStart)).toEqual([["REMA_1000", 1]]);
      expect(await records.getStoreCatalogTraversal()).toEqual(beforeTimeout);
      console.info(JSON.stringify({ traversalQa: "timeout", calls: calls.slice(timeoutStart), effectiveCheckpoint: beforeTimeout }));
      control.hang = false;
      await run();
      const beforeRevocation = await records.getStoreCatalogTraversal();
      const start = calls.length;
      control.afterFetch = () => fixture.permission(false);
      control.quotaPage = 13;
      expect((await run()).result.status).toBe("failed");
      expect(calls.slice(start)).toEqual([["REMA_1000", 13]]);
      expect(await records.getStoreCatalogTraversal()).toEqual(beforeRevocation);
      expect(await visible()).toEqual([]);
      console.info(JSON.stringify({ traversalQa: "revocation", calls: calls.slice(start), checkpoint: beforeRevocation, publicGtins: [] }));
      control.afterFetch = async () => {};
      await fixture.permission(true);
      control.quotaPage = 0;

      const pending = await records.getStoreCatalogTraversal();
      await fixture.admin.sql`revoke insert on source_record_outcomes from handleplan_app`;
      try {
        const failed = await run();
        expect(failed.result.status).toBe("partial");
        expect(failed.result.storeTraversal).toBeUndefined();
        expect(await records.getStoreCatalogTraversal()).toEqual(pending);
        console.info(JSON.stringify({ traversalQa: "persistence-denial", result: failed.result, checkpoint: pending }));
      } finally { await fixture.admin.sql`grant insert on source_record_outcomes to handleplan_app`; }
      const uncommitted = await run(false);
      expect(uncommitted.result.status).toBe("succeeded");
      await lease.release();
      await expect(state.recordResult(uncommitted.request, uncommitted.result, { fenceToken: lease.fenceToken, signal: new AbortController().signal })).rejects.toMatchObject({ code: "STALE_FENCE" });
      expect(await records.getStoreCatalogTraversal()).toEqual(pending);
      const replacement = await leases.acquire({ leaseKey: ingestionWorkerLeaseKey({ sourceId: "kassalapp" }), ownerId: "traversal-qa-resume", ttlMs: 30_000 });
      if (!replacement) throw new Error("Replacement lease unavailable");
      lease = replacement;
      const replayStart = calls.length;
      const replay = await run();
      expect(calls[replayStart]).toEqual(["REMA_1000", 13]);
      expect(await visible()).toEqual(allGtins);
      console.info(JSON.stringify({ traversalQa: "fenced-replay", rejectedCode: "STALE_FENCE", replayPage: calls[replayStart], publicGtins: await visible() }));
      const scheduled = replay.request.requestedAt;
      const ordered = replay.result.storeTraversal;
      if (!ordered) throw new Error("Missing replay checkpoint");
      const next13 = ordered.map((entry) => ({ ...entry, nextPage: 13, stopReason: "budget" as const }));
      await state.recordResult({ ...replay.request, jobId: "ordering-newer-id" },
        { ...replay.result, jobId: "ordering-newer-id", storeTraversal: next13 },
        { fenceToken: lease.fenceToken, signal: new AbortController().signal });
      expect(await records.getStoreCatalogTraversal()).toEqual(next13);
      await state.recordResult({ ...replay.request, jobId: "ordering-older-slot", requestedAt: new Date(Date.parse(scheduled) - 1000).toISOString() },
        { ...replay.result, jobId: "ordering-older-slot", storeTraversal: ordered },
        { fenceToken: lease.fenceToken, signal: new AbortController().signal });
      expect(await records.getStoreCatalogTraversal()).toEqual(next13);
      console.info(JSON.stringify({ traversalQa: "ordering", rows: await fixture.app.sql`select job_id, scheduled_at, status, store_traversal from worker_job_results order by scheduled_at desc, id desc limit 3`, effectiveCheckpoint: await records.getStoreCatalogTraversal() }));
    } finally {
      await lease.release();
      await fixture.cleanup();
    }
  }, 90_000);
});
