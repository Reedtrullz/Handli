# Public-good governance

**Status:** adopted project policy for the protected alpha
**Public launch:** blocked until the unresolved facts below have named owners,
accepted evidence, and current public disclosures

## Mission

Handleplan exists to help people make an informed trade-off between grocery
cost and shopping convenience. It is intended to be a non-commercial public
good: core recommendations must remain useful without payment, an account, or
retailer influence. It must describe the evidence it actually compares and
must prefer a smaller honest scope over an unsupported "best" claim.

This mission is not an additional restriction on the code licence. The
`AGPL-3.0-or-later` licence permits commercial use when its terms are followed.

## Funding, sponsorship, and conflicts

Funding may come from transparent donations, grants, or sponsorships. Money,
free access, affiliate arrangements, data access, or other benefits must not:

- buy placement, change an objective or tie-break, suppress a cheaper plan, or
  exempt a retailer or source from the evidence rules;
- be conditioned on access to a person's basket, search, location, or trip; or
- be described as independent funding when a material conflict exists.

Every material funder, sponsor, affiliate arrangement, donated service, and
maintainer conflict must be published with its value or value range, period,
conditions, and a statement of whether it can influence product decisions.
There is no accepted funding ledger or named disclosure owner yet. Public
launch remains blocked until the actual state, including an explicit "none" if
that is accurate, is reviewed and published. Handleplan does not offer paid
ranking.

## Reproducible ranking policy

The binding rules live in the
[product-truth contract](../contracts/v1-product-truth.md). In summary:

1. The server rehydrates product, family, price, offer, coverage, and source
   identities; browser-supplied labels or prices are not ranking evidence.
2. Only currently eligible, attributable evidence within its declared time,
   geography, membership, and channel scope may participate.
3. Every required need and quantity must be fulfilled with whole purchasable
   packages. Incomplete baskets are not recommendations.
4. Candidate plans use one, two, or at most three stores. The planner removes
   dominated plans using the documented objectives: total checkout cost,
   number of stores, approved substitutions, and, only after opt-in, calculated
   travel time.
5. "Maximum savings" and "maximum convenience" are actual returned frontier
   plans. Intermediate preferences select an actual non-dominated plan, not an
   interpolated price. Stable documented tie-breaks make equal inputs
   deterministic.
6. Unknown or partial coverage remains visible and qualifies every best-price
   claim. Paid status, sponsorship, retailer identity, and commission are not
   objectives or tie-breaks.

A replay record for a candidate release must bind the code revision, contract
version, evaluation time, normalized request, source/coverage manifest,
taxonomy version, eligible evidence identifiers, routing evidence when used,
and returned frontier. Production replay and independent-oracle evidence are
not complete yet; until they are, this is the policy and implementation target,
not a claim that every live result has been independently reproduced.

## Corrections and appeals

Non-sensitive product, price, coverage, wording, and accessibility errors may
be reported through the public
[correction form](https://github.com/Reedtrullz/Handli/issues/new). A useful
report names the product, chain, region, observed time, page, expected result,
and non-sensitive source reference. Do not include a basket, address,
coordinates, Access identity, credentials, copyrighted captures, or other
personal/private material.

Corrections append evidence and decisions; they do not rewrite source captures
or reviewer history. A correction that affects eligibility or ranking must
invalidate dependent public output and be covered by a regression test. The
issue should record outcome and rationale, while private evidence stays
private. Response-time targets and a named correction owner are not yet
adopted, so the public release gate remains partial.

Security vulnerabilities and privacy requests must not be filed as public
issues. The confidential channels for those reports are unresolved blockers;
see [`SECURITY.md`](../../SECURITY.md) and the
[Norwegian privacy notice](../privacy/personvern.md).

## Contributor governance

Handleplan is currently maintainer-led. Changes are proposed as public issues
or pull requests and accepted on evidence, mission fit, maintainability, and
the product-truth contract, not sponsor or retailer preference.

Contributors must:

- licence contributions under `AGPL-3.0-or-later` and certify they have the
  right to submit them;
- keep secrets, personal data, private review evidence, and unlicensed captures
  out of issues, commits, fixtures, and CI artifacts;
- add tests and migration/rollback evidence proportional to the change;
- disclose material retailer, provider, funder, or affiliate conflicts; and
- obtain explicit review for changes to ranking objectives, source
  eligibility, privacy boundaries, security controls, or public claims.

Architecture and policy changes should be recorded as an ADR or binding
contract change. Source permissions and legal decisions require dated evidence
and a named human reviewer; code review cannot manufacture permission.
Maintainer identity, decision-appeal ownership, succession, moderation rules,
and the final contributor legal review are not complete and block public
launch. Practical contribution instructions are in
[`CONTRIBUTING.md`](../../CONTRIBUTING.md).

## Facts still required before public launch

- legal operator and Norwegian data-controller identity, organization/address,
  and contact details;
- confidential privacy and security reporting channels with owners and
  response expectations;
- the truthful funding/sponsorship/conflict ledger and its renewal owner;
- accepted dependency, licence, attribution, terms, trademark, logo, product
  imagery, and publication-capture review;
- permission evidence for every active price and offer source;
- selected geocoding/routing processors, agreements, retention, production
  quotas, attribution, and privacy review; and
- accepted legal, privacy, security, accessibility, operations, and release
  evidence for one immutable candidate.

Until those facts exist, Cloudflare Access stays in place and the application
must describe itself as a protected alpha.
