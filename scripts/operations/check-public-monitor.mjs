import { pathToFileURL } from "node:url";

const CONTRACT_VERSION = 1;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 500;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_SOURCE_RESPONSE_AGE_MS = 5 * 60 * 1_000;
const MAX_SOURCE_RESPONSE_FUTURE_SKEW_MS = 60 * 1_000;
const PUBLIC_SOURCE_HEALTH_MAX_AGE_MS = 26 * 60 * 60 * 1_000;
const MONITORED_ORIGIN = "https://handle.reidar.tech";

const SOURCE_KINDS = new Set([
  "catalog",
  "ordinary-price",
  "offer",
  "store",
  "geocoder",
  "routing",
  "legacy",
]);
const RUNTIME_STATES = new Set(["approved", "conditional", "blocked", "revoked"]);
const HEALTH_STATES = new Set(["healthy", "degraded", "failed", "disabled"]);
const TERMINAL_STATES = new Set(["completed", "degraded", "failed", "cancelled"]);
const SOURCE_OVERALL_STATES = new Set([
  "operational",
  "degraded",
  "unknown",
  "no-approved-sources",
]);
const PUBLIC_FAILURE_CODES = new Set([
  "CONFIG_INVALID",
  "HTTP_UNAVAILABLE",
  "LIVENESS_CONTRACT_MISMATCH",
  "MIGRATION_MISMATCH",
  "MONITOR_FAILED",
  "READINESS_CONTRACT_MISMATCH",
  "READINESS_UNAVAILABLE",
  "REQUEST_FAILED",
  "REQUEST_TIMEOUT",
  "RESPONSE_CONTRACT_MISMATCH",
  "RESPONSE_READ_FAILED",
  "RESPONSE_TOO_LARGE",
  "REVISION_MISMATCH",
  "SOURCE_CONTRACT_MISMATCH",
  "SOURCE_DEGRADED",
  "SOURCE_NOT_OPERATIONAL",
  "SOURCE_RESPONSE_STALE",
  "SOURCE_UNKNOWN",
]);

export class PublicMonitorFailure extends Error {
  constructor(code, { retryable = false } = {}) {
    super(code);
    this.name = "PublicMonitorFailure";
    this.code = code;
    this.retryable = retryable;
  }
}

function fail(code, options) {
  throw new PublicMonitorFailure(code, options);
}

function exactKeys(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function safeString(value, max = 500) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= max
    && value.trim() === value;
}

function canonicalTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return false;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateHealth(value) {
  if (!exactKeys(value, ["freshness", "lastSuccess", "recordedAt", "state"])) return false;
  if (!new Set(["current", "stale"]).has(value.freshness)) return false;
  if (!HEALTH_STATES.has(value.state) || !canonicalTimestamp(value.recordedAt)) return false;
  if (!exactKeys(value.lastSuccess, [
    "captureAt",
    "discoveryAt",
    "eligibleEvidenceAt",
    "publishAt",
  ])) return false;
  const recordedAt = Date.parse(value.recordedAt);
  return Object.values(value.lastSuccess).every((timestamp) =>
    timestamp === null
    || (canonicalTimestamp(timestamp) && Date.parse(timestamp) <= recordedAt));
}

function validateTerminalIngestion(value) {
  return exactKeys(value, ["completedAt", "scope", "startedAt", "state"])
    && value.scope === "source-wide"
    && TERMINAL_STATES.has(value.state)
    && canonicalTimestamp(value.startedAt)
    && canonicalTimestamp(value.completedAt)
    && Date.parse(value.completedAt) >= Date.parse(value.startedAt);
}

function validateScope(value) {
  return exactKeys(value, ["countryCode", "id", "kind", "label", "state"])
    && typeof value.countryCode === "string"
    && /^[A-Z]{2}$/u.test(value.countryCode)
    && typeof value.id === "string"
    && /^scope:[0-9a-f]{64}$/u.test(value.id)
    && new Set(["national", "region", "postal-set", "store-set"]).has(value.kind)
    && safeString(value.label)
    && new Set(["active", "retired"]).has(value.state);
}

function validateSource(value) {
  return exactKeys(value, ["displayName", "id", "kind", "runtimeState"])
    && safeString(value.displayName)
    && safeString(value.id, 200)
    && SOURCE_KINDS.has(value.kind)
    && RUNTIME_STATES.has(value.runtimeState);
}

function validateSourceEntry(value) {
  if (!exactKeys(value, [
    "governanceState",
    "health",
    "latestTerminalIngestion",
    "scope",
    "source",
  ])) return false;
  if (!new Set(["approved", "not-approved"]).has(value.governanceState)) return false;
  if (!validateSource(value.source)) return false;
  if (value.governanceState === "approved" && value.source.runtimeState !== "approved") return false;
  if (value.scope !== null && !validateScope(value.scope)) return false;
  if (value.health !== null && !validateHealth(value.health)) return false;
  return value.latestTerminalIngestion === null
    || validateTerminalIngestion(value.latestTerminalIngestion);
}

function entryKey(entry) {
  return `${entry.source.id}\u0000${entry.scope?.id ?? "unscoped"}`;
}

function compareEntries(left, right) {
  return compareText(left.source.displayName, right.source.displayName)
    || compareText(left.source.id, right.source.id)
    || compareText(left.scope?.id ?? "", right.scope?.id ?? "");
}

function hasNewerFailedOrDegradedIngestion(entry) {
  const ingestion = entry.latestTerminalIngestion;
  if (ingestion === null || !new Set(["failed", "degraded"]).has(ingestion.state)) return false;
  return entry.health === null
    || Date.parse(ingestion.completedAt) > Date.parse(entry.health.recordedAt);
}

function hasNewerCancelledIngestion(entry) {
  const ingestion = entry.latestTerminalIngestion;
  return ingestion?.state === "cancelled"
    && (entry.health === null
      || Date.parse(ingestion.completedAt) > Date.parse(entry.health.recordedAt));
}

function hasRecentRecordedSuccess(entry, generatedAt) {
  if (entry.health === null) return false;
  const generatedAtMs = Date.parse(generatedAt);
  return Object.values(entry.health.lastSuccess).some((timestamp) => {
    if (timestamp === null) return false;
    const successAtMs = Date.parse(timestamp);
    return successAtMs <= generatedAtMs
      && generatedAtMs - successAtMs <= PUBLIC_SOURCE_HEALTH_MAX_AGE_MS;
  });
}

function deriveSourceOverall(entries, hasMore, generatedAt) {
  const approved = entries.filter(({ governanceState }) => governanceState === "approved");
  if (
    approved.some(({ health }) => health !== null && new Set([
      "degraded",
      "failed",
      "disabled",
    ]).has(health.state))
    || approved.some(hasNewerFailedOrDegradedIngestion)
  ) return "degraded";
  if (hasMore) return "unknown";
  if (approved.length === 0) return "no-approved-sources";
  if (
    approved.some(hasNewerCancelledIngestion)
    || approved.some(({ health }) => health === null || health.freshness === "stale")
    || approved.some((entry) => !hasRecentRecordedSuccess(entry, generatedAt))
  ) return "unknown";
  return "operational";
}

export function validateHealthContract(value, expectedRevision) {
  if (!exactKeys(value, ["commit", "status", "version"])) fail("LIVENESS_CONTRACT_MISMATCH");
  if (value.status !== "ok" || value.version !== CONTRACT_VERSION) fail("LIVENESS_CONTRACT_MISMATCH");
  if (value.commit !== expectedRevision) fail("REVISION_MISMATCH");
}

export function validateReadinessContract(value, expectedMigration) {
  if (!exactKeys(value, ["database", "status", "version"])) fail("READINESS_CONTRACT_MISMATCH");
  if (value.status !== "ok" || value.version !== CONTRACT_VERSION) fail("READINESS_CONTRACT_MISMATCH");
  if (!exactKeys(value.database, ["requiredMigration", "status"])) {
    fail("READINESS_CONTRACT_MISMATCH");
  }
  if (value.database.status !== "ok") fail("READINESS_UNAVAILABLE");
  if (value.database.requiredMigration !== expectedMigration) fail("MIGRATION_MISMATCH");
}

export function validateSourceStatusContract(value, nowMs = Date.now()) {
  if (!exactKeys(value, [
    "claimBoundary",
    "completeness",
    "contractVersion",
    "entries",
    "generatedAt",
    "hasMore",
    "kind",
    "overall",
  ])) fail("SOURCE_CONTRACT_MISMATCH");
  if (
    !exactKeys(value.claimBoundary, [
      "priceCoverage",
      "publicRanking",
      "runtimeActivation",
      "stockStatus",
    ])
    || Object.values(value.claimBoundary).some((boundary) => boundary !== "not-established")
    || value.completeness !== "partial"
    || value.contractVersion !== CONTRACT_VERSION
    || value.kind !== "public-source-status"
    || typeof value.hasMore !== "boolean"
    || !SOURCE_OVERALL_STATES.has(value.overall)
    || !canonicalTimestamp(value.generatedAt)
    || !Array.isArray(value.entries)
    || value.entries.length > 50
    || !value.entries.every(validateSourceEntry)
  ) fail("SOURCE_CONTRACT_MISMATCH");

  const generatedAtMs = Date.parse(value.generatedAt);
  if (
    generatedAtMs > nowMs + MAX_SOURCE_RESPONSE_FUTURE_SKEW_MS
    || nowMs - generatedAtMs > MAX_SOURCE_RESPONSE_AGE_MS
  ) fail("SOURCE_RESPONSE_STALE");

  const keys = value.entries.map(entryKey);
  if (new Set(keys).size !== keys.length) fail("SOURCE_CONTRACT_MISMATCH");
  const sorted = [...value.entries].sort(compareEntries);
  if (value.entries.some((entry, index) => entryKey(entry) !== entryKey(sorted[index]))) {
    fail("SOURCE_CONTRACT_MISMATCH");
  }
  for (const entry of value.entries) {
    if (entry.health !== null) {
      const recordedAtMs = Date.parse(entry.health.recordedAt);
      if (recordedAtMs > generatedAtMs) fail("SOURCE_CONTRACT_MISMATCH");
      const expectedFreshness = generatedAtMs - recordedAtMs <= PUBLIC_SOURCE_HEALTH_MAX_AGE_MS
        ? "current"
        : "stale";
      if (entry.health.freshness !== expectedFreshness) fail("SOURCE_CONTRACT_MISMATCH");
    }
    if (
      entry.latestTerminalIngestion !== null
      && Date.parse(entry.latestTerminalIngestion.completedAt) > generatedAtMs
    ) fail("SOURCE_CONTRACT_MISMATCH");
  }
  if (value.overall !== deriveSourceOverall(value.entries, value.hasMore, value.generatedAt)) {
    fail("SOURCE_CONTRACT_MISMATCH");
  }
}

function parsePositiveInteger(value, fallback, maximum) {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/u.test(value)) fail("CONFIG_INVALID");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) fail("CONFIG_INVALID");
  return parsed;
}

export function readMonitorConfig(environment = process.env) {
  let baseUrl;
  try {
    baseUrl = new URL(environment.HANDLEPLAN_MONITOR_BASE_URL);
  } catch {
    fail("CONFIG_INVALID");
  }
  if (
    baseUrl.protocol !== "https:"
    || baseUrl.origin !== MONITORED_ORIGIN
    || baseUrl.username !== ""
    || baseUrl.password !== ""
    || baseUrl.pathname !== "/"
    || baseUrl.search !== ""
    || baseUrl.hash !== ""
  ) fail("CONFIG_INVALID");

  const expectedRevision = environment.HANDLEPLAN_MONITOR_EXPECTED_REVISION;
  const expectedMigration = environment.HANDLEPLAN_MONITOR_EXPECTED_MIGRATION;
  if (typeof expectedRevision !== "string" || !/^[0-9a-f]{40}$/u.test(expectedRevision)) {
    fail("CONFIG_INVALID");
  }
  if (
    typeof expectedMigration !== "string"
    || !/^\d{3}_[a-z0-9_]+\.sql$/u.test(expectedMigration)
  ) fail("CONFIG_INVALID");

  const accessClientId = environment.HANDLEPLAN_MONITOR_CF_ACCESS_CLIENT_ID;
  const accessClientSecret = environment.HANDLEPLAN_MONITOR_CF_ACCESS_CLIENT_SECRET;
  if (!safeString(accessClientId, 2_000) || !safeString(accessClientSecret, 2_000)) {
    fail("CONFIG_INVALID");
  }

  return Object.freeze({
    accessClientId,
    accessClientSecret,
    attempts: parsePositiveInteger(environment.HANDLEPLAN_MONITOR_ATTEMPTS, DEFAULT_ATTEMPTS, 5),
    baseUrl,
    expectedMigration,
    expectedRevision,
    retryDelayMs: parsePositiveInteger(
      environment.HANDLEPLAN_MONITOR_RETRY_DELAY_MS,
      DEFAULT_RETRY_DELAY_MS,
      5_000,
    ),
    timeoutMs: parsePositiveInteger(
      environment.HANDLEPLAN_MONITOR_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      15_000,
    ),
  });
}

async function cancelWithin(cancel, maximumWaitMs) {
  let cancellation;
  try {
    cancellation = Promise.resolve(cancel()).catch(() => undefined);
  } catch {
    return;
  }
  if (maximumWaitMs <= 0) {
    void cancellation;
    return;
  }
  let timeout;
  try {
    await Promise.race([
      cancellation,
      new Promise((resolve) => {
        timeout = setTimeout(resolve, Math.min(maximumWaitMs, 250));
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function rejectResponse(response, code, maximumWaitMs, options) {
  if (response.body !== null) {
    await cancelWithin(() => response.body.cancel(), maximumWaitMs);
  }
  fail(code, options);
}

async function readBoundedJson(response, remainingMs) {
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    await rejectResponse(response, "RESPONSE_CONTRACT_MISMATCH", remainingMs());
  }
  const cacheDirectives = (response.headers.get("cache-control") ?? "")
    .split(",")
    .map((directive) => directive.trim().toLowerCase());
  if (!cacheDirectives.includes("no-store")) {
    await rejectResponse(response, "RESPONSE_CONTRACT_MISMATCH", remainingMs());
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_RESPONSE_BYTES) {
      await rejectResponse(response, "RESPONSE_TOO_LARGE", remainingMs());
    }
  }
  if (response.body === null) fail("RESPONSE_CONTRACT_MISMATCH");

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await cancelWithin(() => reader.cancel(), remainingMs());
        fail("RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof PublicMonitorFailure) throw error;
    fail("RESPONSE_READ_FAILED", { retryable: true });
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("RESPONSE_CONTRACT_MISMATCH");
  }
}

async function requestJson(pathname, config, dependencies) {
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const sleep = dependencies.sleep ?? ((milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)));
  if (typeof fetchImpl !== "function") fail("CONFIG_INVALID");

  for (let attempt = 1; attempt <= config.attempts; attempt += 1) {
    const controller = new AbortController();
    const deadlineAt = Date.now() + config.timeoutMs;
    const remainingMs = () => Math.max(0, deadlineAt - Date.now());
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetchImpl(new URL(pathname, config.baseUrl), {
        cache: "no-store",
        headers: {
          accept: "application/json",
          "cf-access-client-id": config.accessClientId,
          "cf-access-client-secret": config.accessClientSecret,
        },
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status !== 200) {
        const retryable = response.status === 408
          || response.status === 429
          || response.status >= 500;
        await rejectResponse(response, "HTTP_UNAVAILABLE", remainingMs(), { retryable });
      }
      return await readBoundedJson(response, remainingMs);
    } catch (error) {
      let failure;
      if (controller.signal.aborted) {
        failure = new PublicMonitorFailure("REQUEST_TIMEOUT", { retryable: true });
      } else if (error instanceof PublicMonitorFailure) {
        failure = error;
      } else {
        failure = new PublicMonitorFailure("REQUEST_FAILED", { retryable: true });
      }
      if (!failure.retryable || attempt === config.attempts) throw failure;
      await sleep(config.retryDelayMs * attempt);
    } finally {
      clearTimeout(timeout);
    }
  }
  fail("REQUEST_FAILED");
}

export async function runPublicMonitor(config, dependencies = {}) {
  const liveness = await requestJson("/api/health", config, dependencies);
  validateHealthContract(liveness, config.expectedRevision);

  const readiness = await requestJson("/api/ready", config, dependencies);
  validateReadinessContract(readiness, config.expectedMigration);

  const sourceStatus = await requestJson("/api/source-status", config, dependencies);
  validateSourceStatusContract(sourceStatus, dependencies.nowMs?.() ?? Date.now());
  if (sourceStatus.overall === "degraded") fail("SOURCE_DEGRADED");
  if (sourceStatus.overall === "unknown") fail("SOURCE_UNKNOWN");
  if (sourceStatus.overall === "no-approved-sources") fail("SOURCE_NOT_OPERATIONAL");

  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    event: "public-monitor.completed",
    liveness: "ok",
    readiness: "ok",
    source: "operational",
  });
}

export function sanitizedFailure(error) {
  const code = error instanceof PublicMonitorFailure && PUBLIC_FAILURE_CODES.has(error.code)
    ? error.code
    : "MONITOR_FAILED";
  return Object.freeze({
    code,
    contractVersion: CONTRACT_VERSION,
    event: "public-monitor.failed",
  });
}

async function main() {
  try {
    const result = await runPublicMonitor(readMonitorConfig());
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(sanitizedFailure(error))}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
