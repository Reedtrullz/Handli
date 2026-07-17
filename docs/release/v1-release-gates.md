# Handleplan v1 evidence-linked release gates

**Decision:** public launch is blocked until every gate below is `passed`

**Last assessed:** 2026-07-17

**Audited implementation baseline:** `a890b05fa07e5fa2fc806b0640a62cf37f8b234e`

This is not a checkbox list. A gate changes state only when the linked, reproducible evidence satisfies its acceptance rule. Missing proof is a failed release condition, even when the feature appears to work manually.

Status meanings:

- `passed`: required evidence exists, is current for the candidate release, and has been reviewed;
- `partial`: useful implementation or evidence exists, but the acceptance rule is not met;
- `blocked`: a known external or correctness condition prevents acceptance; and
- `not-started`: no release-grade proof exists yet.

## Current gate ledger

| Gate | Status | Current evidence | Proof still required for `passed` |
|---|---|---|---|
| G1 Source rights | blocked | [source registry](../data/source-registry.md), [machine-readable registry](../data/source-registry.v1.json) | Recorded permission for every active ordinary-price and official-offer claim, including processing, retention, derived display, redistribution, imagery/marks, attribution, rate limits, expiry, owner, and review date. Kassalapp and prospective offer sources remain conditional or blocked. |
| G2 Declared coverage | partial | [launch manifest](../data/launch-coverage.v1.json), [launch-scope ADR](../adr/0002-launch-scope-policy.md) | A public status page and candidate-release manifest must match successful current production runs for every declared chain and region. No candidate region is launch-eligible today. |
| G3 Data truth | partial | [product-truth contract](../contracts/v1-product-truth.md), [official/history ADR](../adr/0001-official-offer-vs-historical-price.md), [foundation verification](../evidence/v1/foundation-2026-07-16.md), and [evidence/planner/worker milestone](../evidence/v1/evidence-planner-worker-2026-07-16.md) | Candidate-release proof using rights-cleared production runs; reviewed flexible matching and the official-offer vertical are not complete. |
| G4 Planner correctness | partial | Whole-package/domain/frontier suites and the [evidence/planner/worker milestone](../evidence/v1/evidence-planner-worker-2026-07-16.md) | Independent-oracle and regional corpus proof for reviewed flexible matching, multibuy, maximum three stores, deterministic travel-aware non-dominated frontier, endpoints, and partial coverage. |
| G5 Three-chain evidence | blocked | The manifest declares Bunnpris, REMA 1000, and Extra as the intended v1 chains | Current successful rights-cleared ingestion and eligible evidence for all three chains in every declared launch region. |
| G6 Travel privacy | not-started | Privacy rules in the [product-truth contract](../contracts/v1-product-truth.md) | Opt-in route flow plus automated sentinel tests proving origin/address/coordinates are absent from storage, URLs, caches, responses, evidence, and application telemetry. |
| G7 Offline shopping | partial | Immutable IndexedDB trip snapshot, API-cache exclusion tests, and the [production-build offline Chromium journey](../evidence/v1/evidence-planner-worker-2026-07-16.md) | Production PWA trip completed offline on iOS and Android physical devices, including install, reload, checklist progress, eviction/staleness behavior, and accessible touch use. |
| G8 Accessibility | partial | Phase 1 responsive/browser evidence under `docs/evidence/phase1/` and the [local V1-18 automated accessibility delta](../evidence/v1/v1-18-accessibility-automated-2026-07-17.md) | Candidate-release Chromium/Firefox/WebKit execution, native-zoom evidence, plus accepted VoiceOver, keyboard-only, and mobile-device reports. |
| G9 Security, privacy, and legal | partial | Protected Cloudflare Access preview, server-only credential boundary, source registry, [Norwegian privacy notice](../privacy/personvern.md), [data-flow/threat model](../security/data-flow-threat-model.md), [security policy](../../SECURITY.md), code license/third-party boundary, tested response-header baseline, allowlist-only readiness telemetry with application sentinel tests, and [repository dependency/license/secret gates](../security/supply-chain.md) | Accepted operator/data-controller and processor facts, legal/privacy/security review, actual edge/VPS/provider/monitoring logging and retention evidence, rights/marks/imagery review, distributed abuse controls, route-origin and all-boundary telemetry sentinel proof, container/history scans, and tested confidential privacy/security contacts. |
| G10 Operations | partial | Forward migrations, fenced worker/health deployment, safe-degraded rollback assets, the [fresh 162-test PostgreSQL milestone](../evidence/v1/evidence-planner-worker-2026-07-16.md), the [001-to-008 foundation proof](../evidence/v1/foundation-2026-07-16.md), CI source steps for SPDX plus an unsigned image build statement, and the explicitly blocked [candidate-manifest contract](../runbooks/release-candidate-manifest.md) | Candidate-current CI and VPS proof, encrypted off-host backup and isolated clean-host recovery including private blobs, external alerts, retained signed provenance/SBOM, immutable promoted image, container scan, and bad-image/post-start rollback drills. |
| G11 Real baskets | partial | [versioned benchmark baskets](../data/benchmark-baskets.v1.json) | Every declared region passes the complete corpus; at least five baskets per region are manually reconciled to rights-cleared source, conditions, validity, and geography. |
| G12 Public-good governance | partial | [`AGPL-3.0-or-later`](../../LICENSE) with [third-party exclusions](../../LICENSES/README.md), [public-good governance](../governance/public-good-governance.md), [contributor process](../../CONTRIBUTING.md), product-truth contract, and public `/om` correction/ranking disclosure | Truthful current funding/conflict ledger and owner, named maintainer/correction/appeal roles, operator/data-controller identity, confidential contacts, contributor/legal compatibility review, and accepted candidate-release replay evidence. |

## Evidence acceptance rule

Evidence for a candidate release must be stored without overwriting older runs and identify:

1. candidate commit and immutable image digest;
2. migration checksums and database starting state;
3. source-registry and launch-manifest versions;
4. exact command or manual protocol, environment, and result;
5. skips, degradations, and negative assertions;
6. reviewer and review time for manual, legal, rights, and device evidence; and
7. links to raw reports, logs with sensitive data removed, screenshots, or restore artifacts.

The candidate release manifest must satisfy the strict
[v1 schema](./v1-candidate-manifest.schema.json) and the semantic verifier
documented in the [candidate-manifest runbook](../runbooks/release-candidate-manifest.md).
It links checksummed repository evidence under `docs/evidence/v1/<candidate>/`.
Chat summaries, an owner-accessible preview, or an unversioned dashboard are
not sufficient evidence. The current
[source-neutral draft](../evidence/v1/v1-17-source-neutral-draft-2026-07-17/release-candidate.v1.json)
is explicitly blocked and is neither a release nor deployment evidence.
The verifier intentionally rejects every promotion candidate today. Its current
contract is a fail-closed draft ledger, not a release authorization mechanism;
the remaining evidence-architecture work is recorded in the runbook.

## Launch decision and emergency behaviour

Public launch requires all twelve gates to be `passed` for the same release candidate. Until then, Cloudflare Access remains in front of the preview and public wording remains protected-alpha wording.

After launch, a revoked/expired source, stale required evidence, regional mismatch, or failed safety gate must remove or qualify the affected claim immediately. The [source kill switch](../data/source-kill-switch.md) is preferred over preserving a misleading recommendation. A smaller honest scope is an acceptable degraded state.
