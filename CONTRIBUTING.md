# Contributing to Handleplan

Handleplan welcomes fixes and proposals that strengthen its public-good
mission and product-truth contract. The project is currently maintainer-led;
this file is a contribution process, not a claim that a foundation, board, or
formal appeal body exists.

## Before opening a pull request

1. Use a public issue for non-sensitive discussion. Never post credentials,
   personal data, baskets, addresses, coordinates, private review material, or
   copyrighted source captures.
2. Keep the change source-neutral unless a dated permission record explicitly
   allows a provider-specific integration.
3. Add or update tests, contracts, migration/rollback proof, public wording,
   and release evidence in proportion to the risk.
4. Disclose material employment, funding, affiliate, retailer, or provider
   conflicts relevant to the change.
5. Run `corepack pnpm typecheck`, `corepack pnpm lint`, and
   `corepack pnpm test` where applicable. A green UI test cannot override a
   failed privacy, rights, security, data-truth, or operations gate.

## Engineering roadmap

Use [Handli — Engineering Roadmap](https://github.com/users/Reedtrullz/projects/24)
for this repository's planning state. Issues are the canonical work items;
pull requests carry reviewable changes. The roadmap supplements the contribution,
privacy, provenance and review rules in this file.

New findings enter **Intake**. Move to **Ready** only after checking evidence,
duplicates, ownership, bounded scope, acceptance criteria and dependencies.
Use **In Progress**, **Blocked** and **In Review** to describe actual work.
Priority (P0–P3), Phase, Effort (XS–XL), Confidence and Category describe planning;
Area names the real subsystem. Confidence is separate from priority.

Use **Done** only after the intended outcome and required checks are complete,
with the implementing change merged where applicable. Use closing references in
PRs only for fully resolved Issues. Native item-closed and PR-merged workflows
are enabled; re-read Issue and Project state after an authorized merge. A draft
PR, green CI or Project status does not establish deployment or human acceptance.
Merge, deployment, provider access and release gates require their own authorization.

## Licence and provenance

Original contributions are submitted under `AGPL-3.0-or-later`, the repository
licence. By contributing, you represent that you have the right to submit the
work under that licence. Preserve third-party notices and do not assume that a
public API, webpage, catalogue, image, logo, or customer paper is reusable.
See [`LICENSES/README.md`](LICENSES/README.md) for exclusions.

## Review rules

Ranking objectives, tie-breaks, source eligibility, matching confidence,
location handling, logging, reviewer visibility, and public claims are trust
boundaries. A change to one of them needs an explicit reviewer rationale and a
regression test. Permissions and legal decisions need named, dated human
evidence; they cannot be approved only by CI.

Maintainers may reject a contribution that weakens complete-basket,
maximum-three-store, provenance, explicit-coverage, privacy, or no-paid-ranking
rules. Decisions should be explained on the issue or pull request. Formal
maintainer identity, succession, moderation, and appeal ownership remain to be
published before public launch.

## Reporting problems

- Non-sensitive corrections: use the public
  [issue form](https://github.com/Reedtrullz/Handli/issues/new).
- Security vulnerabilities: follow [`SECURITY.md`](SECURITY.md); do not post
  exploit details publicly.
- Privacy/data-subject requests: use the confidential channel once it is
  published. Its absence is an explicit public-launch blocker and a public
  issue is not a safe substitute.
