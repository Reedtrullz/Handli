"use client";

import {
  NATIONAL_MARKET_CONTEXT_V1,
  tripSnapshotSchema,
  type TripSnapshot,
} from "@handleplan/domain";
import { z } from "zod";

const DATABASE_NAME = "handleplan-handlemodus";
const DATABASE_VERSION = 1;
const STORE_NAME = "active-trip";
const ACTIVE_KEY = "active";

const storedTripV1Schema = z
  .object({
    repositoryVersion: z.literal(1),
    snapshot: tripSnapshotSchema,
    completedItemIds: z.array(z.string().min(1).max(300)).max(50),
  })
  .strict()
  .superRefine((record, context) => {
    const completed = new Set(record.completedItemIds);
    const allowed = new Set(record.snapshot.checklistItems.map(({ id }) => id));
    if (
      completed.size !== record.completedItemIds.length
      || record.completedItemIds.some((id) => !allowed.has(id))
    ) {
      context.addIssue({
        code: "custom",
        message: "Completion IDs must be a unique subset of the snapshot checklist",
        path: ["completedItemIds"],
      });
    }
  });

type StoredTripV1 = z.infer<typeof storedTripV1Schema>;

const legacyMarketlessStoredTripV2EnvelopeSchema = z
  .object({
    repositoryVersion: z.literal(1),
    snapshot: z.object({ contractVersion: z.literal(2) }).passthrough(),
    completedItemIds: z.array(z.string().min(1).max(300)).max(50),
  })
  .strict();

interface ParsedStoredTrip {
  migrated: boolean;
  record: StoredTripV1;
}

export interface ActiveTripV1 {
  snapshot: TripSnapshot;
  completedItemIds: readonly string[];
}

export type ActiveTrip = ActiveTripV1;

export type TripSnapshotRepositoryErrorCode =
  | "ACTIVE_TRIP_EXISTS"
  | "CORRUPT"
  | "INCOMPLETE"
  | "INVALID"
  | "NOT_FOUND"
  | "UNAVAILABLE";

const ERROR_MESSAGES: Readonly<Record<TripSnapshotRepositoryErrorCode, string>> = {
  ACTIVE_TRIP_EXISTS: "En aktiv handletur finnes allerede.",
  CORRUPT: "Den lagrede handleturen kunne ikke leses.",
  INCOMPLETE: "Handleturen kan ikke fullføres før alle varer er krysset av.",
  INVALID: "Handleturen er ugyldig.",
  NOT_FOUND: "Den aktive handleturen finnes ikke.",
  UNAVAILABLE: "Handlemodus er ikke tilgjengelig i denne nettleseren.",
};

export class TripSnapshotRepositoryError extends Error {
  constructor(readonly code: TripSnapshotRepositoryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "TripSnapshotRepositoryError";
  }
}

export interface TripSnapshotRepository {
  getActive(): Promise<ActiveTripV1 | undefined>;
  start(snapshot: TripSnapshot): Promise<ActiveTripV1>;
  setCompleted(snapshotId: string, checklistItemId: string, completed: boolean): Promise<ActiveTripV1>;
  finish(snapshotId: string): Promise<void>;
  delete(snapshotId: string): Promise<boolean>;
  clear(): Promise<void>;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function toPublicState(record: StoredTripV1): ActiveTripV1 {
  return Object.freeze({
    completedItemIds: Object.freeze([...record.completedItemIds]),
    snapshot: deepFreeze(record.snapshot),
  });
}

function parseStoredResult(value: unknown): ParsedStoredTrip {
  const parsed = storedTripV1Schema.safeParse(value);
  if (parsed.success) return { migrated: false, record: parsed.data };

  const legacy = legacyMarketlessStoredTripV2EnvelopeSchema.safeParse(value);
  if (
    !legacy.success
    || Object.prototype.hasOwnProperty.call(legacy.data.snapshot, "marketContext")
  ) {
    throw new TripSnapshotRepositoryError("CORRUPT");
  }
  const migrated = storedTripV1Schema.safeParse({
    ...legacy.data,
    snapshot: {
      ...legacy.data.snapshot,
      marketContext: NATIONAL_MARKET_CONTEXT_V1,
    },
  });
  if (!migrated.success) throw new TripSnapshotRepositoryError("CORRUPT");
  return { migrated: true, record: migrated.data };
}

function parseStored(value: unknown): StoredTripV1 {
  return parseStoredResult(value).record;
}

export class IndexedDbTripSnapshotRepository implements TripSnapshotRepository {
  private databasePromise: Promise<IDBDatabase> | undefined;

  constructor(private readonly factory: IDBFactory | undefined = globalThis.indexedDB) {}

  private database(): Promise<IDBDatabase> {
    if (this.factory === undefined) {
      return Promise.reject(new TripSnapshotRepositoryError("UNAVAILABLE"));
    }
    this.databasePromise ??= new Promise((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = this.factory!.open(DATABASE_NAME, DATABASE_VERSION);
      } catch {
        reject(new TripSnapshotRepositoryError("UNAVAILABLE"));
        return;
      }
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(new TripSnapshotRepositoryError("UNAVAILABLE"));
      request.onblocked = () => reject(new TripSnapshotRepositoryError("UNAVAILABLE"));
    });
    return this.databasePromise;
  }

  private async removeCorruptRecord(): Promise<void> {
    try {
      const database = await this.database();
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const done = transactionDone(transaction);
      await requestResult(transaction.objectStore(STORE_NAME).delete(ACTIVE_KEY));
      await done;
    } catch {
      // Corrupt data is never returned. Cleanup is best effort if storage is failing.
    }
  }

  async getActive(): Promise<ActiveTripV1 | undefined> {
    try {
      const database = await this.database();
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const done = transactionDone(transaction);
      const store = transaction.objectStore(STORE_NAME);
      const value = await requestResult(store.get(ACTIVE_KEY));
      if (value === undefined) {
        await done;
        return undefined;
      }
      const parsed = parseStoredResult(value);
      if (parsed.migrated) await requestResult(store.put(parsed.record, ACTIVE_KEY));
      await done;
      return toPublicState(parsed.record);
    } catch (error) {
      if (error instanceof TripSnapshotRepositoryError && error.code === "CORRUPT") {
        await this.removeCorruptRecord();
        throw error;
      }
      if (error instanceof TripSnapshotRepositoryError) throw error;
      throw new TripSnapshotRepositoryError("UNAVAILABLE");
    }
  }

  async start(snapshot: TripSnapshot): Promise<ActiveTripV1> {
    const parsed = tripSnapshotSchema.safeParse(snapshot);
    if (!parsed.success) throw new TripSnapshotRepositoryError("INVALID");
    try {
      const database = await this.database();
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const done = transactionDone(transaction);
      const store = transaction.objectStore(STORE_NAME);
      const existing = await requestResult(store.get(ACTIVE_KEY));
      if (existing !== undefined) {
        parseStored(existing);
        await done;
        throw new TripSnapshotRepositoryError("ACTIVE_TRIP_EXISTS");
      }
      const record = storedTripV1Schema.parse({
        completedItemIds: [],
        repositoryVersion: 1,
        snapshot: parsed.data,
      });
      await requestResult(store.put(record, ACTIVE_KEY));
      await done;
      return toPublicState(record);
    } catch (error) {
      if (error instanceof TripSnapshotRepositoryError) {
        if (error.code === "CORRUPT") await this.removeCorruptRecord();
        throw error;
      }
      throw new TripSnapshotRepositoryError("UNAVAILABLE");
    }
  }

  async setCompleted(
    snapshotId: string,
    checklistItemId: string,
    completed: boolean,
  ): Promise<ActiveTripV1> {
    try {
      const database = await this.database();
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const done = transactionDone(transaction);
      const store = transaction.objectStore(STORE_NAME);
      const value = await requestResult(store.get(ACTIVE_KEY));
      if (value === undefined) {
        await done;
        throw new TripSnapshotRepositoryError("NOT_FOUND");
      }
      const record = parseStored(value);
      if (record.snapshot.id !== snapshotId) {
        await done;
        throw new TripSnapshotRepositoryError("NOT_FOUND");
      }
      const itemOrder = record.snapshot.checklistItems.map(({ id }) => id);
      if (!itemOrder.includes(checklistItemId)) {
        await done;
        throw new TripSnapshotRepositoryError("INVALID");
      }
      const next = new Set(record.completedItemIds);
      if (completed) next.add(checklistItemId);
      else next.delete(checklistItemId);
      const updated = storedTripV1Schema.parse({
        ...record,
        completedItemIds: itemOrder.filter((id) => next.has(id)),
      });
      await requestResult(store.put(updated, ACTIVE_KEY));
      await done;
      return toPublicState(updated);
    } catch (error) {
      if (error instanceof TripSnapshotRepositoryError) {
        if (error.code === "CORRUPT") await this.removeCorruptRecord();
        throw error;
      }
      throw new TripSnapshotRepositoryError("UNAVAILABLE");
    }
  }

  async finish(snapshotId: string): Promise<void> {
    try {
      const active = await this.getActive();
      if (active === undefined || active.snapshot.id !== snapshotId) {
        throw new TripSnapshotRepositoryError("NOT_FOUND");
      }
      if (active.completedItemIds.length !== active.snapshot.checklistItems.length) {
        throw new TripSnapshotRepositoryError("INCOMPLETE");
      }
      await this.delete(snapshotId);
    } catch (error) {
      if (error instanceof TripSnapshotRepositoryError) throw error;
      throw new TripSnapshotRepositoryError("UNAVAILABLE");
    }
  }

  async delete(snapshotId: string): Promise<boolean> {
    try {
      const database = await this.database();
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const done = transactionDone(transaction);
      const store = transaction.objectStore(STORE_NAME);
      const value = await requestResult(store.get(ACTIVE_KEY));
      if (value === undefined) {
        await done;
        return false;
      }
      const record = parseStored(value);
      if (record.snapshot.id !== snapshotId) {
        await done;
        return false;
      }
      await requestResult(store.delete(ACTIVE_KEY));
      await done;
      return true;
    } catch (error) {
      if (error instanceof TripSnapshotRepositoryError) {
        if (error.code === "CORRUPT") await this.removeCorruptRecord();
        throw error;
      }
      throw new TripSnapshotRepositoryError("UNAVAILABLE");
    }
  }

  async clear(): Promise<void> {
    try {
      const database = await this.database();
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const done = transactionDone(transaction);
      await requestResult(transaction.objectStore(STORE_NAME).clear());
      await done;
    } catch (error) {
      if (error instanceof TripSnapshotRepositoryError) throw error;
      throw new TripSnapshotRepositoryError("UNAVAILABLE");
    }
  }
}

export function createBrowserTripSnapshotRepository(): TripSnapshotRepository {
  return new IndexedDbTripSnapshotRepository();
}
