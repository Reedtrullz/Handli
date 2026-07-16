# Handleplan

Handleplan is an anonymous-first Norwegian grocery planner. Phase 1 lets a shopper build an explicitly matched basket and compare complete, non-dominated plans across at most three chains: Bunnpris, REMA 1000, and Extra.

## Quick start with deterministic data

Requirements: Node.js 22 and Corepack pnpm 10.

```bash
corepack enable
corepack pnpm install --frozen-lockfile
KASSAL_MODE=fake corepack pnpm dev
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
service, checksum-verified forward migrations, immutable commit-tagged images,
health-gated startup, and rollback to the previous local image when startup
fails. `deploy/Caddyfile.handleplan` rejects direct-origin traffic and requires
Cloudflare Access before proxying the preview.

`KASSAL_API_KEY` and the generated PostgreSQL password belong only in
`/opt/apps/handleplan/shared/production.env` on the VPS. They are not GitHub
Actions secrets and must never be committed or printed.

## Scope

Phase 1 does not claim branch inventory, branch-specific shelf prices, member prices, flyer offers, travel-time routing, Oppdag, deployment, or public-release readiness. Anonymous basket, matching preferences, and selected plan stay in local browser storage; volunteered origin is transient and is not persisted.

Required quantities are package counts (`each`) in Phase 1. Gram and millilitre needs fail closed until package-size normalization can prove how many purchasable packages are required.

## Public-release gates

Before public operation, Handleplan still needs distributed rate limiting at the shared edge/store, real migrations and live PostgreSQL coverage in CI, reconciliation against the current live Kassalapp contract, and production security/observability controls. A per-process limiter would not satisfy the distributed gate and is intentionally not presented as protection here.
