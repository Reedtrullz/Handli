import { spawn, spawnSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import {
  createServer as createHttpServer,
  request as requestHttp,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";

const hostname = "127.0.0.1";
const upstreamPort = 3120;
const publicPort = 3121;
const controlPort = 3122;
const responseScanHeader = "x-handleplan-image-e2e-response-scan";
const controlHeader = "x-handleplan-image-e2e-control";
const headerLeakProbePath = "/__handleplan-image-e2e/leak-header-v1";
const bodyLeakProbePath = "/__handleplan-image-e2e/leak-body-v1";
const leakProbeHeader = "x-handleplan-image-e2e-leak-probe";
const maxRequestBytes = 2 * 1024 * 1024;
const maxResponseBytes = 16 * 1024 * 1024;
const imageIdPattern = /^sha256:[0-9a-f]{64}$/u;
const revisionPattern = /^[0-9a-f]{40}$/u;
const buildIdPattern = /^hpv2-[0-9a-f]{64}$/u;
const controlTokenPattern = /^handleplan-image-control-[0-9a-f]{48}$/u;
const responseCanaryPattern = /^handleplan-image-canary-[0-9a-f]{48}$/u;
const expectedImageId = process.env.HANDLEPLAN_IMAGE_ID ?? "";
const expectedRevision = process.env.APP_COMMIT_SHA ?? "";
const imageReference = process.env.HANDLEPLAN_IMAGE_REFERENCE ?? "";
const controlToken = process.env.HANDLEPLAN_IMAGE_E2E_CONTROL_TOKEN ?? "";
const responseCanary = process.env.HANDLEPLAN_IMAGE_E2E_RESPONSE_CANARY ?? "";
const databaseRoleSpecifications = [
  ["HANDLEPLAN_IMAGE_SEED_DATABASE_URL", "handleplan"],
  ["HANDLEPLAN_IMAGE_SEED_APP_DATABASE_URL", "handleplan_app"],
  ["HANDLEPLAN_IMAGE_SEED_REVIEW_DATABASE_URL", "handleplan_review"],
  ["HANDLEPLAN_IMAGE_DATABASE_URL", "handleplan_web"],
];
const allowedMethods = new Set(["GET", "HEAD", "POST"]);
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

function fail(message) {
  throw new Error(`production image browser harness: ${message}`);
}

if (!imageIdPattern.test(expectedImageId)) fail("HANDLEPLAN_IMAGE_ID is invalid");
if (!revisionPattern.test(expectedRevision)) fail("APP_COMMIT_SHA is invalid");
if (imageReference !== `handleplan:${expectedRevision}`) {
  fail("HANDLEPLAN_IMAGE_REFERENCE is not the exact revision tag");
}
if (!controlTokenPattern.test(controlToken)) {
  fail("the loopback control capability is invalid");
}
if (!responseCanaryPattern.test(responseCanary)) {
  fail("the response scan canary is invalid");
}

function requiredDatabaseRoleUrl(name, expectedUser) {
  const value = process.env[name] ?? "";
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${name} is invalid`);
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol)
    || parsed.hostname !== hostname
    || parsed.port !== "5432"
    || parsed.pathname !== "/handleplan"
    || parsed.username !== expectedUser
    || parsed.password.length < 16
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    fail(`${name} must be its exact isolated loopback CI role`);
  }
  return { name, password: parsed.password, url: value };
}

const databaseRoles = databaseRoleSpecifications.map(([name, expectedUser]) =>
  requiredDatabaseRoleUrl(name, expectedUser));
const databaseUrl = databaseRoles.find(({ name }) =>
  name === "HANDLEPLAN_IMAGE_DATABASE_URL")?.url;
if (databaseUrl === undefined) fail("the exact-image web database role is unavailable");
const databaseCredentialCanaries = databaseRoles.flatMap(({ password, url }) => [url, password]);

const forbiddenValues = [...new Set([
  "DATABASE_URL",
  ...databaseRoles.map(({ name }) => name),
  ...databaseCredentialCanaries,
  controlToken,
  responseCanary,
])];
const hostCommandEnvironment = { ...process.env };
for (const [name] of databaseRoleSpecifications) delete hostCommandEnvironment[name];
const harnessState = {
  databaseCredentialCanaryCount: databaseCredentialCanaries.length,
  databaseRoleCount: databaseRoles.length,
  expectedBodyLeakProbeRejections: 0,
  expectedHeaderLeakProbeRejections: 0,
  expectedLeakProbeRejections: 0,
  forbiddenValueCount: forbiddenValues.length,
  inFlightRequests: 0,
  responseBodiesScanned: 0,
  teardownBarrier: false,
  unexpectedScanFailures: [],
};
let lastApplicationTrafficAt = Date.now();
let networkOffline = false;
let transition;

function docker(arguments_, { allowFailure = false } = {}) {
  const result = spawnSync("docker", arguments_, {
    encoding: "utf8",
    env: hostCommandEnvironment,
    maxBuffer: 1024 * 1024,
  });
  if (!allowFailure && (result.error !== undefined || result.status !== 0)) {
    fail(`Docker command failed: ${arguments_[0] ?? "unknown"}`);
  }
  return result.stdout;
}

function inspectImage(reference) {
  let inspection;
  try {
    inspection = JSON.parse(docker(["image", "inspect", reference]));
  } catch {
    fail("Docker image inspection is invalid");
  }
  if (
    !Array.isArray(inspection)
    || inspection.length !== 1
    || inspection[0]?.Id !== expectedImageId
    || inspection[0]?.Os !== "linux"
    || inspection[0]?.Architecture !== "amd64"
    || inspection[0]?.Config?.Labels?.["org.opencontainers.image.revision"] !== expectedRevision
    || JSON.stringify(inspection[0]?.Config?.Entrypoint) !== JSON.stringify(["/app/deploy/entrypoint.sh"])
  ) {
    fail("image reference, immutable ID, revision, or default entrypoint does not match");
  }
}

inspectImage(imageReference);
inspectImage(expectedImageId);

const tlsDirectory = mkdtempSync(path.join(tmpdir(), "handleplan-image-browser-tls-"));
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
if (certificate.error !== undefined || certificate.status !== 0) {
  rmSync(tlsDirectory, { force: true, recursive: true });
  fail("could not create the ephemeral HTTPS certificate");
}

const containerName = `handleplan-image-browser-${process.pid}-${randomBytes(6).toString("hex")}`;
const proxySockets = new Set();
const upstreamRequests = new Set();
let proxy;
let controlServer;
let containerStarted = false;
let cleaning = false;
let waitProcess;

function cleanup() {
  if (cleaning) return;
  cleaning = true;
  for (const request of upstreamRequests) request.destroy();
  for (const socket of proxySockets) socket.destroy();
  proxy?.closeAllConnections?.();
  proxy?.close();
  controlServer?.closeAllConnections?.();
  controlServer?.close();
  if (containerStarted) docker(["rm", "-f", containerName], { allowFailure: true });
  waitProcess?.kill("SIGTERM");
  rmSync(tlsDirectory, { force: true, recursive: true });
}

process.once("exit", cleanup);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    cleanup();
    process.exit(0);
  });
}

const containerEnvironment = {
  ...hostCommandEnvironment,
  APP_COMMIT_SHA: expectedRevision,
  DATABASE_URL: databaseUrl,
  HOSTNAME: hostname,
  NEXT_TELEMETRY_DISABLED: "1",
  NODE_ENV: "production",
  PORT: String(upstreamPort),
};
const launch = spawnSync("docker", [
  "run",
  "--detach",
  "--name",
  containerName,
  "--network",
  "host",
  "--read-only",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges:true",
  "--tmpfs",
  "/tmp:rw,noexec,nosuid,nodev,size=64m",
  "--env",
  "APP_COMMIT_SHA",
  "--env",
  "DATABASE_URL",
  "--env",
  "HOSTNAME",
  "--env",
  "NEXT_TELEMETRY_DISABLED",
  "--env",
  "NODE_ENV",
  "--env",
  "PORT",
  expectedImageId,
], {
  encoding: "utf8",
  env: containerEnvironment,
  maxBuffer: 1024 * 1024,
});
if (launch.error !== undefined || launch.status !== 0) {
  cleanup();
  fail("could not start the exact production image");
}
containerStarted = true;

function inspectContainer() {
  let inspection;
  try {
    inspection = JSON.parse(docker(["container", "inspect", containerName]));
  } catch {
    fail("Docker container inspection is invalid");
  }
  const container = inspection?.[0];
  if (
    !Array.isArray(inspection)
    || inspection.length !== 1
    || container?.Image !== expectedImageId
    || container?.Config?.Image !== expectedImageId
    || container?.Config?.Labels?.["org.opencontainers.image.revision"] !== expectedRevision
    || JSON.stringify(container?.Config?.Entrypoint) !== JSON.stringify(["/app/deploy/entrypoint.sh"])
    || container?.State?.Running !== true
    || container?.RestartCount !== 0
    || container?.HostConfig?.ReadonlyRootfs !== true
    || container?.HostConfig?.NetworkMode !== "host"
    || !container?.HostConfig?.CapDrop?.includes("ALL")
    || !container?.HostConfig?.SecurityOpt?.includes("no-new-privileges:true")
    || !Array.isArray(container?.Mounts)
    || container.Mounts.length !== 0
  ) {
    fail("live production container does not match the immutable hardened contract");
  }
}

function readBoundedJson(pathname) {
  return new Promise((resolve, reject) => {
    const request = requestHttp({
      headers: { accept: "application/json" },
      host: hostname,
      method: "GET",
      path: pathname,
      port: upstreamPort,
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024) {
          request.destroy(new Error("response exceeded the harness bound"));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.once("end", () => {
        try {
          resolve({ status: response.statusCode, value: JSON.parse(Buffer.concat(chunks)) });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(5_000, () => request.destroy(new Error("request timed out")));
    request.once("error", reject);
    request.end();
  });
}

let ready = false;
for (let attempt = 0; attempt < 60; attempt += 1) {
  inspectContainer();
  try {
    const [health, readiness] = await Promise.all([
      readBoundedJson("/api/health"),
      readBoundedJson("/api/ready"),
    ]);
    if (
      health.status === 200
      && health.value?.status === "ok"
      && health.value?.commit === expectedRevision
      && readiness.status === 200
      && readiness.value?.status === "ok"
    ) {
      ready = true;
      break;
    }
  } catch {
    // The immutable container may still be starting or waiting for PostgreSQL.
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
if (!ready) {
  cleanup();
  fail("exact production image did not become ready");
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

function writeEmpty(response, statusCode) {
  if (!canWrite(response)) return;
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": "0",
  });
  response.end();
}

function recordUnexpectedScanFailure(kind, pathname) {
  if (harnessState.unexpectedScanFailures.length >= 20) return;
  harnessState.unexpectedScanFailures.push({
    kind,
    pathname: pathname.slice(0, 200),
  });
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
  // IncomingMessage has already removed HTTP chunk framing from the collected bytes.
  return codings.length !== 1 || codings[0] !== "chunked";
}

function unsupportedContentEncoding(headers) {
  const value = headers["content-encoding"];
  return value !== undefined
    && (typeof value !== "string" || value.trim().toLowerCase() !== "identity");
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

function scanFailure(headers, body) {
  if (unsupportedTransferCoding(headers)) return "unsupported-transfer-coding";
  if (unsupportedContentEncoding(headers)) return "unsupported-content-encoding";
  if (unsupportedTextCharset(headers)) return "unsupported-text-charset";
  if (hasForbiddenHeader(headers) || containsForbidden(body)) return "forbidden-value";
  return undefined;
}

function rejectedResponse(response) {
  writeJson(
    response,
    502,
    { error: "exact production image evidence rejected traffic" },
    { [responseScanHeader]: "rejected-v1" },
  );
}

function forwardedResponseHeaders(headers, bodyLength) {
  const forwarded = stripHopByHopHeaders(headers);
  delete forwarded[responseScanHeader];
  delete forwarded["content-encoding"];
  delete forwarded["content-length"];
  forwarded["content-length"] = String(bodyLength);
  forwarded[responseScanHeader] = "passed-v1";
  return forwarded;
}

function collectBoundedBody(stream, maximumBytes, label) {
  return new Promise((resolve, reject) => {
    const declaredLength = stream.headers?.["content-length"];
    if (
      declaredLength !== undefined
      && (
        typeof declaredLength !== "string"
        || !/^\d+$/u.test(declaredLength)
        || Number(declaredLength) > maximumBytes
      )
    ) {
      stream.destroy();
      reject(new Error(`${label} exceeded its evidence bound`));
      return;
    }

    const chunks = [];
    let byteLength = 0;
    let settled = false;
    let idleTimer;
    const overallTimer = setTimeout(
      () => failCollection(new Error(`${label} exceeded its evidence deadline`)),
      30_000,
    );
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => failCollection(new Error(`${label} exceeded its idle deadline`)),
        10_000,
      );
    };
    const clearTimers = () => {
      clearTimeout(idleTimer);
      clearTimeout(overallTimer);
    };
    function failCollection(error) {
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
        failCollection(new Error(`${label} exceeded its evidence bound`));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    stream.once("aborted", () => failCollection(new Error(`${label} was aborted`)));
    stream.once("error", failCollection);
    stream.once("close", () => {
      if ("complete" in stream && !stream.complete) {
        failCollection(new Error(`${label} closed before completion`));
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

function sendScannedResponse(
  response,
  statusCode,
  headers,
  body,
  pathname,
  expectedLeakProbe,
) {
  const failure = scanFailure(headers, body);
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
    rejectedResponse(response);
    return;
  }
  if (expectedLeakProbe !== undefined) {
    recordUnexpectedScanFailure(
      `${expectedLeakProbe}-positive-control-was-not-rejected`,
      pathname,
    );
    rejectedResponse(response);
    return;
  }
  harnessState.responseBodiesScanned += 1;
  if (!canWrite(response)) return;
  response.writeHead(statusCode, forwardedResponseHeaders(headers, body.length));
  response.end(body);
}

function exactUtf8Text(body, label) {
  const text = body.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(body)) {
    throw new Error(`${label} was not canonical UTF-8`);
  }
  return text;
}

function transitionResponseKind(requestUrl) {
  if (transition === undefined) return undefined;
  const requestedWorkerBuildId = requestUrl.pathname === "/sw.js"
    && requestUrl.searchParams.size === 1
    ? requestUrl.searchParams.get("build")
    : undefined;
  // A real next deployment serves the next worker bytes even when a client
  // still requests the prior query identity. Materializing both canonical
  // query variants makes that stale registration fail the worker's embedded
  // identity check instead of synthetically rolling the registration back.
  const isTransitionWorker = requestedWorkerBuildId === transition.fromBuildId
    || requestedWorkerBuildId === transition.toBuildId;
  const isHandleDocument = requestUrl.pathname === "/planlegg/handle"
    && requestUrl.search === "";
  return isTransitionWorker ? "worker" : isHandleDocument ? "document" : undefined;
}

function transformBuildResponse(requestUrl, method, statusCode, headers, body) {
  const responseKind = transitionResponseKind(requestUrl);
  if (responseKind === undefined) return body;
  // The upstream image still has prior-generation validators. A conditional
  // 304 would make the browser reuse the old bytes, which is not how a real
  // deployment with changed worker/document bytes behaves.
  if (method !== "GET" || statusCode !== 200) {
    throw new Error("test-only build transition requires a complete response");
  }

  const contentType = headers["content-type"];
  if (
    typeof contentType !== "string"
    || (responseKind === "worker"
      ? !/^(?:application|text)\/javascript(?:\s*;|$)/iu.test(contentType)
      : !/^text\/html(?:\s*;|$)/iu.test(contentType))
  ) {
    throw new Error("test-only build transition received an unexpected content type");
  }
  const text = exactUtf8Text(body, "test-only build transition response");
  const occurrences = text.split(transition.fromBuildId).length - 1;
  if (occurrences < 1 || text.includes(transition.toBuildId)) {
    throw new Error("test-only build transition did not match exactly one source generation");
  }
  const transformed = text.replaceAll(transition.fromBuildId, transition.toBuildId);
  if (transformed.includes(transition.fromBuildId)) {
    throw new Error("test-only build transition left a prior build marker behind");
  }
  return Buffer.from(transformed, "utf8");
}

function transformedResponseHeaders(requestUrl, headers) {
  if (transitionResponseKind(requestUrl) === undefined) return headers;
  const transformed = { ...headers };
  for (const header of [
    "accept-ranges",
    "content-digest",
    "content-md5",
    "content-range",
    "digest",
    "etag",
    "last-modified",
    "repr-digest",
  ]) delete transformed[header];
  transformed["cache-control"] = "no-store";
  return transformed;
}

function capabilityMatches(value) {
  if (typeof value !== "string" || Buffer.byteLength(value) !== Buffer.byteLength(controlToken)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(value), Buffer.from(controlToken));
}

function setNetworkOffline(nextOffline) {
  networkOffline = nextOffline;
  if (!nextOffline) return;
  for (const request of upstreamRequests) request.destroy();
  for (const socket of proxySockets) socket.destroy();
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
    recordUnexpectedScanFailure("teardown-barrier-timeout", "/status");
  }
}

function parseTransitionBody(body) {
  let value;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "fromBuildId,toBuildId"
    || !buildIdPattern.test(value.fromBuildId)
    || !buildIdPattern.test(value.toBuildId)
    || value.fromBuildId === value.toBuildId
  ) {
    return undefined;
  }
  return { fromBuildId: value.fromBuildId, toBuildId: value.toBuildId };
}

async function handleControlRequest(request, response) {
  if (request.headers.host !== `${hostname}:${controlPort}`) {
    writeJson(response, 421, { error: "exact loopback control host required" });
    return;
  }
  if (!capabilityMatches(request.headers[controlHeader])) {
    writeJson(response, 404, { error: "not found" });
    return;
  }
  const requestUrl = new URL(request.url ?? "/", `http://${hostname}:${controlPort}`);
  if (
    request.method === "GET"
    && requestUrl.pathname === "/status"
    && requestUrl.search === ""
  ) {
    await waitForScanQuiescence();
    writeJson(response, 200, {
      contractVersion: 1,
      networkOffline,
      transitionActive: transition !== undefined,
      ...harnessState,
    });
    return;
  }
  if (request.method !== "POST" || harnessState.teardownBarrier) {
    writeJson(response, 409, { error: "control operation rejected" });
    return;
  }

  let body;
  try {
    body = await collectBoundedBody(request, 8 * 1024, "control request body");
  } catch {
    writeJson(response, 400, { error: "invalid control body" });
    return;
  }
  if (
    requestUrl.pathname === "/reset"
    && requestUrl.search === ""
    && body.length === 0
  ) {
    setNetworkOffline(false);
    transition = undefined;
    writeEmpty(response, 204);
    return;
  }
  if (
    requestUrl.pathname === "/network"
    && requestUrl.searchParams.size === 1
    && body.length === 0
    && ["0", "1"].includes(requestUrl.searchParams.get("offline") ?? "")
  ) {
    setNetworkOffline(requestUrl.searchParams.get("offline") === "1");
    writeEmpty(response, 204);
    return;
  }
  if (
    requestUrl.pathname === "/transition"
    && requestUrl.search === ""
    && !networkOffline
    && /^application\/json(?:\s*;|$)/iu.test(request.headers["content-type"] ?? "")
  ) {
    const parsed = parseTransitionBody(body);
    if (parsed !== undefined) {
      transition = parsed;
      writeEmpty(response, 204);
      return;
    }
  }
  writeJson(response, 400, { error: "invalid control operation" });
}

async function proxyUpstreamRequest(incoming, outgoing, requestUrl, requestBody) {
  const upstreamHeaders = stripHopByHopHeaders(incoming.headers);
  for (const header of [
    controlHeader,
    leakProbeHeader,
    responseScanHeader,
    "content-encoding",
    "content-length",
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
  ]) delete upstreamHeaders[header];
  if (transitionResponseKind(requestUrl) !== undefined) {
    for (const header of [
      "if-match",
      "if-modified-since",
      "if-none-match",
      "if-range",
      "if-unmodified-since",
      "range",
    ]) delete upstreamHeaders[header];
  }
  upstreamHeaders["accept-encoding"] = "identity";
  upstreamHeaders.host = `${hostname}:${publicPort}`;
  upstreamHeaders["x-forwarded-host"] = `${hostname}:${publicPort}`;
  upstreamHeaders["x-forwarded-proto"] = "https";
  if (requestBody.length > 0 || incoming.method === "POST") {
    upstreamHeaders["content-length"] = String(requestBody.length);
  }

  await new Promise((resolve) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      try {
        callback();
      } finally {
        resolve();
      }
    };
    const upstream = requestHttp({
      headers: upstreamHeaders,
      host: hostname,
      method: incoming.method,
      path: incoming.url,
      port: upstreamPort,
    }, async (response) => {
      try {
        const responseHeaders = transformedResponseHeaders(requestUrl, response.headers);
        const body = await collectBoundedBody(
          response,
          maxResponseBytes,
          "production image response body",
        );
        let transformedBody;
        try {
          transformedBody = transformBuildResponse(
            requestUrl,
            incoming.method,
            response.statusCode ?? 502,
            responseHeaders,
            body,
          );
        } catch {
          recordUnexpectedScanFailure("build-transition-rejected", requestUrl.pathname);
          finish(() => rejectedResponse(outgoing));
          return;
        }
        finish(() => sendScannedResponse(
          outgoing,
          response.statusCode ?? 502,
          responseHeaders,
          transformedBody,
          requestUrl.pathname,
        ));
      } catch {
        if (!networkOffline) {
          recordUnexpectedScanFailure("response-incomplete", requestUrl.pathname);
          finish(() => rejectedResponse(outgoing));
        } else {
          finish(() => outgoing.destroy());
        }
      } finally {
        upstreamRequests.delete(upstream);
      }
    });
    upstreamRequests.add(upstream);
    upstream.setTimeout(30_000, () => upstream.destroy(new Error("upstream request timed out")));
    upstream.once("error", () => {
      upstreamRequests.delete(upstream);
      if (!networkOffline) {
        recordUnexpectedScanFailure("upstream-request-failed", requestUrl.pathname);
        finish(() => rejectedResponse(outgoing));
      } else {
        finish(() => outgoing.destroy());
      }
    });
    upstream.end(requestBody);
  });
}

async function forwardApplicationRequest(incoming, outgoing) {
  let requestUrl;
  try {
    requestUrl = new URL(incoming.url ?? "/", `https://${hostname}:${publicPort}`);
  } catch {
    rejectedResponse(outgoing);
    return;
  }
  if (incoming.headers.host !== `${hostname}:${publicPort}`) {
    writeJson(outgoing, 421, { error: "exact image browser test host required" });
    return;
  }
  const expectedHeaderLeak = incoming.method === "GET"
    && requestUrl.pathname === headerLeakProbePath
    && requestUrl.search === ""
    && incoming.headers[leakProbeHeader] === "v1";
  const expectedBodyLeak = incoming.method === "GET"
    && requestUrl.pathname === bodyLeakProbePath
    && requestUrl.search === ""
    && incoming.headers[leakProbeHeader] === "v1";
  if (expectedHeaderLeak || expectedBodyLeak) {
    sendScannedResponse(
      outgoing,
      200,
      expectedHeaderLeak
        ? {
            "content-type": "application/json; charset=utf-8",
            "x-handleplan-image-e2e-positive-control": responseCanary,
          }
        : { "content-type": "application/json; charset=utf-8" },
      Buffer.from(JSON.stringify(expectedBodyLeak
        ? { probe: responseCanary }
        : { probe: "header" })),
      requestUrl.pathname,
      expectedHeaderLeak ? "header" : "body",
    );
    return;
  }
  if (!allowedMethods.has(incoming.method ?? "")) {
    recordUnexpectedScanFailure("request-unsupported-method", requestUrl.pathname);
    rejectedResponse(outgoing);
    return;
  }
  if (harnessState.teardownBarrier) {
    lastApplicationTrafficAt = Date.now();
    recordUnexpectedScanFailure("traffic-after-teardown-barrier", requestUrl.pathname);
    rejectedResponse(outgoing);
    return;
  }
  if (networkOffline) {
    incoming.socket.destroy();
    return;
  }

  harnessState.inFlightRequests += 1;
  lastApplicationTrafficAt = Date.now();
  try {
    let requestBody;
    try {
      requestBody = await collectBoundedBody(
        incoming,
        maxRequestBytes,
        "production image request body",
      );
    } catch {
      if (!networkOffline) {
        recordUnexpectedScanFailure("request-incomplete", requestUrl.pathname);
        rejectedResponse(outgoing);
      }
      return;
    }
    if (networkOffline) {
      outgoing.destroy();
      return;
    }
    await proxyUpstreamRequest(incoming, outgoing, requestUrl, requestBody);
  } finally {
    harnessState.inFlightRequests -= 1;
    lastApplicationTrafficAt = Date.now();
  }
}

controlServer = createHttpServer((request, response) => {
  void handleControlRequest(request, response).catch(() => {
    writeJson(response, 500, { error: "control operation failed closed" });
  });
});
controlServer.on("clientError", (_error, socket) => socket.destroy());
await new Promise((resolve, reject) => {
  controlServer.once("error", reject);
  controlServer.listen(controlPort, hostname, resolve);
});

proxy = createHttpsServer({
  cert: readFileSync(certificatePath),
  key: readFileSync(keyPath),
}, (incoming, outgoing) => {
  void forwardApplicationRequest(incoming, outgoing).catch(() => {
    recordUnexpectedScanFailure("proxy-handler-failed", "/unknown");
    rejectedResponse(outgoing);
  });
});
proxy.on("connection", (socket) => {
  proxySockets.add(socket);
  socket.once("close", () => proxySockets.delete(socket));
});
proxy.on("upgrade", (_request, socket) => socket.destroy());
proxy.on("clientError", (_error, socket) => socket.destroy());
await new Promise((resolve, reject) => {
  proxy.once("error", reject);
  proxy.listen(publicPort, hostname, resolve);
});

waitProcess = spawn("docker", ["wait", containerName], {
  stdio: "ignore",
});
waitProcess.once("exit", () => {
  if (cleaning) return;
  process.exitCode = 1;
  cleanup();
});

process.stdout.write(
  `production image browser harness ready image=${expectedImageId} revision=${expectedRevision}\n`,
);
await new Promise(() => {});
