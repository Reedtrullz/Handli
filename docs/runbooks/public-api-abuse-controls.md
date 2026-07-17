# Public API abuse controls

**Operational state:** source-neutral application foundation; edge activation
and live capacity proof are still blocked.

Handleplan admits expensive public API work through two independent controls:

1. PostgreSQL applies one application-global rolling-window budget per allowlisted
   route class. The table stores only `route_key` and a server timestamp.
2. Each web process collapses identical work already in flight. Its map key is
   only a SHA-256 digest and disappears when the operation settles.

Neither control accepts or stores IP address, Access identity, user-agent,
query, basket, address, coordinate, location token, request body, or a durable
request hash. Per-IP and bot policy belongs at the edge and remains an external
activation/evidence gate; the application must not recreate it with persistent
identity data.

## Fixed database policies

Migration `019_public_api_request_budget.sql` owns the policy. Callers can
select only one of these route classes; they cannot supply a limit or window.

| Route class | Claims per rolling minute |
|---|---:|
| `discovery-impact` | 120 |
| `discovery-search` | 300 |
| `locations-current` | 120 |
| `locations-search` | 60 |
| `plan-candidates` | 180 |
| `plans` | 120 |
| `plans-travel` | 60 |
| `products-search` | 300 |
| `source-status` | 120 |

`claim_public_api_request_budget(text)` tries a transaction-scoped advisory
lock for the fixed route key. Lock contention fails closed immediately with a
one-second retry rather than waiting. After acquiring the lock it prunes
expired rows for that key and either appends one event or returns a retry delay
from 1 through 60 seconds. PostgreSQL errors fail closed. A denied HTTP request
returns `429 RATE_LIMITED` with that bounded `Retry-After`; an unavailable
coordinator returns a sanitized 503.

The function is `SECURITY DEFINER`, pins `search_path` to `pg_catalog, pg_temp`,
and schema-qualifies its table. `handleplan_web` has `EXECUTE` on that one
function and no direct table privilege. Worker and reviewer roles have neither.
Migration 019 precedes the current required migration, so the web readiness
gate prevents a deployment from silently running without admission control.

These rows are ephemeral runtime coordination, not business/evidence state.
The encrypted backup retains the table and function schema but excludes this
table's data. A restore therefore begins with an empty application budget. An
ordinary app or database restart preserves at most the already bounded
route/timestamp rows until a later claim for that route prunes them. Admission
does not use expired rows as historical volume evidence, and off-host backups
exclude all rows from this table.

## Process-local coalescing

The shared coalescer admits at most 128 distinct active digests and 64
subscribers to one digest. Canonical key material is bounded before hashing;
the map exposes only its count, never its digests. Every shared entry has a
non-renewable server deadline of at most ten seconds; the Kartverket geocoder
uses its route's five-second bound. One subscriber's abort rejects only that
subscriber. Shared work is aborted at that deadline or after the final subscriber
leaves; an aborted operation remains counted until it actually settles, so
ignored cancellation cannot create untracked duplicate work.

Planning, discovery, plan-candidate, product-search, and travel operations use
the control after strict request validation without weakening their existing
body, response, or wall-time bounds. Location search coalesces only the
Kartverket gateway lookup. Each caller still receives a separately random
short-lived location-choice token; current-coordinate token issuance is not
shared. Both location endpoints still claim their global database budget.

No coalescing input, digest, response, cancellation reason, or backend error is
logged or persisted. Capacity errors return a sanitized `503 SERVER_BUSY`.

## Operations and activation

This foundation deliberately emits no per-request abuse event: such an event
would add durable request correlation without an accepted alert consumer.
Future monitoring may export only allowlisted aggregate route-class counters
and bounded outcome buckets, never request or identity metadata.

Before public launch, retain evidence for all of the following:

- migration 019 and exact-role proofs on the production PostgreSQL major;
- concurrency/load results that justify the fixed policies and process bounds;
- Cloudflare per-IP/bot rules, cache bypass, retention, deletion, and direct
  origin enforcement, without copying identity into Handleplan storage;
- alert rules and delivery/dead-man proof for sustained 429, coordinator
  outage, saturation, and latency; and
- sentinel review across edge, Caddy, app, database, monitoring, and backups.

The committed source does **not** prove active edge rules, production policy
tuning, live multi-instance admission, alert delivery, bot mitigation,
production database ACLs, or an executed restore. Keep public release blocked
until those separate evidence gates pass.
