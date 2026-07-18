# Operations telemetry threat model

Scope: the V1-17 private aggregate dashboard and disabled alert-evaluator foundation.
This supplements the broader data-flow threat model; it is not a penetration
test, privacy approval, monitoring-vendor selection, or activation record.

## Assets and trust boundaries

The protected assets are private review evidence, copyrighted captures,
request/basket/search/location data, credentials, provider responses, and the
integrity of operational/release claims. The implementation crosses PostgreSQL
evidence into a bounded aggregate snapshot and a distinct Cloudflare Access
assertion into the private operations process. Fixed alert transitions and a
bounded pull exporter are implemented. Trusted external collectors, recipient
integration, and off-host delivery remain future work.

Allowed durable alert data is limited to a fixed alert key, fixed source ID or
global scope, fixed severity/status/outcome, and incident clocks. Source IDs are
operator-defined registry identifiers, not request identifiers.

The following are forbidden from metrics, events, logs, URLs, caches, traces,
delivery payload extensions, and test evidence:

- IP address, user agent, cookies, session/access tokens, or authentication
  claims;
- basket contents, GTINs from requests, search text, address, coordinates,
  origin, route geometry, or hashes/fingerprints of any of them;
- request/response bodies, URLs with query strings, provider payloads, exception
  messages, stack traces, or arbitrary error text;
- review reasons/corrections, normalized candidate fields, capture/blob keys,
  capture bytes, source permission notes, or private reference keys; and
- generic labels, tags, metadata, messages, or free-form dimensions.

Hashing forbidden request data does not make it an allowed metric.

## Threats and controls

| Threat | Foundation control | Remaining gate |
| --- | --- | --- |
| Request or review data leaks through a generic telemetry field | Strict schemas expose no metadata/message/error/tag map; repository query selects only allowlisted aggregate columns; sentinel tests reject extra fields | Inspect proxy/collector/delivery configuration and real emitted bytes |
| User-controlled cardinality causes memory, query, or alert explosion | 100-source directory, 10,001 matching-row/result limits, 10,000 visible caps, fixed keys and source registry IDs; migration 024 adds targeted source/time indexes and the operations role enforces statement/lock timeouts | Candidate-current query-plan proof and load tests are still required because row limits and timeouts do not establish an efficient physical scan |
| Missing collector, matrix cell, or source row is interpreted as healthy | Every unknown bucket opens a warning; the strict canonical roster rejects missing/extra IDs, the evaluator requires exactly eight global plus six per roster source, and incomplete pagination refuses all writes | Bind the real roster entries/version/SHA-256 to the release manifest, plus an off-VPS dead-man monitor and delivery drill |
| A newer unrelated evidence stream hides a stale required stream | Each roster entry allowlists required `ordinary-price`/`official-offer` signals and worker job kinds; freshness/lag use the worst required individual result, never a maximum across unrelated streams | Candidate roster review and per-source live freshness drills |
| A non-zero extraction candidate count falsely proves publication | A current completed confirmed-empty envelope is explicitly healthy; unexpected-empty is warning; failed/non-empty-without-output is unknown; clear publication requires eligible output tied to that extraction | Live extraction-to-publication drill and delivery-independent source alert |
| A historical/future edition or stale offer closes current freshness | Silent-zero selects only currently valid publication editions; official freshness requires current public-display rights and either active eligible output or completed confirmed-empty evidence; expiry hygiene omits the 14-day age cutoff | Live overlapping-edition, backfill, stale-capture, and expired-status drills |
| Concurrent or out-of-order evaluators append duplicates, invert event clocks, lose transitions, or let stale work overwrite current state | A strict SECURITY DEFINER function acquires a global advisory lock before capturing the DB event clock or checking a distinct evaluation checkpoint; older and same-clock contradictory evaluations fail; canonical per-identity locks follow; newer unchanged runs advance only the checkpoint | Checkpoint retention and concurrent live PostgreSQL proof |
| Attacker rewrites or deletes alert history | Repository issues inserts only; migration 024 adds a database append-only trigger and database persistence clock | Candidate-current privilege-denial, trigger, retention, backup, and restore proof |
| Arbitrary SQL client writes a convincing fixed-looking alert | The operations role has no alert-table privilege and can invoke only a fixed least-privilege function that owns clocks, keys, scope, details and idempotency; production evaluation remains disabled | Candidate-current role denial and corrupt-row proof before activation |
| Backdated/current mutable rows create false historical claims | The enabled dashboard reads only post-024 DB-stamped worker/health rows; ordinary ingestion uses DB-owned `terminalized_at`; official freshness uses capture retrieval time and current-validity gates; selected clocks are bounded by observation time; docs prohibit historical interpretation | Version all mutable source/offer states before supporting historical snapshots and explicitly adapt the disabled richer evaluator to the post-024 health boundary |
| Private dashboard becomes publicly reachable | Exact operations page/API matchers route to a distinct loopback service; Caddy forwards only the signed assertion; the app verifies exact origin/path, issuer, audience, time, signature and key strength; missing/invalid credentials return the same no-store 404 before service resolution | Candidate-current Cloudflare policy and VPS denial proof |
| Operations role reads private row data | Dedicated role receives no table/sequence privilege and invokes one fixed aggregate `SECURITY DEFINER` function with bounded roster, counts, and timeouts | Live PostgreSQL privilege-denial and returned-column proof |
| Monitoring shares the application failure domain | No delivery claim is made | Independent destination, dead-man check, and VPS outage drill |
| Alert fatigue hides real failures | Fixed keys, deterministic severity, state-change-only append | Validate thresholds with measured baselines, owners, escalation and suppression policy |
| A capped count is mistaken for an exact count | Counts carry an explicit `capped` bit; queue saturation remains alerting; the private UI renders “at least 10,000” | Candidate-current browser/readback proof of the deployed UI |
| Governance metadata points at a different permission | Latest permission is selected by DB creation clock and ID; source review/expiry pointers must exactly match; contradiction, revoke, and expiry are critical | Migration/role proof and live revocation drill |
| Malformed, future, or roster-digest-mismatched rows close an incident | Parsers and repository SHA-256 recomputation fail closed before append | Live corrupt-row and privilege tests |

## Logging and failure behavior

The service has no logging interface. Callers must convert failures only to a
fixed internal result code; they must not serialize caught exceptions, inputs,
SQL parameters, or status-producer payloads. Cancellation is rechecked after
every query and immediately before the transaction callback returns; a
final-insert race is tested as failure. After PostgreSQL commits, the committed
result is returned rather than misreporting a rollback. A pre-commit repository
failure must leave the transaction uncommitted and must not be reclassified as
a healthy/closed alert.

Operational evidence is not public product evidence. It may explain a release
blocker, but a unit-test fixture, local event row, or same-host check cannot prove
production availability, external delivery, backup recovery, or source rights.

## Security review required before activation

- inspect the later database migration and role grants independently;
- prove internal auth denies missing, forged, expired, wrong-issuer, and
  wrong-audience credentials without resource enumeration;
- prove responses use private/no-store caching and never include private table
  fields;
- inspect collector configs for forbidden labels and high-cardinality fields;
- exercise abort, timeout, saturation, concurrent evaluation, stale/unknown,
  escalation, recovery, exporter outage, and full VPS outage paths; and
- capture sanitized raw delivery evidence from the independent destination.

No production deployment, Cloudflare configuration, live PostgreSQL privilege,
scheduler activation, recipient exporter, or delivery evidence exists as of
2026-07-17.
