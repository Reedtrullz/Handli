# Handleplan evidence/planner/worker milestone — 2026-07-16

This record covers the protected-alpha implementation after the V1 foundation.
It is evidence for a source-neutral implementation milestone, not a public v1
release certificate and not proof of permission to activate a grocery source.

## Identity

- Audited main baseline: `a890b05fa07e5fa2fc806b0640a62cf37f8b234e`
- Foundation commits: `66970c4af647db3818eceaf7b754d2294e00454b`,
  `fa6e08dae1f5beeb2f063a6d7ea96d5a0865d96a`
- Implementation branch: `codex/v1-evidence-planner-worker`
- Candidate commit, immutable image digest, CI run, and VPS readback: pending
- Runtime: Node.js `22.22.3`, Corepack pnpm `10.34.5`

## Implemented boundary

- Public web is database-read-only and has no Kassal credential or upstream
  refresh path. The scheduled worker owns the bounded ingestion surface.
- Every physical Kassal HTTP attempt rechecks current source authorization after
  acquiring the shared request budget, including retries and store subrequests.
- Worker scheduling uses database leases, fencing, bounded jobs, graceful
  shutdown, sanitized loopback-only health, and exact revision readback.
- Catalog publication is derived only from immutable observations attached to a
  completed catalog run. Retrieval time and source update time remain distinct.
- Ingestion runs start as `running`, make one terminal transition, and cannot be
  relabeled, rewritten, or deleted afterward.
- Exact-product planning rehydrates GTIN identities from the eligible catalog,
  reads persisted price/history/coverage evidence, fulfils whole packages, and
  returns deterministic non-dominated complete plans using at most three chains.
- Oppdag browses the persisted catalog without a required query and keeps
  ordinary prices, official offers, and historical comparisons separate.
- Basket state v2 persists a normalized convenience preference instead of a
  brittle plan ID. Handlemodus stores an immutable trip snapshot in IndexedDB;
  the service worker excludes every API request.
- Automatic rollback to a pre-worker image is explicitly safe-degraded: it uses
  `handleplan_web`, a static non-secret compatibility key, and HTTPS loopback
  port 1. It can serve eligible cached reads but cannot call Kassalapp or write
  worker state.

## Fresh local verification

| Area | Result | Scope |
|---|---|---|
| Data manifest | passed | 7 sources, 4 permission states, 3 regions, 18 coverage cells, 20 scenarios, 60 benchmark runs. |
| Fresh PostgreSQL | 162/162 passed | New database, all 11 migrations, 22/22 files; includes catalog, ingestion lifecycle, request-budget concurrency, worker-lease renewal, price evidence, and exact readers. |
| Upgrade/restore and runtime role proof | passed | Eleven-migration upgrade, pinned dump/restore, append-only guards, worker/web ACL split, and terminal-run immutability. |
| Typecheck | passed | Domain, Kassalapp, database, worker, and web. |
| Lint | passed | All five projects. |
| Normal workspace tests | passed | Domain 164/164; Kassalapp 102/102; database 124/124 with 38 live cases intentionally gated and separately proven 162/162; worker 110/110; web 216/216. |
| Production web build | passed | Next.js compiled and generated 15 public/API routes. |
| Production offline journey | 1/1 passed | Start a strict trip, disconnect, reload Handlemodus, and retain checklist state. |
| Shell/YAML/static deploy checks | passed | Shell syntax, deployment-state behavior, YAML value parsing, exact worker readback assertions, and `git diff --check`. |
| Independent P1 review | passed | No remaining P0/P1 in catalog publication, per-attempt authorization, ingestion provenance, worker promotion, or safe-degraded rollback. |

The ordinary Playwright suite was run after the architecture change and exposed
two stale test assumptions: a generic need was submitted through the new
exact-only public planning contract, and Oppdag asserted its previous heading.
Those assertions were updated to the current exact identity and catalog wording,
but the local rerun was blocked when the desktop approval service reached its
usage limit for loopback server execution. The candidate must therefore obtain
a green 5/5 browser run in GitHub Actions (or a later authorized local rerun)
before this milestone can be promoted or deployed.

Docker Compose rendering is also not claimed locally because the installed
Compose plugin is unavailable. No VPS deploy or rollback drill has been run for
this candidate yet.

## Explicit non-claims and next gates

- Kassalapp remains `conditional` and source access remains off by default.
- No rights-cleared official-offer vertical, private review queue, or current
  Bunnpris/REMA 1000/Extra regional offer run exists.
- Reviewed product-family matching is not yet server-authoritative. The public
  planning contract in this milestone deliberately accepts exact GTIN needs
  only; generic needs must fail closed until V1-05 is complete.
- No routing provider, ephemeral-origin travel calculation, or travel-aware
  frontier is implemented.
- No live backup/alert/clean-host drill, container SBOM/signature promotion,
  physical-device PWA proof, VoiceOver report, or regional real-basket corpus is
  claimed.
- Cloudflare Access must remain enabled. Public launch remains blocked by G1–G12
  in `docs/release/v1-release-gates.md`.

Decision: continue protected implementation; do not activate sources or remove
access protection.
