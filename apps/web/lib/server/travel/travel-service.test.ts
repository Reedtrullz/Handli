import {
  projectRepresentativesV2,
  type InternalTravelBranch,
  type MarketContextV1,
  type MoneyOre,
  type PlanResultV2,
  type RouteMatrix,
  type TravelChainId,
  type TravelCoordinate,
} from "@handleplan/domain";
import { describe, expect, it } from "vitest";

import {
  BranchDirectoryUnavailableError,
  TravelGatewayTimeoutError,
} from "./gateways";
import {
  FakeBranchDirectory,
  FakeRouteFingerprintSource,
  FakeRouteMatrixGateway,
} from "./fakes";
import {
  TravelService,
  TravelServiceInputError,
  type TravelServiceResult,
} from "./travel-service";

const NOW = new Date("2026-07-17T12:00:00.000Z");
const MARKET = { contractVersion: 1 as const, countryCode: "NO" as const, kind: "national" as const };
const ORIGIN: TravelCoordinate = {
  latitudeE6: 59_913_900,
  longitudeE6: 10_752_200,
};
const CHAINS = ["extra", "rema-1000", "bunnpris"] as const;
const money = (value: number) => value as MoneyOre;

function plan(
  id: string,
  totalOre: number,
  chains: readonly TravelChainId[],
): PlanResultV2 {
  const baseCost = Math.floor(totalOre / chains.length);
  const remainder = totalOre - baseCost * chains.length;
  const assignments = chains.map((chain, index) => {
    const costOre = baseCost + (index === 0 ? remainder : 0);
    return {
      needId: `need:${id}:${index}`,
      canonicalProductId: `product:${id}:${index}`,
      ean: "7038010000010",
      chain,
      costOre: money(costOre),
      observedAt: "2026-07-17T11:00:00.000Z",
      source: "fixture-price-source",
      fulfilment: {
        contractVersion: 2 as const,
        needId: `need:${id}:${index}`,
        canonicalProductId: `product:${id}:${index}`,
        requested: { amount: 1, unit: "package" as const },
        packageMeasure: { amount: 1, unit: "package" as const },
        packageCount: 1,
        purchased: { amount: 1, unit: "package" as const },
        surplus: { amount: 0, unit: "package" as const },
        complete: true as const,
      },
      checkout: {
        ordinaryTotalOre: money(costOre),
        savingOre: money(0),
        totalOre: money(costOre),
      },
    };
  });
  return {
    id,
    assignments,
    totalOre: money(totalOre),
    chains: [...chains],
    substitutions: [],
    coverage: 1,
    freshness: Object.fromEntries(assignments.map(({ needId }) => [needId, "eligible"])),
  };
}

function branch(
  branchId: string,
  chainId: TravelChainId,
  northOffsetE6: number,
  eastOffsetE6 = 0,
): InternalTravelBranch {
  return {
    branchId,
    chainId,
    coordinate: {
      latitudeE6: ORIGIN.latitudeE6 + northOffsetE6,
      longitudeE6: ORIGIN.longitudeE6 + eastOffsetE6,
    },
    name: `${chainId} ${branchId}`,
  };
}

function matrix(
  durations: readonly (readonly (number | null)[])[],
  distances: readonly (readonly (number | null)[])[] = durations,
): RouteMatrix {
  return {
    cells: durations.map((row, from) => row.map((durationSeconds, to) => {
      const distanceMeters = distances[from]?.[to];
      return durationSeconds === null || distanceMeters == null
        ? null
        : { distanceMeters, durationSeconds };
    })),
    contractVersion: 1,
  };
}

function uniformMatrix(size: number, durationSeconds = 10): RouteMatrix {
  return matrix(Array.from({ length: size }, (_row, from) =>
    Array.from({ length: size }, (_cell, to) => from === to ? 0 : durationSeconds)));
}

function snapshot(branches: readonly InternalTravelBranch[], complete = true) {
  return {
    branches: [...branches],
    complete,
    contractVersion: 1 as const,
    eligibleChainIds: [...new Set(branches.map(({ chainId }) => chainId))],
    marketContext: MARKET,
  };
}

function service(
  branches: readonly InternalTravelBranch[],
  routeMatrix: RouteMatrix,
  options: { eligibleChainIds?: readonly TravelChainId[] } = {},
) {
  const directory = new FakeBranchDirectory({
    ...snapshot(branches),
    eligibleChainIds: [...(options.eligibleChainIds ?? new Set(
      branches.map(({ chainId }) => chainId),
    ))],
  });
  const router = new FakeRouteMatrixGateway("fixture-router", routeMatrix);
  const fingerprints = new FakeRouteFingerprintSource([
    "route:random-1",
    "route:random-2",
    "route:random-3",
    "route:random-4",
    "route:random-5",
    "route:random-6",
    "route:random-7",
  ]);
  return {
    directory,
    fingerprints,
    router,
    travel: new TravelService({
      branchDirectory: directory,
      createRouteFingerprint: () => fingerprints.next(),
      routeMatrixGateway: router,
    }),
  };
}

async function calculate(
  travel: TravelService,
  candidates: readonly PlanResultV2[],
  signal?: AbortSignal,
  marketContext: MarketContextV1 = MARKET,
): Promise<TravelServiceResult> {
  return travel.calculate({
    candidates,
    capturedEvaluationTime: NOW,
    marketContext,
    mode: "car",
    origin: ORIGIN,
  }, signal);
}

describe("TravelService", () => {
  it("routes a launch region only from a snapshot carrying matching current proof", async () => {
    const regionalMarket = {
      contractVersion: 1 as const,
      countryCode: "NO" as const,
      kind: "launch-region" as const,
      regionId: "no-0301-oslo",
    };
    const regionalBranch = branch("branch:extra", "extra", 1_000);
    const directory = new FakeBranchDirectory({
      branches: [regionalBranch],
      complete: true,
      contractVersion: 1,
      eligibleChainIds: ["extra"],
      marketContext: regionalMarket,
      regionEvidence: {
        contractVersion: 1,
        countryCode: "NO",
        directoryEvidenceReference: "manifest:directory",
        directoryVersionId: "postal-directory-2026-07",
        regionEvidenceReference: "manifest:oslo",
        regionId: regionalMarket.regionId,
        reviewedAt: "2026-07-16T12:00:00.000Z",
      },
    });
    const router = new FakeRouteMatrixGateway("fixture-router", uniformMatrix(2));
    const travel = new TravelService({
      branchDirectory: directory,
      createRouteFingerprint: () => "route:regional-proof",
      routeMatrixGateway: router,
    });

    const result = await calculate(
      travel,
      [plan("regional", 10_000, ["extra"])],
      undefined,
      regionalMarket,
    );

    expect(result.travel.kind).toBe("calculated");
    expect(directory.calls[0]?.marketContext).toEqual(regionalMarket);
  });

  it("routes complete one-, two-, and three-store candidates using one matrix and 1/2/6 order enumeration", async () => {
    const candidates = [
      plan("one", 13_000, ["extra"]),
      plan("two", 10_000, ["extra", "rema-1000"]),
      plan("three", 8_000, ["extra", "rema-1000", "bunnpris"]),
    ];
    const branches = [
      branch("branch:bunnpris", "bunnpris", 3_000),
      branch("branch:extra", "extra", 1_000),
      branch("branch:rema", "rema-1000", 2_000),
    ];
    // Points are origin, Bunnpris, Extra, then REMA 1000. The directed
    // Extra -> REMA -> Bunnpris order is the unique shortest three-stop tour.
    const routeMatrix = matrix([
      [0, 50, 1, 50],
      [1, 0, 50, 50],
      [50, 50, 0, 1],
      [50, 1, 50, 0],
    ]);
    const { directory, router, travel } = service(branches, routeMatrix);

    const result = await calculate(travel, candidates);

    expect(directory.calls).toHaveLength(1);
    expect(directory.calls[0]).toMatchObject({
      eligibleChainIds: ["bunnpris", "extra", "rema-1000"],
      evaluatedAt: NOW,
    });
    expect("origin" in directory.calls[0]!).toBe(false);
    expect(router.calls).toHaveLength(1);
    expect(router.calls[0]?.mode).toBe("car");
    expect(router.calls[0]?.points).toHaveLength(4);
    expect(result.plans).toHaveLength(3);
    expect(result.plans.every(({ travel: evidence }) => evidence?.kind === "calculated"))
      .toBe(true);
    expect(result.travel.kind).toBe("calculated");
    if (result.travel.kind !== "calculated") throw new Error("expected calculated travel");
    expect(result.travel.routes).toHaveLength(3);
    expect(result.travel.routes.find(({ planId }) => planId === "one")?.stops).toHaveLength(1);
    expect(result.travel.routes.find(({ planId }) => planId === "two")?.stops).toHaveLength(2);
    expect(result.travel.routes.find(({ planId }) => planId === "three")?.stops).toEqual([
      expect.objectContaining({ branchId: "branch:extra", sequence: 1 }),
      expect.objectContaining({ branchId: "branch:rema", sequence: 2 }),
      expect.objectContaining({ branchId: "branch:bunnpris", sequence: 3 }),
    ]);
  });

  it("filters in memory, keeps the nearest three branches per chain, and never requests more than ten points", async () => {
    const eastOffsets: Readonly<Record<TravelChainId, number>> = {
      bunnpris: 20_000,
      extra: 0,
      "rema-1000": 10_000,
    };
    const nearBranches = CHAINS.flatMap((chainId) => [1, 2, 3, 4].map((index) =>
      branch(
        `branch:${chainId}:${index}`,
        chainId,
        index * 1_000,
        eastOffsets[chainId],
      )));
    const outsideRadius = branch("branch:extra:outside-radius", "extra", 600_000);
    const directory = new FakeBranchDirectory({
      ...snapshot([...nearBranches, outsideRadius]),
      eligibleChainIds: [...CHAINS],
    });
    const router = new FakeRouteMatrixGateway("fixture-router", ({ points }) =>
      uniformMatrix(points.length));
    const travel = new TravelService({
      branchDirectory: directory,
      createRouteFingerprint: () => "route:random-bounded",
      routeMatrixGateway: router,
    });

    const result = await calculate(travel, [plan("all", 10_000, [...CHAINS])]);

    expect(router.calls).toHaveLength(1);
    expect(router.calls[0]?.points).toHaveLength(10);
    const selectedCoordinates = router.calls[0]!.points.slice(1);
    for (const chainId of CHAINS) {
      expect(selectedCoordinates).toEqual(expect.arrayContaining(
        [1, 2, 3].map((index) =>
          branch(
            `unused:${chainId}:${index}`,
            chainId,
            index * 1_000,
            eastOffsets[chainId],
          ).coordinate),
      ));
      expect(selectedCoordinates).not.toContainEqual(
        branch(`unused:${chainId}:4`, chainId, 4_000, eastOffsets[chainId]).coordinate,
      );
    }
    expect(selectedCoordinates).not.toContainEqual(outsideRadius.coordinate);
    expect(result.plans[0]?.chains).toHaveLength(3);
  });

  it("lets the matrix choose among the three admitted nearby branches and returns a deterministic route", async () => {
    const branches = [
      branch("branch:extra:z", "extra", 1_000),
      branch("branch:extra:a", "extra", 2_000),
      branch("branch:extra:best", "extra", 3_000),
    ];
    const routeMatrix = matrix([
      [0, 20, 10, 2],
      [20, 0, 1, 1],
      [10, 1, 0, 1],
      [2, 1, 1, 0],
    ]);
    const first = service(branches, routeMatrix);
    const second = service([...branches].reverse(), routeMatrix);

    const forward = await calculate(first.travel, [plan("candidate", 10_000, ["extra"])]);
    const reverse = await calculate(second.travel, [plan("candidate", 10_000, ["extra"])]);

    expect(forward.travel).toEqual(reverse.travel);
    expect(forward.travel).toMatchObject({
      kind: "calculated",
      routes: [{ stops: [{ branchId: "branch:extra:best", sequence: 1 }] }],
    });
  });

  it.each([
    ["malformed dimensions", uniformMatrix(3)],
    ["partial cells", matrix([[0, null], [null, 0]])],
  ])("atomically returns a coherent price-only frontier for %s", async (_name, routeMatrix) => {
    const candidates = [
      plan("cheap", 8_000, ["extra"]),
      plan("dominated", 12_000, ["extra"]),
    ];
    const { travel } = service([
      branch("branch:extra", "extra", 1_000),
    ], routeMatrix);

    const result = await calculate(travel, candidates);

    expect(result.travel).toEqual({
      contractVersion: 1,
      kind: "unavailable",
      reason: "no-route",
    });
    expect(result.plans).toEqual(projectRepresentativesV2(candidates, 7));
    expect(result.plans.every(({ travel: evidence }) => evidence === undefined)).toBe(true);
  });

  it.each([
    ["incomplete snapshot", false, ["extra"] as TravelChainId[], [branch("branch:extra", "extra", 1_000)]],
    ["missing chain coverage", true, [] as TravelChainId[], [branch("branch:extra", "extra", 1_000)]],
    ["no nearby branch", true, ["extra"] as TravelChainId[], [branch("branch:far", "extra", 600_000)]],
  ])("fails closed to price-only when branch data has an %s", async (
    _name,
    complete,
    eligibleChainIds,
    branches,
  ) => {
    const directory = new FakeBranchDirectory({
      ...snapshot(branches, complete),
      eligibleChainIds,
    });
    const router = new FakeRouteMatrixGateway("fixture-router", uniformMatrix(2));
    const travel = new TravelService({
      branchDirectory: directory,
      createRouteFingerprint: () => "route:must-not-run",
      routeMatrixGateway: router,
    });

    const result = await calculate(travel, [plan("candidate", 10_000, ["extra"])]);

    expect(result.travel).toEqual({
      contractVersion: 1,
      kind: "unavailable",
      reason: "branch-data-unavailable",
    });
    expect(result.plans[0]?.travel).toBeUndefined();
    expect(router.calls).toHaveLength(0);
  });

  it.each([
    [new TravelGatewayTimeoutError(), "timeout"],
    [new Error("provider outage"), "provider-unavailable"],
  ] as const)("maps matrix timeout/outage to an atomic price-only fallback", async (fault, reason) => {
    const directory = new FakeBranchDirectory({
      ...snapshot([branch("branch:extra", "extra", 1_000)]),
      eligibleChainIds: ["extra"],
    });
    const router = new FakeRouteMatrixGateway("fixture-router", fault);
    const travel = new TravelService({
      branchDirectory: directory,
      createRouteFingerprint: () => "route:must-not-run",
      routeMatrixGateway: router,
    });

    const result = await calculate(travel, [plan("candidate", 10_000, ["extra"])]);

    expect(result.travel).toEqual({ contractVersion: 1, kind: "unavailable", reason });
    expect(result.plans[0]?.travel).toBeUndefined();
  });

  it("maps a directory outage to branch-data-unavailable without invoking the route provider", async () => {
    const directory = new FakeBranchDirectory(new BranchDirectoryUnavailableError());
    const router = new FakeRouteMatrixGateway("fixture-router", uniformMatrix(2));
    const travel = new TravelService({
      branchDirectory: directory,
      createRouteFingerprint: () => "route:must-not-run",
      routeMatrixGateway: router,
    });

    const result = await calculate(travel, [plan("candidate", 10_000, ["extra"])]);

    expect(result.travel).toMatchObject({
      kind: "unavailable",
      reason: "branch-data-unavailable",
    });
    expect(router.calls).toHaveLength(0);
  });

  it("propagates cancellation and prevents all later gateway and fingerprint work", async () => {
    const controller = new AbortController();
    const directory = new FakeBranchDirectory({
      ...snapshot([branch("branch:extra", "extra", 1_000)]),
      eligibleChainIds: ["extra"],
    }, () => controller.abort(new DOMException("cancelled", "AbortError")));
    const router = new FakeRouteMatrixGateway("fixture-router", uniformMatrix(2));
    const fingerprints = new FakeRouteFingerprintSource(["route:must-not-run"]);
    const travel = new TravelService({
      branchDirectory: directory,
      createRouteFingerprint: () => fingerprints.next(),
      routeMatrixGateway: router,
    });

    await expect(calculate(
      travel,
      [plan("candidate", 10_000, ["extra"])],
      controller.signal,
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(directory.calls).toHaveLength(1);
    expect(router.calls).toHaveLength(0);
    expect(fingerprints.calls).toBe(0);

    const preAborted = new AbortController();
    preAborted.abort(new DOMException("already cancelled", "AbortError"));
    const unused = service([branch("branch:extra", "extra", 1_000)], uniformMatrix(2));
    await expect(calculate(
      unused.travel,
      [plan("candidate", 10_000, ["extra"])],
      preAborted.signal,
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(unused.directory.calls).toHaveLength(0);
    expect(unused.router.calls).toHaveLength(0);
  });

  it("rejects malformed or over-three-store candidates before any external work", async () => {
    const { directory, router, travel } = service(
      [branch("branch:extra", "extra", 1_000)],
      uniformMatrix(2),
    );
    const malformed = {
      ...plan("invalid", 10_000, ["extra"]),
      chains: ["extra", "rema-1000", "bunnpris", "extra"],
    } as unknown as PlanResultV2;

    await expect(calculate(travel, [malformed])).rejects.toBeInstanceOf(
      TravelServiceInputError,
    );
    expect(directory.calls).toHaveLength(0);
    expect(router.calls).toHaveLength(0);
  });

  it("rejects a forged non-Date evaluation time before external work", async () => {
    const { directory, router, travel } = service(
      [branch("branch:extra", "extra", 1_000)],
      uniformMatrix(2),
    );
    await expect(travel.calculate({
      candidates: [plan("candidate", 10_000, ["extra"])],
      capturedEvaluationTime: "2026-07-17T12:00:00.000Z" as unknown as Date,
      marketContext: MARKET,
      mode: "car",
      origin: ORIGIN,
    })).rejects.toBeInstanceOf(TravelServiceInputError);
    expect(directory.calls).toHaveLength(0);
    expect(router.calls).toHaveLength(0);
  });

  it("returns only aggregate travel and public branch identity/order, never origin or geometry", async () => {
    const sentinelOrigin: TravelCoordinate = {
      latitudeE6: 12_345_678,
      longitudeE6: 87_654_321,
    };
    const nearby: InternalTravelBranch = {
      branchId: "branch:privacy-safe",
      chainId: "extra",
      coordinate: { latitudeE6: 12_345_679, longitudeE6: 87_654_322 },
      name: "Extra Sentrum",
    };
    const { travel } = service([nearby], uniformMatrix(2));

    const result = await travel.calculate({
      candidates: [plan("private", 10_000, ["extra"])],
      capturedEvaluationTime: NOW,
      marketContext: MARKET,
      mode: "bike",
      origin: sentinelOrigin,
    });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("12345678");
    expect(serialized).not.toContain("87654321");
    expect(serialized).not.toMatch(/origin|address|coordinate|latitude|longitude|geometry/i);
    expect(result.travel).toMatchObject({
      kind: "calculated",
      routes: [{
        aggregate: {
          calculatedAt: NOW.toISOString(),
          mode: "bike",
          providerSourceId: "fixture-router",
          routeFingerprint: "route:random-1",
        },
        stops: [{
          branchId: "branch:privacy-safe",
          chainId: "extra",
          name: "Extra Sentrum",
          sequence: 1,
        }],
      }],
    });
  });
});
