# Europris offer source qualification - 2026-09-21

Task: plan Task 13 Steps 1-2 (docs/superpowers/plans/2026-09-08-handleplan-full-release.md, lines ~737-790).
Scope of this note: qualify the Europris kundeavis source within a hard budget of three bounded HTTP requests (12 s timeout each). No other files were modified, nothing was committed, and no bulk dumps are retained in the repo.

## Summary

- The viewer is Zmags, confirmed from the page embed code itself, not prior knowledge: the kundeavis page loads the Zmags viewer API and initializes a publication with ID `3b50b26c`.
- No structured offer payload was reachable within the request budget. The budget went to the kundeavis page, the viewer bootstrap JS, and one viewer-configuration probe; the probe failed HTTP 500 and no offer data was observed at any point.
- Publication metadata alone is insufficient per the plan, so the Step 2 source contract cannot be completed this round.

## Request log

All times UTC 2026-09-21. curl, 12 s timeout, desktop Chrome user agent, run from the repo directory.

| # | UTC time | URL | Status | Content-Type | Bytes |
|---|---|---|---|---|---|
| 1 | 19:54:55Z | https://www.europris.no/kundeavis | 200 | text/html; charset=UTF-8 | 289826 |
| 2 | 19:56:32Z | https://secure.api.viewer.zmags.com/viewer/viewer.js | 200 | application/javascript | 81638 |
| 3 | 19:58:58Z | https://secure.viewer.zmags.com/viewerconfiguration?publication=3b50b26c&locale=en-US&embeddedInCustomPage=true | 500 | text/html;charset=ISO-8859-1 | 946 |

Local inspection copies were kept outside the repo: /tmp/europris-kundeavis.html, /tmp/europris-viewer.js, /tmp/europris-viewerconfig.json (the last is the decompressable 500 error page, not offer data). Request 1 response headers also matter: the page CSP allows *.zmags.com and *.zma.gs for scripts, frames and connections, consistent with the embed below.

## Viewer identity and configuration

- The kundeavis HTML embeds the classic Zmags viewer API:
  - script `https://secure.api.viewer.zmags.com/viewer/viewer.js`, container `<div id="myViewerContent">`.
  - init block: `var viewer = new com.zmags.api.Viewer(); var publicationId = "3b50b26c"; viewer.setPublicationID("3b50b26c"); viewer.setParentElementID("myViewerContent"); viewer.show();`
  - the viewer posts pageChange/toolbar/productwidget events back to the parent page via postMessage.
- A second loader is present: `https://cas.zma.gs/64d296c9b6fc7c5ba76fbd60/ssr/experiences/64e4d5ad6df9f10f7607589c/init.js` (Zmags experiences SSR bootstrap; not fetched within budget).
- viewer.js (81,638 bytes) exposes the service layer on `https://secure.viewer.zmags.com`:
  - `/services/publicationInfo`
  - `/viewerconfiguration`
  - `/services/launcherInfo`
  - `/services/htmlviewer/content`
  - statistics: `https://secure.stats.zmags.com/services/launchpage`
- The bootstrap carries product plumbing (`gotoProduct`, `registerProductDetailsViewed`, client-side validators for `price` and `discount_price`, `/product/js/ZmagsStandardProductWindows.js`) but no directly callable product/enrichment endpoint: offer data is fetched by the inner viewer frame after the viewer configuration resolves.

## Structured offer payload search

- Candidate structured endpoints identified from viewer.js: `publicationInfo` and `viewerconfiguration` on secure.viewer.zmags.com; the inner HTML-viewer content service follows from the viewer configuration.
- Probe: `/viewerconfiguration?publication=3b50b26c&locale=en-US&embeddedInCustomPage=true` returned HTTP 500 with a Zmags "VIEW PUBLICATION" error page. The exact parameter set the live viewer issues is not derivable from the bootstrap JS (its base-URL variables are runtime-resolved), so the guessed parameter set was rejected by the service.
- The three-request budget was then exhausted. No offer data was observed at any point. `/services/publicationInfo` remains an unverified candidate for a later approved capture round, together with the inner viewer enrichment endpoints observed in a real browser session.

## Field paths (Step 2 checklist)

No structured offer payload was reachable within the request budget, so no JSON paths can be stated. Every required field is explicitly unresolved pending an approved capture of publicationInfo/viewerconfiguration and the inner viewer enrichment services.

| Field | Status | Reason |
|---|---|---|
| name | not observed | no structured offer payload reached; the bootstrap implies viewer-side product objects with `product_id`/`name`, but no endpoint was callable within budget |
| offer price | not observed | no payload seen; the bootstrap validates `price` on product objects client-side, which does not expose the source path |
| before price | not observed | no payload seen; the bootstrap references `discount_price` validation only |
| quantity | not observed | no payload seen |
| currency | not observed | no payload seen |
| validity | not observed | no payload seen |
| scope (geographic) | none observed | no payload seen; the kundeavis HTML carries no geographic scope information and no store/postcode parameter was part of the embed |
| member/multibuy/channel conditions | not observed | no payload seen |
| image fields | not observed | no payload seen; the CSP image-host list is not offer data |

The Step 2 capture fixtures (one ordinary unit offer, one conditional or ambiguous offer, one invalid or expired input) were not obtainable without the payload and remain outstanding.

## Geographic scope

None. No fetched response carried geographic scope information. The kundeavis page contains no region, store or postcode data in the inspected markup, and the Zmags services that would carry per-store or per-region offers were not reachable within budget. No scope claim is made; the plan warning that postcode 7011 must not be assumed to define the launch region stands.

## Qualification verdict

BLOCKED

Reason: a structured offer payload was not reachable within the three-request budget; the viewer-configuration probe failed with HTTP 500 and the bootstrap JS exposes only publication-level services. Next step for a later approved round: capture the exact parameter set the live viewer sends (browser observation of requests to secure.viewer.zmags.com), then probe `/services/publicationInfo` and the inner viewer enrichment endpoints with those parameters.

## 2026-09-22 — Browser-observation probe (live viewer session; two page loads max, no endpoint replay)

**Method.** Bounded observation of the kundeavis viewer in an already-loaded Chrome tab via the CUA Playwright/CDP bridge. The two permitted page loads were consumed in the initial session; all later evidence was collected with zero new page loads by evaluating the live `secure.viewer.zmags.com/services/htmlviewer/content/3b50b26c?pubVersion=7&environment=2&locale=en&viewerID=993db7ef` frame. No authenticated endpoints, no replay of unobserved URLs, no probing beyond observed traffic. `functions.exec` was unavailable all session ("too many active cells"), so no response bodies could be dumped to /tmp; every fact below was transcribed live from the viewer session and re-verified in-frame on 2026-09-22.

**Network requests observed to *.zmags.com / *.zma.gs (11 total across both page loads):**

1. `GET https://secure.api.viewer.zmags.com/viewer/viewer.js` — 200, application/javascript (public viewer bootstrap).
2.–9. Eight `GET https://cas.zma.gs/static/90b27b5d/*.js|css` — 200, static viewer assets (eight separate asset files under the same path prefix).
10. `GET https://secure.stats.zmags.com/services/launchpage?brand=viewer.zmags.com&launchPage=viewer_api_html` — stats beacon.
11. `GET https://cas.zma.gs/64d296c9b6fc7c5ba76fbd60/ssr/experiences/64e4d5ad6df9f10f7607589c/init.js` — 200, SSR bootstrapper, 58,761 chars. Contains `companyId 64d296c9b6fc7c5ba76fbd60`, `experienceId 64e4d5ad6df9f10f7607589c`; expects inline `preload_data_<experienceId>` / `behaviors_data_<experienceId>`. Zero occurrences of offer/product/hotspot/validity/quantity fields; the single `price` hit is a generic rule-engine `conditionType === 'price'`, not offer data. References `https://connect-adapter.api.zmags.com` and `/api/companies/{companyId}/experiences/…` only as code literals — never fetched in observed traffic.

**No dedicated offer/enrichment JSON endpoint was observed in any load.**

**Viewer-frame URL grammar (from the inline bootstrap script, 5,733 chars; re-verified live 2026-09-22):**

- `publicationApiURL: https://secure.api.viewer.zmags.com/publication`
- `serviceBaseURL: https://secure.viewer.zmags.com/services` with `publicationInfoServicePath: /publicationInfo`, `accessControlServicePath: /AccessControlJSON`
- `resourceServicePath: /resource`
- enrichmentDescriptor template: `/pub/{publicationID}/enr/{version}/{firstPageNumber}-{lastPageNumber}`
- productsDescriptor template: `/pub/{publicationID}/product/{version}/{firstPageNumber}-{lastPageNumber}`
- publicationDescriptor: `/pub/{publicationID}/{version}`
- pageRepresentation: `/pub/{publicationID}/pg{width}x{height}/{version}/{pageNumber}`
- publicationImage: `/pub/{publicationID}/image/{imageID}/{version}?maxWidth={maxWidth}&maxHeight={maxHeight}`
- `productIndexPath: https://secure.viewer.zmags.com/services/publicationapi/resource/a1a7bb78/prodidx/3b50b26c/7/`
- locale: `/locale/4/{locale}`; serviceConfiguration: `/service/{version}`; viewerConfiguration: `/viewer/993db7ef/7`

**Publication descriptor (inline config):** title "DM 39-26 MYBRING", 14 pages, `pageAspectRatio: 0.7835365853658537`, `firstPageIsCoverPage: true`, **`pagesWithProducts: []` (empty — no commerce/product data configured for this publication)**, `pagesWithEnrichments: [1,2,3,4,5,6,7,8,9,10,11,12,13,14]`, hex pageIDs beginning `cd8fac00, e92e8d44, cd8e8d04, 692fac60, 4d8fac20, 692e8d64, 4d8e8d24, …`.

**Live frame state (re-verified 2026-09-22 via in-frame DOM eval):** five page images fetched (`…/pg470x600/7/{1..5}?viewerID=993db7ef`); five `div.EnrichmentsContainer` elements, each containing only an empty hidden wrapper div (no hotspot or offer nodes); no `/enr/` or `/product/` request in resource timing or CDP traffic. Viewer core (642,103 chars inline) gates enrichment/product descriptor fetches behind a commerce flag (`if (w)`) and a per-active-page load flow (`enrichmentsDescriptorResourceID` + `productsDescriptorResourceID`, then `pageProductsDescriptor` / `pageEnrichments`). Startup console recorded `Uncaught Error: Mismatched anonymous define() module` from require.min.js plus `Uncaught SyntaxError: JSON.parse` at 126:60 and 2206:70 in the frame document — a malformed inline config blob at viewer startup may have killed enrichment initialization.

**Offer fields:** name / price / before-price / quantity / unit / validity / conditions were **not** found in any observed payload. No JSON offer document was captured, so no JSON paths can be recorded.

**Verdict upgrade: BLOCKED → PARTIAL.** Structured-data endpoints demonstrably exist and are documented in the viewer's own runtime configuration, and the viewer core contains the code path to fetch per-page enrichment/product descriptors. However, `pagesWithProducts` is empty for this publication, no enrichment/product JSON was ever observed on the wire across two full page loads plus the long-lived session, and the grammar-derived `/enr/` and `/product/` URLs remain unproven live — fetching them would be active probing beyond observed traffic, which is out of scope. Treat the URL grammar as a lead requiring its own bounded authorization, not as available data.
