# Handleplan v1 evidence-linked release gates

**Decision:** public launch is blocked until every gate below is `passed`

**Last assessed:** 2026-07-18

**Audited implementation baseline:** `29fb91a6ae3e7a9ed79243f6b70007a0d0ce434c`

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
| G2 Declared coverage | partial | [launch manifest](../data/launch-coverage.v1.json), [launch-scope ADR](../adr/0002-launch-scope-policy.md), public `/status`, and the [cross-browser-remediated implementation verification](../evidence/v1/v1-source-neutral-cross-browser-remediation-2026-07-17/verification.md) | The public status projection and a candidate-release manifest must match successful current production runs for every declared chain and region. No candidate region is launch-eligible today. |
| G3 Data truth | partial | [product-truth contract](../contracts/v1-product-truth.md), [official/history ADR](../adr/0001-official-offer-vs-historical-price.md), reviewed-family and official-offer publication boundaries, and the [cross-browser-remediated implementation verification](../evidence/v1/v1-source-neutral-cross-browser-remediation-2026-07-17/verification.md) | Candidate-current proof from rights-cleared production captures and runs. The exact/OCR review and publication vertical is implemented but not activated against a permitted live source. |
| G4 Planner correctness | partial | Complete-basket planner/domain suites, a separately implemented offer-aware V2 oracle with exact membership-program isolation, and the [cross-browser-remediated implementation verification](../evidence/v1/v1-source-neutral-cross-browser-remediation-2026-07-17/verification.md) | Every supported region must pass the real rights-cleared 60-run corpus and manual reconciliation. The current source-neutral corpus intentionally remains 0 passed and 60 pending. |
| G5 Three-chain evidence | blocked | The manifest declares Bunnpris, REMA 1000, and Extra as the intended v1 chains | Current successful rights-cleared ingestion and eligible evidence for all three chains in every declared launch region. |
| G6 Travel privacy | partial | Opt-in ephemeral address/current-location tokens, self-hosted Valhalla boundary, storage/URL/cache sentinel checks, and the [cross-browser-remediated implementation verification](../evidence/v1/v1-source-neutral-cross-browser-remediation-2026-07-17/verification.md) | Accepted Kartverket URL/retention and edge/application log policy, live Valhalla route/log proof, infrastructure telemetry sentinel evidence, and device/browser review. |
| G7 Offline shopping | partial | Immutable IndexedDB trip snapshot, API-cache exclusion tests, and the [production-build three-engine application-origin-outage journeys](../evidence/v1/v1-source-neutral-cross-browser-remediation-2026-07-17/verification.md) | Production PWA trip completed offline on iOS and Android physical devices, including install, reload, checklist progress, eviction/staleness behavior, and accessible touch use. |
| G8 Accessibility | partial | Phase 1 evidence, the [local V1-18 automated delta](../evidence/v1/v1-18-accessibility-automated-2026-07-17.md), and local Chromium/Firefox/WebKit reflow/axe journeys in the [cross-browser-remediated implementation verification](../evidence/v1/v1-source-neutral-cross-browser-remediation-2026-07-17/verification.md) | Exact-candidate Chromium/Firefox/WebKit CI execution, native-zoom evidence, plus accepted VoiceOver, keyboard-only, and mobile-device reports. |
| G9 Security, privacy, and legal | partial | Protected Cloudflare Access preview, server-only credential boundary, source registry, [Norwegian privacy notice](../privacy/personvern.md), [data-flow/threat model](../security/data-flow-threat-model.md), [security policy](../../SECURITY.md), code license/third-party boundary, tested response-header baseline, allowlist-only readiness telemetry with application sentinel tests, and [repository dependency/license/secret gates](../security/supply-chain.md) | Accepted operator/data-controller and processor facts, legal/privacy/security review, actual edge/VPS/provider/monitoring logging and retention evidence, rights/marks/imagery review, distributed abuse controls, route-origin and all-boundary telemetry sentinel proof, container/history scans, and tested confidential privacy/security contacts. |
| G10 Operations | partial | The [cross-browser-remediated implementation verification](../evidence/v1/v1-source-neutral-cross-browser-remediation-2026-07-17/verification.md) covers forward migrations through 026, the read-only operations role, least-privilege private runtimes, image handoff, rollback, inert backup/restore tooling, and monitor contracts at its historical baseline. The implementation branch adds migration 027 with DB-owned publication-health facts and migration 028 with the image-only review-evidence boundary, but those additions remain unverified until a new exact-source candidate is retained. | Candidate-current Linux CI and VPS proof, encrypted off-host provider activation and authenticated manifest origin, provisioned backup grants/blob view, supervised clean-host restore with private blobs and RPO/RTO, a separately provisioned and composed production alert scheduler/delivery identity, signed OCI promotion, container scan, and live rollback drills. |
| G11 Real baskets | partial | [versioned benchmark baskets](../data/benchmark-baskets.v1.json), executable V2 protocol/oracle schemas, and 25/25 acceptance-foundation tests | Every declared region passes the real rights-cleared 60-run corpus; at least five baskets per region are manually reconciled to source, conditions, validity, offers, membership program, and geography. |
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
[cross-browser-remediated source-neutral implementation draft](../evidence/v1/v1-source-neutral-cross-browser-remediation-2026-07-17/release-candidate.v1.json)
is explicitly blocked and is neither a release nor deployment evidence.
The verifier can authorize a structurally complete promotion only when the
protected release Environment supplies an independent Ed25519 trust policy and
the evidence commit contains a current signed receipt bound to the exact
manifest, OCI image, approved signers, and G1-G12 claims. The current draft has
no such receipt and remains blocked; verifier capability is not release
evidence.

## Launch decision and emergency behaviour

Public launch requires all twelve gates to be `passed` for the same release candidate. Until then, Cloudflare Access remains in front of the preview and public wording remains protected-alpha wording.

After launch, a revoked/expired source, stale required evidence, regional mismatch, or failed safety gate must remove or qualify the affected claim immediately. The [source kill switch](../data/source-kill-switch.md) is preferred over preserving a misleading recommendation. A smaller honest scope is an acceptable degraded state.
