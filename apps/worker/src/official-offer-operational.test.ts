import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SYNTHETIC_OFFER_LAYOUT_FINGERPRINT,
  SYNTHETIC_OFFER_SCHEMA_FINGERPRINT,
  officialOfferEditionDiscoveryInputV1Schema,
  officialOfferExtractionEnvelopeV1Schema,
  syntheticAuthorizedLocalEdition,
  syntheticExactProductIdsByGtin,
  syntheticStructuredOfferCandidates,
  validateOfficialOfferExtraction,
  type OfficialOfferExtractionEnvelopeV1,
} from "@handleplan/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OfficialOfferFoundationPipeline,
  OfficialOfferFoundationWorkerError,
  type OfficialOfferFoundationRepositoryPort,
  type OfficialOfferPrivateBlobWrite,
} from "./official-offer-foundation";
import {
  OfficialOfferLifecycleJobExecutor,
  type OfficialOfferLifecycleReceiptV1,
} from "./official-offer-lifecycle";
import {
  MAX_OFFICIAL_OFFER_DISCOVERY_PAGES,
  OfficialOfferIngestionOrchestrator,
  OfficialOfferIngestionProgressError,
  createOfficialOfferIngestionHandler,
  createOfficialOfferProductionComposition,
  disabledOfficialOfferProductionComposition,
} from "./official-offer-operational";
import { FilesystemOfficialOfferPrivateBlobStore } from "./private-offer-blob-store";
import { WorkerRunner } from "./runner";
import { WorkerRuntime } from "./runtime";

const NOW = new Date("2026-07-17T08:00:00.000Z");
const PAYLOAD = new TextEncoder().encode("invented source-neutral publication fixture");
const PAYLOAD_CHECKSUM = createHash("sha256").update(PAYLOAD).digest("hex");
const EDITION = officialOfferEditionDiscoveryInputV1Schema.parse(
  syntheticAuthorizedLocalEdition,
);
const TEMPORARY_ROOTS = new Set<string>();

afterEach(async () => {
  await Promise.all([...TEMPORARY_ROOTS].map(async (root) => {
    await rm(root, { force: true, recursive: true });
    TEMPORARY_ROOTS.delete(root);
  }));
});

async function privateTemporaryRoot(): Promise<string> {
  const physicalTemporaryDirectory = await realpath(tmpdir());
  const root = await mkdtemp(join(physicalTemporaryDirectory, "handleplan-offer-runtime-"));
  TEMPORARY_ROOTS.add(root);
  return root;
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function fetchResult() {
  return {
    bytes: PAYLOAD,
    checksumSha256: PAYLOAD_CHECKSUM,
    contractVersion: 1,
    externalEditionId: EDITION.externalEditionId,
    mimeType: "application/json",
    rightsClassification: "extract_only",
    sourceId: EDITION.sourceId,
  };
}

describe("source-neutral official-offer operational boundaries", () => {
  it("keeps production schedules and handlers explicitly empty while activation is disabled", () => {
    expect(disabledOfficialOfferProductionComposition()).toEqual({
      activationEnabled: false,
      handlers: {},
      schedules: [],
    });
    expect(() => createOfficialOfferProductionComposition({
      contractVersion: 1,
      enabled: true,
      ingestion: {
        anchorAt: "2026-01-01T00:00:00.000Z",
        intervalMs: 6 * 60 * 60 * 1_000,
        timeoutMs: 15 * 60 * 1_000,
      },
      lifecycle: {
        anchorAt: "2026-01-01T00:30:00.000Z",
        intervalMs: 60 * 60 * 1_000,
        timeoutMs: 5 * 60 * 1_000,
      },
      sourceId: "synthetic-source",
    })).toThrow(new OfficialOfferFoundationWorkerError("SOURCE_DISABLED"));
  });

  it("rejects extra production config fields and malformed schedules before composition", () => {
    expect(() => createOfficialOfferProductionComposition({
      contractVersion: 1,
      enabled: false,
      reason: "disabled",
      sourceId: "must-not-be-accepted",
    } as never)).toThrow(new OfficialOfferFoundationWorkerError("INVALID_INPUT"));

    expect(() => createOfficialOfferProductionComposition({
      contractVersion: 1,
      enabled: true,
      ingestion: {
        anchorAt: "not-a-canonical-timestamp",
        intervalMs: 1,
        timeoutMs: 1,
      },
      lifecycle: {
        anchorAt: "2026-01-01T00:00:00.000Z",
        intervalMs: 1,
        timeoutMs: 1,
      },
      sourceId: "synthetic-source",
    })).toThrow(new OfficialOfferFoundationWorkerError("INVALID_INPUT"));
  });

  it("cross-binds fetch results to discovered editions and rejects extra fields", async () => {
    const pipeline = { captureAndExtract: vi.fn() };
    const orchestrator = new OfficialOfferIngestionOrchestrator({
      attemptAuthorizer: { authorizeAttempt: vi.fn(async () => undefined) },
      discovery: {
        discoverPage: vi.fn(async () => ({
          contractVersion: 1,
          editions: [EDITION],
        })),
      },
      fetcher: {
        fetchEdition: vi.fn(async () => ({
          ...fetchResult(),
          sourceId: "different-source",
        })),
      },
      pipeline,
      sourceId: EDITION.sourceId,
    });

    await expect(orchestrator.run(signal())).rejects.toEqual(
      new OfficialOfferFoundationWorkerError("INVALID_INPUT"),
    );
    expect(pipeline.captureAndExtract).not.toHaveBeenCalled();

    const extraField = new OfficialOfferIngestionOrchestrator({
      attemptAuthorizer: { authorizeAttempt: vi.fn(async () => undefined) },
      discovery: {
        discoverPage: vi.fn(async () => ({
          contractVersion: 1,
          editions: [EDITION],
          privateUrl: "https://invalid.test/private",
        })),
      },
      fetcher: { fetchEdition: vi.fn() },
      pipeline,
      sourceId: EDITION.sourceId,
    });
    await expect(extraField.run(signal())).rejects.toEqual(
      new OfficialOfferFoundationWorkerError("INVALID_INPUT"),
    );
  });

  it("rejects repeated cursors and bounded-page exhaustion", async () => {
    const repeated = new OfficialOfferIngestionOrchestrator({
      attemptAuthorizer: { authorizeAttempt: vi.fn(async () => undefined) },
      discovery: {
        discoverPage: vi.fn(async () => ({
          contractVersion: 1,
          editions: [],
          nextCursor: "same-cursor",
        })),
      },
      fetcher: { fetchEdition: vi.fn() },
      pipeline: { captureAndExtract: vi.fn() },
      sourceId: EDITION.sourceId,
    });
    await expect(repeated.run(signal())).rejects.toEqual(
      new OfficialOfferFoundationWorkerError("INVALID_INPUT"),
    );

    let page = 0;
    const exhausted = new OfficialOfferIngestionOrchestrator({
      attemptAuthorizer: { authorizeAttempt: vi.fn(async () => undefined) },
      discovery: {
        discoverPage: vi.fn(async () => ({
          contractVersion: 1,
          editions: [],
          nextCursor: `cursor-${page++}`,
        })),
      },
      fetcher: { fetchEdition: vi.fn() },
      pipeline: { captureAndExtract: vi.fn() },
      sourceId: EDITION.sourceId,
    });
    await expect(exhausted.run(signal())).rejects.toEqual(
      new OfficialOfferFoundationWorkerError("INVALID_INPUT"),
    );
    expect(page).toBe(MAX_OFFICIAL_OFFER_DISCOVERY_PAGES);
  });

  it("preserves already-persisted progress when a later edition fails", async () => {
    const secondEdition = officialOfferEditionDiscoveryInputV1Schema.parse({
      ...EDITION,
      externalEditionId: `${EDITION.externalEditionId}-second`,
    });
    const pipeline = {
      captureAndExtract: vi.fn()
        .mockResolvedValueOnce({
          activationEnabled: false,
          contractVersion: 1,
          counts: { exactMatch: 1, rejected: 0, reviewRequired: 0, total: 1 },
          extractionMethod: "structured",
          extractionRunId: 1,
          status: "completed",
        })
        .mockRejectedValueOnce(new Error("synthetic second-edition failure")),
    };
    const orchestrator = new OfficialOfferIngestionOrchestrator({
      attemptAuthorizer: { authorizeAttempt: vi.fn(async () => undefined) },
      discovery: {
        discoverPage: vi.fn(async () => ({
          contractVersion: 1,
          editions: [EDITION, secondEdition],
        })),
      },
      fetcher: {
        fetchEdition: vi.fn(async (edition) => ({
          ...fetchResult(),
          externalEditionId: edition.externalEditionId,
        })),
      },
      pipeline,
      sourceId: EDITION.sourceId,
    });

    await expect(orchestrator.run(signal())).rejects.toEqual(
      new OfficialOfferIngestionProgressError("FAILED", {
        completed: 1,
        contractVersion: 1,
        degraded: 0,
        discovered: 2,
        failed: 1,
        fetched: 1,
        persisted: 1,
      }),
    );
  });

  it("preserves partial accounting through the real handler and WorkerRunner", async () => {
    const runner = new WorkerRunner({
      createRunId: () => "synthetic-offer-partial-run",
      handlers: {
        "official-offer-ingestion": createOfficialOfferIngestionHandler({
          run: async () => {
            throw new OfficialOfferIngestionProgressError("FAILED", {
              completed: 1,
              contractVersion: 1,
              degraded: 0,
              discovered: 2,
              failed: 1,
              fetched: 1,
              persisted: 1,
            });
          },
        }, EDITION.sourceId),
      },
      now: () => NOW,
    });

    await expect(runner.run({
      contractVersion: 1,
      jobId: "synthetic-offer-partial-job",
      kind: "official-offer-ingestion",
      requestedAt: NOW.toISOString(),
      sourceId: EDITION.sourceId,
      timeoutMs: 60_000,
    }, { fenceToken: "synthetic-offer-fence" })).resolves.toMatchObject({
      status: "partial",
      counters: {
        accepted: 1,
        failed: 1,
        fetched: 1,
        persisted: 1,
        quarantined: 0,
        unknown: 0,
      },
    });

    const failedReceiptRunner = new WorkerRunner({
      createRunId: () => "synthetic-offer-failed-receipt-run",
      handlers: {
        "official-offer-ingestion": createOfficialOfferIngestionHandler({
          run: async () => ({
            completed: 0,
            contractVersion: 1,
            degraded: 0,
            discovered: 1,
            failed: 1,
            fetched: 1,
            persisted: 1,
          }),
        }, EDITION.sourceId),
      },
      now: () => NOW,
    });
    await expect(failedReceiptRunner.run({
      contractVersion: 1,
      jobId: "synthetic-offer-failed-receipt-job",
      kind: "official-offer-ingestion",
      requestedAt: NOW.toISOString(),
      sourceId: EDITION.sourceId,
      timeoutMs: 60_000,
    }, { fenceToken: "synthetic-offer-fence" })).resolves.toMatchObject({
      status: "partial",
      counters: {
        accepted: 0,
        failed: 1,
        fetched: 1,
        persisted: 1,
        quarantined: 0,
        unknown: 1,
      },
    });
  });

});

describe("synthetic official-offer operational flow", () => {
  it("crosses ingestion runtime and then the dedicated atomic lifecycle boundary", async () => {
    const events: string[] = [];
    const temporaryRoot = await privateTemporaryRoot();
    const privateCaptureRoot = join(temporaryRoot, "captures");
    const filesystemBlobStore = new FilesystemOfficialOfferPrivateBlobStore({
      rootDirectory: privateCaptureRoot,
    });
    const envelope: OfficialOfferExtractionEnvelopeV1 =
      officialOfferExtractionEnvelopeV1Schema.parse({
        contractVersion: 1,
        captureChecksumSha256: PAYLOAD_CHECKSUM,
        extractorVersion: "synthetic-operational-v1",
        method: "structured",
        layoutFingerprintSha256: SYNTHETIC_OFFER_LAYOUT_FINGERPRINT,
        schemaFingerprintSha256: SYNTHETIC_OFFER_SCHEMA_FINGERPRINT,
        startedAt: "2026-07-17T08:00:01.000Z",
        completedAt: "2026-07-17T08:00:02.000Z",
        emptyResult: "not-empty",
        candidates: syntheticStructuredOfferCandidates,
      });
    const repository: OfficialOfferFoundationRepositoryPort = {
      recordEdition: vi.fn(async () => {
        events.push("capture:edition-recorded");
        return { id: 41 };
      }),
      recordCapture: vi.fn(async () => {
        events.push("capture:metadata-recorded");
        return { id: 42, retrievedAt: NOW.toISOString() };
      }),
      recordExtraction: vi.fn(async (
        _captureId,
        extracted,
        edition,
        context,
      ) => {
        const validation = validateOfficialOfferExtraction(extracted, edition, context);
        events.push(`candidate:persisted:${validation.counts.total}`);
        return { counts: validation.counts, id: 43, status: validation.status };
      }),
    };
    const pipeline = new OfficialOfferFoundationPipeline({
      exactProductResolver: {
        resolveGtins: vi.fn(async (gtins: readonly string[]) => {
          events.push("extract:exact-product-resolution");
          return {
            contractVersion: 1,
            matchesByGtin: Object.fromEntries(gtins.map((gtin) => [
              gtin,
              [...(syntheticExactProductIdsByGtin[
                gtin as keyof typeof syntheticExactProductIdsByGtin
              ] ?? [])],
            ])),
          };
        }),
      },
      expectedLayoutFingerprintsSha256: [SYNTHETIC_OFFER_LAYOUT_FINGERPRINT],
      expectedSchemaFingerprintSha256: SYNTHETIC_OFFER_SCHEMA_FINGERPRINT,
      now: () => new Date(NOW),
      privateBlobStore: {
        putIfAbsent: vi.fn(async (
          write: OfficialOfferPrivateBlobWrite,
          writeSignal: AbortSignal,
        ) => {
          const result = await filesystemBlobStore.putIfAbsent(write, writeSignal);
          events.push("capture:immutable-blob-stored");
          return result;
        }),
      },
      repository,
      sourceAccessPolicy: {
        getDecision: vi.fn(async (sourceId: string, _capability: string, asOf: string) => ({
          capabilities: ["capture", "discover", "extract", "ocr"],
          contractVersion: 1,
          decision: "approved",
          evaluatedAt: asOf,
          permissionId: 11,
          reviewedAt: "2026-07-01T00:00:00.000Z",
          rightsClassifications: ["extract_only", "private_review", "public_display"],
          sourceId,
          validUntil: "2026-08-01T00:00:00.000Z",
        })),
      },
      structuredExtractor: {
        extractorVersion: "synthetic-operational-v1",
        method: "structured",
        extract: vi.fn(async () => {
          events.push("extract:structured");
          return { contractVersion: 1, envelope, state: "available" };
        }),
      },
    });
    const ingestion = new OfficialOfferIngestionOrchestrator({
      attemptAuthorizer: {
        authorizeAttempt: vi.fn(async ({ operation }) => {
          events.push(`authorize:${operation}`);
        }),
      },
      discovery: {
        discoverPage: vi.fn(async () => {
          events.push("discover:page");
          return { contractVersion: 1, editions: [EDITION] };
        }),
      },
      fetcher: {
        fetchEdition: vi.fn(async () => {
          events.push("fetch:bytes");
          return fetchResult();
        }),
      },
      pipeline,
      sourceId: EDITION.sourceId,
    });
    const lifecycleReceipt: OfficialOfferLifecycleReceiptV1 = Object.freeze({
      contractVersion: 1,
      databaseAsOf: new Date("2026-07-17T08:00:00.250Z"),
      expiredCount: 1,
      expiryExamined: 1,
      jobId: "synthetic-source:official-offer-lifecycle-reconcile:2026-07-17T08:00:00.000Z",
      leaseExpiresAt: new Date("2026-07-17T08:00:10.250Z"),
      outcome: "completed",
      publicationExamined: 0,
      publicationState: "foundation-disabled",
      publishedCount: 0,
      replayed: false,
      revokedCount: 0,
      skippedCount: 0,
      sourceId: EDITION.sourceId,
    });
    const lifecycleReconcile = vi.fn(async () => {
      events.push("lifecycle:atomic-reconcile");
      return lifecycleReceipt;
    });
    const lifecycle = new OfficialOfferLifecycleJobExecutor({
      ownerId: "synthetic-offer-lifecycle-worker",
      repository: { reconcile: lifecycleReconcile },
      sourceId: EDITION.sourceId,
    });

    const recordedResults: unknown[] = [];
    const leaseSignal = new AbortController();
    const runtime = new WorkerRuntime({
      leaseProvider: {
        acquire: async () => ({
          fenceToken: "synthetic-offer-runtime-fence",
          release: async () => undefined,
          signal: leaseSignal.signal,
        }),
      },
      now: () => NOW,
      runner: new WorkerRunner({
        createRunId: () => "synthetic-offer-runtime-run",
        handlers: {
          "official-offer-ingestion": createOfficialOfferIngestionHandler(
            ingestion,
            EDITION.sourceId,
          ),
        },
        now: () => NOW,
      }),
      schedules: [{
        anchorAt: "2026-07-17T07:30:00.000Z",
        intervalMs: 6 * 60 * 60 * 1_000,
        kind: "official-offer-ingestion",
        sourceId: EDITION.sourceId,
        timeoutMs: 60_000,
      }],
      shutdownGraceMs: 1_000,
      stateStore: {
        getLastScheduledAt: async () => undefined,
        recordResult: async (_request, result, fence) => {
          expect(fence.fenceToken).toBe("synthetic-offer-runtime-fence");
          recordedResults.push(result);
        },
      },
    });
    const cycle = await runtime.runCycle();
    expect(cycle).toMatchObject({
      leaseAcquired: true,
      results: [{
        counters: {
          accepted: 1,
          failed: 0,
          fetched: 1,
          persisted: 1,
          quarantined: 0,
          unknown: 0,
        },
        kind: "official-offer-ingestion",
        status: "succeeded",
      }],
    });
    expect(recordedResults).toEqual(cycle.results);

    const sourceNamespace = createHash("sha256").update(EDITION.sourceId, "utf8").digest("hex");
    const blobPath = join(
      privateCaptureRoot,
      "official-offers",
      "private",
      "v1",
      sourceNamespace,
      "41",
      PAYLOAD_CHECKSUM,
    );
    expect(await readFile(blobPath)).toEqual(Buffer.from(PAYLOAD));
    expect((await lstat(blobPath)).mode & 0o777).toBe(0o400);

    await expect(lifecycle.execute({
      contractVersion: 1,
      jobId: lifecycleReceipt.jobId,
      runId: "synthetic-offer-lifecycle-run",
      scheduledAt: NOW,
    }, signal())).resolves.toBe(lifecycleReceipt);
    expect(lifecycleReconcile).toHaveBeenCalledTimes(1);
    expect(lifecycleReconcile).toHaveBeenCalledWith(expect.objectContaining({
      batchLimit: 50,
      publicationRequested: false,
      sourceId: EDITION.sourceId,
    }), expect.any(AbortSignal));
    expect(events).toEqual([
      "authorize:discover",
      "discover:page",
      "authorize:fetch",
      "fetch:bytes",
      "capture:edition-recorded",
      "capture:immutable-blob-stored",
      "capture:metadata-recorded",
      "extract:structured",
      "extract:exact-product-resolution",
      "candidate:persisted:5",
      "lifecycle:atomic-reconcile",
    ]);
    expect(JSON.stringify(events)).not.toContain("http");
    expect(disabledOfficialOfferProductionComposition().activationEnabled).toBe(false);
  });
});
