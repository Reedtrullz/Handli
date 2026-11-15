import assert from "node:assert/strict";
import test from "node:test";

import worker, { dispatchMonitor } from "../../scripts/operations/monitor-dispatch/src/index.mjs";

const DISPATCH_URL =
  "https://api.github.com/repos/Reedtrullz/Handli/actions/workflows/external-public-monitor.yml/dispatches";
const TOKEN = `github_pat_${"a".repeat(40)}`;

function response(status, body = "") {
  return new Response(status === 204 ? null : body, { status });
}

test("dispatches the monitor on main with a bounded authenticated request", async () => {
  const calls = [];
  await dispatchMonitor({ GITHUB_TOKEN: TOKEN }, async (url, init) => {
    calls.push({ url, init });
    return response(204);
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, DISPATCH_URL);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].init.headers.accept, "application/vnd.github+json");
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  assert.equal(calls[0].init.headers["user-agent"], "handli-monitor-dispatch");
  assert.equal(calls[0].init.headers["x-github-api-version"], "2022-11-28");
  assert.deepEqual(JSON.parse(calls[0].init.body), { ref: "main" });
});

test("fails closed without a token and on a rejected dispatch", async () => {
  await assert.rejects(dispatchMonitor({}), /GITHUB_TOKEN is not configured/u);

  await assert.rejects(
    dispatchMonitor({ GITHUB_TOKEN: TOKEN }, async () =>
      response(403, "Resource not accessible")),
    (error) => {
      assert.match(error.message, /403/u);
      assert.doesNotMatch(error.message, new RegExp(TOKEN, "u"));
      return true;
    },
  );
});

test("the scheduled handler awaits the dispatch", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return response(204);
  };
  try {
    await worker.scheduled({ cron: "2,17,32,47 * * * *" }, { GITHUB_TOKEN: TOKEN }, { waitUntil() {} });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
