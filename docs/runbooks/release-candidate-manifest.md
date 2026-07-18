# V1 release candidate manifest

This runbook defines the repository evidence record for a possible Handleplan
v1 release. Draft verification proves that the JSON is internally consistent
and bound to the checked-out repository files. Promotion verification also
requires a short-lived Ed25519 receipt signed by a trust root supplied through
the protected `release-promotion` GitHub Environment. The verifier does **not**
itself build, sign, deploy, approve, or publish a release.

The schema describes two modes:

- `draft_unverified` is always `blocked`. It may describe a dirty working tree,
  but then the full commit is explicitly a `baseline_only` reference. Missing
  image, CI, test, scan, backup, regional, signature, and provenance evidence is
  represented as missing or unverified—not as a fabricated identifier.
- `promotion_candidate` receives strict two-commit validation. The
  source commit must be followed by exactly one clean evidence-only commit that
  adds a previously absent candidate directory and changes nothing outside it.
  Every repository proof must pass, and the evidence commit must add
  `external-release-trust-receipt.v1.json`. That receipt binds the exact
  manifest bytes, source commit, OCI repository/reference/digest, approved
  image and provenance signers, and canonical G1-G12 set. Its Ed25519 key,
  expected registry, and expected signer identities come from Environment
  policy rather than candidate-controlled files. A receipt is valid for at
  most 24 hours and must postdate all candidate evidence.

The historical
[cross-browser-remediated source-neutral implementation draft](../evidence/v1/v1-source-neutral-cross-browser-remediation-2026-07-17/release-candidate.v1.json)
demonstrates the first mode. It binds the signed source commit, enumerates all
26 migrations that were current at that baseline, records no supported
regions, and leaves all twelve
release gates incomplete. Its adjacent local verification note is diagnostic
context, not retained candidate-current release proof. The implementation has
advanced beyond that artifact and requires a new exact-source candidate.
The preceding typecheck,
PostgreSQL, and CI remediation, full implementation, and V1-17 drafts are
preserved as historical, immutable milestones. None of the drafts is a release
or a claim about production.

## Why promotion remains externally closed

Repository-local JSON and hashes cannot prove the external facts required to
authorize a release. The verifier therefore succeeds only after an independent
release authority signs the bounded receipt. Before signing, that authority
must independently establish all of the following:

1. review of the two-commit evidence design, where one
   immutable source commit produces the image and exactly one later
   evidence-only commit retains proofs without claiming that those later files
   were present in the source commit;
2. live registry verification of the immutable OCI manifest, its config, and
   its layers, rather than trusting a repository-authored readback wrapper;
3. real image-signature and DSSE/in-toto verification against pinned workload
   identities; the signed receipt records those identities and the protected
   Environment supplies the allowed identities and receipt public key;
4. distinct typed evidence contracts for G1 through G12 instead of allowing a
   generic self-declared report to satisfy unrelated gates;
5. candidate-current freshness and ordering rules for builds, tests, reviews,
   backup/restore drills, preview verification, and production readback; and
6. authoritative SPDX and SLSA validation plus reviewed legal, regional,
   operational, and device evidence.

The receipt cannot manufacture any of those facts: whoever controls its private
key is responsible for verifying them before signing. No private key belongs in
the repository, GitHub variable output, CI artifact, or candidate evidence.
Today there is no signed receipt, approved grocery source, supported region, or
completed G1-G12 set, so every real Handleplan candidate remains blocked.
Passing draft verification still means only that declared gaps and repository
bindings are consistent.

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
Promotion additionally requires all of the following:

1. the evidence checkout is clean; the source commit is its ancestor; exactly
   one commit separates them; the candidate directory did not exist in the
   source; and every changed path is inside that newly added candidate
   directory;
2. every repository SQL migration is listed once, in lexical order, with its
   exact SHA-256;
3. source-registry and launch-coverage versions and file bytes match their own
   Draft 2020-12 schemas; active sources are in the cell's candidate set, expose
   the required data class, and leave no selection blocker or supported-region
   gap unresolved;
4. evidence IDs are unique; each passed CI, test, scan, or review has its own
   `handleplan.release-evidence.v2` candidate/commit/image-bound wrapper, named
   reviewer, checksummed raw report, review time, canonical `gateIds`, and the
   exact `handleplan.gate-evidence.<gate-domain>.v1` protocol required for that
   gate; evidence for one gate cannot be reused by another gate merely because
   its broad kind matches;
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
   `TBD`, or `replace-me`; and
10. the fixed candidate-local external trust receipt has a valid Ed25519
    signature from the Environment-pinned key, is no more than 24 hours old,
    postdates every candidate review, authorizes the exact registry and signer
    identities, and binds the exact manifest SHA-256 and all G1-G12 gates.

Paths must be normalized repository-relative regular files. Absolute paths,
`..`, backslashes, symlink traversal, missing files, checksum drift, raw image
archive hashes presented as OCI manifest digests, and unbound web dashboards are
rejected. Promotion paths must also be tracked at the candidate commit and live
under `docs/evidence/v1/<candidate>/`; ignored `.artifacts/`, another
candidate's reports, and unrelated repository files cannot satisfy a promotion.

The release-evidence wrappers are deliberately small indexes, not replacements
for raw proof. Promotion requires wrapper v2, which binds contract version,
candidate, commit, OCI digest, evidence ID and kind, canonical gate IDs, the
gate-specific protocol, exact command, environment, result, reviewer, review
time, and one or more checksummed raw artifacts. Historical blocked drafts may
retain v1 wrappers, but v1 can never satisfy promotion. Backup evidence uses a
separate restore contract. The verifier parses the retained SPDX document,
signed DSSE in-toto/SLSA provenance payload, registry manifest, and image
signature verification report instead of accepting a generic “passed” JSON.
Those structural parses are not direct registry, legal, or operational
verification. The external receipt is the cryptographic assertion that an
independent authority performed those checks; the verifier validates that
assertion against policy outside candidate control.

## Build a promotion candidate

Do not edit a blocked draft into `eligible`. Build one immutable source commit,
then add one evidence-only commit containing a complete manifest, raw redacted
reports, and the externally signed receipt under
`docs/evidence/v1/<candidate>/`. The release process must:

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
8. have the independent authority sign the canonical receipt statement only
   after checking the registry, signatures, provenance, evidence contracts,
   review ordering, and all G1-G12 facts; and
9. run the protected `release-promotion` verifier before any preview or
   production promotion.

The Environment must define these non-secret policy variables:

- `HANDLEPLAN_RELEASE_TRUST_KEY_ID`
- `HANDLEPLAN_RELEASE_TRUST_REPOSITORY`
- `HANDLEPLAN_RELEASE_IMAGE_SIGNER`
- `HANDLEPLAN_RELEASE_PROVENANCE_SIGNER`

It must also provide the base64-encoded Ed25519 SPKI public key as the protected
secret `HANDLEPLAN_RELEASE_TRUST_PUBLIC_KEY_BASE64`. The key is public material,
but storing it as an Environment secret prevents pull-request code from reading
or replacing the active trust root. The private key remains outside GitHub and
the repository.

The `CI` workflow's optional `promotion_manifest` input runs only after normal
CI succeeds. Its separate job is bound to the protected `release-promotion`
Environment and invokes `--require-promotion`. Missing policy, a blocked draft,
an expired or forged receipt, a candidate binding mismatch, or any failed gate
causes a hard failure. Normal push and pull-request CI only tests the verifier;
it does not imply that a promotion candidate or signed receipt exists.

A later checkout cannot truthfully verify a different commit's source bytes.
Preview and production readback, backup/restore drills, registry state, and
signature verification are separate external evidence events and must not be
inferred from this repository checker.
