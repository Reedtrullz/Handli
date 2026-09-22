# Refresh observation evidence (Task 20)

Date: 2026-09-22. Branch: `codex/prices-and-discounts`.

## Step 2: Monitor contracts (verified 2026-09-22)

```bash
corepack pnpm operations:monitor:test
corepack pnpm --filter @handleplan/worker exec vitest run src/health.test.ts
```

Results:

- `operations:monitor:test`: **11 pass / 0 fail** (119 ms).
- worker `src/health.test.ts`: **1 file / 4 tests passed** (205 ms).

## Step 1: Controlled failure matrix — EXTERNAL GATE (not performed)

The disposable-staging failure matrix (source disabled, 429, timeout, SQL failure, partial extraction, review backlog, empty source, stale data, expired offer; API/UI status and job-counter comparison per case) was **not** executed in this session. No misleading-transition repair claims are made; no runbook content was modified on that basis.

## Non-claims

- Monitor/health contract tests passing proves the projection and health-signal logic, not that a deployed stack correctly exposes a dead importer or expired public offer.
- Stale-price, overdue-capture and expiry thresholds remain as specified in the existing runbooks; live verification against a deployed environment is outstanding.
