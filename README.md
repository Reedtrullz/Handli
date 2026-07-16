# Handleplan

Handleplan is an anonymous-first Norwegian grocery planner under protected-alpha development. A shopper can discover observed prices, add an exact product or explicitly approve a reviewed product family in a shared basket, and compare complete, non-dominated plans using the eligible prices Handleplan can verify across at most three intended chains: Bunnpris, REMA 1000, and Extra.

The binding v1 promise is documented in the [product-truth contract](docs/contracts/v1-product-truth.md): Handleplan names the comparison scope, distinguishes ordinary observations, official offers, and historical comparisons, and never hides unknown coverage behind an unqualified “best” claim.

Handleplan's original code is licensed under
[`AGPL-3.0-or-later`](LICENSE). External price/product/offer data, retailer and
provider marks, imagery, captures, dependencies, and other third-party material
are not relicensed; see the [licensing boundary](LICENSES/README.md). The
[public-good governance policy](docs/governance/public-good-governance.md),
[Norwegian privacy notice](docs/privacy/personvern.md), [security
policy](SECURITY.md), and [data-flow/threat
model](docs/security/data-flow-threat-model.md) are published alpha artifacts,
not claims that legal, source-rights, privacy, or public-launch review has
passed.

## Quick start with deterministic data

Requirements: Node.js 22 and Corepack pnpm 10.

```bash
corepack enable
corepack pnpm install --frozen-lockfile
HANDLEPLAN_MODE=fake corepack pnpm dev
```

Open `http://localhost:3000/planlegg`. Fake mode is explicit, server-only, fixed-clock, makes no Kassalapp or PostgreSQL network request, and does not need credentials or PostgreSQL.

## Verification

```bash
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm build
corepack pnpm exec playwright install chromium
corepack pnpm exec playwright test
```

See [local development](docs/runbooks/local-development.md) and the [Kassalapp boundary](docs/runbooks/kassalapp.md).

## Protected VPS preview

Production deployment assets live under `deploy/`. The app runs as a non-root
standalone Next.js container on loopback port 3004 with a dedicated PostgreSQL
service, an owner-only one-shot migrator, a least-privilege `handleplan_app`
worker role plus a distinct read-only `handleplan_web` role, checksum-verified forward migrations, immutable commit-tagged
images, health-gated startup, and rollback to the previous local image when
startup fails. `deploy/Caddyfile.handleplan` rejects direct-origin traffic and
requires Cloudflare Access before proxying the preview.

`KASSAL_API_KEY`, `POSTGRES_PASSWORD`, and the pairwise-distinct
`APP_DATABASE_PASSWORD` and `WEB_DATABASE_PASSWORD` belong only in
`/opt/apps/handleplan/shared/production.env` on the VPS. All three database
passwords must be independently generated, URL-safe 32-128 character secrets.
They are not GitHub Actions secrets and must never be committed or printed.

## Scope

Oppdag browses eligible Kassalapp observations without requiring a search, shows the prices actually returned for the intended chains, supports optional product filtering, and can add an exact product to the same local basket used by Planlegg. Coverage can be incomplete. Cross-chain differences are not retailer discounts, and a previous observation is not an official before-price. The alpha does not claim complete three-chain coverage, official offers, branch inventory, branch-specific shelf prices, travel-time routing, or plan impact. The current VPS deployment is an owner-only protected preview. Anonymous basket, matching preferences, and selected plan stay in local browser storage; future volunteered origin is required to remain transient and unpersisted.

Exact required quantities support packages, grams, and millilitres. The server uses approved package measures, buys whole packages, and shows surplus. Flexible matching is admitted only through a server-published reviewed family and a complete candidate snapshot that the shopper has inspected and approved; unknown, stale, ambiguous, or empty families fail closed.

## Public-release gates

Public operation is blocked until the [evidence-linked v1 release gates](docs/release/v1-release-gates.md) all pass for one release candidate. The current blockers include source rights, declared three-chain/regional coverage, the full ingestion, offer, and travel pipelines, privacy/security/legal review, accessibility/device evidence, real-basket reconciliation, tested off-host backup/restore, and production monitoring. A protected preview or distributed quota control alone is not presented as public-release proof.

The implementation source of truth is the [comprehensive v1 work plan](docs/superpowers/plans/2026-07-16-handleplan-v1-comprehensive-work-plan.md). The [v1 baseline](docs/evidence/v1/baseline-2026-07-16.md) and [reviewed foundation verification](docs/evidence/v1/foundation-2026-07-16.md) are point-in-time non-claim records.
