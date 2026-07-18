import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";

const hostname = "127.0.0.1";
const publicPort = 3121;
const controlPort = 3122;
const controlHeader = "x-handleplan-image-e2e-control";
const responseScanHeader = "x-handleplan-image-e2e-response-scan";
const leakProbeHeader = "x-handleplan-image-e2e-leak-probe";
const exactRejectionBody = Buffer.from(JSON.stringify({
  error: "exact production image evidence rejected traffic",
}));

function requestBounded({
  headers = {},
  method = "GET",
  path,
  port,
  secure = false,
}) {
  return new Promise((resolve, reject) => {
    const request = (secure ? requestHttps : requestHttp)({
      headers,
      host: hostname,
      method,
      path,
      port,
      ...(secure ? { rejectUnauthorized: false } : {}),
    }, (response) => {
      const chunks = [];
      let length = 0;
      response.on("data", (chunk) => {
        length += chunk.length;
        if (length > 64 * 1024) {
          response.destroy(new Error("exact-image teardown response exceeded its bound"));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.once("error", reject);
      response.once("end", () => resolve({
        body: Buffer.concat(chunks),
        headers: response.headers,
        statusCode: response.statusCode,
      }));
    });
    request.setTimeout(15_000, () => {
      request.destroy(new Error("exact-image teardown request timed out"));
    });
    request.once("error", reject);
    request.end();
  });
}

function containsForbidden(response, forbiddenValues) {
  const headers = Buffer.from(JSON.stringify(response.headers));
  return forbiddenValues.some((value) => {
    const bytes = Buffer.from(value);
    return response.body.includes(bytes) || headers.includes(bytes);
  });
}

function requireSafeLeakRejection(response, forbiddenValues, label) {
  if (
    response.statusCode !== 502
    || response.headers[responseScanHeader] !== "rejected-v1"
    || !response.body.equals(exactRejectionBody)
    || containsForbidden(response, forbiddenValues)
  ) {
    throw new Error(`exact-image ${label} positive control did not fail closed`);
  }
}

export default async function verifyProductionImageHarness() {
  const controlToken = process.env.HANDLEPLAN_IMAGE_E2E_CONTROL_TOKEN ?? "";
  const responseCanary = process.env.HANDLEPLAN_IMAGE_E2E_RESPONSE_CANARY ?? "";
  if (
    !/^handleplan-image-control-[0-9a-f]{48}$/u.test(controlToken)
    || !/^handleplan-image-canary-[0-9a-f]{48}$/u.test(responseCanary)
  ) {
    throw new Error("exact-image teardown capabilities are unavailable");
  }
  const forbiddenValues = [
    "DATABASE_URL",
    controlToken,
    responseCanary,
  ];
  const controlHeaders = {
    [controlHeader]: controlToken,
    "content-length": "0",
  };

  const reset = await requestBounded({
    headers: controlHeaders,
    method: "POST",
    path: "/reset",
    port: controlPort,
  });
  if (reset.statusCode !== 204 || reset.body.length !== 0) {
    throw new Error("exact-image teardown could not restore the application network");
  }

  const readiness = await requestBounded({
    path: "/api/ready",
    port: publicPort,
    secure: true,
  });
  if (
    readiness.statusCode !== 200
    || readiness.headers[responseScanHeader] !== "passed-v1"
    || containsForbidden(readiness, forbiddenValues)
  ) {
    throw new Error("exact-image teardown readiness was not response-scanned");
  }

  const probeHeaders = { [leakProbeHeader]: "v1" };
  const headerLeak = await requestBounded({
    headers: probeHeaders,
    path: "/__handleplan-image-e2e/leak-header-v1",
    port: publicPort,
    secure: true,
  });
  requireSafeLeakRejection(headerLeak, forbiddenValues, "header leak");
  const bodyLeak = await requestBounded({
    headers: probeHeaders,
    path: "/__handleplan-image-e2e/leak-body-v1",
    port: publicPort,
    secure: true,
  });
  requireSafeLeakRejection(bodyLeak, forbiddenValues, "body leak");

  const statusResponse = await requestBounded({
    headers: { [controlHeader]: controlToken },
    path: "/status",
    port: controlPort,
  });
  if (statusResponse.statusCode !== 200 || containsForbidden(statusResponse, forbiddenValues)) {
    throw new Error("exact-image teardown status was unavailable or unsafe");
  }
  let status;
  try {
    status = JSON.parse(statusResponse.body.toString("utf8"));
  } catch {
    throw new Error("exact-image teardown status was not valid JSON");
  }
  if (
    status?.contractVersion !== 1
    || status?.databaseCredentialCanaryCount !== 8
    || status?.databaseRoleCount !== 4
    || !Number.isInteger(status?.forbiddenValueCount)
    || status.forbiddenValueCount < 15
    || status?.networkOffline !== false
    || status?.transitionActive !== false
    || status?.inFlightRequests !== 0
    || status?.teardownBarrier !== true
    || !Number.isInteger(status?.responseBodiesScanned)
    || status.responseBodiesScanned <= 0
    || !Number.isInteger(status?.expectedHeaderLeakProbeRejections)
    || status.expectedHeaderLeakProbeRejections <= 0
    || !Number.isInteger(status?.expectedBodyLeakProbeRejections)
    || status.expectedBodyLeakProbeRejections <= 0
    || status.expectedLeakProbeRejections
      !== status.expectedHeaderLeakProbeRejections + status.expectedBodyLeakProbeRejections
    || !Array.isArray(status?.unexpectedScanFailures)
  ) {
    throw new Error("exact-image teardown returned incomplete scan evidence");
  }
  if (status.unexpectedScanFailures.length > 0) {
    throw new Error(
      `exact-image harness rejected ${status.unexpectedScanFailures.length} unexpected responses`,
    );
  }
}
