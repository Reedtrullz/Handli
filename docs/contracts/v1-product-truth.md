# Handleplan v1 product-truth contract

**Status:** binding for implementation and release

**Applies to:** Planlegg, Oppdag, Handlemodus, public APIs, workers, review tools, status pages, and release evidence

Handleplan is a public-good grocery planner. Its useful promise is not that it knows every price. Its promise is narrower and testable:

> Handleplan recommends the lowest-cost or most-convenient complete plan among evidence it can verify, names the comparison scope, and never hides unknown coverage behind a “best” claim.

The deployed application remains a protected alpha until every public-release gate has evidence. Alpha access, a working UI, or a successful fetch does not make a source or claim public-release eligible.

## What the shopper must be able to trust

- Every recommended plan fulfils every requested need and quantity, or fails closed with an explanation.
- A plan uses one, two, or at most three stores.
- The maximum-savings and maximum-convenience endpoints are real returned plans. Intermediate slider positions are real non-dominated plans, never interpolated totals.
- A “best” claim names its declared chain, region, freshness, membership, and product/package scope. With incomplete coverage, copy says “among verified prices” instead.
- A cross-chain price difference is not called a retailer discount.
- A substitution, membership condition, multibuy requirement, surplus package, stale value, or unknown comparison is visible before a user chooses a plan.
- Suggested physical branches support routing only. They do not imply branch inventory or a branch-specific shelf price without branch-level evidence.

## Price and offer vocabulary

These concepts are deliberately separate in types, storage, APIs, and presentation.

### Ordinary price observation

A source-stamped package price observed at a stated time and geographic scope. It may enter a plan only while fresh, eligible, and attributable. The default freshness ceiling is 72 hours unless the source contract is stricter.

### Official offer

A rights-cleared retailer or licensed-source offer with immutable provenance, validity, applicability, conditions, and a matched purchasable product. It expires at its approved `validUntil`; a failed refresh never extends it.

### Official before-price

A reference price displayed only when an eligible official source supplies it for the same offer. Handleplan does not infer an official before-price from another shop or from its own price history.

### Historical comparison

An analytical comparison with earlier eligible ordinary observations. It is not an official discount. The v1 default is the median eligible ordinary observation over the trailing 30 days, with observations on at least seven distinct days. Until that threshold is met, no numeric historical saving is shown.

The protected alpha may describe a value as lower than a named previous observation. It must not strike that observation through, label the difference “Spar,” or present it as an official saving.

## Coverage is data, not absence

For each requested need and every declared supported chain, the server returns exactly one state:

- `priced`: eligible evidence can be used;
- `known-not-carried`: affirmative evidence says the item is not carried, checked no later than the comparison snapshot and no more than 72 hours before it;
- `stale`: evidence exists but is too old;
- `ineligible`: evidence exists but fails permission, scope, membership, ambiguity, or another eligibility rule; or
- `unknown`: Handleplan cannot establish the result.

A missing upstream row is `unknown` unless affirmative evidence proves `known-not-carried`. It must never silently disappear.

Every plan response identifies expected, verified, and unknown chains; complete or partial comparison status; per-need/per-chain reasons; and evidence identifiers for every assignment. Useful plans may be returned from partial evidence, but unqualified “best across all three” copy is prohibited.

## Geographic applicability and branch proof

- National, region, postal-set, and store-set evidence remain distinct. A regional selection may use a postal-set price or offer only when a current, approved, versioned postal directory proves that the set covers the complete selected region.
- When that proof authorizes a public plan, the response carries a bounded attestation for only the selected region (never the complete national directory). Exact, reviewed-family, travel-filtered, and immutable-trip validation all bind it to the same directory version, market, and evaluation clock; trip expiry cannot outlive the attestation.
- Partial postal overlap is ambiguous, not applicable. A missing, conflicting, future, expired, blocked, retired, incomplete, or ambiguous directory fails closed and cannot improve a public recommendation.
- Directory versions are assembled in a non-public `building` state and become immutable when sealed. A later terminal version shadows an older approval at the same or later review clock.
- Region-bound routing uses only branches whose persisted source-provided postal code joins the same current directory version and complete region proof. It does not infer a branch region from coordinates, an address supplied by the shopper, or the optional route origin.
- No approved directory rows are seeded by the application. A launch region becomes routable only after explicit reviewed directory evidence is loaded; otherwise travel returns the existing branch-data-unavailable outcome.

## Matching and quantity fulfilment

- Exact valid EAN is the only automatic high-confidence merge.
- Name, brand, or package similarity creates a review candidate, not a silent merge.
- The server rehydrates product and family identities. Browser-supplied product metadata is not authoritative.
- Flexible family membership is reviewed or produced by a versioned deterministic rule.
- Required gram, millilitre, piece, and package amounts are fulfilled with whole purchasable packages.
- Output shows requested amount, package count, purchased amount, and surplus.
- Multibuy arithmetic applies the qualifying group price and the best eligible ordinary price for any remainder.
- Monetary values use integer øre; quantities use integer base units; overflow fails closed.

## Travel and privacy

Travel is optional. The result page asks for an origin only after explicit opt-in and labels the output “calculated route estimate.” If routing fails, Handleplan recomputes a coherent price-only frontier.

An origin, address, coordinates, origin label, or origin-adjacent route geometry must not be written to browser persistence, URLs, cookies, analytics, application logs, persistent caches, or evidence storage. Provider credentials remain server-only. The private, no-store address lookup may return at most five bounded labels with short-lived opaque tokens so the user can make a real selection; it never returns coordinates or provider identifiers. Travel-plan responses contain selected branch stops and aggregate time/distance, not the origin.

Anonymous basket and active-trip data stay on the device and remain user-clearable. Handleplan adds no behavioural analytics without a separate documented consent decision.

## Source eligibility and revocation

Only an `approved` source with a current permission record, eligible claim class, active geographic scope, and enabled runtime state may feed a public ranking. `conditional`, `blocked`, `revoked`, expired-permission, unknown-scope, stale, malformed, or quarantined evidence fails closed.

The machine-readable [source registry](../data/source-registry.v1.json), [launch coverage manifest](../data/launch-coverage.v1.json), and [source kill-switch procedure](../data/source-kill-switch.md) are release inputs. A rights or coverage gap narrows the declared launch scope; it does not authorize an undocumented workaround.

## UI copy and presentation rules

- Use “official offer” only with eligible official-offer evidence.
- Use “official before-price” only when supplied by that eligible official source.
- Use neutral historical language such as “lower than the historical comparison,” never retailer-sale styling.
- Use “among verified prices” whenever comparison coverage is partial.
- Show source, observed/published time, validity, scope, conditions, freshness, and known gaps close to the claim.
- Keep official offers and historical comparisons visually and semantically distinguishable, including to screen readers.
- Never claim stock, checkout availability, guaranteed travel time, or universal cheapest price without matching evidence.

## Enforcement

This contract is enforced through versioned domain parsers, database eligibility queries, deterministic fixtures, API/component tests, acceptance scenarios, and the [evidence-linked release gates](../release/v1-release-gates.md). A green UI smoke test cannot override a failed source, data-truth, privacy, accessibility, security, or operations gate.
