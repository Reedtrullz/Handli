# Kassalapp boundary runbook

## Worker-only configuration

`KASSAL_API_KEY` and `KASSAL_BASE_URL` are accepted only by `apps/worker`. The public web container receives only the read-only `handleplan_web` database URL and has no Kassalapp client or upstream refresh path. The bearer credential must never appear in browser bundles, the public web environment, request URLs, public headers or bodies, logs, fixtures, screenshots, or committed files.

The 1Password Developer Environment is named `Clankus`. Use the variable names above through the configured environment integration; never copy or echo secret values into a shell transcript.

Scheduled ingestion follows the separate
[`worker.md`](./worker.md) runbook. The production worker remains conditional
by default and requires both explicit deployment opt-in and current,
scope-specific PostgreSQL governance approval before it makes an upstream
request. Possession of the API key alone never activates ingestion.

## Adapter and public-read behavior

- Product search, Oppdag, and strict planning read only persisted evidence from
  approved sources. A public request never triggers an upstream request or a
  database write.
- `GET /api/discovery/search` browses at most 36 canonical products; `q`
  narrows the persisted catalog to at most 20 matches. Canonical aliases are
  deduplicated for cards while an exact valid GTIN remains searchable.
- Ordinary price evidence is at most 72 hours old. If a mature independent
  historical proof would exceed the 128 KiB response boundary, the complete
  historical claim and its source set are omitted while ordinary-price
  browsing remains available.
- Worker catalog lookups use `GET /api/v1/products` with `search`, `size`, `unique=1`,
  and `exclude_without_ean=1`.
- Scheduled catalog discovery uses one bounded `GET /api/v1/products` page with
  `page`, `size=100`, `sort=date_desc`, `unique=1`, and
  `exclude_without_ean=1`. The worker receives source-normalized accepted,
  unknown, or quarantined records rather than the public `Product` DTO; see the
  worker runbook for the bounded page rotation and correction review policy.
- Bulk price requests are validated and split into at most 100 EANs.
- Each attempt has an eight-second timeout.
- Only `429`, `502`, `503`, and `504` receive one retry.
- Upstream JSON is schema-validated and normalized into canonical UTC timestamps and integer øre.
- Successful responses require JSON content type, fatal UTF-8 decoding, and a 512 KiB streaming byte limit even without `Content-Length`.
- Search and bulk envelopes are capped at 100 products; each bulk product is
  capped at 100 store rows. Only `BUNNPRIS`, `REMA_1000`, and `COOP_EXTRA`
  become Phase 1 observations.
- Public errors use allow-listed codes and never include upstream URLs, headers, bodies, stack causes, or credentials.

The adapter was reconciled against Kassalapp's published OpenAPI contract.
Synthetic fixtures mirror only the fields Handleplan consumes; live values and
credentials are never committed. No credentialed live probe is recorded as
release evidence yet; when one is run, store only dated, value-redacted contract
results under `docs/evidence/v1`.

## Price meaning and non-claims

Kassalapp observations are chain-level price evidence. They do not prove branch inventory or a branch-specific shelf price. Oppdag keeps current ordinary price, independently derived 30-day historical comparison, and official offer in separate fields and visual states. A previous observation is never presented as an official before-price. Member-only prices and inferred plan impact remain excluded from planning. A plan is returned only when eligible evidence covers every required basket item, and never uses more than three chains.

Every selected assignment carries its canonical observation timestamp and public source descriptor into the result. Versioned public responses always identify their read model as `cache`; calculation time is never labelled as observation time, and public requests never refresh evidence.
