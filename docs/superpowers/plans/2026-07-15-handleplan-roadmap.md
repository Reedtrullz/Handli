# Handleplan Implementation Roadmap

The approved design is intentionally split into four implementation plans. Each plan ends with independently testable working software and preserves the contracts in `docs/superpowers/specs/2026-07-15-handleplan-design.md`.

1. **Foundation and Planlegg base-price slice** — anonymous basket, matching rules, server-only Kassalapp integration, complete one-to-three-chain plans, and the approved workspace result UI. Detailed in `2026-07-15-handleplan-planlegg-foundation.md`.
2. **Travel and Handlemodus** — branch candidates, temporary origin, route-provider abstraction, Pareto travel dimension, and the offline mobile checklist.
3. **Flyer ingestion and review** — Bunnpris, REMA 1000, and Extra direct-source adapters; immutable captures; extraction; validation; geographic scope; review queue; expiry; and offer-price precedence.
4. **Oppdag and public-release hardening** — basket impact, 30-day price-drop evidence, accessibility, operations health, multi-region acceptance checks, and permission/terms gates.

The plans are executed in order. A later plan may extend an earlier interface but must not silently weaken complete-basket, freshness, privacy, provenance, or maximum-three-store invariants.

## Specification coverage

| Approved design area | Owning implementation plan |
|---|---|
| Anonymous state, matching, Kassalapp, freshness, complete basket, one-to-three-chain Pareto frontier, Planlegg and result workspace | 1. Foundation and Planlegg |
| Temporary origin, transport mode, branch candidates, round-trip route, travel-aware dominance, offline checklist | 2. Travel and Handlemodus |
| Direct retailer sources, national/regional/local scope, OCR/extraction, validation, review, expiry, member and multibuy price precedence | 3. Flyer ingestion and review |
| Basket-relevant discovery, price history, plan impact, operational health, accessibility and multi-region release evidence | 4. Oppdag and release hardening |
| Terms, redistribution, marks and imagery permissions | Release gate spanning plans 3 and 4; public launch remains blocked until recorded evidence exists |
