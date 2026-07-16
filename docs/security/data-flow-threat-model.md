# Data-flow inventory and threat model

**Status:** source-neutral architecture record for the protected alpha
**Assessment:** not an accepted security, privacy, legal, processor, logging,
backup, or penetration-test report

## Safety properties

1. Every recommendation is derived from eligible evidence and a complete
   basket, across at most three stores.
2. Browser-provided labels, prices, product families, source states, and review
   claims are untrusted and rehydrated by the server.
3. Kassalapp and future geocoding/routing providers never receive a basket,
   Access identity, IP address forwarded by the app, or unrelated shopper data.
4. A future route origin is transient: no origin, address, coordinate, origin
   label, or origin-adjacent geometry may enter persistent browser storage,
   URLs, cookies, application/proxy logs, telemetry, caches, database rows,
   evidence, monitoring, or backups.
5. Public web access is read-only at the database. Ingestion/review evidence and
   copyrighted captures do not cross into public API responses.
6. Unknown, stale, conditional, blocked, revoked, expired-permission, or
   out-of-scope source evidence fails closed.

## Components and data inventory

| Component | Receives or stores | Must not receive/store | Current boundary and open proof |
|---|---|---|---|
| Browser | Local basket/preferences in local storage; immutable active-trip/checklist snapshot in IndexedDB; app shell/static assets in service-worker cache; transient API responses | Secrets, source permissions, reviewer identity, private captures; route origin in persistence/URL/cookie/cache | Anonymous app use exists, but the protected Cloudflare layer is not anonymous. Cross-browser/device deletion and privacy evidence remains open. |
| Cloudflare edge and Access | During alpha: Access identity/cookie and network/request metadata such as IP, time, URL, user-agent; proxied request/response | Request bodies in logs; route origin in URL/header/log/cache/analytics; provider credentials | Access guards the preview. Actual Cloudflare products, log fields, retention, processor terms, cache bypass, rate limiting, and deletion procedure are not yet accepted. |
| VPS/Caddy | TLS-origin proxy traffic and technical connection metadata; app/worker processes | Durable baskets, queries, addresses, coordinates, Access identity, request/response bodies, secrets in logs | Origin rejects non-Cloudflare ranges and missing Access assertion; Caddy sets HSTS. No accepted log/retention/abuse-monitoring audit or direct-origin penetration proof exists. |
| Next.js web app | Transient search/plan request; eligible public evidence read from DB; health/readiness state | Kassalapp key; writes to production DB; persistent shopper profile; route origin in logs/cache/response | Container has only read-only `handleplan_web` credentials and no Kassalapp key. Body/response limits, distributed rate limits, coalescing, and telemetry sentinel tests remain open. |
| Worker and review boundary | Scheduled source jobs, provider credentials, raw normalized source records, append-only outcomes; future private review decisions/captures | Shopper requests, IP/user-agent, route origin; private reviewer/capture fields in public views | Worker owns Kassalapp access and a separate DB role. Review queue/capture store and full private/public projection evidence are incomplete. |
| PostgreSQL | Public/source/catalog/price/offer/coverage and operational evidence, leases/budgets, immutable review metadata | Basket, search history, address, coordinates, origin geometry, Access identity; secret values | Roles are separated and public reads are constrained. Candidate migration/restore, row-level projection, retention, and clean-host recovery must be re-proved for release. |
| Kassalapp | Worker-originated source requests needed for allowed catalogue/price ingestion | Any shopper basket, search, IP forwarded by Handleplan, address, coordinate, trip, Access identity | Credential is worker-only and source access defaults conditional. Permission, retention, derived-display, attribution, quota, and public-ranking rights remain unresolved, so public use is blocked. |
| Future geocoder | Minimum address fragment or coordinate needed after explicit route opt-in | Basket, products, price plan, identity, cookies, unneeded precision | No production provider/processor has been selected or approved. Candidate documentation in the source registry is not activation evidence. |
| Future router | Ephemeral origin and selected public branch stops needed for a route estimate | Basket contents, prices, identity/cookies, retained origin, user-visible route geometry that reveals origin | No production provider/processor has been selected or approved. Only aggregate duration/distance may return; provider failure must fall back to price-only planning. |
| Monitoring/alerts | Aggregated availability, latency, error class, worker lag, source freshness and bounded counts | Request/response bodies, basket/query/address/coordinate sentinels, IP/user-agent, credentials, private captures | Production monitoring and an external failure-domain alert path are not implemented/accepted. Schema allowlists and sentinel tests are release requirements. |
| Backups | Encrypted DB and future private capture data strictly within documented retention | Browser-only data, origin, logs containing personal/request data, credentials | Tested encrypted off-host backup, retention/deletion, monthly restore, and clean-host recovery are not complete. Backup scope must prove forbidden data never entered upstream stores. |

## Data flows and trust boundaries

1. **Browser → Cloudflare → Caddy → web:** TLS request for page, search, or
   plan. Cloudflare authenticates the protected preview. The app processes a
   bounded request and returns public/redacted evidence. Browser input is
   hostile. Request bodies and sensitive query values must not be logged.
2. **Web → PostgreSQL:** read-only parameterized access using the dedicated web
   role. The DB returns only public projections and eligible evidence. A web
   compromise must not allow ingestion, reviewer-history, or capture writes.
3. **Worker → Kassalapp → worker → PostgreSQL:** scheduled, budgeted server-side
   ingestion. Authorization is checked at each external attempt and again at
   publication. Provider payloads are untrusted, bounded, validated, and tied
   to provenance. No live shopper request triggers this flow.
4. **Reviewer → private review service/store → public projection (future):**
   captures and reviewer identity stay private; only approved structured facts
   and redacted provenance may publish. Append-only history supports correction
   without rewriting evidence.
5. **Browser → web → geocoder/router → web → browser (future, opt-in):** exact
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
| Source payload injection, decompression/size abuse, or malformed offer | Bounded typed adapters and fail-closed normalization | Explicit HTTP/body/decompression limits and adversarial fixtures for every adapter |
| Direct-origin/Access bypass or forged forwarding headers | Pinned Cloudflare proxy ranges, Access assertion requirement, loopback app port | Automated origin-bypass test, proxy-range renewal, cryptographic/header review, distributed edge/app rate limits |
| API cost/CPU/database exhaustion | Bounded schemas, worker request budgets and leases | Distributed per-route limits, request coalescing, timeouts, body/response caps, abuse alerts |
| Basket/query/location leaks through logs, traces, errors, caches, URLs, or analytics | No behavioural analytics; service worker excludes APIs; origin persistence forbidden by contract | Structured allowlist logger and sentinel tests covering basket, query, address, coordinate, IP and user-agent at Cloudflare, Caddy, app, worker, provider, monitoring, and backup boundaries |
| Public read exposes reviewer identity or copyrighted captures | Dedicated web role and public projections; base evidence intended private | Review/capture-store implementation, projection tests, object-store policy, retention and incident drill |
| Credential or DB-role compromise | Server-only secrets, separate least-privilege roles, non-root/read-only containers | Secret scan, rotation drill, host hardening, network/DB audit, dependency/container scan and SBOM |
| Database loss, tampering, or destructive migration | Append-only guards, migration checksums, upgrade/rollback tests | Encrypted off-host backup, immutable audit export, isolated restore and clean-host recovery |
| Supply-chain or dependency compromise | Lockfile and pinned runtime/container inputs | Automated dependency/licence/secret scans, provenance/SBOM, immutable image promotion; no critical/high accepted vulnerability |
| Biased ranking or sponsor influence | Published no-paid-ranking objectives and deterministic frontier rules | Funding/conflict ledger, replay artifact, governance owner and independent release review |
| Privacy/security report is lost or exposed | Public issues explicitly reject sensitive reports | Tested confidential channels, named owners, response/disclosure targets and backup contact |

## Origin non-retention design

The future route endpoint must accept origin only in a bounded POST body after
explicit opt-in. It must use request-scoped memory, avoid request-object dumps,
disable response/CDN/service-worker caching, call providers without shopper
identity or forwarding headers, discard provider geometry, and return only
aggregate route facts. Logs and metrics use enumerated event names, status,
duration buckets, and provider error classes—not free text or request values.
Any location-choice token must be generated by Handleplan from cryptographic
randomness, map to provider output only in request-scoped expiring memory, and
be single-purpose; deterministic coordinate/provider identifiers are forbidden.

Tests must inject unique sentinels for basket, query, address, latitude,
longitude, IP, user-agent, and origin label, then search application logs,
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

This document does not select Kassalapp, a geocoder, a router, a monitoring
vendor, a backup vendor, or a legal basis. It does not establish source rights,
operator/data-controller identity, GDPR compliance, processor agreements,
marks/imagery permission, launch readiness, or a passed security review. Those
facts require named owners and external/current evidence in the release gates.
