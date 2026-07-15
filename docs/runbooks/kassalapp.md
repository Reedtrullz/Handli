# Kassalapp boundary runbook

## Server-only configuration

Real mode requires `KASSAL_API_KEY`, `KASSAL_BASE_URL`, and `DATABASE_URL`. `KASSAL_API_KEY` is used only by the server-side gateway as a bearer credential. It must never appear in browser bundles, request URLs, public headers or bodies, logs, fixtures, screenshots, or committed files.

The 1Password Developer Environment is named `Clankus`. Use the variable names above through the configured environment integration; never copy or echo secret values into a shell transcript.

## Adapter behavior

- Search input is bounded and URL-encoded by the server route.
- Bulk price requests are validated and split into at most 100 EANs.
- Each attempt has an eight-second timeout.
- Only `429`, `502`, `503`, and `504` receive one retry.
- Upstream JSON is schema-validated and normalized into canonical UTC timestamps and integer øre.
- Successful responses require JSON content type, fatal UTF-8 decoding, and a 512 KiB streaming byte limit even without `Content-Length`.
- Search envelopes are capped at 100 products; each 100-EAN bulk envelope is capped at 300 Phase 1 chain observations.
- Public errors use allow-listed codes and never include upstream URLs, headers, bodies, stack causes, or credentials.

The current response envelopes and search path are provisional because no sanitized production Kassalapp response contract has been committed. Reconcile them with the current API documentation before enabling live/public operation.

## Price meaning and non-claims

Kassalapp observations are chain-level price evidence. They do not prove branch inventory or a branch-specific shelf price. Phase 1 excludes member-only prices and flyer offers. A plan is returned only when eligible evidence covers every required basket item, and never uses more than three chains.

Every selected assignment carries its canonical observation timestamp and Kassalapp source into the public result. The response separately identifies whether those validated observations came directly from upstream or from the fallback cache; calculation time is never labeled as observation time.
