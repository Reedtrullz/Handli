# Kassalapp boundary runbook

## Server-only configuration

Real mode requires `KASSAL_API_KEY`, `KASSAL_BASE_URL`, and `DATABASE_URL`. `KASSAL_API_KEY` is used only by the server-side gateway as a bearer credential. It must never appear in browser bundles, request URLs, public headers or bodies, logs, fixtures, screenshots, or committed files.

The 1Password Developer Environment is named `Clankus`. Use the variable names above through the configured environment integration; never copy or echo secret values into a shell transcript.

## Adapter behavior

- Search input is bounded and URL-encoded by the server route.
- `GET /api/discovery/search` browses up to 36 newly catalogued unique products
  using bounded store-scoped catalog requests for Bunnpris, REMA 1000, and Extra;
  the optional `q` parameter narrows this to at most 12 search matches. Both
  modes combine catalog rows with bulk prices and include only observations no
  older than 72 hours. If upstream prices fail, only still-fresh validated
  cache rows may be returned.
- Product search uses `GET /api/v1/products` with `search`, `size`, `unique=1`,
  and `exclude_without_ean=1`.
- Bulk price requests are validated and split into at most 100 EANs.
- Each attempt has an eight-second timeout.
- Only `429`, `502`, `503`, and `504` receive one retry.
- Upstream JSON is schema-validated and normalized into canonical UTC timestamps and integer øre.
- Successful responses require JSON content type, fatal UTF-8 decoding, and a 512 KiB streaming byte limit even without `Content-Length`.
- Search and bulk envelopes are capped at 100 products; each bulk product is
  capped at 100 store rows. Only `BUNNPRIS`, `REMA_1000`, and `COOP_EXTRA`
  become Phase 1 observations.
- Public errors use allow-listed codes and never include upstream URLs, headers, bodies, stack causes, or credentials.

The adapter was reconciled against Kassalapp's published OpenAPI contract and a
live, value-redacted search plus bulk-price probe on 16 July 2026. Synthetic
fixtures mirror only the fields Handleplan consumes; live values and credentials
are never committed.

## Price meaning and non-claims

Kassalapp observations are chain-level price evidence. They do not prove branch inventory or a branch-specific shelf price. Oppdag therefore labels them as current price observations, not discounts or historical price falls. Member-only prices, flyer offers, and inferred plan impact remain excluded. A plan is returned only when eligible evidence covers every required basket item, and never uses more than three chains.

Every selected assignment carries its canonical observation timestamp and Kassalapp source into the public result. The response separately identifies whether those validated observations came directly from upstream or from the fallback cache; calculation time is never labeled as observation time.
