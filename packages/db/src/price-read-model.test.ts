import type { MoneyOre, PriceObservation } from "@handleplan/domain";
import { describe, expect, it, vi } from "vitest";

import type { PriceCache } from "./price-cache";
import {
  EvidenceReadModelPriceCache,
  comparePriceReadModels,
} from "./price-read-model";

function row(amountOre: number): PriceObservation {
  return {
    amountOre: amountOre as MoneyOre,
    chain: "extra",
    ean: "7038010000134",
    observedAt: "2026-07-15T08:30:00.000Z",
    source: "kassalapp",
  };
}

function fakeCache(rows: PriceObservation[]): PriceCache {
  return {
    getMany: vi.fn(async () => rows),
    putMany: vi.fn(async () => undefined),
  };
}

describe("evidence read model cutover", () => {
  it("compares only aggregate mismatch counts", () => {
    expect(comparePriceReadModels([row(1000)], [row(1000)])).toEqual({
      evidenceOnly: 0,
      legacyOnly: 0,
      valueMismatch: 0,
    });
    expect(comparePriceReadModels([row(1000)], [row(900)])).toEqual({
      evidenceOnly: 0,
      legacyOnly: 0,
      valueMismatch: 1,
    });
    expect(comparePriceReadModels([row(1000)], [])).toEqual({
      evidenceOnly: 0,
      legacyOnly: 1,
      valueMismatch: 0,
    });
  });

  it("returns legacy data while shadow-comparing evidence", async () => {
    const legacy = fakeCache([row(1000)]);
    const evidence = fakeCache([row(900)]);
    const onComparison = vi.fn();
    const cache = new EvidenceReadModelPriceCache({
      evidence,
      legacy,
      mode: "shadow",
      onComparison,
    });

    await expect(cache.getMany([row(1000).ean])).resolves.toEqual([row(1000)]);
    expect(onComparison).toHaveBeenCalledWith({
      evidenceOnly: 0,
      legacyOnly: 0,
      valueMismatch: 1,
    });
  });

  it("returns legacy data when the shadow evidence read fails", async () => {
    const legacy = fakeCache([row(1000)]);
    const evidence = fakeCache([]);
    vi.mocked(evidence.getMany).mockRejectedValue(new Error("evidence unavailable"));
    const onEvidenceError = vi.fn();
    const cache = new EvidenceReadModelPriceCache({
      evidence,
      legacy,
      mode: "shadow",
      onEvidenceError,
    });

    await expect(cache.getMany([row(1000).ean])).resolves.toEqual([row(1000)]);
    expect(onEvidenceError).toHaveBeenCalledOnce();
  });

  it("switches reads without changing the dual-write owner", async () => {
    const legacy = fakeCache([row(1000)]);
    const evidence = fakeCache([row(900)]);
    const evidenceMode = new EvidenceReadModelPriceCache({
      evidence,
      legacy,
      mode: "evidence",
    });

    await expect(evidenceMode.getMany([row(1000).ean])).resolves.toEqual([row(900)]);
    await evidenceMode.putMany([row(800)]);
    expect(legacy.putMany).toHaveBeenCalledWith([row(800)], undefined);
    expect(evidence.putMany).not.toHaveBeenCalled();
  });
});
