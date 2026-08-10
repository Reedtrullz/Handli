import { request as requestHttps } from "node:https";

function requestHarness({ headers = {}, method = "GET", path }) {
  return new Promise((resolve, reject) => {
    const request = requestHttps({
      headers,
      hostname: "127.0.0.1",
      method,
      path,
      port: 3109,
      rejectUnauthorized: false,
      timeout: 15_000,
    }, (response) => {
      const chunks = [];
      let length = 0;
      response.on("data", (chunk) => {
        length += chunk.length;
        if (length > 64 * 1024) {
          response.destroy(new Error("public browser harness status exceeded its bound"));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.once("error", reject);
      response.once("end", () => {
        resolve({
          body: Buffer.concat(chunks),
          headers: response.headers,
          statusCode: response.statusCode,
        });
      });
    });
    request.once("error", reject);
    request.once("timeout", () => request.destroy(new Error("public browser harness status timed out")));
    request.end();
  });
}

function requireScanHeaders(response, expected) {
  if (
    response.headers["x-handleplan-e2e-api-scan"] !== expected
    || response.headers["x-handleplan-e2e-response-scan"] !== expected
  ) {
    throw new Error(`public browser harness control had invalid scan headers: ${JSON.stringify(response.headers)}`);
  }
}

function requireRejectedControl(response, sentinel, label) {
  if (response.statusCode !== 502) {
    throw new Error(`public browser harness ${label} returned ${response.statusCode ?? "unknown"}`);
  }
  requireScanHeaders(response, "rejected-v1");
  const expectedBody = Buffer.from(JSON.stringify({
    error: "public browser evidence rejected traffic",
  }));
  const serializedHeaders = Buffer.from(JSON.stringify(response.headers));
  if (
    !response.body.equals(expectedBody)
    || response.body.includes(Buffer.from(sentinel))
    || serializedHeaders.includes(Buffer.from(sentinel))
    || response.body.includes(Buffer.from("KASSAL_API_KEY"))
    || serializedHeaders.includes(Buffer.from("KASSAL_API_KEY"))
  ) {
    throw new Error(`public browser harness ${label} did not return the exact safe rejection`);
  }
}

export default async function verifyPublicHarness() {
  const sentinel = process.env.HANDLEPLAN_E2E_SENTINEL;
  if (typeof sentinel !== "string" || !/^handleplan-e2e-[0-9a-f]{48}$/u.test(sentinel)) {
    throw new Error("public browser harness teardown sentinel is unavailable");
  }

  const ready = await requestHarness({ path: "/api/ready" });
  if (ready.statusCode !== 200) {
    throw new Error(`public browser harness API control returned ${ready.statusCode ?? "unknown"}`);
  }
  requireScanHeaders(ready, "passed-v1");

  const bodyLeakProbe = await requestHarness({
    headers: { "x-handleplan-e2e-leak-probe": "v1" },
    path: "/api/_handleplan-e2e/leak-probe",
  });
  requireRejectedControl(bodyLeakProbe, sentinel, "body leak control");

  const headerLeakProbe = await requestHarness({
    headers: { "x-handleplan-e2e-leak-probe": "v1" },
    path: "/api/_handleplan-e2e/leak-header-probe",
  });
  requireRejectedControl(headerLeakProbe, sentinel, "header leak control");

  const methodProbe = await requestHarness({
    headers: { "x-handleplan-e2e-method-probe": "v1" },
    method: "TRACE",
    path: "/api/_handleplan-e2e/method-probe",
  });
  requireRejectedControl(methodProbe, sentinel, "method control");

  // The server-side teardown barrier may wait up to ten seconds for an already
  // accepted response scan; the verifier's request deadline outlives it.
  const statusResponse = await requestHarness({
    headers: { "x-handleplan-e2e-control": sentinel },
    path: "/__handleplan-e2e/scan-status-v1",
  });
  if (statusResponse.statusCode !== 200) {
    throw new Error(`public browser harness status returned ${statusResponse.statusCode ?? "unknown"}`);
  }
  let status;
  try {
    status = JSON.parse(statusResponse.body.toString("utf8"));
  } catch {
    throw new Error("public browser harness status was not valid JSON");
  }

  if (
    status?.contractVersion !== 1
    || status?.inFlightRequests !== 0
    || !Number.isInteger(status?.apiResponsesScanned)
    || status.apiResponsesScanned <= 0
    || !Number.isInteger(status?.expectedLeakProbeRejections)
    || status.expectedLeakProbeRejections <= 0
    || !Number.isInteger(status?.expectedBodyLeakProbeRejections)
    || status.expectedBodyLeakProbeRejections <= 0
    || !Number.isInteger(status?.expectedHeaderLeakProbeRejections)
    || status.expectedHeaderLeakProbeRejections <= 0
    || status.expectedLeakProbeRejections
      !== status.expectedBodyLeakProbeRejections + status.expectedHeaderLeakProbeRejections
    || !Number.isInteger(status?.expectedMethodProbeRejections)
    || status.expectedMethodProbeRejections <= 0
    || !Number.isInteger(status?.requestBodiesScanned)
    || status.requestBodiesScanned <= 0
    || !Number.isInteger(status?.responseBodiesScanned)
    || status.responseBodiesScanned <= 0
    || status.apiResponsesScanned > status.responseBodiesScanned
    || status?.teardownBarrier !== true
    || !Array.isArray(status?.unexpectedScanFailures)
  ) {
    throw new Error("public browser harness did not return complete scan evidence");
  }
  if (status.unexpectedScanFailures.length > 0) {
    const redacted = JSON.stringify(status.unexpectedScanFailures).replaceAll(
      sentinel,
      "[redacted]",
    );
    throw new Error(
      `public browser harness rejected unexpected traffic: ${redacted}`,
    );
  }
}
