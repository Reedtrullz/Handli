# Travel scope and location privacy evidence (Task 19)

Date: 2026-09-22. Branch: `codex/prices-and-discounts`.

## Step 1: Current travel tests (verified 2026-09-22)

```bash
corepack pnpm --filter web exec vitest run lib/server/travel/kartverket-geocoder.test.ts lib/server/travel/valhalla-route-matrix-gateway.test.ts lib/server/travel/travel-plan-service.production.test.ts
```

Result: **3 files / 17 tests passed** (651 ms).

## Steps 2-3: Live consented route and privacy copy reconciliation — EXTERNAL GATE (not performed)

No live Valhalla route request, sentinel-based log inspection, or staged privacy-log review was performed in this session. Until that live check passes, no route-aware savings or travel-time claim is enabled for release, and `docs/privacy/personvern.md` is intentionally left unmodified — changing the privacy record without live evidence would fabricate retention/log facts. Any enabled-travel release claim requires: a measured live route on the self-hosted Valhalla endpoint, unavailable-routing fallback proof, budgeted latency, and sentinel log verification proving no persistent addresses or tokens in URL/cache/analytics.

If the live check cannot be completed before release, travel stays clearly disabled and no savings-after-travel-cost claim is advertised — that scope decision belongs to the reviewer, not this session.

## Non-claims

- No live route, telemetry, or production-log evidence is claimed.
- Unit/production-contract test passes do not prove live route applicability or privacy behavior.
