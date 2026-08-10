# Handleplan v1 plan-delta explanation contract

**Status:** binding for V1-08 implementation

**Applies to:** exact-product planning v1, reviewed-family planning v2, optional travel planning, and the Planlegg result UI

Plan differences are server-owned evidence claims. The browser may render an absolute plan total, store count, package facts, and route aggregate supplied by the server, but it must not subtract plan totals, sum offer savings, or derive comparative travel copy.

## Versioned response

Every successful planning response includes `planDeltaExplanations` with contract version `1`. The object binds the explanation set to:

- the exact planning `generatedAt` timestamp and market context;
- the ordered IDs of the projected, non-dominated plans;
- every price-evidence and official-offer ID used by those assignments;
- the complete or partial comparison scope and unresolved reasons; and
- when travel is available for every returned plan, the route timestamp, mode, provider, and fingerprint for each plan.

The first returned plan is the comparison reference. Each entry identifies that reference, supplies its server-owned selector role and Norwegian label, and describes the selected plan's basket-price relationship, documented offer saving, store count and store-set changes, and per-need product, package quantity, offer, and chain changes. Savings/convenience labels are emitted only for a complete comparison; partial comparisons receive neutral numbered alternative labels. Travel time and distance differences appear only when one coherent route set covers every returned plan.

The server derives explanations after the final frontier and representative projection:

~~~text
enumerate complete plans
  -> attach optional travel evidence
  -> retain Pareto frontier
  -> project at most seven representatives
  -> derive and bind plan-delta explanations
~~~

The planning service retains an internal, evidence-bound `completeCandidateSet` for travel. It contains every distinct complete plan produced from the allowed non-empty chain subsets before price-only dominance (up to seven subsets when all three launch chains are available and `maxStores` is three). This internal set is never serialized by `/api/plans`. Optional routing evaluates the entire set first, so a price-dominated plan can legitimately enter the final frontier when its journey is shorter. If travel is unavailable, the coordinator discards every provider-supplied subset and returns the freshly validated price-only frontier and its price-only explanations.

## Fail-closed rules

Derivation returns no explanation object when any of these conditions is true:

- a plan is dominated, misordered, incomplete, stale, ineligible, or uses more than three stores;
- plans do not cover the same complete need set;
- an assignment is detached from its evidence, coverage row, product, chain, or offer;
- evidence or route data belongs to another planning timestamp, market, plan order, or store set; or
- only some returned plans have valid route evidence.

The exact-product, reviewed-family, and travel response parsers independently rederive the expected object and require byte-equivalent structured data. A syntactically valid but forged or stale message is therefore rejected at the API boundary.

Starting Handlemodus from a calculated route requires the full validated travel request and response, not a standalone route object. The nested travel request must be byte-equivalent to the primary planning request, and the nested planning response must be byte-equivalent to the primary exact or reviewed response, including market, `generatedAt`, plan bodies, ordering, and explanations. Only the selected public route aggregate and branch stops are copied into the immutable trip; the location token, address, origin coordinate, and route geometry are not persisted.

## Qualified numeric claims

Basket-price differences and documented offer-saving totals are numeric only when the compared plans have complete eligible coverage for every need. A `known-not-carried` cell counts as resolved only when its server check is no later than the planning snapshot and at most 72 hours old. If coverage is partial, unknown, stale, future-dated, or ineligible, the corresponding union variant is `withheld` and contains a reason and qualified message, but no amount field; malformed serialized coverage is rejected outright.

A cross-store basket difference is not a retailer discount. `offerSaving` is computed only from assignment checkout evidence for an applied eligible official offer. Package and product changes remain factual structured differences, not price-saving claims.

## Client rendering rule

Planlegg selects an explanation by exact plan ID and renders its server-provided selector label, messages, and qualifier. It may format absolute integer-øre totals and direct route aggregates, but comparative labels and copy come only from the explanation contract. Missing or response-detached explanation data invalidates the result instead of triggering a browser fallback calculation.

## Verification

Coverage includes:

- deterministic unit and property tests for evidence permutations and exact integer-øre deltas;
- fail-closed tests for partial coverage, mixed snapshots, detached evidence, and dominated plans;
- exact, reviewed-family, and travel response-schema tamper tests;
- full-candidate travel rescue, price-only fallback, and non-canonical plan-body tests;
- exact and reviewed Handlemodus tests for cross-market and cross-response travel-envelope tampering;
- API route tests that reject forged service explanations; and
- result summary and selector tests that render supplied messages without deriving equivalent deltas.
