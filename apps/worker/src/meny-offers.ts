import { createHash } from "node:crypto";
import {
  officialOfferExtractionEnvelopeV1Schema,
  type ExtractedOfficialOfferCandidateV1,
} from "@handleplan/domain";
import type { OfficialOfferExtractor, OfficialOfferExtractionInput } from "./official-offer-foundation";

export const MENY_SOURCE_ID = "meny" as const;
export const MENY_EXTRACTOR_VERSION = "meny-embedded-text-v1" as const;

// Fingerprint of the reviewed MENY pageTexts layout. Derived like the Tjek
// fingerprint: a stable review marker, not a hash of one captured payload.
const MENY_LAYOUT_FINGERPRINT = createHash("sha256").update("meny-page-texts-review-v1").digest("hex");
const MENY_SCHEMA_FINGERPRINT = MENY_LAYOUT_FINGERPRINT;

export interface MenyStaticSettings {
  paperId: number;
  licenseId: number;
  name: string;
  pageTexts: readonly string[];
}

const SPLIT_DIGIT_PRICE = /(\d{1,3}) (\d{2}) \/ /u;
const DECIMAL_PRICE = /(\d{1,4}),(\d{2})(?!\d)/u;
const BEFORE_PRICE = /FØRPRIS\s+(\d{1,4}),(\d{2})/u;
const PACKAGE_SINGLE = /PK (\d+) ?(G|KG|ML|L|STK)\b/u;
const PACKAGE_MULTI = /PK (\d+)X(\d+),(\d{1,2}) ?(G|KG|ML|L|STK)\b/u;
const MEMBER_PROGRAM = /TRUMF/u;
const COMPARISON_PRICE = /[(/]\s*\d{1,4},\d{2}\s*\/\s*(KG|L|STK|PK)/iu;
const TRAILING_UNIT_PRICE = /,\d{2}\s*\/\s*(KG|L|STK|PK)\b/iu;
const NUMERIC_LABEL = /^[\d\s.,\-/]*$/u;
const BEFORE_PRICE_PREFIX = /FØRPRIS\s*$/u;

const UNIT_BY_CODE: Readonly<Record<string, "g" | "ml" | "piece">> = {
  G: "g",
  KG: "g",
  ML: "ml",
  L: "ml",
  STK: "piece",
};

function toUnitAmount(rawAmount: number, code: string): number {
  return code === "KG" ? rawAmount * 1000 : code === "L" ? rawAmount * 1000 : rawAmount;
}

/** Extracts the iPaper staticSettings payload from viewer HTML bytes. */
export function parseMenyStaticSettings(html: string): MenyStaticSettings | undefined {
  const match = html.match(/window\.staticSettings\s*=\s*(\{[\s\S]*?\});/u);
  if (!match) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]!);
  } catch {
    return undefined;
  }
  const settings = parsed as Partial<MenyStaticSettings> | null;
  if (
    !settings
    || typeof settings.paperId !== "number"
    || typeof settings.licenseId !== "number"
    || typeof settings.name !== "string"
    || !Array.isArray(settings.pageTexts)
    || settings.pageTexts.some((page) => typeof page !== "string")
  ) {
    return undefined;
  }
  return {
    paperId: settings.paperId,
    licenseId: settings.licenseId,
    name: settings.name,
    pageTexts: settings.pageTexts,
  };
}

interface ParsedPrice {
  startIndex: number;
  ore: number;
  endIndex: number;
}

function findSplitDigitPrice(text: string, from: number): ParsedPrice | undefined {
  const match = SPLIT_DIGIT_PRICE.exec(text.slice(from));
  if (!match) return undefined;
  const startIndex = from + (match.index ?? 0);
  return { startIndex, ore: Number(match[1]) * 100 + Number(match[2]), endIndex: startIndex + match[0].length };
}

function isComparisonContext(text: string, index: number): boolean {
  return COMPARISON_PRICE.test(text.slice(Math.max(0, index - 12), index + 24));
}

function findStandaloneDecimal(text: string, from: number): ParsedPrice | undefined {
  const segment = text.slice(from);
  const match = DECIMAL_PRICE.exec(segment);
  if (!match) return undefined;
  const absoluteIndex = from + (match.index ?? 0);
  // A decimal glued to FORPRIS is a before-price, never the offer price;
  // the offer price in that layout is unparseable.
  if (BEFORE_PRICE_PREFIX.test(text.slice(Math.max(0, absoluteIndex - 10), absoluteIndex))) return undefined;
  if (isComparisonContext(text, absoluteIndex) || TRAILING_UNIT_PRICE.test(text.slice(absoluteIndex, absoluteIndex + 16))) {
    return undefined;
  }
  return { startIndex: absoluteIndex, ore: Number(match[1]) * 100 + Number(match[2]), endIndex: absoluteIndex + match[0].length };
}

function labelBefore(text: string, startIndex: number): string | undefined {
  const label = text
    .slice(0, startIndex)
    .replace(/FØRPRIS.*$/iu, "")
    .replace(/[^\p{L}\p{N}][^\p{L}\p{N}]*$/u, "")
    .trim();
  if (!label) return undefined;
  // A label spanning more than one visual block is page-boundary junk, not a
  // product name; fail closed to review rather than emit a garbage label.
  if (label.length > 120) return undefined;
  return label;
}

function parsePackage(segment: string): ExtractedOfficialOfferCandidateV1["package"] {
  const multi = PACKAGE_MULTI.exec(segment);
  if (multi) {
    const unitsPerPack = Number(multi[1]);
    const amount = toUnitAmount(Number(multi[2] + "." + multi[3]), multi[4]!);
    return { state: "parsed", amount, unit: UNIT_BY_CODE[multi[4]!]!, unitsPerPack };
  }
  const single = PACKAGE_SINGLE.exec(segment);
  if (single) {
    return { state: "parsed", amount: toUnitAmount(Number(single[1]), single[2]!), unit: UNIT_BY_CODE[single[2]!]!, unitsPerPack: 1 };
  }
  return { state: "unknown", reasonCode: "MISSING" };
}

export interface MenyParseResult {
  candidates: ExtractedOfficialOfferCandidateV1[];
  skippedBlocks: number;
}

/**
 * Parses one candidate per "UKENS TILBUD" block that carries an absolute
 * price. Percentage-only and unparseable blocks are skipped, never invented.
 * Scope and validity are unknown in the source payload and stay unknown.
 */
export function parseMenyOffers(pageTexts: readonly string[]): MenyParseResult {
  const candidates: ExtractedOfficialOfferCandidateV1[] = [];
  let skippedBlocks = 0;
  for (const [pageIndex, page] of pageTexts.entries()) {
    const blocks = page.split(/UKENS TILBUD/iu).slice(1);
    for (const [blockIndex, block] of blocks.entries()) {
      const before = BEFORE_PRICE.exec(block);
      const beforePriceOre = before ? Number(before[1]) * 100 + Number(before[2]) : undefined;
      const split = findSplitDigitPrice(block, 0);
      const decimal = split ? undefined : findStandaloneDecimal(block, 0);
      const price = split ?? decimal;
      if (!price) {
        skippedBlocks += 1;
        continue;
      }
      const label = labelBefore(block, price.startIndex);
      // "*" is a footnote marker; its presence means the label window crossed
      // a page footnote rather than a product name.
      if (!label || label.includes("*") || NUMERIC_LABEL.test(label)) {
        skippedBlocks += 1;
        continue;
      }
      const member = MEMBER_PROGRAM.test(block);
      const anomalies: ExtractedOfficialOfferCandidateV1["anomalyCodes"] = ["EXTRACTOR_ANOMALY", "UNKNOWN_SCOPE", "UNREADABLE_DATE"];
      if (beforePriceOre !== undefined && beforePriceOre < price.ore) anomalies.push("BEFORE_PRICE_BELOW_OFFER");
      candidates.push({
        contractVersion: 1,
        candidateKey: `p${pageIndex}-b${blockIndex}`,
        product: { kind: "unresolved-label", label },
        package: parsePackage(block),
        pricing: {
          kind: "unit",
          offerPriceOre: price.ore,
          ...(beforePriceOre !== undefined ? { beforePriceOre } : {}),
        },
        eligibility: member ? { kind: "member", programId: "trumf" } : { kind: "public" },
        validity: { state: "unreadable", reasonCode: "MISSING" },
        geographicScope: { kind: "unknown", reason: "meny-payload-carries-no-scope-evidence" },
        channels: ["in-store"],
        provenance: { method: "embedded-text", evidenceLocator: `pageTexts[${pageIndex}]`, confidence: split ? 60 : 40 },
        anomalyCodes: [...new Set(anomalies)],
      });
    }
  }
  return { candidates, skippedBlocks };
}

export function createMenyEmbeddedTextExtractor(
  payload: MenyStaticSettings,
  now: () => Date = () => new Date(),
): OfficialOfferExtractor {
  return {
    extractorVersion: MENY_EXTRACTOR_VERSION,
    method: "embedded-text",
    async extract(input: Readonly<OfficialOfferExtractionInput>) {
      const startedAt = now().toISOString();
      const { candidates } = parseMenyOffers(payload.pageTexts);
      return {
        contractVersion: 1,
        state: "available" as const,
        envelope: officialOfferExtractionEnvelopeV1Schema.parse({
          contractVersion: 1,
          captureChecksumSha256: input.captureMetadata.checksumSha256,
          extractorVersion: MENY_EXTRACTOR_VERSION,
          method: "embedded-text",
          layoutFingerprintSha256: MENY_LAYOUT_FINGERPRINT,
          schemaFingerprintSha256: MENY_SCHEMA_FINGERPRINT,
          startedAt,
          completedAt: now().toISOString(),
          emptyResult: candidates.length ? ("not-empty" as const) : ("unexpected-empty" as const),
          candidates,
        }),
      };
    },
  };
}

/** Unavailable outcome when the viewer layout no longer carries page text. */
export const MENY_NO_EMBEDDED_TEXT = {
  contractVersion: 1,
  state: "unavailable" as const,
  reason: "NO_EMBEDDED_TEXT" as const,
};
