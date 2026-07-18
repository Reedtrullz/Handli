# Handleplan v1 Comprehensive Work Plan

**Status:** implementation source of truth

**Baseline audited:** 2026-07-16 at a890b05fa07e5fa2fc806b0640a62cf37f8b234e

**Product specification:** [approved design](../specs/2026-07-15-handleplan-design.md)

**Delivered alpha plan:** [foundation and Planlegg](2026-07-15-handleplan-planlegg-foundation.md)

## 1. Outcome

Handleplan v1 is a public-good Norwegian grocery planner that lets an anonymous shopper:

1. describe what they need, including exact, constrained, or flexible products and required quantities;
2. compare complete baskets across Bunnpris, REMA 1000, and Extra;
3. move between maximum savings and maximum convenience using only real, non-dominated plans;
4. use one, two, or at most three stores;
5. optionally calculate route-based travel time without Handleplan retaining their origin;
6. understand exactly which prices, offers, assumptions, and gaps produced the recommendation;
7. browse official offers and defensible historical price changes in Oppdag; and
8. take an immutable plan into an offline Handlemodus checklist.

The v1 promise is not “we know every price.” It is:

> Handleplan recommends the lowest-cost or most-convenient complete plan among the prices it can verify, shows the comparison scope, and never hides unknown coverage behind a “best” claim.

## 2. Strategy correction

The protected alpha proves the interaction and the deterministic planner core, but it does not yet prove a public v1 data product. The old four-step roadmap placed travel before offer ingestion. This plan changes that order.

The v1 critical path is:

~~~text
data rights and launch scope
  -> product-truth and coverage contracts
  -> append-only evidence and canonical catalog
  -> scheduled base-price collection
  -> coverage-aware planner
  -> one complete offer-ingestion vertical
  -> review and regional applicability
  -> three-chain offer coverage
  -> travel, Oppdag impact, and Handlemodus
  -> public-release proof
~~~

Travel, the PWA shell, accessibility infrastructure, governance, and operational tooling may proceed in parallel after their contracts stabilize. No feature may outrun the evidence needed to describe it truthfully.

## 3. Current baseline

### 3.1 What is already strong

- Next.js/TypeScript monorepo with domain, Kassalapp, database, and web boundaries.
- Integer-øre money model and deterministic planning.
- Complete-basket invariant, explicit matching rules, and a maximum of three chains.
- Pareto plan generation with unit and property tests.
- Server-only Kassalapp credential boundary and deterministic fake mode.
- Anonymous local basket persistence.
- Working Planlegg, result, and Oppdag routes.
- Protected VPS preview, forward migrations, container health checks, and rollback.
- Unit, integration-shaped, component, responsive, and Chromium end-to-end coverage.

These are preserved. This is an additive migration, not a greenfield rewrite.

### 3.2 Gaps that block v1

| Area | Current behavior | v1 requirement |
|---|---|---|
| Catalog | Browser-facing products are effectively keyed by EAN; generic families are fake-data dependent | Stable canonical products, aliases, package measures, reviewed family membership, server rehydration |
| Quantities | Required g/ml needs fail closed; package count is the usable path | Whole-package fulfilment for g, ml, piece, and package with visible surplus |
| Price evidence | price_cache overwrites one latest row per EAN/chain | Append-only observations with source, scope, ingestion run, confidence, and history |
| Coverage | Missing upstream rows disappear; planner scope is inferred from returned rows | Every need × supported chain is priced, known-not-carried, stale, ineligible, or unknown |
| “Best” copy | A plan can look complete while REMA/Extra evidence is absent | Qualify partial comparisons; reserve unqualified “best” for complete declared scope |
| Discounts | Oppdag can present a recent different observation like a discount | Separate verified official offer, official before-price, and historical comparison types |
| Offers | No direct flyer/feed ingestion, review, regional scope, membership, or multibuy | Rights-cleared three-chain offer pipeline with immutable evidence and review |
| Travel | A preference component exists but is not connected | Optional ephemeral origin, real route-provider estimate, branch suggestions, graceful fallback |
| Frontier UI | Browser and domain duplicate dominance/projection logic | One server-owned candidate/frontier/projection contract; slider maps only to returned plans |
| Oppdag | Browsing works, but no plan impact and incomplete savings provenance | Browse by chain/category/offer type; add/replace/lock impact using the same planner snapshot |
| Handlemodus | No active-trip snapshot, offline route, or PWA | Immutable local trip snapshot and offline checklist |
| Operations | Static process health; DB tests may skip; no worker/source health/restore proof | Scheduled worker, source status, distributed controls, live DB CI, backups, alerts, drills |
| Public operation | Owner-only Cloudflare Access preview | Public surface only after privacy, rights, security, accessibility, and regional gates pass |

## 4. Binding v1 scope

### 4.1 In scope

- Bunnpris, REMA 1000, and Extra.
- A declared launch-region set with national, regional, local, or store-set applicability.
- Candidate launch regions are Oslo, Bergen, and Trondheim, but the rights/coverage gate makes the final decision.
- Kassalapp documented product, price, category/label, and physical-store data where contractually permitted.
- Rights-cleared structured offer feeds, preferably a licensed aggregation feed such as Tjek or authorized retailer feeds.
- Authorized direct publication capture and OCR only where a sustainable structured source is unavailable.
- Small human review queue; all OCR-derived offers require review in v1.
- Exact, constrained, and flexible basket needs.
- Whole-package quantity fulfilment and multibuy arithmetic.
- One-to-three-store plans and a real convenience/savings selector.
- Optional car/bike route-time calculation using an explicit temporary origin.
- Oppdag, Planlegg, and offline Handlemodus.
- Anonymous local-first use and public-good operation.

### 4.2 Explicit non-goals

- Accounts, cloud sync, social profiles, or personalized recommendations.
- Loyalty-provider login, private coupons, payment, checkout, or receipt import.
- Stock or branch-inventory claims.
- Branch-specific price claims unless a source explicitly provides branch-level evidence.
- Native iOS/Android apps.
- Recipe or meal planning.
- Sponsored ranking, paid placement, or retailer-biased optimization.
- Crowdsourced prices as a primary v1 evidence source.
- Scraping private or undocumented retailer APIs.
- Public reproduction of copyrighted publication pages without recorded rights.
- More than three stores in one plan.
- Price alerts, barcode scanning, and household collaboration; candidates for later releases.

## 5. Product-truth contracts

These invariants are release-blocking and must be encoded in domain types, tests, API schemas, and user-facing copy.

### 5.1 Price and offer semantics

1. **Ordinary price observation** is a source-stamped observed package price.
2. **Official offer** has a rights-cleared source, validity, geographic scope, conditions, and immutable provenance.
3. **Official before-price** is displayed only when the official source supplies an eligible reference price.
4. **Historical comparison** is an analytical comparison, never an official discount. Default: median eligible ordinary observation in the trailing 30 days with observations on at least seven distinct days.
5. A missing source row is **unknown**, unless affirmative source evidence proves known-not-carried.
6. Stale, expired, wrong-region, unknown-scope, ambiguous, or membership-ineligible evidence cannot win a plan.
7. Fresh ordinary prices default to a 72-hour eligibility ceiling unless a source-specific contract is stricter.
8. Offers expire at approved validUntil. Fetch failure never extends them.
9. Monetary values and quantity arithmetic use integers in base units and øre.

### 5.2 Coverage semantics

For every requested need and every declared supported chain, return one state:

- priced
- known_not_carried
- stale
- ineligible
- unknown

Every plan response includes:

- expected chains;
- verified chains;
- unknown chains;
- complete or partial comparison status;
- per-need/per-chain reasons; and
- evidence identifiers for every assignment.

A partial comparison may return useful complete plans, but the interface must say “among verified prices” and must not use copy equivalent to “best across all three.”

### 5.3 Matching and fulfilment semantics

- Exact EAN is the only automatic high-confidence product merge.
- Name/brand/package similarity creates a review candidate, not a silent merge.
- Flexible family membership is reviewed or produced by a versioned deterministic rule.
- The server rehydrates EAN and family identities; browser-supplied metadata is never authoritative.
- Required g/ml/piece/package amounts are fulfilled with whole purchasable packages.
- Plan output shows requested amount, package count, purchased amount, and surplus.
- Multibuy uses the qualifying group price plus the best eligible ordinary price for any remainder.
- A substitution is never silent; the admitted candidate set and changed choice remain inspectable.

### 5.4 Planning and travel semantics

- Every returned plan covers every required need and quantity or is explicitly a fail-closed result.
- Maximum store count is three.
- Candidate generation happens before travel-aware Pareto filtering.
- Price-only objectives are checkout total, store count, and substitutions.
- Travel-enabled objectives are checkout total, store count, route seconds, and substitutions.
- The slider maps only to actual representative plans from the non-dominated frontier.
- The savings endpoint and convenience endpoint are always available when distinct.
- At most seven representative slider positions are shown.
- Route time is labelled “calculated route estimate,” not guaranteed actual time.
- Chain-level prices remain distinct from suggested physical branches and do not imply stock.
- If routing fails, Handleplan recomputes a coherent price-only frontier; it never mixes known and unknown travel costs.

### 5.5 Privacy semantics

- Location is requested only after explicit opt-in.
- Address, coordinates, route geometry around the origin, and origin labels are not written to localStorage, sessionStorage, IndexedDB, cookies, URLs, analytics, application logs, or persistent route caches.
- Provider tokens remain server-only.
- The public response returns branch stops and aggregate route time/distance, not the origin.
- Basket and active-trip data stay local and are user-clearable.
- No behavioral analytics are added without a separate documented consent decision.

## 6. Target architecture and data model

### 6.1 Components

~~~text
Browser
  Planlegg / Oppdag / Handlemodus
       |
       v
Next.js public API
  catalog + coverage + plan + discovery + travel
       |
       +--------------------+
       v                    v
Domain engine          Provider adapters
matching/fulfilment    Kassalapp / offer source
frontier/explanation   Kartverket / route matrix
       |                    |
       +----------+---------+
                  v
PostgreSQL evidence store + private immutable capture store
                  ^
                  |
Scheduled worker: catalog, prices, stores, publications, extraction,
validation, review publishing, expiry, history, source health
~~~

### 6.2 Durable records

| Group | Required records |
|---|---|
| Catalog | canonical_products, product_identifiers, source_products, product_families, product_family_memberships |
| Source governance | data_sources, source_permissions, permission_review_events |
| Price evidence | ingestion_runs, price_observations, price_coverage_checks, historical_price_statistics |
| Geography | physical_stores, geographic_scopes, scope_regions, scope_postal_codes, scope_store_ids |
| Publications | publications, publication_captures, extraction_runs, extracted_offer_candidates |
| Offers | offer_matches, approved_offers, offer_targets, offer_conditions |
| Review | review_actions with actor, reason, previous/new version, and timestamp |
| Operations | source_health_snapshots, worker_leases, alert_events |

Source captures live in a private immutable blob store. PostgreSQL stores the blob key, checksum, MIME type, size, retrieval metadata, and rights classification. A protected VPS volume is acceptable for the first deployment only with tested offsite backup and a documented S3-compatible migration path.

### 6.3 Kassalapp boundary

Consume only documented, necessary endpoints behind versioned contract fixtures:

- products search
- exact product/EAN lookup
- bulk prices
- physical stores
- categories
- labels
- webhooks if the documented delivery/permission model is suitable

The adapter returns source DTOs, not public domain products. All normalization, rejection, source identity, unknown-chain handling, and evidence persistence remain auditable. Credentials remain in the existing server-only 1Password-backed environment; no secret value enters tests, docs, logs, or browser bundles.

### 6.4 Offer-source order of preference

1. Licensed structured aggregation feed with redistribution rights.
2. Authorized structured retailer feed.
3. Authorized direct publication capture with embedded text extraction.
4. Authorized OCR with mandatory human review.

If none is sustainable for a launch chain/region, that scope fails the data gate. The response is not to use undocumented endpoints or weaken provenance.

## 7. Workstreams and dependencies

| Workstream | Primary responsibility | Can start | Blocks |
|---|---|---|---|
| A. Rights and governance | source permission, launch scope, public-good charter | now | offer adapters, public release |
| B. Evidence platform | contracts, catalog, append-only prices, coverage, worker | after A0 scope draft | every truthful product surface |
| C. Offers | capture/feed, extraction, validation, review, regional applicability | after A permission per source and B contracts | official discounts in Planlegg/Oppdag |
| D. Planner/product | fulfilment, frontier, coverage UX, slider, Oppdag impact | after B contracts; integrates as B lands | user-complete v1 |
| E. Travel | branches, geocoding, route matrix, temporary origin | after plan-result v2 | convenience objective |
| F. Handlemodus | trip snapshot, PWA, offline checklist | after plan-result v2 | shop-ready v1 |
| G. Trust/release | security, privacy, a11y, CI, backups, monitoring, acceptance | starts now; continuous | public release |

Recommended parallel lanes after contracts freeze:

~~~text
Lane 1: evidence schema -> Kassalapp worker -> coverage service
Lane 2: offer vertical -> review queue -> remaining chain adapters
Lane 3: fulfilment/frontier -> travel -> slider and Planlegg integration
Lane 4: trip snapshot/PWA -> Handlemodus
Lane 5: governance/security/a11y/ops -> acceptance evidence
~~~

## 8. Implementation batches

Each batch is one focused PR or a small, explicitly linked PR stack. Every batch starts with failing tests, keeps fake mode deterministic, updates contracts/runbooks, and records evidence before merge.

### V1-00 — Truth reset and execution controls

**Depends on:** nothing

**Outcome:** current alpha claims and the v1 program agree with reality.

Deliver:

- Make this plan the roadmap source of truth.
- Add docs/contracts/v1-product-truth.md containing Section 5 in user-facing and engineering language.
- Correct current Oppdag styling/copy so a “previous observation” is not struck through or labelled “Spar.”
- Add a visible protected-alpha/coverage notice while only partial live data exists.
- Add a release-gate checklist that is evidence-linked, not checkbox-only.
- Record the baseline commit, current test counts, known skips, live-source limitations, and protected deployment state.

Acceptance:

- No current route claims an official discount without official-offer evidence.
- No current route claims all-three-chain “best” with partial coverage.
- Existing tests/build remain green.

### V1-01 — Data rights, source registry, and launch manifest

**Depends on:** V1-00

**Outcome:** sustainable data sources and a bounded launch promise.

Deliver:

- docs/data/source-registry.md for Kassalapp and each offer source.
- Record permitted access, processing, retention, derived display, redistribution, imagery, marks, attribution, rate limits, and termination risk.
- Evaluate licensed Tjek access and authorized retailer alternatives before any source-specific scraping work.
- Define a machine-readable coverage manifest: chain, source, price class, geographic scope, refresh target, evidence level, and known gaps.
- Select launch regions from measured feasibility. Oslo, Bergen, and Trondheim are candidates, not assumptions.
- Define 20 representative baskets per launch region.
- Add ADRs for official-vs-historical classification and launch-scope policy.
- Add a runtime source state for approved, conditional, blocked, and revoked, plus a per-source kill switch and revocation procedure.

Gate A:

- Every launch chain has a sustainable ordinary-price path.
- Every launch chain/region intended to show official offers has a rights-cleared offer path.
- Unresolved rights produce a smaller declared launch scope, never an undocumented workaround.

### V1-02 — Versioned product-truth domain contracts

**Depends on:** V1-00; source-neutral work may run with V1-01

**Outcome:** every downstream team uses the same evidence and coverage vocabulary.

Modify packages/domain/src/contracts.ts and exports. Add focused modules for coverage, geography, fulfilment, offers, history, and explanations.

Deliver types for:

- CanonicalProduct, ProductIdentifier, ProductFamily, PackageMeasure
- EvidenceSource, PriceEvidence, EvidenceLevel
- CoverageStatus, ComparisonScope
- GeographicScope and OfferApplicability
- OfficialOffer, OfferCondition, HistoricalComparison
- Fulfilment, PlanObjectives, TravelResult, PlanExplanation

Acceptance:

- Unknown cannot parse or coerce to absent.
- HistoricalComparison cannot parse as OfficialOffer.
- Wrong-scope, stale, expired, ambiguous, or disabled-member evidence fails closed.
- Source is no longer hard-coded to Kassalapp.
- Contracts are versioned and have boundary/overflow tests.

### V1-03 — Additive evidence persistence and rollback path

**Depends on:** V1-02

**Outcome:** durable history and provenance without risking the alpha read model.

Deliver forward-only migrations for:

1. sources, permissions, catalog, and identifiers;
2. price evidence, coverage checks, and ingestion runs;
3. geography and physical stores;
4. publications, captures, candidates, and extraction runs;
5. approved offers, applicability, review audit, and source health.

Implementation:

- Keep `price_cache` as the rollback read model for the previous immutable
  application image only. The current public process must not be able to switch
  back to provenance-poor legacy rows at runtime.
- Backfill it under a synthetic legacy-import run, marked ineligible for official reference-price claims.
- Dual-write the append-only evidence mirror and retain the deterministic
  legacy/evidence comparison harness for offline and CI proof.
- The earlier live `legacy | shadow | evidence` web flag is superseded by an
  image-level cutover: the current image reads evidence only, while the
  network-disabled legacy rollback image may read `price_cache`. This prevents
  an operator flag or stale environment value from silently weakening public
  provenance after cutover.
- Retain legacy storage through at least one release and restore cycle.

Acceptance:

- Clean install and upgrade from migration 001 pass against real PostgreSQL in CI.
- Migration checksums are immutable and reruns idempotent.
- Distinct observations never overwrite one another.
- Concurrent jobs cannot duplicate publications/offers.
- Backup/restore includes database state, audit trail, and capture metadata.

### V1-04 — Canonical catalog and Kassalapp ingestion worker

**Depends on:** V1-03

**Outcome:** source records become auditable products and scheduled price evidence.

Deliver:

- New apps/worker service.
- Catalog refresh, benchmark-price refresh, physical-store sync, and historical-observation jobs.
- Catalog repositories and canonicalization service.
- GTIN checksum validation; invalid records remain quarantined source records.
- Exact EAN auto-link only; ambiguous candidates enter review.
- Integer package measures normalized to g, ml, piece, and package.
- Versioned fixtures for every consumed Kassalapp endpoint.
- Distributed request budget, request coalescing, timeouts, bounded parsing, retries, and run counters.

Acceptance:

- Missing/null price rows become unknown coverage.
- Unknown chain codes quarantine instead of disappearing.
- kg/l/cl/dl normalization is exact.
- Duplicate upstream rows converge deterministically.
- Rate-limit, timeout, cancellation, partial batch, oversized response, and malformed data tests pass.
- A redacted live probe runbook proves each active contract without printing credentials.

### V1-05 — Canonical matching and server-authoritative planning input

**Depends on:** V1-04

**Outcome:** exact and generic needs work with live-normalized data.

Deliver:

- CatalogService and reviewed family taxonomy.
- Product-by-EAN rehydration in POST /api/plans.
- Browser requests contain identities and user-approved matching rules, not trusted product metadata.
- Candidate inspection and explicit confirmation for ambiguous/flexible matches.
- Basket-state v2 migration; retain convenience preference, not a brittle plan ID.

Acceptance:

- Generic “melk” and representative families work in live-normalized fixtures.
- Forged browser brand/family fields cannot change exact matching.
- Duplicate aliases normalize deterministically.
- Unknown family requires an explicit exact choice.
- Valid v1 local baskets migrate; corrupt or oversized state resets safely.

### V1-06 — Quantity fulfilment and offer arithmetic

**Depends on:** V1-02, V1-05

**Outcome:** plans buy enough real packages and explain overbuy.

Deliver packages/domain/src/fulfilment.ts and integrate it into matching/planning.

Acceptance fixtures include:

- 1.5 l fulfilled by two 1 l packages;
- 1 kg versus two 500 g packages;
- piece multipacks and exact package counts;
- visible surplus;
- incompatible/missing units;
- safe-integer overflow;
- 2-for-X and 3-for-X with non-multiple remainders;
- membership enabled and disabled.

All comparisons use total purchase cost, never a misleading unit-only price.

### V1-07 — Eligible price, history, and explicit coverage services

**Depends on:** V1-03 through V1-06

**Outcome:** one source-neutral service decides which evidence may enter a plan or discovery claim.

Create:

- apps/web/lib/server/catalog-service.ts
- apps/web/lib/server/price-service.ts
- apps/web/lib/server/coverage-service.ts
- derived historical-comparison query/materialization

Refactor plan-service.ts and discovery-service.ts to use them.

Acceptance:

- Every assignment exposes an immutable evidence ID, source class, time/validity, scope, and conditions.
- Every missing need/chain has a reason.
- Ordinary price, official offer, and historical comparison are separate response fields.
- Official offer wins only when it lowers the qualifying checkout cost.
- History is hidden until the 30-day/seven-distinct-day threshold is met.
- Existing API consumers have an explicit versioned compatibility transition.

### V1-08 — Coverage-aware candidates, frontier, and explanations

**Depends on:** V1-06, V1-07

**Outcome:** planning remains correct before and after travel is attached.

Refactor into pure stages:

~~~text
enumerateCompletePlanCandidates
  -> attachOptionalTravelEvidence
  -> paretoFrontier
  -> projectRepresentatives(max 7)
  -> explainPlanDeltas
~~~

Move dominance, ordering, endpoints, and projection into packages/domain. Delete competing browser optimizer logic.

Acceptance:

- Candidate enumeration considers all declared supported chains, not only chains with returned rows.
- No returned plan is dominated.
- Both endpoints survive projection.
- Input permutations produce byte-equivalent ordering and IDs.
- A price-dominated candidate may enter the frontier after valid travel evidence is attached.
- Routing failure triggers a complete price-only recomputation.
- Every response contains complete/partial comparison scope and coverage matrix.
- Property tests retain complete-basket and maximum-three-store invariants.

### V1-09 — One rights-cleared offer vertical

**Depends on:** Gate A, V1-03, V1-07

**Outcome:** one retailer/source works end to end before the design is copied three times.

Choose the first source by permission and sample quality.

Pipeline:

1. discover publication/feed edition;
2. resolve declared geography;
3. capture or ingest immutably with checksum;
4. prefer structured/embedded text; OCR only when necessary;
5. emit typed candidates;
6. validate dates, units, arithmetic, membership, scope, duplicates, and anomalies;
7. exact-match or create a review candidate;
8. approve, publish, and expire.

Acceptance:

- Rights-cleared golden fixtures cover ordinary price, before-price, multibuy, member offer, package size, local edition, unreadable date, and anomaly.
- Capture checksum plus extractor version makes processing idempotent.
- Layout/schema change becomes degraded/failed, never silent empty success.
- Wrong/unknown scope cannot publish.
- OCR cannot auto-publish.
- Expired offers disappear even during source outage.

### V1-10 — Private review queue and immutable audit

**Depends on:** V1-09

**Outcome:** a small reviewer can safely turn candidates into public facts.

Deliver:

- Private /review route and APIs.
- Filters by chain, scope, age, confidence, and anomaly.
- Rights-appropriate source crop beside typed fields.
- Approve, correct-and-approve, reject.
- Optimistic concurrency and append-only action log.
- Separate Cloudflare Access policy and server-side assertion verification.

Acceptance:

- Unauthorized callers cannot enumerate queue counts, candidates, or captures.
- Concurrent review cannot overwrite a newer decision.
- Every public OCR-derived offer traces to a review action.
- Correction never changes the original candidate/capture.
- Private artwork never appears in public APIs or caches.

### V1-11 — Bunnpris, REMA 1000, Extra, and regional applicability

**Depends on:** V1-09, V1-10

**Outcome:** the proven adapter pattern covers the declared v1 market.

Deliver:

- One adapter/configuration per launch chain.
- National, region, postal-set, and store-set scope normalization.
- Deterministic overlap/border resolution.
- Coverage/status page listing healthy chains, regions, source class, and freshness.

Store sets remain a normalized ingestion/evidence scope in v1, but public
eligibility is fail-closed until the user explicitly selects a store context
that is independent of the transient travel origin. The initial regional v1
may launch with national, region, and postal-set offers; it must not infer a
store from an address or widen a store-only offer to a region. Store-context
selection is a post-v1 product extension unless it is designed and accepted
before launch.

Acceptance:

- Each launch chain has a current successful production ingestion run and fixture.
- Each declared launch region receives the correct edition.
- Unknown scope is never eligible.
- Regional offers do not leak across postal/store boundaries.
- Public coverage matches the machine-readable launch manifest.

### V1-12 — Branch directory, geocoding, and route-provider boundary

**Depends on:** V1-04, V1-08

**Outcome:** optional travel can be calculated without contaminating price evidence or privacy.

Deliver:

- Normalized physical Branch from Kassalapp.
- Kartverket geocoder adapter.
- RouteMatrixGateway and a selected routing provider behind fixed server-only base URLs.
- Deterministic fakes and strict coordinate, radius, matrix-size, response-size, timeout, and cancellation bounds.
- /api/locations/search and TravelService.

Algorithm:

1. geocode an explicitly selected address;
2. load a bounded nearby branch set per chain;
3. request a bounded route matrix;
4. enumerate at most six stop orders for up to three stores;
5. choose the shortest round trip per chain set;
6. return aggregate route evidence and public branch stops.

Acceptance:

- Success, no nearby branch, malformed matrix, partial rows, timeout, cancellation, and outage are covered.
- Provider credentials remain server-only.
- No user-controlled upstream URL exists.
- Address/coordinates are redacted from logs and never persisted or cached.

### V1-13 — Travel-aware Planlegg and real convenience/savings slider

**Depends on:** V1-08, V1-12

**Outcome:** the approved hybrid interaction is complete and honest.

Deliver:

- Ask for origin on the result page only after opt-in.
- Accessible address combobox with confirmation and car/bike mode.
- Route-informed server frontier.
- input type=range synchronized with an always-available radio/list alternative.
- Per-position plan name, total, stores, route estimate, substitutions, and delta explanation.
- Persist normalized preference only; remap it to a new frontier after price changes.

Acceptance:

- One-, two-, and three-stop plans work.
- Pointer, arrows, Home/End, and radio selection stay synchronized.
- aria-valuetext describes the current plan without noisy duplicate announcements.
- Slider positions are real returned plans, never interpolation.
- Provider failure leaves a usable price-only result.
- Origin does not survive reload/navigation and appears in no storage, URL, response, or captured application log.

### V1-14 — Oppdag v1

**Depends on:** V1-07, V1-08, V1-11

**Outcome:** users can browse useful opportunities without knowing what to search for.

Deliver:

- Browse by chain, category, official offer, and historical comparison.
- Show offer price, official before-price where eligible, kroner saved, percent saved, conditions, dates, scope, source, and freshness.
- Neutral historical language and styling.
- “Best verified offer” comparisons scoped to comparable product/package and declared coverage.
- Bounded batch plan-impact endpoint for the visible opportunities.
- Add, replace, and lock actions using one coherent price snapshot.

Impact rules:

- Add compares a different basket and must say “with the item added,” not claim pure savings.
- Replace compares the same need and may show price/store deltas.
- Lock changes a flexible need to exact EAN only after confirmation.
- Travel impact is omitted because origin is intentionally not retained; Planlegg recalculates it.

Acceptance:

- No N+1 planner amplification; batch and visible-card limits are enforced.
- Incomplete variants produce no numeric savings claim.
- Wrong-region/stale evidence cannot affect ranking or impact.
- Add/replace/lock updates the shared basket and invalidates the old plan snapshot.
- Official and historical cards are distinguishable visually and to a screen reader.

### V1-15 — Active-trip snapshot, Handlemodus, and offline PWA

**Depends on:** PlanResult v2 from V1-08; may run parallel to V1-12 through V1-14

**Outcome:** the chosen plan remains usable in the shop without connectivity.

Deliver TripSnapshotV1 with:

- evaluation time and expiry;
- public branch stops and order;
- assignments, quantities, packages, price expectations, conditions, and freshness;
- aggregate route time/distance only;
- caveats and stable checklist item IDs.

Store it in IndexedDB. Starting a trip copies an immutable snapshot; only checklist completion mutates.

Deliver:

- /planlegg/handle route;
- grouped store checklists, progress, check/uncheck, finish/delete, stale warning;
- manifest, maskable icons, service-worker registration, and deterministic cache cleanup.

Caching policy:

- Cache app shell, Handlemodus document, icons, and immutable static assets.
- Never cache /api routes, POST bodies, provider responses, or origin-bearing requests.

Acceptance:

- Offline reload keeps the chosen trip and checklist progress.
- Later prices/basket changes do not silently rewrite an active trip.
- Corrupt/unsupported snapshots fail safely.
- Static tests prove all API traffic bypasses the service worker cache.
- A production-build E2E journey completes entirely offline after the snapshot starts.

### V1-16 — Public-good governance, legal, privacy, and security

**Depends on:** starts at V1-01; completes after feature code

**Outcome:** public operation is sustainable, inspectable, and not retailer-biased.

Deliver:

- Choose and publish the code license.
- Publish the mission, funding/sponsorship disclosure, ranking policy, corrections process, and contributor governance.
- Source/permission registry with renewal owner and review date.
- Norwegian privacy notice and data-flow inventory.
- Terms/attribution/marks/imagery review.
- Threat model for public APIs, review boundary, ingestion inputs, database, capture store, and providers.
- Distributed edge/application rate limits, request coalescing, body/response limits, and abuse monitoring.
- CSP, HSTS, Referrer-Policy, Permissions-Policy, frame protections, dependency/license audit, and secret scan.

Acceptance:

- Public ranking contains no paid bias and is reproducible from documented objectives.
- Location data is absent from durable storage and telemetry.
- Review evidence and copyrighted captures remain private.
- No critical/high dependency or validated application vulnerability remains open.
- Public contact/correction route exists.
- The operator/data controller, code license, excluded third-party data/assets, and security-reporting process are explicit.
- A documented data-flow inventory covers browser, Cloudflare, VPS, Kassalapp, geocoder, router, monitoring, and backups.
- Logger tests prove sentinel basket, query, address, coordinate, IP, and user-agent values do not appear in application telemetry.
- Blocked, revoked, expired-permission, or unknown-scope sources cannot feed public recommendations.

### V1-17 — Production operations and source health

**Depends on:** V1-03, V1-04, V1-09; evolves continuously

**Outcome:** data failure is visible, bounded, and recoverable.

Deliver:

- Worker deployment and singleton/distributed leases.
- Separate liveness, dependency readiness, and public source-status endpoints.
- Liveness reports process/revision only; readiness proves database/config/migrations; source failures produce a degraded state rather than a restart loop.
- Source dashboard: last discovery/capture/extraction/publish success, counts, rejection rate, queue age, active/expiring offers, ordinary-price freshness, and provider errors.
- PostgreSQL integration tests in CI with no silent skips.
- Expand/contract migration checks, destructive-SQL guard, and proof that the previous release can run against the expanded schema.
- Encrypted off-host database and private-capture backups, retention, restore runbook, monthly isolated restore, and one clean-host recovery drill.
- Monitoring for API latency/error rate, database saturation, worker lag, source freshness, silent zero-publication runs, and expiring offers.
- External uptime/alert monitoring that does not share the VPS failure domain.
- Build the container once in CI, scan it, generate an SBOM/provenance, and promote the exact immutable digest through preview and production.
- A release manifest containing commit, image digest, migration checksums, coverage/source manifest version, test/scan evidence, backup identifier, and supported regions.
- Deploy/rollback runbooks covering web, worker, migrations, evidence read flag, capture store, source kill switches, and the emergency Cloudflare Access switch.

Initial service targets to validate before public launch:

- price-only plan p95 below 2.5 seconds for benchmark baskets;
- travel plan p95 below 6 seconds excluding a clearly surfaced provider timeout;
- no eligible ordinary observation older than 72 hours;
- no active offer past validUntil;
- required review queue oldest age below 24 hours;
- no silent zero-publication success;
- initial backup RPO at most 24 hours and recovery target at most 2 hours;
- public web availability target 99.5% monthly after launch.

Source degradation should remove or qualify affected claims, not necessarily take the entire public site offline.

Acceptance:

- Fresh install, repeat migration, checksum corruption, and previous-image compatibility run against real PostgreSQL in CI.
- An encrypted off-host backup restores into an isolated environment and a clean-host recovery reaches a verified public smoke test.
- Database outage fails readiness but not liveness; source outage produces degraded status and removes stale claims.
- App, source, backup, disk, and certificate alert drills reach the maintainer and later close.
- Preview and production report the exact image digest from the signed release manifest; the VPS does not rebuild it.
- Bad-image and post-start failure drills prove the documented rollback path without improvising a down migration.

### V1-18 — Accessibility, cross-browser, and real-basket acceptance

**Depends on:** all user-facing batches; fixtures start at V1-01

**Outcome:** v1 has reproducible public-release evidence, not only green unit tests.

Automated:

- Chromium, Firefox, and WebKit E2E.
- Axe on basket, complete/partial/empty results, travel, each slider endpoint, Oppdag, Handlemodus online/offline, review boundary, and errors.
- 320 px reflow, 200%/400% zoom, forced colors, reduced motion, touch targets, focus restoration, heading hierarchy, and status announcements.
- Unit/property/contract/integration tests, production build, DB migration test, PWA test, and real-basket runner.

Manual:

- VoiceOver/Safari complete journey.
- Keyboard-only complete journey.
- iOS Safari and Android Chrome install/offline flow.
- Norwegian currency/date/unit/pluralization review.
- One-, two-, and three-stop route plausibility.

Real-basket corpus per launch region:

- at least 20 baskets;
- exact and flexible needs;
- g/ml/piece/package;
- multibuy and membership on/off;
- national/local offer;
- one-, two-, and three-store frontier;
- deliberately incomplete coverage;
- stale, expired, wrong-region, and ambiguous negatives.

At least five baskets per region are manually cross-checked against source price, conditions, validity, and geography. Use fixed public origins, never household addresses.

Acceptance:

- Every case returns a deterministic valid result or expected fail-closed result.
- Every recommendation fulfils quantities and uses at most three stores.
- Arithmetic matches to the øre.
- Unknown coverage removes unqualified “best” copy.
- No unresolved high-severity accessibility, data, privacy, security, or operations discrepancy remains.
- Evidence is stored under docs/evidence/v1 without overwriting older runs.

## 9. Release gates

| Gate | Required proof | Blocks public launch |
|---|---|---|
| G1 Source rights | Signed/recorded permission and attribution status for every active source | yes |
| G2 Declared coverage | Machine-readable chain/region/source manifest equals public status page | yes |
| G3 Data truth | Append-only evidence, explicit unknowns, official/history separation, expiry and scope tests | yes |
| G4 Planner correctness | Complete quantities, max three stores, deterministic non-dominated frontier, independent property oracle | yes |
| G5 Three-chain evidence | Current successful Bunnpris, REMA 1000, and Extra runs in each launch region | yes |
| G6 Travel privacy | Opt-in route works; origin absent from persistent storage/logs/caches/evidence | yes |
| G7 Offline shopping | Production PWA trip completes on two physical mobile devices | yes |
| G8 Accessibility | Automated suite plus manual VoiceOver/keyboard/mobile report | yes |
| G9 Security/privacy/legal | Threat model, headers, scans, notices, license, marks/imagery review | yes |
| G10 Operations | Live DB CI, alerts, backup and restore drill, outage and rollback drill | yes |
| G11 Real baskets | Corpus passes; manual source checks accepted in every launch region | yes |
| G12 Public-good governance | License, ranking/funding disclosure, corrections path, contributor rules | yes |

Cloudflare Access remains on the entire site until all twelve gates pass. At public launch it is removed from public routes but retained as a separate enforced boundary around /review and internal operations.

## 10. Rollout stages

### Stage 0 — Protected alpha

Current state. Owner-only, claims narrowed, fake/live differences visible.

### Stage 1 — Evidence alpha

Offline/CI comparison runs the new evidence model against the retained legacy
cache, while the protected current image uses evidence only. Scheduled
collection builds history. No public official-offer claim appears until one
complete vertical and review trail work.

### Stage 2 — Closed regional beta

Invite a small tester group in the declared regions. All three chains must be visible; gaps remain explicit. Collect correction reports and acceptance evidence without adding personal analytics.

### Stage 3 — Public regional v1

Remove public Cloudflare Access only after G1–G12 pass. Publish coverage/status, privacy, source, ranking, license, and corrections pages with the release.

### Stage 4 — Geographic expansion

Add a region only through the same source-rights, coverage-manifest, real-basket, and source-health gates. National marketing language is not used until national evidence exists.

## 11. Rollback and failure policy

- Applied migrations are never edited; rollback is a forward repair or read-model flag.
- Keep legacy price_cache until one evidence-model release and restore cycle is proven.
- A broken source adapter is disabled independently.
- Approved offers retain only their original expiry; source outage cannot extend them.
- Failed routing falls back to a coherent price-only plan.
- Failed historical computation hides historical comparison, not ordinary prices.
- Failed offer ingestion removes/qualifies official offers, not the whole planner.
- Unknown coverage stays visible and may narrow claims.
- Public status reports degradation without exposing provider secrets or private captures.

## 12. Required decisions

These are owner decisions, but source-independent implementation need not wait for all of them:

| Decision | Needed by | Recommended default |
|---|---|---|
| Offer-source commercial/licensing path | Gate A / V1-09 | Licensed structured feed first; authorized direct adapters second |
| Launch regions | end of V1-01 | Smallest set with proven three-chain coverage; evaluate Oslo, Bergen, Trondheim |
| Routing provider | decided 2026-07-16; activation remains in V1-12 | Self-hosted Valhalla over OpenStreetMap data; see ADR 0003. Pinning, Norway tiles, capacity, freshness, attribution, recovery, and privacy proof remain required before runtime enablement. |
| Code license | V1-16 | AGPL-3.0-or-later as the public-good default, subject to dependency and contributor compatibility review |
| Funding/governance model | public beta | Transparent sponsorship/donation policy with no ranking influence |
| Analytics | separate ADR | None in v1 unless privacy-preserving metrics are demonstrably necessary |

## 13. PR completion standard

Every PR must include:

1. a stated invariant or user outcome;
2. failing test first where technically possible;
3. implementation and migration/rollback notes;
4. unit/property/contract coverage proportional to risk;
5. accessible loading, empty, degraded, and error states;
6. no new secret or personal-data path;
7. updated API/schema/runbook documentation;
8. focused verification plus the full relevant workspace suite;
9. deploy/evidence notes when behavior reaches the protected environment; and
10. a clear statement of what the PR does not prove.

Baseline verification commands:

~~~text
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm build
corepack pnpm e2e
~~~

Relevant batches also run live PostgreSQL migrations, worker/source contract suites, cross-browser/PWA tests, security checks, and the real-basket acceptance runner.

## 14. v1 definition of done

Handleplan v1 is done only when:

- Bunnpris, REMA 1000, and Extra have sustainable data paths in every declared launch region.
- Exact and reviewed flexible baskets support real package quantities.
- Every plan is complete, deterministic, at most three stores, and fully traceable to eligible evidence.
- Unknown market coverage is visible and cannot produce an unqualified “best” claim.
- Official offers and historical comparisons are technically, visually, and semantically distinct.
- The convenience/savings selector maps to real non-dominated plans.
- Optional route calculation works without persistent origin data and degrades safely.
- Oppdag supports useful browse, verified savings context, and truthful plan impact.
- Handlemodus works offline from an immutable local trip snapshot.
- Ingestion, review, expiry, health, backup, restore, rollback, and outage drills have recorded proof.
- Accessibility, privacy, security, legal, governance, and real-basket release gates pass.
- Public documentation states scope, sources, limitations, ranking method, funding, corrections, and status.

Passing fake mode or a protected preview is necessary evidence, but it is not v1 completion.
