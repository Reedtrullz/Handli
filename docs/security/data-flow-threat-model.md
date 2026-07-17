# Data-flow inventory and threat model

**Status:** source-neutral architecture record for the protected alpha
**Assessment:** not an accepted security, privacy, legal, processor, logging,
backup, or penetration-test report

## Safety properties

1. Every recommendation is derived from eligible evidence and a complete
   basket, across at most three stores.
2. Browser-provided labels, prices, product families, source states, and review
   claims are untrusted and rehydrated by the server.
3. Kassalapp and the selected geocoding/routing boundaries never receive a basket,
   Access identity, IP address forwarded by the app, or unrelated shopper data.
4. An opt-in route origin is transient: a private, no-store lookup may return
   at most five bounded address labels with five-minute opaque tokens, but no
   origin, address, coordinate, origin label, or origin-adjacent geometry may enter persistent browser storage,
   URLs, cookies, application/proxy logs, telemetry, caches, database rows,
   evidence, monitoring, or backups.
5. Public web access is read-only for evidence/business state and its process
   receives no private-review credential or Access configuration. Its sole write
   capability is EXECUTE on a fixed-policy database function that appends an
   ephemeral allowlisted route class and server timestamp; it has no direct
   access to that table. Ingestion/review evidence and copyrighted captures do
   not cross into public API responses.
6. Unknown, stale, conditional, blocked, revoked, expired-permission, or
   out-of-scope source evidence fails closed.

## Components and data inventory

| Component | Receives or stores | Must not receive/store | Current boundary and open proof |
|---|---|---|---|
| Browser | Local basket/preferences in local storage; immutable active-trip/checklist snapshot in IndexedDB; app shell/static assets in service-worker cache; transient API responses | Secrets, source permissions, reviewer identity, private captures; route origin in persistence/URL/cookie/cache | The current VPS remains an owner-only Access-protected preview; private review has a separate application-verification boundary. Anonymous public access requires a later explicit release change. Cross-browser/device deletion evidence remains open. |
| Cloudflare edge and Access | Access identity/cookie and network/request metadata such as IP, time, URL, and user-agent for the protected preview; a separate review assertion/audience on private paths | Request bodies in logs; route origin in URL/header/log/cache/analytics; provider credentials | The hostname-wide preview policy remains in force, with an intended separate review application for the exact review route families. Actual policy configuration, log fields, retention, processor terms, cache bypass, rate limiting, and deletion procedure are not yet accepted. |
| VPS/Caddy | TLS-origin proxy traffic and technical connection metadata; separate public and review loopback upstreams | Durable baskets, queries, addresses, coordinates, Access identity, request/response bodies, secrets in logs | Repository config rejects non-Cloudflare ranges and a missing Access assertion globally, then routes exact review paths to port 3006 and all other paths to port 3004. It strips convenience identity headers before review and all Access/identity headers before the public process. No deployed config readback, accepted log/retention audit, or direct-origin/route-isolation penetration proof exists. |
| Next.js public app process | Transient search/plan request; eligible public evidence read from DB; health/readiness state; ephemeral route-class budget claim | `REVIEW_DATABASE_URL`, `REVIEW_ACCESS_*`, `REVIEW_BASE_URL`, Kassalapp key, evidence/business writes, persistent shopper profile; route origin in logs/cache/response | `handleplan_web` has public reads plus EXECUTE-only access to one fixed-policy budget function. Its Compose environment contains no review configuration. Application-global route budgets and bounded digest-only in-flight coalescing are implemented; deployed environment inspection, production tuning/load proof, edge policy, abuse alerts, and telemetry proof remain open. |
| Private review process | Access-protected private review requests, `handleplan_review` connection, fixed Access verifier configuration, typed candidates and bounded crop references | Public `DATABASE_URL`, worker/provider credentials, shopper requests, reviewer email, capture paths/bytes/checksums | The same immutable image runs as a separate process on loopback port 3006. Exact proxy routing and cryptographic issuer/audience/origin/path checks fail closed before repository access. A deployed Access policy, container-environment readback, production capture renderer/store, live ACL proof, and reviewed real source remain incomplete. |
| Worker | Scheduled Kassalapp jobs; disabled source-neutral official-offer job contracts; provider credentials; trusted normalized source records; append-only outcomes; owner-private immutable capture blobs on a worker-only volume | Shopper requests, IP/user-agent, route origin, reviewer/Access configuration; raw official-source network output at the trusted normalization port | Worker and reviewer use separate DB roles and processes. The worker has no host port. Official production composition returns no handlers/schedules and has no retailer URL/adapter. The local blob store is write-only and the review process has no volume mount. Quota, free-space alerting, retention/deletion, backup/restore, a safe read path, and live process/ACL proof remain incomplete. |
| PostgreSQL | Public/source/catalog/price/offer/coverage and operational evidence, leases/budgets, immutable review metadata; ephemeral fixed route class/timestamp claims | Basket, search history, address, coordinates, origin geometry, Access identity, user-agent, request hash; secret values | Roles are separated, public evidence reads are constrained, and the web budget table is EXECUTE-only through a pinned SECURITY DEFINER function. Live migration/ACL/restore, retention, and clean-host recovery must be re-proved for release. |
| Kassalapp | Worker-originated source requests needed for allowed catalogue/price ingestion | Any shopper basket, search, IP forwarded by Handleplan, address, coordinate, trip, Access identity | Credential is worker-only and source access defaults conditional. Permission, retention, derived-display, attribution, quota, and public-ranking rights remain unresolved, so public use is blocked. |
| Kartverket Address API | Minimum address fragment or coordinate needed after explicit route opt-in | Basket, products, price plan, identity, cookies, unneeded precision | The source boundary is selected and permission-reviewed, but defaults off. Production processor/configuration, quota, retention, attribution readback, and end-to-end non-retention proof still block activation. |
| Self-hosted Valhalla over OpenStreetMap | Ephemeral origin and selected public branch stops needed for a route estimate | Basket contents, prices, identity/cookies, retained origin, user-visible route geometry that reveals origin | The source boundary is selected and defaults off. A pinned image, reproducible Norway graph, capacity/freshness/recovery proof, visible attribution, and end-to-end non-retention proof still block activation. Only aggregate duration/distance may return; failure falls back to price-only planning. |
| Monitoring/alerts | Aggregated availability, latency, error class, worker lag, source freshness and bounded counts | Request/response bodies, basket/query/address/coordinate sentinels, IP/user-agent, credentials, private captures | The application readiness event is schema-allowlisted and sentinel-tested. No production exporter or external failure-domain alert path is implemented/accepted, and edge, proxy, worker, provider, monitoring, and backup boundaries remain unproved. |
| Backups | Encrypted DB and future private capture data strictly within documented retention | Browser-only data, origin, logs containing personal/request data, credentials | Tested encrypted off-host backup, retention/deletion, monthly restore, and clean-host recovery are not complete. Backup scope must prove forbidden data never entered upstream stores. |

## Data flows and trust boundaries

1. **Browser → Cloudflare → Caddy → public web:** TLS request for page, search,
   or plan in the owner-only preview. Cloudflare Access authenticates the
   preview, and Caddy rejects direct-origin traffic or a missing assertion before
   sending non-review paths to the credential-separated public process. The app
   processes a bounded request and returns public/redacted evidence. Browser
   input is hostile. Request bodies and sensitive query values must not be logged.
2. **Web → PostgreSQL:** parameterized public evidence reads plus one
   fixed-policy route-budget claim using the dedicated web role. The DB returns
   only public projections and eligible evidence; the budget function stores
   only route class/time. A web compromise must not allow ingestion,
   reviewer-history, capture writes, or direct budget-table access.
3. **Worker → Kassalapp → worker → PostgreSQL:** scheduled, budgeted server-side
   catalogue/ordinary-price ingestion. Provider payloads are untrusted, bounded,
   validated, and tied to provenance. No live shopper request triggers this flow.
   Separately, the disabled official-offer foundation defines
   **authorizer → trusted normalizer → discovery/fetch → private filesystem blob →
   extraction/candidate evidence**. It authorizes immediately before every port
   invocation, forbids hidden retries/redirects by contract, and rechecks dynamic
   policy in the pipeline. There is no physical adapter, URL, live schedule, or
   public publication. Future official work requires a separate source-bound lease.
4. **Reviewer → Cloudflare → Caddy → private review process/store → rejection
   audit (future public projection):** Cloudflare Access authenticates the dedicated review
   application. Caddy accepts only the exact review paths, rejects a missing
   assertion, strips untrusted convenience identity headers, and selects the
   loopback review upstream; the review app verifies
   the signed RS256 assertion against a fixed issuer, audience, origin, and
   bounded JWKS response before resolving the review service. The database
   grants the runtime only two exact `SECURITY DEFINER` functions: one bounded
   rights-current candidate reader and one typed decision transaction. The
   database derives source, chain, and scope from immutable candidate/capture
   rows and rechecks current `officialOffers`/`privateReview` permission flags,
   canonical capture/extraction capabilities, and capture rights under an
   optimistic version. Capture paths and bytes remain private; only a bounded
   rights-classified crop reference reaches this UI. That opaque reference is
   not viewable evidence, so the UI disables approval/correction, the service
   returns typed `EVIDENCE_UNAVAILABLE`, and the decision function independently
   rejects direct-SQL approval before any write. Only a reasoned rejection can
   currently append. Public projection/publication remain separate, disabled
   transitions with their own current-review and rights gates.
5. **Browser → web → geocoder/router → web → browser (opt-in, runtime-disabled):** exact
   origin exists only for the request lifetime. Provider credentials stay on
   the server. Cache and telemetry bypass is mandatory. A location-choice
   response may contain only a server-minted random token, exact/approximate
   match quality, and a lifetime of at most five minutes—never a provider ID,
   address label, coordinate, or geometry. A route response has branch stops
   plus aggregate time/distance, never the origin.
6. **Services → monitoring/backups (future):** only explicit allowlisted metrics
   and approved stores. Sanitization happens before export, and backup scope is
   enumerated rather than inferred.

## Threats, controls, and remaining work

| Threat | Present control | Required before public launch |
|---|---|---|
| Forged products/prices/family approval from browser | Strict schemas and server rehydration; invalid/ambiguous input fails closed | Contract fuzzing, candidate-release replay, and independent basket oracle |
| Stale, revoked, unlicensed, or wrong-region evidence influences ranking | Source state, permissions, scope, freshness, immutable runs, coverage vocabulary | Rights evidence for every live source and kill-switch/expiry exercises |
| Source payload injection, decompression/size abuse, malformed offer, or adapter-supplied authority | Bounded strict orchestration; trusted normalized official-offer port is explicit; attempt authorization precedes every call; edition/fetch source IDs are cross-bound | Raw DTO normalization through policy, server clock, geography and rights resolution; explicit HTTP/body/decompression/redirect/retry limits and adversarial fixtures for every real adapter |
| Direct-origin/Access bypass, privileged-route confusion, or forged forwarding headers | Pinned Cloudflare proxy ranges; preview-wide missing-assertion rejection; exact review-path matcher; separate loopback ports/process credentials; cryptographic review-app verification | Deployed origin-bypass and near-prefix route tests, proxy-range renewal, container-environment inspection, cryptographic/header review, and evidenced edge per-IP/bot limits; app-global limits are identity-free and do not replace the edge |
| API cost/CPU/database exhaustion | Bounded schemas/body/response/time, worker budgets/leases, application-global fixed route budgets, bounded digest-only in-flight coalescing | Production load/tuning evidence, Cloudflare per-IP/bot controls, aggregate abuse alerts and delivery proof |
| Basket/query/location leaks through logs, traces, errors, caches, URLs, or analytics | No behavioural analytics; service worker excludes APIs; origin persistence forbidden by contract | Structured allowlist logger and sentinel tests covering basket, query, address, coordinate, IP and user-agent at Cloudflare, Caddy, app, worker, provider, monitoring, and backup boundaries |
| Public read exposes reviewer identity or copyrighted captures | Dedicated web/review roles; cryptographic Access verification; unauthorized requests resolve before service access; queue contracts reject blob paths/checksums/count totals; `private, no-store` responses; candidate/capture evidence append-only; worker-only 0700/0400 immutable filesystem store with no public/review mount | Checksum-verifying rights-current private read path and production crop renderer, live filesystem/container ACL readback, edge cache proof, retention/deletion and incident drill |
| Private capture disk exhaustion or unrecoverable local evidence | Per-capture 50 MiB and per-run 100 MiB bounds; no-overwrite content addressing; worker-only named volume; production official schedule disabled | Dedicated filesystem quota, free-space alarms, retention/deletion policy, encrypted off-host capture backup, checksum restore drill, and cross-host recovery evidence |
| Forged review identity, stale concurrent approval, or rights revocation race | Fixed Cloudflare Access issuer/audience/origin with RS256/JWKS validation; pseudonymous actor hash; candidate row lock, optimistic version, append-only action, per-source governance lock and final current-rights recheck | Deployed Access policy/audience readback, key-rotation exercise, live PostgreSQL concurrency proof and operator offboarding drill |
| Credential or DB-role compromise | Server-only secrets, separate least-privilege roles, non-root/read-only containers, and a high-confidence repository secret scan | Rotation drill, history/container/host secret scans, host hardening, network/DB audit, and credential-boundary readback |
| Database loss, tampering, or destructive migration | Append-only guards, migration checksums, upgrade/rollback tests | Encrypted off-host backup, immutable audit export, isolated restore and clean-host recovery |
| Supply-chain or dependency compromise | Lockfile and pinned runtime/container inputs; fail-closed high/critical advisory gate; reviewed license inventory checked again in the Alpine builder; source SPDX; ephemeral Docker-archive digest plus unsigned build statement | Candidate-current reports, container vulnerability scan, retained/signed provenance and SBOM, immutable image promotion, and independent review; no critical/high accepted vulnerability |
| Biased ranking or sponsor influence | Published no-paid-ranking objectives and deterministic frontier rules | Funding/conflict ledger, replay artifact, governance owner and independent release review |
| Privacy/security report is lost or exposed | Public issues explicitly reject sensitive reports | Tested confidential channels, named owners, response/disclosure targets and backup contact |

## Origin non-retention design

The route endpoint accepts origin only in a bounded POST body after
explicit opt-in. It must use request-scoped memory, avoid request-object dumps,
disable response/CDN/service-worker caching, call providers without shopper
identity or forwarding headers, discard provider geometry, and return only
aggregate route facts. Logs and metrics use enumerated event names, status,
duration buckets, and provider error classes—not free text or request values.
Any location-choice token must be generated by Handleplan from cryptographic
randomness, map to provider output only in request-scoped expiring memory, and
be single-purpose; deterministic coordinate/provider identifiers are forbidden.

The readiness-boundary unit test injects unique basket, query, address,
coordinate, IP, and user-agent sentinels through URL, headers, and an exception,
and proves its emitted event contains only the fixed component, event name, and
outcome. That narrow test is not route-origin or end-to-end proof. Remaining
tests must inject unique sentinels for basket, query, address, latitude,
longitude, IP, user-agent, and origin label, then search all application logs,
traces, caches, database/evidence, monitoring exports, and backup fixtures.
Provider and edge retention require contract/config evidence; an application
unit test cannot prove them. Any failed boundary keeps routing disabled and G6
unpassed.

## Security headers currently configured

The web app declares a restrictive same-origin CSP, denies framing and MIME
sniffing, sends `no-referrer`, limits browser permissions, and declares HSTS.
Caddy also sends HSTS. The CSP currently permits inline scripts/styles for the
Next.js runtime; nonce/hash hardening and a deployed-header readback remain
open. Headers do not replace input validation, rate limits, Access policy, or
provider/rights review.

## Explicit non-claims

This document does not claim the split Compose services or Caddy route policy are
deployed. It does not select Kassalapp, a monitoring vendor, a backup vendor,
or a legal basis. Kartverket and self-hosted Valhalla/OpenStreetMap are selected
as default-off technical boundaries; that selection is not production activation,
processor approval, or end-to-end privacy proof. This document does not establish grocery-source rights,
operator/data-controller identity, GDPR compliance, processor agreements,
marks/imagery permission, launch readiness, or a passed security review. Those
facts require named owners and external/current evidence in the release gates.
