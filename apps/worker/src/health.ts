import { createServer, type Server } from "node:http";

const MAX_COUNTER = Number.MAX_SAFE_INTEGER;
const HEALTH_HOST = "127.0.0.1";
const MIN_READY_UPTIME_SECONDS = 10;
export const WORKER_HEALTH_PORT = 3_005;

type SchedulerHealthState =
  | "starting"
  | "running"
  | "idle"
  | "stopping"
  | "stopped"
  | "failed";

type CycleOutcome = "ok" | "degraded" | "standby";

interface CycleSummary {
  completedAt: string;
  degradedJobs: number;
  durationMs: number;
  jobs: number;
  leaseAcquired: boolean;
  outcome: CycleOutcome;
  startedAt: string;
}

export interface WorkerHealthSnapshot {
  live: boolean;
  process: Readonly<{
    pid: number;
    uptimeSeconds: number;
  }>;
  ready: boolean;
  revision: string;
  scheduler: Readonly<{
    activeCycleStartedAt: string | null;
    completedCycles: number;
    cycleBoundMs: number;
    failedCycles: number;
    lastCycle: Readonly<CycleSummary> | null;
    state: SchedulerHealthState;
  }>;
  schemaVersion: 1;
  status: "ok" | "degraded" | "starting" | "unhealthy";
}

export interface WorkerHealthMonitorOptions {
  cycleIntervalMs: number;
  maxCycleDurationMs: number;
  now?: () => Date;
  pid?: number;
  revision: string;
  uptimeSeconds?: () => number;
}

interface CycleResultShape {
  leaseAcquired: boolean;
  results: readonly unknown[];
}

function requireBoundedMilliseconds(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60 * 60 * 1_000) {
    throw new TypeError(`${name} must be an integer from 1 through 3600000`);
  }
  return value;
}

function requireRevision(value: string): string {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new TypeError("APP_COMMIT_SHA must be a full lowercase commit SHA");
  }
  return value;
}

function saturatingIncrement(value: number): number {
  return value >= MAX_COUNTER ? MAX_COUNTER : value + 1;
}

function canonicalTime(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function cycleResultShape(value: unknown): CycleResultShape | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as { leaseAcquired?: unknown; results?: unknown };
  if (typeof candidate.leaseAcquired !== "boolean" || !Array.isArray(candidate.results)) {
    return undefined;
  }
  return {
    leaseAcquired: candidate.leaseAcquired,
    results: candidate.results,
  };
}

function resultIsDegraded(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  return (value as { status?: unknown }).status !== "succeeded";
}

export class WorkerHealthMonitor {
  private activeCycleOperational = false;
  private activeCycleStartedMs: number | undefined;
  private completedCyclesValue = 0;
  private failedCyclesValue = 0;
  private lastCycleValue: Readonly<CycleSummary> | undefined;
  private readonly now: () => Date;
  private readonly pid: number;
  private readonly revision: string;
  private state: SchedulerHealthState = "starting";
  private readonly uptimeSeconds: () => number;

  readonly cycleIntervalMs: number;
  readonly maxCycleDurationMs: number;

  constructor(options: WorkerHealthMonitorOptions) {
    this.cycleIntervalMs = requireBoundedMilliseconds(
      options.cycleIntervalMs,
      "cycleIntervalMs",
    );
    this.maxCycleDurationMs = requireBoundedMilliseconds(
      options.maxCycleDurationMs,
      "maxCycleDurationMs",
    );
    this.revision = requireRevision(options.revision);
    this.now = options.now ?? (() => new Date());
    this.uptimeSeconds = options.uptimeSeconds ?? (() => process.uptime());
    this.pid = options.pid ?? process.pid;
    if (!Number.isSafeInteger(this.pid) || this.pid < 1) {
      throw new TypeError("pid must be a positive safe integer");
    }
  }

  schedulerStarted(): void {
    if (this.state === "starting") return;
    if (this.state === "stopped" || this.state === "failed") return;
    this.state = "starting";
  }

  cycleStarted(): void {
    if (this.state === "stopping" || this.state === "stopped" || this.state === "failed") {
      return;
    }
    this.activeCycleStartedMs = this.nowMilliseconds();
    this.activeCycleOperational = false;
    this.state = "running";
  }

  cycleOperational(): void {
    if (this.state === "running" && this.activeCycleStartedMs !== undefined) {
      this.activeCycleOperational = true;
    }
  }

  cycleCompleted(result: unknown): void {
    const completedAtMs = this.nowMilliseconds();
    const startedAtMs = this.activeCycleStartedMs;
    const parsed = cycleResultShape(result);
    this.activeCycleStartedMs = undefined;
    this.activeCycleOperational = false;
    if (startedAtMs === undefined || parsed === undefined) {
      this.failedCyclesValue = saturatingIncrement(this.failedCyclesValue);
      this.state = "failed";
      return;
    }

    const durationMs = Math.max(0, completedAtMs - startedAtMs);
    const inspectedResults = parsed.results.slice(0, 100);
    const degradedJobs = inspectedResults.filter(resultIsDegraded).length;
    const outcome: CycleOutcome = !parsed.leaseAcquired
      ? "standby"
      : degradedJobs > 0 || parsed.results.length > inspectedResults.length
        ? "degraded"
        : "ok";
    this.completedCyclesValue = saturatingIncrement(this.completedCyclesValue);
    this.lastCycleValue = Object.freeze({
      completedAt: canonicalTime(completedAtMs),
      degradedJobs,
      durationMs: Math.min(durationMs, this.maxCycleDurationMs + 1),
      jobs: inspectedResults.length,
      leaseAcquired: parsed.leaseAcquired,
      outcome,
      startedAt: canonicalTime(startedAtMs),
    });
    this.state = "idle";
  }

  cycleFailed(): void {
    this.activeCycleStartedMs = undefined;
    this.activeCycleOperational = false;
    this.failedCyclesValue = saturatingIncrement(this.failedCyclesValue);
    this.state = "failed";
  }

  schedulerStopping(): void {
    if (this.state !== "failed" && this.state !== "stopped") this.state = "stopping";
  }

  schedulerStopped(exitCode: 0 | 1): void {
    this.activeCycleStartedMs = undefined;
    this.activeCycleOperational = false;
    this.state = exitCode === 0 ? "stopped" : "failed";
  }

  snapshot(): Readonly<WorkerHealthSnapshot> {
    const nowMs = this.nowMilliseconds();
    const activeDuration = this.activeCycleStartedMs === undefined
      ? undefined
      : Math.max(0, nowMs - this.activeCycleStartedMs);
    const lastCycleAge = this.lastCycleValue === undefined
      ? undefined
      : Math.max(0, nowMs - Date.parse(this.lastCycleValue.completedAt));
    const cycleWithinBound = activeDuration === undefined
      || activeDuration <= this.maxCycleDurationMs;
    const schedulerFresh = this.state === "running"
      ? this.activeCycleOperational && cycleWithinBound
      : this.state === "idle"
        && lastCycleAge !== undefined
        && lastCycleAge <= this.cycleIntervalMs + 30_000;
    const completedCycleWithinBound = this.lastCycleValue === undefined
      || this.lastCycleValue.durationMs <= this.maxCycleDurationMs;
    const uptime = this.uptimeSeconds();
    const boundedUptime = Number.isFinite(uptime)
      ? Math.min(MAX_COUNTER, Math.max(0, Math.floor(uptime)))
      : 0;
    const processStable = boundedUptime >= MIN_READY_UPTIME_SECONDS;
    const ready = processStable && schedulerFresh && completedCycleWithinBound;
    const live = this.state !== "failed" && this.state !== "stopped";
    const schedulerStarting = this.state === "starting"
      || (this.state === "running" && !this.activeCycleOperational);
    const status: WorkerHealthSnapshot["status"] = !ready
      ? schedulerStarting || !processStable
        ? "starting"
        : "unhealthy"
      : this.lastCycleValue?.outcome === "degraded"
        ? "degraded"
        : "ok";
    return Object.freeze({
      live,
      process: Object.freeze({
        pid: this.pid,
        uptimeSeconds: boundedUptime,
      }),
      ready,
      revision: this.revision,
      scheduler: Object.freeze({
        activeCycleStartedAt: this.activeCycleStartedMs === undefined
          ? null
          : canonicalTime(this.activeCycleStartedMs),
        completedCycles: this.completedCyclesValue,
        cycleBoundMs: this.maxCycleDurationMs,
        failedCycles: this.failedCyclesValue,
        lastCycle: this.lastCycleValue ?? null,
        state: this.state,
      }),
      schemaVersion: 1,
      status,
    });
  }

  private nowMilliseconds(): number {
    const milliseconds = this.now().getTime();
    if (!Number.isFinite(milliseconds)) throw new Error("Worker health clock is invalid");
    return milliseconds;
  }
}

export interface WorkerHealthServer {
  close(): Promise<void>;
  readonly host: typeof HEALTH_HOST;
  readonly port: number;
}

export interface WorkerHealthHttpResponse {
  readonly body: string;
  readonly headers: Readonly<Record<string, string | number>>;
  readonly statusCode: 200 | 404 | 405 | 503;
}

export function workerHealthHttpResponse(
  monitor: WorkerHealthMonitor,
  method: string | undefined,
  url: string | undefined,
): WorkerHealthHttpResponse {
  if (method !== "GET") {
    return Object.freeze({
      body: "",
      headers: Object.freeze({ Allow: "GET", "Cache-Control": "no-store" }),
      statusCode: 405,
    });
  }
  if (url !== "/health") {
    return Object.freeze({
      body: "",
      headers: Object.freeze({ "Cache-Control": "no-store" }),
      statusCode: 404,
    });
  }
  const snapshot = monitor.snapshot();
  const body = JSON.stringify(snapshot);
  return Object.freeze({
    body,
    headers: Object.freeze({
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(body),
      "Content-Type": "application/json; charset=utf-8",
    }),
    statusCode: snapshot.ready ? 200 : 503,
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

export async function startWorkerHealthServer(
  monitor: WorkerHealthMonitor,
  port = WORKER_HEALTH_PORT,
): Promise<WorkerHealthServer> {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("Worker health port must be an integer from 0 through 65535");
  }
  const server = createServer((request, response) => {
    request.setTimeout(1_000, () => request.destroy());
    const healthResponse = workerHealthHttpResponse(monitor, request.method, request.url);
    response.writeHead(healthResponse.statusCode, healthResponse.headers);
    response.end(healthResponse.body);
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.requestTimeout = 2_000;
  server.headersTimeout = 2_000;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, HEALTH_HOST);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("Worker health server did not bind a TCP port");
  }

  return Object.freeze({
    close: async () => closeServer(server),
    host: HEALTH_HOST,
    port: address.port,
  });
}
