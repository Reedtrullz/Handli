import { z } from "zod";

import {
  canonicalTimestampSchema,
  contractVersionSchema,
  hasUniqueStrings,
  identifierSchema,
  nonEmptyStringSchema,
} from "./contract-primitives";

export const PUBLIC_SOURCE_STATUS_MAX_ENTRIES = 50;
export const PUBLIC_SOURCE_HEALTH_MAX_AGE_MS = 26 * 60 * 60 * 1_000;

const sourceKindSchema = z.enum([
  "catalog",
  "ordinary-price",
  "offer",
  "store",
  "geocoder",
  "routing",
  "legacy",
]);

const runtimeStateSchema = z.enum([
  "approved",
  "conditional",
  "blocked",
  "revoked",
]);

const scopeIdSchema = z.string().regex(/^scope:[0-9a-f]{64}$/u);

export const publicSourceStatusScopeSchema = z
  .object({
    countryCode: z.string().regex(/^[A-Z]{2}$/u),
    id: scopeIdSchema,
    kind: z.enum(["national", "region", "postal-set", "store-set"]),
    label: nonEmptyStringSchema,
    state: z.enum(["active", "retired"]),
  })
  .strict();

export const publicSourceStatusHealthSchema = z
  .object({
    freshness: z.enum(["current", "stale"]),
    lastSuccess: z
      .object({
        captureAt: canonicalTimestampSchema.nullable(),
        discoveryAt: canonicalTimestampSchema.nullable(),
        eligibleEvidenceAt: canonicalTimestampSchema.nullable(),
        publishAt: canonicalTimestampSchema.nullable(),
      })
      .strict(),
    recordedAt: canonicalTimestampSchema,
    state: z.enum(["healthy", "degraded", "failed", "disabled"]),
  })
  .strict()
  .superRefine(({ lastSuccess, recordedAt }, context) => {
    const recordedAtMs = Date.parse(recordedAt);
    for (const [key, value] of Object.entries(lastSuccess)) {
      if (value !== null && Date.parse(value) > recordedAtMs) {
        context.addIssue({
          code: "custom",
          message: "A source success cannot postdate its health snapshot",
          path: ["lastSuccess", key],
        });
      }
    }
  });

export const publicSourceTerminalIngestionSchema = z
  .object({
    completedAt: canonicalTimestampSchema,
    scope: z.literal("source-wide"),
    startedAt: canonicalTimestampSchema,
    state: z.enum(["completed", "degraded", "failed", "cancelled"]),
  })
  .strict()
  .refine(({ completedAt, startedAt }) => Date.parse(completedAt) >= Date.parse(startedAt), {
    message: "A terminal ingestion cannot complete before it starts",
    path: ["completedAt"],
  });

export const publicSourceStatusEntrySchema = z
  .object({
    governanceState: z.enum(["approved", "not-approved"]),
    health: publicSourceStatusHealthSchema.nullable(),
    latestTerminalIngestion: publicSourceTerminalIngestionSchema.nullable(),
    scope: publicSourceStatusScopeSchema.nullable(),
    source: z
      .object({
        displayName: nonEmptyStringSchema,
        id: identifierSchema,
        kind: sourceKindSchema,
        runtimeState: runtimeStateSchema,
      })
      .strict(),
  })
  .strict()
  .refine(
    ({ governanceState, source }) =>
      governanceState !== "approved" || source.runtimeState === "approved",
    {
      message: "Governance approval requires an approved source runtime state",
      path: ["governanceState"],
    },
  );

export type PublicSourceStatusEntry = z.infer<typeof publicSourceStatusEntrySchema>;

export const publicSourceStatusOverallSchema = z.enum([
  "operational",
  "degraded",
  "unknown",
  "no-approved-sources",
]);

export type PublicSourceStatusOverall = z.infer<typeof publicSourceStatusOverallSchema>;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function entryKey(entry: PublicSourceStatusEntry): string {
  return `${entry.source.id}\u0000${entry.scope?.id ?? "unscoped"}`;
}

function entryOrder(
  left: PublicSourceStatusEntry,
  right: PublicSourceStatusEntry,
): number {
  return compareText(left.source.displayName, right.source.displayName)
    || compareText(left.source.id, right.source.id)
    || compareText(left.scope?.id ?? "", right.scope?.id ?? "");
}

function hasNewerFailedOrDegradedIngestion(entry: PublicSourceStatusEntry): boolean {
  const ingestion = entry.latestTerminalIngestion;
  if (
    ingestion === null
    || (ingestion.state !== "failed" && ingestion.state !== "degraded")
  ) {
    return false;
  }
  return entry.health === null
    || Date.parse(ingestion.completedAt) > Date.parse(entry.health.recordedAt);
}

function hasNewerCancelledIngestion(entry: PublicSourceStatusEntry): boolean {
  const ingestion = entry.latestTerminalIngestion;
  if (ingestion?.state !== "cancelled") return false;
  return entry.health === null
    || Date.parse(ingestion.completedAt) > Date.parse(entry.health.recordedAt);
}

function hasRecentRecordedSuccess(
  entry: PublicSourceStatusEntry,
  generatedAt: string,
): boolean {
  if (entry.health === null) return false;
  const generatedAtMs = Date.parse(generatedAt);
  return Object.values(entry.health.lastSuccess).some((value) => {
    if (value === null) return false;
    const successAtMs = Date.parse(value);
    return successAtMs <= generatedAtMs
      && generatedAtMs - successAtMs <= PUBLIC_SOURCE_HEALTH_MAX_AGE_MS;
  });
}

export function derivePublicSourceStatusOverall(
  entries: readonly PublicSourceStatusEntry[],
  hasMore: boolean,
  generatedAt: string,
): PublicSourceStatusOverall {
  const approved = entries.filter(({ governanceState }) => governanceState === "approved");
  if (approved.some(({ health }) =>
    health?.state === "degraded"
    || health?.state === "failed"
    || health?.state === "disabled")
    || approved.some(hasNewerFailedOrDegradedIngestion)) {
    return "degraded";
  }
  if (hasMore) return "unknown";
  if (approved.length === 0) return "no-approved-sources";
  if (
    approved.some(hasNewerCancelledIngestion)
    || approved.some(({ health }) => health === null || health.freshness === "stale")
    || approved.some((entry) => !hasRecentRecordedSuccess(entry, generatedAt))
  ) {
    return "unknown";
  }
  return "operational";
}

export const publicSourceStatusResponseSchema = z
  .object({
    claimBoundary: z
      .object({
        priceCoverage: z.literal("not-established"),
        publicRanking: z.literal("not-established"),
        runtimeActivation: z.literal("not-established"),
        stockStatus: z.literal("not-established"),
      })
      .strict(),
    completeness: z.literal("partial"),
    contractVersion: contractVersionSchema,
    entries: z.array(publicSourceStatusEntrySchema).max(PUBLIC_SOURCE_STATUS_MAX_ENTRIES),
    generatedAt: canonicalTimestampSchema,
    hasMore: z.boolean(),
    kind: z.literal("public-source-status"),
    overall: publicSourceStatusOverallSchema,
  })
  .strict()
  .superRefine((response, context) => {
    const keys = response.entries.map(entryKey);
    if (!hasUniqueStrings(keys)) {
      context.addIssue({
        code: "custom",
        message: "Source status entries must be unique per source and scope",
        path: ["entries"],
      });
    }
    const sorted = [...response.entries].sort(entryOrder);
    if (response.entries.some((entry, index) => entryKey(entry) !== entryKey(sorted[index]!))) {
      context.addIssue({
        code: "custom",
        message: "Source status entries must use canonical public ordering",
        path: ["entries"],
      });
    }
    const generatedAtMs = Date.parse(response.generatedAt);
    response.entries.forEach((entry, index) => {
      if (entry.health !== null && Date.parse(entry.health.recordedAt) > generatedAtMs) {
        context.addIssue({
          code: "custom",
          message: "Source health cannot postdate response generation",
          path: ["entries", index, "health", "recordedAt"],
        });
      }
      if (entry.health !== null) {
        const expectedFreshness = generatedAtMs - Date.parse(entry.health.recordedAt)
          <= PUBLIC_SOURCE_HEALTH_MAX_AGE_MS
          ? "current"
          : "stale";
        if (entry.health.freshness !== expectedFreshness) {
          context.addIssue({
            code: "custom",
            message: "Source-health freshness must match the response clock",
            path: ["entries", index, "health", "freshness"],
          });
        }
      }
      if (
        entry.latestTerminalIngestion !== null
        && Date.parse(entry.latestTerminalIngestion.completedAt) > generatedAtMs
      ) {
        context.addIssue({
          code: "custom",
          message: "Ingestion completion cannot postdate response generation",
          path: ["entries", index, "latestTerminalIngestion", "completedAt"],
        });
      }
    });
    if (response.overall !== derivePublicSourceStatusOverall(
      response.entries,
      response.hasMore,
      response.generatedAt,
    )) {
      context.addIssue({
        code: "custom",
        message: "Overall source status must match the bounded entries",
        path: ["overall"],
      });
    }
  });

export type PublicSourceStatusResponse = z.infer<typeof publicSourceStatusResponseSchema>;
