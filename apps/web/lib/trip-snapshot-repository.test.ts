import { describe, expect, it } from "vitest";

import {
  legacyTripSnapshotFixture,
  tripSnapshotFixture,
} from "../test-support/trip-snapshot-fixture";
import {
  IndexedDbTripSnapshotRepository,
  TripSnapshotRepositoryError,
} from "./trip-snapshot-repository";

type Handler = ((event?: unknown) => void) | null;

class FakeRequest<T> {
  result!: T;
  error: DOMException | null = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
}

class FakeTransaction {
  error: DOMException | null = null;
  oncomplete: Handler = null;
  onabort: Handler = null;
  onerror: Handler = null;
  private pending = 0;
  private completionScheduled = false;

  constructor(private readonly records: Map<IDBValidKey, unknown>) {}

  objectStore(): IDBObjectStore {
    const request = <T>(operation: () => T): IDBRequest<T> => {
      const result = new FakeRequest<T>();
      this.pending += 1;
      setTimeout(() => {
        try {
          result.result = operation();
          result.onsuccess?.();
        } catch (error) {
          result.error = new DOMException(error instanceof Error ? error.message : "fake failure");
          result.onerror?.();
        } finally {
          this.pending -= 1;
          this.scheduleCompletion();
        }
      }, 0);
      return result as unknown as IDBRequest<T>;
    };
    return {
      clear: () => request(() => {
        this.records.clear();
        return undefined;
      }),
      delete: (key: IDBValidKey) => request(() => {
        this.records.delete(key);
        return undefined;
      }),
      get: (key: IDBValidKey) => request(() => {
        const value = this.records.get(key);
        return value === undefined ? undefined : structuredClone(value);
      }),
      put: (value: unknown, key: IDBValidKey) => request(() => {
        this.records.set(key, structuredClone(value));
        return key;
      }),
    } as unknown as IDBObjectStore;
  }

  private scheduleCompletion(): void {
    if (this.completionScheduled) return;
    this.completionScheduled = true;
    setTimeout(() => {
      this.completionScheduled = false;
      if (this.pending === 0) this.oncomplete?.();
      else this.scheduleCompletion();
    }, 0);
  }
}

class FakeDatabase {
  readonly records = new Map<IDBValidKey, unknown>();
  private hasStore = false;
  onversionchange: Handler = null;

  get objectStoreNames(): DOMStringList {
    const names = { contains: (name: string) => this.hasStore && name === "active-trip" };
    return names as unknown as DOMStringList;
  }

  createObjectStore(name: string): IDBObjectStore {
    if (name !== "active-trip") throw new Error("unexpected store");
    this.hasStore = true;
    return {} as IDBObjectStore;
  }

  transaction(name: string): IDBTransaction {
    if (!this.hasStore || name !== "active-trip") throw new Error("missing store");
    return new FakeTransaction(this.records) as unknown as IDBTransaction;
  }

  close(): void {}
}

class FakeIndexedDbFactory {
  readonly database = new FakeDatabase();
  private opened = false;

  open(): IDBOpenDBRequest {
    const request = new FakeRequest<IDBDatabase>() as FakeRequest<IDBDatabase> & {
      onblocked: Handler;
      onupgradeneeded: Handler;
    };
    request.onblocked = null;
    request.onupgradeneeded = null;
    setTimeout(() => {
      request.result = this.database as unknown as IDBDatabase;
      if (!this.opened) {
        request.onupgradeneeded?.();
        this.opened = true;
      }
      request.onsuccess?.();
    }, 0);
    return request as unknown as IDBOpenDBRequest;
  }
}

function expectCode(code: TripSnapshotRepositoryError["code"]) {
  return expect.objectContaining({ code, name: "TripSnapshotRepositoryError" });
}

describe("IndexedDbTripSnapshotRepository", () => {
  it("starts one immutable active snapshot and changes only its completion set", async () => {
    const factory = new FakeIndexedDbFactory();
    const repository = new IndexedDbTripSnapshotRepository(factory as unknown as IDBFactory);
    const snapshot = tripSnapshotFixture();

    const started = await repository.start(snapshot);
    expect(started.completedItemIds).toEqual([]);
    expect(started.snapshot.contractVersion).toBe(2);
    expect(Object.isFrozen(started.snapshot)).toBe(true);
    await expect(repository.start(snapshot)).rejects.toEqual(expectCode("ACTIVE_TRIP_EXISTS"));

    const itemId = snapshot.checklistItems[0]!.id;
    const completed = await repository.setCompleted(snapshot.id, itemId, true);
    expect(completed.completedItemIds).toEqual([itemId]);
    expect(completed.snapshot).toEqual(snapshot);
    expect(await repository.getActive()).toEqual(completed);

    const reopened = await repository.setCompleted(snapshot.id, itemId, false);
    expect(reopened.completedItemIds).toEqual([]);
    expect(reopened.snapshot.plan).toEqual(snapshot.plan);
  });

  it("continues to read an active legacy V1 snapshot without rewriting it", async () => {
    const factory = new FakeIndexedDbFactory();
    const repository = new IndexedDbTripSnapshotRepository(factory as unknown as IDBFactory);
    await repository.getActive();
    const legacy = legacyTripSnapshotFixture();
    factory.database.records.set("active", {
      completedItemIds: [],
      repositoryVersion: 1,
      snapshot: legacy,
    });

    const active = await repository.getActive();
    expect(active?.snapshot).toEqual(legacy);
    expect(active?.snapshot.contractVersion).toBe(1);
  });

  it("migrates only a valid pre-market V2 trip to national scope and preserves completion", async () => {
    const factory = new FakeIndexedDbFactory();
    const repository = new IndexedDbTripSnapshotRepository(factory as unknown as IDBFactory);
    await repository.getActive();
    const snapshot = tripSnapshotFixture();
    const { marketContext: _marketContext, ...legacySnapshot } = snapshot;
    void _marketContext;
    const completedItemIds = [snapshot.checklistItems[0]!.id];
    factory.database.records.set("active", {
      completedItemIds,
      repositoryVersion: 1,
      snapshot: legacySnapshot,
    });

    const active = await repository.getActive();
    expect(active).toEqual({ completedItemIds, snapshot });
    expect(factory.database.records.get("active")).toMatchObject({
      completedItemIds,
      snapshot: {
        marketContext: {
          contractVersion: 1,
          countryCode: "NO",
          kind: "national",
        },
      },
    });
  });

  it("requires a complete checklist to finish and then deletes without history", async () => {
    const repository = new IndexedDbTripSnapshotRepository(
      new FakeIndexedDbFactory() as unknown as IDBFactory,
    );
    const snapshot = tripSnapshotFixture();
    await repository.start(snapshot);

    await expect(repository.finish(snapshot.id)).rejects.toEqual(expectCode("INCOMPLETE"));
    await repository.setCompleted(snapshot.id, snapshot.checklistItems[0]!.id, true);
    await repository.finish(snapshot.id);
    await expect(repository.getActive()).resolves.toBeUndefined();
  });

  it("supports scoped deletion and explicit clear", async () => {
    const repository = new IndexedDbTripSnapshotRepository(
      new FakeIndexedDbFactory() as unknown as IDBFactory,
    );
    const snapshot = tripSnapshotFixture();
    await repository.start(snapshot);
    await expect(repository.delete("trip:other")).resolves.toBe(false);
    await expect(repository.delete(snapshot.id)).resolves.toBe(true);
    await expect(repository.delete(snapshot.id)).resolves.toBe(false);

    await repository.start(snapshot);
    await repository.clear();
    await expect(repository.getActive()).resolves.toBeUndefined();
  });

  it("deletes corrupt and version-mismatched records without returning partial data", async () => {
    for (const corrupt of [
      { repositoryVersion: 2, snapshot: tripSnapshotFixture(), completedItemIds: [] },
      { repositoryVersion: 1, snapshot: { contractVersion: 99 }, completedItemIds: [] },
      {
        repositoryVersion: 1,
        snapshot: tripSnapshotFixture(),
        completedItemIds: ["unknown-item"],
      },
    ]) {
      const factory = new FakeIndexedDbFactory();
      const repository = new IndexedDbTripSnapshotRepository(factory as unknown as IDBFactory);
      await repository.getActive();
      factory.database.records.set("active", corrupt);

      await expect(repository.getActive()).rejects.toEqual(expectCode("CORRUPT"));
      expect(factory.database.records.has("active")).toBe(false);
    }
  });

  it("fails safely when IndexedDB is unavailable or identifiers do not match", async () => {
    const unavailable = new IndexedDbTripSnapshotRepository(undefined);
    await expect(unavailable.getActive()).rejects.toEqual(expectCode("UNAVAILABLE"));

    const repository = new IndexedDbTripSnapshotRepository(
      new FakeIndexedDbFactory() as unknown as IDBFactory,
    );
    const snapshot = tripSnapshotFixture();
    await repository.start(snapshot);
    await expect(repository.setCompleted(snapshot.id, "unknown", true))
      .rejects.toEqual(expectCode("INVALID"));
    await expect(repository.setCompleted("trip:other", snapshot.checklistItems[0]!.id, true))
      .rejects.toEqual(expectCode("NOT_FOUND"));
  });
});
