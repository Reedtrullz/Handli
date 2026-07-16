import type { RouteMatrix } from "@handleplan/domain";

import type { GeocoderGatewayResult } from "./gateways";
import {
  branchDirectorySnapshotSchema,
  geocoderGatewayResultSchema,
  routeMatrixGatewayRequestSchema,
  type BranchDirectory,
  type BranchDirectoryQuery,
  type BranchDirectorySnapshot,
  type GeocoderGateway,
  type RouteMatrixGateway,
  type RouteMatrixGatewayRequest,
} from "./gateways";

type MaybePromise<T> = T | Promise<T>;

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

export class FakeGeocoderGateway implements GeocoderGateway {
  readonly calls: string[] = [];

  constructor(
    private readonly outcome: GeocoderGatewayResult | Error,
    private readonly onCall?: () => void,
  ) {}

  async search(query: string, signal?: AbortSignal): Promise<GeocoderGatewayResult> {
    throwIfAborted(signal);
    this.calls.push(query);
    this.onCall?.();
    throwIfAborted(signal);
    if (this.outcome instanceof Error) throw this.outcome;
    return geocoderGatewayResultSchema.parse(this.outcome);
  }
}

export class FakeBranchDirectory implements BranchDirectory {
  readonly calls: BranchDirectoryQuery[] = [];

  constructor(
    private readonly outcome: BranchDirectorySnapshot | Error,
    private readonly onCall?: () => void,
  ) {}

  async loadEligibleBranches(
    query: BranchDirectoryQuery,
    signal?: AbortSignal,
  ): Promise<BranchDirectorySnapshot> {
    throwIfAborted(signal);
    this.calls.push({
      eligibleChainIds: [...query.eligibleChainIds],
      evaluatedAt: new Date(query.evaluatedAt),
    });
    this.onCall?.();
    throwIfAborted(signal);
    if (this.outcome instanceof Error) throw this.outcome;
    return branchDirectorySnapshotSchema.parse(this.outcome);
  }
}

type MatrixOutcome =
  | RouteMatrix
  | Error
  | ((request: RouteMatrixGatewayRequest) => MaybePromise<RouteMatrix>);

export class FakeRouteMatrixGateway implements RouteMatrixGateway {
  readonly calls: RouteMatrixGatewayRequest[] = [];

  constructor(
    readonly providerSourceId: string,
    private readonly outcome: MatrixOutcome,
    private readonly onCall?: () => void,
  ) {}

  async calculateMatrix(
    request: RouteMatrixGatewayRequest,
    signal?: AbortSignal,
  ): Promise<RouteMatrix> {
    throwIfAborted(signal);
    const parsed = routeMatrixGatewayRequestSchema.parse(request);
    this.calls.push({
      mode: parsed.mode,
      points: parsed.points.map((point) => ({ ...point })),
    });
    this.onCall?.();
    throwIfAborted(signal);
    if (this.outcome instanceof Error) throw this.outcome;
    const result = typeof this.outcome === "function"
      ? await this.outcome(parsed)
      : this.outcome;
    throwIfAborted(signal);
    return result;
  }
}

export class FakeRouteFingerprintSource {
  calls = 0;

  constructor(private readonly values: readonly string[]) {}

  next(): string {
    const value = this.values[this.calls];
    this.calls += 1;
    if (value === undefined) {
      throw new Error("Deterministic route fingerprint fixture exhausted");
    }
    return value;
  }
}
