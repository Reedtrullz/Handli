import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  type PublicSourceStatusReader,
  PublicSourceStatusReaderError,
} from "@handleplan/db/source-status-reader";

import {
  SourceStatusRequestCancelledError,
  SourceStatusService,
  SourceStatusUnavailableError,
} from "./source-status-service";

const NOW = new Date("2026-07-17T12:00:00.000Z");

function reader(
  read: PublicSourceStatusReader["read"] = async () => ({ entries: [], hasMore: false }),
): PublicSourceStatusReader {
  return { read };
}

describe("SourceStatusService", () => {
  it("uses one evaluation clock and keeps an empty public directory truthful", async () => {
    const read = vi.fn<PublicSourceStatusReader["read"]>().mockResolvedValue({
      entries: [],
      hasMore: false,
    });
    const service = new SourceStatusService({ now: () => NOW, reader: reader(read) });

    await expect(service.read()).resolves.toEqual({
      claimBoundary: {
        priceCoverage: "not-established",
        publicRanking: "not-established",
        runtimeActivation: "not-established",
        stockStatus: "not-established",
      },
      completeness: "partial",
      contractVersion: 1,
      entries: [],
      generatedAt: NOW.toISOString(),
      hasMore: false,
      kind: "public-source-status",
      overall: "no-approved-sources",
    });
    expect(read).toHaveBeenCalledWith(50, NOW, undefined);
  });

  it("maps cancellation separately and collapses malformed/private reader output", async () => {
    await expect(new SourceStatusService({
      now: () => NOW,
      reader: reader(async () => {
        throw new PublicSourceStatusReaderError("CANCELLED");
      }),
    }).read()).rejects.toBeInstanceOf(SourceStatusRequestCancelledError);

    await expect(new SourceStatusService({
      now: () => NOW,
      reader: reader(async () => ({
        entries: [{ providerError: "private" }] as never,
        hasMore: false,
      })),
    }).read()).rejects.toBeInstanceOf(SourceStatusUnavailableError);
  });

  it("rejects an invalid evaluation clock before reading", async () => {
    const read = vi.fn<PublicSourceStatusReader["read"]>();
    await expect(new SourceStatusService({
      now: () => new Date("invalid"),
      reader: reader(read),
    }).read()).rejects.toBeInstanceOf(SourceStatusUnavailableError);
    expect(read).not.toHaveBeenCalled();
  });
});
