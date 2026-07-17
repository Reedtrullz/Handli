import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, request as requestHttp } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";
import path from "node:path";

const projectRoot = process.cwd();
const standaloneRoot = path.join(projectRoot, ".next", "standalone", "apps", "web");
const publicTarget = path.join(standaloneRoot, "public");
const staticTarget = path.join(standaloneRoot, ".next", "static");
const hostname = "127.0.0.1";
const publicPort = 3115;
const upstreamPort = 3116;
const controlPort = 3117;
const fixturePaths = new Set([
  "/api/locations/search",
  "/api/plans",
  "/api/plans/travel",
]);
const fixtureRequestBytes = new Map([
  ["/api/locations/search", 2 * 1024],
  ["/api/plans", 64 * 1024],
  ["/api/plans/travel", 64 * 1024],
]);
const maxFixtureBodyBytes = 256 * 1024;
const maxFixtureAggregateBytes = 512 * 1024;
const maxControlRequestBytes = 1024 * 1024;
const maxCapturedRequestsPerPath = 4;
const controlHeaderName = "x-handleplan-test-control";
const controlHeaderValue = "v1";
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

for (const target of [publicTarget, staticTarget]) {
  rmSync(target, { force: true, recursive: true });
}
cpSync(path.join(projectRoot, "public"), publicTarget, { recursive: true });
cpSync(path.join(projectRoot, ".next", "static"), staticTarget, { recursive: true });

const tlsDirectory = mkdtempSync(path.join(tmpdir(), "handleplan-handlemodus-tls-"));
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
  throw new Error(`could not create Handlemodus test certificate: ${detail}`);
}

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  rmSync(tlsDirectory, { force: true, recursive: true });
}
process.once("exit", cleanup);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    cleanup();
    process.exit(0);
  });
}

process.env.HOSTNAME = hostname;
process.env.PORT = String(upstreamPort);
await import(pathToFileURL(path.join(standaloneRoot, "server.js")).href);

let networkOffline = false;
const fixtures = new Map();
const capturedRequestBodies = new Map();

function writeEmpty(response, statusCode) {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": "0",
  });
  response.end();
}

function writeJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": String(Buffer.byteLength(body)),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}

function hasOnlySearchParameter(requestUrl, name) {
  const keys = [...requestUrl.searchParams.keys()];
  return keys.length === 1 && keys[0] === name;
}

function readBoundedBody(request, maximumBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let byteLength = 0;
    let tooLarge = false;

    request.on("data", (chunk) => {
      byteLength += chunk.length;
      if (byteLength > maximumBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(Buffer.from(chunk));
    });
    request.once("end", () => {
      if (tooLarge) {
        reject(new Error("request body exceeds the test-harness limit"));
        return;
      }
      try {
        resolve(utf8Decoder.decode(Buffer.concat(chunks)));
      } catch {
        reject(new Error("request body is not valid UTF-8"));
      }
    });
    request.once("aborted", () => reject(new Error("request was aborted")));
    request.once("error", reject);
  });
}

function parseFixtures(value) {
  if (
    typeof value !== "object"
    || value === null
    || !Array.isArray(value.fixtures)
    || value.fixtures.length > fixturePaths.size
  ) {
    return undefined;
  }

  const parsed = new Map();
  let aggregateBytes = 0;
  for (const fixture of value.fixtures) {
    const bodyBytes = typeof fixture?.body === "string"
      ? Buffer.byteLength(fixture.body)
      : Number.POSITIVE_INFINITY;
    if (
      typeof fixture !== "object"
      || fixture === null
      || typeof fixture.path !== "string"
      || !fixturePaths.has(fixture.path)
      || parsed.has(fixture.path)
      || typeof fixture.body !== "string"
      || bodyBytes > maxFixtureBodyBytes
      || aggregateBytes + bodyBytes > maxFixtureAggregateBytes
      || (fixture.status !== undefined
        && (!Number.isInteger(fixture.status) || fixture.status < 200 || fixture.status > 599))
    ) {
      return undefined;
    }
    aggregateBytes += bodyBytes;
    try {
      JSON.parse(fixture.body);
    } catch {
      return undefined;
    }
    parsed.set(fixture.path, {
      body: fixture.body,
      status: fixture.status ?? 200,
    });
  }
  return parsed;
}

async function handleApplicationRequest(request, response) {
  if (networkOffline) {
    request.socket.destroy();
    return;
  }

  const requestUrl = new URL(request.url ?? "/", `https://${hostname}:${publicPort}`);
  if (fixturePaths.has(requestUrl.pathname)) {
    if (request.headers.host !== `${hostname}:${publicPort}`) {
      writeJson(response, 421, { error: "exact test application host required" });
      return;
    }
    if (request.method !== "POST") {
      writeJson(response, 405, { error: "fixture endpoint requires POST" });
      return;
    }
    if (requestUrl.search !== "") {
      writeJson(response, 400, { error: "fixture endpoint does not accept a query" });
      return;
    }
    if (
      request.headers["content-encoding"] !== undefined
      && request.headers["content-encoding"] !== "identity"
    ) {
      writeJson(response, 415, { error: "encoded fixture request is not supported" });
      return;
    }
    if (!/^application\/json(?:\s*;|$)/iu.test(request.headers["content-type"] ?? "")) {
      writeJson(response, 415, { error: "fixture request must be JSON" });
      return;
    }
    const maximumBytes = fixtureRequestBytes.get(requestUrl.pathname);
    const declaredLength = request.headers["content-length"];
    if (
      maximumBytes === undefined
      || (declaredLength !== undefined
        && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maximumBytes))
    ) {
      writeJson(response, 413, { error: "bounded fixture request required" });
      return;
    }
    const fixture = fixtures.get(requestUrl.pathname);
    if (fixture === undefined) {
      writeJson(response, 503, { error: "test fixture is not installed" });
      return;
    }
    let body;
    try {
      body = await readBoundedBody(request, maximumBytes);
    } catch {
      writeJson(response, 413, { error: "bounded fixture request required" });
      return;
    }

    const captures = capturedRequestBodies.get(requestUrl.pathname) ?? [];
    if (captures.length >= maxCapturedRequestsPerPath) {
      writeJson(response, 429, { error: "fixture request capture limit reached" });
      return;
    }
    captures.push(body);
    capturedRequestBodies.set(requestUrl.pathname, captures);
    response.writeHead(fixture.status, {
      "cache-control": "no-store",
      "content-length": String(Buffer.byteLength(fixture.body)),
      "content-type": "application/json; charset=utf-8",
    });
    response.end(fixture.body);
    return;
  }

  const upstream = requestHttp({
    headers: {
      ...request.headers,
      host: `${hostname}:${publicPort}`,
      "x-forwarded-host": `${hostname}:${publicPort}`,
      "x-forwarded-proto": "https",
    },
    hostname,
    method: request.method,
    path: request.url,
    port: upstreamPort,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502, { "cache-control": "no-store" });
    response.end();
  });
  request.on("aborted", () => upstream.destroy());
  request.pipe(upstream);
}

const proxy = createHttpsServer({
  cert: readFileSync(certificatePath),
  key: readFileSync(keyPath),
}, (request, response) => {
  void handleApplicationRequest(request, response).catch(() => {
    if (!response.headersSent) writeJson(response, 500, { error: "test harness failure" });
    else response.destroy();
  });
});

const applicationSockets = new Set();
proxy.on("connection", (socket) => {
  applicationSockets.add(socket);
  socket.once("close", () => applicationSockets.delete(socket));
});

const control = createHttpServer((request, response) => {
  void (async () => {
    const requestUrl = new URL(request.url ?? "/", `http://${hostname}:${controlPort}`);
    if (
      request.headers.host !== `${hostname}:${controlPort}`
      || request.headers[controlHeaderName] !== controlHeaderValue
    ) {
      writeEmpty(response, 404);
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/network") {
      const values = requestUrl.searchParams.getAll("offline");
      if (
        !hasOnlySearchParameter(requestUrl, "offline")
        || values.length !== 1
        || !["0", "1"].includes(values[0])
      ) {
        writeJson(response, 400, { error: "one offline flag is required" });
        return;
      }
      networkOffline = values[0] === "1";
      if (networkOffline) {
        for (const socket of applicationSockets) socket.destroy();
      }
      writeEmpty(response, 204);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/reset") {
      if (requestUrl.search !== "") {
        writeJson(response, 400, { error: "reset does not accept a query" });
        return;
      }
      networkOffline = false;
      fixtures.clear();
      capturedRequestBodies.clear();
      writeEmpty(response, 204);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/fixtures") {
      if (
        requestUrl.search !== ""
        || !/^application\/json(?:\s*;|$)/iu.test(request.headers["content-type"] ?? "")
      ) {
        writeJson(response, 400, { error: "fixture control requires JSON without a query" });
        return;
      }
      const declaredLength = request.headers["content-length"];
      if (
        declaredLength !== undefined
        && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maxControlRequestBytes)
      ) {
        writeJson(response, 413, { error: "bounded fixture control required" });
        return;
      }
      let value;
      try {
        value = JSON.parse(await readBoundedBody(request, maxControlRequestBytes));
      } catch {
        writeJson(response, 400, { error: "valid bounded JSON required" });
        return;
      }
      const parsed = parseFixtures(value);
      if (parsed === undefined) {
        writeJson(response, 400, { error: "invalid fixture configuration" });
        return;
      }
      fixtures.clear();
      capturedRequestBodies.clear();
      for (const [fixturePath, fixture] of parsed) fixtures.set(fixturePath, fixture);
      writeEmpty(response, 204);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/requests") {
      const paths = requestUrl.searchParams.getAll("path");
      const fixturePath = paths[0];
      if (
        !hasOnlySearchParameter(requestUrl, "path")
        || paths.length !== 1
        || fixturePath === undefined
        || !fixturePaths.has(fixturePath)
      ) {
        writeJson(response, 400, { error: "allowlisted fixture path required" });
        return;
      }
      writeJson(response, 200, {
        bodies: capturedRequestBodies.get(fixturePath) ?? [],
        path: fixturePath,
      });
      return;
    }

    writeEmpty(response, 404);
  })().catch(() => {
    if (!response.headersSent) writeJson(response, 500, { error: "test control failure" });
    else response.destroy();
  });
});

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

await listen(control, controlPort);
await listen(proxy, publicPort);
