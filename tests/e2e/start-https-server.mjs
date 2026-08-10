import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as requestHttp } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertExpectedPublicBuildRevision,
  assertPublicBuildBinding,
} from "../../scripts/e2e/public-build-binding.mjs";

const repositoryRoot = process.cwd();
const webRoot = path.join(repositoryRoot, "apps", "web");
const standaloneRoot = path.join(webRoot, ".next", "standalone", "apps", "web");
const standaloneServer = path.join(standaloneRoot, "server.js");
const publicTarget = path.join(standaloneRoot, "public");
const staticTarget = path.join(standaloneRoot, ".next", "static");
const capabilityPreloader = path.join(repositoryRoot, "tests", "e2e", "install-public-fake-capability.mjs");
const hostname = "127.0.0.1";
const publicPort = 3109;
const upstreamPort = 3108;
const apiScanHeader = "x-handleplan-e2e-api-scan";
const apiScanPassed = "passed-v1";
const apiScanRejected = "rejected-v1";
const responseScanHeader = "x-handleplan-e2e-response-scan";
const responseScanPassed = "passed-v1";
const responseScanRejected = "rejected-v1";
const controlHeader = "x-handleplan-e2e-control";
const controlPath = "/__handleplan-e2e/scan-status-v1";
const leakProbeHeader = "x-handleplan-e2e-leak-probe";
const bodyLeakProbePath = "/api/_handleplan-e2e/leak-probe";
const headerLeakProbePath = "/api/_handleplan-e2e/leak-header-probe";
const methodProbeHeader = "x-handleplan-e2e-method-probe";
const methodProbePath = "/api/_handleplan-e2e/method-probe";
const allowedMethods = new Set(["GET", "HEAD", "POST"]);
const maxRequestBytes = 2 * 1024 * 1024;
const maxResponseBytes = 16 * 1024 * 1024;
const sentinel = process.env.HANDLEPLAN_E2E_SENTINEL;
const forbiddenValues = ["KASSAL_API_KEY", sentinel].filter(
  (value) => typeof value === "string" && value.length > 0,
);
const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const harnessState = {
  apiResponsesScanned: 0,
  expectedBodyLeakProbeRejections: 0,
  expectedHeaderLeakProbeRejections: 0,
  expectedLeakProbeRejections: 0,
  expectedMethodProbeRejections: 0,
  inFlightRequests: 0,
  requestBodiesScanned: 0,
  responseBodiesScanned: 0,
  teardownBarrier: false,
  unexpectedScanFailures: [],
};
let lastApplicationTrafficAt = Date.now();

if (typeof sentinel !== "string" || !/^handleplan-e2e-[0-9a-f]{48}$/u.test(sentinel)) {
  throw new Error("public browser evidence sentinel is missing or too short");
}
if (
  process.env.HANDLEPLAN_MODE !== "fake"
  || process.env.HANDLEPLAN_E2E_FAKE_PRODUCTION_TOKEN !== sentinel
  || process.env.KASSAL_API_KEY !== sentinel
  || process.env.HANDLEPLAN_E2E_PUBLIC_ORIGIN !== `https://${hostname}:${publicPort}`
) {
  throw new Error("public browser production-fake proof is incomplete");
}
const binding = assertPublicBuildBinding(repositoryRoot);
const expectedRevision = assertExpectedPublicBuildRevision(binding);
for (const requiredPath of [standaloneServer, publicTarget, staticTarget, capabilityPreloader]) {
  if (!existsSync(requiredPath)) {
    throw new Error(`public browser tests require a source-bound standalone build: missing ${requiredPath}`);
  }
}

const tlsDirectory = mkdtempSync(path.join(tmpdir(), "handleplan-public-e2e-tls-"));
const keyPath = path.join(tlsDirectory, "key.pem");
const certificatePath = path.join(tlsDirectory, "certificate.pem");
const certificate = spawnSync("openssl", [
  "req",
  "-x509",
  "-newkey",
  "rsa:2048",
  "-nodes",
  "-sha256",
  "-days",
  "1",
  "-subj",
  `/CN=${hostname}`,
  "-addext",
  `subjectAltName=IP:${hostname},DNS:localhost`,
  "-keyout",
  keyPath,
  "-out",
  certificatePath,
], { encoding: "utf8" });
if (certificate.status !== 0) {
  rmSync(tlsDirectory, { force: true, recursive: true });
  const detail = certificate.error instanceof Error
    ? certificate.error.message
    : certificate.stderr?.trim() || "openssl exited without diagnostics";
  throw new Error(`could not create public browser test certificate: ${detail}`);
}

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  rmSync(tlsDirectory, { force: true, recursive: true });
}
process.once("exit", cleanup);

function isApiPath(pathname) {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function canWrite(response) {
  return !response.destroyed && !response.writableEnded;
}

function writeJson(response, statusCode, value, extraHeaders = {}) {
  if (!canWrite(response)) return;
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": String(body.length),
    "content-type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  response.end(body);
}

function recordUnexpectedScanFailure(kind, pathname) {
  if (harnessState.unexpectedScanFailures.length >= 20) return;
  harnessState.unexpectedScanFailures.push({ kind, pathname: pathname.slice(0, 200) });
}

function connectionHeaderNames(headers) {
  const value = headers.connection;
  if (typeof value !== "string") return [];
  return value.split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);
}

function stripHopByHopHeaders(headers) {
  const excluded = new Set([...hopByHopHeaders, ...connectionHeaderNames(headers)]);
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !excluded.has(name.toLowerCase())),
  );
}

function forbiddenBuffers(value) {
  const utf16le = Buffer.from(value, "utf16le");
  const utf16be = Buffer.from(utf16le);
  for (let index = 0; index + 1 < utf16be.length; index += 2) {
    [utf16be[index], utf16be[index + 1]] = [utf16be[index + 1], utf16be[index]];
  }
  return [Buffer.from(value, "utf8"), utf16le, utf16be];
}

function containsForbidden(buffer) {
  return forbiddenValues.some((value) =>
    forbiddenBuffers(value).some((encoded) => buffer.includes(encoded)));
}

function hasForbiddenHeader(headers) {
  for (const [name, value] of Object.entries(headers)) {
    const serialized = `${name}:${Array.isArray(value) ? value.join("\n") : value ?? ""}`;
    if (containsForbidden(Buffer.from(serialized, "utf8"))) return true;
  }
  return false;
}

function unsupportedTransferCoding(headers) {
  const value = headers["transfer-encoding"];
  if (value === undefined) return false;
  if (typeof value !== "string") return true;
  const codings = value.split(",").map((coding) => coding.trim().toLowerCase()).filter(Boolean);
  // Node has already removed HTTP chunk framing from IncomingMessage bytes.
  return codings.length !== 1 || codings[0] !== "chunked";
}

function unsupportedContentEncoding(headers) {
  const value = headers["content-encoding"];
  return value !== undefined && (typeof value !== "string" || value.trim().toLowerCase() !== "identity");
}

function unsupportedTextCharset(headers) {
  const contentType = headers["content-type"];
  if (typeof contentType !== "string") return false;
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const textual = mediaType.startsWith("text/")
    || mediaType === "application/json"
    || mediaType.endsWith("+json")
    || mediaType === "application/javascript"
    || mediaType === "application/xml"
    || mediaType.endsWith("+xml")
    || mediaType === "image/svg+xml";
  if (!textual) return false;
  const charset = /(?:^|;)\s*charset\s*=\s*"?([^;"\s]+)/iu.exec(contentType)?.[1]?.toLowerCase();
  return charset !== undefined && !["utf-8", "utf8", "us-ascii"].includes(charset);
}

function scanFailure(headers, body, urlBytes) {
  if (unsupportedTransferCoding(headers)) return "unsupported-transfer-coding";
  if (unsupportedContentEncoding(headers)) return "unsupported-content-encoding";
  if (unsupportedTextCharset(headers)) return "unsupported-text-charset";
  if (hasForbiddenHeader(headers) || containsForbidden(body) || containsForbidden(urlBytes)) {
    return "forbidden-value";
  }
  return undefined;
}

function rejectedResponse(response, api) {
  writeJson(response, 502, { error: "public browser evidence rejected traffic" }, api
    ? { [apiScanHeader]: apiScanRejected, [responseScanHeader]: responseScanRejected }
    : { [responseScanHeader]: responseScanRejected });
}

function forwardedResponseHeaders(headers, bodyLength, api) {
  const forwarded = stripHopByHopHeaders(headers);
  delete forwarded[apiScanHeader];
  delete forwarded[responseScanHeader];
  delete forwarded["content-encoding"];
  delete forwarded["content-length"];
  forwarded["content-length"] = String(bodyLength);
  if (api) forwarded[apiScanHeader] = apiScanPassed;
  forwarded[responseScanHeader] = responseScanPassed;
  return forwarded;
}

function collectBoundedBody(stream, maximumBytes, label) {
  return new Promise((resolve, reject) => {
    const declaredLength = stream.headers?.["content-length"];
    if (
      declaredLength !== undefined
      && (typeof declaredLength !== "string" || !/^\d+$/u.test(declaredLength) || Number(declaredLength) > maximumBytes)
    ) {
      stream.destroy();
      reject(new Error(`${label} exceeded the public evidence limit`));
      return;
    }

    const chunks = [];
    let byteLength = 0;
    let settled = false;
    let idleTimer;
    const overallTimer = setTimeout(
      () => fail(new Error(`${label} exceeded the public evidence deadline`)),
      30_000,
    );
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => fail(new Error(`${label} exceeded the public evidence idle deadline`)),
        10_000,
      );
    };
    const clearTimers = () => {
      clearTimeout(idleTimer);
      clearTimeout(overallTimer);
    };
    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimers();
      stream.destroy();
      reject(error);
    }
    resetIdleTimer();
    stream.on("data", (chunk) => {
      if (settled) return;
      resetIdleTimer();
      byteLength += chunk.length;
      if (byteLength > maximumBytes) {
        fail(new Error(`${label} exceeded the public evidence limit`));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    stream.once("aborted", () => fail(new Error(`${label} was aborted`)));
    stream.once("error", fail);
    stream.once("close", () => {
      if ("complete" in stream && !stream.complete) {
        fail(new Error(`${label} closed before completion`));
      }
    });
    stream.once("end", () => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(Buffer.concat(chunks));
    });
  });
}

function sendScannedResponse(response, statusCode, headers, body, pathname, api, expectedLeakProbe) {
  const failure = scanFailure(headers, body, Buffer.from(pathname, "utf8"));
  if (failure !== undefined) {
    if (expectedLeakProbe !== undefined && failure === "forbidden-value") {
      harnessState.expectedLeakProbeRejections += 1;
      if (expectedLeakProbe === "header") {
        harnessState.expectedHeaderLeakProbeRejections += 1;
      } else {
        harnessState.expectedBodyLeakProbeRejections += 1;
      }
    } else {
      recordUnexpectedScanFailure(`response-${failure}`, pathname);
    }
    rejectedResponse(response, api);
    return;
  }
  if (expectedLeakProbe !== undefined) {
    recordUnexpectedScanFailure(`${expectedLeakProbe}-positive-control-was-not-rejected`, pathname);
    rejectedResponse(response, api);
    return;
  }
  harnessState.responseBodiesScanned += 1;
  if (api) harnessState.apiResponsesScanned += 1;
  if (!canWrite(response)) return;
  response.writeHead(statusCode, forwardedResponseHeaders(headers, body.length, api));
  response.end(body);
}

function childEnvironment() {
  const environment = {};
  for (const name of ["CI", "HOME", "LANG", "LC_ALL", "PATH", "TMPDIR", "TZ"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return {
    ...environment,
    APP_COMMIT_SHA: expectedRevision,
    HANDLEPLAN_E2E_FAKE_PRODUCTION_TOKEN: sentinel,
    HANDLEPLAN_E2E_PUBLIC_ORIGIN: `https://${hostname}:${publicPort}`,
    HANDLEPLAN_E2E_SENTINEL: sentinel,
    HANDLEPLAN_MODE: "fake",
    HOSTNAME: hostname,
    KASSAL_API_KEY: sentinel,
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_ENV: "production",
    PORT: String(upstreamPort),
  };
}

let proxy;
const sockets = new Set();
let shuttingDown = false;
const upstreamProcess = spawn(
  process.execPath,
  ["--import", capabilityPreloader, standaloneServer],
  {
    cwd: repositoryRoot,
    env: childEnvironment(),
    stdio: ["ignore", "inherit", "inherit", "pipe"],
  },
);
const inheritedProofPipe = upstreamProcess.stdio[3];
if (inheritedProofPipe === null || !("end" in inheritedProofPipe)) {
  upstreamProcess.kill("SIGKILL");
  cleanup();
  throw new Error("could not create inherited public browser proof descriptor");
}
inheritedProofPipe.end(sentinel);

let upstreamExitState;
const upstreamExit = new Promise((resolve) => {
  upstreamProcess.once("error", (error) => {
    upstreamExitState = { error: error.message };
    resolve(upstreamExitState);
  });
  upstreamProcess.once("exit", (code, signal) => {
    upstreamExitState = { code, signal };
    resolve(upstreamExitState);
  });
});

async function terminateUpstream() {
  if (upstreamExitState === undefined) upstreamProcess.kill("SIGTERM");
  await Promise.race([upstreamExit, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  if (upstreamExitState === undefined) {
    upstreamProcess.kill("SIGKILL");
    await Promise.race([upstreamExit, new Promise((resolve) => setTimeout(resolve, 1_000))]);
  }
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const socket of sockets) socket.destroy();
  if (proxy?.listening === true) {
    await new Promise((resolve) => proxy.close(resolve));
  }
  await terminateUpstream();
  cleanup();
  process.exit(harnessState.unexpectedScanFailures.length === 0 ? 0 : 1);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
void upstreamExit.then(() => {
  if (shuttingDown) return;
  process.exitCode = 1;
  recordUnexpectedScanFailure("upstream-exited", "/");
  void shutdown().catch(() => {
    cleanup();
    process.exit(1);
  });
});

function probeUpstreamReadiness() {
  return new Promise((resolve) => {
    const request = requestHttp({
      headers: { host: `${hostname}:${publicPort}`, "x-forwarded-proto": "https" },
      hostname,
      method: "GET",
      path: "/api/ready",
      port: upstreamPort,
      timeout: 1_000,
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode === 200));
    });
    request.once("error", () => resolve(false));
    request.once("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.end();
  });
}

const readinessDeadline = Date.now() + 60_000;
let upstreamReady = false;
while (!upstreamReady && Date.now() < readinessDeadline && upstreamExitState === undefined) {
  upstreamReady = await probeUpstreamReadiness();
  if (!upstreamReady) await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!upstreamReady) {
  await terminateUpstream();
  cleanup();
  throw new Error(`standalone public browser upstream was not ready: ${JSON.stringify(upstreamExitState)}`);
}

async function waitForScanQuiescence() {
  harnessState.teardownBarrier = true;
  const deadline = Date.now() + 10_000;
  while (
    Date.now() < deadline
    && (harnessState.inFlightRequests > 0 || Date.now() - lastApplicationTrafficAt < 250)
  ) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (harnessState.inFlightRequests > 0) {
    recordUnexpectedScanFailure("teardown-barrier-timeout", controlPath);
  }
}

async function forwardApplicationRequest(request, response) {
  const requestUrl = new URL(request.url ?? "/", `https://${hostname}:${publicPort}`);
  const api = isApiPath(requestUrl.pathname);

  if (request.headers.host !== `${hostname}:${publicPort}`) {
    writeJson(response, 421, { error: "exact public browser test host required" });
    return;
  }
  if (
    request.method === "GET"
    && requestUrl.pathname === controlPath
    && requestUrl.search === ""
    && request.headers[controlHeader] === sentinel
  ) {
    await waitForScanQuiescence();
    writeJson(response, 200, {
      contractVersion: 1,
      upstreamProcessId: upstreamProcess.pid,
      ...harnessState,
    });
    return;
  }
  if (
    request.method === "GET"
    && [bodyLeakProbePath, headerLeakProbePath].includes(requestUrl.pathname)
    && requestUrl.search === ""
    && request.headers[leakProbeHeader] === "v1"
  ) {
    const expectedHeaderLeak = requestUrl.pathname === headerLeakProbePath;
    sendScannedResponse(
      response,
      200,
      expectedHeaderLeak
        ? {
            "content-type": "application/json; charset=utf-8",
            "x-handleplan-e2e-positive-control": sentinel,
          }
        : { "content-type": "application/json; charset=utf-8" },
      Buffer.from(JSON.stringify(expectedHeaderLeak ? { probe: "header" } : { sentinel })),
      requestUrl.pathname,
      true,
      expectedHeaderLeak ? "header" : "body",
    );
    return;
  }

  const expectedMethodProbe = request.method === "TRACE"
    && requestUrl.pathname === methodProbePath
    && requestUrl.search === ""
    && request.headers[methodProbeHeader] === "v1";
  if (!allowedMethods.has(request.method ?? "")) {
    if (expectedMethodProbe) {
      harnessState.expectedMethodProbeRejections += 1;
    } else {
      recordUnexpectedScanFailure("request-unsupported-method", requestUrl.pathname);
    }
    rejectedResponse(response, api);
    return;
  }

  if (harnessState.teardownBarrier) {
    lastApplicationTrafficAt = Date.now();
    recordUnexpectedScanFailure("traffic-after-teardown-barrier", requestUrl.pathname);
    rejectedResponse(response, api);
    return;
  }
  harnessState.inFlightRequests += 1;
  lastApplicationTrafficAt = Date.now();
  try {
    let requestBody;
    try {
      requestBody = await collectBoundedBody(request, maxRequestBytes, "public browser request body");
    } catch {
      recordUnexpectedScanFailure("request-incomplete", requestUrl.pathname);
      rejectedResponse(response, api);
      return;
    }
    const requestFailure = scanFailure(
      request.headers,
      requestBody,
      Buffer.from(`${request.method ?? ""}\0${request.url ?? "/"}`, "utf8"),
    );
    if (requestFailure !== undefined) {
      recordUnexpectedScanFailure(`request-${requestFailure}`, requestUrl.pathname);
      rejectedResponse(response, api);
      return;
    }
    harnessState.requestBodiesScanned += 1;

    const upstreamHeaders = stripHopByHopHeaders(request.headers);
    delete upstreamHeaders[apiScanHeader];
    delete upstreamHeaders[responseScanHeader];
    delete upstreamHeaders[controlHeader];
    delete upstreamHeaders[leakProbeHeader];
    delete upstreamHeaders[methodProbeHeader];
    delete upstreamHeaders["content-encoding"];
    delete upstreamHeaders["content-length"];
    upstreamHeaders["accept-encoding"] = "identity";
    upstreamHeaders["content-length"] = String(requestBody.length);
    upstreamHeaders.host = `${hostname}:${publicPort}`;
    upstreamHeaders["x-forwarded-host"] = `${hostname}:${publicPort}`;
    upstreamHeaders["x-forwarded-proto"] = "https";

    await new Promise((resolve) => {
      let settled = false;
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        try {
          callback();
        } catch {
          recordUnexpectedScanFailure("proxy-write-failure", requestUrl.pathname);
          try {
            if (!response.headersSent) {
              writeJson(response, 500, { error: "public browser harness failure" });
            } else {
              response.destroy();
            }
          } catch {
            response.destroy();
          }
        } finally {
          resolve();
        }
      };
      const upstream = requestHttp({
        headers: upstreamHeaders,
        hostname,
        method: request.method,
        path: request.url,
        port: upstreamPort,
      }, (upstreamResponse) => {
        void collectBoundedBody(upstreamResponse, maxResponseBytes, "public browser response body")
          .then((body) => finish(() => sendScannedResponse(
            response,
            upstreamResponse.statusCode ?? 502,
            upstreamResponse.headers,
            body,
            requestUrl.pathname,
            api,
          )))
          .catch(() => finish(() => {
            recordUnexpectedScanFailure("response-incomplete", requestUrl.pathname);
            rejectedResponse(response, api);
          }));
      });
      upstream.setTimeout(30_000, () => {
        upstream.destroy(new Error("public browser upstream timed out"));
      });
      upstream.once("error", () => finish(() => {
        recordUnexpectedScanFailure("upstream-unavailable", requestUrl.pathname);
        rejectedResponse(response, api);
      }));
      upstream.end(requestBody);
    });
  } finally {
    harnessState.inFlightRequests -= 1;
    lastApplicationTrafficAt = Date.now();
  }
}

proxy = createHttpsServer({
  cert: readFileSync(certificatePath),
  key: readFileSync(keyPath),
}, (request, response) => {
  void forwardApplicationRequest(request, response).catch(() => {
    recordUnexpectedScanFailure("proxy-handler-error", new URL(
      request.url ?? "/",
      `https://${hostname}:${publicPort}`,
    ).pathname);
    if (!response.headersSent) writeJson(response, 500, { error: "public browser harness failure" });
    else response.destroy();
  });
});
proxy.headersTimeout = 10_000;
proxy.requestTimeout = 30_000;

proxy.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});
proxy.on("connect", (_request, socket) => {
  recordUnexpectedScanFailure("request-connect-not-allowed", "/");
  socket.destroy();
});
proxy.on("upgrade", (_request, socket) => {
  recordUnexpectedScanFailure("request-upgrade-not-allowed", "/");
  socket.destroy();
});
proxy.on("clientError", (error, socket) => {
  // Browsers may close speculative TLS connections before sending an HTTP
  // request. Node reports those harmless, unforwarded sockets as ECONNRESET
  // or the exact certificate alert below. Every other parser/client failure
  // remains unexpected and fails evidence.
  const unforwardedCertificateAlert = (
    error?.code === "ERR_SSL_SSL/TLS_ALERT_CERTIFICATE_UNKNOWN"
    && socket.bytesRead === 0
    && socket.bytesWritten === 0
  );
  if (error?.code !== "ECONNRESET" && !unforwardedCertificateAlert) {
    const code = typeof error?.code === "string"
      ? error.code.replace(/[^A-Z0-9_]+/gu, "_").slice(0, 80)
      : "UNKNOWN";
    recordUnexpectedScanFailure(`request-parse-failure-${code}`, "/");
  }
  socket.destroy();
});

try {
  await new Promise((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(publicPort, hostname, () => {
      proxy.removeListener("error", reject);
      resolve();
    });
  });
} catch (error) {
  for (const socket of sockets) socket.destroy();
  await terminateUpstream();
  cleanup();
  throw error;
}
