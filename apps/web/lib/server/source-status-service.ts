import "server-only";

import {
  type PublicSourceStatusReader,
  PublicSourceStatusReaderError,
} from "@handleplan/db/source-status-reader";
import {
  derivePublicSourceStatusOverall,
  isFiniteDate,
  PUBLIC_SOURCE_STATUS_MAX_ENTRIES,
  publicSourceStatusResponseSchema,
  type PublicSourceStatusResponse,
} from "@handleplan/domain";

export class SourceStatusRequestCancelledError extends Error {
  constructor() {
    super("Source-status request cancelled");
    this.name = "SourceStatusRequestCancelledError";
  }
}

export class SourceStatusUnavailableError extends Error {
  constructor() {
    super("Source status is unavailable");
    this.name = "SourceStatusUnavailableError";
  }
}

export interface SourceStatusServiceContract {
  read(signal?: AbortSignal): Promise<PublicSourceStatusResponse>;
}

export interface SourceStatusServiceDependencies {
  now?: () => Date;
  reader: PublicSourceStatusReader;
}

export class SourceStatusService implements SourceStatusServiceContract {
  private readonly now: () => Date;
  private readonly reader: PublicSourceStatusReader;

  constructor(dependencies: SourceStatusServiceDependencies) {
    if (dependencies === null || typeof dependencies !== "object") {
      throw new TypeError("SourceStatusService dependencies are required");
    }
    if (typeof dependencies.reader?.read !== "function") {
      throw new TypeError("A public source-status reader is required");
    }
    this.reader = dependencies.reader;
    this.now = dependencies.now ?? (() => new Date());
  }

  async read(signal?: AbortSignal): Promise<PublicSourceStatusResponse> {
    if (signal?.aborted) throw new SourceStatusRequestCancelledError();
    const generatedAt = this.now();
    if (!(generatedAt instanceof Date) || !isFiniteDate(generatedAt)) {
      throw new SourceStatusUnavailableError();
    }
    try {
      const directory = await this.reader.read(
        PUBLIC_SOURCE_STATUS_MAX_ENTRIES,
        generatedAt,
        signal,
      );
      if (signal?.aborted) throw new SourceStatusRequestCancelledError();
      const response = publicSourceStatusResponseSchema.safeParse({
        claimBoundary: {
          priceCoverage: "not-established",
          publicRanking: "not-established",
          runtimeActivation: "not-established",
          stockStatus: "not-established",
        },
        completeness: "partial",
        contractVersion: 1,
        entries: directory.entries,
        generatedAt: generatedAt.toISOString(),
        hasMore: directory.hasMore,
        kind: "public-source-status",
        overall: derivePublicSourceStatusOverall(
          directory.entries,
          directory.hasMore,
          generatedAt.toISOString(),
        ),
      });
      if (!response.success) throw new SourceStatusUnavailableError();
      return response.data;
    } catch (error) {
      if (error instanceof SourceStatusRequestCancelledError) throw error;
      if (
        error instanceof PublicSourceStatusReaderError
        && error.code === "CANCELLED"
      ) {
        throw new SourceStatusRequestCancelledError();
      }
      throw new SourceStatusUnavailableError();
    }
  }
}
