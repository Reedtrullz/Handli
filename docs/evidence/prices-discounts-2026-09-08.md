# Prices and discounts execution — 2026-09-08

## Result

Draft only; not deployed. Five production services remain healthy on
`670daec8c02b0df965c2a18ec5062f08297ec247`. Main contains the previously verified
51-row continuation repair `34b9ad1b9c306c69b99478aaa3500c3011077f99`, still not live.

## Implemented

- Replaced Tjek direct review/publication SQL and fuzzy exact-product matching with
  the existing foundation repository, private payload storage, and review candidates.
- Added paged Extra/REMA retrieval with bounded short-page completion, preserving raw
  conditions, currency, catalogue scope, and advertised counts. Failed/partial requests
  no longer masquerade as confirmed empty catalogues.
- Wired daily discovery and the dedicated SQL lifecycle scheduler; publication policy
  remains independently gated. No production approved-offer evidence was changed.
- Stopped promoting discounted Open Prices receipts into ordinary prices and stopped
  stamping unverified receipt locations as national.
- Updated vulnerable dependency resolutions and the license inventory.
- Added a missing NOLOGIN worker-role prerequisite for fresh migration 037; existing
  roles and migrations 022–040 remain unchanged.

## Verification

- DB: 340 passed, 87 skipped; later changed migration tests: 32 passed.
- Web: 732 passed; DB/web typechecks passed.
- Worker: 190 passed, one opt-in integration test skipped; typecheck/lint passed.
- Tjek: 29 passed; strict typecheck passed. Open Prices: 27 passed.
- Dependency audit: zero known vulnerabilities; license policy: 451 packages passed.
- Live bounded Tjek extraction: Extra `0dhblsFH` returns 103 NOK offers
  (advertised 120), REMA `K9l4rVqg` returns 116 NOK offers (advertised 131).
  Both endpoint traversals finish on a short page; neither has null prices.
- Bunnpris catalogue `6hvf5RxU`: explicit all-store Norway evidence; anonymous RPC
  rejects `INVALID_API_KEY`. Production-key extraction was not proven in this draft.

## Release blockers

1. Fresh PostgreSQL migration 039 fails: E-string escaping destroys the intended
   literal-pipe regex, generating an invalid replacement function. The handoff forbids
   editing migrations 022–040, so no historical checksum or execution was rewritten.
   An explicitly agreed immutable-migration recovery strategy is needed.
2. Existing source permission timestamps have microseconds; the domain fence represents
   milliseconds and the foundation compares exact SQL timestamps. Current governance
   evidence was not silently rounded or reapproved.
3. Under the real worker role, foundation geographic-scope `FOR SHARE` requires a
   privilege the worker lacks (SELECT is granted, UPDATE is not). Publication capture
   also requires an unreached update/lock privilege. Broad UPDATE rights were not granted and the lock was
   not removed. A narrow reviewed database boundary is needed.
4. Offers without proven identity/package/eligibility are degraded review candidates,
   not public discounts. The database publication policy remains false.

The disposable PostgreSQL test is intentionally opt-in and exposes the remaining intake
failure. Scratch migration experiments excluding 039 are diagnostic only, never full
migration or deployment proof. Do not merge/deploy this draft as a completed repair.

## Chain requirements

| Chain | Remaining source or acceptance requirement |
| --- | --- |
| Bunnpris | Credentialed capture, database intake repair, exact reviewed offer evidence |
| REMA 1000 | Intake repair and review of 116 endpoint offers; explicit all-store scope exists |
| Extra | Store/edition scope resolution (`all_stores:false`) plus intake and review |
| MENY | Current regular-price coverage exists; iPaper offer adapter and authorized structured evidence needed |
| SPAR | Current customer newspaper resolves to PDF; structured authorized offer evidence needed |
| Joker | Current regular-price coverage exists; newspaper destination returned 403 |
| Europris | Zmags publication adapter and authorized structured offer evidence needed |
| Engrossnett / Oda | Fresh usable ordinary-price evidence absent in baseline |

Source discovery: [Tjek SDK paged offers](https://github.com/tjek/tjek-js-sdk/blob/develop/lib/kits/core-ui/components/common/offer-list.ts),
[MENY newspaper](https://meny.no/api/kundeavis?postCode=7011),
[SPAR newspaper](https://spar.no/api/kundeavis?postCode=7011),
[Joker newspaper](https://joker.no/api/kundeavis?postCode=7011),
[Europris newspaper](https://www.europris.no/kundeavis).
Technical availability does not expand the persisted source permission record.
