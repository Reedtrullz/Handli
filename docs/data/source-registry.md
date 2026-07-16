# Handleplan source registry

- Last reviewed: 2026-07-16
- Machine-readable contract: [source-registry.v1.json](./source-registry.v1.json)
- Revocation procedure: [source-kill-switch.md](./source-kill-switch.md)
- Candidate coverage: [launch-coverage.v1.json](./launch-coverage.v1.json)
- Benchmark corpus: [benchmark-baskets.v1.json](./benchmark-baskets.v1.json)

## Decision

Handleplan treats technical accessibility and reuse permission as separate facts. A documented endpoint, public customer paper, or valid credential does not by itself authorize persistent storage, derived rankings, public display, redistribution, imagery, or trademark use.

The runtime state vocabulary is:

- `approved`: primary evidence authorizes the intended use and all recorded obligations are accepted;
- `conditional`: a plausible source path exists, but at least one material condition is unresolved;
- `blocked`: automated use is not authorized or affirmative permission evidence is absent; and
- `revoked`: access previously considered usable has been withdrawn, suspended, terminated, or invalidated.

Unknown permission fails closed to `blocked`. Every source defaults off. Public price or offer ranking may consume only `approved` sources. State promotion requires dated primary evidence, a named reviewer, recorded obligations, and regeneration of the launch coverage manifest.

## Current registry

| Source | Intended role | State | Public ranking | Binding reason |
|---|---|---:|---:|---|
| Kassalapp API | catalog, ordinary prices, history, stores | conditional | no | Commercial app access is advertised, but the current credential tier and storage/display/redistribution terms are not recorded |
| Tjek API | structured official offers | conditional | no | Customer-only API; the signed agreement defines the permitted services and Handleplan has no verified agreement |
| Bunnpris public web | stores and customer papers | blocked | no | Public presentation is not affirmative permission for automated reuse |
| REMA 1000 public web | stores and regional customer papers | blocked | no | Public presentation is not affirmative permission for automated reuse |
| Coop/Extra public web | stores, regional papers, member offers | blocked | no | Public presentation is not affirmative permission for automated reuse |
| Kartverket Address API | opt-in address lookup | approved | not applicable | Official terms permit commercial and non-commercial reuse under CC BY 4.0; attribution is mandatory |
| openrouteservice API | opt-in route estimate | conditional | no | Result reuse is documented, but provider selection, account quota, and origin-coordinate privacy review are unresolved |

No grocery source is approved as of this review. Consequently, no candidate region is launch-eligible and Handleplan must not claim complete three-chain comparison.

## Primary evidence

All observations below were retrieved from official pages on 2026-07-16. They record what the public source says; they do not substitute for a project-specific agreement.

### Kassalapp

- [Kassalapp pricing](https://kassal.app/pris) describes Hobby access as non-commercial and limited to 60 requests per minute. It describes Bedrift as suitable for embedding price and product functionality in an app and asks users to make an agreement. This supports a viable commercial path but does not prove the current key's tier or full downstream rights.
- [Kassalapp API documentation](https://kassal.app/api/docs) documents product search, EAN lookup, physical stores, and bulk price history. The documented bulk endpoint accepts at most 100 EANs and distinguishes regular and premium history windows. Endpoint documentation proves technical capability, not retention or republication permission.

Unresolved: credential tier; persistent raw and derived storage; historical aggregation; public rankings; imagery; marks; attribution; rate limits; termination; deletion; and measured three-chain regional coverage.

### Tjek

- [Tjek APIs and SDKs](https://tjek.com/apis-and-sdks) says the API is available only to customers and directs prospective users to contact Tjek.
- [Tjek terms](https://tjek.com/terms), sections 8.1-8.6, make API use agreement-specific, limit it to agreed services on customer-owned platforms, prohibit systematic third-party reuse unless expressly agreed, and prohibit using the content to train or improve AI/ML models without written approval.

Unresolved: whether Handleplan will become a customer; authorized retailers, regions, fields, derived calculations, imagery, marks, attribution, cache/retention, deletion, and post-termination handling. No Tjek fetch, OCR, classifier training, or public display is approved.

### Retailer public pages

- [Bunnpris](https://www.bunnpris.no/) and its [store directory](https://www.bunnpris.no/butikker) expose stores and customer papers.
- [REMA 1000 campaigns](https://www.rema.no/kampanjevarer/) and the [Oslo customer-paper page](https://www.rema.no/kundeaviser/oslo/) expose offers and geographic validity. The Oslo page says it applies in Oslo and Gjelleråsen, showing that regional scope is material.
- [Extra offers](https://www.coop.no/extra/tilbud), the [Hordaland publication](https://kundeavis.coop.no/aviser/extra/hordaland/), and the [Midt publication](https://kundeavis.coop.no/aviser/extra/midt/) expose customer papers, member benefits, validity dates, and stock/error caveats.

These pages support manual product research and launch-feasibility checks only. This review found no affirmative authorization for Handleplan's automated extraction, persistence, derived comparison, or republishing. Each retailer web source therefore remains blocked. A future authorized feed must receive a distinct source ID rather than silently changing the meaning of a web-scraping entry.

### Geocoding and routing

- [Kartverket terms](https://www.kartverket.no/en/api-and-data/terms-of-use) release free products for commercial and non-commercial use under CC BY 4.0 and require `©Kartverket` plus a link where practical. The [Address API guide](https://kartverket.no/api-og-data/eiendomsdata/brukarrettleiing-adresse-api) says registration is not required and describes integration into public-facing services. Approval is narrowly scoped to this address API, not map tiles or unrelated services with external licenses.
- [openrouteservice terms](https://openrouteservice.org/terms-of-service/) require `© openrouteservice.org by HeiGIT | Map data © OpenStreetMap contributors`, license API results under CC BY 4.0, and describe account/usage constraints. [API restrictions](https://openrouteservice.org/restrictions/) document endpoint limits. Provider selection, production quota, and a privacy review for user-origin coordinates still block activation.

## Required evidence before a grocery source becomes approved

For the exact Handleplan use case, record:

1. legal/operator identity and agreement version;
2. access method and credential tier without recording secrets;
3. permitted processing and canonical matching;
4. raw, normalized, and derived retention periods;
5. public derived displays, rankings, savings, and historical comparisons;
6. redistribution and API-response exposure;
7. publication/product imagery and retailer marks;
8. attribution wording and placement;
9. rate limits, caching, monitoring, and support expectations;
10. authorized chains, regions, fields, membership conditions, and validity semantics;
11. termination, revocation, deletion, and audit obligations; and
12. named internal reviewer and next review date.

Written permission should be linked or referenced by a non-secret agreement identifier. Confidential agreements must not be committed to the public repository.

## Review result

Gate A is not passed. Kassalapp, Tjek, and retailer rights remain unresolved. The safe next move is commercial/rights outreach plus a measured Kassalapp coverage probe under verified terms. Until then, the launch manifest stays candidate-only and every grocery comparison is ineligible for public v1 claims.
