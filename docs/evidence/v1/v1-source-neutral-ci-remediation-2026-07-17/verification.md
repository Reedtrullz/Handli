# Source-neutral v1 CI remediation verification — 2026-07-17

Status: **implementation milestone; public release remains blocked**

Source commit: `aa143744d943f00f4f82d9fa0a303f38eb9dac6e`

The adjacent `release-candidate.v1.json` is a new, immutable
`draft_unverified` ledger generated from the signed source commit above. It
does not overwrite the earlier
[`v1-source-neutral-implementation-2026-07-17`](../v1-source-neutral-implementation-2026-07-17/verification.md)
milestone. Its source binding is deliberately `baseline_only`, all twelve
release gates remain incomplete, and no supported launch region is declared.

## Remediation bound by this milestone

The [first exact-head CI run](https://github.com/Reedtrullz/Handli/actions/runs/29577116206)
for the implementation milestone reached the live PostgreSQL least-privilege
proof and exposed a malformed synthetic fixture. The fixture's normalized
review envelope omitted the top-level
`publicationRoute: "human-review-required"` marker required by migration 021,
so the strictly bounded review projection correctly returned no rows.

The production eligibility predicate was not relaxed. The fixture now persists
the same canonical review route emitted by the ingestion contracts, and a
focused static regression requires the named envelope and route marker to
remain in the executable role proof.

## Local diagnostic proof

These checks are useful source diagnostics, not retained candidate-current
Linux, production, legal, or manual release evidence:

| Check | Result |
|---|---|
| Private review decision-boundary static suite | 3/3 passed |
| Runtime role proof syntax | passed on Node.js 22.22.3 |
| Database package typecheck and lint | passed |
| Disposable PostgreSQL runtime-role proof | passed, including the bounded eligible row and all direct-access denials; the disposable container was removed |
| Worktree whitespace validation | passed before the source commit |

The broader local planner, discovery, travel, offline, accessibility, review,
operations, backup, security, and browser proof remains recorded in the prior
[implementation verification](../v1-source-neutral-implementation-2026-07-17/verification.md).
This note does not convert those diagnostics into release-grade evidence.

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
