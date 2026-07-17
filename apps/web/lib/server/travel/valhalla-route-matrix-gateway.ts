import "server-only";

import { routeMatrixSchema, type RouteMatrix } from "@handleplan/domain";
import { z } from "zod";

import {
  TravelGatewayTimeoutError,
  routeMatrixGatewayRequestSchema,
  type RouteMatrixGateway,
  type RouteMatrixGatewayRequest,
} from "./gateways";

/**
 * The production router is an internal, self-hosted Valhalla service. Keeping
 * the complete URL in this module prevents request data from selecting a host,
 * path, scheme, port, query parameter, or credential.
 */
export const VALHALLA_MATRIX_URL = "http://valhalla:8002/sources_to_targets";

const PROVIDER_SOURCE_ID = "valhalla-openstreetmap-self-hosted";
const DEFAULT_TIMEOUT_MS = 4_000;
const MAX_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 128 * 1_024;

const matrixScalarSchema = z.number().finite().nonnegative().nullable();
const matrixRowsSchema = z.array(z.array(matrixScalarSchema).min(2).max(10)).min(2).max(10);
const valhallaResponseSchema = z.object({
  sources_to_targets: z.object({
    distances: matrixRowsSchema,
    durations: matrixRowsSchema,
  }),
  units: z.literal("kilometers"),
});

export interface ValhallaRouteMatrixGatewayOptions {
  fetch: typeof fetch;
  /** Server-owned dependency injection for deterministic deadline tests. */
  timeoutMs?: number;
}

class ValhallaGatewayRequestError extends Error {
  constructor() {
    super("Routing provider request is invalid");
    this.name = "ValhallaGatewayRequestError";
  }
}

class ValhallaGatewayResponseError extends Error {
  constructor() {
    super("Routing provider response is invalid");
    this.name = "ValhallaGatewayResponseError";
  }
}

function isExactParsedValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cleanup only. Provider/body details must not escape this boundary.
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  const token = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
  const quotedString = '"(?:[^"\\\\\\r\\n]|\\\\[\\t\\x20-\\x7e])*"';
  const parameter = `(?:${token})\\s*=\\s*(?:${token}|${quotedString})`;
  if (!new RegExp(`^application/json(?:\\s*;\\s*${parameter})*\\s*$`, "i").test(contentType)) {
    await cancelBody(response);
    throw new ValhallaGatewayResponseError();
  }

  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null
    && /^\d+$/.test(contentLength)
    && Number(contentLength) > MAX_RESPONSE_BYTES
  ) {
    await cancelBody(response);
    throw new ValhallaGatewayResponseError();
  }
  if (response.body === null) throw new ValhallaGatewayResponseError();

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const fragments: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ValhallaGatewayResponseError();
      }
      fragments.push(decoder.decode(value, { stream: true }));
    }
    fragments.push(decoder.decode());
    return JSON.parse(fragments.join("")) as unknown;
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Cleanup only.
    }
    if (error instanceof ValhallaGatewayResponseError) throw error;
    throw new ValhallaGatewayResponseError();
  }
}

function throwCallerCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) signal.throwIfAborted();
}

function toProviderPoint({
  latitudeE6,
  longitudeE6,
}: RouteMatrixGatewayRequest["points"][number]): { lat: number; lon: number } {
  return {
    lat: latitudeE6 / 1_000_000,
    lon: longitudeE6 / 1_000_000,
  };
}

function normalizeMatrix(
  rawResponse: unknown,
  expectedSize: number,
): RouteMatrix {
  const response = valhallaResponseSchema.safeParse(rawResponse);
  if (!response.success) throw new ValhallaGatewayResponseError();
  const { distances, durations } = response.data.sources_to_targets;
  if (
    distances.length !== expectedSize
    || durations.length !== expectedSize
    || distances.some((row) => row.length !== expectedSize)
    || durations.some((row) => row.length !== expectedSize)
  ) {
    throw new ValhallaGatewayResponseError();
  }

  const candidate: RouteMatrix = {
    cells: durations.map((durationRow, rowIndex) =>
      durationRow.map((durationSeconds, columnIndex) => {
        const distanceKilometers = distances[rowIndex]?.[columnIndex];
        if (durationSeconds === null || distanceKilometers === null) {
          if (durationSeconds !== null || distanceKilometers !== null) {
            throw new ValhallaGatewayResponseError();
          }
          return null;
        }
        return {
          distanceMeters: Math.round(distanceKilometers * 1_000),
          durationSeconds: Math.round(durationSeconds),
        };
      }),
    ),
    contractVersion: 1,
  };
  const parsed = routeMatrixSchema.safeParse(candidate);
  if (!parsed.success) throw new ValhallaGatewayResponseError();
  return parsed.data;
}

export class ValhallaRouteMatrixGateway implements RouteMatrixGateway {
  readonly providerSourceId = PROVIDER_SOURCE_ID;
  private readonly timeoutMs: number;

  constructor(private readonly options: ValhallaRouteMatrixGatewayOptions) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new ValhallaGatewayRequestError();
    }
    this.timeoutMs = timeoutMs;
  }

  async calculateMatrix(
    request: RouteMatrixGatewayRequest,
    callerSignal?: AbortSignal,
  ): Promise<RouteMatrix> {
    throwCallerCancellation(callerSignal);
    const parsed = routeMatrixGatewayRequestSchema.safeParse(request);
    if (!parsed.success || !isExactParsedValue(request, parsed.data)) {
      throw new ValhallaGatewayRequestError();
    }

    const requestController = new AbortController();
    let timedOut = false;
    const onCallerAbort = () => requestController.abort(callerSignal?.reason);
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    if (callerSignal?.aborted) onCallerAbort();
    const timeout = setTimeout(() => {
      timedOut = true;
      requestController.abort(new DOMException("routing deadline", "TimeoutError"));
    }, this.timeoutMs);

    try {
      throwCallerCancellation(callerSignal);
      const providerPoints = parsed.data.points.map(toProviderPoint);
      const response = await this.options.fetch(VALHALLA_MATRIX_URL, {
        body: JSON.stringify({
          costing: parsed.data.mode === "car" ? "auto" : "bicycle",
          sources: providerPoints,
          targets: providerPoints,
          units: "kilometers",
          verbose: false,
        }),
        cache: "no-store",
        credentials: "omit",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        method: "POST",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: requestController.signal,
      });
      throwCallerCancellation(callerSignal);
      if (!response.ok) {
        await cancelBody(response);
        throw new ValhallaGatewayResponseError();
      }
      const body = await readBoundedJson(response);
      throwCallerCancellation(callerSignal);
      return normalizeMatrix(body, parsed.data.points.length);
    } catch (error) {
      throwCallerCancellation(callerSignal);
      if (timedOut) throw new TravelGatewayTimeoutError();
      if (error instanceof ValhallaGatewayResponseError) throw error;
      throw new ValhallaGatewayResponseError();
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }
}
