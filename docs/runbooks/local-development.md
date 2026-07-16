# Local development runbook

## Toolchain

- Node.js `22`
- Corepack pnpm `10` (the repository pins `10.34.5`)
- PostgreSQL `16` only when exercising the real cache or opt-in integration tests

Install from the repository root:

```bash
corepack enable
corepack pnpm install --frozen-lockfile
```

## Deterministic fake mode

```bash
HANDLEPLAN_MODE=fake corepack pnpm dev
```

Fake mode is an explicit server-only composition. It uses fixed Bunnpris, REMA 1000, and Extra catalog/evidence fixtures and a fixed evaluation clock. It performs no Kassalapp or database network request. It is not the production default and no fake-mode flag is placed in browser storage, browser bundles, requests, or responses.

The committed Playwright journey starts this mode automatically. It needs no secrets:

```bash
corepack pnpm exec playwright install chromium
corepack pnpm exec playwright test
```

## Real mode and PostgreSQL

Real web mode is the default and requires only `DATABASE_URL` for the read-only `handleplan_web` role. The public web process never receives Kassalapp credentials; scheduled ingestion is owned by `apps/worker`.

The local Compose file defines PostgreSQL 16:

```bash
docker compose up -d postgres
corepack pnpm --filter @handleplan/db db:migrate
RUN_DB_INTEGRATION=1 corepack pnpm --filter @handleplan/db test
corepack pnpm dev
```

This repository does not assume Docker Compose is installed. Without it, the pure/unit suites and fake E2E remain reproducible; live cache round trips remain unverified.

For the real environment, activate the 1Password Developer Environment named `Clankus`. `DATABASE_URL` is consumed by the public web process, while `KASSAL_API_KEY` and `KASSAL_BASE_URL` are consumed only by the scheduled worker. Do not paste, print, log, or commit their values.

## Persisted evidence and freshness behavior

- Public web requests never fetch or persist upstream rows.
- The worker writes append-only evidence; readers admit only completed ingestion runs from currently approved sources.
- Observations are eligible through exactly 72 hours.
- Rows older than 72 hours through 14 days are stale-visible but ineligible for recommendations.
- Rows older than 14 days are historical. Future timestamps are invalid.
- Incomplete coverage stays explicit; the app never recommends a partial basket.

## Anonymous privacy

The basket and normalized convenience preference are stored locally in the browser. An active Handlemodus trip is an immutable IndexedDB snapshot; only checklist completion mutates. No origin/address/coordinates are stored. Core use has no account or consent wall.

## Quantity semantics

Strict public plan requests accept package counts, grams, and millilitres for exact products. The server rehydrates package measures from its approved catalog, buys whole packages, and exposes package count and surplus; browser-supplied product metadata cannot change fulfilment.

## Public-release gates

- Distributed rate limiting shared across every application instance and region.
- Live PostgreSQL migration/cache coverage in CI and tested backup restoration.
- Audit/alerting, metrics, error budgets, and operational observability.
