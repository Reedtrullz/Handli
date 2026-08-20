# Norwegian grocery promotional flyer scraping research

Checked 2026-08-20 against public endpoints. Findings describe publicly observable behavior, not permission to bypass access controls or high-volume scrape.

## Summary

| Chain | Public machine-readable path | Flyer offers structured? | GTIN/EAN observed | Rotation/freshness | Practical assessment |
|---|---|---|---|---|---|
| Coop Extra | `www.coop.no/api/content/extra/tilbud`, `/api/content/extra`, `/api/content/kundeavis` | Public JSON is Contentful metadata and flyer image URLs. `/api/content/extra` points to a client-resolved WeeklyOffers block; item endpoint not identified. | No | Current asset labelled `UKE 34`; `updatedAt` 2026-08-15; feature data valid 300s. | Scrape flyer images/metadata reliably; product extraction requires OCR/manual parsing or further reverse-engineering of the client dynamic-data flow. |
| REMA 1000 | WordPress `/wp-json/` plus public Algolia search | No public offer/flyer product index found. Product-like pages expose Article metadata, text and images only. | No | WordPress `modified`/`dateModified` fields; pages can be months old. Store feed has `now` timestamp but one-year CDN max-age. | Not a dependable structured promotional-price source. Use only for discovery/store metadata unless a separately licensed feed is obtained. |
| Bunnpris | Tjek/SGN API used by store pages: `squid-api.tjek.com/v2/catalogs` and `/v4/rpc/*` | Yes: catalog/publication, leaflet sections, offer IDs, names/prices are returned through RPC. | No GTIN/EAN in HTML; product RPC should be tested for identifiers before relying on it. | Catalog includes publication date and `run_from`/`run_till`; example 2026-08-17 to 2026-08-24. Catalog responses cache ~1h with ETag. | Best candidate for automated weekly offer ingestion, subject to API terms, key stability, and validation of product identifiers. |

## Coop Extra

`GET https://www.coop.no/extra/tilbud` returned HTTP 200 HTML (~53.8 KB), Cloudflare `cf-cache-status: HIT`. The page embeds `window.INITIAL_DATA = JSON.parse(...)`. Parsing this object yielded page metadata and Contentful assets, including desktop/mobile flyer images with alt text `Extra kundeavis uke 34`; no product, offer, price, GTIN or EAN fields were present.

`GET https://www.coop.no/api/content/extra/tilbud` (and `?language=nb-NO`) returned HTTP 200 `application/json` (~3.95 KB; API version 6.9.0.0). `/api/content/kundeavis` returned ~3.17 KB. These responses are image-backed `NewsletterBlockApiModel` content, not line-item offers. `/api/content/extra` (~7.9 KB) includes a `WeeklyOffersBlockApiModel` pointer (`offersBaseUrl: /minkundeavis`, default chain ID `07`), implying dynamic client resolution via `/api/client/dynamic-data/resolve`; static payload inspection found no GTIN/EAN and no literal item API URL.

The current flyer is weekly (UKE 34), with `updatedAt` 2026-08-15T20:00:17.644Z. HTML exposes `OUTPUT_CACHE_AGE` around 436 seconds; feature data says weekly offers valid for 300 seconds. Twelve rapid API requests remained HTTP 200; no `x-ratelimit` or `retry-after` headers were observed. Cloudflare caching/stale-while-revalidate means consumers should revalidate and record fetch timestamps.

## REMA 1000

`GET https://www.rema.no/wp-json/` returned HTTP 200 and exposed namespaces `rema-recipes/v1`, `rema-stores/v1`, and `wp/v2`. Custom store routes (`/wp-json/rema-stores/v1/get-stores-data`, `/get-stores-active-address`) return store records, GLN, addresses, coordinates, opening hours and a `now` timestamp; they do not return promotional products.

WordPress search/pages can discover product-like pages, but their HTML uses Schema.org Article microdata (`name`, `headline`, `dateModified`, description, images), not Product schema. `gtin`/`ean` were absent. The WP REST page content and public Algolia index (`wp_searchable_posts`, recipes, stores) likewise contain titles/permalinks/post-modified epochs, with custom fields/EAN/GTIN null. No public offer/flyer index was found.

The client exposes an Algolia app ID/key and anonymous queries work; treat that key as public search configuration, use low request rates and caching, and do not assume it authorizes bulk extraction. Store endpoints returned 200 without rate-limit headers in five calls. CDN headers include `max-age=31536000`, so freshness must come from timestamps and periodic conditional requests.

## Bunnpris

The public site is Drupal 10/Vue rather than Umbraco. `/alle-butikker` returns a JSON store directory (~161 KB, roughly 100 stores) with IDs, addresses, coordinates and opening hours. Store pages load the Tjek/SGN SDK and embed a business identifier (`5b11sm`) and API key.

The SDK calls:

```text
GET https://squid-api.tjek.com/v2/catalogs?dealer_id=5b11sm&order_by=-publication_date&types=incito&limit=24
GET /v2/catalogs/{catalog_id}
POST /v4/rpc/generate_incito_from_publication
POST /v4/rpc/generate_incito_from_publication_section
POST /v4/rpc/get_offer_from_incito_publication_view
POST /v4/rpc/get_offer_products
```

The catalog endpoint returned HTTP 200 and a current publication (example ID `HEAqFAxC`) with `publication_date` 2026-08-18, `run_from` 2026-08-17T22:00Z, `run_till` 2026-08-24T21:59Z, and `offer_count: 3`. Generated publication/section responses expose offer IDs and structured offer names/prices. The HTML itself contains no GTIN/EAN; the final `get_offer_products` response must be inspected to determine whether identifiers are available.

Catalog responses advertise public `max-age=3600` and ETags; RPC responses did not show cache headers. Twelve rapid catalog/API requests returned 200 without obvious rate-limit headers. Respect the SDK/API terms, cache weekly publications, and monitor key or schema changes.

## Recommended ingestion boundaries

1. Treat Bunnpris Tjek catalogs as the only currently evidenced structured weekly-offer source; persist publication/run dates, raw offer payloads, and provenance, then validate prices and identifiers.
2. Treat Coop Extra as image-first. Persist Contentful URLs, alt text, update timestamps and hashes; add OCR only with confidence/review states. Continue investigating `/minkundeavis` dynamic resolution rather than assuming the static Contentful API contains products.
3. Treat REMA as unsupported for automated promotional-price ingestion from public APIs. Keep store metadata separate from offer data and avoid presenting Algolia/WP discovery records as prices.
