# Source-neutral v1 implementation verification — 2026-07-17

Status: **implementation milestone; public release remains blocked**

Source commit: `b2ce9386bbff3cfa5d58fbd4f37b9645fc33dd6d`

The adjacent `release-candidate.v1.json` is a generated `draft_unverified`
ledger. It enumerates all 26 migrations and binds the signed source commit, but
its binding is deliberately `baseline_only`: this later evidence file was not
part of the source commit. No item below changes the manifest's `blocked`
decision, selects a supported region, or passes a public-release gate.

## Implemented source boundary

- Complete-basket planning for exact and reviewed-family needs, quantity units,
  offer/member/multibuy/deposit arithmetic, a maximum of three stores, and a
  dynamic savings/convenience frontier.
- Browsable Oppdag catalog, chain and offer views with ordinary price, current
  price, kroner saved, percentage saved, geographic precedence, and explicit
  member/condition disclosure.
- Opt-in route calculation with opaque five-minute location tokens, bounded
  address labels, self-hosted Valhalla contracts, kill switches, and no address
  or coordinate in the public travel response or saved trip.
- Immutable IndexedDB Handlemodus with offline shell, complete trip snapshot,
  checklist persistence, route summary, and strict cache exclusions.
- Human-reviewed exact/OCR official-offer publication, private evidence
  challenge/digest acknowledgement, read-only PDF behavior, append-only
  lifecycle, public projection, and post-lock database clocks.
- Separate review and operations runtimes, distinct Access audiences,
  loopback-only health, least-privilege database contracts, bounded dashboards,
  fail-closed public API controls, and source-status projection.
- Exact-CI image handoff, forward-only migrations/rollback, migration-bound
  operations controls, inert encrypted backup/restore tooling, monitoring,
  secret/license/SBOM/provenance checkers, and a deliberately closed promotion
  path.

## Local proof completed

Environment: macOS, Node.js 22.22.3, pnpm 10.34.5. These are local diagnostic
results, not retained candidate-current Linux, production, legal, or manual
review evidence.

| Check | Result |
|---|---|
| Recursive TypeScript | domain, db, Kassalapp, worker, and web passed |
| Recursive lint | all five workspace projects passed with zero warnings |
| Domain | 33 files, 318 tests passed |
| Kassalapp | 4 files, 104 tests passed |
| Database unit/static | 32 files, 311 tests passed; 14 files / 65 opt-in integration tests skipped without disposable PostgreSQL |
| Web unit/component | 95 files, 668 tests passed |
| Worker | 18 files, 176 tests passed |
| V2 basket acceptance | 25/25 passed; wrong-program membership, offer arithmetic, tamper, frontier, replay, and negative controls included |
| V1 data validation | 8 sources, 3 candidate regions, 18 coverage cells, 20 scenarios, 60 modeled runs |
| Current real corpus | expected failure: exit 2, `blocked`, 0 passed and 60 pending (`candidate-output-missing`, `no-eligible-live-evidence`) |
| Backup/restore tooling | 43/43 passed, including dollar-quoted PL/pgSQL and top-level transaction-control rejection |
| Public monitor | 11/11 passed |
| Security script contracts | 8/8 passed |
| Immutable deployment handoff | 5/5 passed; deploy/rollback focused suite 16/16 passed |
| Chromium Handlemodus production journey | 3/3 passed, including online-to-offline persistence and 320 CSS-pixel reflow |
| Chromium public/review-boundary journeys | 16/16 passed, including whole-page axe scans, 200% text resize, 400%-equivalent reflow, travel privacy, and route-scoped evidence `blob:` CSP |
| Production web build | 24 static/dynamic routes compiled before the final contrast-only and browser-test amendments |
| Dependency policy | 0 high/critical advisories; 2 moderate transitive advisories remain (development-only esbuild server path and PostCSS stringify path) |
| License inventory | 453 packages; digest `0737c7596ba2a1fecca07661c28ba685a08b597c866bd8667aee672804ec1167` |
| Secret scan | 585 repository files passed |

The final monolithic recursive rerun and an exact-source rebuild were not
started after free disk fell below the required 30 GiB safety floor. Component
suites, the final Chromium public matrix, acceptance checks, and static checks
were already green. Exact-commit Linux, PostgreSQL, build, and three-browser
proof is delegated to branch CI rather than weakening the disk guard.

## Explicit nonclaims and activation blockers

- Bunnpris, REMA 1000, and Extra do not yet have recorded rights-approved live
  ordinary-price and official-offer inputs for any selected launch region.
  Runtime source switches, schedules, and publication remain inactive.
- The real 60-run regional corpus and five manual reconciliations per region are
  absent. The synthetic oracle proof cannot substitute for live evidence.
- No live Cloudflare Access, Caddy, VPS, Linux `/proc/self/fd` renderer, preview,
  production, immutable registry promotion, image signature, container scan, or
  rollback readback was performed for this source commit.
- Firefox and WebKit binaries were not installed locally near the disk floor.
  No VoiceOver, native browser zoom, keyboard-only review, or physical iOS or
  Android acceptance was performed.
- Kartverket URL/retention behavior and actual edge/application logs have not
  been accepted; live Valhalla routing and log-minimization proof is absent.
- The off-host provider, authenticated manifest origin, backup role/grants,
  private-blob materialization/read view, retention, timer, missing-backup
  alerts, clean-host restore, and measured RPO/RTO remain unactivated.
- Production alert evaluation is intentionally rejected until a scheduler and
  writer are composed. PDF evidence remains readable but non-approvable.
- The live PostgreSQL offer row-lock race is implemented as an opt-in CI test
  but was not run locally without a disposable database.
- No release, merge to `main`, public activation, or VPS deployment is
  authorized by this evidence.
