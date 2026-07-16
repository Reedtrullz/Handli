import type {
  KassalappIngestionGateway,
  KassalappPhysicalStoreSyncResultV1,
  KassalappPhysicalStoreSourceRecordV1,
  KassalappPriceSourceRecordV1,
  KassalappProductSourceRecordV1,
  SourceRecordOutcome,
} from "@handleplan/kassalapp";
import { describe, expect, it, vi } from "vitest";

import {
  createKassalappHandlers,
  type KassalappHandlerDependencies,
  type KassalappIngestionRepository,
  type KassalappSourceAccessState,
  type KassalappTargetProvider,
} from "./kassalapp-handlers";
import type { WorkerJobKind, WorkerRunCounters } from "./contracts";
import { WorkerCancelledError, type WorkerJobContext } from "./runner";

const NOW = new Date("2026-07-16T12:00:00.000Z");
const RETRIEVED_AT = "2026-07-16T11:59:00.000Z";
const EAN = "7038010000010";
const OTHER_EAN = "7040000000009";
const SIGNAL = new AbortController().signal;
const RUN_HANDLE = { id: "ingestion-run" };

function testGtin(variant: number): string {
  const body = `70400000${String(variant).padStart(4, "0")}`;
  let sum = 0;
  for (let index = body.length - 1, position = 1; index >= 0; index -= 1, position += 1) {
    sum += Number(body[index]) * (position % 2 === 1 ? 3 : 1);
  }
  return `${body}${(10 - (sum % 10)) % 10}`;
}

const completeCounters = {
  accepted: 1,
  failed: 0,
  fetched: 1,
  persisted: 1,
  quarantined: 0,
  unknown: 0,
} as const;

function productRecord(
  overrides: Partial<KassalappProductSourceRecordV1> = {},
): KassalappProductSourceRecordV1 {
  return {
    contractVersion: 1,
    sourceId: "kassalapp",
    sourceRecordId: "product-117",
    retrievedAt: RETRIEVED_AT,
    kind: "product",
    ean: EAN,
    name: "Tine Lettmelk",
    brand: "Tine",
    packageMeasure: { amount: 1_000, unit: "ml" },
    sourceUpdatedAt: "2026-07-15T08:30:00.000Z",
    ...overrides,
  };
}

function priceRecord(
  overrides: Partial<KassalappPriceSourceRecordV1> = {},
): KassalappPriceSourceRecordV1 {
  return {
    contractVersion: 1,
    sourceId: "kassalapp",
    sourceRecordId: `${EAN}:COOP_EXTRA:current:2026-07-15T08:30:00.000Z`,
    retrievedAt: RETRIEVED_AT,
    kind: "price",
    ean: EAN,
    chainId: "extra",
    chainCode: "COOP_EXTRA",
    amountOre: 2_190,
    observationKind: "current",
    observedAt: "2026-07-15T08:30:00.000Z",
    ...overrides,
  };
}

function storeRecord(
  overrides: Partial<KassalappPhysicalStoreSourceRecordV1> = {},
): KassalappPhysicalStoreSourceRecordV1 {
  return {
    contractVersion: 1,
    sourceId: "kassalapp",
    sourceRecordId: "store-501",
    retrievedAt: RETRIEVED_AT,
    kind: "physical-store",
    name: "Extra Sentrum",
    chainId: "extra",
    chainCode: "COOP_EXTRA",
    address: "Storgata 1",
    latitude: 59.91,
    longitude: 10.75,
    sourceUpdatedAt: "2026-07-15T08:30:00.000Z",
    ...overrides,
  };
}

function createGateway(): KassalappIngestionGateway {
  return {
    getSourceCatalogProducts: vi.fn(async () => []),
    getSourceProductByEan: vi.fn(async (): Promise<Array<
      SourceRecordOutcome<KassalappProductSourceRecordV1>
    >> => [{ state: "accepted", record: productRecord() }]),
    getSourceProductById: vi.fn(async (): Promise<
      SourceRecordOutcome<KassalappProductSourceRecordV1>
    > => ({ state: "accepted", record: productRecord() })),
    getSourceBulkPrices: vi.fn(async (): Promise<Array<
      SourceRecordOutcome<KassalappPriceSourceRecordV1>
    >> => [{ state: "accepted", record: priceRecord() }]),
    getSourceHistoricalPrices: vi.fn(async (): Promise<Array<
      SourceRecordOutcome<KassalappPriceSourceRecordV1>
    >> => [{
      state: "accepted",
      record: priceRecord({
        observationKind: "historical",
        sourceRecordId: `${EAN}:COOP_EXTRA:historical:2026-07-14T00:00:00.000Z:2090`,
        observedAt: "2026-07-14T00:00:00.000Z",
        amountOre: 2_090,
      }),
    }]),
    getSourceCategories: vi.fn(async () => ({ outcomes: [], coverage: [] })),
    getSourceLabels: vi.fn(async () => []),
    getSourcePhysicalStores: vi.fn(async (): Promise<KassalappPhysicalStoreSyncResultV1> => ({
      outcomes: [{ state: "accepted", record: storeRecord() }],
      coverage: [{
        chainCode: "COOP_EXTRA",
        chainId: "extra",
        recordCount: 1,
        state: "complete",
      }],
    })),
  };
}

function createTargets(): KassalappTargetProvider {
  return {
    getCatalogDiscoveryPage: vi.fn(async () => 1),
    getCatalogTargets: vi.fn(async () => [{ ean: EAN }]),
    getBenchmarkPriceTargets: vi.fn(async () => [{ ean: EAN, geographicScopeId: 7 }]),
    getHistoricalObservationTargets: vi.fn(async () => [{ ean: EAN, geographicScopeId: 7 }]),
  };
}

function createRepository(
  counters: WorkerRunCounters = completeCounters,
): KassalappIngestionRepository<typeof RUN_HANDLE> {
  return {
    beginRun: vi.fn(async () => ({ handle: RUN_HANDLE })),
    persistCatalogOutcomes: vi.fn(async () => undefined),
    persistPriceOutcomes: vi.fn(async () => undefined),
    persistPhysicalStoreOutcomes: vi.fn(async () => undefined),
    finalizeRun: vi.fn(async () => ({ counts: { ...counters } })),
  };
}

function createPolicy(...states: KassalappSourceAccessState[]) {
  const fallback = states.at(-1) ?? "approved";
  let index = 0;
  return {
    getAccessState: vi.fn(async () => states[index++] ?? fallback),
  };
}

function createDependencies(
  overrides: Partial<KassalappHandlerDependencies<typeof RUN_HANDLE>> = {},
) {
  return {
    clock: () => new Date(NOW),
    gateway: createGateway(),
    repository: createRepository(),
    sourceAccessPolicy: createPolicy("approved"),
    targetProvider: createTargets(),
    ...overrides,
  } satisfies KassalappHandlerDependencies<typeof RUN_HANDLE>;
}

function contextFor(kind: WorkerJobKind, signal: AbortSignal = SIGNAL): WorkerJobContext {
  return {
    fenceToken: "wlf1.fixture-fence",
    jobId: `kassalapp:${kind}:2026-07-16T12:00:00.000Z`,
    kind,
    runId: `worker-run-${kind}`,
    signal,
    sourceId: "kassalapp",
  };
}

const context = contextFor("catalog-refresh");

describe("Kassalapp worker handlers", () => {
  it.each([
    ["catalog-refresh", "catalog"],
    ["benchmark-price-refresh", "benchmark-prices"],
    ["physical-store-sync", "physical-stores"],
    ["historical-observation-collection", "historical-prices"],
  ] as const)("starts %s with a fence-scoped ingestion attempt and stable run type", async (
    kind,
    runType,
  ) => {
    const repository = createRepository();
    const handlers = createKassalappHandlers(createDependencies({ repository }));
    const jobContext = contextFor(kind);

    await handlers[kind](jobContext);

    expect(repository.beginRun).toHaveBeenCalledExactlyOnceWith({
      fenceToken: jobContext.fenceToken,
      jobId: expect.stringMatching(/~attempt-[0-9a-f]{64}$/),
      runType,
      sourceId: "kassalapp",
      startedAt: NOW,
    }, SIGNAL);
    expect(vi.mocked(repository.beginRun).mock.calls[0]?.[0].jobId).not.toBe(jobContext.jobId);
  });

  it("uses a new ingestion attempt after crash takeover of the same scheduled job", async () => {
    const repository = createRepository();
    const handlers = createKassalappHandlers(createDependencies({ repository }));
    const original = contextFor("catalog-refresh");

    await handlers["catalog-refresh"](original);
    await handlers["catalog-refresh"]({
      ...original,
      fenceToken: "wlf1.fixture-takeover-fence",
    });

    const attemptIds = vi.mocked(repository.beginRun).mock.calls.map(([input]) => input.jobId);
    expect(attemptIds).toHaveLength(2);
    expect(new Set(attemptIds).size).toBe(2);
    expect(attemptIds).toEqual([
      expect.stringMatching(/~attempt-[0-9a-f]{64}$/),
      expect.stringMatching(/~attempt-[0-9a-f]{64}$/),
    ]);
    expect(attemptIds.every((attemptId) => attemptId.length <= 200)).toBe(true);
  });

  it("refreshes only known exact-EAN catalog targets and maps all source outcomes", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.getSourceProductByEan).mockResolvedValue([
      { state: "accepted", record: productRecord() },
      {
        state: "quarantined",
        sourceRecordId: "product-duplicate",
        reason: "DUPLICATE_IDENTITY",
        ean: EAN,
      },
    ]);
    const repository = createRepository({
      accepted: 1,
      failed: 0,
      fetched: 2,
      persisted: 2,
      quarantined: 1,
      unknown: 0,
    });
    const handlers = createKassalappHandlers(createDependencies({ gateway, repository }));

    const result = await handlers["catalog-refresh"](context);

    expect(gateway.getSourceProductByEan).toHaveBeenCalledExactlyOnceWith(EAN, SIGNAL);
    expect(repository.beginRun).toHaveBeenCalledWith({
      fenceToken: context.fenceToken,
      jobId: expect.stringMatching(/~attempt-[0-9a-f]{64}$/),
      runType: "catalog",
      sourceId: "kassalapp",
      startedAt: NOW,
    }, SIGNAL);
    expect(repository.persistCatalogOutcomes).toHaveBeenCalledWith(RUN_HANDLE, [
      expect.objectContaining({
        outcomeState: "accepted",
        rawChainCode: undefined,
        recordKind: "product",
        sourceRecordId: "product-117",
        subjectEan: EAN,
        product: {
          brand: "Tine",
          displayName: "Tine Lettmelk",
          packageAmount: 1_000,
          packageUnit: "ml",
          retrievedAt: new Date(RETRIEVED_AT),
          sourceUpdatedAt: new Date("2026-07-15T08:30:00.000Z"),
        },
      }),
      expect.objectContaining({
        outcomeState: "quarantined",
        reason: "DUPLICATE_IDENTITY",
        recordKind: "product",
        sourceRecordId: "product-duplicate",
        subjectEan: EAN,
      }),
    ], SIGNAL);
    expect(result).toEqual({ counters: {
      accepted: 1,
      failed: 0,
      fetched: 2,
      persisted: 2,
      quarantined: 1,
      unknown: 0,
    } });
  });

  it("downgrades a provider-accepted product without a package measure to audited unknown", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.getSourceProductByEan).mockResolvedValue([{
      state: "accepted",
      record: productRecord({ packageMeasure: undefined, packageMeasureState: "missing" }),
    }]);
    const repository = createRepository({
      accepted: 0,
      failed: 0,
      fetched: 1,
      persisted: 1,
      quarantined: 0,
      unknown: 1,
    });
    const handlers = createKassalappHandlers(createDependencies({ gateway, repository }));

    await handlers["catalog-refresh"](context);

    expect(repository.persistCatalogOutcomes).toHaveBeenCalledWith(RUN_HANDLE, [
      expect.objectContaining({
        outcomeState: "unknown",
        reason: "MISSING_MEASURE",
        subjectEan: EAN,
      }),
    ], SIGNAL);
  });

  it("keeps retrieval freshness separate when a product has no source update timestamp", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.getSourceProductByEan).mockResolvedValue([{
      state: "accepted",
      record: productRecord({ sourceUpdatedAt: undefined }),
    }]);
    const repository = createRepository();
    const handlers = createKassalappHandlers(createDependencies({ gateway, repository }));

    await handlers["catalog-refresh"](context);

    const persisted = vi.mocked(repository.persistCatalogOutcomes).mock.calls[0]?.[1][0];
    expect(persisted).toMatchObject({
      outcomeState: "accepted",
      product: {
        brand: "Tine",
        displayName: "Tine Lettmelk",
        packageAmount: 1_000,
        packageUnit: "ml",
        retrievedAt: new Date(RETRIEVED_AT),
      },
    });
    expect(persisted?.outcomeState === "accepted" && persisted.product).not.toHaveProperty(
      "sourceUpdatedAt",
    );
  });

  it("maps current price subjects for explicit coverage and leaves unknown chains audit-only", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.getSourceBulkPrices).mockResolvedValue([
      { state: "accepted", record: priceRecord() },
      {
        state: "unknown",
        sourceRecordId: `${EAN}:REMA_1000:current:coverage`,
        reason: "MISSING_SUPPORTED_CHAIN",
        ean: EAN,
        chainId: "rema-1000",
        chainCode: "REMA_1000",
      },
      {
        state: "quarantined",
        sourceRecordId: `${EAN}:FUTURE_CHAIN:current:coverage`,
        reason: "UNKNOWN_CHAIN",
        ean: EAN,
        chainCode: "FUTURE_CHAIN",
      },
    ]);
    const repository = createRepository({
      accepted: 1,
      failed: 0,
      fetched: 3,
      persisted: 3,
      quarantined: 1,
      unknown: 1,
    });
    const handlers = createKassalappHandlers(createDependencies({ gateway, repository }));

    await handlers["benchmark-price-refresh"](contextFor("benchmark-price-refresh"));

    expect(gateway.getSourceBulkPrices).toHaveBeenCalledExactlyOnceWith([EAN], SIGNAL);
    expect(repository.persistPriceOutcomes).toHaveBeenCalledWith(RUN_HANDLE, [
      expect.objectContaining({
        outcomeState: "accepted",
        rawChainCode: "COOP_EXTRA",
        subjectChain: "extra",
        subjectEan: EAN,
        price: expect.objectContaining({
          amountOre: 2_190,
          geographicScopeId: 7,
          observedAt: new Date("2026-07-15T08:30:00.000Z"),
        }),
      }),
      expect.objectContaining({
        geographicScopeId: 7,
        outcomeState: "unknown",
        rawChainCode: "REMA_1000",
        subjectChain: "rema-1000",
        subjectEan: EAN,
      }),
      expect.not.objectContaining({ subjectChain: expect.anything() }),
    ], SIGNAL);
  });

  it("collects historical observations through the distinct history gateway", async () => {
    const gateway = createGateway();
    const repository = createRepository();
    const handlers = createKassalappHandlers(createDependencies({ gateway, repository }));

    await handlers["historical-observation-collection"](
      contextFor("historical-observation-collection"),
    );

    expect(gateway.getSourceHistoricalPrices).toHaveBeenCalledExactlyOnceWith([EAN], SIGNAL);
    expect(gateway.getSourceBulkPrices).not.toHaveBeenCalled();
    expect(repository.persistPriceOutcomes).toHaveBeenCalledWith(RUN_HANDLE, [
      expect.objectContaining({
        normalizedRecord: expect.objectContaining({ observationKind: "historical" }),
        sourceRecordId: `${EAN}:COOP_EXTRA:historical:2026-07-14T00:00:00.000Z:2090`,
      }),
    ], SIGNAL);
  });

  it("persists physical branches separately and audits missing coordinates as unknown", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.getSourcePhysicalStores).mockResolvedValue({
      outcomes: [
        { state: "accepted", record: storeRecord() },
        {
          state: "accepted",
          record: storeRecord({
            sourceRecordId: "store-502",
            name: "Extra Uten Kartpunkt",
            latitude: undefined,
            longitude: undefined,
          }),
        },
        {
          state: "quarantined",
          sourceRecordId: "store-unknown-chain",
          reason: "UNKNOWN_CHAIN",
          chainCode: "FUTURE_CHAIN",
        },
      ],
      coverage: [{
        chainCode: "COOP_EXTRA",
        chainId: "extra",
        recordCount: 2,
        state: "complete",
      }],
    });
    const repository = createRepository({
      accepted: 1,
      failed: 0,
      fetched: 3,
      persisted: 3,
      quarantined: 1,
      unknown: 1,
    });
    const handlers = createKassalappHandlers(createDependencies({ gateway, repository }));

    await handlers["physical-store-sync"](contextFor("physical-store-sync"));

    expect(repository.persistPhysicalStoreOutcomes).toHaveBeenCalledWith(RUN_HANDLE, [
      expect.objectContaining({
        outcomeState: "accepted",
        rawChainCode: "COOP_EXTRA",
        sourceRecordId: "store-501",
        subjectChain: "extra",
        store: expect.objectContaining({
          addressLine: "Storgata 1",
          latitude: 59.91,
          longitude: 10.75,
          name: "Extra Sentrum",
        }),
      }),
      expect.objectContaining({
        outcomeState: "unknown",
        reason: "MISSING_COORDINATES",
        rawChainCode: "COOP_EXTRA",
        sourceRecordId: "store-502",
        subjectChain: "extra",
      }),
      expect.objectContaining({
        outcomeState: "quarantined",
        rawChainCode: "FUTURE_CHAIN",
        sourceRecordId: "store-unknown-chain",
      }),
    ], SIGNAL);
  });

  it.each(["conditional", "blocked", "revoked"] as const)(
    "fails closed before any gateway or repository call when source access is %s",
    async (state) => {
      const gateway = createGateway();
      const repository = createRepository();
      const handlers = createKassalappHandlers(createDependencies({
        gateway,
        repository,
        sourceAccessPolicy: createPolicy(state),
      }));

      for (const kind of [
        "catalog-refresh",
        "benchmark-price-refresh",
        "physical-store-sync",
        "historical-observation-collection",
      ] as const) {
        await expect(handlers[kind](contextFor(kind))).resolves.toEqual({ counters: { failed: 1 } });
      }
      expect(gateway.getSourceProductByEan).not.toHaveBeenCalled();
      expect(gateway.getSourceBulkPrices).not.toHaveBeenCalled();
      expect(gateway.getSourceHistoricalPrices).not.toHaveBeenCalled();
      expect(gateway.getSourcePhysicalStores).not.toHaveBeenCalled();
      expect(gateway.getSourceCatalogProducts).not.toHaveBeenCalled();
      expect(repository.beginRun).not.toHaveBeenCalled();
      expect(repository.finalizeRun).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["benchmark-price-refresh", "getBenchmarkPriceTargets", "getSourceBulkPrices"],
    ["historical-observation-collection", "getHistoricalObservationTargets", "getSourceHistoricalPrices"],
  ] as const)("fails %s with NO_TARGETS semantics and no source/evidence calls", async (
    kind,
    targetMethod,
    gatewayMethod,
  ) => {
    const gateway = createGateway();
    const repository = createRepository();
    const targetProvider = createTargets();
    vi.mocked(targetProvider[targetMethod]).mockResolvedValue([]);
    const handlers = createKassalappHandlers(createDependencies({ gateway, repository, targetProvider }));

    await expect(handlers[kind](contextFor(kind))).resolves.toEqual({ counters: { failed: 1 } });
    expect(gateway[gatewayMethod]).not.toHaveBeenCalled();
    expect(repository.beginRun).not.toHaveBeenCalled();
  });

  it("bootstraps a clean catalog from a bounded source-normalized product page", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.getSourceCatalogProducts).mockResolvedValue([{
      state: "accepted",
      record: productRecord(),
    }]);
    const repository = createRepository();
    const targetProvider = createTargets();
    vi.mocked(targetProvider.getCatalogTargets).mockResolvedValue([]);
    const handlers = createKassalappHandlers(createDependencies({
      gateway,
      repository,
      targetProvider,
    }));

    await handlers["catalog-refresh"](context);

    expect(gateway.getSourceCatalogProducts).toHaveBeenCalledExactlyOnceWith(1, 100, SIGNAL);
    expect(gateway.getSourceProductByEan).not.toHaveBeenCalled();
    expect(repository.persistCatalogOutcomes).toHaveBeenCalledWith(RUN_HANDLE, [
      expect.objectContaining({
        outcomeState: "accepted",
        sourceRecordId: "product-117",
        subjectEan: EAN,
      }),
    ], SIGNAL);
  });

  it("skips an exact target already accepted by the discovery page", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.getSourceCatalogProducts).mockResolvedValue([{
      state: "accepted",
      record: productRecord(),
    }]);
    const repository = createRepository();
    const handlers = createKassalappHandlers(createDependencies({ gateway, repository }));

    await handlers["catalog-refresh"](context);

    expect(gateway.getSourceProductByEan).not.toHaveBeenCalled();
    expect(repository.persistCatalogOutcomes).toHaveBeenCalledWith(RUN_HANDLE, [
      expect.objectContaining({
        outcomeState: "accepted",
        sourceRecordId: "product-117",
        subjectEan: EAN,
      }),
    ], SIGNAL);
  });

  it("quarantines multiple accepted source identities for one exact GTIN", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.getSourceProductByEan).mockResolvedValue([
      { state: "accepted", record: productRecord({ sourceRecordId: "product-a" }) },
      { state: "accepted", record: productRecord({ sourceRecordId: "product-b" }) },
    ]);
    const repository = createRepository({
      accepted: 0,
      failed: 0,
      fetched: 2,
      persisted: 2,
      quarantined: 2,
      unknown: 0,
    });
    const handlers = createKassalappHandlers(createDependencies({ gateway, repository }));

    await handlers["catalog-refresh"](context);

    expect(repository.persistCatalogOutcomes).toHaveBeenCalledWith(RUN_HANDLE, [
      expect.objectContaining({
        normalizedRecord: {
          candidateCount: 2,
          conflictSourceRecordIds: ["product-a", "product-b"],
          conflictType: "subject-ean",
        },
        outcomeState: "quarantined",
        reason: "DUPLICATE_IDENTITY",
        sourceRecordId: "product-a",
        subjectEan: EAN,
      }),
      expect.objectContaining({
        normalizedRecord: {
          candidateCount: 2,
          conflictSourceRecordIds: ["product-a", "product-b"],
          conflictType: "subject-ean",
        },
        outcomeState: "quarantined",
        reason: "DUPLICATE_IDENTITY",
        sourceRecordId: "product-b",
        subjectEan: EAN,
      }),
    ], SIGNAL);
  });

  it("quarantines a cross-source GTIN conflict instead of publishing either record", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.getSourceCatalogProducts).mockResolvedValue([{
      state: "accepted",
      record: productRecord({ sourceRecordId: "page-product" }),
    }]);
    vi.mocked(gateway.getSourceProductByEan).mockResolvedValue([{
      state: "accepted",
      record: productRecord({ sourceRecordId: "exact-product" }),
    }]);
    const targetProvider = createTargets();
    vi.mocked(targetProvider.getCatalogTargets).mockResolvedValue([{ ean: OTHER_EAN }]);
    const repository = createRepository({
      accepted: 0,
      failed: 0,
      fetched: 2,
      persisted: 2,
      quarantined: 2,
      unknown: 0,
    });
    const handlers = createKassalappHandlers(createDependencies({
      gateway,
      repository,
      targetProvider,
    }));

    await handlers["catalog-refresh"](context);

    expect(gateway.getSourceProductByEan).toHaveBeenCalledExactlyOnceWith(OTHER_EAN, SIGNAL);
    expect(repository.persistCatalogOutcomes).toHaveBeenCalledWith(RUN_HANDLE, [
      expect.objectContaining({
        normalizedRecord: {
          candidateCount: 2,
          conflictSourceRecordIds: ["exact-product", "page-product"],
          conflictType: "subject-ean",
        },
        outcomeState: "quarantined",
        sourceRecordId: "page-product",
        subjectEan: EAN,
      }),
      expect.objectContaining({
        normalizedRecord: {
          candidateCount: 2,
          conflictSourceRecordIds: ["exact-product", "page-product"],
          conflictType: "subject-ean",
        },
        outcomeState: "quarantined",
        sourceRecordId: "exact-product",
        subjectEan: EAN,
      }),
    ], SIGNAL);
  });

  it("quarantines one source identity that resolves to conflicting GTINs", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.getSourceCatalogProducts).mockResolvedValue([{
      state: "accepted",
      record: productRecord(),
    }]);
    vi.mocked(gateway.getSourceProductByEan).mockResolvedValue([{
      state: "accepted",
      record: productRecord({ ean: OTHER_EAN }),
    }]);
    const targetProvider = createTargets();
    vi.mocked(targetProvider.getCatalogTargets).mockResolvedValue([{ ean: OTHER_EAN }]);
    const repository = createRepository({
      accepted: 0,
      failed: 0,
      fetched: 1,
      persisted: 1,
      quarantined: 1,
      unknown: 0,
    });
    const handlers = createKassalappHandlers(createDependencies({
      gateway,
      repository,
      targetProvider,
    }));

    await handlers["catalog-refresh"](context);

    expect(repository.persistCatalogOutcomes).toHaveBeenCalledWith(RUN_HANDLE, [
      expect.objectContaining({
        normalizedRecord: {
          candidateCount: 2,
          conflictSourceRecordIds: ["product-117"],
          conflictType: "source-record-id",
        },
        outcomeState: "quarantined",
        reason: "DUPLICATE_IDENTITY",
        sourceRecordId: "product-117",
      }),
    ], SIGNAL);
    const persisted = vi.mocked(repository.persistCatalogOutcomes).mock.calls[0]?.[1][0];
    expect(persisted).not.toHaveProperty("subjectEan");
  });

  it("prefers the discovery record for a same-source same-GTIN comparison overlap", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.getSourceCatalogProducts).mockResolvedValue([{
      state: "accepted",
      record: productRecord({ name: "Discovery name" }),
    }]);
    vi.mocked(gateway.getSourceProductByEan).mockResolvedValue([{
      state: "accepted",
      record: productRecord({ name: "Exact comparison name" }),
    }]);
    const targetProvider = createTargets();
    vi.mocked(targetProvider.getCatalogTargets).mockResolvedValue([{ ean: OTHER_EAN }]);
    const repository = createRepository();
    const handlers = createKassalappHandlers(createDependencies({
      gateway,
      repository,
      targetProvider,
    }));

    await handlers["catalog-refresh"](context);

    expect(repository.persistCatalogOutcomes).toHaveBeenCalledWith(RUN_HANDLE, [
      expect.objectContaining({
        outcomeState: "accepted",
        product: expect.objectContaining({ displayName: "Discovery name" }),
        sourceRecordId: "product-117",
        subjectEan: EAN,
      }),
    ], SIGNAL);
  });

  it("rechecks access after fetch and writes no evidence if permission was revoked", async () => {
    const gateway = createGateway();
    const repository = createRepository();
    const handlers = createKassalappHandlers(createDependencies({
      gateway,
      repository,
      sourceAccessPolicy: createPolicy("approved", "revoked"),
    }));

    await expect(handlers["benchmark-price-refresh"](
      contextFor("benchmark-price-refresh"),
    )).resolves.toEqual({
      counters: { failed: 1 },
    });
    expect(gateway.getSourceBulkPrices).toHaveBeenCalledOnce();
    expect(repository.beginRun).not.toHaveBeenCalled();
    expect(repository.persistPriceOutcomes).not.toHaveBeenCalled();
    expect(repository.finalizeRun).not.toHaveBeenCalled();
  });

  it("stops a long catalog source loop within 25 calls after access is revoked", async () => {
    const gateway = createGateway();
    const repository = createRepository();
    const sourceAccessPolicy = createPolicy("approved", "approved", "revoked");
    const targetProvider = createTargets();
    vi.mocked(targetProvider.getCatalogTargets).mockResolvedValue(
      Array.from({ length: 30 }, (_, index) => ({ ean: testGtin(index) })),
    );
    const handlers = createKassalappHandlers(createDependencies({
      gateway,
      repository,
      sourceAccessPolicy,
      targetProvider,
    }));

    await expect(handlers["catalog-refresh"](context)).resolves.toEqual({
      counters: { failed: 1 },
    });
    expect(gateway.getSourceProductByEan).toHaveBeenCalledTimes(25);
    expect(sourceAccessPolicy.getAccessState).toHaveBeenCalledTimes(3);
    expect(repository.beginRun).not.toHaveBeenCalled();
    expect(repository.persistCatalogOutcomes).not.toHaveBeenCalled();
  });

  it("marks persisted evidence degraded when permission is revoked before completion", async () => {
    const persistedCounters: WorkerRunCounters = {
      ...completeCounters,
      failed: 1,
    };
    const repository = createRepository(persistedCounters);
    const handlers = createKassalappHandlers(createDependencies({
      repository,
      sourceAccessPolicy: createPolicy("approved", "approved", "approved", "revoked"),
    }));

    await expect(handlers["benchmark-price-refresh"](
      contextFor("benchmark-price-refresh"),
    )).resolves.toEqual({
      counters: persistedCounters,
    });
    expect(repository.persistPriceOutcomes).toHaveBeenCalledOnce();
    expect(repository.finalizeRun).toHaveBeenCalledOnce();
    expect(repository.finalizeRun).toHaveBeenCalledWith(RUN_HANDLE, {
      completedAt: new Date(NOW),
      errorClass: "SOURCE_ACCESS_CHANGED",
      failed: 1,
      status: "degraded",
    }, SIGNAL);
  });

  it("rechecks access between 25-row persistence transactions and stops on revocation", async () => {
    const eans = Array.from({ length: 26 }, (_, index) => testGtin(100 + index));
    const gateway = createGateway();
    vi.mocked(gateway.getSourceBulkPrices).mockImplementation(async (batch) =>
      batch.map((ean) => ({
        state: "accepted" as const,
        record: priceRecord({
          ean,
          sourceRecordId: `${ean}:COOP_EXTRA:current:2026-07-15T08:30:00.000Z`,
        }),
      })));
    const repository = createRepository({
      accepted: 25,
      failed: 1,
      fetched: 25,
      persisted: 25,
      quarantined: 0,
      unknown: 0,
    });
    const sourceAccessPolicy = {
      getAccessState: vi.fn(async () =>
        vi.mocked(repository.persistPriceOutcomes).mock.calls.length === 0
          ? "approved" as const
          : "revoked" as const),
    };
    const targetProvider = createTargets();
    vi.mocked(targetProvider.getBenchmarkPriceTargets).mockResolvedValue(
      eans.map((ean) => ({ ean, geographicScopeId: 7 })),
    );
    const handlers = createKassalappHandlers(createDependencies({
      gateway,
      repository,
      sourceAccessPolicy,
      targetProvider,
    }));

    await expect(handlers["benchmark-price-refresh"](
      contextFor("benchmark-price-refresh"),
    )).resolves.toEqual({
      counters: expect.objectContaining({ accepted: 25, failed: 1 }),
    });
    expect(gateway.getSourceBulkPrices).toHaveBeenCalledTimes(2);
    expect(repository.persistPriceOutcomes).toHaveBeenCalledOnce();
    expect(vi.mocked(repository.persistPriceOutcomes).mock.calls[0]?.[1]).toHaveLength(25);
    expect(repository.finalizeRun).toHaveBeenCalledWith(RUN_HANDLE, {
      completedAt: NOW,
      errorClass: "SOURCE_ACCESS_CHANGED",
      failed: 1,
      status: "degraded",
    }, SIGNAL);
  });

  it("fails invalid or conflicting known targets before source access", async () => {
    const gateway = createGateway();
    const repository = createRepository();
    const targetProvider = createTargets();
    vi.mocked(targetProvider.getBenchmarkPriceTargets).mockResolvedValue([
      { ean: "not-an-ean", geographicScopeId: 7 },
    ]);
    const handlers = createKassalappHandlers(createDependencies({ gateway, repository, targetProvider }));

    await expect(handlers["benchmark-price-refresh"](
      contextFor("benchmark-price-refresh"),
    )).resolves.toEqual({
      counters: { failed: 1 },
    });
    expect(gateway.getSourceBulkPrices).not.toHaveBeenCalled();
    expect(repository.beginRun).not.toHaveBeenCalled();
  });

  it("passes partial batch failures to finalization and returns only persisted counters", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.getSourceBulkPrices).mockResolvedValue([
      { state: "accepted", record: priceRecord() },
      { state: "unknown", sourceRecordId: OTHER_EAN, reason: "BATCH_FAILED", ean: OTHER_EAN },
    ]);
    const targetProvider = createTargets();
    vi.mocked(targetProvider.getBenchmarkPriceTargets).mockResolvedValue([
      { ean: EAN, geographicScopeId: 7 },
      { ean: OTHER_EAN, geographicScopeId: 8 },
    ]);
    const persistedCounters = {
      accepted: 1,
      failed: 1,
      fetched: 2,
      persisted: 2,
      quarantined: 0,
      unknown: 1,
    } as const;
    const repository = createRepository(persistedCounters);
    const handlers = createKassalappHandlers(createDependencies({ gateway, repository, targetProvider }));

    const result = await handlers["benchmark-price-refresh"](
      contextFor("benchmark-price-refresh"),
    );

    expect(repository.finalizeRun).toHaveBeenCalledWith(RUN_HANDLE, {
      completedAt: NOW,
      failed: 1,
      status: "degraded",
    }, SIGNAL);
    expect(result).toEqual({ counters: persistedCounters });
  });

  it("preserves earlier exact catalog outcomes when a later target fails", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.getSourceProductByEan).mockImplementation(async (ean) => {
      if (ean === OTHER_EAN) throw new Error("private per-target failure");
      return [{ state: "accepted", record: productRecord() }];
    });
    const targetProvider = createTargets();
    vi.mocked(targetProvider.getCatalogTargets).mockResolvedValue([
      { ean: EAN },
      { ean: OTHER_EAN },
    ]);
    const persistedCounters: WorkerRunCounters = {
      accepted: 1,
      failed: 1,
      fetched: 2,
      persisted: 2,
      quarantined: 0,
      unknown: 1,
    };
    const repository = createRepository(persistedCounters);
    const handlers = createKassalappHandlers(createDependencies({
      gateway,
      repository,
      targetProvider,
    }));

    const result = await handlers["catalog-refresh"](context);

    expect(repository.persistCatalogOutcomes).toHaveBeenCalledWith(RUN_HANDLE, [
      expect.objectContaining({ outcomeState: "accepted", subjectEan: EAN }),
      expect.objectContaining({
        outcomeState: "unknown",
        reason: "BATCH_FAILED",
        sourceRecordId: OTHER_EAN,
        subjectEan: OTHER_EAN,
      }),
    ], SIGNAL);
    expect(repository.finalizeRun).toHaveBeenCalledWith(RUN_HANDLE, {
      completedAt: NOW,
      failed: 1,
      status: "degraded",
    }, SIGNAL);
    expect(result).toEqual({ counters: persistedCounters });
  });

  it("fails honestly with no evidence writes when the provider throws", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.getSourceBulkPrices).mockRejectedValue(new Error("private upstream detail"));
    const repository = createRepository();
    const handlers = createKassalappHandlers(createDependencies({ gateway, repository }));

    await expect(handlers["benchmark-price-refresh"](
      contextFor("benchmark-price-refresh"),
    )).resolves.toEqual({
      counters: { failed: 1 },
    });
    expect(repository.beginRun).not.toHaveBeenCalled();
    expect(repository.finalizeRun).not.toHaveBeenCalled();
  });

  it("finalizes a persistence failure with a sanitized class and repository counters", async () => {
    const repository = createRepository({
      accepted: 0,
      failed: 1,
      fetched: 0,
      persisted: 0,
      quarantined: 0,
      unknown: 0,
    });
    vi.mocked(repository.persistCatalogOutcomes).mockRejectedValue(new Error("private database detail"));
    const handlers = createKassalappHandlers(createDependencies({ repository }));

    const result = await handlers["catalog-refresh"](context);

    expect(repository.finalizeRun).toHaveBeenCalledWith(RUN_HANDLE, {
      completedAt: NOW,
      errorClass: "PERSISTENCE_FAILURE",
      failed: 1,
      status: "degraded",
    }, SIGNAL);
    expect(result).toEqual({ counters: expect.objectContaining({ failed: 1, fetched: 0 }) });
  });

  it("finalizes cancellation and exposes only repository counters to WorkerRunner", async () => {
    const controller = new AbortController();
    const repository = createRepository({
      accepted: 0,
      failed: 0,
      fetched: 0,
      persisted: 0,
      quarantined: 0,
      unknown: 0,
    });
    vi.mocked(repository.persistCatalogOutcomes).mockImplementation(async () => {
      controller.abort();
      throw new Error("cancelled private operation");
    });
    const handlers = createKassalappHandlers(createDependencies({ repository }));

    const execution = handlers["catalog-refresh"]({ ...context, signal: controller.signal });

    await expect(execution).rejects.toBeInstanceOf(WorkerCancelledError);
    await expect(execution).rejects.toMatchObject({ counters: {
      accepted: 0,
      failed: 0,
      fetched: 0,
      persisted: 0,
      quarantined: 0,
      unknown: 0,
    } });
    expect(repository.finalizeRun).toHaveBeenCalledWith(RUN_HANDLE, {
      completedAt: NOW,
      errorClass: "CANCELLED",
      failed: 0,
      status: "cancelled",
    }, undefined);
  });
});
