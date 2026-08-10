import "server-only";

import { randomBytes } from "node:crypto";

import {
  locationSearchRequestSchema,
  locationSearchResponseSchema,
  travelCoordinateSchema,
  type LocationSearchRequest,
  type LocationSearchResponse,
  type TravelCoordinate,
} from "@handleplan/domain";

import {
  KARTVERKET_ADDRESS_SOURCE_ID,
  KartverketGeocoderGateway,
} from "./kartverket-geocoder";
import {
  geocoderGatewayResultSchema,
  type GeocoderGateway,
} from "./gateways";
import {
  getPublicApiOperationCoalescer,
  type InFlightOperationCoalescer,
} from "../in-flight-operation-coalescer";
import { isValhallaTravelRuntimeEnabled } from "./travel-runtime-gate";

export const LOCATION_CHOICE_TTL_MS = 5 * 60 * 1_000;
export const DEFAULT_LOCATION_CHOICE_CAPACITY = 10_000;
export const KARTVERKET_RUNTIME_ENABLE_ENV = "HANDLEPLAN_KARTVERKET_ADDRESS_API_ENABLED";
export const LOCATION_GEOCODER_MAX_OPERATION_MS = 5_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const FULL_TOKEN_PATTERN = /^location-choice:[A-Za-z0-9_-]{43}$/u;

export type LocationSearchServiceErrorCode =
  | "INVALID_REQUEST"
  | "PROVIDER_UNAVAILABLE"
  | "REQUEST_CANCELLED";

export class LocationSearchServiceError extends Error {
  constructor(readonly code: LocationSearchServiceErrorCode) {
    super(`Location search failed: ${code}`);
    this.name = "LocationSearchServiceError";
  }
}

export interface LocationSearchServiceContract {
  search(input: LocationSearchRequest, signal?: AbortSignal): Promise<LocationSearchResponse>;
}

export interface LocationChoiceResolver {
  resolve(token: string, at: Date): TravelCoordinate | undefined;
}

export interface LocationChoiceIssuer {
  issueMany(coordinates: readonly TravelCoordinate[], at: Date): string[];
}

export interface LocationChoiceStoreOptions {
  maxEntries?: number;
  tokenSource?: () => string;
}

interface StoredLocationChoice {
  coordinate: TravelCoordinate;
  expiresAtMs: number;
}

function defaultTokenSource(): string {
  return randomBytes(32).toString("base64url");
}

function finiteDate(value: Date): number {
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds)) throw new TypeError("A finite date is required");
  return milliseconds;
}

/**
 * Process-memory-only, bounded and expiring. The store deliberately retains no
 * query, label, provider identifier, browser identity, or other request data.
 */
export class InMemoryLocationChoiceStore implements LocationChoiceIssuer, LocationChoiceResolver {
  private readonly entries = new Map<string, StoredLocationChoice>();
  private readonly maxEntries: number;
  private readonly tokenSource: () => string;

  constructor(options: LocationChoiceStoreOptions = {}) {
    const maxEntries = options.maxEntries ?? DEFAULT_LOCATION_CHOICE_CAPACITY;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 100_000) {
      throw new RangeError("maxEntries must be an integer from 1 through 100000");
    }
    this.maxEntries = maxEntries;
    this.tokenSource = options.tokenSource ?? defaultTokenSource;
  }

  private prune(atMs: number): void {
    for (const [token, entry] of this.entries) {
      if (entry.expiresAtMs <= atMs) this.entries.delete(token);
    }
  }

  issueMany(coordinates: readonly TravelCoordinate[], at: Date): string[] {
    const atMs = finiteDate(at);
    this.prune(atMs);
    if (coordinates.length > 5) throw new RangeError("At most five location choices may be issued");
    if (coordinates.length > this.maxEntries) {
      throw new Error("Location choice batch exceeds store capacity");
    }
    while (this.entries.size + coordinates.length > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }

    const parsedCoordinates = coordinates.map((coordinate) =>
      travelCoordinateSchema.parse(coordinate));
    const pending = new Set<string>();
    const tokens: string[] = [];
    for (let index = 0; index < parsedCoordinates.length; index += 1) {
      let token: string | undefined;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const opaque = this.tokenSource();
        if (!TOKEN_PATTERN.test(opaque)) {
          throw new Error("Location choice token source returned an invalid value");
        }
        const candidate = `location-choice:${opaque}`;
        if (!this.entries.has(candidate) && !pending.has(candidate)) {
          token = candidate;
          break;
        }
      }
      if (token === undefined) throw new Error("Location choice token collision limit reached");
      pending.add(token);
      tokens.push(token);
    }

    const expiresAtMs = atMs + LOCATION_CHOICE_TTL_MS;
    tokens.forEach((token, index) => {
      const coordinate = parsedCoordinates[index]!;
      this.entries.set(token, {
        coordinate: { ...coordinate },
        expiresAtMs,
      });
    });
    return tokens;
  }

  resolve(token: string, at: Date): TravelCoordinate | undefined {
    const atMs = finiteDate(at);
    if (!FULL_TOKEN_PATTERN.test(token)) return undefined;
    const entry = this.entries.get(token);
    if (entry === undefined) return undefined;
    if (entry.expiresAtMs <= atMs) {
      this.entries.delete(token);
      return undefined;
    }
    return { ...entry.coordinate };
  }
}

export interface LocationSearchServiceDependencies {
  choices: InMemoryLocationChoiceStore;
  geocoder: GeocoderGateway;
  geocoderCoalescer?: Pick<InFlightOperationCoalescer, "run">;
  now?: () => Date;
}

function comparableAddress(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/[,\s]+/gu, " ")
    .toLocaleLowerCase("nb-NO");
}

/**
 * Kartverket canonicalizes a normal query such as "Storgata 1, Oslo" to a
 * provider label such as "Storgata 1, 0155 OSLO". The postcode is useful for
 * disambiguation, but its insertion must not make an otherwise exact query
 * unusable. Keep this matching entirely inside the server process and accept
 * only canonical variants of one provider result; approximate provider hits
 * never receive a public selection token.
 */
function isSemanticAddressMatch(query: string, providerLabel: string): boolean {
  const comparableQuery = comparableAddress(query);
  const [streetPart, ...localityParts] = providerLabel.split(",");
  if (localityParts.length === 0) {
    return comparableAddress(providerLabel) === comparableQuery;
  }

  const street = comparableAddress(streetPart ?? "");
  const locality = comparableAddress(localityParts.join(" "));
  if (street.length === 0 || locality.length === 0) return false;

  const localityMatch = /^(\d{4})(?:\s+(.+))?$/u.exec(locality);
  const postcode = localityMatch?.[1];
  const postalPlace = localityMatch?.[2];
  const accepted = new Set<string>();
  if (postcode !== undefined) accepted.add(`${street} ${postcode}`);
  if (postalPlace !== undefined) accepted.add(`${street} ${postalPlace}`);
  if (postcode !== undefined && postalPlace !== undefined) {
    accepted.add(`${street} ${postcode} ${postalPlace}`);
  }
  if (postcode === undefined) accepted.add(`${street} ${locality}`);
  return accepted.has(comparableQuery);
}

export class LocationSearchService implements LocationSearchServiceContract {
  private readonly now: () => Date;

  constructor(private readonly dependencies: LocationSearchServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async search(
    input: LocationSearchRequest,
    signal?: AbortSignal,
  ): Promise<LocationSearchResponse> {
    const request = locationSearchRequestSchema.safeParse(input);
    if (
      !request.success
      || /[\u0000-\u001f\u007f]/u.test(request.data.query)
    ) {
      throw new LocationSearchServiceError("INVALID_REQUEST");
    }
    if (signal?.aborted) throw new LocationSearchServiceError("REQUEST_CANCELLED");

    try {
      const gatewayResult = this.dependencies.geocoderCoalescer === undefined
        ? await this.dependencies.geocoder.search(request.data.query, signal)
        : await this.dependencies.geocoderCoalescer.run(
            "location-geocoder",
            { query: request.data.query },
            signal,
            (sharedSignal) => this.dependencies.geocoder.search(
              request.data.query,
              sharedSignal,
            ),
            { maxOperationMs: LOCATION_GEOCODER_MAX_OPERATION_MS },
          );
      const result = geocoderGatewayResultSchema.parse(
        gatewayResult,
      );
      if (signal?.aborted) throw new LocationSearchServiceError("REQUEST_CANCELLED");
      if (result.providerSourceId !== KARTVERKET_ADDRESS_SOURCE_ID) {
        throw new LocationSearchServiceError("PROVIDER_UNAVAILABLE");
      }

      const generatedAt = this.now();
      const generatedAtMs = finiteDate(generatedAt);
      // Labels are returned only in this bounded, private, no-store response so
      // the browser can offer a real choice. Coordinates and provider IDs stay
      // server-side behind short-lived opaque tokens and are never persisted.
      const seenLabels = new Set<string>();
      const selectable = result.candidates.filter(({ label }) => {
        const normalized = label.normalize("NFKC").trim().toLocaleLowerCase("nb-NO");
        if (seenLabels.has(normalized)) return false;
        seenLabels.add(normalized);
        return true;
      }).slice(0, 5);
      const tokens = this.dependencies.choices.issueMany(
        selectable.map(({ coordinate }) => coordinate),
        generatedAt,
      );
      return locationSearchResponseSchema.parse({
        candidates: selectable.map((candidate, index) => ({
          label: candidate.label,
          matchQuality: isSemanticAddressMatch(request.data.query, candidate.label)
            ? "exact"
            : "approximate",
          selectionToken: tokens[index],
        })),
        contractVersion: 1,
        expiresAt: new Date(generatedAtMs + LOCATION_CHOICE_TTL_MS).toISOString(),
        generatedAt: generatedAt.toISOString(),
        source: {
          displayName: "©Kartverket",
          id: KARTVERKET_ADDRESS_SOURCE_ID,
        },
      });
    } catch (error) {
      if (error instanceof LocationSearchServiceError) throw error;
      if (signal?.aborted) throw new LocationSearchServiceError("REQUEST_CANCELLED");
      throw new LocationSearchServiceError("PROVIDER_UNAVAILABLE");
    }
  }
}

let productionService: LocationSearchService | undefined;
let productionChoices: InMemoryLocationChoiceStore | undefined;

function getProductionLocationChoices(): InMemoryLocationChoiceStore {
  productionChoices ??= new InMemoryLocationChoiceStore();
  return productionChoices;
}

export function getProductionLocationChoiceResolver(): LocationChoiceResolver {
  return getProductionLocationChoices();
}

export function getProductionLocationChoiceIssuer(): LocationChoiceIssuer {
  return getProductionLocationChoices();
}

export function getProductionLocationSearchService(
  values: Record<string, string | undefined> = process.env,
): LocationSearchServiceContract {
  // Kartverket's current search contract puts the address in an upstream GET
  // URL. Keep runtime off unless deployment explicitly accepts that provider
  // URL/retention boundary; the route still fails with a sanitized 503.
  if (
    values[KARTVERKET_RUNTIME_ENABLE_ENV] !== "true"
    || !isValhallaTravelRuntimeEnabled(values)
  ) {
    throw new LocationSearchServiceError("PROVIDER_UNAVAILABLE");
  }
  productionService ??= new LocationSearchService({
    choices: getProductionLocationChoices(),
    geocoder: new KartverketGeocoderGateway(),
    geocoderCoalescer: getPublicApiOperationCoalescer(),
  });
  return productionService;
}
