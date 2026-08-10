import { z } from "zod";

export const OPERATIONS_CONTRACT_VERSION = 1 as const;
export const MAX_OPERATIONAL_SOURCES = 100;
export const MAX_OPERATIONAL_COUNT = 10_000;
export const OPERATIONS_REVIEW_AGE_TARGET_SECONDS = 24 * 60 * 60;
export const OPERATIONS_FRESHNESS_TARGET_SECONDS = 72 * 60 * 60;
export const OPERATIONS_WORKER_LAG_TARGET_SECONDS = 6 * 60 * 60;
export const MAX_OPERATIONAL_ALERT_TRANSITIONS = 8 + MAX_OPERATIONAL_SOURCES * 6;
export const MAX_OPERATIONAL_ALERT_EXPORT_EVENTS = 100;

export const OPERATIONAL_EVIDENCE_SIGNAL_KINDS = [
  "official-offer",
  "ordinary-price",
] as const;
export const OPERATIONAL_WORKER_JOB_KINDS = [
  "benchmark-price-refresh",
  "catalog-refresh",
  "historical-observation-collection",
  "official-offer-discovery",
  "official-offer-fetch",
  "official-offer-ingestion",
  "official-offer-lifecycle-reconcile",
  "physical-store-sync",
] as const;

const sourceIdSchema = z.string().trim().min(1).max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/u);
const timestampSchema = z.iso.datetime({ offset: true });
const optionalTimestampSchema = timestampSchema.nullable();
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
export const operationalEvidenceSignalKindSchema = z.enum(OPERATIONAL_EVIDENCE_SIGNAL_KINDS);
export const operationalWorkerJobKindSchema = z.enum(OPERATIONAL_WORKER_JOB_KINDS);

export type OperationalEvidenceSignalKind = z.infer<typeof operationalEvidenceSignalKindSchema>;
export type OperationalWorkerJobKind = z.infer<typeof operationalWorkerJobKindSchema>;

function compareOperationalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export const boundedOperationalCountSchema = z.object({
  capped: z.boolean(),
  value: z.number().int().min(0).max(MAX_OPERATIONAL_COUNT),
}).strict().superRefine((count, context) => {
  if (count.capped && count.value !== MAX_OPERATIONAL_COUNT) {
    context.addIssue({
      code: "custom",
      message: "A capped operational count must equal the public bound",
    });
  }
});

export type BoundedOperationalCount = z.infer<typeof boundedOperationalCountSchema>;

const sourceHealthSchema = z.object({
  lastCaptureSuccessAt: optionalTimestampSchema,
  lastDiscoverySuccessAt: optionalTimestampSchema,
  lastEligibleEvidenceAt: optionalTimestampSchema,
  lastPublishSuccessAt: optionalTimestampSchema,
  persistedAt: timestampSchema,
  recordedAt: timestampSchema,
  state: z.enum(["healthy", "degraded", "failed", "disabled"]),
  workerJobKind: operationalWorkerJobKindSchema,
}).strict();

const latestExtractionSchema = z.object({
  candidateCount: boundedOperationalCountSchema,
  completedAt: timestampSchema,
  emptyResult: z.enum(["not-empty", "confirmed-empty", "unexpected-empty"]),
  eligiblePublishedOfferCount: boundedOperationalCountSchema,
  state: z.enum(["completed", "degraded", "failed"]),
}).strict().superRefine((extraction, context) => {
  const isEmpty = extraction.candidateCount.value === 0 && !extraction.candidateCount.capped;
  if (extraction.emptyResult !== "not-empty" && !isEmpty) {
    context.addIssue({ code: "custom", message: "Extraction empty-result evidence contradicts its count" });
  }
  if (extraction.emptyResult !== "not-empty" && extraction.eligiblePublishedOfferCount.value > 0) {
    context.addIssue({ code: "custom", message: "An empty extraction cannot have published output" });
  }
  if (
    (extraction.emptyResult === "confirmed-empty" && extraction.state !== "completed")
    || (extraction.emptyResult === "unexpected-empty" && extraction.state !== "degraded")
    || (extraction.state === "failed" && extraction.emptyResult !== "not-empty")
  ) {
    context.addIssue({ code: "custom", message: "Extraction state contradicts its empty-result classification" });
  }
});

const freshnessSchema = z.enum(["fresh", "stale", "unknown"]);
const lagSchema = z.enum(["within-target", "late", "unknown"]);

const evidenceSignalSchema = z.object({
  freshness: freshnessSchema,
  newestEligibleAt: optionalTimestampSchema,
}).strict();

const workerJobEvidenceSchema = z.object({
  completedAt: optionalTimestampSchema,
  lag: lagSchema,
  state: z.enum(["completed", "degraded", "failed", "cancelled", "unknown"]),
  terminalizedAt: optionalTimestampSchema,
}).strict().superRefine((job, context) => {
  const isUnknown = job.state === "unknown";
  if (
    isUnknown !== (job.completedAt === null)
    || isUnknown !== (job.terminalizedAt === null)
    || (isUnknown && job.lag !== "unknown")
    || (!isUnknown && job.completedAt !== null && job.terminalizedAt !== null
      && Date.parse(job.completedAt) > Date.parse(job.terminalizedAt))
  ) {
    context.addIssue({ code: "custom", message: "Worker job evidence is internally inconsistent" });
  }
});

export const sourceOperationalMetricsV1Schema = z.object({
  counts24h: z.object({
    failedIngestions: boundedOperationalCountSchema,
    ingestions: boundedOperationalCountSchema,
    rejectedReviews: boundedOperationalCountSchema,
    reviewDecisions: boundedOperationalCountSchema,
  }).strict(),
  derived: z.object({
    ordinaryPriceFreshness: freshnessSchema,
    rejectionRate: z.enum(["none", "low", "high", "unknown"]),
    silentZeroPublication: z.enum(["clear", "confirmed-empty", "detected", "unknown"]),
    sourceFreshness: freshnessSchema,
    workerLag: lagSchema,
  }).strict(),
  evidenceSignals: z.object({
    "official-offer": evidenceSignalSchema,
    "ordinary-price": evidenceSignalSchema,
  }).strict(),
  governanceState: z.enum([
    "approved-current",
    "approval-incomplete",
    "blocked",
    "conditional",
    "contradictory",
    "expired",
    "revoked",
  ]),
  health: sourceHealthSchema.nullable(),
  latestExtraction: latestExtractionSchema.nullable(),
  offers: z.object({
    active: boundedOperationalCountSchema,
    expiredButPublished: boundedOperationalCountSchema,
    expiringWithin48h: boundedOperationalCountSchema,
  }).strict(),
  reviewQueue: z.object({
    count: boundedOperationalCountSchema,
    oldestAgeSeconds: z.number().int().nonnegative().nullable(),
  }).strict(),
  sourceId: sourceIdSchema,
  workerJobs: z.object({
    "benchmark-price-refresh": workerJobEvidenceSchema,
    "catalog-refresh": workerJobEvidenceSchema,
    "historical-observation-collection": workerJobEvidenceSchema,
    "official-offer-discovery": workerJobEvidenceSchema,
    "official-offer-fetch": workerJobEvidenceSchema,
    "official-offer-ingestion": workerJobEvidenceSchema,
    "official-offer-lifecycle-reconcile": workerJobEvidenceSchema,
    "physical-store-sync": workerJobEvidenceSchema,
  }).strict(),
}).strict();

const operationsSourceRosterEntryV1Schema = z.object({
  requiredEvidenceSignals: z.array(operationalEvidenceSignalKindSchema).min(1)
    .max(OPERATIONAL_EVIDENCE_SIGNAL_KINDS.length),
  requiredWorkerJobKinds: z.array(operationalWorkerJobKindSchema).min(1)
    .max(OPERATIONAL_WORKER_JOB_KINDS.length),
  sourceId: sourceIdSchema,
}).strict().superRefine((entry, context) => {
  for (const [path, values] of [
    ["requiredEvidenceSignals", entry.requiredEvidenceSignals],
    ["requiredWorkerJobKinds", entry.requiredWorkerJobKinds],
  ] as const) {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: "custom", message: "Roster requirements must be unique", path: [path] });
    }
    if (values.join("\u0000") !== [...values].sort(compareOperationalText).join("\u0000")) {
      context.addIssue({ code: "custom", message: "Roster requirements must be canonically sorted", path: [path] });
    }
  }
});

export const operationsSourceRosterV1Schema = z.object({
  contentSha256: sha256Schema,
  entries: z.array(operationsSourceRosterEntryV1Schema).min(1).max(MAX_OPERATIONAL_SOURCES),
  version: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9._:-]*$/u),
}).strict().superRefine((roster, context) => {
  const identifiers = roster.entries.map(({ sourceId }) => sourceId);
  if (new Set(identifiers).size !== identifiers.length) {
    context.addIssue({ code: "custom", message: "Expected source identifiers must be unique" });
  }
  if (identifiers.join("\u0000") !== [...identifiers].sort(compareOperationalText).join("\u0000")) {
    context.addIssue({ code: "custom", message: "Roster entries must be canonically sorted" });
  }
});

export type OperationsSourceRosterV1 = z.infer<typeof operationsSourceRosterV1Schema>;

export const OPERATIONS_RUNTIME_WORKER_JOB_KINDS = [
  "benchmark-price-refresh",
  "catalog-refresh",
  "historical-observation-collection",
  "official-offer-discovery",
  "official-offer-fetch",
  "official-offer-ingestion",
  "official-offer-lifecycle-reconcile",
  "physical-store-sync",
] as const;

export const operationsRuntimeWorkerJobKindSchema = z.enum(
  OPERATIONS_RUNTIME_WORKER_JOB_KINDS,
);

const operationsRuntimeWorkerResultV1Schema = z.object({
  completedAt: timestampSchema,
  jobKind: operationsRuntimeWorkerJobKindSchema,
  persistedAt: timestampSchema,
  status: z.enum(["cancelled", "failed", "partial", "succeeded", "timed-out"]),
}).strict().refine(
  ({ completedAt, persistedAt }) => Date.parse(completedAt) <= Date.parse(persistedAt),
  { message: "A worker completion cannot postdate its database persistence clock" },
);

const operationsRuntimeHealthV1Schema = z.object({
  lastCaptureSuccessAt: optionalTimestampSchema,
  lastDiscoverySuccessAt: optionalTimestampSchema,
  lastEligibleEvidenceAt: optionalTimestampSchema,
  lastPublishSuccessAt: optionalTimestampSchema,
  persistedAt: timestampSchema,
  recordedAt: timestampSchema,
  state: z.enum(["degraded", "disabled", "failed", "healthy"]),
  workerJobKind: operationsRuntimeWorkerJobKindSchema,
}).strict().superRefine((health, context) => {
  const persistedAt = Date.parse(health.persistedAt);
  if (Date.parse(health.recordedAt) > persistedAt) {
    context.addIssue({ code: "custom", message: "Health evidence cannot postdate persistence" });
  }
  for (const value of [
    health.lastCaptureSuccessAt,
    health.lastDiscoverySuccessAt,
    health.lastEligibleEvidenceAt,
    health.lastPublishSuccessAt,
  ]) {
    if (value !== null && Date.parse(value) > Date.parse(health.recordedAt)) {
      context.addIssue({ code: "custom", message: "Health success cannot postdate its snapshot" });
    }
  }
});

const operationsRuntimeExtractionV1Schema = z.object({
  candidateRows: boundedOperationalCountSchema,
  completedAt: timestampSchema,
  emptyResult: z.enum(["confirmed-empty", "not-empty", "unexpected-empty"]),
  state: z.enum(["completed", "degraded", "failed"]),
}).strict().superRefine((extraction, context) => {
  const isEmpty = extraction.candidateRows.value === 0 && !extraction.candidateRows.capped;
  if (extraction.emptyResult !== "not-empty" && !isEmpty) {
    context.addIssue({ code: "custom", message: "Extraction empty-result evidence contradicts its count" });
  }
  if (
    (extraction.emptyResult === "confirmed-empty" && extraction.state !== "completed")
    || (extraction.emptyResult === "unexpected-empty" && extraction.state !== "degraded")
    || (extraction.state === "failed" && extraction.emptyResult !== "not-empty")
  ) {
    context.addIssue({ code: "custom", message: "Extraction state contradicts its empty-result classification" });
  }
});

export const operationsRuntimeSourceV1Schema = z.object({
  administrativeRows: z.object({
    activePublishedOffers: boundedOperationalCountSchema,
    expiredPublishedOffers: boundedOperationalCountSchema,
    expiringPublishedOffers: boundedOperationalCountSchema,
    pendingReviewCandidates: boundedOperationalCountSchema,
  }).strict(),
  governanceState: z.enum([
    "approved-current",
    "approval-incomplete",
    "blocked",
    "conditional",
    "contradictory",
    "expired",
    "revoked",
  ]),
  health: operationsRuntimeHealthV1Schema.nullable(),
  latestExtraction: operationsRuntimeExtractionV1Schema.nullable(),
  latestWorkerResults: z.array(operationsRuntimeWorkerResultV1Schema)
    .max(OPERATIONS_RUNTIME_WORKER_JOB_KINDS.length),
  newestOrdinaryPriceAt: optionalTimestampSchema,
  sourceId: sourceIdSchema,
  workerResults24h: z.object({
    nonSuccessful: boundedOperationalCountSchema,
    total: boundedOperationalCountSchema,
  }).strict(),
}).strict().superRefine((source, context) => {
  if (
    source.workerResults24h.nonSuccessful.value > source.workerResults24h.total.value
    || (!source.workerResults24h.total.capped && source.workerResults24h.nonSuccessful.capped)
  ) {
    context.addIssue({ code: "custom", message: "Non-successful worker results exceed total" });
  }
  if (
    source.administrativeRows.expiringPublishedOffers.value
      > source.administrativeRows.activePublishedOffers.value
    || (
      !source.administrativeRows.activePublishedOffers.capped
      && source.administrativeRows.expiringPublishedOffers.capped
    )
  ) {
    context.addIssue({ code: "custom", message: "Expiring offers exceed active offers" });
  }
  const kinds = source.latestWorkerResults.map(({ jobKind }) => jobKind);
  if (new Set(kinds).size !== kinds.length) {
    context.addIssue({ code: "custom", message: "Latest worker job kinds must be unique" });
  }
  if (kinds.join("\u0000") !== [...kinds].sort(compareOperationalText).join("\u0000")) {
    context.addIssue({ code: "custom", message: "Latest worker results must be canonically sorted" });
  }
});

export const operationsRuntimeSnapshotV1Schema = z.object({
  claimBoundary: z.object({
    alertDelivery: z.literal("disabled"),
    historicalReconstruction: z.literal("not-established"),
    publicAvailability: z.literal("not-established"),
    publicOfferEligibility: z.literal("not-established"),
  }).strict(),
  completeness: z.literal("bounded-aggregate"),
  contractVersion: z.literal(OPERATIONS_CONTRACT_VERSION),
  kind: z.literal("internal-operations-snapshot"),
  observedAt: timestampSchema,
  sourceRoster: operationsSourceRosterV1Schema,
  sources: z.array(operationsRuntimeSourceV1Schema).max(MAX_OPERATIONAL_SOURCES),
}).strict().superRefine((snapshot, context) => {
  const expected = snapshot.sourceRoster.entries.map(({ sourceId }) => sourceId);
  const actual = snapshot.sources.map(({ sourceId }) => sourceId);
  if (
    actual.length !== expected.length
    || actual.some((sourceId, index) => sourceId !== expected[index])
  ) {
    context.addIssue({
      code: "custom",
      message: "Runtime operations sources must exactly match the canonical roster",
      path: ["sources"],
    });
  }
  const observedAt = Date.parse(snapshot.observedAt);
  snapshot.sources.forEach((source, index) => {
    const clocks = [
      source.health?.persistedAt,
      source.latestExtraction?.completedAt,
      source.newestOrdinaryPriceAt,
      ...source.latestWorkerResults.flatMap(({ completedAt, persistedAt }) => [
        completedAt,
        persistedAt,
      ]),
    ].filter((value): value is string => value !== null && value !== undefined);
    if (clocks.some((value) => Date.parse(value) > observedAt)) {
      context.addIssue({
        code: "custom",
        message: "Runtime operations evidence cannot postdate its observation clock",
        path: ["sources", index],
      });
    }
  });
});

export type OperationsRuntimeSnapshotV1 = z.infer<typeof operationsRuntimeSnapshotV1Schema>;
export type OperationsRuntimeSourceV1 = z.infer<typeof operationsRuntimeSourceV1Schema>;

/** Normative UTF-8 payload whose SHA-256 is `contentSha256`. */
export function canonicalizeOperationsSourceRosterV1(
  rosterInput: Omit<OperationsSourceRosterV1, "contentSha256">,
): string {
  const parsed = operationsSourceRosterV1Schema.parse({
    ...rosterInput,
    contentSha256: "0".repeat(64),
  });
  return JSON.stringify({
    contractVersion: OPERATIONS_CONTRACT_VERSION,
    entries: parsed.entries,
    version: parsed.version,
  });
}

export const operationsEvidenceSnapshotV1Schema = z.object({
  contractVersion: z.literal(OPERATIONS_CONTRACT_VERSION),
  hasMoreSources: z.boolean(),
  observedAt: timestampSchema,
  sourceRoster: operationsSourceRosterV1Schema,
  sources: z.array(sourceOperationalMetricsV1Schema).max(MAX_OPERATIONAL_SOURCES),
  windowStartedAt: timestampSchema,
}).strict().superRefine((snapshot, context) => {
  if (Date.parse(snapshot.observedAt) - Date.parse(snapshot.windowStartedAt) !== 24 * 60 * 60 * 1_000) {
    context.addIssue({ code: "custom", message: "The operations window must be exactly 24 hours" });
  }
  const identifiers = snapshot.sources.map((source) => source.sourceId);
  if (new Set(identifiers).size !== identifiers.length) {
    context.addIssue({ code: "custom", message: "Operational source identifiers must be unique" });
  }
  const expectedIdentifiers = snapshot.sourceRoster.entries.map(({ sourceId }) => sourceId);
  if (
    identifiers.length !== expectedIdentifiers.length
    || identifiers.some((id, index) => id !== expectedIdentifiers[index])
  ) {
    context.addIssue({
      code: "custom",
      message: "The operational source directory must exactly match the canonical roster",
      path: ["sourceRoster", "entries"],
    });
  }
  const observedAt = Date.parse(snapshot.observedAt);
  for (const [index, source] of snapshot.sources.entries()) {
    const requirement = snapshot.sourceRoster.entries[index];
    if (requirement === undefined || requirement.sourceId !== source.sourceId) continue;
    const timestamps = [
      source.health?.recordedAt,
      source.health?.persistedAt,
      source.health?.lastCaptureSuccessAt,
      source.health?.lastDiscoverySuccessAt,
      source.health?.lastEligibleEvidenceAt,
      source.health?.lastPublishSuccessAt,
      source.latestExtraction?.completedAt,
      source.evidenceSignals["official-offer"].newestEligibleAt,
      source.evidenceSignals["ordinary-price"].newestEligibleAt,
      ...Object.values(source.workerJobs).flatMap((job) => [job.completedAt, job.terminalizedAt]),
    ].filter((value): value is string => value !== null && value !== undefined);
    if (timestamps.some((value) => Date.parse(value) > observedAt)) {
      context.addIssue({
        code: "custom",
        message: "Operational evidence cannot postdate its observation clock",
        path: ["sources", index],
      });
    }
    if (source.health !== null) {
      const recordedAt = Date.parse(source.health.recordedAt);
      if (Date.parse(source.health.persistedAt) < recordedAt) {
        context.addIssue({
          code: "custom",
          message: "Trusted source health must be persisted after worker completion",
          path: ["sources", index, "health"],
        });
      }
      const successClocks = [
        source.health.lastCaptureSuccessAt,
        source.health.lastDiscoverySuccessAt,
        source.health.lastEligibleEvidenceAt,
        source.health.lastPublishSuccessAt,
      ].filter((value): value is string => value !== null);
      if (successClocks.some((value) => Date.parse(value) > recordedAt)) {
        context.addIssue({
          code: "custom",
          message: "Source success cannot postdate its health snapshot",
          path: ["sources", index, "health"],
        });
      }
    }
    for (const kind of OPERATIONAL_EVIDENCE_SIGNAL_KINDS) {
      const signal = source.evidenceSignals[kind];
      if (signal.freshness !== freshnessFromClock(signal.newestEligibleAt, observedAt)) {
        context.addIssue({
          code: "custom",
          message: `Evidence signal ${kind} freshness does not match its clock`,
          path: ["sources", index, "evidenceSignals", kind],
        });
      }
    }
    for (const kind of OPERATIONAL_WORKER_JOB_KINDS) {
      const job = source.workerJobs[kind];
      const expectedLag = job.terminalizedAt === null
        ? "unknown"
        : observedAt - Date.parse(job.terminalizedAt)
            <= OPERATIONS_WORKER_LAG_TARGET_SECONDS * 1_000
          ? "within-target"
          : "late";
      if (job.lag !== expectedLag) {
        context.addIssue({
          code: "custom",
          message: `Worker job ${kind} lag does not match its persistence clock`,
          path: ["sources", index, "workerJobs", kind],
        });
      }
    }
    if (
      source.counts24h.failedIngestions.value > source.counts24h.ingestions.value
      || (!source.counts24h.ingestions.capped && source.counts24h.failedIngestions.capped)
      || source.counts24h.rejectedReviews.value > source.counts24h.reviewDecisions.value
      || (!source.counts24h.reviewDecisions.capped && source.counts24h.rejectedReviews.capped)
      || source.offers.expiringWithin48h.value > source.offers.active.value
      || (!source.offers.active.capped && source.offers.expiringWithin48h.capped)
      || ((source.reviewQueue.count.value === 0) !== (source.reviewQueue.oldestAgeSeconds === null))
    ) {
      context.addIssue({
        code: "custom",
        message: "Operational aggregate subsets are inconsistent",
        path: ["sources", index],
      });
    }
    const expected = expectedDerivedStates(source, requirement, observedAt);
    for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
      if (source.derived[key] !== expected[key]) {
        context.addIssue({
          code: "custom",
          message: `Derived operational state ${key} does not match its evidence`,
          path: ["sources", index, "derived", key],
        });
      }
    }
  }
});

export type OperationsEvidenceSnapshotV1 = z.infer<typeof operationsEvidenceSnapshotV1Schema>;
export type SourceOperationalMetricsV1 = z.infer<typeof sourceOperationalMetricsV1Schema>;

function freshnessFromClock(
  value: string | null,
  observedAt: number,
): "fresh" | "stale" | "unknown" {
  if (value === null) return "unknown";
  return observedAt - Date.parse(value) <= OPERATIONS_FRESHNESS_TARGET_SECONDS * 1_000
    ? "fresh"
    : "stale";
}

function expectedDerivedStates(
  source: SourceOperationalMetricsV1,
  requirement: OperationsSourceRosterV1["entries"][number],
  _observedAt: number,
): SourceOperationalMetricsV1["derived"] {
  const reviewDecisions = source.counts24h.reviewDecisions;
  const rejectedReviews = source.counts24h.rejectedReviews;
  const requiredSignalFreshness = requirement.requiredEvidenceSignals.map(
    (kind) => source.evidenceSignals[kind].freshness,
  );
  const sourceFreshness = requiredSignalFreshness.includes("stale")
    ? "stale"
    : requiredSignalFreshness.includes("unknown") ? "unknown" : "fresh";
  const requiredWorkerLag = requirement.requiredWorkerJobKinds.map(
    (kind) => source.workerJobs[kind].lag,
  );
  const workerLag = requiredWorkerLag.includes("late")
    ? "late"
    : requiredWorkerLag.includes("unknown") ? "unknown" : "within-target";
  return {
    ordinaryPriceFreshness: source.evidenceSignals["ordinary-price"].freshness,
    rejectionRate: reviewDecisions.capped || rejectedReviews.capped
      ? "unknown"
      : reviewDecisions.value === 0
        ? "none"
        : rejectedReviews.value * 2 >= reviewDecisions.value ? "high" : "low",
    silentZeroPublication: source.latestExtraction === null
      ? "unknown"
      : source.latestExtraction.emptyResult === "unexpected-empty"
        ? "detected"
        : source.latestExtraction.emptyResult === "confirmed-empty"
          ? "confirmed-empty"
          : source.latestExtraction.state === "completed"
              && source.latestExtraction.eligiblePublishedOfferCount.value > 0
            && !source.latestExtraction.eligiblePublishedOfferCount.capped
            ? "clear"
            : "unknown",
    sourceFreshness,
    workerLag,
  };
}

export const suppliedOperationalStatusesV1Schema = z.object({
  apiCoordinator: z.enum(["healthy", "outage", "unknown"]),
  apiErrorRate: z.enum(["normal", "elevated", "critical", "unknown"]),
  apiLatency: z.enum(["within-target", "above-target", "unavailable", "unknown"]),
  apiSaturation: z.enum(["normal", "high", "critical", "unknown"]),
  backup: z.enum(["current", "stale", "failed", "unknown"]),
  certificate: z.enum(["valid", "expiring", "expired", "unknown"]),
  databaseSaturation: z.enum(["normal", "high", "critical", "unknown"]),
  disk: z.enum(["healthy", "low", "critical", "unknown"]),
}).strict();

export type SuppliedOperationalStatusesV1 = z.infer<typeof suppliedOperationalStatusesV1Schema>;

export const operationalAlertKeySchema = z.enum([
  "api.coordinator-outage",
  "api.error-rate",
  "api.latency",
  "api.saturation",
  "backup.status",
  "certificate.status",
  "database.saturation",
  "disk.status",
  "offer.expired",
  "offer.expiring",
  "review.queue-age",
  "source.freshness",
  "source.silent-zero-publication",
  "worker.lag",
]);

export type OperationalAlertKey = z.infer<typeof operationalAlertKeySchema>;
export const operationalAlertOutcomeSchema = z.enum(["ok", "warning", "critical", "unknown"]);
export type OperationalAlertOutcome = z.infer<typeof operationalAlertOutcomeSchema>;

export const operationalAlertAssessmentV1Schema = z.object({
  alertKey: operationalAlertKeySchema,
  outcome: operationalAlertOutcomeSchema,
  severity: z.enum(["info", "warning", "critical"]),
  sourceId: sourceIdSchema.nullable(),
  status: z.enum(["open", "closed"]),
}).strict().superRefine((assessment, context) => {
  const needsSource = assessment.alertKey.startsWith("source.")
    || assessment.alertKey.startsWith("offer.")
    || assessment.alertKey === "review.queue-age"
    || assessment.alertKey === "worker.lag";
  if (needsSource !== (assessment.sourceId !== null)) {
    context.addIssue({ code: "custom", message: "Alert scope does not match its fixed key" });
  }
  if (
    (assessment.outcome === "ok") !== (assessment.status === "closed")
    || (assessment.outcome === "ok" && assessment.severity !== "info")
    || (assessment.outcome === "critical" && assessment.severity !== "critical")
    || (["warning", "unknown"].includes(assessment.outcome)
      && assessment.severity !== "warning")
  ) {
    context.addIssue({ code: "custom", message: "Alert outcome, status, and severity disagree" });
  }
});

export type OperationalAlertAssessmentV1 = z.infer<typeof operationalAlertAssessmentV1Schema>;

export const operationalAlertEvaluationV1Schema = z.object({
  assessments: z.array(operationalAlertAssessmentV1Schema)
    .max(MAX_OPERATIONAL_ALERT_TRANSITIONS),
  contractVersion: z.literal(OPERATIONS_CONTRACT_VERSION),
  evaluatedAt: timestampSchema,
  sourceRoster: operationsSourceRosterV1Schema,
}).strict().superRefine((evaluation, context) => {
  const identities = evaluation.assessments.map(
    (assessment) => `${assessment.alertKey}\u0000${assessment.sourceId ?? ""}`,
  );
  if (new Set(identities).size !== identities.length) {
    context.addIssue({ code: "custom", message: "Alert assessments must have unique identities" });
  }
  const globalKeys = [
    "api.coordinator-outage",
    "api.error-rate",
    "api.latency",
    "api.saturation",
    "backup.status",
    "certificate.status",
    "database.saturation",
    "disk.status",
  ] as const satisfies readonly OperationalAlertKey[];
  const sourceKeys = [
    "offer.expired",
    "offer.expiring",
    "review.queue-age",
    "source.freshness",
    "source.silent-zero-publication",
    "worker.lag",
  ] as const satisfies readonly OperationalAlertKey[];
  const expectedIdentities = [
    ...globalKeys.map((key) => `${key}\u0000`),
    ...evaluation.sourceRoster.entries.flatMap(({ sourceId }) =>
      sourceKeys.map((key) => `${key}\u0000${sourceId}`)),
  ].sort(compareOperationalText);
  if (
    identities.length !== expectedIdentities.length
    || [...identities].sort(compareOperationalText)
      .some((identity, index) => identity !== expectedIdentities[index])
  ) {
    context.addIssue({ code: "custom", message: "Alert evaluation must contain the exact roster matrix" });
  }
  if (identities.some((identity, index) => index > 0 && identities[index - 1]! > identity)) {
    context.addIssue({ code: "custom", message: "Alert assessments must be canonically sorted" });
  }
});

export type OperationalAlertEvaluationV1 = z.infer<typeof operationalAlertEvaluationV1Schema>;

const canonicalOperationsTimestampSchema = timestampSchema.refine(
  (value) => new Date(value).toISOString() === value,
  { message: "Operations runtime timestamps must use canonical UTC milliseconds" },
);

export const operationalAlertScheduleV1Schema = z.object({
  anchorAt: canonicalOperationsTimestampSchema,
  contractVersion: z.literal(OPERATIONS_CONTRACT_VERSION),
  intervalMs: z.number().int().min(60_000).max(24 * 60 * 60 * 1_000),
  timeoutMs: z.number().int().min(1_000).max(5 * 60 * 1_000),
}).strict();

export type OperationalAlertScheduleV1 = z.infer<typeof operationalAlertScheduleV1Schema>;

export const operationalAlertCheckpointV1Schema = z.object({
  contractVersion: z.literal(OPERATIONS_CONTRACT_VERSION),
  evaluatedAt: canonicalOperationsTimestampSchema,
  evaluationContentSha256: sha256Schema,
  persistedAt: canonicalOperationsTimestampSchema,
  sourceRosterContentSha256: sha256Schema,
  sourceRosterVersion: z.string().min(1).max(80)
    .regex(/^[a-z0-9][a-z0-9._:-]*$/u),
}).strict().refine(
  ({ evaluatedAt, persistedAt }) => Date.parse(evaluatedAt) <= Date.parse(persistedAt),
  { message: "An alert checkpoint cannot precede its evaluation" },
);

export type OperationalAlertCheckpointV1 = z.infer<typeof operationalAlertCheckpointV1Schema>;

export const operationalAlertAppendReceiptV1Schema = z.object({
  appended: z.number().int().min(0).max(MAX_OPERATIONAL_ALERT_TRANSITIONS),
  checkpoint: operationalAlertCheckpointV1Schema,
}).strict();

export type OperationalAlertAppendReceiptV1 = z.infer<
  typeof operationalAlertAppendReceiptV1Schema
>;

const positiveEventIdSchema = z.string().regex(/^[1-9][0-9]{0,18}$/u);

export const operationalAlertExportEventV1Schema = z.object({
  alertKey: operationalAlertKeySchema,
  evaluatedAt: canonicalOperationsTimestampSchema,
  eventAt: canonicalOperationsTimestampSchema,
  eventId: positiveEventIdSchema,
  outcome: operationalAlertOutcomeSchema,
  severity: z.enum(["info", "warning", "critical"]),
  sourceId: sourceIdSchema.nullable(),
  status: z.enum(["open", "closed"]),
}).strict().superRefine((event, context) => {
  const assessmentResult = operationalAlertAssessmentV1Schema.safeParse({
    alertKey: event.alertKey,
    outcome: event.outcome,
    severity: event.severity,
    sourceId: event.sourceId,
    status: event.status,
  });
  if (!assessmentResult.success) {
    context.addIssue({ code: "custom", message: "Export event is not a fixed alert transition" });
  }
  if (Date.parse(event.evaluatedAt) > Date.parse(event.eventAt)) {
    context.addIssue({ code: "custom", message: "Export event cannot precede evaluation" });
  }
});

export type OperationalAlertExportEventV1 = z.infer<
  typeof operationalAlertExportEventV1Schema
>;

export const operationalAlertExportBatchV1Schema = z.object({
  contractVersion: z.literal(OPERATIONS_CONTRACT_VERSION),
  events: z.array(operationalAlertExportEventV1Schema)
    .max(MAX_OPERATIONAL_ALERT_EXPORT_EVENTS),
  hasMore: z.boolean(),
  nextEventId: positiveEventIdSchema.nullable(),
}).strict().superRefine((batch, context) => {
  if ((batch.events.length === 0) !== (batch.nextEventId === null)) {
    context.addIssue({ code: "custom", message: "Export cursor must match the emitted batch" });
  }
  const identifiers = batch.events.map(({ eventId }) => BigInt(eventId));
  if (identifiers.some((eventId, index) => index > 0 && identifiers[index - 1]! >= eventId)) {
    context.addIssue({ code: "custom", message: "Export events must be strictly ordered" });
  }
  if (
    batch.nextEventId !== null
    && batch.nextEventId !== batch.events.at(-1)?.eventId
  ) {
    context.addIssue({ code: "custom", message: "Export cursor must equal the final event" });
  }
});

export type OperationalAlertExportBatchV1 = z.infer<
  typeof operationalAlertExportBatchV1Schema
>;

export const operationsAlertRuntimeConfigV1Schema = z.discriminatedUnion("enabled", [
  z.object({
    contractVersion: z.literal(OPERATIONS_CONTRACT_VERSION),
    enabled: z.literal(false),
  }).strict(),
  z.object({
    capabilities: z.object({
      appender: z.literal("security-definer-v1"),
      checkpoint: z.literal("database-checkpoint-v1"),
      exporter: z.literal("bounded-pull-v1"),
      suppliedStatuses: z.literal("fixed-buckets-v1"),
    }).strict(),
    contractVersion: z.literal(OPERATIONS_CONTRACT_VERSION),
    delivery: z.literal("disabled"),
    enabled: z.literal(true),
    schedule: operationalAlertScheduleV1Schema,
  }).strict(),
]);

export type OperationsAlertRuntimeConfigV1 = z.infer<
  typeof operationsAlertRuntimeConfigV1Schema
>;

function assessment(
  alertKey: OperationalAlertKey,
  sourceId: string | null,
  outcome: OperationalAlertOutcome,
): OperationalAlertAssessmentV1 {
  return operationalAlertAssessmentV1Schema.parse({
    alertKey,
    outcome,
    severity: outcome === "critical" ? "critical" : outcome === "ok" ? "info" : "warning",
    sourceId,
    status: outcome === "ok" ? "closed" : "open",
  });
}

function simpleOutcome(
  value: string,
  ok: readonly string[],
  warning: readonly string[],
  critical: readonly string[],
): OperationalAlertOutcome {
  if (ok.includes(value)) return "ok";
  if (warning.includes(value)) return "warning";
  if (critical.includes(value)) return "critical";
  return "unknown";
}

/**
 * Converts already-aggregated, allowlisted operational facts into a complete,
 * deterministic alert state. Unknown evidence is deliberately an open warning,
 * never an implicit success.
 */
export function evaluateOperationalAlertsV1(
  evidenceInput: OperationsEvidenceSnapshotV1,
  suppliedInput: SuppliedOperationalStatusesV1,
): OperationalAlertEvaluationV1 {
  const evidence = operationsEvidenceSnapshotV1Schema.parse(evidenceInput);
  const supplied = suppliedOperationalStatusesV1Schema.parse(suppliedInput);
  if (evidence.hasMoreSources) {
    throw new TypeError("Cannot evaluate an incomplete operational source directory");
  }
  const assessments: OperationalAlertAssessmentV1[] = [
    assessment("api.coordinator-outage", null, simpleOutcome(
      supplied.apiCoordinator, ["healthy"], [], ["outage"],
    )),
    assessment("api.error-rate", null, simpleOutcome(
      supplied.apiErrorRate, ["normal"], ["elevated"], ["critical"],
    )),
    assessment("api.latency", null, simpleOutcome(
      supplied.apiLatency, ["within-target"], ["above-target"], ["unavailable"],
    )),
    assessment("api.saturation", null, simpleOutcome(
      supplied.apiSaturation, ["normal"], ["high"], ["critical"],
    )),
    assessment("backup.status", null, simpleOutcome(
      supplied.backup, ["current"], ["stale"], ["failed"],
    )),
    assessment("certificate.status", null, simpleOutcome(
      supplied.certificate, ["valid"], ["expiring"], ["expired"],
    )),
    assessment("database.saturation", null, simpleOutcome(
      supplied.databaseSaturation, ["normal"], ["high"], ["critical"],
    )),
    assessment("disk.status", null, simpleOutcome(
      supplied.disk, ["healthy"], ["low"], ["critical"],
    )),
  ];

  for (const source of [...evidence.sources].sort((left, right) =>
    compareOperationalText(left.sourceId, right.sourceId))) {
    const requirement = evidence.sourceRoster.entries.find(({ sourceId }) => sourceId === source.sourceId);
    if (requirement === undefined) {
      throw new TypeError("Operational source is absent from the canonical roster");
    }
    const requiredWorkerJobs = requirement.requiredWorkerJobKinds.map(
      (kind) => source.workerJobs[kind],
    );
    const requiredWorkerStates = requiredWorkerJobs.map(({ state }) => state);
    const requiredHealth = source.health !== null
      && requirement.requiredWorkerJobKinds.includes(source.health.workerJobKind)
      ? source.health
      : null;
    assessments.push(
      assessment("offer.expired", source.sourceId,
        source.offers.expiredButPublished.value > 0 ? "critical" : "ok"),
      assessment("offer.expiring", source.sourceId,
        source.offers.expiringWithin48h.value > 0 ? "warning" : "ok"),
      assessment("review.queue-age", source.sourceId,
        source.reviewQueue.count.capped
          || (source.reviewQueue.oldestAgeSeconds ?? 0) > OPERATIONS_REVIEW_AGE_TARGET_SECONDS
          ? "warning"
          : "ok"),
      assessment("source.freshness", source.sourceId,
        ["contradictory", "expired", "revoked"].includes(source.governanceState)
          ? "critical"
          : source.governanceState !== "approved-current"
            ? "warning"
            : source.derived.sourceFreshness === "fresh"
              ? "ok"
              : source.derived.sourceFreshness === "stale" ? "critical" : "unknown"),
      assessment("source.silent-zero-publication", source.sourceId,
        ["clear", "confirmed-empty"].includes(source.derived.silentZeroPublication)
          ? "ok"
          : source.derived.silentZeroPublication === "detected" ? "warning" : "unknown"),
      assessment("worker.lag", source.sourceId,
        requiredHealth?.state === "failed" || requiredWorkerStates.includes("failed")
            ? "critical"
            : (
                (requiredHealth !== null && ["degraded", "disabled"].includes(requiredHealth.state))
                || requiredWorkerStates.some((jobState) =>
                  ["degraded", "cancelled"].includes(jobState))
              )
              ? "warning"
              : source.derived.workerLag === "late"
                ? "warning"
                : requiredWorkerStates.includes("unknown")
                  ? "unknown"
                  : source.derived.workerLag === "within-target"
                ? "ok"
                : "unknown"),
    );
  }

  assessments.sort((left, right) => {
    const keyOrder = compareOperationalText(left.alertKey, right.alertKey);
    return keyOrder !== 0 ? keyOrder : compareOperationalText(left.sourceId ?? "", right.sourceId ?? "");
  });
  return operationalAlertEvaluationV1Schema.parse({
    assessments,
    contractVersion: OPERATIONS_CONTRACT_VERSION,
    evaluatedAt: evidence.observedAt,
    sourceRoster: evidence.sourceRoster,
  });
}
