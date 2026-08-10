# Handleplan v1 foundation verification — 2026-07-16

This record captures the reviewed V1-00 through V1-04 **foundation** before its
branch commit. It is implementation evidence, not a public-release certificate
and not proof of a scheduled production ingestion service.

## Identity and runtime

- Audited starting point: `a890b05fa07e5fa2fc806b0640a62cf37f8b234e`
- Implementation branch: `codex/v1-foundation`
- Runtime: Node.js `22.22.3`, Corepack pnpm `10.34.5`
- Database: pinned PostgreSQL `16.10-alpine` image on an isolated local port
- Browser: Playwright `1.58.0`, Chromium, Norwegian locale and Oslo timezone

The eventual commit SHA and GitHub Actions run belong in a later immutable
candidate record. The local container image below was built from the uncommitted
workspace and therefore cannot be promoted as a release artifact.

## Fresh verification

| Area | Result | Scope |
|---|---|---|
| Frozen dependency install | passed | `CI=true corepack pnpm install --frozen-lockfile`; lockfile resolution was unchanged. |
| V1 data manifest | passed | 7 sources, 3 regions, 18 coverage cells, 20 scenarios, 60 benchmark runs. |
| Migrations | passed twice | Eight additive migrations through `008_provider_request_budget.sql`. |
| Upgrade and restore | passed | Legacy upgrade, pinned `pg_dump`/`pg_restore`, eight checksums, protected evidence, and restored runtime-role policy. |
| Runtime least privilege | passed | Separate `handleplan_app`; cache/worker writes and request-budget coordination allowed; protected mutation, trigger disable, DDL, and owner-role assumption denied. |
| Live database suite | 54/54 passed | Includes 21 evidence/cache tests and three shared-budget tests against PostgreSQL. |
| Shared request budget | passed | Exactly three of four concurrent claims admitted across two coordinators; caller cancellation and 100 ms held-lock deadline both passed. |
| Typecheck | passed | All five workspace projects under Node 22. |
| Lint | passed | Domain, worker, Kassalapp, DB, and web. |
| Ordinary workspace tests | 395 passed, 15 gated skips | The skipped PostgreSQL cases are the same cases proven separately in the 54/54 live run; no database-pass claim is based on the skipped run. |
| Production web build | passed | Next.js generated all public pages and API routes. |
| Browser acceptance | 5/5 passed | Leak detector, 320 px reflow, complete-frontier selection, stale-evidence rejection, and Oppdag-to-Planlegg exact-product journey. |
| Production image build | passed | Pinned Node base, frozen install, Next.js build, and non-root runner image; local uncommitted manifest list `sha256:a73d6aaf1360c9c83f7edc760cdc9a82dbe834879e71f8b67f480077e35785ae`. |
| Diff and secret-pattern check | passed | No whitespace errors or common private-key/token patterns found; committed credential locations contain only names or explicit CI placeholders. |

Shell syntax and `deploy/migrate.mjs` syntax passed. The final local run could not
execute `docker compose config` because this Mac's Docker CLI has a broken
Compose-plugin symlink. GitHub Actions remains the authoritative Compose check;
the branch must not be described as CI-clean until that job passes.

## Independent review outcome

An independent final review found no remaining Critical or Important issue in
the scoped foundation after these corrections:

- public planning and discovery read back only persisted, eligible evidence;
- eligibility is permission-, source-, run-, time-, and coverage-gated;
- append-only evidence and the migration ledger fail closed;
- the runtime database role cannot forge source permission or bypass guards;
- official-offer arithmetic rejects contradictory before-prices;
- Kassalapp queues, responses, retries, cancellation, and parsing are bounded;
- accepted-plus-quarantined store conflicts and invalid category rows downgrade
  coverage instead of producing a false complete state; and
- all production web replicas spend from the shared PostgreSQL Kassalapp budget.

The earlier runbook sentence claiming a live credentialed probe was removed.
No credentialed live probe is release evidence in this record.

## Exact scope boundary

This foundation includes source-neutral contracts, the evidence schema and read
model, source DTO normalization, official fixtures, a bounded worker runner,
runtime security, and distributed upstream quota coordination.

It does **not** yet include real Kassalapp job handlers, catalog repositories,
scheduling/start entrypoint, persistent job composition, a production worker
service, or a credentialed live probe. Those remain required before V1-04 can be
called scheduled ingestion.

V1-05 is also not complete. The current protected-alpha planning request still
accepts browser product metadata; the next implementation slice must introduce
canonical active-GTIN rehydration, an identity-only versioned request, bounded
server product summaries, and basket-state v2. Reviewed family matching remains
a separate later gate.

## Release decision

Continue protected implementation. Public launch remains blocked by every
unpassed gate in `docs/release/v1-release-gates.md`, including source rights,
three-chain regional evidence, scheduled ingestion, offers/review, travel,
offline mode, accessibility, security/legal/governance, operations, and real
baskets. Cloudflare Access must remain enabled.
