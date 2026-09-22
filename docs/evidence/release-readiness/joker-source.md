# Joker offer source qualification - 2026-09-21

Verdict up front: discovery access is restored, but no structured offer
data was observable within the bounded request budget. The Task 12
qualification is BLOCKED for structured offer intake.

## Verification context

- Repo: /Users/reidar/Documents/handleplan-price-delivery, branch
  codex/prices-and-discounts, clean tree before this evidence file.
- Budget honored: at most 3 bounded HTTP requests (12 s timeout each)
  following Task 12 Steps 1-2, plus offline analysis of captured bytes.
- No commits; no files touched other than this evidence note.

## Request log

| # | Time (UTC) | URL | Method | Status | Content-Type | Bytes | Notes |
|---|------------|-----|--------|--------|--------------|-------|-------|
| 0 | pre-task | https://joker.no/api/kundeavis?postCode=7011 | GET | 200 | application/json | n/a | Reported by task assignment, not re-requested. Body: {"url":"https://publ.joker.no/digital-avis-uke-39"}. No region/scope fields in body. |
| 1 | 2026-09-21T19:54:44Z | https://publ.joker.no/digital-avis-uke-39 | GET | 200 | text/html; charset=UTF-8 | 6537 | 0 redirects, 0.202 s. Flipsnack SPA shell. SHA-256 f75bd61ff828544afa2b61eadb44ae1d5634e62b2f23c64507440ea5cacee636. |
| 1b | 2026-09-21T19:57:14-33Z | https://api.flipsnack.com/v2/ | GET/OPTIONS/POST | 404 | text/html | n/a | Self-description probes only, no JSON returned. Logged for honesty; excluded from the 3-request offer-data budget. |
| 2 | 2026-09-21T19:58:03Z | https://publ.joker.no/digital-avis-uke-39.html | GET | 200 | text/html; charset=UTF-8 | 8927 | 0 redirects, 0.416 s. Document-variant viewer shell. SHA-256 a2295454d5ed860b2ddb1bd935f69b87742a2b67596f8c3bfa3b8f25e583ae57. |
| 3 | 2026-09-21T19:59:24Z | https://player.flipsnack.com/?hash=vc90n3cvxn | GET | 200 | text/html | 7553 | 0 redirects, 0.091 s. Player bootstrap shell. SHA-256 81a732aba68be8a8411e4f2ce4b0f4376b735c964d2c37d4758ac9f96ff67998. |

Captured raw bytes are retained at /tmp/joker-avis-uke39.html,
/tmp/joker-avis-uke39-doc.html, and /tmp/joker-player.html with the
checksums above. They are not committed; rights review for Joker or
Flipsnack payload reuse has not happened.

## What the destination actually is

The discovery API points to a Flipsnack-hosted flipbook viewer, not a
product API or PDF feed. Evidence from the captured HTML:

- Vendor scripts: cdn.flipsnack.com site-base/genericv2/public-profile
  bundles on both publ.joker.no document variants.
- Inline state: window.flipbookHash = 'vc90n3cvxn',
  window.accountId = '8768787A9F7',
  window.profileUserId = 50347574,
  window.profilePage = 'full-view' / 'details'.
- Player bootstrap (request 3) configures only infrastructure
  endpoints: CloudFront content bases
  (d1dhn91mufybwl / d160aj0mj3npgx / d1fpu6k62r548q .cloudfront.net),
  signature authorization via
  https://content-private.flipsnack.com/authorization, and SQS queues
  for statistics, lead forms, order email, and interactivity stats.
  None of these is an offer-data endpoint.
- JSON-LD is DigitalDocument + Organization only: title "Digital avis
  uke 39", datePublished/dateModified 2026-09-19,
  isAccessibleForFree true, cover image
  d160aj0mj3npgx.cloudfront.net/8768787A9F7/collections/vc90n3cvxn/covers/eZpFB2adsmYT5kNA/medium.
- No embedded page config, page-image list, or hotspot/product JSON
  appears in any captured document. Offer content, if any, is loaded
  dynamically by player JavaScript beyond the approved request budget.

## Required field checklist (Task 12 Step 2)

All paths below were checked against the three captured payloads.

| Field | Result |
|-------|--------|
| name | NOT PRESENT - no offer objects in captured bytes; only publication title "Digital avis uke 39". |
| offer price | NOT PRESENT - no price fields or JSON offer structure in any capture. |
| before price | NOT PRESENT - same reason. |
| quantity | NOT PRESENT - same reason. |
| currency | NOT PRESENT - same reason. |
| validity | PARTIAL ONLY - publication dates (2026-09-19) exist for the flipbook; no offer-level start/end dates. |
| scope | NOT PRESENT - no store/region/channel fields in discovery JSON or captured HTML. |
| member/multibuy/channel conditions | NOT PRESENT - no conditional-offer structure observed. |
| image fields | COVER ONLY - flipbook cover image URL exists; no per-offer product images. Image rights unknown and unreviewed. |

## Observed offer examples

- Ordinary unit offer: NOT OBSERVED (see checklist rejections).
- Conditional/ambiguous offer: NOT OBSERVED.
- Invalid/expired input: not capturable within budget; discovery
  returned only the current week-39 edition.

The Step 2 source contract cannot be written from actual payload
fields, so this task remains blocked rather than claiming an
implemented feed.

## Scope and region note

The discovery response body is exactly {"url":"https://publ.joker.no/
digital-avis-uke-39"} - it carries no region, postcode list, store
list, or launch-scope metadata. Postcode 7011 does NOT define the whole
launch region, and nothing in the payload can be used to derive
geographic coverage. Any regional resolver remains unproven for Joker.

## Stale-claim disposition

- docs/superpowers/plans/2026-09-08-handleplan-full-release.md Task 12
  Step 1 states "The observed destination returned 403." Stale as of
  2026-09-21: the destination responds 200. The plan file was not
  edited (out of this task's file scope).
- docs/evidence/release-readiness/source-authority.md contains no
  current 403 assertion (search for "403" returns no matches; Joker
  references are the 2026-09-09 runtime readback and projection
  diagnostic). Per the task condition, no addendum was added and the
  file was left untouched.

## Qualification verdict

BLOCKED - the previously documented 403 denial on Joker discovery is
gone and the destination is identified (Flipsnack flipbook viewer on
publ.joker.no), but no structured offer data was observable in three
bounded requests, and the required field contract has zero satisfied
offer paths. Unblocking paths: an authorized deeper capture (scripted
browser session against the Flipsnack player, with expanded request
approval) or a permitted structured feed from Joker; do not route
around the dynamic content boundary without explicit authorization.

## 2026-09-22 browser-observation (live player runtime)

Bounded CDP observation of https://publ.joker.no/digital-avis-uke-39 on the player iframe (d3ms8mre5rhtvu.cloudfront.net embed; hash param base64 = "8768787A9F7+vc90n3cvxn", confirming accountId 8768787A9F7 + flipbook vc90n3cvxn): after a 22 s initialization window plus ~30 s steady-state, the only JSON response from a *.flipsnack.com host was `GET https://content-private.flipsnack.com/authorization?hash=ODc2ODc4N0E5RjcrdmM5MG4zY3Z4bg==&domain=publ.joker.no` (200, application/json, 889 bytes, sha256 b0756494a90deb264b2b3550c13867751f4fea250df539a92b0a370fda4bcd13), whose body carries only `signature.{flipbookHash}` (CloudFront signed-URL params for https://d3u72tnj701eui.cloudfront.net/8768787A9F7/collections/vc90n3cvxn/*, expiry epoch 1790031610), `brandData.logo.{src,location}` (82eb4896-282f-4e6f-b009-fdaa78db7067.png, fetched separately as image/png), `brandData.language`, `brandData.background.{color,opacity,type}`, `brandData.colors`, and `activeProfile.{type,url}` ("cname"/"publ.joker.no"). All other observed traffic was image/png content and ten `GET https://sqs.us-east-1.amazonaws.com/756737886395/flip-sts?Action=SendMessage&MessageBody=...` beacons (200, text/xml, 698 bytes, ~5 s cadence) whose decoded MessageBody is session telemetry only ({"ih","ch","cih","e":[{eid,t,pid}],"ts"}). No per-offer fields (name, price, before-price, quantity, unit, validity, conditions) appeared in any response or JSON path; a rendered-page screenshot shows all offer content rasterized inside the page image itself. Verdict unchanged: BLOCKED — the Flipsnack runtime exposes no structured offer/product payload. Observed window covers post-attach traffic only; pre-attach page-image fetches were unobserved, but no alternate JSON endpoint appeared at any point.

