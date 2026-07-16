# Source kill switch and revocation procedure

- Status: normative v1 runbook contract
- Last reviewed: 2026-07-16
- Registry: [source-registry.v1.json](./source-registry.v1.json)

## Purpose

Every external source has an independent kill-switch key in the source registry. The switch controls fetch scheduling, queued work, normalization, eligibility, cache serving, and downstream ranking as one fail-closed boundary.

This document defines required behavior. Runtime wiring is implemented in later v1 source/domain/operations batches; until that wiring exists, all sources remain disabled by default and none may be represented as activated.

## State and control contract

- `approved` is the only state eligible for activation.
- `conditional`, `blocked`, and `revoked` force the effective switch off regardless of deployment configuration.
- Missing registry entries, unreadable registry data, unknown state values, stale registry versions, and missing kill-switch configuration fail closed.
- A switch is addressed by its committed `killSwitchKey`, for example `source.kassalapp.enabled`. Secret values and credentials are never stored in the registry.
- Disabling a source requires no schema migration and must take effect before the next fetch or public response.
- Re-enabling requires a reviewed registry change and fresh source-health proof; toggling deployment configuration alone is insufficient.

The runtime source resolver must expose effective state and a non-secret reason to readiness/status tooling. Internal endpoints may include agreement references, while public status exposes only source class, coverage, freshness, and limitation copy.

## Immediate triggers

Disable first and investigate second when any of these occurs:

- provider or rights holder asks Handleplan to stop;
- agreement expires, terminates, or is disputed;
- terms change and compatibility is not yet reviewed;
- credential compromise or unexpected access pattern;
- rate-limit suspension or provider abuse notice;
- source begins returning a materially different schema or geographic scope;
- imagery, marks, membership, before-price, or validity semantics become ambiguous;
- source evidence is corrupted, fabricated, or cannot be traced;
- privacy boundary sends or persists forbidden user-origin data; or
- an operator cannot establish which agreement governs the source.

## Revocation procedure

1. **Identify.** Record source ID, detection time, reporter, affected data classes, regions, and the non-secret trigger. Do not copy credentials or confidential agreement text into logs/issues.
2. **Disable.** Set the source effective state to `revoked` and its kill switch off. Stop schedulers and reject new queue items.
3. **Drain safely.** Cancel or quarantine in-flight fetch/normalization/review work. A worker must re-check effective source state immediately before writing or publishing.
4. **Make evidence ineligible.** Invalidate active offers and ordinary-price candidates from the source. Revocation must not wait for cache expiry or `validUntil`.
5. **Purge caches.** Remove public response, CDN, application, route, and derived-ranking cache entries that depend on the source. Cache keys must retain source dependencies so this is bounded.
6. **Preserve minimal audit proof.** Keep source ID, evidence IDs/hashes, timestamps, state transitions, and operator actions only as the agreement and law allow. Never retain content merely for convenience.
7. **Apply disposition.** Follow the registry's `revocationDisposition` and governing agreement. If retention rights are unclear, quarantine raw/derived content, stop display, and escalate before deletion or reuse.
8. **Regenerate coverage.** Set affected manifest cells to `blocked` or `suspended`, clear `activeSourceId`, set `launchEligible: false`, and list the gap. Recompute region selection.
9. **Degrade product truthfully.** Recompute plans from remaining eligible evidence. Use “among verified prices” for partial comparisons. If complete plans cannot be proven, return a fail-closed result. Travel-source failure recomputes a coherent price-only frontier.
10. **Communicate.** Update the public status/limitations surface and internal incident record. Notify the provider or rights holder through the recorded contact path when appropriate.
11. **Verify.** Probe that fetches, queue writes, evidence eligibility, cached responses, and public claims no longer contain the source. Record commands, timestamps, and result identifiers.

## Data-class disposition defaults

These defaults apply only when the source agreement is silent; explicit agreement and legal requirements take precedence.

| Data class | On block/revoke | Public behavior |
|---|---|---|
| active official offer | immediately ineligible; remove from caches | disappear; never extend validity |
| ordinary-price observation | stop new writes; quarantine if retention unclear | exclude from current ranking; historical display depends on retention rights |
| normalized/derived ranking | invalidate by source dependency | recompute or fail closed |
| publication/product image | stop serving; purge cached copy if rights unclear | use no image or rights-cleared fallback |
| retailer mark | stop source-specific display if mark permission is affected | plain text only if legally reviewed |
| physical store | stop refresh; keep only if retention/right remains valid | mark directory unavailable or source-stale |
| user origin/route geometry | never persist | no retained data to purge; disable route and use price-only plan |
| audit metadata | retain minimum non-content proof if lawful | internal only |

## Restoration procedure

Restoration is a new approval, not the inverse of a toggle.

1. Resolve the trigger and obtain dated primary evidence.
2. Review access, processing, retention, derived display, redistribution, imagery, marks, attribution, rate limits, privacy, and termination.
3. Update the registry with a named reviewer and new evidence date.
4. Run contract fixtures and a bounded canary with public serving still off.
5. Rebuild only data permitted under the current agreement; do not silently revive quarantined content.
6. Run source-health, scope, freshness, cache-invalidation, and benchmark checks.
7. Promote affected manifest cells only from measured evidence.
8. Enable public consumption after review; publish updated status in the same change window.

## Required automated acceptance tests

- non-approved source cannot become effectively enabled;
- missing or malformed registry fails closed;
- worker checks state before fetch and before write;
- revoked evidence cannot win a price or offer plan;
- source-dependent caches are invalidated immediately;
- offer validity is never extended by outage;
- coverage manifest and public status lose affected scope together;
- partial comparison copy is qualified;
- route-source revocation produces price-only plans without stored origin; and
- reactivation fails without new evidence and health proof.
