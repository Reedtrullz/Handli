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
- Public errors use allow-listed codes and never include upstream URLs, headers, bodies, stack causes, or credentials.

The current response envelopes and search path are provisional because no sanitized production Kassalapp response contract has been committed. Reconcile them with the current API documentation before enabling live/public operation.

## Price meaning and non-claims

Kassalapp observations are chain-level price evidence. They do not prove branch inventory or a branch-specific shelf price. Phase 1 excludes member-only prices and flyer offers. A plan is returned only when eligible evidence covers every required basket item, and never uses more than three chains.
