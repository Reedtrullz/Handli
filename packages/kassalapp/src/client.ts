import type { PriceObservation, Product } from "@handleplan/domain";
import { z } from "zod";

import { normalizeBulkPriceResponse, normalizeSearchResponse } from "./schemas";

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_BULK_EANS = 100;
const eanSchema = z.string().regex(/^(?:\d{8}|\d{13})$/);

export type KassalappGatewayErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_RESPONSE"
  | "TIMEOUT"
  | "UPSTREAM_UNAVAILABLE";

export class KassalappGatewayError extends Error {
  constructor(public readonly code: KassalappGatewayErrorCode) {
    super(publicMessage(code));
    this.name = "KassalappGatewayError";
  }
}

export interface KassalappGateway {
  searchProducts(query: string, limit: number): Promise<Product[]>;
  getBulkPrices(eans: string[]): Promise<PriceObservation[]>;
}

export interface KassalappClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch: typeof fetch;
}

interface AttemptResult {
  response: Response;
  body?: unknown;
}

class AttemptTimeoutError extends Error {}
class InvalidResponseError extends Error {}

function publicMessage(code: KassalappGatewayErrorCode): string {
  switch (code) {
    case "INVALID_REQUEST":
      return "Ugyldig forespørsel til prisgrunnlaget.";
    case "INVALID_RESPONSE":
      return "Prisgrunnlaget hadde et ukjent format.";
    case "TIMEOUT":
      return "Prisgrunnlaget svarte ikke i tide.";
    case "UPSTREAM_UNAVAILABLE":
      return "Prisgrunnlaget er midlertidig utilgjengelig.";
  }
}

function toGatewayError(error: unknown): KassalappGatewayError {
  if (error instanceof KassalappGatewayError) {
    return error;
  }
  return new KassalappGatewayError("INVALID_RESPONSE");
}

export class KassalappClient implements KassalappGateway {
  private readonly baseUrl: string;

  constructor(private readonly options: KassalappClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
  }

  async searchProducts(query: string, limit: number): Promise<Product[]> {
    const parsed = z
      .object({ query: z.string().trim().min(1), limit: z.number().int().min(1).max(100) })
      .safeParse({ query, limit });
    if (!parsed.success) {
      throw new KassalappGatewayError("INVALID_REQUEST");
    }

    const url = new URL(`${this.baseUrl}/products/search`);
    url.searchParams.set("query", parsed.data.query);
    url.searchParams.set("limit", String(parsed.data.limit));

    try {
      return normalizeSearchResponse(await this.requestJson(url, { method: "GET" })).slice(
        0,
        parsed.data.limit,
      );
    } catch (error) {
      throw toGatewayError(error);
    }
  }

  async getBulkPrices(eans: string[]): Promise<PriceObservation[]> {
    if (eans.length === 0) {
      return [];
    }

    const parsed = z.array(eanSchema).safeParse(eans);
    if (!parsed.success) {
      throw new KassalappGatewayError("INVALID_REQUEST");
    }

    const observations: PriceObservation[] = [];
    for (let index = 0; index < parsed.data.length; index += MAX_BULK_EANS) {
      const batch = parsed.data.slice(index, index + MAX_BULK_EANS);
      try {
        const response = await this.requestJson(`${this.baseUrl}/products/prices-bulk`, {
          body: JSON.stringify({ eans: batch }),
          method: "POST",
        });
        const normalized = normalizeBulkPriceResponse(response);
        const requested = new Set(batch);
        if (normalized.some((observation) => !requested.has(observation.ean))) {
          throw new KassalappGatewayError("INVALID_RESPONSE");
        }
        observations.push(...normalized);
      } catch (error) {
        throw toGatewayError(error);
      }
    }

    return observations;
  }

  private async requestJson(input: string | URL, init: RequestInit): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await this.attempt(input, init);
      if (result.response.ok) {
        return result.body;
      }
      if (attempt === 0 && RETRYABLE_STATUSES.has(result.response.status)) {
        continue;
      }
      throw new KassalappGatewayError("UPSTREAM_UNAVAILABLE");
    }

    throw new KassalappGatewayError("UPSTREAM_UNAVAILABLE");
  }

  private async attempt(input: string | URL, init: RequestInit): Promise<AttemptResult> {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new AttemptTimeoutError());
      }, DEFAULT_TIMEOUT_MS);
    });

    const request = (async (): Promise<AttemptResult> => {
      const response = await this.options.fetch(input, {
        ...init,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        return { response };
      }
      try {
        return { body: await response.json(), response };
      } catch {
        throw new InvalidResponseError();
      }
    })();

    try {
      return await Promise.race([request, timeout]);
    } catch (error) {
      if (error instanceof AttemptTimeoutError || controller.signal.aborted) {
        throw new KassalappGatewayError("TIMEOUT");
      }
      if (error instanceof InvalidResponseError) {
        throw new KassalappGatewayError("INVALID_RESPONSE");
      }
      throw new KassalappGatewayError("UPSTREAM_UNAVAILABLE");
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
