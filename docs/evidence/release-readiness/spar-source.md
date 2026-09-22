# SPAR offer source qualification — 2026-09-21

## Scope of this note

This note records Steps 1-2 of Task 11 from
`docs/superpowers/plans/2026-09-08-handleplan-full-release.md` for the SPAR
customer brochure (`spar.no/api/kundeavis?postCode=7011`). All observations
are from live bounded requests made on 2026-09-21 and from local analysis of
the downloaded bytes. It does not qualify the source for release; see the
verdict at the end.

## Discovery request log

| # | Time (Europe/Oslo) | Request | Status | Bytes | Note |
|---|---|---|---|---:|---|
| 1 | 2026-09-21T21:54:11+02:00 | GET `https://cdn.sanity.io/files/we3sp607/production/fc0821cf4ecf8a93f1b78944fe93f9bd7b2a7acd.pdf` | 200 | 14695577 | PDF 1.6, `application/pdf`, 1.0 s |
| 2 | 2026-09-21T21:55:00+02:00 | GET `https://spar.no/api/kundeavis?postCode=7011` | 200 | small JSON | `{"url":"...fc0821cf4ecf8a93f1b78944fe93f9bd7b2a7acd.pdf"}` |

Request 1 was the PDF download itself. Request 2 re-confirmed the discovery
JSON. No other HTTP requests were made.

The discovery JSON carries exactly one field, `url`, pointing at the PDF.
It contains no scope, store list, region, validity window, currency, or
version metadata. Postcode 7011 (Trondheim) therefore selects an edition but
does not define the launch region, and the payload provides no evidence about
which geographic scope the returned edition actually covers.

## PDF capture

- URL: `https://cdn.sanity.io/files/we3sp607/production/fc0821cf4ecf8a93f1b78944fe93f9bd7b2a7acd.pdf`
- HTTP status: 200, content type `application/pdf`
- Byte size: 14,695,577
- SHA-256: `f8b00e8d0379f6d0f50e5aad8bee5c6a5099e7b998149f536fb47cfae6f81c29`
- Captured at: 2026-09-21T21:54:11+02:00 (Europe/Oslo; 19:54:11 UTC)
- PDF version: 1.6, deflate-compressed
- Internal creation metadata: CreatorTool and Producer are
  `Adobe Acrobat 26.2 Image Conversion Plug-in`; CreationDate
  `D:20260911080440+02'00'`, ModDate `D:20260917122203+02'00'`.
- Page count: 32 (from PDFKit page enumeration and the image XObject count).

## Text-layer reality: image-only by construction

The PDF has no embedded text layer. Evidence, all from local byte analysis:

- `strings` over the raw PDF finds no `ToUnicode` CMaps and no `/Font`
  objects beyond a single reference; there are no Type0/TrueType text-font
  resources to decode glyphs from.
- Decompressing all 39 deflate streams in the file with Python's stdlib
  `zlib` finds 39 decodable streams and **zero** streams containing PDF text
  operators (`Tj`/`TJ`). Every content stream only paints an image.
- There are 32 image XObjects (one per page, DCTDecode/JPEG), and the
  producer is explicitly "Adobe Acrobat 26.2 Image Conversion Plug-in",
  meaning the pages were rasterized on creation. Image-only status is a
  property of how the file was made, not a font-map quirk.
- Apple PDFKit (`PDFDocument.string` and per-page `page.string`) returns
  the empty string on all inspected pages, consistent with the byte-level
  result.

Per the plan gate ("Use embedded text first; OCR requires explicit source
capability and reviewed evidence"), embedded text does not work for this
source. OCR capability would be required for name, prices, quantity, and
validity markers, and OCR output is not machine-readable offer data in the
sense Step 2 requires.

## Per-field extraction anchor reality

All fields below exist only as pixels inside per-page JPEG images. No text
anchors exist. Representative content was read visually from the extracted
page images (stored locally as `/tmp/spar-page-01..06.jpg`; one ordinary
unit offer and one percentage-discount offer are visible on pages 2-3), not
from any text layer.

| Required field | Anchor reality | Rejection/review reason |
|---|---|---|
| Name | Absent | Text exists only inside page JPEGs; no extractable name anchor. OCR would be required and is not source-capable evidence. |
| Offer price | Absent | Prices like 49,90 / 24,90 are raster pixels; no numeric field or text run. OCR would be required; layout, decimal-mark, and badge-vs-shelf ambiguity make OCR-derived prices unverified. |
| Before price | Absent | The edition shows percentage badges (e.g. "-30%") rather than before-prices on inspected pages; no machine-readable before-price exists. Treating a percentage badge as a before-price would be fabrication. |
| Quantity / unit | Absent | Unit strings (e.g. "500 g", "400-900 g", "99,80/kg") are raster pixels only. |
| Currency | Absent | Norwegian format implies NOK visually, but no currency token exists in extractable text. |
| Validity | Absent | No extractable validity dates. The PDF's internal ModDate (2026-09-17) is a file timestamp, not an offer validity window. |
| Scope (region/store) | Absent | Discovery JSON carries only `url`. No store list, postcode scope, or region metadata. Postcode 7011 does not define the launch region. |
| Member / multibuy / channel conditions | Absent | Footer text (e.g. "kun til private husholdninger") exists only as raster pixels; membership and multibuy conditions cannot be separated from ordinary offers by machine. |
| Image rights | Absent | No rights metadata in PDF or discovery payload. SPAR brochure imagery reuse rights are not evidenced; committing page images or OCR-derived fixtures would need explicit rights approval. |

## Sample content (visual read, not machine extraction)

Because no text layer exists, these are read from the extracted page images
and are shown only to document what an OCR pipeline would have to recover.
They are not verified offer records and must not be treated as extraction
output:

- Page 2: "Norske salater, Gartner/Onna, et utvalg" with a -30% badge.
- Page 2: "Norske små tomater, Gartner, 500 g, 99,80/kg" at 49,90.
- Page 3: "Norsk gulrot, Gartner, beger, 750 g, 33,20/kg" at 24,90.
- Page 3: "Småpoteter, Gartner/Bjertnæs & Hoel, et utvalg, 400-900 g,
  33,22-74,75/kg" at 29,90.
- Page 3: "Norske rotgrønnsaker, Gartner, et utvalg" with a -30% badge.
- Footer (all pages): "VI TAR FORBEHOLD OM TRYKKFEIL OG UTSOLGTE VARER. KUN
  TIL PRIVATE HUSHOLDNINGER. BEGRENSNINGER KAN FOREKOMME..." (raster pixels).

The plan also asks for "at least one ordinary unit offer, one
conditional/ambiguous offer and one invalid/expired input". This source
cannot provide any of the three as machine-readable input: the ordinary and
percentage-badge offers above are visible only as pixels, and no expired or
historical edition was requested within the request budget. The contract
required by Step 2 therefore cannot be written from this payload.

## Request log summary

Two bounded HTTP requests total (15 s timeout each):

1. PDF download (the capture itself).
2. Discovery JSON re-confirmation.

No further requests were made. Local analysis (PDFKit enumeration, `strings`,
`zlib` stream decode, JPEG extraction) involved no HTTP requests.

## Qualification verdict

BLOCKED

The current SPAR payload is an image-only PDF produced by an image-conversion
plugin. It has no embedded text layer, no machine-readable offer fields, and
no scope metadata. Writing the Step 2 source contract would require fabricating
anchors that do not exist, and the plan explicitly gates OCR behind explicit
source capability plus reviewed evidence, neither of which is present. SPAR
offer delivery remains blocked until SPAR provides either a text-based PDF or
an official structured offer feed, or an explicit OCR capability decision with
reviewed evidence is approved separately.

## OCR capability evaluation (2026-09-22)

Tesseract 5.5.3 (Homebrew) with the `nor` traineddata pack was installed and run on five sample pages (1-5) of the captured Uke 39 PDF at psm 3. This was an offline evaluation of the PDF bytes already captured on 2026-09-21; no new source requests were made.

Results: product names, brand/producer lines, unit labels and before-prices ("Førpris: 339,00") OCR cleanly. However, the offer prices themselves are unreliably captured: page 5 shows five "Førpris" values but only a subset of the offer prices; page 1 misses the "Norske epler" price almost entirely; page 4's klementiner block has no price. The prices are set in large stylized display type on colored badges, which the OCR pass frequently fails to read. Multi-column block association (name-price-unit grouping) is also unreliable at psm 3.

Verdict: OCR is not proven as an offer-price extraction capability. It fails the fail-closed bar because the pipeline cannot know which offer blocks were dropped, so per-block human review of every page would be required each week - a reviewed-manual-OCR pipeline, not an automated capability. SPAR ingestion remains BLOCKED pending either (a) a source-authorized structured offer feed, or (b) an explicit user decision to fund a reviewed per-block manual-OCR workflow. Raw bytes (14.7 MB PDF, sha256 f8b00e8d...f81c29) and page JPEGs stay private in /tmp; nothing committed.

