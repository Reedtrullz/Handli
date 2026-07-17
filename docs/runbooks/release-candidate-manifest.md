# V1 release candidate manifest

This runbook defines the repository evidence record for a possible Handleplan
v1 release. Verification proves that the JSON is internally consistent and
bound to the checked-out repository files. It does **not** build, sign, deploy,
approve, or promote a release.

The schema describes two modes, but the repository verifier supports only one
outcome today:

- `draft_unverified` is always `blocked`. It may describe a dirty working tree,
  but then the full commit is explicitly a `baseline_only` reference. Missing
  image, CI, test, scan, backup, regional, signature, and provenance evidence is
  represented as missing or unverified—not as a fabricated identifier.
- `promotion_candidate` is a reserved static shape. The verifier may report a
  more specific malformed-evidence error first, but it always rejects this mode
  and can never return `eligible`.

The current
[source-neutral V1-17 draft](../evidence/v1/v1-17-source-neutral-draft-2026-07-17/release-candidate.v1.json)
demonstrates the first mode. It records a dirty source milestone, no supported
regions, and all twelve gates as incomplete. It is not a release or a claim
about production.

## Why promotion is intentionally closed

Repository-local JSON and hashes cannot prove the external facts required to
authorize a release. Promotion remains unsupported until all of the following
exist and are independently reviewed:

1. a two-commit evidence design, where one immutable source commit produces the
   image and a later evidence commit retains proofs without claiming that those
   later files were present in the source commit;
2. live registry verification of the immutable OCI manifest, its config, and
   its layers, rather than trusting a repository-authored readback wrapper;
3. real signature and DSSE/in-toto verification against a pinned key or workload
   identity policy, with the verifier and trust roots outside candidate control;
4. distinct typed evidence contracts for G1 through G12 instead of allowing a
   generic self-declared report to satisfy unrelated gates;
5. candidate-current freshness and ordering rules for builds, tests, reviews,
   backup/restore drills, preview verification, and production readback; and
6. authoritative SPDX and SLSA validation plus reviewed legal, regional,
   operational, and device evidence.

Until that work lands, this tool is useful as a fail-closed draft ledger and
static preflight only. Passing draft verification means that the declared gaps
and repository file bindings are consistent. It does not establish release
readiness.

## Generate a new blocked draft

Choose a unique lowercase candidate ID and run:

```sh
corepack pnpm release:manifest:draft -- <candidate-id>
```

The generator writes
`docs/evidence/v1/<candidate-id>/release-candidate.v1.json`, refuses to
overwrite an existing candidate, enumerates every current SQL migration, and
binds the current source-registry and coverage-manifest bytes. Because writing
the new file makes the checkout dirty, it records the current commit only as a
`baseline_only` reference and leaves the image, backup, attestations, supported
regions, and all gates explicitly missing or unverified. It schema-validates and
semantically verifies the blocked draft before reporting success.

## Verify a manifest

Use Node 22 from the exact candidate checkout, then run:

```sh
corepack pnpm release:manifest:verify -- docs/evidence/v1/<candidate>/release-candidate.v1.json
```

The command reads `git rev-parse HEAD` and the complete porcelain worktree
status itself. A caller cannot mark a dirty checkout clean through manifest
fields. It then applies the Draft 2020-12
[schema](../release/v1-candidate-manifest.schema.json) and these semantic rules.
The promotion-only rules below are defensive static checks, not a path to a
successful release decision:

1. the full commit, clean/dirty state, and exact/baseline binding agree with Git;
2. every repository SQL migration is listed once, in lexical order, with its
   exact SHA-256;
3. source-registry and launch-coverage versions and file bytes match their own
   Draft 2020-12 schemas; active sources are in the cell's candidate set, expose
   the required data class, and leave no selection blocker or supported-region
   gap unresolved;
4. evidence IDs are unique; each passed CI, test, scan, or review has its own
   typed candidate/commit/image-bound wrapper, named reviewer, checksummed raw
   report, and review time; gates require the applicable evidence kinds;
5. `missingOrUnverifiedGateIds` is exactly the canonical projection of all
   non-passed gates;
6. supported regions exactly match selected coverage regions, and every required
   chain has rights-cleared, measured, launch-eligible ordinary-price and
   official-offer coverage from an approved public-ranking source;
7. an image identifier is an OCI **manifest** digest: typed registry readback
   retains the raw manifest bytes, their recomputed digest, OCI image-manifest
   media type, config descriptor, and layer descriptors; archive/config/layer,
   arbitrary, and repeated-character dummy digests are rejected;
8. a promotion-shaped document has a restore-verified backup identifier and
   retained evidence, a verified retained SBOM bound to the source commit,
   signed and verified provenance bound to both source commit and OCI manifest,
   passed registry readback evidence, and a verified image signature for that
   same manifest; and
9. promotion text cannot contain common placeholder markers such as `TODO`,
   `TBD`, or `replace-me`.

Paths must be normalized repository-relative regular files. Absolute paths,
`..`, backslashes, symlink traversal, missing files, checksum drift, raw image
archive hashes presented as OCI manifest digests, and unbound web dashboards are
rejected. Promotion paths must also be tracked at the candidate commit and live
under `docs/evidence/v1/<candidate>/`; ignored `.artifacts/`, another
candidate's reports, and unrelated repository files cannot satisfy a promotion.

The release-evidence wrappers are deliberately small indexes, not replacements
for raw proof. They bind contract version, candidate, commit, OCI digest,
evidence ID and kind, exact command/protocol, environment, result, reviewer,
review time, and one or more checksummed raw artifacts. Backup evidence uses a
separate restore contract. The verifier parses the retained SPDX document,
signed DSSE in-toto/SLSA provenance payload, registry manifest, and image
signature verification report instead of accepting a generic “passed” JSON.
Those structural parses are not cryptographic, registry, legal, or operational
verification, which is why promotion still terminates in rejection.

## Work required before enabling promotion

Do not edit the draft into `eligible`: the current verifier rejects it even if
all fields are populated. A future promotion implementation must use a new,
reviewed contract and an append-only directory under
`docs/evidence/v1/<candidate>/` for raw, redacted reports. That design must:

1. start from one clean full commit and record all migration checksums plus the
   database starting-state identifier;
2. build once in CI from the exact Git archive, push once, and obtain the
   registry's OCI manifest digest—not a Docker archive, config, layer, or tag;
3. run and retain candidate-current CI, PostgreSQL, browser/device, basket,
   dependency, secret, history, and container reports;
4. bind the exact source-registry and launch-coverage documents, with only
   actually selected and launch-eligible regions listed as supported;
5. retain an encrypted off-host backup identifier and an isolated restore
   artifact without secrets or private captures;
6. retain and verify the SBOM, signed provenance, and immutable image signature;
7. attach checksummed evidence to every one of G1 through G12, including named
   manual/legal/rights/device reviews where required; and
8. run an independently trusted verifier before any preview or production
   promotion, with the source commit and later evidence commit modeled
   separately.

The `CI` workflow's optional `promotion_manifest` input is a guardrail, not a
release lane. It invokes `--require-promotion`, which rejects the blocked draft;
any promotion-shaped document is then rejected by the verifier as unsupported.
Consequently, `workflow_dispatch` cannot report successful promotion today.
Normal push and pull-request CI tests the fail-closed checker but does not imply
that a promotion candidate exists.

A later checkout cannot truthfully verify a different commit's source bytes.
Preview and production readback, backup/restore drills, registry state, and
signature verification are separate external evidence events and must not be
inferred from this repository checker.
