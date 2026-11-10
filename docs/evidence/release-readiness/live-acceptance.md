# Live acceptance for the deployed protected candidate (Task 24)

Date: 2026-09-22. Branch: `codex/prices-and-discounts`. This document covers
Task 24 Steps 1-3 (deployment and server-side verification). Steps 4-5 are
open external gates; Task 25 promotion is blocked by design.

## Deployment identity

| Item | Value |
| --- | --- |
| Merge commit (main) | `86f0d9c95c477cad573a27151427c7e451f3bdb7` |
| Candidate SHA (Task 23) | `b3618723213eb3aaeab798e065e9d6a233647d32` |
| Fix commit | `b361872` fix: keep catalog provenance for offer-backed rows with category paths |
| Evidence commit | `b719d90` docs: record Task 23 candidate checks for b361872 |
| PR | [#12](https://github.com/Reedtrullz/Handli/pull/12), marked ready and merged (merge commit) |
| CI on main | [run 35702500108](https://github.com/Reedtrullz/Handli/actions/runs/35702500108), conclusion `success` |
| Deploy workflow | [run 35703457141](https://github.com/Reedtrullz/Handli/actions/runs/35703457141), deploy job success, 0 failed steps |
| Running image | `handleplan:86f0d9c95c477cad573a27151427c7e451f3bdb7` |
| Image ID | `sha256:cfa10320b369aa936768e5534d36cdbc544712c70a4fbc68c013814f9102bb59` |
| Rollback target | `670daec8c02b0df965c2a18ec5062f08297ec247`, image `sha256:31a05db6aaa687fa02dc8b058f11fa84eeac4f536b4cdfcd183af35cbbe97c17` |

## Pre-deploy state reconciliation

Before merging, deployment state files were stale from an interrupted
2026-08-21 operation while production had run healthy `670daec8` since
2026-08-24. Reconciled to the live-proven deployment now running:

- Backup first: `/opt/apps/handleplan/state-backups/state-before-reconcile-20260922T075724Z.tar.gz`,
  sha-256 `b4297fef2c702f7c782a4541f552583a35c0b83d10f643cb67cac7a219d8619a`
  (contains the full pre-reconcile state; rollback of the reconciliation itself
  is possible from this tarball).
- Rewrote `current-deployment`, `current-revision`, `current-image-id`,
  `deployment-high-water` to the live-proven `670daec8...` /
  `sha256:31a05db6...` tuple; created the matching `verified-images/670daec8...`
  record; cleared a bounded self-pairing `pending-deployment` record that had
  been used only to satisfy the create-only validator grammar; removed a stale
  empty `.deployment-operation.lock`.
- Guard preconditions were verified before the merge; one ordering slip made
  step A exit nonzero after its writes and was corrected in step B.

## Post-deploy verification (2026-09-22)

### Services and image

All four application containers healthy on the exact deployed image,
restarts = 0 (postgres lifetime counter 3 unchanged):

```text
handleplan-app-1         handleplan:86f0d9c9... Up (healthy)
handleplan-worker-1      handleplan:86f0d9c9... Up (healthy)
handleplan-review-1      handleplan:86f0d9c9... Up (healthy)
handleplan-operations-1  handleplan:86f0d9c9... Up (healthy)
handleplan-postgres-1    postgres:16.10-alpine  Up 5 weeks (healthy)
```

### State-machine readback

```text
current-deployment = v1 86f0d9c9... current
current-image-id   = sha256:cfa10320...
accepted-deployment = v1 86f0d9c9... sha256:cfa10320... 670daec8... sha256:31a05db6... ...
pending-deployment = absent
verified-images entries: 78
```

The accepted record embeds the predecessor tuple (`670daec8` /
`sha256:31a05db6...`), proving the rollback chain to the previously verified
deployment.

### Health and readiness

```text
GET /api/health  -> {"status":"ok","version":1,"commit":"86f0d9c95c477cad573a27151427c7e451f3bdb7"}
GET /api/ready   -> {"database":{"requiredMigration":"031_supported_chain_expansion.sql","status":"ok"},"status":"ok","version":1}
```

Public `https://handle.reidar.tech` responds 302 to Cloudflare Access login
without service-token headers; expected for the protected scope.

### Migration and baseline ledger

`public.handleplan_schema_migrations` readback: 43 rows, through
`043_meny_official_offer_source.sql` (applied 2026-09-22 08:12:55 UTC, with
`041_public_offer_projection_repair` and `042_official_offer_worker_boundary`
in the same batch). The `/api/ready` required-migration marker
(`031_supported_chain_expansion.sql`) matches the plan expectation.

### Worker jobs (last 24h)

```text
job_kind                             status      count  latest (UTC)
benchmark-price-refresh               succeeded   4     2026-09-22 06:41
catalog-refresh                       succeeded   1     2026-09-21 10:37
historical-observation-collection     succeeded   1     2026-09-22 04:16
official-offer-discovery              partial     1     2026-09-22 08:13
official-offer-lifecycle-reconcile    succeeded   2     2026-09-22 08:15
open-prices-benchmark-refresh         succeeded   4     2026-09-22 07:30
physical-store-sync                   succeeded   1     2026-09-22 03:15
```

Zero failed jobs in 24h. The single `partial` is tjek
`official-offer-discovery` at 08:13 UTC: counts `fetched 104 / persisted 104 /
quarantined 104 / accepted 0 / failed 3`. That is a review backlog signal,
reported separately here rather than concealed as zero failures. No SQL or
transport failures recorded.

### Source freshness

- Catalog observations refresh daily at about 10:37 UTC; latest run
  2026-09-21 (run 450, 398 observations). Sep 22 run expected on cadence.
- Lifecycle reconcile receipts: two tjek runs on 2026-09-22 (08:00, 08:15),
  both `succeeded` with result hashes; the 08:00 run examined and expired 5
  offers; publication state `foundation-disabled` with
  `publication_authorized = f` (publication remains gated as designed).

## Honest non-claims

- Step 4 real-browser authenticated acceptance was not performed (requires the
  user's Chrome with Cloudflare Access login); the browser gate stays open.
- Step 5 refresh/validity observation over a real publication or expiry
  boundary is time-gated and stays open; the two lifecycle receipts above are
  not a boundary observation.
- Task 25 public promotion remains blocked pending the independent external
  receipt signer (Task 25 Step 2). No self-signed or generated receipt exists.
- The tjek discovery partial/quarantine backlog is reported, not resolved; no
  review decisions were fabricated.
