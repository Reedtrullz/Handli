# Handleplan full release specification

## Requested outcome

Release Handleplan with truthful current ordinary prices and official discounts for Bunnpris, REMA 1000, Extra, MENY, SPAR, Joker and Europris. Carry those facts through discovery, product selection, complete-basket planning and shopping mode. The other currently exposed chain filters must either pass the same evidence checks or state their unavailable/partial coverage accurately. A protected preview, one visible item, green unit tests, or a successful import is not the requested complete release.

## Existing evidence

- Working directory: `/Users/reidar/Documents/handleplan-price-delivery`; original checkout `/Users/reidar/Documents/Kassalappen`.
- Draft PR: https://github.com/Reedtrullz/Handli/pull/12, baseline `3912d52a0c1b278136e4bde364accedd1912db8d`.
- Last verified production revision in this session: `670daec8c02b0df965c2a18ec5062f08297ec247`, five healthy services. Recheck before execution.
- Pagination fix `34b9ad1b9c306c69b99478aaa3500c3011077f99` is on main and included in the draft ancestry; not yet verified deployed.
- CI 34231658984 fails production migration 039. The preceding dependency/license/secret gates now pass.
- Real worker-role intake fails the geographic-scope lock. The current authorization fence also cannot preserve PostgreSQL microseconds.
- Bounded live Tjek extraction returned 103 Extra and 116 REMA NOK offers; neither proves ordinary-price catalogue completeness. Extra is not all-store scope. Anonymous Bunnpris RPC requires a key.
- Current basket checker: blocked, 60 pending, zero passed. Current launch manifest selects no region. July release ledger is historical and must be reassessed.
- Detailed baseline: `docs/evidence/prices-discounts-2026-09-08.md`.

## Required behavior

R1 Reproducible fresh install, rerun, upgrade from production, restore and rollback; immutable historical evidence.
R2 Least-privilege, revocation-safe ingestion preserving exact permission identity and durable private capture evidence.
R3 Authorized and measured ordinary-price plus official-offer coverage for all seven named chains in declared geography.
R4 Exact product or explicitly reviewed-family identity, package/quantity, NOK, eligibility, channel, store scope, dates and source provenance; no invented discounts or before prices.
R5 Review-to-publication lifecycle, trustworthy counters, restart/retry safety, automatic expiry and revocation.
R6 Discovery, search, pagination, category and planning agree; no invisible contract gap for reviewed identifiers.
R7 Complete-basket arithmetic, deposits, membership, multibuy, substitutions and stale/unknown data correctly handled with real-source acceptance.
R8 Accessible, cross-browser, mobile/offline shopping and truthful travel behavior for enabled features.
R9 Candidate-current backup/restore, monitoring delivery, security/privacy/legal facts and source governance.
R10 Exact-image protected deployment, public launch evidence and post-launch refresh/expiry verification.

## Global constraints

- Use Node 22.22.3 and pnpm 10.34.5.
- Do not modify migrations 022–040.
- Do not fabricate products, prices, discounts, source rights, review decisions or production evidence.
- Do not weaken trust, freshness, source-permission, supported-chain, geographic or generic GTIN validation gates.
- Do not grant the worker direct review/approval/publication authority.
- Preserve unrelated work, database contents, existing private captures and historical evidence.
- Keep credentials, private captures and personal account data out of Git and durable reports.
- Do not contact providers or send messages to others without explicit authorization.
- Use `ssh -i ~/.ssh/id_rsa_racknerd -o IdentitiesOnly=yes` for the VPS.
- Check `df -h /System/Volumes/Data` before long builds; stop below 30 GiB free.
- Use the prescribed Compose stop/remove/recreate procedure and verify the exact deployed SHA and image digest.
- No public-release claim until every applicable G1–G12 gate passes for the same candidate.

## Decisions and external inputs

The plan recommends a distinct audited clean-install baseline and a forward upgrade migration, preserving 022–040. Approve that design after the schema/ledger comparison, before changing bootstrap behavior; do not silently skip 039 or forge its applied checksum. An alternative historical-file repair requires an explicit exception to the constraint above.

Choose launch geography from measured evidence. The current acceptance protocol covers Oslo, Bergen and Trondheim and 60 runs; retain it unless an explicit scope decision updates the contracts. Do not silently reduce the user's seven-chain goal to the original three-chain manifest.

Provider rights/access, operator identity, independent release signing and physical-device/manual review evidence are external deliverables. Record exact blockers and owners if unavailable; do not mark dependent tasks complete. Technical database and parser bugs are engineering work, not automatic permission requests.
