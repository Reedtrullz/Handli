import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  OperationsRuntimeReaderError,
  type OperationsRuntimeReader,
} from "@handleplan/db/operations-runtime";
import type { OperationsRuntimeSnapshotV1 } from "@handleplan/domain";

import {
  OperationsRuntimeService,
  OperationsRuntimeServiceError,
} from "./operations-runtime-service";

const snapshot = {
  claimBoundary: {
    alertDelivery: "disabled",
    historicalReconstruction: "not-established",
    publicAvailability: "not-established",
    publicOfferEligibility: "not-established",
  },
  completeness: "bounded-aggregate",
  contractVersion: 1,
  kind: "internal-operations-snapshot",
  observedAt: "2026-07-17T12:00:00.000Z",
  sourceRoster: {
    contentSha256: "a".repeat(64),
    entries: [],
    version: "fixture:v1",
  },
  sources: [],
} as unknown as OperationsRuntimeSnapshotV1;

describe("OperationsRuntimeService", () => {
  it("returns only its aggregate reader result", async () => {
    const read = vi.fn(async () => snapshot);
    const signal = new AbortController().signal;
    await expect(new OperationsRuntimeService({ read }).read(signal)).resolves.toBe(snapshot);
    expect(read).toHaveBeenCalledWith(signal);
  });

  it("maps reader failures to fixed service codes", async () => {
    for (const error of [
      new OperationsRuntimeReaderError("CORRUPT_RECORD"),
      new Error("private database detail"),
    ]) {
      const reader: OperationsRuntimeReader = { read: async () => { throw error; } };
      await expect(new OperationsRuntimeService(reader).read()).rejects.toEqual(
        new OperationsRuntimeServiceError("UNAVAILABLE"),
      );
    }
  });

  it("preserves cancellation as a fixed cancellation code", async () => {
    const reader: OperationsRuntimeReader = {
      read: async () => { throw new OperationsRuntimeReaderError("CANCELLED"); },
    };
    await expect(new OperationsRuntimeService(reader).read()).rejects.toMatchObject({
      code: "CANCELLED",
    });

    const controller = new AbortController();
    controller.abort();
    await expect(new OperationsRuntimeService(reader).read(controller.signal))
      .rejects.toMatchObject({ code: "CANCELLED" });
  });
});
