import { describe, expect, it } from "vitest";
import { officialOfferExtractionEnvelopeV1Schema } from "@handleplan/domain";
import {
  createMenyEmbeddedTextExtractor,
  parseMenyOffers,
  parseMenyStaticSettings,
} from "./meny-offers";

// Fixtures quote text anchors from the qualified capture (viewer.html sha256
// 7790c9a8...; bytes retained privately, only anchors committed here, per
// meny-source.md image-rights findings).
const VIEWER_PREFIX = '<html><script>window.staticSettings=';
const VIEWER_SUFFIX = ';</script></html>';

function viewerHtml(pageTexts: string[]): string {
  return VIEWER_PREFIX + JSON.stringify({
    paperId: 3060440,
    licenseId: 9445,
    name: "Uke 39 mandag",
    pageTexts,
  }) + VIEWER_SUFFIX;
}

const PAGE_ZERO = [
  "MANDAG 21. SEPTEMBER - L\u00d8RDAG 26. SEPTEMBER UKE 39, 2026",
  "UKENS TILBUD FERSK KYLLINGFILET 99 00 / PK 700G, PRIOR (141,43/KG) F\u00d8RPRIS 139,00",
  "UKENS TILBUD TORO SUPPER/ SAUSER/GRYTER 50 % STORT UTVALG",
  "UKENS TILBUD FERSK LAKS HEL 2-3KG 129 00 / KG SKIVER 189,00/KG, OPPDRETT, FRA FISKEDISKEN F\u00d8RPRIS HEL 199,00/SKIVER 279,00",
  "UKENS TILBUD COCA-COLA ZERO 119 00 / PK 8X1,5L (9,92/L) + PANT ORIGINAL 129,00 (10,75/L) F\u00d8RPRIS 155,00",
  "UKENS TILBUD PAKKEDE TOMATER 30 % 250-500G, UTVALGTE VARIANTER",
  "UKENS TILBUD ALI KAFFE 34 90 / PK 250G/16-18 STK, STORT UTVALG (139,60/KG-1,94-2,18/STK) F\u00d8RPRIS 49,90-69,90",
].join(" ");

// Page-three layout puts the product name after the price; the extractor
// deliberately skips these instead of pairing a price with the wrong name.
const PAGE_THREE = [
  "UKENS TILBUD 54 90 F\u00d8RPRIS72,90 / HG Granstubben ca 380g, Gangstad (549,00/kg)",
  "UKENS TILBUD 39 90 / GL F\u00d8RPRIS 44,90-54,90 Lerum syltet\u00f8y 330-335g, jordb\u00e6r/bringeb\u00e6r/ kokos&pasjon (119,10-120,91/kg)",
  "UKENS TILBUD 35 00 / STK F\u00d8RPRIS 47,90 Fransk solsikkebr\u00f8d 700g, fra bakeriet (50,00/kg)",
].join(" ");

const PAGE_FIVE = [
  "UKENS TILBUD Cevita mango import 29 90 / STK 30 % 30 % Pakkede tomater 250-500g, utvalgte varianter",
  "UKENS TILBUD *Finnes i de fleste MENY-butikker HELGENS BUKETT GAVEBUKETT *Finnes i de fleste MENY-butikker 79 90 / STK",
].join(" ");

const REAL_SHAPE_PAGE_TEXTS = [PAGE_ZERO, PAGE_THREE, PAGE_FIVE];

describe("parseMenyStaticSettings", () => {
  it("parses the iPaper staticSettings payload", () => {
    const payload = parseMenyStaticSettings(viewerHtml(REAL_SHAPE_PAGE_TEXTS));
    expect(payload).toMatchObject({ paperId: 3060440, licenseId: 9445, name: "Uke 39 mandag" });
    expect(payload?.pageTexts).toHaveLength(3);
  });

  it("rejects malformed or missing payloads", () => {
    expect(parseMenyStaticSettings("<html>none</html>")).toBeUndefined();
    expect(parseMenyStaticSettings(VIEWER_PREFIX + "{broken" + VIEWER_SUFFIX)).toBeUndefined();
    // An empty pageTexts array is structurally valid; extraction reports
    // unexpected-empty for it (covered below).
    expect(parseMenyStaticSettings(viewerHtml([]))).toBeDefined();
    expect(parseMenyStaticSettings(viewerHtml([42 as unknown as string]))).toBeUndefined();
  });
});

describe("parseMenyOffers", () => {
  it("extracts real candidates with prices, before-prices and packages", () => {
    const candidates = parseMenyOffers([PAGE_ZERO]).candidates;
    expect(candidates.map((c) => c.product.kind === "unresolved-label" ? c.product.label : "")).toEqual([
      "FERSK KYLLINGFILET",
      "FERSK LAKS HEL 2-3KG",
      "COCA-COLA ZERO",
      "ALI KAFFE",
    ]);
    expect(candidates[0]).toMatchObject({
      pricing: { kind: "unit", offerPriceOre: 9900, beforePriceOre: 13900 },
      package: { state: "parsed", amount: 700, unit: "g", unitsPerPack: 1 },
      eligibility: { kind: "public" },
      validity: { state: "unreadable", reasonCode: "MISSING" },
      geographicScope: { kind: "unknown" },
      channels: ["in-store"],
      anomalyCodes: expect.arrayContaining(["EXTRACTOR_ANOMALY", "UNKNOWN_SCOPE", "UNREADABLE_DATE"]),
    });
    // Multi-pack keeps the decimal: PK 8X1,5L is 8 x 1500 ml.
    expect(candidates[2].package).toEqual({ state: "parsed", amount: 1500, unit: "ml", unitsPerPack: 8 });
    // Comparison prices ((141,43/KG)) never become offer or before prices.
    expect(candidates[1].pricing).toEqual({ kind: "unit", offerPriceOre: 12900 });
    expect(candidates[3].pricing).toEqual({ kind: "unit", offerPriceOre: 3490, beforePriceOre: 4990 });
  });

  it("skips percentage-only blocks", () => {
    const result = parseMenyOffers([PAGE_ZERO]);
    expect(result.candidates).toHaveLength(4);
    expect(result.skippedBlocks).toBe(2); // Toro 50 %, Tomater 30 %
  });

  it("fails closed on scrambled before-price, name-after-price and footnote layouts", () => {
    const result = parseMenyOffers([PAGE_THREE, PAGE_FIVE]);
    // 54 90 / F\u00d8RPRIS72,90: before-price is not read as the offer price.
    // 39 90 / GL and 35 00 / STK: name follows the price; no label pairing.
    // Footnote block: "*Finnes i de fleste MENY-butikker" is not a product.
    expect(result.candidates.map((c) => c.product.kind === "unresolved-label" ? c.product.label : "")).toEqual(["Cevita mango import"]);
    expect(result.candidates[0].pricing).toEqual({ kind: "unit", offerPriceOre: 2990 });
    expect(result.skippedBlocks).toBe(4);
  });

  it("never invents prices for unparseable blocks", () => {
    expect(parseMenyOffers(["UKENS TILBUD PAKKEDE TOMATER 30 % 250-500G"]).candidates).toEqual([]);
    expect(parseMenyOffers(["UKENS TILBUD 54 90 F\u00d8RPRIS72,90 / HG Granstubben ca 380g"]).candidates).toEqual([]);
  });

  it("marks Trumf member offers", () => {
    const result = parseMenyOffers(["UKENS TILBUD TACO-PRODUKTER 29 90 / PK FAST TRUMF-BONUS"]);
    expect(result.candidates[0].eligibility).toEqual({ kind: "member", programId: "trumf" });
  });
});

type AvailableOutcome = { state: "available"; envelope: unknown };

function extractEnvelope(
  extractor: ReturnType<typeof createMenyEmbeddedTextExtractor>,
  checksum: string,
): Promise<AvailableOutcome> {
  return extractor.extract(
    { contractVersion: 1, captureId: 1, captureMetadata: { checksumSha256: checksum }, privateBlobKey: "k" } as never,
    new AbortController().signal,
  ) as Promise<AvailableOutcome>;
}

describe("createMenyEmbeddedTextExtractor", () => {
  it("returns a schema-valid available envelope bound to the capture checksum", async () => {
    const payload = parseMenyStaticSettings(viewerHtml(REAL_SHAPE_PAGE_TEXTS))!;
    const extractor = createMenyEmbeddedTextExtractor(payload, () => new Date("2026-09-21T20:00:00.000Z"));
    expect(extractor.method).toBe("embedded-text");
    expect(extractor.extractorVersion).toBe("meny-embedded-text-v1");
    const outcome = officialOfferExtractionEnvelopeV1Schema.parse((await extractEnvelope(extractor, "a".repeat(64))).envelope);
    expect(outcome.extractorVersion).toBe("meny-embedded-text-v1");
    expect(outcome.captureChecksumSha256).toBe("a".repeat(64));
    expect(outcome.method).toBe("embedded-text");
    expect(outcome.emptyResult).toBe("not-empty");
    expect(outcome.candidates.length).toBeGreaterThan(0);
    expect(outcome.layoutFingerprintSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("reports unexpected-empty when a valid layout carries no offers", async () => {
    const payload = parseMenyStaticSettings(viewerHtml(["INGEN TILBUD I DENNE UKE"]))!;
    const extractor = createMenyEmbeddedTextExtractor(payload, () => new Date("2026-09-21T20:00:00.000Z"));
    const outcome = officialOfferExtractionEnvelopeV1Schema.parse((await extractEnvelope(extractor, "b".repeat(64))).envelope);
    expect(outcome.emptyResult).toBe("unexpected-empty");
    expect(outcome.candidates).toEqual([]);
  });
});
