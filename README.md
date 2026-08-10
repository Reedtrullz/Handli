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

Production deployment assets live under `deploy/`. One immutable image runs as
three isolated non-root standalone Next.js processes: the public app on loopback port 3004
has only the read-only `handleplan_web` connection and no `REVIEW_*`
configuration, while the private review process on loopback port 3006 has only
the isolated `handleplan_review` connection and fixed Access configuration.
The internal operations process on loopback port 3007 has only the aggregate
`handleplan_operations` function boundary and a distinct Access audience. A
dedicated PostgreSQL service, owner-only one-shot migrator, and least-privilege
`handleplan_app` worker role complete the runtime role split.
Deployments use checksum-verified forward migrations, immutable commit-tagged
images, health-gated startup, and rollback to the previous local image when
startup fails. While the VPS remains an owner-only preview,
`deploy/Caddyfile.handleplan` rejects direct-origin traffic and requests missing
an Access assertion for the whole hostname. It then sends only the exact
`/review` and `/api/review` route families to port 3006, exact internal
operations route families to port 3007, and all remaining routes to port 3004.
Both private apps still verify their separate assertions
cryptographically; the proxy's header-presence check is not trusted as
authentication. Removing the preview-wide gate belongs to an explicitly
authorized public-release change, not this runtime split.

The private offer-review surface has its own cryptographically verified Access
boundary and least-privilege database role. Its fail-closed configuration,
rights gates, append-only actions, deployment checklist, and explicit nonclaims
are documented in the [private review runbook](docs/runbooks/private-review.md).
The source-neutral private renderer pins the capture's canonical parent chain
and verifies owner/mode/link count, size, MIME signature, and full checksum
before an Access-authenticated reviewer can view the file. The GET response has
no actionable approval proof. Supported images require a complete browser read,
client SHA-256, successful decode, and a candidate/session-bound acknowledgement
before the server records a one-time proof for approval or correction. PDF
captures are not fetched or rendered in v1 and remain fail-closed for approval
and correction at the database recorder, receipt constraint, and decision
transaction; rejection remains available without artwork. This is
repository functionality, not evidence of human sight, a configured Access
policy, a rights-approved live source, a deployed capture volume, or production
review.

`KASSAL_API_KEY`, `POSTGRES_PASSWORD`, and the pairwise-distinct
`APP_DATABASE_PASSWORD`, `WEB_DATABASE_PASSWORD`, `REVIEW_DATABASE_PASSWORD`,
and `OPERATIONS_DATABASE_PASSWORD` belong only in
`/opt/apps/handleplan/shared/production.env` on the VPS. All four database
passwords must be independently generated, URL-safe 32-128 character secrets.
The review and operations Access/base-URL settings, the independently generated
`REVIEW_EVIDENCE_PROOF_SECRET`, and the digest-bound
`OPERATIONS_SOURCE_ROSTER_JSON` also belong in that protected file. Compose
derives each private database URL and exposes it only to its matching process;
the operations process alone receives the source roster. Review and operations
may use the same canonical HTTPS origin because Caddy routes exact path families,
but they must use separate Cloudflare Access applications and distinct bare
audience tags. The deployment preflight compares those tags without printing or
sourcing the protected file. These values are not GitHub Actions secrets and
must never be committed or printed.

## Scope

Oppdag browses eligible Kassalapp observations without requiring a search, shows the prices actually returned for the intended chains, supports optional product filtering, and can add an exact product to the same local basket used by Planlegg. Coverage can be incomplete. Cross-chain differences are not retailer discounts, and a previous observation is not an official before-price. The alpha does not claim complete three-chain coverage, official offers, branch inventory, branch-specific shelf prices, travel-time routing, or plan impact. The current VPS deployment is an owner-only protected preview. Anonymous basket, matching preferences, and selected plan stay in local browser storage; future volunteered origin is required to remain transient and unpersisted.

Exact required quantities support packages, grams, and millilitres. The server uses approved package measures, buys whole packages, and shows surplus. Flexible matching is admitted only through a server-published reviewed family and a complete candidate snapshot that the shopper has inspected and approved; unknown, stale, ambiguous, or empty families fail closed.

## Public-release gates

Public operation is blocked until the [evidence-linked v1 release gates](docs/release/v1-release-gates.md) all pass for one release candidate. The current blockers include source rights, declared three-chain/regional coverage, the full ingestion, offer, and travel pipelines, privacy/security/legal review, accessibility/device evidence, real-basket reconciliation, tested off-host backup/restore, and production monitoring. A protected preview or distributed quota control alone is not presented as public-release proof.

The implementation source of truth is the [comprehensive v1 work plan](docs/superpowers/plans/2026-07-16-handleplan-v1-comprehensive-work-plan.md). The [v1 baseline](docs/evidence/v1/baseline-2026-07-16.md) and [reviewed foundation verification](docs/evidence/v1/foundation-2026-07-16.md) are point-in-time non-claim records.
