# Open Prices as a Norwegian gap-filling source

Research date: 2026-08-20. Production API: https://prices.openfoodfacts.org.

## Bottom line

Open Prices is technically usable as an optional, crowdsourced source for Norwegian observations, including Bunnpris, Rema 1000 and Coop Extra. It is not a complete everyday-price feed: coverage is concentrated in a small number of contributor-recorded stores, many products/stores have few observations, and the API is capped at page 500. Use it as supplementary evidence with explicit observation dates, not as a nationwide price catalogue or guaranteed-current source.

## API and query contract

- Swagger UI: GET https://prices.openfoodfacts.org/api/docs
- OpenAPI YAML: GET https://prices.openfoodfacts.org/api/schema
- Status: GET /api/v1/status -> {"status":"running"}
- Main read endpoints: /api/v1/prices, /products, /locations, /locations/nearby, /stats, /proofs.
- Price list envelope: {items, page, pages, size, total}. Default size=10, maximum size=100; requests beyond page 500 are rejected. Full exports: /data/prices.jsonl.gz, /data/locations.jsonl.gz, /data/proofs.jsonl.gz, and the Open Food Facts Hugging Face dataset.
- Useful price filters: product_code, product_code__in, currency, location_id, location_id__in, location_osm_id, location_osm_type, location__osm_name__contains, created__gte/lte, price__gte/lte, order_by, and date filters such as date__gte=2026-07-21. Multiple codes/IDs are comma-separated.
- Location filters: osm_address_country__like, osm_address_city__like, osm_name__like; nearby lookup accepts latitude/longitude/radius. Norway is stored as Norge, not Norway.
- Product lookup: GET /api/v1/products?code=... is reliable. The documented /api/v1/products/code/{code} route returned no useful result in probing.

Reads worked without authentication. Authentication is bearer-token based (POST /api/v1/auth, then Authorization: Bearer ... ) for account/write operations; production and pre-production tokens are separate. No numeric rate limit or DRF throttle setting was found, so use low concurrency, caching and polite polling.

## Norwegian coverage and chains

GET /api/v1/locations?osm_address_country__like=Norge&size=100 returned 97 locations. Location records include internal id, OSM identifiers/name/display name, city/country, osm_brand, coordinates, and price_count.

Examples:

- Rema 1000: Hallset (Trondheim, id 2728, 124 prices), Prinsens gate (Trondheim, id 3583, 11), Marken (Bergen, id 357, 591), Danmarksplass (Bergen, id 497, 1,480), plus others.
- Bunnpris: Prinsen (Trondheim, id 2729, 38), Damsgård (Bergen, id 619, 1,480), Steinsviken (id 4006, 5), Kronstad (id 6255, 11), Torggaten (id 6543, 17).
- Coop Extra: Extra Leuthenhaven (Trondheim, id 3568, 29), Extra Danmarksplass (Bergen, id 341, 5,544), Extra Nesttun (id 3148, 4), Extra Ila (id 3663, 9), Extra Kalfarveien (id 4210, 10), Extra Søreide (id 4418, 50), Extra Storsvingen (id 5454, 41), and others.

These are OSM-derived store IDs, not a canonical chain registry. Match on osm_brand/osm_name and retain OSM IDs; names and brand tagging can be inconsistent.

## Price model and examples

Each price contains product_code (GTIN/barcode), price, currency, date, discount fields, optional unit price/quantity, location OSM ID/type, owner/source/tags, timestamps and proof ID. Expanded records embed product, location and proof objects. Product fields include name, brands, quantity, OFF source and quality/count metadata; location includes chain/store name and country; proof includes receipt/price-tag date and provenance.

Example: GET /api/v1/prices?location_id=2728&currency=NOK&size=5 returned Rema 1000 Hallset observations including TINE whole milk GTIN 7038010052422 at NOK 40.90 on 2025-04-15.

Requested GTIN probes 7038013063967, 7035008931367, and 7048701010894 returned total: 0, items: []. The nearby TINE GTIN 7038010052422 resolved to “Helmelk 3,5%”, brand TINE, with 9 NOK observations from 2024-05-02 through 2025-07-07 (37.50, 40.90, 40.90, 41.50, 44.00, etc.).

## Freshness and volume

GET /api/v1/prices?currency=NOK&date__gte=2026-07-21&size=1 returned 1,801 observations, newest sample dated 2026-07-21. Recent (last-30-day) data exists, but this aggregate does not imply a recent observation for every chain/product. The all-NOK query returned 19,840 records; unrestricted prices reported 295,992 globally at probe time.

## Licensing and operational caveats

The project is AGPL-3.0 software and publishes data under the Open Database License (ODbL). Reusers must provide attribution, comply with share-alike/database obligations, and avoid combining it with non-free data in a way that prevents open redistribution. Retailer scraping is explicitly discouraged; this is crowdsourced receipt/price-tag data.

## Handleplan recommendation

Integrate behind a feature flag as a gap filler: ingest JSONL/Hugging Face for complete backfills, use API filters for incremental updates, map OSM IDs to normalized chains, and expose observed_at, proof/source and freshness to users. Do not present Open Prices as exhaustive Norwegian coverage or a substitute for direct retailer feeds.
