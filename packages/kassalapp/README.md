# Kassalapp adapter boundary

The adapter coordinates requests conservatively. Callers can inject a shared
`KassalappRequestCoordinator`; without one, it falls back to one Node.js process:

- all `KassalappClient` instances in the process share a rolling budget of 60
  upstream attempts per minute;
- at most 120 unique requests may wait behind that process-local budget;
  excess callers fail with the same sanitized unavailable state;
- each client admits at most 180 unique in-flight or waiting operations;
- one coalesced operation admits at most 100 waiting subscribers;
- one client instance coalesces identical requests that are already in flight;
- retryable responses are retried at most once, after `Retry-After` when it is
  no more than 30 seconds, or after a 250 ms fallback delay;
- a longer `Retry-After` is not retried early;
- cancelling one coalesced subscriber does not cancel the other subscribers,
  while cancelling the final subscriber aborts the upstream work.

The built-in fallback and in-flight coalescing are deliberately
**process-local**. The production web composition injects the shared
PostgreSQL request budget under the provider key `kassalapp`, so all web
replicas spend from one rolling 60-attempt/minute allowance. Any separately
deployed ingestion worker must inject that same provider key before it is
allowed to call the upstream API. Coalescing remains per client process, and
load-tested evidence is still required before rate-limit readiness can be
claimed.

Category and physical-store endpoints are requested at their documented
maximum page size of 100. The verified contract exposes no pagination cursor,
so a response containing exactly 100 records is reported as
`POSSIBLY_TRUNCATED`; it is never treated as complete coverage.
