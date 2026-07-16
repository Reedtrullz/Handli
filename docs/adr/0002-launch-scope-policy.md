# ADR 0002: Launch only where three-chain coverage is rights-cleared and measured

- Status: Accepted
- Date: 2026-07-16
- Owners: Handleplan maintainers
- Applies from: launch coverage manifest v1

## Context

The first usable Handleplan release must cover Bunnpris, REMA 1000, and Extra. Oslo, Bergen, and Trondheim are plausible candidates because official retailer pages show physical stores in all three cities. Presence alone does not prove complete ordinary-price coverage, authorized offer ingestion, correct regional applicability, freshness, or branch mapping.

Regional publications also use different scope models. REMA 1000 publishes named geographic editions, Extra exposes cooperative/region-labelled publications, and Bunnpris customer papers may be store-specific. A city chosen from intuition could therefore produce misleading “best” claims.

## Decision

### Manifest is authoritative

`docs/data/launch-coverage.v1.json` is the repository authority for public chain/region/source coverage. Public status copy must be generated from or checked against it. Chat conclusions, successful sample calls, store-presence pages, and fake fixtures cannot promote a region.

The manifest has three distinct concepts:

- **candidate region**: worth measuring, not a launch promise;
- **selected region**: all launch gates below have recorded evidence; and
- **suspended region**: previously selected but no longer eligible because a source, freshness, scope, or operational gate failed.

Oslo, Bergen, and Trondheim begin as `candidate_unverified` with `selected: false`.

### Selection gate

A region may become selected only when all of these conditions pass:

1. Bunnpris, REMA 1000, and Extra each have an `approved`, sustainable ordinary-price source.
2. Bunnpris, REMA 1000, and Extra each have an `approved` official-offer path if Oppdag is launched with all-three-chain offer coverage, as required by v1.
3. Every chain/price-class cell has an active approved source, `coverageStatus: verified`, and `evidenceLevel: rights_cleared_measured`.
4. Twenty representative basket runs for that region have current results with explicit priced, known-not-carried, stale, ineligible, and unknown states.
5. Every complete recommendation remains complete after server-authoritative matching and quantity fulfilment, uses at most three stores, and qualifies “best” whenever any expected chain is unknown.
6. Regional and store applicability is deterministic; unknown scope is ineligible and border tests pass.
7. Freshness distribution, branch-directory coverage, and source health meet the production contracts.
8. Manual source checks for the benchmark corpus are accepted and dated.
9. Public status, limitations, attribution, and source labels match the manifest.
10. Revocation, outage, and stale-data drills demonstrate fail-closed behavior.

The first selected region should be the smallest region set that proves this contract. It need not be the largest market. Additional candidates remain hidden from launch claims until they independently pass.

### Coverage semantics

Store presence evidence is `public_presence_only`. A publication that names a region is at most `public_scope_only`. Neither is price coverage or reuse permission.

Product-level comparisons use the states:

- `priced`;
- `known_not_carried`;
- `stale`;
- `ineligible`; and
- `unknown`.

Missing data is `unknown`, never `known_not_carried`. When any supported chain is unknown, useful complete plans may still be returned, but copy is limited to “among verified prices” and cannot claim the best price across all three chains.

### Suspension and scope reduction

Any active source moving to `blocked` or `revoked`, any unresolved region mapping, or sustained failure of freshness/health changes affected coverage cells immediately. If the selection gate no longer passes:

1. the region becomes `suspended` or its declared feature scope is reduced;
2. affected evidence becomes ineligible;
3. public status and recommendation copy update in the same release/change window; and
4. re-selection requires new measured evidence, not merely service recovery.

Rights uncertainty produces a smaller declared launch, never an undocumented scraper or silent source substitution.

## Consequences

- Candidate cities are useful planning units but are not product claims.
- Launch may begin in one region even if all three candidates were evaluated.
- The data team must measure the same benchmark corpus in each candidate region.
- Public wording and feature availability degrade automatically with the manifest.
- V1 cannot be declared complete while a required chain is represented only by public-page presence or an unverified credential.

## Rejected alternatives

- **Launch nationally once one product appears at each chain.** Rejected because samples do not prove basket or regional coverage.
- **Select Oslo by market size.** Rejected because feasibility and rights, not population, determine truthful scope.
- **Treat missing chain rows as products not carried.** Rejected because it manufactures comparison completeness.
- **Keep stale launch claims during source incidents.** Rejected because public claims must follow current evidence.
