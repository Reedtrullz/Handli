# ADR 0001: Keep official offers separate from historical price comparisons

- Status: Accepted
- Date: 2026-07-16
- Owners: Handleplan maintainers
- Applies from: domain contract v1

## Context

Handleplan needs to show a current package price, an original price, kroner saved, and percentage saved without implying that every observed price decrease is a retailer promotion. Public grocery APIs may expose current and historical observations without a retailer-declared campaign, while publications may include actual offers with validity, geography, membership, quantity, and before-price conditions.

Combining these concepts would make a numerical inference look like an official discount. It would also allow stale, wrong-region, member-only, or ambiguous evidence to win a plan.

Primary evidence reviewed on 2026-07-16 reinforces the distinction:

- [Kassalapp API documentation](https://kassal.app/api/docs) documents current products and bulk price history, but those observations do not by themselves declare a retailer campaign.
- [Tjek terms](https://tjek.com/terms) define offers and make API use agreement-specific.
- [REMA 1000's Oslo publication](https://www.rema.no/kundeaviser/oslo/) declares geographic applicability, validity periods, and stock/image caveats.
- [Extra's Hordaland publication](https://kundeavis.coop.no/aviser/extra/hordaland/) declares a regional edition, dates, and stock/error caveats.

## Decision

Handleplan has three disjoint price concepts.

### Ordinary price observation

An ordinary observation is an immutable, source-stamped package price observed at a point in time. It includes source, chain, product/package identity, observed time, geographic applicability when known, amount in øre, and eligibility state.

It is not an offer. Its absence is `unknown` unless affirmative evidence proves `known_not_carried`.

### Official offer

An official offer is eligible only when all of the following are true:

1. its source is `approved` for official-offer processing and public display;
2. retailer or authorized publisher provenance is immutable and inspectable;
3. offer price, purchasable package, valid-from, and valid-until are known;
4. geographic scope resolves to the selected region/store without ambiguity;
5. quantity, multibuy, membership, coupon, and other eligibility conditions are explicit;
6. the offer is current and has not been revoked; and
7. any before-price displayed was supplied as an eligible reference price by the official source.

An offer with missing or ambiguous required data is `ineligible`; it is never repaired from historical observations. Fetch failure never extends `validUntil`.

“Spar”, “tilbud”, original/before price, kroner saved, and percentage saved are official-offer language. Handleplan may calculate official savings only when both eligible offer price and source-supplied before-price exist:

```text
savings_ore = before_price_ore - effective_offer_price_ore
savings_ratio = savings_ore / before_price_ore
```

If savings are zero or negative, savings copy is omitted and the evidence is flagged for review. Rounding for display must never alter the underlying integer amounts.

### Historical comparison

A historical comparison is an analytical result, not a promotion. The default reference is the median of eligible ordinary observations for the same canonical product and comparable package in the trailing 30 days, with observations on at least seven distinct days.

Historical comparison may use copy equivalent to:

- “under 30-dagers median”; or
- “prisendring mot historikk”.

It must not use “tilbud”, “førpris”, “rabatt”, or “spar”. It cannot supply a missing official before-price. The UI and API expose its method, window, distinct observation-day count, reference amount, current amount, and evidence identifiers.

### Precedence and revocation

An eligible official offer and an ordinary observation may coexist. The planner evaluates the effective eligible purchase price but preserves both classifications and their provenance. Historical analytics remain separate even when their reference amount happens to equal an official before-price.

If a source becomes `blocked` or `revoked`, new evidence is rejected immediately and affected active offers become ineligible. Previously displayed historical facts may remain only if the source agreement permits retention; otherwise they are quarantined or deleted under the source disposition rule.

## API and UI acceptance rules

- Every price-like response carries `classification`, `sourceId`, `evidenceId`, `observedAt`, and eligibility.
- Official offers additionally carry validity, scope, conditions, and immutable publication provenance.
- Historical comparisons additionally carry method, window, observation-day count, and reference evidence.
- A missing official before-price produces no original price, kroner-saved, or percent-saved fields.
- Wrong-region, expired, stale, member-ineligible, unknown-scope, blocked-source, and revoked-source evidence cannot win.
- Snapshot, contract, and visual tests assert that official and historical labels cannot be swapped.

## Consequences

- Oppdag can show useful historical context before a licensed offer pipeline exists, but it cannot call that context a discount.
- Official savings require more source fields and stricter review than ordinary prices.
- Current UI copy and APIs that conflate a price drop with an offer must be corrected before public launch.
- Source revocation can reduce visible deals and comparison scope; truthful degradation is preferred to invented completeness.

## Rejected alternatives

- **Treat every current price below the last different observation as a discount.** Rejected because it is sensitive to sparse data and invents retailer intent.
- **Use the historical median as an official before-price.** Rejected because a computed reference is not retailer-declared.
- **Hide classification details from the API.** Rejected because downstream UI could silently conflate meanings.
