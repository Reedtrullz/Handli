import { isValidGtin } from "@handleplan/domain";
import { resolveChainFromLocation } from "./chain-mapping";
import type { HandleplanChainId } from "./chain-mapping";
import type { OpenPricesPrice } from "./types";

export const OPEN_PRICES_SOURCE_ID = "open-prices" as const;

export interface OpenPricesPriceIngestionOutcomeAccepted {
  readonly outcomeState: "accepted";
  readonly recordKind: "price";
  readonly sourceRecordId: string;
  readonly subjectChain: HandleplanChainId;
  readonly subjectEan: string;
  readonly normalizedRecord: Readonly<Record<string, unknown>>;
  readonly recordedAt: Date;
  readonly price: {
    readonly amountOre: number;
    readonly fetchedAt: Date;
    readonly observedAt: Date;
    readonly sourceReference: string;
    readonly geographicScopeId?: number;
  };
}

export interface OpenPricesPriceIngestionOutcomeQuarantined {
  readonly outcomeState: "quarantined";
  readonly recordKind: "price";
  readonly sourceRecordId: string;
  readonly reason: string;
  readonly normalizedRecord: Readonly<Record<string, unknown>>;
  readonly recordedAt: Date;
  readonly subjectChain?: HandleplanChainId;
  readonly subjectEan?: string;
  readonly geographicScopeId?: number;
}

export interface OpenPricesPriceIngestionOutcomeUnknown {
  readonly outcomeState: "unknown";
  readonly recordKind: "price";
  readonly sourceRecordId: string;
  readonly reason: string;
  readonly normalizedRecord: Readonly<Record<string, unknown>>;
  readonly recordedAt: Date;
  readonly subjectChain?: HandleplanChainId;
  readonly subjectEan?: string;
  readonly geographicScopeId?: number;
}

export type OpenPricesPriceIngestionOutcome =
  | OpenPricesPriceIngestionOutcomeAccepted
  | OpenPricesPriceIngestionOutcomeQuarantined
  | OpenPricesPriceIngestionOutcomeUnknown;

function checkedDate(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError("Invalid Open Prices timestamp");
  return parsed;
}

function normalizedRecord(record: object): Readonly<Record<string, unknown>> {
  return { ...record };
}

export function normalizeOpenPricesOutcome(
  price: OpenPricesPrice,
  fetchedAt: Date,
  geographicScopeId?: number,
): OpenPricesPriceIngestionOutcome {
  const sourceRecordId = `op-${price.id}`;
  const ean = price.product_code?.trim();
  if (ean === undefined || ean === "" || !isValidGtin(ean)) {
    return {
      geographicScopeId,
      normalizedRecord: normalizedRecord(price),
      outcomeState: "quarantined",
      reason: "INVALID_GTIN",
      recordedAt: fetchedAt,
      recordKind: "price",
      sourceRecordId,
    };
  }
  if (typeof price.price !== "number" || price.price <= 0 || !Number.isFinite(price.price)) {
    return {
      geographicScopeId,
      normalizedRecord: normalizedRecord(price),
      outcomeState: "quarantined",
      reason: "INVALID_PRICE",
      recordedAt: fetchedAt,
      recordKind: "price",
      sourceRecordId,
      subjectEan: ean,
    };
  }
  if (price.currency !== "NOK") {
    return {
      geographicScopeId,
      normalizedRecord: normalizedRecord(price),
      outcomeState: "quarantined",
      reason: "UNSUPPORTED_CURRENCY",
      recordedAt: fetchedAt,
      recordKind: "price",
      sourceRecordId,
      subjectEan: ean,
    };
  }
  let observedAt: Date;
  try {
    observedAt = checkedDate(price.date);
  } catch {
    return {
      geographicScopeId,
      normalizedRecord: normalizedRecord(price),
      outcomeState: "quarantined",
      reason: "INVALID_DATE",
      recordedAt: fetchedAt,
      recordKind: "price",
      sourceRecordId,
      subjectEan: ean,
    };
  }
  const location = price.location ?? { id: price.location_id, osm_brand: null, osm_name: null };
  const chain = resolveChainFromLocation(location);
  if (chain === undefined) {
    return {
      geographicScopeId,
      normalizedRecord: normalizedRecord(price),
      outcomeState: "unknown",
      reason: "UNKNOWN_CHAIN",
      recordedAt: fetchedAt,
      recordKind: "price",
      sourceRecordId,
      subjectEan: ean,
    };
  }
  const amountOre = Math.round(price.price * 100);
  return {
    normalizedRecord: normalizedRecord(price),
    outcomeState: "accepted",
    recordedAt: fetchedAt,
    recordKind: "price",
    sourceRecordId,
    subjectChain: chain,
    subjectEan: ean,
    price: {
      amountOre,
      fetchedAt,
      ...(geographicScopeId === undefined ? {} : { geographicScopeId }),
      observedAt,
      sourceReference: `${OPEN_PRICES_SOURCE_ID}:${price.id}`,
    },
  };
}
