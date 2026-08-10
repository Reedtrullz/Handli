# V1 real-basket acceptance runner

The V1 acceptance runner checks the 20 benchmark baskets in each of the three candidate regions: 60 runs in total. It is source-neutral. It does not fetch prices, approve a provider, or turn missing rights and measurement into evidence.

The checked-in corpus deliberately remains truthful: all 60 runs are `pending_rights_and_measurement`, and the launch-coverage manifest has no eligible live grocery-price source. Running the checker without candidate evidence returns a machine-readable `blocked` report with 60 explicit pending results and exit code `2`.

Protocol V2 removes the old architectural dead end. A fully supplied candidate can now pass when a separate runner artifact binds a runner-owned bounded V2 snapshot, an independent V2 enumeration result, provenance, offer handling, request/result identity, and measured timing. The synthetic contract fixtures prove that this acceptance path is executable; they are not live-source evidence and do not change launch coverage. The repository corpus still cannot pass until the external rights, catalog-identity, regional-coverage, history, variable-weight measurement, and reconciliation work is complete.

## Contracts

- [`benchmark-baskets.v1.schema.json`](./benchmark-baskets.v1.schema.json) defines the 20 source-neutral basket scenarios and 60 regional runs.
- [`benchmark-basket-candidate.v1.schema.json`](./benchmark-basket-candidate.v1.schema.json) defines candidate execution and evidence.
- [`benchmark-basket-protocol.v1.schema.json`](./benchmark-basket-protocol.v1.schema.json) defines the nested executable protocol.
- [`benchmark-basket-runner-attestation.v2.schema.json`](./benchmark-basket-runner-attestation.v2.schema.json) defines the separate runner snapshot, oracle result, timing, and bindings.
- [`benchmark-basket-report.v1.schema.json`](./benchmark-basket-report.v1.schema.json) defines the acceptance report.
- [`source-registry.v1.json`](./source-registry.v1.json) and [`launch-coverage.v1.json`](./launch-coverage.v1.json) remain authoritative for source rights and eligible regional coverage.

The filenames retain `v1` where they are part of the product V1 release gate. The current candidate, protocol, and report contract version is `2.0.0`; the runner-attestation contract is also `2.0.0`. Unknown versions and properties are rejected.

The candidate contract intentionally has no address, origin, coordinate, request-header, credential, or free-form-note field. It carries bounded identifiers, source-record digests, evidence facts, oracle operands/results, and acceptance state only.

## Basket identity and quantity semantics

Every basket need declares exactly one identity mode:

- `exact-product` binds a `canonicalProductId`. Only a reviewed match for that exact ID is eligible. Exact-product scenarios must execute an `exact-product-mismatch` negative control.
- `reviewed-family` binds a `familyId`. Candidate products still require reviewed match evidence and explicit constraint handling; a family label is never permission for silent substitution.

Requested units are `g`, `ml`, `piece`, or `package`. For base units, package count is ceiling division and purchased base units must cover the request. For `package`, the requested value is already the package count, `packageBaseUnits` is the package measurement fact, `purchasedBaseUnits` equals the package count, and surplus is zero. This keeps “buy two packages of this exact product” distinct from “buy enough grams or millilitres.”

The representative exact/package cases in the corpus use synthetic benchmark product IDs. A live candidate must replace that modeling proof with rights-cleared catalog identity evidence; the IDs in the corpus are not a claim that any provider currently exposes those products.

## Evidence foundation

An evaluated run can pass only when all of the following bind to the same candidate and governance inputs:

1. The candidate carries the canonical JSON digests of the exact corpus, source registry, and launch-coverage manifest.
2. The corpus run is `measured` or `accepted`; pending, failed, and suspended corpus rows cannot be upgraded by a candidate assertion.
3. The candidate contains exactly the canonical 60 run IDs.
4. Every basket need is assigned exactly once, with no extra need.
5. Package, purchased-unit, ordinary price, offer bundle/remainder, deposit, ordinary checkout, discounted checkout, and total arithmetic use positive safe integers and the need's declared unit.
6. Every used store is declared once, belongs to the run region, is actually used, and the plan uses at most three stores.
7. Each store binds a current physical-store observation from a fully rights-resolved, approved, enabled, public-ranking-eligible source.
8. Each assignment binds one deterministic ordinary-price record, an explicit nullable applied-offer record, both ordinary and actual checkout totals, and one deterministic reviewed product-match record. A membership-required offer must carry exactly one `membershipProgramId`, and that exact program must occur in the request's canonical `enabledMembershipProgramIds`; enabling another retailer program is not authorization. A non-null offer must also be current, same-product, quantity-eligible, and strictly cheaper after bundle/remainder arithmetic. Exact-product matches must use the required product ID. Unreferenced evidence is rejected.
9. Price sources and launch cells must support the required price class, be rights-cleared and measured, be active for the exact region/chain/class cell, and be enabled for the execution.
10. Price observations must be current for the launch cell, valid at evaluation time, and match chain, product, package measure, and unit.
11. Geographic scope is explicit: national covers Norway, regional must match the candidate region, and store scope must match the selected store.
12. The exact six chain/price-class cells are reproduced for the region. Complete coverage requires `declared-complete-coverage`; unresolved cells require `among-verified-prices`.
13. Candidate, plan, store, price, match, reconciliation, protocol, runner-attestation, replay, and report identities are digest-bound.
14. At least five passing baskets per region have manual reconciliations that bind all selected stores and assignment prices, with ordering `evidence/run <= review <= measurement <= report`.

Qualified partial comparisons may pass individual foundation checks when the evidence is eligible and the scope says `among-verified-prices`. They cannot pass the three-chain launch gate: any ineligible one of the 18 exact region/chain/price-class cells adds `launch-coverage-incomplete`.

## Executable protocol V2

An evaluated run may omit `protocol` and remain schema-valid, but it is blocked with `protocol-evidence-missing`. A supplied protocol is scenario-digest-bound and contains bounded, executable evidence:

- `quantityCases` bind every need. The runner derives all eligible ordinary-price/reviewed-match pairs for the selected store and rejects omitted or invented options. It recomputes package count, purchased and surplus units, merchandise, deposit, checkout, and reduced exact unit rate. Each need is capped at 12 options; overflow blocks instead of truncating.
- `pricingCases` bind ordinary, optional official-offer, optional historical evidence, and a sorted, unique `enabledMembershipProgramIds` set. The checker recomputes time, minimum-quantity, bundle/remainder, exact-program authorization, deposit, official savings, and historical context. The member fixture proves program A both off and on while program A is enabled and a cheaper program-B offer remains ineligible. Historical observations never become an offer or ranking price.
- `matchCases` bind reviewed attributes, scenario constraints, and the user's decision. Missing constraints reject, an unreviewed otherwise-eligible candidate requires review, and only an approved eligible candidate can be selected.
- `negativeControls` execute stale price, wrong region, disabled source, qualified partial coverage, and source-backed known-not-carried mutations for every run. Offer-expiry scenarios add expired offer. Exact-product scenarios add exact-product mismatch. Controls bind a valid baseline first and mutate only the named input; a submitted reason string is not proof.
- `frontier` carries one to seven complete evidence-backed plans and explicit convenience and savings endpoints. Every assignment carries `priceEvidenceId`, nullable `appliedOfferEvidenceId`, `ordinaryCostOre`, and actual `costOre`. Candidate-side validation independently recomputes ordinary, bundle/remainder, member eligibility, deposit, and discounted totals; exhaustive acceptance comes from the separate bounded oracle result.
- `replay` binds governance, scenario, V2 oracle request, candidate plan, frontier, request/result digests, and candidate-side samples. Its timestamps remain candidate evidence; they do not replace runner timing.

Every `acceptanceFocus` maps to derived runner features. Unknown focuses fail validation so the corpus cannot silently add an unimplemented expectation. There are no candidate-supplied `passed` booleans.

## Separate runner evidence and independent oracle

`createRunnerAttestationV2` constructs a bounded snapshot from eligible evidence for the exact run:

- one to three physical stores;
- one to twelve needs;
- one to twelve eligible product/price options per need;
- at most four official offers per option;
- explicit package units, deposits, evaluation time, and a sorted, unique set of enabled membership program IDs.

The independent oracle in [`v1-basket-oracle-v2.mjs`](../../tests/acceptance/v1-basket-oracle-v2.mjs) owns its enumeration and integer arithmetic. It considers every non-empty subset of up to three stores, chooses the deterministic cheapest eligible option for each need, rejects an infeasible subset, deduplicates plans, derives the non-dominated frontier, and independently selects convenience and savings endpoints. The feasible set is bounded to seven plans. For every option it recomputes package count, ordinary merchandise, per-package deposit, offer validity, minimum packages, exact membership-program inclusion, bundle count, ordinary-price remainder, applied offer ID, ordinary checkout, and discounted checkout. The result separately lists feasible and frontier signatures whose arithmetic was actually changed by an eligible offer; merely carrying offer evidence does not prove `offer-aware-plan`.

The separate runner document binds, per run:

- the snapshot and its digest;
- the independent oracle result and result digest;
- a request digest covering governance, candidate, implementation, and snapshot;
- monotonic duration samples, recomputed p95, and a timing digest;
- a provenance digest over the exact store, price, offer, and reviewed-match records used by the snapshot;
- an offer-aware digest over evaluation time, the canonical membership-program set, and all eligible offers including their conditional program IDs.

The top-level artifact binds all 60 run IDs, governance digests, the full candidate-document digest, attestation time, runner implementation ID, and SHA-256 of the independent oracle source. Verification rebuilds every snapshot and digest, reruns the oracle, compares the candidate frontier and both endpoints, recomputes timing arithmetic, and performs fresh timing samples. The price-only p95 budget is 2,500 ms.

This artifact is a separate deterministic runner attestation, not a claim of a remote cryptographic signature. It prevents a candidate-authored protocol from self-certifying enumeration and timing and prevents transplanting an attestation between candidates. Its provenance binding proves exactly which supplied records were evaluated; source governance, rights clearance, measured regional completeness, and manual reconciliation remain independent gates.

An executable candidate without the separate artifact is blocked with `protocol-runner-attestation-missing`. A malformed, stale, transplanted, incomplete, or digest-mismatched artifact fails closed. The deterministic synthetic positive fixture passes all 60 runs only because it supplies all contracts and runner evidence, including a real discounted frontier, program-A-authorized offer, explicitly rejected program-B offer, multibuy remainder, and deposit arithmetic. Mutations that tamper with or omit the applied-offer binding, omit the required program, enable the wrong program, or submit a noncanonical program set fail. The repository's pending corpus and launch manifest remain unchanged.

## Deterministic identity

Digests use UTF-8 SHA-256 over canonical JSON: object keys are sorted lexicographically, undefined properties are omitted, arrays retain declared order, and insignificant whitespace is absent. Digest strings are `sha256:<64 lowercase hex>`.

Entity IDs prefix that digest, such as `price-evidence:sha256:...`, `protocol-evidence:sha256:...`, and `runner-attestation:sha256:...`. Report identity excludes `generatedAt`, so the same substantive evidence produces the same ID at a later reporting time. The timestamp remains in the report for audit ordering.

## Commands and exit codes

Run focused contract, oracle, mutation, and CLI tests:

```sh
corepack pnpm acceptance:v1-baskets:test
```

Inspect the truthful checked-in status:

```sh
corepack pnpm --silent acceptance:v1-baskets:check
```

Validate a candidate together with the separately generated runner artifact and create a non-overwriting report:

```sh
corepack pnpm --silent acceptance:v1-baskets:check -- \
  --candidate path/to/candidate.json \
  --runner-attestation path/to/runner-attestation.json \
  --at 2026-07-17T06:00:00.000Z \
  --output path/to/new-report.json
```

Semantically verify an existing attested report:

```sh
corepack pnpm --silent acceptance:v1-baskets:check -- \
  --candidate path/to/candidate.json \
  --runner-attestation path/to/runner-attestation.json \
  --verify-report path/to/report.json
```

Schema validation alone is not acceptance. `--verify-report` recomputes governance and candidate bindings, evidence semantics, run summaries, focus sets, V2 snapshots, oracle results, timing/provenance/offer bindings, replay bindings, candidate/report digests, and report ID.

Candidate and report JSON are capped at 8 MiB, runner attestation at 16 MiB, and governance inputs at 2 MiB each. Output uses exclusive creation and mode `0600`; an existing path is never overwritten.

Exit codes are fail-closed:

- `0`: all 60 measured/accepted runs and all foundation, protocol, V2 oracle, runner-attestation, coverage, timing, and reconciliation gates pass;
- `1`: invalid invocation, invalid contract, semantic verification failure, or failed acceptance assertion;
- `2`: blocked or pending, including the current rights/measurement state.

CI and release tooling must require both exit code `0` and `acceptancePassed: true`. Exit code `2` is never a soft pass. The current pending corpus still returns `2`.
