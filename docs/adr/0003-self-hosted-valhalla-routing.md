# ADR 0003: Use self-hosted Valhalla for optional travel estimates

- Status: accepted for implementation; production activation remains gated
- Date: 2026-07-16

## Context

Handleplan needs an optional, directed time-and-distance matrix for one origin
and at most nine nearby branch candidates. The same boundary must support car
and bicycle travel, preserve asymmetric journeys, and fail back to a coherent
price-only frontier. A volunteered address and its coordinates are sensitive
request data: they must not be persisted, cached, placed in URLs, or disclosed
to an avoidable third party.

The earlier source review kept the hosted openrouteservice API conditional
because account quota, provider selection, and coordinate-processing privacy
were unresolved. Valhalla is an open-source routing engine under the MIT
licence. Its matrix API supports `auto` and `bicycle` costing with distinct
source and target arrays, and it can be operated on our own server using
OpenStreetMap data:

- [Valhalla matrix API](https://valhalla.github.io/valhalla/api/matrix/api-reference/)
- [Valhalla repository and licence](https://github.com/valhalla/valhalla)
- [OpenStreetMap copyright and attribution](https://www.openstreetmap.org/copyright)

## Decision

Select a self-hosted Valhalla service for the v1 routing boundary.

- The web server calls only the compile-time internal endpoint
  `http://valhalla:8002/sources_to_targets`; no client value, environment value,
  address, or token can select an upstream host or path.
- Requests use `POST` JSON, `verbose: false`, identical bounded source/target
  arrays, and only the `auto` or `bicycle` costing selected by the user.
- The adapter permits at most ten points, applies a four-second deadline and a
  128 KiB response cap, rejects malformed or mismatched matrix rows, and never
  exposes upstream bodies.
- Valhalla is reachable only on the internal application network. The browser
  never calls it and no route-provider credential is required.
- The registry kill switch `source.valhalla-openstreetmap-self-hosted.enabled`
  maps to the exact-string server environment gate
  `HANDLEPLAN_SOURCE_VALHALLA_OPENSTREETMAP_SELF_HOSTED_ENABLED=true`. Absence,
  `false`, or any other spelling keeps both origin-token issuance and routing
  disabled.
- Only aggregate duration, aggregate distance, opaque route fingerprint, and
  the selected public branch stops leave the server. Address, coordinates,
  provider-correlated locations, and route geometry do not.
- OpenStreetMap attribution must be visible anywhere travel estimates are
  shown. A route-data revocation or stale/unhealthy tile set disables travel
  and recomputes the price-only frontier.

The public Valhalla demo service is not a production fallback. Its fair-use
service is useful for manual interoperability checks but would reintroduce a
third-party coordinate disclosure and an external availability dependency.

## Consequences and activation gates

This choice improves privacy, auditability, and public-good portability, while
making tile building, updates, capacity, and monitoring our responsibility.
Production activation therefore still requires:

1. an exact, reviewed Valhalla image/version and reproducible Norway tile build;
2. measured VPS disk, memory, startup, matrix latency, and update headroom;
3. a freshness policy and health check that fail closed on missing or stale
   routing tiles;
4. OpenStreetMap attribution in the travel UI and project notices;
5. clean-host recovery and rollback proof for the router and tile volume; and
6. browser evidence that volunteered origin data appears in no storage, URL,
   cache, application log, monitoring payload, or error response.

Until those gates pass, the adapter and deterministic fakes may be verified in
source and CI, but production travel remains disabled and no deployment may
claim actual travel time.
