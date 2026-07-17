import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PublicMonitorFailure,
  readMonitorConfig,
  runPublicMonitor,
  sanitizedFailure,
  validateSourceStatusContract,
} from "../../scripts/operations/check-public-monitor.mjs";

const NOW = "2026-07-17T12:00:00.000Z";
const REVISION = "a".repeat(40);
const MIGRATION = "026_official_offer_publication_runtime.sql";
const ACCESS_ID = "sentinel-access-id";
const ACCESS_SECRET = "placeholder";

function config(overrides = {}) {
  return {
    accessClientId: ACCESS_ID,
    accessClientSecret: ACCESS_SECRET,
    attempts: 3,
    baseUrl: new URL("https://monitor-target.invalid/"),
    expectedMigration: MIGRATION,
    expectedRevision: REVISION,
    retryDelayMs: 1,
    timeoutMs: 100,
    ...overrides,
  };
}

function liveness(overrides = {}) {
  return { commit: REVISION, status: "ok", version: 1, ...overrides };
}

function readiness(overrides = {}) {
  return {
    database: { requiredMigration: MIGRATION, status: "ok" },
    status: "ok",
    version: 1,
    ...overrides,
  };
}

function sourceEntry(overrides = {}) {
  return {
    governanceState: "approved",
    health: {
      freshness: "current",
      lastSuccess: {
        captureAt: "2026-07-17T11:57:00.000Z",
        discoveryAt: "2026-07-17T11:55:00.000Z",
        eligibleEvidenceAt: "2026-07-17T11:58:00.000Z",
        publishAt: "2026-07-17T11:59:00.000Z",
      },
      recordedAt: "2026-07-17T11:59:30.000Z",
      state: "healthy",
    },
    latestTerminalIngestion: {
      completedAt: "2026-07-17T11:59:00.000Z",
      scope: "source-wide",
      startedAt: "2026-07-17T11:50:00.000Z",
      state: "completed",
    },
    scope: null,
    source: {
      displayName: "Approved source",
      id: "approved-source",
      kind: "ordinary-price",
      runtimeState: "approved",
    },
    ...overrides,
  };
}

function sourceStatus(overrides = {}) {
  return {
    claimBoundary: {
      priceCoverage: "not-established",
      publicRanking: "not-established",
      runtimeActivation: "not-established",
      stockStatus: "not-established",
    },
    completeness: "partial",
    contractVersion: 1,
    entries: [sourceEntry()],
    generatedAt: NOW,
    hasMore: false,
    kind: "public-source-status",
    overall: "operational",
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
    status,
  });
}

function endpointFetch(values, calls = []) {
  return async (url, init) => {
    calls.push({ init, pathname: url.pathname });
    if (url.pathname === "/api/health") return jsonResponse(values.health ?? liveness());
    if (url.pathname === "/api/ready") return jsonResponse(values.ready ?? readiness());
    if (url.pathname === "/api/source-status") {
      return jsonResponse(values.source ?? sourceStatus());
    }
    throw new Error("unexpected endpoint");
  };
}

async function expectFailure(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof PublicMonitorFailure);
    assert.equal(error.code, code);
    return true;
  });
}

test("checks three strict public contracts with protected GET requests only", async () => {
  const calls = [];
  const result = await runPublicMonitor(config(), {
    fetchImpl: endpointFetch({}, calls),
    nowMs: () => Date.parse(NOW),
    sleep: async () => undefined,
  });

  assert.deepEqual(result, {
    contractVersion: 1,
    event: "public-monitor.completed",
    liveness: "ok",
    readiness: "ok",
    source: "operational",
  });
  assert.deepEqual(calls.map(({ pathname }) => pathname), [
    "/api/health",
    "/api/ready",
    "/api/source-status",
  ]);
  for (const { init } of calls) {
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "manual");
    assert.equal(init.headers["cf-access-client-id"], ACCESS_ID);
    assert.equal(init.headers["cf-access-client-secret"], ACCESS_SECRET);
  }
});

test("fails closed on revision and migration mismatches", async () => {
  await expectFailure(runPublicMonitor(config(), {
    fetchImpl: endpointFetch({ health: liveness({ commit: "b".repeat(40) }) }),
    nowMs: () => Date.parse(NOW),
  }), "REVISION_MISMATCH");

  await expectFailure(runPublicMonitor(config(), {
    fetchImpl: endpointFetch({
      ready: readiness({ database: { requiredMigration: "014_stores.sql", status: "ok" } }),
    }),
    nowMs: () => Date.parse(NOW),
  }), "MIGRATION_MISMATCH");
});

test("retries only bounded transient failures and emits no response body", async () => {
  let attempts = 0;
  let cancelled = 0;
  const sentinel = "SENTINEL-PRIVATE-RESPONSE-BASKET-ADDRESS";
  const fetchImpl = async () => {
    attempts += 1;
    return new Response(new ReadableStream({
      cancel: () => {
        cancelled += 1;
      },
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ privateDetails: sentinel })));
      },
    }), {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json",
      },
      status: 503,
    });
  };

  let caught;
  try {
    await runPublicMonitor(config(), {
      fetchImpl,
      sleep: async () => undefined,
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(attempts, 3);
  assert.equal(cancelled, 3);
  assert.deepEqual(sanitizedFailure(caught), {
    code: "HTTP_UNAVAILABLE",
    contractVersion: 1,
    event: "public-monitor.failed",
  });
  assert.doesNotMatch(JSON.stringify(sanitizedFailure(caught)), new RegExp(sentinel, "u"));
});

test("bounds request deadlines and response bytes", async () => {
  let attempts = 0;
  const neverResponds = async (_url, init) => {
    attempts += 1;
    return await new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("private timeout detail")), {
        once: true,
      });
    });
  };
  await expectFailure(runPublicMonitor(config({ timeoutMs: 5 }), {
    fetchImpl: neverResponds,
    sleep: async () => undefined,
  }), "REQUEST_TIMEOUT");
  assert.equal(attempts, 3);

  let slowBodyAttempts = 0;
  const slowBody = async (_url, init) => {
    slowBodyAttempts += 1;
    return new Response(new ReadableStream({
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode("{"));
        init.signal.addEventListener("abort", () => {
          controller.error(new Error("private slow-body detail"));
        }, { once: true });
      },
    }), {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json",
      },
    });
  };
  await expectFailure(runPublicMonitor(config({ timeoutMs: 5 }), {
    fetchImpl: slowBody,
    sleep: async () => undefined,
  }), "REQUEST_TIMEOUT");
  assert.equal(slowBodyAttempts, 3);

  let oversizedCancelled = 0;
  const oversized = async () => new Response(new ReadableStream({
    cancel: () => {
      oversizedCancelled += 1;
    },
    start: (controller) => {
      controller.enqueue(new TextEncoder().encode("{}"));
    },
  }), {
    headers: {
      "cache-control": "no-store",
      "content-length": String(64 * 1024 + 1),
      "content-type": "application/json",
    },
  });
  await expectFailure(runPublicMonitor(config(), { fetchImpl: oversized }), "RESPONSE_TOO_LARGE");
  assert.equal(oversizedCancelled, 1);
});

test("turns degraded and silent source states into alerts without a recovery request", async () => {
  const degraded = sourceStatus({
    entries: [sourceEntry({
      health: {
        ...sourceEntry().health,
        state: "degraded",
      },
    })],
    overall: "degraded",
  });
  const degradedCalls = [];
  await expectFailure(runPublicMonitor(config(), {
    fetchImpl: endpointFetch({ source: degraded }, degradedCalls),
    nowMs: () => Date.parse(NOW),
  }), "SOURCE_DEGRADED");
  assert.deepEqual(degradedCalls.map(({ init }) => init.method), ["GET", "GET", "GET"]);

  const unknown = sourceStatus({
    entries: [sourceEntry({ health: null, latestTerminalIngestion: null })],
    overall: "unknown",
  });
  await expectFailure(runPublicMonitor(config(), {
    fetchImpl: endpointFetch({ source: unknown }),
    nowMs: () => Date.parse(NOW),
  }), "SOURCE_UNKNOWN");

  await expectFailure(runPublicMonitor(config(), {
    fetchImpl: endpointFetch({
      source: sourceStatus({ entries: [], overall: "no-approved-sources" }),
    }),
    nowMs: () => Date.parse(NOW),
  }), "SOURCE_NOT_OPERATIONAL");
});

test("rejects extra source fields, derived-overall lies, and replayed status", () => {
  assert.throws(
    () => validateSourceStatusContract({ ...sourceStatus(), providerError: "private" }, Date.parse(NOW)),
    (error) => error.code === "SOURCE_CONTRACT_MISMATCH",
  );
  assert.throws(
    () => validateSourceStatusContract({ ...sourceStatus(), overall: "unknown" }, Date.parse(NOW)),
    (error) => error.code === "SOURCE_CONTRACT_MISMATCH",
  );
  assert.throws(
    () => validateSourceStatusContract(sourceStatus(), Date.parse("2026-07-17T12:06:00.001Z")),
    (error) => error.code === "SOURCE_RESPONSE_STALE",
  );
});

test("requires credential-free HTTPS configuration and both named Access values", () => {
  const environment = {
    HANDLEPLAN_MONITOR_BASE_URL: "https://handle.reidar.tech/",
    HANDLEPLAN_MONITOR_CF_ACCESS_CLIENT_ID: ACCESS_ID,
    HANDLEPLAN_MONITOR_CF_ACCESS_CLIENT_SECRET: ACCESS_SECRET,
    HANDLEPLAN_MONITOR_EXPECTED_MIGRATION: MIGRATION,
    HANDLEPLAN_MONITOR_EXPECTED_REVISION: REVISION,
  };
  const parsed = readMonitorConfig(environment);
  assert.equal(parsed.baseUrl.origin, "https://handle.reidar.tech");
  assert.equal(parsed.attempts, 3);
  assert.equal(parsed.timeoutMs, 5_000);

  for (const invalid of [
    { ...environment, HANDLEPLAN_MONITOR_BASE_URL: "https://attacker.invalid/" },
    { ...environment, HANDLEPLAN_MONITOR_BASE_URL: "http://handle.reidar.tech/" },
    { ...environment, HANDLEPLAN_MONITOR_BASE_URL: "https://user:secret@handle.reidar.tech/" },
    { ...environment, HANDLEPLAN_MONITOR_BASE_URL: "https://handle.reidar.tech/private" },
    { ...environment, HANDLEPLAN_MONITOR_CF_ACCESS_CLIENT_SECRET: "" },
    { ...environment, HANDLEPLAN_MONITOR_EXPECTED_REVISION: "main" },
  ]) {
    assert.throws(() => readMonitorConfig(invalid), (error) => error.code === "CONFIG_INVALID");
  }
});

test("sanitized failures never include exception, URL, header, request, source, or user detail", () => {
  const sentinels = [
    "https://user:secret@example.invalid/private",
    ACCESS_ID,
    ACCESS_SECRET,
    "SENTINEL-ADDRESS",
    "SENTINEL-BASKET",
    "SENTINEL-SOURCE-ERROR",
    "SENTINEL-REQUEST-METADATA",
  ];
  const output = JSON.stringify(sanitizedFailure(new Error(sentinels.join(" "))));
  assert.deepEqual(JSON.parse(output), {
    code: "MONITOR_FAILED",
    contractVersion: 1,
    event: "public-monitor.failed",
  });
  for (const sentinel of sentinels) assert.doesNotMatch(output, new RegExp(sentinel, "u"));
  assert.deepEqual(sanitizedFailure(new PublicMonitorFailure(sentinels.join(" "))), {
    code: "MONITOR_FAILED",
    contractVersion: 1,
    event: "public-monitor.failed",
  });
});

test("workflow stays pinned, read-only, bounded, secret-named, and free of recovery paths", async () => {
  const workflow = await readFile(".github/workflows/external-public-monitor.yml", "utf8");
  assert.match(workflow, /schedule:/u);
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /\n  push:\n  pull_request:\n/u);
  assert.doesNotMatch(workflow, /\n\s+paths:/u);
  assert.doesNotMatch(workflow, /cancel-in-progress:\s*true/u);
  assert.match(workflow, /timeout-minutes: 5/u);
  assert.match(workflow, /permissions:\n  contents: read/u);
  assert.match(workflow, /environment:\n      name: external-public-monitor/u);
  assert.match(workflow, /github\.ref_name == github\.event\.repository\.default_branch/u);
  assert.match(workflow, /HANDLEPLAN_MONITOR_BASE_URL: https:\/\/handle\.reidar\.tech\//u);
  assert.doesNotMatch(workflow, /vars\.HANDLEPLAN_MONITOR_BASE_URL/u);
  assert.equal(workflow.match(/persist-credentials: false/gu)?.length, 2);
  assert.match(workflow, /secrets\.HANDLEPLAN_MONITOR_CF_ACCESS_CLIENT_ID/u);
  assert.match(workflow, /secrets\.HANDLEPLAN_MONITOR_CF_ACCESS_CLIENT_SECRET/u);
  assert.doesNotMatch(workflow, /uses:\s+[^\s@]+@(?![0-9a-f]{40}(?:\s|$))/u);
  assert.doesNotMatch(workflow, /\b(?:ssh|scp|restart|deploy|docker|curl)\b/iu);
  assert.doesNotMatch(workflow, /(?:access-client-id|access-client-secret).*\$\{\{\s*vars\./iu);
});

test("checker source cannot print dynamic fetch, response, request, or exception detail", async () => {
  const checker = await readFile("scripts/operations/check-public-monitor.mjs", "utf8");
  assert.doesNotMatch(checker, /\bconsole\./u);
  assert.doesNotMatch(checker, /response\.(?:text|json|arrayBuffer)\s*\(/u);
  assert.doesNotMatch(checker, /error\.(?:cause|message|stack)/u);
  assert.doesNotMatch(checker, /JSON\.stringify\s*\(\s*error/u);
});

test("runbook preserves the inactive and no-alert-delivery evidence boundary", async () => {
  const runbook = await readFile("docs/runbooks/external-public-monitoring.md", "utf8");
  assert.match(runbook, /not active\s+or proven/iu);
  assert.match(runbook, /no repository evidence[\s\S]*failure notification reached a maintainer/iu);
  assert.match(runbook, /branch/u);
  assert.match(runbook, /deployment branches and tags to the protected default branch only/iu);
  assert.match(runbook, /Do not add a\s+required-reviewer approval gate/iu);
  assert.match(runbook, /monitored origin is pinned in reviewed code/iu);
  assert.match(runbook, /notification/iu);
  assert.match(runbook, /alert drill/iu);
  assert.match(runbook, /independently operated dead-man monitor outside both GitHub\s+Actions and the VPS/iu);
  assert.match(runbook, /initially 45 minutes/iu);
  assert.match(runbook, /no selected or configured independent heartbeat receiver/iu);
  assert.match(runbook, /Drill the dead-man separately/iu);
  assert.match(runbook, /ruleset requiring at least one non-author approval/iu);
  assert.match(runbook, /No repository evidence currently proves the required ruleset/iu);
  assert.match(runbook, /must remain live and no restart or deploy\s+action may occur/iu);
});
