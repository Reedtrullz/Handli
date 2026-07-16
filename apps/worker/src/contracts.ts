import { z } from "zod";

export const WORKER_CONTRACT_VERSION = 1 as const;
export const WORKER_JOB_KINDS = [
  "catalog-refresh",
  "benchmark-price-refresh",
  "physical-store-sync",
  "historical-observation-collection",
] as const;

export type WorkerJobKind = (typeof WORKER_JOB_KINDS)[number];

const identifierSchema = z.string().trim().min(1).max(200);
const canonicalTimestampSchema = z.iso.datetime({ offset: false, precision: 3 });
const counterSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const workerJobRequestSchema = z.object({
  contractVersion: z.literal(WORKER_CONTRACT_VERSION),
  jobId: identifierSchema,
  kind: z.enum(WORKER_JOB_KINDS),
  requestedAt: canonicalTimestampSchema,
  sourceId: identifierSchema,
  timeoutMs: z.number().int().min(1).max(15 * 60 * 1_000),
}).strict();

export type WorkerJobRequest = z.infer<typeof workerJobRequestSchema>;

export const workerRunCountersSchema = z.object({
  fetched: counterSchema,
  accepted: counterSchema,
  quarantined: counterSchema,
  unknown: counterSchema,
  persisted: counterSchema,
  failed: counterSchema,
}).strict();

export type WorkerRunCounters = z.infer<typeof workerRunCountersSchema>;

export const ZERO_WORKER_RUN_COUNTERS: Readonly<WorkerRunCounters> = Object.freeze({
  fetched: 0,
  accepted: 0,
  quarantined: 0,
  unknown: 0,
  persisted: 0,
  failed: 0,
});

export const workerRunResultSchema = z.object({
  contractVersion: z.literal(WORKER_CONTRACT_VERSION),
  runId: identifierSchema,
  jobId: identifierSchema,
  kind: z.enum(WORKER_JOB_KINDS),
  sourceId: identifierSchema,
  status: z.enum(["succeeded", "partial", "cancelled", "timed-out", "failed"]),
  startedAt: canonicalTimestampSchema,
  completedAt: canonicalTimestampSchema,
  counters: workerRunCountersSchema,
}).strict().superRefine(({ counters, startedAt, completedAt, status }, issue) => {
  if (Date.parse(completedAt) < Date.parse(startedAt)) {
    issue.addIssue({
      code: "custom",
      message: "A worker run cannot complete before it starts",
      path: ["completedAt"],
    });
  }
  if (counters.fetched !== counters.accepted + counters.quarantined + counters.unknown) {
    issue.addIssue({
      code: "custom",
      message: "Fetched records must equal accepted, quarantined, and unknown records",
      path: ["counters", "fetched"],
    });
  }
  if (counters.persisted !== counters.fetched) {
    issue.addIssue({
      code: "custom",
      message: "Every fetched outcome must be persisted for audit",
      path: ["counters", "persisted"],
    });
  }
  if (status === "succeeded" && counters.failed !== 0) {
    issue.addIssue({ code: "custom", message: "Succeeded runs cannot contain failures", path: ["status"] });
  }
  if (status === "partial" && (counters.failed === 0 || counters.fetched === 0)) {
    issue.addIssue({ code: "custom", message: "Partial runs require progress and failures", path: ["status"] });
  }
  if (status === "failed" && (counters.failed === 0 || counters.fetched !== 0)) {
    issue.addIssue({ code: "custom", message: "Failed runs require failures and no fetched progress", path: ["status"] });
  }
});

export type WorkerRunResult = z.infer<typeof workerRunResultSchema>;

export interface SourceJobPage<T> {
  records: readonly T[];
  nextCursor?: string;
}

export interface SourceNeutralIngestionGateway<TCatalog = unknown, TPrice = unknown, TStore = unknown> {
  listCatalog(cursor: string | undefined, signal: AbortSignal): Promise<SourceJobPage<TCatalog>>;
  getBenchmarkPrices(signal: AbortSignal): Promise<readonly TPrice[]>;
  listPhysicalStores(cursor: string | undefined, signal: AbortSignal): Promise<SourceJobPage<TStore>>;
  collectHistoricalObservations(signal: AbortSignal): Promise<readonly TPrice[]>;
}
