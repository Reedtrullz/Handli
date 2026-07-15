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
KASSAL_MODE=fake corepack pnpm dev
```

Fake mode is an explicit server-only composition. It uses fixed Bunnpris, REMA 1000, and Extra catalog/price fixtures, a fixed evaluation clock, and an in-memory cache. It performs no Kassalapp or database network request. It is not the production default and no fake-mode flag is placed in browser storage, browser bundles, requests, or responses.

The committed Playwright journey starts this mode automatically. It needs no secrets:

```bash
corepack pnpm exec playwright install chromium
corepack pnpm exec playwright test
```

## Real mode and PostgreSQL

Real mode is the default and fails closed unless all three variables are valid: `KASSAL_API_KEY`, `KASSAL_BASE_URL` (HTTPS), and `DATABASE_URL` (PostgreSQL). `KASSAL_MODE=real` may be set explicitly.

The local Compose file defines PostgreSQL 16:

```bash
docker compose up -d postgres
corepack pnpm --filter @handleplan/db db:migrate
RUN_DB_INTEGRATION=1 corepack pnpm --filter @handleplan/db test
corepack pnpm dev
```

This repository does not assume Docker Compose is installed. Without it, the pure/unit suites and fake E2E remain reproducible; live cache round trips remain unverified.

For the real environment, activate the 1Password Developer Environment named `Clankus`. The required variable names are `KASSAL_API_KEY`, `KASSAL_BASE_URL`, and `DATABASE_URL`. Do not paste, print, log, or commit their values. The application reads them only in server modules.

## Cache and freshness behavior

- Valid upstream rows are evaluated after the upstream request finishes and then written to cache best-effort.
- If upstream fails, the cache is used only when eligible rows still form a complete required-item plan.
- Observations are eligible through exactly 72 hours.
- Rows older than 72 hours through 14 days are stale-visible but ineligible for recommendations.
- Rows older than 14 days are historical. Future timestamps are invalid.
- A cache failure or incomplete/stale cache produces a sanitized unavailable state; the app never recommends a partial plan.

## Anonymous privacy

The basket, explicit match approvals, coarse travel preference, and selected plan ID are stored under `handleplan:basket:v1` in local storage. A precise origin is component-local and transient. Core use has no account or consent wall.
