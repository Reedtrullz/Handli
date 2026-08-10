# Source-neutral v1 PostgreSQL remediation verification — 2026-07-17

Status: **implementation milestone; public release remains blocked**

Source commit: `80b9e1f46762d0c43a7dffc799ebf54b13295c2d`

The adjacent `release-candidate.v1.json` is a new, immutable
`draft_unverified` ledger generated from the signed source commit above. It
does not overwrite the prior
[`v1-source-neutral-ci-remediation-2026-07-17`](../v1-source-neutral-ci-remediation-2026-07-17/verification.md)
milestone. Its source binding is deliberately `baseline_only`, all twelve
release gates remain incomplete, and no supported launch region is declared.

## Why this milestone exists

The [preceding exact-head CI run](https://github.com/Reedtrullz/Handli/actions/runs/29577808506)
proved the corrected runtime least-privilege boundary, then exposed four
PostgreSQL integration failures: a wrapped constraint error, client-owned
future fixture time, raw timestamp decoding assumptions, and raw prepared
`timestamptz`/`jsonb` parameters. Exercising those fixes on a fresh database
also exposed a legacy direct-review fixture that did not satisfy the current
renderer-backed v2 projection.

The remediation preserves the database guards and makes the proof match the
production trust contract:

- constraint failures are asserted through the exact Drizzle wrapper,
  PostgreSQL SQLSTATE, and cause message;
- fixture verification, start, completion, permission, and future clocks are
  database-owned, and an intentionally future completion remains rejected;
- raw PostgreSQL timestamps are decoded from untrusted values, while prepared
  timestamps and JSON are bound as canonical strings;
- the official-offer fixture records renderable evidence and uses the real v2
  review decision path with `correct_and_approve`, `human_review`, proof/session
  binding, and database clock ordering;
- a legacy direct review is otherwise truthful and remains quarantined solely
  because it lacks the renderer-backed decision marker; and
- the unused, incomplete foundation-level current-offer reader was removed, so
  the migration-022/026 database projection is the single public authority.

## Local diagnostic proof

These checks are source diagnostics, not retained candidate-current Linux,
production, legal, or manual release evidence:

| Check | Result |
|---|---|
| Fresh isolated PostgreSQL 16.10 matrix | 46 files, 384/384 tests passed |
| Official-offer v2 focused database path | 9/9 passed before the full fresh-database rerun |
| Database package typecheck and lint | passed on Node.js 22.22.3 |
| Integrated trust-boundary review | no remaining source-level finding after removing the alternate current-offer reader |
| Worktree whitespace validation | passed before the source commit |

The broader local planner, discovery, travel, offline, accessibility, review,
operations, backup, security, and browser proof remains recorded in the prior
[implementation verification](../v1-source-neutral-implementation-2026-07-17/verification.md).
This note does not promote those diagnostics into release-grade evidence.

## Explicit nonclaims

- Replacement exact-head GitHub Actions, immutable image, registry, container
  scan, preview, production, and rollback evidence are not embedded in this
  draft. The external workflow result must be evaluated separately.
- Bunnpris, REMA 1000, and Extra still lack rights-approved live ordinary-price
  and official-offer inputs for a selected region. The real 60-run corpus and
  manual basket reconciliations remain absent.
- Live Cloudflare Access, Caddy, VPS, Kartverket, Valhalla, off-host backup,
  alert delivery, clean-host restore, physical-device, VoiceOver, legal, and
  governance acceptance remain unproven.
- No release, merge to `main`, source activation, or VPS deployment is
  authorized by this milestone.
