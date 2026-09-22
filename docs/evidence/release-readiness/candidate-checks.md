# Candidate checks for the immutable release candidate (Task 23)

Date: 2026-09-22. Branch: `codex/prices-and-discounts`.

## Candidate identity

| Item | Value |
| --- | --- |
| Source SHA | `b3618723213eb3aaeab798e065e9d6a233647d32` |
| CI (push) | [run 35690231917](https://github.com/Reedtrullz/Handli/actions/runs/35690231917), conclusion `success` (10m34s) |
| CI (pull request) | [run 35690234053](https://github.com/Reedtrullz/Handli/actions/runs/35690234053), conclusion `success` (10m2s) |
| Image reference | `handleplan:b3618723213eb3aaeab798e065e9d6a233647d32` |
| Image ID (push bundle) | `sha256:dffb5b7711b3fc331eafd774586801e56b8befcfe6c204027abce8952b089b85` |
| Platform | `linux/amd64` |
| Bundle manifest | `handleplan-image-bundle.v1`, artifact `handleplan-ci-image-b3618723213eb3aaeab798e065e9d6a233647d32-attempt-1` (274,609,624 bytes) |
| Image archive SHA-256 | `b84ab1fbc628606c636369c34eeb17928e3e8bdee5b876bf989d24906c490770` |
| Provenance | SLSA v1, builder `github.com/Reedtrullz/Handli/actions/workflows/ci.yml`, invocation `35690231917` |

`gh pr checks 12` on the candidate head: `verify` pass (both runs); promotion jobs `skipping` as designed for a draft PR.

## Final blocker fixed on the candidate SHA

All 18 previous CI runs failed; run 18 (`9297597`) reached image e2e and
failed because `/api/discovery/search` returned 503 in all three browsers.
Root cause: in `PostgresPublicCatalogIndexReader.readDiscovery`, a canonical
product present in both the catalog scan and the offer-backed scan had its
product summary replaced by offer evidence (`image-offer-*` source id) while
the category path kept catalog provenance (`image-catalog-*`). The public
discovery contract refines category-path provenance to the same reviewed
source as the reported catalog evidence, so `validateResponse` rejected the
response and the route degraded to 503. Fix on `b361872`: an offer-backed
row with a real catalog category path keeps its catalog product summary;
offer provenance is reported only for rows without a catalog category path
(the established offer-backed boundary). Regression coverage added to the
governed image-database seed test, which previously validated only the
default (non-offer-backed) reader against the seeded fixture.

## Local verification at the candidate SHA

Disposable PostgreSQL 16.10 container (`hp-local-ci-db`, CI-style roles and
passwords), fresh database, migrations applied twice for each suite run.

```bash
node deploy/migrate.mjs && node deploy/migrate.mjs
RUN_DB_INTEGRATION=1 RUN_OFFICIAL_OFFER_DB_INTEGRATION=1 \
  corepack pnpm --filter @handleplan/db exec vitest run --no-file-parallelism
RUN_PRODUCTION_IMAGE_DATABASE_SEED=1 APP_COMMIT_SHA=$(git rev-parse HEAD) \
  corepack pnpm --filter @handleplan/db exec vitest run \
  src/production-image-database-seed.integration.test.ts --no-file-parallelism
corepack pnpm --filter @handleplan/db typecheck
corepack pnpm --filter web typecheck
corepack pnpm --filter web exec vitest run
corepack pnpm --filter @handleplan/worker typecheck
corepack pnpm --filter @handleplan/worker exec vitest run
corepack pnpm --filter @handleplan/tjek test
corepack pnpm --filter @handleplan/open-prices test
corepack pnpm operations:image:test
node --test tests/operations/deployment-artifact-handoff.test.mjs
```

Results:

- db suite: **436 passed / 1 skipped** (1 skipped = `production-image-database-seed`, CI-gated; also verified locally on a fresh database, including the new provenance assertion).
- reader unit tests: **39 passed**; web suite: **734 passed / 0 failed**; web typecheck exit 0.
- worker: typecheck exit 0, **214 passed / 1 skipped**; tjek: **31 passed**; open-prices: **27 passed**.
- `operations:image:test`: **17 pass / 0 fail**; deployment-artifact handoff: **30 pass / 0 fail**.
- migration-files: **36 passed**; readiness + private-runtime-readiness: **9 passed**.

## CI image-bundle verification

The push-run bundle was downloaded (`gh run download 35690231917`) and
checked with `scripts/operations/verify-ci-image-bundle.mjs`: manifest
identity, artifact SHA-256 digests, and SLSA provenance binding (base image
digest, revision, run id, image archive digest) all verified locally. The
final SPDX step compares the CI SBOM against the *locally installed*
dependency inventory; the local macOS inventory legitimately contains
darwin-arm64 platform binaries (`@esbuild/darwin-arm64`,
`@img/sharp-darwin-arm64`, `@next/swc-darwin-arm64`,
`@rollup/rollup-darwin-arm64`) absent from the linux/amd64 CI inventory, so
this host-bound step cannot pass off-platform and was not claimed. The
complete bundle verification, including the SPDX inventory check, runs on the
ubuntu-24.04 deploy runner in `.github/workflows/deploy-preview.yml` before
any VPS transfer.

## EXTERNAL GATES (not performed)

- **Deployment and live acceptance (Tasks 24-25)**: explicitly out of scope for this task and stopped pending explicit user authorization. No production or staging system was touched.
- **SPDX inventory check on this host**: inherently host-bound (see above); performed by the deploy workflow on the Linux runner instead.
- **Off-host backup upload, restore drill, alert delivery, exact-image rollback drill**: remain external gates per `operations.md`.
- **Live Valhalla routing, device/accessibility testing**: not exercised on this candidate.
- **Tjek key owner classification** (Task 22 Step 3): still open; requires the source owner.

## Source-authority status (unchanged by this task)

- **SPAR**: BLOCKED (image-only brochure PDF; no structured, machine-readable offers) — `spar-source.md`.
- **Joker**: BLOCKED for structured offer intake — `joker-source.md`.
- **Europris**: BLOCKED (no structured product/offer evidence observed; URL-grammar lead requires separate bounded authorization) — `europris-source.md`.
- **Meny**: PARTIAL (structured endpoints exist and are documented, but `pagesWithProducts` empty; no enrichment/product JSON observed on the wire) — `meny-source.md`.
- Consequence: national discovery coverage for SPAR, Joker, Europris and Meny remains source-authority-limited regardless of application readiness; prices and discounts for these chains cannot be shown until a qualified source exists.

## Non-claims

This document records candidate checks only. It does not claim a live deploy,
promoted release, device testing, live routing, restored backup, delivered
alert, tested rollback, or resolved source-rights for SPAR, Joker, Europris
or Meny. CI success proves the candidate passes the repository's automated
gates; it does not substitute for the external gates listed above.
