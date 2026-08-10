# Source-neutral v1 typecheck remediation verification — 2026-07-17

Status: **implementation milestone; public release remains blocked**

Source commit: `4bcb2000724cf4904c73b2bc99f8f835c709c0ad`

The adjacent `release-candidate.v1.json` is a new, immutable
`draft_unverified` ledger generated from the signed source commit above. It
does not overwrite the prior
[`v1-source-neutral-pg-remediation-2026-07-17`](../v1-source-neutral-pg-remediation-2026-07-17/verification.md)
milestone. Its source binding is deliberately `baseline_only`, all twelve
release gates remain incomplete, and no supported launch region is declared.

## Why this milestone exists

The [preceding exact-head CI run](https://github.com/Reedtrullz/Handli/actions/runs/29579979796)
passed dependency, license, secret, manifest, data, migration, backup/restore,
runtime least-privilege, PostgreSQL integration, and previous-image
compatibility gates. It then exposed one TypeScript excess-property error in
the offline Handlemodus browser fixture: the fixture supplied
`geographicDirectoryAttestation` to
`deriveExactProductPlanDeltaExplanationsV1`, whose input deliberately contains
only facts that affect plan-delta explanations.

The fixture now leaves geographic-directory provenance on the exact-product
response, where the response and strict-trip schemas validate and retain it,
while passing only evidence, generation time, market context, plans, and travel
routes into plan-delta derivation. Production behavior and the fail-closed
geographic attestation contract are unchanged.

## Local diagnostic proof

These checks are source diagnostics, not retained candidate-current Linux,
production, legal, or manual release evidence:

| Check | Result |
|---|---|
| Recursive workspace typecheck | passed across all five checked projects on Node.js 22.22.3 |
| Recursive workspace lint | passed across all five checked projects on Node.js 22.22.3 |
| Domain unit suite | 318/318 tests passed |
| Web unit suite | 668/668 tests passed |
| Web production build | passed with 24 generated routes |
| Direct Chromium Handlemodus journey | 2/2 tests passed |
| Worktree whitespace validation | passed before the source commit |

The fresh PostgreSQL 16.10 remediation diagnostics remain recorded in the
prior [PostgreSQL verification](../v1-source-neutral-pg-remediation-2026-07-17/verification.md).
This note does not promote those diagnostics or the partially successful CI
run into release-grade evidence.

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
