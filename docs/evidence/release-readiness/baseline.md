# Handleplan full-release execution baseline

**Captured:** 2026-09-08 (Europe/Oslo)
**Status:** `BLOCKED`
**Baseline marker:** `BASE6c6fe4b`

This is a redacted, read-only execution baseline for the full-release plan. It
does not change production, migration files, source permissions, private
captures, or credentials.

## Repository and CI identity

| Item | Observed value |
| --- | --- |
| Checkout | `/Users/reidar/Documents/handleplan-price-delivery` |
| Branch | `codex/prices-and-discounts` |
| Working tree at capture | clean (`git status --short` produced no entries) |
| Current checkout | `6c6fe4b56608a0efab649327a7438e16d20d4b3c` |
| Draft PR | [Reedtrullz/Handli#12](https://github.com/Reedtrullz/Handli/pull/12) |
| PR head | `3912d52a0c1b278136e4bde364accedd1912db8d` |
| CI run | `34231658984` (`verify` failed; promotion skipped) |
| CI failure | `Apply production migrations twice`; PostgreSQL `42601` near `candidate.normalized_fields` while creating `public.public_official_offer_rows_v1` from migration 039 |
| CI interpretation | Historical migration 039 repair is an authorized baseline item. This task did not rerun or modify it. |

The CI log was intentionally reduced to the failing step and error class; no
generated SQL dump is part of this report.

## Live installation

Inspection used the prescribed SSH identity restriction and read-only Docker
and PostgreSQL commands.

| Container | Image | Status |
| --- | --- | --- |
| `handleplan-worker-1` | `handleplan:670daec8c02b0df965c2a18ec5062f08297ec247` | Up 2 weeks (healthy) |
| `handleplan-operations-1` | same | Up 2 weeks (healthy) |
| `handleplan-app-1` | same | Up 2 weeks (healthy) |
| `handleplan-review-1` | same | Up 2 weeks (healthy) |
| `handleplan-postgres-1` | `postgres:16.10-alpine` | Up 3 weeks (healthy) |

The running Handleplan image resolves to:

```text
revision: 670daec8c02b0df965c2a18ec5062f08297ec247
image: sha256:31a05db6aaa687fa02dc8b058f11fa84eeac4f536b4cdfcd183af35cbbe97c17
```

The image had no registry repo digest in the local Docker inspection. This is
an image identity observation, not a promotion or public-release claim.

## Production migration ledger

The live database reports migrations `001` through `040` applied. IDs and
checksums below are copied from `handleplan_schema_migrations`; no historical
migration was edited or re-executed.

| ID | Checksum |
| --- | --- |
| 001 | `c1803a5179f3379a19fd3384561ee25ba8fc46dfa70779d63bd06f034ea20d9a` |
| 002 | `c5c5e7f7864cb1701835a7b93761545a4627a2e1b6f983ea53e64a13a61d3a05` |
| 003 | `5e9ac6e2c21b2290d0160f45aa4c76c3b47a36ecbd3f738774faa80ab93f0f06` |
| 004 | `f49d9d2ab8cd3f4e47f2453bd6d2b2d8313e94d8bda0ff1e53996b351ffe5943` |
| 005 | `e60b9d73561fc5c0e72ac5f5d0495b7c34dc8134ceba57f3e96871fa0b6b73bd` |
| 006 | `490910604aa75a68910b22e5f4af1638890b2baf13b887a5233c7de1b14719dc` |
| 007 | `9c6ac9301b3a11dbbd800c6da87e57e811c2a9e37b4365ccbbfbcb95f977cb87` |
| 008 | `4c51a2d5443b01323a36104eaff1d1c9fdc0f637fc2ef98c9a705621315d37ec` |
| 009 | `b35d2c465283c7fd514f41566a0e514b896e31a5831cf0c9fef77e3b012dc469` |
| 010 | `8c99f7a11d8c33825c8e90d12f77ffb58a42d6b23d622447720c846cb586d6b4` |
| 011 | `0c5a8b06b9b71859990366864351705d772e6d47bbd2047fa839fef318d38dec` |
| 012 | `70101ad7f170617de7d26614661c69e208293601388f6259c6441a40c941fda3` |
| 013 | `5a223d407b24d9848f35336ede86c8ab2be456273ac44e17b69860cf7d1a9088` |
| 014 | `52808f3e778e129a84928994f1d47acde58e134438aa390458506b2ee23b4a7a` |
| 015 | `4a94b671f6a45cc04a0563a45952468a123a372381cbbccd33a0222cffbb79d6` |
| 016 | `bc84b6b41db1ea5ef01e3c60eb84b9be3027d728f9989362548bc199cd055d1a` |
| 017 | `4fe8c7ce3aefb46d2af7f335f30b789d9a25bd662884713619247fdb448368c8` |
| 018 | `67ebf517236564b41d825da519d9d10b524f6c34119288f02bbca2711a10c307` |
| 019 | `7ffc33c1e129134570437bbe6b2f185b4130734f1a55a7184e33edb1aed70f05` |
| 020 | `203a5c5b66b2ebdd50f9e2a94f7477d2b0b9c3c253f893744fa5d7d90ee2c931` |
| 021 | `6f34f5e4b211378942d4dabc9b95bbb0bbe66968b8fc8c3f2ff7138244443f3b` |
| 022 | `4fb9f560ff89f062bf0a025118d582f7c3b3b60f63ce5b5917a91f63c6427249` |
| 023 | `2eaf73fcc4298a308ba7e8074cb6a2a44ad11b9a23a18b940083d4bd35f5f15a` |
| 024 | `15df6f98c99fc81bb4750169613f288d9cb4b640d5f020bbdf648ad189b34336` |
| 025 | `3d4da7bd3c35cce0393b0a98e52dea02f2b3a3c15425a623330ff443871e6417` |
| 026 | `fd9b961e452e5ad2d42bca44a2d619321be78c7f93e9f97732e7f443a7c119de` |
| 027 | `11a5cba1f7abd6e55f9899ca50c18684742012858423ee1a3060a1c5b1af15ea` |
| 028 | `6654c9070920607e91e9ff70069fd3c3ca49a7109d80cf59ec5f9c04cc3fe4b7` |
| 029 | `49bc92e50fe08bdfd592e1ea386c791fb77c2a4ae2723fa25b7909f705e062bc` |
| 030 | `5581093485475c44122652135b53e2aaca14eb68a1662fbe3cf2c1bc5802005c` |
| 031 | `88b1edf5c1090f8a213546bead97d3413292d31c90e67ceb5a3dbd16004c36eb` |
| 032 | `7e85910142e61a2e26bb07357debcb3883c28fa277bedd72e1c4cde2877a18b5` |
| 033 | `5b6d865c2dc3d3692e85e17371baa023926200ac5c6ef3b2d8c1c3bf5fdc7376` |
| 034 | `3f5276c5a394f6863282cfc801923936a0aff59497f68736512bb86fb25cb4d6` |
| 035 | `c3735f73530c85a6962e948f02c1da62ea4793a387822380c1baadcb24e70b94` |
| 036 | `cf0752c0839335e5b64eaa3c231470816a97210d563743dbe9a14284cca873e8` |
| 037 | `7ed7dfe8939482b72a6eccf1958ce70c18af5f2643e600932f10b6bb29d7758c` |
| 038 | `58c688d05af7c18384d4aeb0bc037b023fb066bb4b719078c21fc38c2ac8e49c` |
| 039 | `b92edd7f8c6e23bcea67a28b40c8150c168999ac70b03dce2bb4334bce4002a8` |
| 040 | `acc7a16e1e4ab4c0eed51df5724cd9cb92d08c8fd467d4d74f6f18f7bded809f` |

Migration 039 is therefore present in the live ledger, but its fresh-install
path remains a CI blocker. This baseline preserves both facts.

## Source approval state (redacted)

Current source rows and latest approval observations are:

| Source | Runtime state | Latest observed decision/time | Exposed approved capabilities |
| --- | --- | --- | --- |
| `kassalapp` | approved | `2026-08-11 13:50:18.020313+00` | catalog, ordinary price, price history, physical store |
| `open-prices` | approved | `2026-08-20 12:54:16.122111+00` | ordinary price |
| `tjek` | approved | `2026-08-21 16:04:05.780477+00` | public display, official offers, official offer capabilities and rights classifications |
| `legacy-import` | blocked | no approval timestamp | none |

Private reference keys, permission payload values, account rows, and private
capture identifiers are intentionally omitted.

## Fixed release scope

The requested chain scope is exactly:

`Bunnpris`, `REMA 1000`, `Extra`, `MENY`, `SPAR`, `Joker`, and `Europris`.

The acceptance protocol remains **Oslo, Bergen, Trondheim, 60 measured basket
runs** until measured evidence and an explicit scope decision support a change.
The current launch manifest selects no region. The three-city protocol is a
measurement scope, not a launch claim.

Current chain blockers from the dated evidence are:

| Chain | Baseline blocker |
| --- | --- |
| Bunnpris | credentialed capture, intake repair, exact reviewed offer evidence |
| REMA 1000 | intake repair and review of bounded offers |
| Extra | store/edition scope resolution and review |
| MENY | authorized structured offer evidence |
| SPAR | authorized structured offer evidence from current publication |
| Joker | authorized structured offer evidence; publication destination returned 403 |
| Europris | authorized structured offer evidence |

Bounded Tjek extraction observed 103 Extra and 116 REMA NOK offers; these are
advertised/partial endpoint observations and do not prove ordinary-price or
complete catalogue coverage.

## External owners and blockers

No person or organization was assigned in the inspected release evidence for
the following required external deliverables. They remain explicitly
**unassigned blockers**:

| Deliverable | Owner | Release consequence |
| --- | --- | --- |
| Provider access/rights and credentialed capture | Unassigned | Seven-chain source permission and measured coverage cannot be certified |
| Independent private review/approval | Unassigned | Candidate offers cannot become trusted public evidence |
| Operations/backup/monitoring delivery | Unassigned | Operational release gates cannot be closed |
| Physical-device/manual basket acceptance | Unassigned | Mobile/offline/device acceptance remains unproven |
| Independent release signing | Unassigned | Candidate image cannot receive independent release evidence |

Technical fixes remain engineering work. Ownership is recorded as unassigned
where current evidence does not name a responsible party; this report invents
no owner and sends no external messages.

## Exit assessment

`BLOCKED`. The baseline is complete and reviewable, but the full release cannot
be claimed: fresh migration 039 fails, the current worker permission boundary
and timestamp precision remain unresolved, measured seven-chain coverage is
absent, the launch geography is unset, and required external owners are
unassigned. No runtime change, migration edit, permission reapproval, public
launch, or deployment was performed by this task.
