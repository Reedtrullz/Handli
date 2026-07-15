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

## Scope

Phase 1 does not claim branch inventory, branch-specific shelf prices, member prices, flyer offers, travel-time routing, Oppdag, deployment, or public-release readiness. Anonymous basket, matching preferences, and selected plan stay in local browser storage; volunteered origin is transient and is not persisted.
