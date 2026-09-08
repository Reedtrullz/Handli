# Legacy edition recovery inventory

**Captured:** 2026-09-09 (Europe/Oslo)
**Scope:** nine non-private Tjek edition identifiers from the read-only legacy
readback on 2026-09-08.
**Status:** conservative recovery dispositions; no production mutation.

The stored identity hash matches the current canonical edition identity for all
nine rows. That proves only that the stored row is self-consistent. It does not
prove provider payload compatibility, geographic authority, current permission,
or that a capture contains extractable offers.

| External edition ID | Chain | Valid until | Capture | Extractor / extraction | Disposition |
| --- | --- | --- | ---: | --- | --- |
| `HEAqFAxC` | Bunnpris | 2026-08-24T22:00:00Z | 3029 bytes | `tjek-v1`, completed, non-empty | `EXPIRED_LEGACY_EXTRACTOR_OBSOLETE`; quarantine. No current `tjek-review-v2` replay claim. |
| `aWlc6wCT` | Bunnpris | 2026-09-07T21:59:59Z | 3017 bytes | `tjek-v1`, completed, non-empty | `EXPIRED_LEGACY_EXTRACTOR_OBSOLETE`; quarantine. No current `tjek-review-v2` replay claim. |
| `jpm3leSX` | Bunnpris | 2026-08-31T21:59:59Z | 3030 bytes | `tjek-v1`, completed, non-empty | `EXPIRED_LEGACY_EXTRACTOR_OBSOLETE`; quarantine. No current `tjek-review-v2` replay claim. |
| `C1lU4Cvr` | Extra | 2026-08-23T21:59:59Z | 2423 bytes | no extraction | `EXPIRED_UNQUALIFIED_CAPTURE`; retain evidence, do not infer offers from the small JSON capture. |
| `EqHaIDBm` | Extra | 2026-09-20T21:59:59Z | 2420 bytes | no extraction | `BLOCKED_PAYLOAD_SCOPE_QUALIFICATION`; a prior provider observation had `all_stores=false`, so this is not automatically resumable. Qualify the exact payload and reviewed scope first. |
| `IXS_5QC8` | Extra | 2026-08-30T21:59:59Z | 2424 bytes | no extraction | `EXPIRED_UNQUALIFIED_CAPTURE`; retain evidence, do not infer offers from the small JSON capture. |
| `58Llu8F7` | REMA 1000 | 2026-08-22T21:59:59Z | 2556 bytes | no extraction | `EXPIRED_UNQUALIFIED_CAPTURE`; retain evidence, do not infer offers from the small JSON capture. |
| `AK24tvpp` | REMA 1000 | 2026-09-05T21:59:59Z | 2550 bytes | no extraction | `EXPIRED_UNQUALIFIED_CAPTURE`; retain evidence, do not infer offers from the small JSON capture. |
| `C3b24G-i` | REMA 1000 | 2026-08-29T21:59:59Z | 2558 bytes | no extraction | `EXPIRED_UNQUALIFIED_CAPTURE`; retain evidence, do not infer offers from the small JSON capture. |

The inventory contains no exact complete replay under the current
`tjek-review-v2` extractor, no payload-qualified resumable partial capture, no
invalid stored canonical identity, and no separately established newer source
revision. Eight editions are expired. The one current edition is blocked by
payload/scope qualification. The three Bunnpris rows are not treated as
completed current replays solely because their legacy `tjek-v1` extractions
completed.

Supported recovery is deliberately narrow:

- An exact-byte capture can be replayed idempotently only after the current
  edition identity, provider payload, scope, rights, and extraction contract
  qualify.
- A capture with a missing extraction may retry through the existing bound
  repository calls. A failed extraction after capture does not rewrite the
  capture identity; the retry creates at most one extraction for that capture
  and extractor version.
- A stored identity mismatch is an explicit `TJEK_EDITION_CONFLICT`. It is
  quarantined until the source publishes a genuinely distinct reviewed
  revision. No invented external revision ID or evidence rewrite is allowed.

## Verification boundary

The focused unit regression covers the incompatible stored identity and passed
after the resolver began comparing the stored hash with the canonical identity.
The actual worker-role integration ran against PostgreSQL 16.10 in the
disposable `handleplan_task5_legacy_20260909` database on port 55442 after the
reviewed 040 baseline and forward migrations 041/042. It preserved the
complete replay (`persisted=1`, then `persisted=0`) and injected one failure at
`recordExtraction` after capture; the retry persisted one extraction and the
database contained exactly one extraction row for that edition.

No production database, current capture, source permission, provider, or
external service was changed. The captured JSON bytes were not reconstructed or
reinterpreted as offers. A self-consistent stored identity remains distinct
from provider compatibility and current source authority.
