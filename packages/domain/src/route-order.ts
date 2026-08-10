import { z } from "zod";

import {
  internalTravelBranchSchema,
  routeMatrixSchema,
  travelChainIdSchema,
  type RouteMatrix,
  type TravelChainId,
  type TravelPublicBranchStop,
} from "./travel-contracts";

const matrixBranchCandidateSchema = internalTravelBranchSchema.extend({
  matrixIndex: z.number().int().min(1).max(9),
}).strict();

export type MatrixBranchCandidate = z.infer<typeof matrixBranchCandidateSchema>;

export interface BestRoundTrip {
  distanceMeters: number;
  durationSeconds: number;
  stops: TravelPublicBranchStop[];
}

export interface ChooseBestRoundTripInput {
  branches: readonly MatrixBranchCandidate[];
  matrix: RouteMatrix;
  requiredChains: readonly TravelChainId[];
}

const chainOrder: Readonly<Record<TravelChainId, number>> = {
  bunnpris: 0,
  extra: 1,
  "rema-1000": 2,
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [[...values]];
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)])
      .map((tail) => [value, ...tail]));
}

function combinations(
  options: readonly (readonly MatrixBranchCandidate[])[],
  index = 0,
  selected: readonly MatrixBranchCandidate[] = [],
): MatrixBranchCandidate[][] {
  if (index === options.length) return [[...selected]];
  return (options[index] ?? []).flatMap((branch) =>
    combinations(options, index + 1, [...selected, branch]));
}

function safeAdd(left: number, right: number): number | undefined {
  const sum = left + right;
  return Number.isSafeInteger(sum) ? sum : undefined;
}

function evaluateOrder(
  order: readonly MatrixBranchCandidate[],
  matrix: RouteMatrix,
): BestRoundTrip | undefined {
  const indices = [0, ...order.map(({ matrixIndex }) => matrixIndex), 0];
  let distanceMeters = 0;
  let durationSeconds = 0;
  for (let index = 0; index < indices.length - 1; index += 1) {
    const cell = matrix.cells[indices[index]!]![indices[index + 1]!];
    if (cell === null || cell === undefined) return undefined;
    const nextDistance = safeAdd(distanceMeters, cell.distanceMeters);
    const nextDuration = safeAdd(durationSeconds, cell.durationSeconds);
    if (nextDistance === undefined || nextDuration === undefined) return undefined;
    distanceMeters = nextDistance;
    durationSeconds = nextDuration;
  }
  return {
    distanceMeters,
    durationSeconds,
    stops: order.map(({ branchId, chainId, name }, index) => ({
      branchId,
      chainId,
      name,
      sequence: index + 1,
    })),
  };
}

function compareRoutes(left: BestRoundTrip, right: BestRoundTrip): number {
  return left.durationSeconds - right.durationSeconds
    || left.distanceMeters - right.distanceMeters
    || compareText(
      left.stops.map(({ branchId }) => branchId).join("\u0000"),
      right.stops.map(({ branchId }) => branchId).join("\u0000"),
    );
}

export function chooseBestRoundTrip(
  input: ChooseBestRoundTripInput,
): BestRoundTrip | undefined {
  const parsedMatrix = routeMatrixSchema.safeParse(input.matrix);
  const parsedChains = z.array(travelChainIdSchema).min(1).max(3).safeParse(input.requiredChains);
  const parsedBranches = z.array(matrixBranchCandidateSchema).min(1).max(9).safeParse(input.branches);
  if (!parsedMatrix.success || !parsedChains.success || !parsedBranches.success) return undefined;

  const requiredChains = [...parsedChains.data].sort(
    (left, right) => chainOrder[left] - chainOrder[right],
  );
  if (new Set(requiredChains).size !== requiredChains.length) return undefined;

  const branches = parsedBranches.data;
  if (
    new Set(branches.map(({ branchId }) => branchId)).size !== branches.length
    || new Set(branches.map(({ matrixIndex }) => matrixIndex)).size !== branches.length
    || branches.some(({ chainId, matrixIndex }) =>
      !requiredChains.includes(chainId) || matrixIndex >= parsedMatrix.data.cells.length)
  ) {
    return undefined;
  }

  const options = requiredChains.map((chainId) => branches
    .filter((branch) => branch.chainId === chainId)
    .sort((left, right) => compareText(left.branchId, right.branchId)));
  if (options.some((candidates) => candidates.length < 1 || candidates.length > 3)) {
    return undefined;
  }

  const routes = combinations(options)
    .flatMap((selection) => permutations(selection))
    .flatMap((order) => {
      const route = evaluateOrder(order, parsedMatrix.data);
      return route === undefined ? [] : [route];
    })
    .sort(compareRoutes);
  return routes[0];
}
