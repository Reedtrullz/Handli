import { describe, expect, it } from "vitest";

import { chooseBestRoundTrip, type MatrixBranchCandidate } from "./route-order";
import type { RouteMatrix } from "./travel-contracts";

function matrix(
  durations: Array<Array<number | null>>,
  distances: Array<Array<number | null>> = durations,
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

function branch(
  branchId: string,
  chainId: MatrixBranchCandidate["chainId"],
  matrixIndex: number,
): MatrixBranchCandidate {
  return {
    branchId,
    chainId,
    coordinate: { latitudeE6: 60_000_000 + matrixIndex, longitudeE6: 10_000_000 },
    matrixIndex,
    name: branchId,
  };
}

describe("chooseBestRoundTrip", () => {
  it("calculates a directed origin-store-origin route", () => {
    expect(chooseBestRoundTrip({
      branches: [branch("branch:extra", "extra", 1)],
      matrix: matrix([[0, 10], [20, 0]], [[0, 100], [250, 0]]),
      requiredChains: ["extra"],
    })).toEqual({
      distanceMeters: 350,
      durationSeconds: 30,
      stops: [{
        branchId: "branch:extra",
        chainId: "extra",
        name: "branch:extra",
        sequence: 1,
      }],
    });
  });

  it("enumerates both two-stop and all six three-stop orders", () => {
    const two = chooseBestRoundTrip({
      branches: [
        branch("branch:extra", "extra", 1),
        branch("branch:rema", "rema-1000", 2),
      ],
      matrix: matrix([
        [0, 1, 9],
        [9, 0, 1],
        [1, 9, 0],
      ]),
      requiredChains: ["rema-1000", "extra"],
    });
    expect(two?.stops.map(({ branchId }) => branchId)).toEqual([
      "branch:extra",
      "branch:rema",
    ]);
    expect(two?.durationSeconds).toBe(3);

    const three = chooseBestRoundTrip({
      branches: [
        branch("branch:bunnpris", "bunnpris", 1),
        branch("branch:extra", "extra", 2),
        branch("branch:rema", "rema-1000", 3),
      ],
      matrix: matrix([
        [0, 50, 1, 50],
        [1, 0, 50, 50],
        [50, 50, 0, 1],
        [50, 1, 50, 0],
      ]),
      requiredChains: ["bunnpris", "extra", "rema-1000"],
    });
    expect(three?.stops.map(({ branchId }) => branchId)).toEqual([
      "branch:extra",
      "branch:rema",
      "branch:bunnpris",
    ]);
    expect(three?.durationSeconds).toBe(4);
  });

  it("chooses the best branch combination and is invariant to input order", () => {
    const branches = [
      branch("branch:extra-far", "extra", 1),
      branch("branch:extra-near", "extra", 2),
      branch("branch:rema", "rema-1000", 3),
    ];
    const routeMatrix = matrix([
      [0, 30, 2, 5],
      [30, 0, 30, 30],
      [2, 30, 0, 2],
      [5, 30, 2, 0],
    ]);
    const first = chooseBestRoundTrip({
      branches,
      matrix: routeMatrix,
      requiredChains: ["extra", "rema-1000"],
    });
    const permuted = chooseBestRoundTrip({
      branches: [...branches].reverse(),
      matrix: routeMatrix,
      requiredChains: ["rema-1000", "extra"],
    });
    expect(first).toEqual(permuted);
    expect(first?.stops.map(({ branchId }) => branchId)).toContain("branch:extra-near");
  });

  it("uses duration, distance, then branch sequence as deterministic ties", () => {
    const result = chooseBestRoundTrip({
      branches: [
        branch("branch:z", "extra", 1),
        branch("branch:a", "extra", 2),
      ],
      matrix: matrix(
        [[0, 5, 5], [5, 0, 1], [5, 1, 0]],
        [[0, 100, 80], [100, 0, 1], [80, 1, 0]],
      ),
      requiredChains: ["extra"],
    });
    expect(result?.stops[0]?.branchId).toBe("branch:a");
  });

  it("fails closed for missing legs, duplicates, too many branches, and overflow", () => {
    const extra = branch("branch:extra", "extra", 1);
    expect(chooseBestRoundTrip({
      branches: [extra],
      matrix: matrix([[0, null], [1, 0]]),
      requiredChains: ["extra"],
    })).toBeUndefined();
    expect(chooseBestRoundTrip({
      branches: [extra, extra],
      matrix: matrix([[0, 1], [1, 0]]),
      requiredChains: ["extra"],
    })).toBeUndefined();
    expect(chooseBestRoundTrip({
      branches: Array.from({ length: 4 }, (_, index) => branch(`branch:${index}`, "extra", index + 1)),
      matrix: matrix(Array.from({ length: 5 }, () => Array(5).fill(1) as number[])),
      requiredChains: ["extra"],
    })).toBeUndefined();
    expect(chooseBestRoundTrip({
      branches: [extra],
      matrix: matrix([
        [0, Number.MAX_SAFE_INTEGER],
        [1, 0],
      ]),
      requiredChains: ["extra"],
    })).toBeUndefined();
  });

  it("never returns origin, address, coordinates, or route geometry", () => {
    const result = chooseBestRoundTrip({
      branches: [branch("branch:extra", "extra", 1)],
      matrix: matrix([[0, 1], [1, 0]]),
      requiredChains: ["extra"],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/origin|address|coordinate|latitude|longitude|geometry/i);
  });
});
