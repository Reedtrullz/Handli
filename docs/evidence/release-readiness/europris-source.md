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
