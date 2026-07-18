import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertManifestSchema,
  gateIds,
  repositoryRoot,
  verifyCandidateManifest,
  verifyManifestFile,
} from "./verify-v1-candidate-manifest.mjs";

const candidateIdPattern = /^[a-z0-9][a-z0-9.-]{2,79}$/u;
const sourceRegistryPath = "docs/data/source-registry.v1.json";
const coverageManifestPath = "docs/data/launch-coverage.v1.json";

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function versionedBinding(root, path, versionField) {
  const absolutePath = resolve(root, path);
  const document = JSON.parse(readFileSync(absolutePath, "utf8"));
  const version = document[versionField];
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`${path} has no ${versionField}`);
  }
  return { path, version, sha256: sha256File(absolutePath) };
}

function migrationBindings(root) {
  return readdirSync(resolve(root, "deploy/migrations"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d{3}_[a-z0-9_]+\.sql$/u.test(entry.name))
    .map((entry) => `deploy/migrations/${entry.name}`)
    .sort((left, right) => left.localeCompare(right))
    .map((path) => ({ path, sha256: sha256File(resolve(root, path)) }));
}

function evidenceEntry(id, command, environment) {
  return {
    id,
    status: "unverified",
    command,
    environment,
    artifact: null,
    sha256: null,
    reviewedAt: null,
  };
}

export function generateDraftManifest({ candidateId, commitSha, createdAt, root = repositoryRoot }) {
  if (!candidateIdPattern.test(candidateId)) {
    throw new Error("candidate ID must be 3-80 lowercase letters, digits, dots, or hyphens");
  }
  if (!/^[0-9a-f]{40}$/u.test(commitSha)) {
    throw new Error("commit SHA must be a full lowercase Git SHA-1");
  }

  const manifest = {
    $schema: "../../../release/v1-candidate-manifest.schema.json",
    manifestVersion: "1.0.0",
    candidateId,
    mode: "draft_unverified",
    createdAt,
    releaseDecision: "blocked",
    source: {
      commitSha,
      treeState: "dirty",
      commitBinding: "baseline_only",
    },
    image: {
      repository: null,
      manifestDigest: null,
      digestKind: "oci_manifest",
      immutableReference: null,
      registryReadbackEvidenceId: null,
      promoted: false,
    },
    database: {
      startingState: { kind: "unverified", identifier: null },
      migrations: migrationBindings(root),
    },
    sourceRegistry: versionedBinding(root, sourceRegistryPath, "registryVersion"),
    coverageManifest: versionedBinding(root, coverageManifestPath, "manifestVersion"),
    evidence: {
      ci: [
        evidenceEntry(
          "candidate-ci",
          "corepack pnpm install --frozen-lockfile && corepack pnpm lint && corepack pnpm typecheck && corepack pnpm test && corepack pnpm build",
          "candidate-current GitHub Actions runner",
        ),
      ],
      tests: [
        evidenceEntry(
          "database-acceptance",
          "node tests/acceptance/prove-database-upgrade.mjs",
          "candidate-current CI PostgreSQL",
        ),
        evidenceEntry(
          "browser-acceptance",
          "corepack pnpm e2e",
          "candidate-current production build in Chromium, Firefox, and WebKit",
        ),
        evidenceEntry(
          "regional-basket-oracle",
          "candidate release regional basket reconciliation protocol",
          "rights-cleared supported-region corpus",
        ),
      ],
      scans: [
        evidenceEntry(
          "dependency-and-secret-scans",
          "corepack pnpm security:audit && corepack pnpm security:licenses && corepack pnpm security:secrets",
          "candidate-current frozen dependency graph and repository",
        ),
        evidenceEntry(
          "container-scan",
          "trivy image --exit-code 1 --severity HIGH,CRITICAL $HANDLEPLAN_IMMUTABLE_IMAGE",
          "candidate-current immutable registry image",
        ),
        evidenceEntry(
          "supply-chain-attestations",
          "corepack pnpm security:sbom && corepack pnpm security:provenance",
          "candidate-current CI build from an exact git archive",
        ),
      ],
      reviews: [
        evidenceEntry(
          "manual-rights-legal-device-reviews",
          "candidate release manual rights, legal, governance, accessibility, device, and basket review protocols",
          "named candidate-current reviewers and physical devices where required",
        ),
      ],
    },
    backup: {
      status: "missing",
      identifier: null,
      createdAt: null,
      restoreTestedAt: null,
      artifact: null,
      sha256: null,
    },
    supportedRegions: [],
    attestations: {
      sbom: {
        status: "missing",
        subjectCommitSha: null,
        artifact: null,
        sha256: null,
      },
      provenance: {
        status: "missing",
        subjectCommitSha: null,
        subjectManifestDigest: null,
        artifact: null,
        sha256: null,
      },
      imageSignature: {
        status: "missing",
        subjectManifestDigest: null,
        artifact: null,
        sha256: null,
        signer: null,
        verifiedAt: null,
      },
    },
    gates: gateIds.map((id) => ({
      id,
      status: "not_started",
      evidenceIds: [],
    })),
    missingOrUnverifiedGateIds: [...gateIds],
    limitations: [
      "This generated file records a dirty working-tree milestone; the commit is a baseline only and does not identify the uncommitted source bytes.",
      "No immutable OCI manifest digest has been built, scanned, signed, promoted, or read back from preview or production.",
      "No candidate-current CI, full browser matrix, live PostgreSQL migration, or regional basket artifact is retained here.",
      "No encrypted off-host backup identifier or isolated restore evidence exists.",
      "No retained verified SBOM, signed provenance, or verified image signature exists.",
      "The bound coverage manifest selects no supported launch region.",
      "All twelve public-release gates are not started for this candidate.",
      "Promotion verification is intentionally unsupported until source and evidence commits are split, registry and signature proofs are verified independently, and G1-G12 have gate-specific evidence contracts.",
      "This draft is not a release, deployment record, or public-launch authorization.",
    ],
  };

  assertManifestSchema(manifest);
  verifyCandidateManifest(manifest, {
    repositoryCommit: commitSha,
    root,
    worktreeDirty: true,
  });
  return manifest;
}

export function writeDraftManifest(
  candidateId,
  root = repositoryRoot,
  { beforeVerify } = {},
) {
  const relativePath = `docs/evidence/v1/${candidateId}/release-candidate.v1.json`;
  const outputPath = resolve(root, relativePath);
  if (existsSync(outputPath)) {
    throw new Error(`refusing to overwrite existing candidate manifest: ${relativePath}`);
  }
  const commitSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const manifest = generateDraftManifest({
    candidateId,
    commitSha,
    createdAt: new Date().toISOString(),
    root,
  });
  const serializedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serializedManifest, { flag: "wx" });
  const createdFile = statSync(outputPath);
  try {
    beforeVerify?.({ manifest, outputPath, relativePath });
    verifyManifestFile(relativePath, root);
  } catch (error) {
    try {
      const currentFile = statSync(outputPath);
      const stillGeneratedBytes = readFileSync(outputPath, "utf8") === serializedManifest;
      if (
        currentFile.dev === createdFile.dev
        && currentFile.ino === createdFile.ino
        && stillGeneratedBytes
      ) {
        unlinkSync(outputPath);
      }
    } catch {
      // The created file is absent or unreadable; do not mask the verification failure.
    }
    throw error;
  }
  return relativePath;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const argumentsAfterSeparator = process.argv[2] === "--"
    ? process.argv.slice(3)
    : process.argv.slice(2);
  if (argumentsAfterSeparator.length !== 1) {
    throw new Error("usage: generate-v1-draft-manifest.mjs <candidate-id>");
  }
  const output = writeDraftManifest(argumentsAfterSeparator[0], repositoryRoot);
  process.stdout.write(`blocked-draft-written path=${output}\n`);
}
