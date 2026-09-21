# MENY source qualification — 2026-09-21

Qualification of the MENY customer-magazine source for Task 10 steps 1–2 of
`docs/superpowers/plans/2026-09-08-handleplan-full-release.md`. The discovery
API endpoint (`https://meny.no/api/kundeavis?postCode=7011`) was probed before
this task and returns `{"url":"https://kundeavis.meny.no/"}`; this qualification
followed only that official destination. All requests used a 10-second timeout.
No raw payload bytes are committed here; checksums and local retention paths are
recorded below.

## Request log

| # | Method | URL | Status | Content-Type | Bytes | Timestamp (UTC) |
|---|--------|-----|-------:|--------------|------:|-----------------|
| 1 | GET | `https://kundeavis.meny.no/` (official destination) | 200 | text/html; charset=utf-8 | 84,433 | 2026-09-21T19:54:55Z |
| 2 | GET | `https://cdn.ipaper.io/iPaper/Papers/3bbef813-e371-4079-ae47-f2e70ef37ddf/Enrichments/v1/1789542805/<signed-path>/Page1-12.json?token=…&expires=1790104408` | 200 | application/json; charset=utf-8 | 3,507 | 2026-09-21T19:56:02Z |
| 3 | GET | `https://meny.no/api/kundeavis?postCode=9999` (alternative-postcode scope probe) | 200 | application/json | 36 | 2026-09-21T20:00:47Z |

The discovery API request itself was not repeated; the parent task had already
confirmed it returns HTTP 200 with the same JSON destination. Request 3 was
spent on the geographic-scope question instead (see below). Full response
headers were captured locally for all three requests.

## Viewer and edition identity

The official destination serves the iPaper flipbook viewer
(`x-ip-buildversion: 509.43`, `x-ip-server: APP3-FLIPBOOKS`). The inline
`window.staticSettings` config carries:

- `paperId: 3060440`, `licenseId: 9445`, `name: "Uke 39 mandag"`
- `pages: [1..12]`, `paperCompleteUrl: "https://kundeavis.meny.no/"`
- `countryCode: 45` and `shop.defaultCountryCode: 45` (iPaper license origin,
  Denmark — license configuration, not a geographic scope statement)
- `modules`: `hasSearch: true`, `hasShop: false`, `hasDownloadPdf: true`,
  `hasArchive: false`

The edition validity period exists only as the front-page text headline inside
`pageTexts[0]`: "MANDAG 21. SEPTEMBER - LØRDAG 26. SEPTEMBER UKE 39, 2026".

## Where the offer data actually lives

1. **Embedded page text layer** — `window.staticSettings.pageTexts` is a JSON
   array of 12 strings (one per page, 9,425 characters total) embedded in the
   viewer HTML. This is the only machine-readable offer content, and it is
   unstructured text, not a per-offer JSON schema.
2. **Enrichment chunk** (`Page1-12.json`, request 2) — 16 hotspot objects under
   `enrichments[]` with keys `pageIndex, id, type, category, url, x, y, width,
   height, zindex, shape, styleid, target, alttext`. All 16 are `type: 1`
   hyperlink hotspots (`category: "Manual"`) linking to meny.no category pages,
   e.g. `{"pageIndex":0,"type":1,"url":"https://meny.no/varer/tilbud","category":"Manual"}`.
   `animationSequences` is empty. The chunk contains **no** offer fields.

## Field coverage (Step 2 checklist)

| Required field | Status | Where found / rejection reason |
|---|---|---|
| Name | Text anchor | Product name precedes the price anchor in the page text, e.g. "FERSK KYLLINGFILET". |
| Offer price | Text anchor | Split-digit pattern `<kr> <øre> / <unit>`: "99 00 / PK 700G", "129 00 / KG", "34 90 / PK 250G/16-18 STK". Percent offers appear as "50 %", "30 %". |
| Before price | Text anchor | `FØRPRIS <amount>`: "FØRPRIS 139,00", "FØRPRIS 155,00", ranges "FØRPRIS 49,90-69,90". Marketing percent labels ("50 %") must not be read as verified savings. |
| Quantity | Text anchor | Unit after the price slash: "PK 700G", "KG", "HG", "STK 130G", "PK 8X1,5L"; ranges "250-500G", "340-600g"; unit-price comparisons "(141,43/KG)". |
| Currency | Missing | No currency field exists anywhere in the viewer config, page text, or enrichment chunk. `language.shopPriceCurrency: "DKK"` is an iPaper license default (countryCode 45) and contradicts the Norwegian market; it must not be trusted. Review reason: currency must be fixed to NOK by adapter convention; no source-field proof. |
| Validity | Text anchor only | Front-page headline "MANDAG 21. SEPTEMBER - LØRDAG 26. SEPTEMBER UKE 39, 2026" in `pageTexts[0]`. No machine field. The `expires=1790104408` URL parameter is the signed CDN token expiry, not an offer-validity field. Review reason: validity requires parsing the headline; format stability across editions is unproven. |
| Scope | Missing | No store IDs, regions, municipalities, or postcode mapping anywhere in the API response, viewer config, or enrichment chunk. See the geographic scope section. |
| Member conditions | Text anchor | "TRUMF-BONUS AV ORDINÆRPRIS", "LAST DIN TRUMF-KONTO" (Trumf loyalty bonus offers). |
| Multibuy conditions | Text anchor | "PLUKK & MIKS 3 2 33% RABATT VED KJØP AV 3", "2 1 50% RABATT VED KJØP AV 2". |
| Channel/exclusion conditions | Text anchor | "KAN IKKE KOMBINERES MED FISKETIRSDAG", "GJELDER IKKE ALLEREDE NEDSATTE VARER", "Salg kun til private husholdninger. Begrensninger på antall kan forekomme", home-delivery callout "LEVERT HJEM PÅ DØREN". |
| Image rights | Missing | Offer visuals are page raster renders (e.g. `viewer.ipaper.io/ViewFile887677.jpg`, optimized PNGs on `files.cdn.ipaper.io`); there are no per-product image objects, enrichment `alttext` is null, and no rights/license metadata exists in the payload. Review reason: image reuse rights are unproven; page rasters must not be extracted as product images. |
| Product identity (EAN/ID) | Missing (supplementary) | No EANs or product IDs anywhere. Matching to a product catalog will need name+unit heuristics with review. |

## Required offer classes

- **Ordinary unit offer** — `pageTexts[0]`: "UKENS TILBUD FERSK KYLLINGFILET
  99 00 / PK 700G, PRIOR (141,43/KG) FØRPRIS 139,00" (price, unit, before-price).
- **Conditional/ambiguous offer** — `pageTexts[9]`: "Taco-produkter stort utvalg
  fast trumf-bonus 4 3 0 % % TRUMF-BONUS AV ORDINÆRPRIS …" — column-interleaved
  digits make member-bonus percentages ambiguous; the multibuy "PLUKK & MIKS 3 2
  33% RABATT VED KJØP AV 3" pattern is a second ambiguous class. Both require
  review rather than automated acceptance.
- **Invalid/expired input** — discovery API with `postCode=9999` returned the
  identical static destination (request 3): no validation, no error, no region
  discrimination. No expired edition was observed during qualification; expired
  edition behavior remains unobserved and is an open item for the adapter plan.

## Geographic scope

Postcode 7011 does **not** define the launch region, and the observed payload
chain carries no geographic scope at all:

- The API response body is 36 bytes — `{"url":"https://kundeavis.meny.no/"}` —
  and is identical for postcode 7011 (parent probe) and postcode 9999 (request
  3). It carries no region, store, or catalogue identity, and performs no
  postcode validation.
- The viewer config's `countryCode: 45` is iPaper license origin (Denmark),
  not a scope statement.
- No store directory, municipality, or coverage fields exist in the viewer
  settings or enrichment chunk.

Conclusion: there is no positive geographic scope evidence in the observed
payload chain. Per the plan, MENY cannot claim regional scope; a scoped
geographic resolver would need evidence from outside this payload (e.g. a
retailer store directory) before any nonnational ingestion.

## Capture retention and checksums

- Viewer HTML SHA-256: `7790c9a8aca04658d915a0d19a0e4883c2fe4f2fb829f4f3bf8c48b28484e725`
- Enrichment chunk SHA-256: `629e01f71b74d5a57bdb312839a69592dc6458371346676fd085cf15050838e0`
- Full bytes are retained locally (not committed) in `/tmp/meny-qual.VkJxXQ/`
  (`viewer.html`, `enrichments.json`, `req1..req3` headers/meta/timestamps).
  This location is ephemeral; the durable protected-staging capture under worker
  credentials (plan Step 5) is still pending and is the retention path that
  matters.

## Qualification verdict

**PARTIAL.**

- A structured per-offer JSON feed does **not** exist: the enrichment endpoint
  carries only hyperlink hotspots, and offer content survives only as 12
  free-text page strings embedded in the viewer HTML.
- The embedded text layer does cover the substantive offer fields (name, offer
  price, before price, quantity, member/multibuy/channel conditions, validity
  headline) as parseable Norwegian text anchors, matching the plan's
  "existing foundation structured/embedded-text extractor port".
- Missing outright: machine currency, machine validity, geographic scope, image
  rights, and product identity — each with the rejection/review reason above.
- Viable adapter shape (for the Step 3 plan): GET the API for the official
  viewer destination, GET the viewer HTML, then parse
  `window.staticSettings.pageTexts` plus `paperId`/`name` for edition identity —
  two requests minimum; the enrichment JSON is not needed for offers.
- Blockers before QUALIFIED: MENY has no runtime source row in the readback
  recorded in `source-authority.md` (2026-09-09), durable protected capture is
  pending, text-anchor stability across editions is unproven, and positive
  geographic scope evidence is absent.

## Task 10 extractor status (2026-09-21, post-qualification)

The embedded-text extractor is implemented and unit-tested:

- `apps/worker/src/meny-offers.ts` — `parseMenyStaticSettings`,
  `parseMenyOffers`, `createMenyEmbeddedTextExtractor` (foundation
  embedded-text port), layout fingerprint derived per the Tjek convention.
- `apps/worker/src/meny-offers.test.ts` — 9 tests from real text anchors
  (split-digit + before-price, multi-pack decimal `PK 8X1,5L` = 1500 ml × 8,
  comparison-price exclusion, percentage-only skip, footnote skip, scrambled
  `FØRPRIS72,90 / HG` fail-closed, Trumf membership, envelope binding).
- `docs/superpowers/plans/2026-09-08-meny-offer-adapter.md` — the Step 3
  design-gate plan, including the blocked production-wiring task.

Fail-closed behaviors verified against the real capture: name-after-price
layouts skip (no label pairing), comparison unit prices never become offer
prices, before-prices never become offer prices, percentage-only and footnote
blocks never price. Non-claims: no production wiring exists; no runtime
`data_sources` row or permission migration; ingestion stays blocked at the
trust-fence scope constraint (`scope_kind` has no `unknown` and the payload
carries no scope evidence). Workers tests: 9/9 MENY tests green, worker
typecheck clean; three unrelated pre-existing `deployment.test.ts` failures
reproduce on the clean tree and are not attributed to this work.
