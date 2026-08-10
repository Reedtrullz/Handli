# Source and build supply-chain controls

**Status:** repository control for the protected alpha; not a legal opinion,
penetration test, signed attestation, immutable image promotion, or production
VPS/Cloudflare assessment.

## Automated checks

The frozen pnpm install is followed by four fail-closed CI checks:

1. `pnpm audit --audit-level high` asks the configured registry for known high
   and critical advisories. Registry failure is not ignored. It is a current
   registry result, not proof that an undisclosed vulnerability does not exist.
2. `pnpm security:licenses` walks the installed dependency graph reachable from
   the root and every workspace (so stale pnpm-store entries cannot enter the
   result), enumerates unique package manifests,
   rejects undeclared/new license expressions, and compares the portable result
   and full lockfile digest to the reviewed inventory in
   `third-party-licenses.v1.json`. This makes an optional package for a different
   platform a review-visible inventory change even when it is not installed on
   the current runner. Platform-native packages vary between macOS development
   and Linux CI, so they must instead
   match an exact package name, version, and license rule in the policy. The
   Docker builder repeats this check against its actual Alpine dependency tree;
   a host-native package cannot stand in for the production set. The allowlist
   records technical review scope only. In particular, LGPL, MPL, and Creative
   Commons notices and distribution obligations still need candidate legal
   review.
3. `pnpm security:secrets` scans every tracked and non-ignored repository file,
   including text hidden behind a media extension or NUL byte, for
   high-confidence credential formats and non-fixture assignments.
   It reports only file, line, and rule—not the matched value. This does not
   inspect Git history, GitHub settings, container layers, the VPS, Cloudflare,
   1Password, provider dashboards, or unknown token formats.
4. `pnpm security:sbom` creates a revision-bound SPDX 2.3 source/dependency
   SBOM from installed package manifests. CI exports the built image as a
   loadable Docker archive, and `pnpm security:provenance` creates an unsigned
   in-toto/SLSA-shaped build statement binding that archive digest to the exact
   Git revision and pinned base digest. CI uploads a seven-day deployment bundle
   containing the Docker archive, exact source archive, SBOM, unsigned
   provenance, and a fixed-format manifest that binds their SHA-256 values, the
   Docker config digest, commit, CI run ID, and run attempt. This is an
   exact-build preview handoff, not a signed attestation or immutable release
   promotion, so release-grade provenance remains open.

## Docker build v1

Immediately before the container build, CI verifies `HEAD` is the requested
full SHA and creates the Docker context with `git archive` from that commit.
Generated, dirty, ignored, and untracked worktree files therefore cannot enter
the build. The build input is the exact commit, `Dockerfile`, frozen lockfile,
workspace manifests, and the Node base image pinned in `Dockerfile`. CI passes
the full Git SHA as `APP_COMMIT_SHA`, exports the local image as a Docker
archive, and generates the unsigned statement without copying environment variables,
credentials, request data, or runner metadata beyond the numeric run ID.

The protected preview workflow can download only the artifact name for the
triggering successful CI run, commit, and run attempt. Before any VPS credential
is read, it requires the five exact files, verifies all four artifact hashes and
the provenance subject/commit, independently reproduces the exact Git archive
from its checked-out commit, bounds both archives, loads the image locally,
and compares its config digest and revision label to the manifest. The VPS
first requires the manifest SHA-256 passed through the pinned-host-key SSH
channel, then repeats the fixed-manifest, run identity, size, and artifact
SHA-256 checks before `docker image load`, then repeats the config-digest and
revision-label checks
after load. Runtime readback also compares every current container's image ID
to that loaded digest. No Docker build runs on the VPS; the checked source
archive supplies only the exact Compose, migration, and rollback definitions.
The VPS independently reproduces and hashes the same archive from its freshly
fetched `origin/main` commit before using those definitions.

The Docker config digest plus Docker-archive SHA-256 identify the exact bytes
used by this handoff. They are not a registry OCI manifest digest, signature,
transparency-log entry, or proof that GitHub/VPS access controls are correctly
configured. Those remain promotion gates.

On push CI, after the full current migration chain has expanded the real
PostgreSQL service schema, CI also builds the exact first-parent Git archive as
a separate image. It starts only that previous web process with the read-only
`handleplan_web` role, waits at most two minutes for both revision-bound
liveness and database readiness, requires zero restarts, and removes the
container. This is an executable one-version schema-compatibility proof. It is
not a registry image, a rollback drill, or evidence that an older-than-parent
release remains compatible.

## Change policy

- A lockfile change and its refreshed committed license inventory must land in
  the same commit. Review every new license expression before committing, and
  run `pnpm security:licenses:write` followed by `pnpm security:licenses` after
  the final frozen install. Push CI builds the exact first-parent commit as the
  previous application image; splitting the lockfile and inventory across two
  commits therefore creates an intentionally unbuildable intermediate revision
  and must not be used as the release branch workflow.
- No vulnerability ignore, license exception, secret-scan bypass, or weakened
  severity threshold may be added without a dated rationale and owner.
- Candidate release evidence must retain the SPDX document, signed provenance,
  immutable promoted image digest, scan reports, commands, and review outcome.
  The current seven-day unsigned CI bundle does not satisfy that release
  requirement.
- The [candidate-manifest verifier](../runbooks/release-candidate-manifest.md)
  binds retained artifacts, migration and policy-document checksums, an OCI
  manifest digest, signatures, backup identity, coverage, and all twelve release
  gates. Its draft mode records missing proof; it does not turn the unsigned CI
  build statement into promotable provenance. Promotion additionally requires
  a short-lived Ed25519 receipt bound to the exact manifest and verified against
  registry/signer policy from the protected release Environment. No current
  candidate has that receipt or the external facts it must attest.
