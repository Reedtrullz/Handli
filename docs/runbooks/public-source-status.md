# Public source status

`GET /api/source-status` is the public, source-neutral operational-health
endpoint. It is separate from process liveness (`/api/health`) and database
readiness (`/api/ready`). A degraded source does not make either process
liveness or dependency readiness fail.

The endpoint evaluates one database clock and returns at most 50 latest
source/scope rows. It reads the most recent `source_health_snapshots` row for
each registered source and geographic scope, plus the source's most recent
terminal `ingestion_runs` row. Geographic scope identifiers are hashed before
publication from the database ID; the web database role cannot select the raw
internal `scope_key`. Sources without a health snapshot remain explicitly unknown; an
approved source cannot become `operational` from a nominal `healthy` value
unless at least one allowlisted success clock falls inside the same 26-hour
operational window.
Healthy snapshots older than the source-neutral 26-hour operational window are
published as stale evidence and keep the overall state `unknown`.

The public allowlist is limited to:

- source identifier, display name, data class, and registered runtime state;
- combined current-governance state without permission documents or notes;
- public scope label, country, kind, and active/retired state;
- health state and recorded clock;
- discovery, capture, publish, and newest-eligible-evidence success clocks;
- latest terminal ingestion state, start clock, and completion clock.

The endpoint never reads or returns source-health `details`, review queue
counts/age, ingestion counters, error classes, job IDs, source payloads,
provider responses, credentials, or request metadata. The response schema and
route tests reject extra fields and use fixed error codes. Responses are
bounded to 32 KiB, time-bounded, cancellable, and `no-store`.

Migration 016 lets the fenced worker append one source-wide snapshot for each
non-cancelled terminal result. Those rows may advance catalog-discovery and
capture clocks only when persisted processing made progress. Raw worker counts
cannot advance `last_publish_success_at` or
`newest_eligible_evidence_at`; those clocks remain unchanged until a separate
publisher binds current source runtime, permission, geographic scope, and
claim eligibility. A zero-accepted-record nominal success is recorded as
degraded ingestion health. This makes the processing condition visible without
turning it into a public evidence, coverage, or ranking claim.

`overall` has deliberately narrow meaning:

- `no-approved-sources`: no returned source/scope row has current combined
  source and permission approval;
- `unknown`: an approved row has no health snapshot, lacks a success clock, or
  the bounded directory has more rows;
- `degraded`: an approved row is degraded/failed/disabled, or a failed or
  degraded terminal ingestion is newer than its health snapshot;
- `operational`: every approved row in the complete bounded directory has a
  healthy snapshot with at least one recent recorded success and no newer
  failed or degraded ingestion.

A cancelled terminal ingestion remains visible but is not a degradation
signal. A cancellation newer than its health snapshot keeps the result
`unknown` until a newer health snapshot is recorded, so cancellation cannot
mask an earlier failure.

Even `operational` proves only the recorded pipeline-health boundary. It does
not prove that a source switch or upstream connection is currently active,
price coverage, rights for public ranking, offer validity, regional
applicability, branch inventory, or stock status. `/status` keeps the separate
launch-coverage manifest and blockers visible alongside this recorded read
model.

## Still required before public v1

This endpoint is not monitoring or recovery infrastructure. Production still
needs external uptime/alert monitoring outside the VPS failure domain,
source-freshness and silent-zero-publication alerts, retained immutable
telemetry, encrypted off-host database/private-capture backups, an isolated
restore drill, and a clean-host recovery drill. Those controls are not claimed
until deployment and drill evidence exists.
