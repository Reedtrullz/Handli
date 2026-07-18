import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { request as requestHttps } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const launcher = path.join(repositoryRoot, "tests", "e2e", "start-https-server.mjs");
const hostname = "127.0.0.1";
const publicPort = 3109;
const upstreamPort = 3108;
const tlsDirectoryPrefix = "handleplan-public-e2e-tls-";
const maximumCapturedBytes = 16 * 1024;

function publicHarnessEnvironment(sentinel, privateTmpDirectory) {
  const environment = {};
  for (const name of [
    "APP_COMMIT_SHA",
    "CI",
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "TMPDIR",
    "TZ",
  ]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return {
    ...environment,
    HANDLEPLAN_E2E_FAKE_PRODUCTION_TOKEN: sentinel,
    HANDLEPLAN_E2E_PUBLIC_ORIGIN: `https://${hostname}:${publicPort}`,
    HANDLEPLAN_E2E_SENTINEL: sentinel,
    HANDLEPLAN_MODE: "fake",
    KASSAL_API_KEY: sentinel,
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_ENV: "production",
    TMPDIR: privateTmpDirectory,
  };
}

function captureBounded(stream) {
  const chunks = [];
  let capturedBytes = 0;
  stream.on("data", (chunk) => {
    if (capturedBytes >= maximumCapturedBytes) return;
    const remaining = maximumCapturedBytes - capturedBytes;
    const bounded = Buffer.from(chunk).subarray(0, remaining);
    chunks.push(bounded);
    capturedBytes += bounded.length;
  });
  return () => Buffer.concat(chunks).toString("utf8");
}

function probeAuthenticatedStatus(sentinel) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = requestHttps({
      headers: { "x-handleplan-e2e-control": sentinel },
      hostname,
      method: "GET",
      path: "/__handleplan-e2e/scan-status-v1",
      port: publicPort,
      rejectUnauthorized: false,
      timeout: 1_000,
    }, (response) => {
      const chunks = [];
      let byteLength = 0;
      response.on("data", (chunk) => {
        byteLength += chunk.length;
        if (byteLength > 64 * 1024) {
          response.destroy();
          finish(undefined);
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.once("aborted", () => finish(undefined));
      response.once("error", () => finish(undefined));
      response.once("close", () => {
        if (!response.complete) finish(undefined);
      });
      response.once("end", () => {
        if (response.statusCode !== 200) {
          finish(undefined);
          return;
        }
        try {
          finish(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          finish(undefined);
        }
      });
    });
    request.once("error", () => finish(undefined));
    request.once("timeout", () => {
      request.destroy();
      finish(undefined);
    });
    request.end();
  });
}

async function waitForAuthenticatedStatus(sentinel, exitState) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && exitState.value === undefined) {
    const status = await probeAuthenticatedStatus(sentinel);
    if (status !== undefined) return status;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`public harness did not become ready: ${JSON.stringify(exitState.value)}`);
}

function waitForExit(child, exitState) {
  return new Promise((resolve) => {
    child.once("error", (error) => {
      exitState.value = { error: error.message };
      resolve(exitState.value);
    });
    child.once("exit", (code, signal) => {
      exitState.value = { code, signal };
      resolve(exitState.value);
    });
  });
}

async function withDeadline(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function provePortReleased(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ exclusive: true, host: hostname, port }, () => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
  });
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

test("public harness exits non-zero and cleans up when its direct upstream exits", {
  timeout: 90_000,
}, async (context) => {
  const sentinel = `handleplan-e2e-${randomBytes(24).toString("hex")}`;
  const privateTmpDirectory = mkdtempSync(path.join(tmpdir(), "handleplan-public-lifecycle-"));
  const harness = spawn(process.execPath, [launcher], {
    cwd: repositoryRoot,
    env: publicHarnessEnvironment(sentinel, privateTmpDirectory),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = captureBounded(harness.stdout);
  const stderr = captureBounded(harness.stderr);
  const exitState = { value: undefined };
  const exited = waitForExit(harness, exitState);
  let upstreamProcessId;

  context.after(async () => {
    if (exitState.value === undefined) {
      harness.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
    if (exitState.value === undefined) {
      harness.kill("SIGKILL");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
    if (processIsAlive(upstreamProcessId)) {
      process.kill(upstreamProcessId, "SIGKILL");
    }
    rmSync(privateTmpDirectory, { force: true, recursive: true });
  });

  try {
    const status = await waitForAuthenticatedStatus(sentinel, exitState);
    assert.equal(status?.contractVersion, 1);
    assert.equal(status?.teardownBarrier, true);
    assert.deepEqual(status?.unexpectedScanFailures, []);
    assert.ok(Number.isSafeInteger(status?.upstreamProcessId));
    assert.ok(status.upstreamProcessId > 0);
    upstreamProcessId = status.upstreamProcessId;
    const revalidatedStatus = await probeAuthenticatedStatus(sentinel);
    assert.equal(revalidatedStatus?.upstreamProcessId, upstreamProcessId);
    assert.equal(processIsAlive(upstreamProcessId), true);
    process.kill(upstreamProcessId, "SIGKILL");

    const result = await withDeadline(
      exited,
      10_000,
      "public harness stayed alive after its direct upstream was killed",
    );
    assert.deepEqual(result, { code: 1, signal: null });
    upstreamProcessId = undefined;
    await provePortReleased(upstreamPort);
    await provePortReleased(publicPort);
    assert.deepEqual(
      readdirSync(privateTmpDirectory).filter((entry) => entry.startsWith(tlsDirectoryPrefix)),
      [],
    );
  } catch (error) {
    const detail = [
      `stdout=${stdout().replaceAll(sentinel, "[sentinel]")}`,
      `stderr=${stderr().replaceAll(sentinel, "[sentinel]")}`,
    ].join("\n");
    assert.fail(`${error instanceof Error ? error.message : String(error)}\n${detail}`);
  }
});
