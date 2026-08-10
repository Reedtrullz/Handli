import { isAbsolute, normalize } from "node:path";

export interface WorkerRuntimeEnv {
  cycleIntervalMs: number;
  shutdownGraceMs: number;
}

export type WorkerSourceAccessState = "approved" | "blocked" | "conditional" | "revoked";

export interface WorkerProductionEnv {
  databaseUrl: string;
  kassalApiKey?: string;
  kassalBaseUrl: string;
  leaseTtlMs: number;
  officialOfferFoundationEnabled: false;
  officialOfferPrivateCaptureRoot: string;
  requestBudgetLimit: number;
  requestBudgetMaxWaitMs: number;
  requestBudgetWindowMs: number;
  sourceAccessState: WorkerSourceAccessState;
  targetLimit: number;
}

function requireDisabledOfficialOfferFoundation(value: string | undefined): false {
  if (value !== "false") {
    throw new TypeError(
      "OFFICIAL_OFFER_FOUNDATION_ENABLED must be explicitly false until activation is approved",
    );
  }
  return false;
}

function requirePrivateCaptureRoot(value: string | undefined): string {
  if (
    value === undefined
    || value.length < 2
    || value.length > 1_024
    || value.includes("\u0000")
    || !isAbsolute(value)
    || normalize(value) !== value
  ) {
    throw new TypeError(
      "OFFICIAL_OFFER_PRIVATE_CAPTURE_ROOT must be a normalized absolute path",
    );
  }
  return value;
}

function boundedInteger(
  input: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (input === undefined) return fallback;
  if (!/^\d+$/.test(input)) {
    throw new TypeError(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function requirePostgresUrl(value: string | undefined): string {
  if (value === undefined || value.length < 1 || value.length > 2_048) {
    throw new TypeError("DATABASE_URL is required");
  }
  try {
    const url = new URL(value);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol)
      || url.username.length < 1
      || url.hostname.length < 1
      || url.pathname.length < 2
      || url.hash !== ""
    ) {
      throw new Error("invalid");
    }
  } catch {
    throw new TypeError("DATABASE_URL must be a PostgreSQL URL");
  }
  return value;
}

function requireHttpsBaseUrl(value: string | undefined): string {
  const input = value ?? "https://kassal.app/api/v1";
  try {
    const url = new URL(input);
    if (
      url.protocol !== "https:"
      || url.username !== ""
      || url.password !== ""
      || url.search !== ""
      || url.hash !== ""
    ) {
      throw new Error("invalid");
    }
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new TypeError("KASSAL_BASE_URL must be a credential-free HTTPS URL");
  }
}

function sourceAccessState(value: string | undefined): WorkerSourceAccessState {
  const state = value ?? "conditional";
  if (!["approved", "blocked", "conditional", "revoked"].includes(state)) {
    throw new TypeError("KASSAL_SOURCE_ACCESS must be an explicit source access state");
  }
  return state as WorkerSourceAccessState;
}

function optionalApiKey(value: string | undefined, access: WorkerSourceAccessState): string | undefined {
  if (value !== undefined && (value.length < 1 || value.length > 1_024 || value.trim().length < 1)) {
    throw new TypeError("KASSAL_API_KEY must contain 1-1024 nonblank characters");
  }
  if (access === "approved" && value === undefined) {
    throw new TypeError("KASSAL_API_KEY is required when KASSAL_SOURCE_ACCESS is approved");
  }
  return value;
}

export function readWorkerRuntimeEnv(
  values?: Record<string, string | undefined>,
): Readonly<WorkerRuntimeEnv> {
  const source = values ?? (
    globalThis as typeof globalThis & {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env ?? {};
  return Object.freeze({
    cycleIntervalMs: boundedInteger(
      source.WORKER_CYCLE_INTERVAL_MS,
      30_000,
      1_000,
      15 * 60 * 1_000,
      "WORKER_CYCLE_INTERVAL_MS",
    ),
    shutdownGraceMs: boundedInteger(
      source.WORKER_SHUTDOWN_GRACE_MS,
      30_000,
      1,
      120_000,
      "WORKER_SHUTDOWN_GRACE_MS",
    ),
  });
}

export function readWorkerProductionEnv(
  values?: Record<string, string | undefined>,
): Readonly<WorkerProductionEnv> {
  const source = values ?? (
    globalThis as typeof globalThis & {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env ?? {};
  const access = sourceAccessState(source.KASSAL_SOURCE_ACCESS);
  return Object.freeze({
    databaseUrl: requirePostgresUrl(source.DATABASE_URL),
    kassalApiKey: optionalApiKey(source.KASSAL_API_KEY, access),
    kassalBaseUrl: requireHttpsBaseUrl(source.KASSAL_BASE_URL),
    leaseTtlMs: boundedInteger(
      source.WORKER_LEASE_TTL_MS,
      120_000,
      30_000,
      15 * 60 * 1_000,
      "WORKER_LEASE_TTL_MS",
    ),
    officialOfferFoundationEnabled: requireDisabledOfficialOfferFoundation(
      source.OFFICIAL_OFFER_FOUNDATION_ENABLED,
    ),
    officialOfferPrivateCaptureRoot: requirePrivateCaptureRoot(
      source.OFFICIAL_OFFER_PRIVATE_CAPTURE_ROOT,
    ),
    requestBudgetLimit: boundedInteger(
      source.WORKER_REQUEST_BUDGET_LIMIT,
      60,
      1,
      10_000,
      "WORKER_REQUEST_BUDGET_LIMIT",
    ),
    requestBudgetMaxWaitMs: boundedInteger(
      source.WORKER_REQUEST_BUDGET_MAX_WAIT_MS,
      65_000,
      1,
      15 * 60 * 1_000,
      "WORKER_REQUEST_BUDGET_MAX_WAIT_MS",
    ),
    requestBudgetWindowMs: boundedInteger(
      source.WORKER_REQUEST_BUDGET_WINDOW_MS,
      60_000,
      1_000,
      24 * 60 * 60 * 1_000,
      "WORKER_REQUEST_BUDGET_WINDOW_MS",
    ),
    sourceAccessState: access,
    targetLimit: boundedInteger(
      source.WORKER_TARGET_LIMIT,
      500,
      1,
      500,
      "WORKER_TARGET_LIMIT",
    ),
  });
}
