# Handleplan

Handleplan is an anonymous-first Norwegian grocery planner. A shopper can discover fresh current prices, add an exact product to a shared basket, and compare complete, non-dominated plans across at most three chains: Bunnpris, REMA 1000, and Extra.

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

Oppdag searches live Kassalapp observations, compares current prices across the three supported chains, and can add an exact product to the same local basket used by Planlegg. It does not claim historical price drops, branch inventory, branch-specific shelf prices, member prices, flyer offers, travel-time routing, or plan impact. The current VPS deployment is an owner-only protected preview. Anonymous basket, matching preferences, and selected plan stay in local browser storage; volunteered origin is transient and is not persisted.

Required quantities are package counts (`each`) in Phase 1. Gram and millilitre needs fail closed until package-size normalization can prove how many purchasable packages are required.

## Public-release gates

Before public operation, Handleplan still needs distributed rate limiting at the shared edge/store, live PostgreSQL migration/cache coverage in CI, tested backups, and production monitoring/alerting. A per-process limiter would not satisfy the distributed gate and is intentionally not presented as protection here.
