import {
  WORKER_CONTRACT_VERSION,
  type WorkerJobKind,
  type WorkerJobRequest,
  workerJobRequestSchema,
} from "./contracts";

const MAX_INTERVAL_MS = 365 * 24 * 60 * 60 * 1_000;
const MAX_JOB_ID_LENGTH = 200;
const FNV_64_OFFSET = 0xcbf29ce484222325n;
const FNV_64_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

export interface WorkerScheduleDefinition {
  readonly anchorAt: string;
  readonly intervalMs: number;
  readonly kind: WorkerJobKind;
  readonly sourceId: string;
  readonly timeoutMs: number;
}

function canonicalMilliseconds(input: string, name: string): number {
  const value = new Date(input);
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds) || value.toISOString() !== input) {
    throw new TypeError(`${name} must be a canonical UTC timestamp`);
  }
  return milliseconds;
}

function validateSchedule(schedule: WorkerScheduleDefinition): number {
  if (
    !Number.isSafeInteger(schedule.intervalMs) ||
    schedule.intervalMs < 1 ||
    schedule.intervalMs > MAX_INTERVAL_MS
  ) {
    throw new TypeError(`intervalMs must be an integer from 1 through ${MAX_INTERVAL_MS}`);
  }
  return canonicalMilliseconds(schedule.anchorAt, "anchorAt");
}

function stableHash(input: string): string {
  let hash = FNV_64_OFFSET;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = (hash * FNV_64_PRIME) & UINT64_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

function stableJobId(sourceId: string, kind: WorkerJobKind, requestedAt: string): string {
  const fullId = `${sourceId}:${kind}:${requestedAt}`;
  if (fullId.length <= MAX_JOB_ID_LENGTH) return fullId;

  const suffix = `~${stableHash(fullId)}:${kind}:${requestedAt}`;
  return `${sourceId.slice(0, MAX_JOB_ID_LENGTH - suffix.length)}${suffix}`;
}

export function newestMissedWorkerJob(
  schedule: WorkerScheduleDefinition,
  lastScheduledAt: string | undefined,
  now: Date,
): WorkerJobRequest | undefined {
  const anchorMs = validateSchedule(schedule);
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new TypeError("now must be a valid date");
  if (nowMs < anchorMs) return undefined;

  const deltaMs = nowMs - anchorMs;
  if (!Number.isSafeInteger(deltaMs)) {
    throw new TypeError("difference between now and anchorAt must be safely representable");
  }
  const slotIndex = Math.floor(deltaMs / schedule.intervalMs);
  const slotMs = anchorMs + slotIndex * schedule.intervalMs;
  if (!Number.isSafeInteger(slotMs)) throw new TypeError("scheduled slot is outside the safe range");
  const requestedAt = new Date(slotMs).toISOString();
  if (
    lastScheduledAt !== undefined &&
    canonicalMilliseconds(lastScheduledAt, "lastScheduledAt") >= slotMs
  ) {
    return undefined;
  }

  const sourceId = schedule.sourceId.trim();

  return workerJobRequestSchema.parse({
    contractVersion: WORKER_CONTRACT_VERSION,
    jobId: stableJobId(sourceId, schedule.kind, requestedAt),
    kind: schedule.kind,
    requestedAt,
    sourceId,
    timeoutMs: schedule.timeoutMs,
  });
}
