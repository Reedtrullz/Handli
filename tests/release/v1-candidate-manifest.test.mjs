import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

import {
  assertManifestSchema,
  canonicalReleaseTrustStatement,
  gateIds,
  requiredEvidenceProtocolByGate,
  repositoryRoot,
  verifyCandidateManifest,
  verifyManifestFile,
} from "../../scripts/release/verify-v1-candidate-manifest.mjs";
import {
  generateDraftManifest,
  writeDraftManifest,
} from "../../scripts/release/generate-v1-draft-manifest.mjs";

// Generate repository-current draft bytes in memory. Historical evidence is
// immutable and must not become a mutable fixture whenever the forward-only
// migration set advances.
const repositoryCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
const draft = generateDraftManifest({
  candidateId: "generated-current-test-draft",
  commitSha: repositoryCommit,
  createdAt: "2026-07-18T00:00:00Z",
  root: repositoryRoot,
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function write(root, path, value) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  const serialized = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(target, serialized);
  return sha256(serialized);
}

function promotionFixture() {
  const root = mkdtempSync(join(tmpdir(), "handleplan-release-manifest-"));
  const candidateId = "fixture-candidate";
  const candidateDirectory = `docs/evidence/v1/${candidateId}`;
  const trackedFiles = new Set();
  const writeTracked = (path, value) => {
    trackedFiles.add(path);
    return write(root, path, value);
  };
  const migrationSha = writeTracked("deploy/migrations/001_fixture.sql", "select 1;\n");
  const registrySha = writeTracked("docs/data/source-registry.v1.json", {
    $schema: "./source-registry.v1.schema.json",
    registryVersion: "1.0.0",
    reviewedAt: "2026-07-17",
    intendedUse: "Fixture public basket ranking and official-offer discovery",
    states: {
      approved: "Recorded permissions are accepted.",
      conditional: "Conditions remain unresolved.",
      blocked: "Use is not permitted.",
      revoked: "Prior permission is no longer valid.",
    },
    policy: {
      defaultState: "blocked",
      defaultRuntimeEnabled: false,
      publicRankingRequires: "approved",
      unknownPermissionBehavior: "blocked",
      stateChangeRequires: ["dated evidence"],
    },
    sources: [{
      id: "fixture-source",
      owner: "Fixture source owner",
      publicRankingEligible: true,
      runtimeState: "approved",
      runtimeDefaultEnabled: false,
      intendedUse: "Fixture ordinary prices and official offers",
      dataClasses: ["ordinary_price_observation", "official_offer"],
      rights: {
        access: "permitted",
        processing: "permitted",
        retention: "permitted",
        derivedDisplay: "permitted",
        redistribution: "prohibited",
        imagery: "not_applicable",
        marks: "not_applicable",
        attribution: "not_applicable",
      },
      rateLimit: "Fixture bounded rate",
      terminationRisk: "Fixture permission may be revoked",
      killSwitchKey: "source.fixture-source.enabled",
      requiredActions: ["Retain candidate-current evidence"],
      knownUnknowns: [],
      evidence: [{
        url: "https://example.test/source",
        kind: "fixture_permission",
        accessedAt: "2026-07-17",
        finding: "Fixture grants the data classes used by this isolated test.",
      }],
      revocationDisposition: "Disable the fixture source immediately.",
    }],
  });
  const chainPresenceEvidence = ["bunnpris", "rema-1000", "extra"].map((chainId) => ({
    chainId,
    url: `https://example.test/stores/${chainId}`,
    accessedAt: "2026-07-17",
    finding: `${chainId} fixture presence is independently recorded.`,
  }));
  const coverage = {
    $schema: "./launch-coverage.v1.schema.json",
    manifestVersion: "1.0.0",
    reviewedAt: "2026-07-17",
    launchDecision: "selected",
    publicClaim: "Oslo fixture coverage is selected for this isolated verifier test.",
    requiredChains: [
      { id: "bunnpris", displayName: "Bunnpris" },
      { id: "rema-1000", displayName: "REMA 1000" },
      { id: "extra", displayName: "Extra" },
    ],
    candidateRegions: [{
      id: "no-0301-oslo",
      name: "Oslo",
      municipalityCode: "0301",
      boundaryType: "municipality",
      selected: true,
      selectionStatus: "selected",
      chainPresenceEvidence,
      offerScopeEvidence: [],
      knownGaps: [],
    }],
    coverage: ["bunnpris", "rema-1000", "extra"].flatMap((chainId) => (
      ["ordinary", "official_offer"].map((priceClass) => ({
        activeSourceId: "fixture-source",
        candidateSourceIds: ["fixture-source"],
        chainId,
        coverageStatus: "verified",
        evidenceLevel: "rights_cleared_measured",
        geographicScope: "no-0301-oslo",
        refreshTargetHours: priceClass === "ordinary" ? 72 : 24,
        knownGaps: [],
        launchEligible: true,
        priceClass,
        regionId: "no-0301-oslo",
      }))
    )),
    selectionGate: {
      requiredEvidence: ["rights-cleared measured six-cell coverage"],
      passed: true,
      blockers: [],
    },
  };
  const coverageSha = writeTracked("docs/data/launch-coverage.v1.json", coverage);

  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "release-fixture@invalid.example"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Release fixture"], { cwd: root });
  execFileSync("git", ["add", "deploy", "docs/data"], { cwd: root });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "source"], {
    cwd: root,
  });
  const commitSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();

  const ociManifestPath = `${candidateDirectory}/image.oci-manifest.json`;
  const ociManifestSha = writeTracked(ociManifestPath, {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      digest: `sha256:${sha256("fixture config")}`,
      size: 128,
    },
    layers: [{
      mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
      digest: `sha256:${sha256("fixture layer")}`,
      size: 256,
    }],
  });
  const imageDigest = `sha256:${ociManifestSha}`;
  const repository = "registry.example/handleplan";
  const immutableReference = `${repository}@${imageDigest}`;
  const reviewedAt = "2026-07-17T03:00:00Z";

  const evidence = (id, kind, gateId, { registryReadback = null } = {}) => {
    const command = `verify ${id}`;
    const environment = "isolated fixture environment";
    const rawPath = `${candidateDirectory}/${id}.raw.json`;
    const rawSha = writeTracked(rawPath, {
      candidateId,
      commitSha,
      evidenceId: id,
      kind,
      result: "passed",
    });
    const artifact = `${candidateDirectory}/${id}.evidence.json`;
    const artifactSha = writeTracked(artifact, {
      contractVersion: "handleplan.release-evidence.v2",
      candidateId,
      evidenceId: id,
      kind,
      candidateCommit: commitSha,
      imageManifestDigest: imageDigest,
      status: "passed",
      command,
      environment,
      reviewedAt,
      reviewer: `fixture-${kind}-reviewer`,
      reportArtifacts: [{ path: rawPath, sha256: rawSha }],
      registryReadback,
      gateIds: [gateId],
      protocol: requiredEvidenceProtocolByGate[gateId],
    });
    return {
      id,
      status: "passed",
      command,
      environment,
      artifact,
      sha256: artifactSha,
      reviewedAt,
    };
  };
  const ciProof = evidence("ci-proof", "ci", "G10", {
    registryReadback: {
      repository,
      immutableReference,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      manifestPath: ociManifestPath,
      manifestSha256: ociManifestSha,
      observedAt: reviewedAt,
    },
  });
  const testProof = evidence("test-proof", "tests", "G2");
  const scanProof = evidence("scan-proof", "scans", "G9");
  const reviewProof = evidence("review-proof", "reviews", "G1");
  const evidenceByGate = {
    G1: [reviewProof],
    G2: [testProof],
    G3: [evidence("g3-test-proof", "tests", "G3")],
    G4: [evidence("g4-test-proof", "tests", "G4")],
    G5: [evidence("g5-test-proof", "tests", "G5")],
    G6: [evidence("g6-test-proof", "tests", "G6")],
    G7: [
      evidence("g7-test-proof", "tests", "G7"),
      evidence("g7-review-proof", "reviews", "G7"),
    ],
    G8: [
      evidence("g8-test-proof", "tests", "G8"),
      evidence("g8-review-proof", "reviews", "G8"),
    ],
    G9: [scanProof, evidence("g9-review-proof", "reviews", "G9")],
    G10: [
      ciProof,
      evidence("g10-test-proof", "tests", "G10"),
      evidence("g10-scan-proof", "scans", "G10"),
    ],
    G11: [
      evidence("g11-test-proof", "tests", "G11"),
      evidence("g11-review-proof", "reviews", "G11"),
    ],
    G12: [evidence("g12-review-proof", "reviews", "G12")],
  };
  const allGateEvidence = Object.values(evidenceByGate).flat();

  const backupReportPath = `${candidateDirectory}/backup-restore.raw.json`;
  const backupReportSha = writeTracked(backupReportPath, { result: "restored" });
  const backupArtifact = `${candidateDirectory}/backup-restore.evidence.json`;
  const backupArtifactSha = writeTracked(backupArtifact, {
    contractVersion: "handleplan.backup-restore-evidence.v1",
    candidateId,
    candidateCommit: commitSha,
    imageManifestDigest: imageDigest,
    status: "restore_verified",
    backupIdentifier: "backup-2026-07-17T02-00-00Z",
    backupCreatedAt: "2026-07-17T02:00:00Z",
    restoreTestedAt: "2026-07-17T02:30:00Z",
    reviewedAt,
    reviewer: "fixture-backup-reviewer",
    reportArtifacts: [{ path: backupReportPath, sha256: backupReportSha }],
  });

  const sbomArtifact = `${candidateDirectory}/handleplan.spdx.json`;
  const sbomSha = writeTracked(sbomArtifact, {
    SPDXID: "SPDXRef-DOCUMENT",
    spdxVersion: "SPDX-2.3",
    documentNamespace: `https://handleplan.no/security/sbom/${commitSha}/fixture`,
    packages: [{
      SPDXID: "SPDXRef-Package-Handleplan",
      name: "handleplan",
      versionInfo: commitSha,
    }],
  });
  const provenanceStatement = {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [{ name: immutableReference, digest: { sha256: ociManifestSha } }],
    predicate: {
      buildDefinition: { externalParameters: { commitSha } },
    },
  };
  const provenanceArtifact = `${candidateDirectory}/handleplan.provenance.dsse.json`;
  const provenanceSha = writeTracked(provenanceArtifact, {
    payloadType: "application/vnd.in-toto+json",
    payload: Buffer.from(JSON.stringify(provenanceStatement)).toString("base64"),
    signatures: [{ keyid: "fixture-key", sig: "Zml4dHVyZS1zaWduYXR1cmU=" }],
  });
  const signatureArtifact = `${candidateDirectory}/image-signature-verification.json`;
  const signatureSha = writeTracked(signatureArtifact, {
    contractVersion: "handleplan.image-signature-verification.v1",
    candidateId,
    candidateCommit: commitSha,
    repository,
    immutableReference,
    manifestDigest: imageDigest,
    status: "verified",
    signer: "fixture-release-identity",
    verifiedAt: reviewedAt,
    verificationCommand: `cosign verify ${immutableReference}`,
  });
  const manifest = {
    $schema: "../../../release/v1-candidate-manifest.schema.json",
    manifestVersion: "1.0.0",
    candidateId,
    mode: "promotion_candidate",
    createdAt: "2026-07-17T03:00:00Z",
    releaseDecision: "eligible",
    source: {
      commitSha,
      treeState: "clean",
      commitBinding: "source_exact_evidence_append",
    },
    image: {
      repository,
      manifestDigest: imageDigest,
      digestKind: "oci_manifest",
      immutableReference,
      registryReadbackEvidenceId: "ci-proof",
      promoted: true,
    },
    database: {
      startingState: {
        kind: "previous_release",
        identifier: "fixture-previous-release",
      },
      migrations: [{
        path: "deploy/migrations/001_fixture.sql",
        sha256: migrationSha,
      }],
    },
    sourceRegistry: {
      path: "docs/data/source-registry.v1.json",
      version: "1.0.0",
      sha256: registrySha,
    },
    coverageManifest: {
      path: "docs/data/launch-coverage.v1.json",
      version: "1.0.0",
      sha256: coverageSha,
    },
    evidence: {
      ci: allGateEvidence.filter(({ id }) => id === "ci-proof"),
      tests: allGateEvidence.filter(({ id }) => id === "test-proof" || id.includes("-test-proof")),
      scans: allGateEvidence.filter(({ id }) => id === "scan-proof" || id.includes("-scan-proof")),
      reviews: allGateEvidence.filter(({ id }) => id === "review-proof" || id.includes("-review-proof")),
    },
    backup: {
      status: "restore_verified",
      identifier: "backup-2026-07-17T02-00-00Z",
      createdAt: "2026-07-17T02:00:00Z",
      restoreTestedAt: "2026-07-17T02:30:00Z",
      artifact: backupArtifact,
      sha256: backupArtifactSha,
    },
    supportedRegions: ["no-0301-oslo"],
    attestations: {
      sbom: {
        status: "verified",
        subjectCommitSha: commitSha,
        artifact: sbomArtifact,
        sha256: sbomSha,
      },
      provenance: {
        status: "signed_verified",
        subjectCommitSha: commitSha,
        subjectManifestDigest: imageDigest,
        artifact: provenanceArtifact,
        sha256: provenanceSha,
      },
      imageSignature: {
        status: "verified",
        subjectManifestDigest: imageDigest,
        artifact: signatureArtifact,
        sha256: signatureSha,
        signer: "fixture-release-identity",
        verifiedAt: "2026-07-17T03:00:00Z",
      },
    },
    gates: gateIds.map((id) => ({
      id,
      status: "passed",
      evidenceIds: evidenceByGate[id].map(({ id: evidenceId }) => evidenceId),
    })),
    missingOrUnverifiedGateIds: [],
    limitations: [],
  };
  return { commitSha, coverage, manifest, root, trackedFiles };
}

function withPromotionFixture(callback) {
  const fixture = promotionFixture();
  try {
    return callback(fixture);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
}

function addExternalTrustReceipt(fixture, {
  expiresAt = "2026-07-17T05:00:00Z",
  keyPair = generateKeyPairSync("ed25519"),
  keyId = "fixture-release-trust-key",
  verifiedAt = "2026-07-17T04:00:00Z",
} = {}) {
  const { manifest, root, trackedFiles } = fixture;
  const manifestPath = `docs/evidence/v1/${manifest.candidateId}/release-candidate.v1.json`;
  const manifestSha256 = write(root, manifestPath, manifest);
  trackedFiles.add(manifestPath);
  const statement = {
    candidateId: manifest.candidateId,
    sourceCommitSha: manifest.source.commitSha,
    candidateManifestSha256: manifestSha256,
    repository: manifest.image.repository,
    immutableReference: manifest.image.immutableReference,
    manifestDigest: manifest.image.manifestDigest,
    verifiedAt,
    expiresAt,
    reviewer: "fixture independent release reviewer",
    checks: {
      registryReadback: "verified",
      imageSignature: {
        status: "verified",
        signer: "fixture-release-identity",
      },
      provenance: {
        status: "verified",
        signer: "fixture-provenance-identity",
      },
      gateEvidence: {
        status: "verified",
        gateIds,
      },
    },
  };
  const receiptPath = `docs/evidence/v1/${manifest.candidateId}/external-release-trust-receipt.v1.json`;
  write(root, receiptPath, {
    contractVersion: "handleplan.external-release-trust.v1",
    statement,
    signature: {
      algorithm: "ed25519",
      keyId,
      value: sign(
        null,
        Buffer.from(canonicalReleaseTrustStatement(statement), "utf8"),
        keyPair.privateKey,
      ).toString("base64"),
    },
  });
  trackedFiles.add(receiptPath);
  return {
    manifestPath,
    receiptPath,
    trustPolicy: {
      imageSigner: "fixture-release-identity",
      keyId,
      provenanceSigner: "fixture-provenance-identity",
      publicKey: keyPair.publicKey.export({ format: "pem", type: "spki" }).toString(),
      repository: manifest.image.repository,
    },
    verificationTime: new Date("2026-07-17T04:30:00Z"),
  };
}

function draftWriterFixture() {
  const root = mkdtempSync(join(tmpdir(), "handleplan-release-draft-writer-"));
  write(root, "deploy/migrations/001_fixture.sql", "select 1;\n");
  for (const path of [
    "docs/data/source-registry.v1.json",
    "docs/data/launch-coverage.v1.json",
  ]) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(repositoryRoot, path), target);
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "release-fixture@invalid.example"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Release fixture"], { cwd: root });
  execFileSync("git", ["add", "deploy", "docs"], { cwd: root });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture"], {
    cwd: root,
  });
  return root;
}

test("the draft generator derives current bindings without inventing release proof", () => {
  const generated = generateDraftManifest({
    candidateId: "generated-source-neutral-draft",
    commitSha: draft.source.commitSha,
    createdAt: "2026-07-17T04:00:00Z",
    root: repositoryRoot,
  });
  const lastMigration = generated.database.migrations.at(-1);

  assert.equal(generated.mode, "draft_unverified");
  assert.equal(generated.releaseDecision, "blocked");
  assert.equal(generated.source.commitBinding, "baseline_only");
  assert.equal(generated.image.manifestDigest, null);
  assert.deepEqual(generated.supportedRegions, []);
  assert.deepEqual(generated.missingOrUnverifiedGateIds, gateIds);
  assert.ok(generated.gates.every(({ evidenceIds, status }) => (
    status === "not_started" && evidenceIds.length === 0
  )));
  assert.equal(
    lastMigration.sha256,
    sha256(readFileSync(resolve(repositoryRoot, lastMigration.path))),
  );
  assert.equal(
    generated.sourceRegistry.sha256,
    sha256(readFileSync(resolve(repositoryRoot, generated.sourceRegistry.path))),
  );
  assert.equal(
    generated.coverageManifest.sha256,
    sha256(readFileSync(resolve(repositoryRoot, generated.coverageManifest.path))),
  );
});

test("the draft writer refuses overwrite and removes its file after binding drift", () => {
  const root = draftWriterFixture();
  try {
    const successfulPath = writeDraftManifest("writer-success", root);
    assert.equal(existsSync(resolve(root, successfulPath)), true);
    assert.throws(
      () => writeDraftManifest("writer-success", root),
      /refusing to overwrite/u,
    );

    const failedPath = "docs/evidence/v1/writer-failure/release-candidate.v1.json";
    assert.throws(
      () => writeDraftManifest("writer-failure", root, {
        beforeVerify() {
          appendFileSync(resolve(root, "deploy/migrations/001_fixture.sql"), "-- binding drift\n");
        },
      }),
      /checksum does not match repository bytes/u,
    );
    assert.equal(existsSync(resolve(root, failedPath)), false);

    const changedPath = "docs/evidence/v1/writer-changed/release-candidate.v1.json";
    assert.throws(
      () => writeDraftManifest("writer-changed", root, {
        beforeVerify({ outputPath }) {
          writeFileSync(outputPath, "{}\n");
        },
      }),
      /schema validation failed/u,
    );
    assert.equal(readFileSync(resolve(root, changedPath), "utf8"), "{}\n");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a generated repository-current draft binds files while remaining explicitly blocked", () => {
  const result = verifyCandidateManifest(draft, {
    repositoryCommit: draft.source.commitSha,
    root: repositoryRoot,
    worktreeDirty: true,
  });
  assert.deepEqual(result, {
    candidateId: "generated-current-test-draft",
    mode: "draft_unverified",
    releaseDecision: "blocked",
  });
  assert.deepEqual(draft.missingOrUnverifiedGateIds, gateIds);
  assert.equal(draft.supportedRegions.length, 0);
});

test("the schema rejects unknown fields and a digest without an algorithm", () => {
  const unknownField = structuredClone(draft);
  unknownField.release = true;
  assert.throws(() => assertManifestSchema(unknownField), /schema validation failed/u);

  const rawDigest = structuredClone(draft);
  rawDigest.image.manifestDigest = sha256("not an OCI reference");
  assert.throws(() => assertManifestSchema(rawDigest), /schema validation failed/u);
});

test("migration bindings fail on omission and byte-level checksum drift", () => {
  const omitted = structuredClone(draft);
  omitted.database.migrations.pop();
  assert.throws(
    () => verifyCandidateManifest(omitted, {
      repositoryCommit: draft.source.commitSha,
      root: repositoryRoot,
      worktreeDirty: true,
    }),
    /enumerate every repository migration/u,
  );

  const drifted = structuredClone(draft);
  const original = drifted.database.migrations[0].sha256;
  drifted.database.migrations[0].sha256 = `${original.slice(0, -1)}${original.endsWith("0") ? "1" : "0"}`;
  assert.throws(
    () => verifyCandidateManifest(drifted, {
      repositoryCommit: draft.source.commitSha,
      root: repositoryRoot,
      worktreeDirty: true,
    }),
    /checksum does not match/u,
  );
});

test("the missing-gate list is an exact fail-closed projection", () => {
  const missingGate = structuredClone(draft);
  missingGate.missingOrUnverifiedGateIds.pop();
  assert.throws(
    () => verifyCandidateManifest(missingGate, {
      repositoryCommit: draft.source.commitSha,
      root: repositoryRoot,
      worktreeDirty: true,
    }),
    /exactly list every non-passed gate/u,
  );

  const unknownEvidence = structuredClone(draft);
  unknownEvidence.gates[0].evidenceIds = ["invented-proof"];
  assert.throws(
    () => verifyCandidateManifest(unknownEvidence, {
      repositoryCommit: draft.source.commitSha,
      root: repositoryRoot,
      worktreeDirty: true,
    }),
    /references unknown evidence/u,
  );
});

test("a draft can identify an unverified backup without claiming a restore", () => {
  const identifiedBackup = structuredClone(draft);
  identifiedBackup.backup.status = "unverified";
  identifiedBackup.backup.identifier = "offsite-backup-2026-07-17T02-00-00Z";
  identifiedBackup.backup.createdAt = "2026-07-17T02:00:00Z";
  assert.equal(verifyCandidateManifest(identifiedBackup, {
    repositoryCommit: draft.source.commitSha,
    root: repositoryRoot,
    worktreeDirty: true,
  }).releaseDecision, "blocked");

  identifiedBackup.backup.restoreTestedAt = "2026-07-17T02:30:00Z";
  assert.throws(
    () => verifyCandidateManifest(identifiedBackup, {
      repositoryCommit: draft.source.commitSha,
      root: repositoryRoot,
      worktreeDirty: true,
    }),
    /no restore-verification time/u,
  );
});

test("a structurally complete fixture cannot pass without external trust", () => {
  withPromotionFixture(({ commitSha, manifest, root, trackedFiles }) => {
    const evidenceCommitSha = sha256("fixture evidence commit").slice(0, 40);
    assert.throws(
      () => verifyCandidateManifest(manifest, {
        repositoryCommit: evidenceCommitSha,
        root,
        sourceCandidateEvidencePaths: [],
        sourceCommitIsAncestor: true,
        sourceToEvidenceChangedPaths: [
          `docs/evidence/v1/${manifest.candidateId}/release-candidate.v1.json`,
        ],
        sourceToEvidenceCommitCount: 1,
        trackedFiles,
        worktreeDirty: false,
      }),
      /must add the external release trust receipt/u,
    );
  });
});

test("a current externally signed receipt unlocks only its exact promotion candidate", () => {
  withPromotionFixture((fixture) => {
    const { manifest, root, trackedFiles } = fixture;
    const evidenceCommitSha = sha256("fixture evidence commit").slice(0, 40);
    const trust = addExternalTrustReceipt(fixture);
    const result = verifyCandidateManifest(manifest, {
      manifestPath: trust.manifestPath,
      repositoryCommit: evidenceCommitSha,
      root,
      sourceCandidateEvidencePaths: [],
      sourceCommitIsAncestor: true,
      sourceToEvidenceChangedPaths: [trust.manifestPath, trust.receiptPath],
      sourceToEvidenceCommitCount: 1,
      trackedFiles,
      trustPolicy: trust.trustPolicy,
      verificationTime: trust.verificationTime,
      worktreeDirty: false,
    });
    assert.deepEqual(result, {
      candidateId: manifest.candidateId,
      mode: "promotion_candidate",
      releaseDecision: "eligible",
    });
  });
});

test("external trust rejects manifest drift, an untrusted key, and an expired receipt", () => {
  const verify = (fixture, trust, overrides = {}) => verifyCandidateManifest(fixture.manifest, {
    manifestPath: trust.manifestPath,
    repositoryCommit: sha256("fixture evidence commit").slice(0, 40),
    root: fixture.root,
    sourceCandidateEvidencePaths: [],
    sourceCommitIsAncestor: true,
    sourceToEvidenceChangedPaths: [trust.manifestPath, trust.receiptPath],
    sourceToEvidenceCommitCount: 1,
    trackedFiles: fixture.trackedFiles,
    trustPolicy: trust.trustPolicy,
    verificationTime: trust.verificationTime,
    worktreeDirty: false,
    ...overrides,
  });

  withPromotionFixture((fixture) => {
    const trust = addExternalTrustReceipt(fixture);
    fixture.manifest.createdAt = "2026-07-17T03:01:00Z";
    write(fixture.root, trust.manifestPath, fixture.manifest);
    assert.throws(() => verify(fixture, trust), /not bound to the candidate manifest and image/u);
  });

  withPromotionFixture((fixture) => {
    const trust = addExternalTrustReceipt(fixture);
    const otherKey = generateKeyPairSync("ed25519");
    trust.trustPolicy.publicKey = otherKey.publicKey
      .export({ format: "pem", type: "spki" }).toString();
    assert.throws(() => verify(fixture, trust), /signature is invalid/u);
  });

  withPromotionFixture((fixture) => {
    const trust = addExternalTrustReceipt(fixture, {
      expiresAt: "2026-07-17T04:15:00Z",
    });
    assert.throws(() => verify(fixture, trust), /not current within its bounded validity window/u);
  });
});

test("promotion requires one append-only evidence commit after the immutable source", () => {
  withPromotionFixture(({ commitSha, manifest, root, trackedFiles }) => {
    const baseOptions = {
      repositoryCommit: sha256("fixture evidence commit").slice(0, 40),
      root,
      sourceCandidateEvidencePaths: [],
      sourceCommitIsAncestor: true,
      sourceToEvidenceChangedPaths: [
        `docs/evidence/v1/${manifest.candidateId}/release-candidate.v1.json`,
        `docs/evidence/v1/${manifest.candidateId}/external-release-trust-receipt.v1.json`,
      ],
      sourceToEvidenceCommitCount: 1,
      trackedFiles,
      worktreeDirty: false,
    };

    assert.throws(
      () => verifyCandidateManifest(manifest, {
        ...baseOptions,
        repositoryCommit: commitSha,
      }),
      /distinct source commit followed by one evidence commit/u,
    );
    assert.throws(
      () => verifyCandidateManifest(manifest, {
        ...baseOptions,
        sourceToEvidenceCommitCount: 2,
      }),
      /exactly one evidence commit/u,
    );
    assert.throws(
      () => verifyCandidateManifest(manifest, {
        ...baseOptions,
        sourceCandidateEvidencePaths: [
          `docs/evidence/v1/${manifest.candidateId}/preexisting.json`,
        ],
      }),
      /must not pre-exist in the source commit/u,
    );
    assert.throws(
      () => verifyCandidateManifest(manifest, {
        ...baseOptions,
        sourceToEvidenceChangedPaths: [
          `docs/evidence/v1/${manifest.candidateId}/release-candidate.v1.json`,
          `docs/evidence/v1/${manifest.candidateId}/external-release-trust-receipt.v1.json`,
          "apps/web/app/page.tsx",
        ],
      }),
      /may change only its candidate evidence directory/u,
    );
  });
});

test("file verification derives the one-commit source-to-evidence boundary from Git", () => {
  withPromotionFixture((fixture) => {
    const { manifest, root } = fixture;
    const trust = addExternalTrustReceipt(fixture);
    execFileSync("git", ["add", "docs/evidence"], { cwd: root });
    execFileSync(
      "git",
      ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "evidence"],
      { cwd: root },
    );

    assert.equal(verifyManifestFile(trust.manifestPath, root, {
      requirePromotion: true,
      trustPolicy: trust.trustPolicy,
      verificationTime: trust.verificationTime,
    }).releaseDecision, "eligible");
  });
});

test("promotion workflow mode rejects the blocked draft before verification", () => {
  assert.throws(
    () => verifyManifestFile(
      "docs/evidence/v1/v1-source-neutral-cross-browser-remediation-2026-07-17/release-candidate.v1.json",
      repositoryRoot,
      { requirePromotion: true },
    ),
    /not an eligible promotion_candidate manifest/u,
  );
});

test("a generic CI result cannot stand in for gate-specific manual evidence", () => {
  withPromotionFixture(({ commitSha, manifest, root, trackedFiles }) => {
    manifest.gates[0].evidenceIds = ["ci-proof"];
    assert.throws(
      () => verifyCandidateManifest(manifest, {
        repositoryCommit: commitSha,
        root,
        trackedFiles,
        worktreeDirty: false,
      }),
      /G1 lacks passed reviews evidence/u,
    );
  });
});

test("a valid evidence kind cannot be reused outside its gate protocol", () => {
  withPromotionFixture(({ commitSha, manifest, root, trackedFiles }) => {
    const review = manifest.evidence.reviews[0];
    const wrapper = JSON.parse(readFileSync(join(root, review.artifact), "utf8"));
    wrapper.gateIds = ["G2"];
    wrapper.protocol = requiredEvidenceProtocolByGate.G2;
    review.sha256 = write(root, review.artifact, wrapper);

    assert.throws(
      () => verifyCandidateManifest(manifest, {
        repositoryCommit: commitSha,
        root,
        trackedFiles,
        worktreeDirty: false,
      }),
      /G1 references evidence outside its gate-specific protocol contract/u,
    );
  });
});

test("promotion validates bound policy schemas and source-to-coverage relationships", () => {
  withPromotionFixture(({ commitSha, coverage, manifest, root, trackedFiles }) => {
    delete coverage.publicClaim;
    manifest.coverageManifest.sha256 = write(
      root,
      manifest.coverageManifest.path,
      coverage,
    );
    assert.throws(
      () => verifyCandidateManifest(manifest, {
        repositoryCommit: commitSha,
        root,
        trackedFiles,
        worktreeDirty: false,
      }),
      /coverage manifest schema validation failed/u,
    );
  });

  withPromotionFixture(({ commitSha, coverage, manifest, root, trackedFiles }) => {
    coverage.coverage[0].candidateSourceIds = ["different-source"];
    manifest.coverageManifest.sha256 = write(
      root,
      manifest.coverageManifest.path,
      coverage,
    );
    assert.throws(
      () => verifyCandidateManifest(manifest, {
        repositoryCommit: commitSha,
        root,
        trackedFiles,
        worktreeDirty: false,
      }),
      /active source is outside its candidate set/u,
    );
  });

  withPromotionFixture(({ commitSha, coverage, manifest, root, trackedFiles }) => {
    coverage.selectionGate.blockers = ["unresolved fixture blocker"];
    manifest.coverageManifest.sha256 = write(
      root,
      manifest.coverageManifest.path,
      coverage,
    );
    assert.throws(
      () => verifyCandidateManifest(manifest, {
        repositoryCommit: commitSha,
        root,
        trackedFiles,
        worktreeDirty: false,
      }),
      /passed selected launch-coverage decision/u,
    );
  });

  withPromotionFixture(({ commitSha, manifest, root, trackedFiles }) => {
    const registry = JSON.parse(readFileSync(
      join(root, manifest.sourceRegistry.path),
      "utf8",
    ));
    registry.sources[0].dataClasses = ["ordinary_price_observation"];
    manifest.sourceRegistry.sha256 = write(
      root,
      manifest.sourceRegistry.path,
      registry,
    );
    assert.throws(
      () => verifyCandidateManifest(manifest, {
        repositoryCommit: commitSha,
        root,
        trackedFiles,
        worktreeDirty: false,
      }),
      /source lacks official_offer/u,
    );
  });

  withPromotionFixture(({ commitSha, manifest, root, trackedFiles }) => {
    const registry = JSON.parse(readFileSync(
      join(root, manifest.sourceRegistry.path),
      "utf8",
    ));
    registry.sources[0].rights.processing = "unknown";
    manifest.sourceRegistry.sha256 = write(
      root,
      manifest.sourceRegistry.path,
      registry,
    );
    assert.throws(
      () => verifyCandidateManifest(manifest, {
        repositoryCommit: commitSha,
        root,
        trackedFiles,
        worktreeDirty: false,
      }),
      /source has unresolved processing rights/u,
    );
  });

  withPromotionFixture(({ commitSha, manifest, root, trackedFiles }) => {
    const registry = JSON.parse(readFileSync(
      join(root, manifest.sourceRegistry.path),
      "utf8",
    ));
    registry.sources[0].knownUnknowns = ["Unresolved fixture redistribution term"];
    manifest.sourceRegistry.sha256 = write(
      root,
      manifest.sourceRegistry.path,
      registry,
    );
    assert.throws(
      () => verifyCandidateManifest(manifest, {
        repositoryCommit: commitSha,
        root,
        trackedFiles,
        worktreeDirty: false,
      }),
      /source still declares rights unknowns/u,
    );
  });
});

test("promotion evidence must be candidate-local, tracked, and record-specific", () => {
  withPromotionFixture(({ commitSha, manifest, root, trackedFiles }) => {
    trackedFiles.delete(manifest.evidence.tests[0].artifact);
    assert.throws(
      () => verifyCandidateManifest(manifest, {
        repositoryCommit: commitSha,
        root,
        trackedFiles,
        worktreeDirty: false,
      }),
      /is not a tracked blob at candidate HEAD/u,
    );
  });

  withPromotionFixture(({ commitSha, manifest, root, trackedFiles }) => {
    const review = manifest.evidence.reviews[0];
    const otherPath = "docs/evidence/v1/other-candidate/review-proof.evidence.json";
    review.sha256 = write(root, otherPath, readFileSync(join(root, review.artifact), "utf8"));
    review.artifact = otherPath;
    trackedFiles.add(otherPath);
    assert.throws(
      () => verifyCandidateManifest(manifest, {
        repositoryCommit: commitSha,
        root,
        trackedFiles,
        worktreeDirty: false,
      }),
      /must live under docs\/evidence\/v1\/fixture-candidate/u,
    );
  });

  withPromotionFixture(({ commitSha, manifest, root, trackedFiles }) => {
    manifest.evidence.tests[0].artifact = manifest.evidence.ci[0].artifact;
    manifest.evidence.tests[0].sha256 = manifest.evidence.ci[0].sha256;
    assert.throws(
      () => verifyCandidateManifest(manifest, {
        repositoryCommit: commitSha,
        root,
        trackedFiles,
        worktreeDirty: false,
      }),
      /wrapper is not bound to this candidate and evidence record/u,
    );
  });

  withPromotionFixture(({ commitSha, manifest, root, trackedFiles }) => {
    const scan = manifest.evidence.scans[0];
    const wrapper = JSON.parse(readFileSync(join(root, scan.artifact), "utf8"));
    wrapper.candidateCommit = sha256("unrelated commit").slice(0, 40);
    scan.sha256 = write(root, scan.artifact, wrapper);
    assert.throws(
      () => verifyCandidateManifest(manifest, {
        repositoryCommit: commitSha,
        root,
        trackedFiles,
        worktreeDirty: false,
      }),
      /wrapper is not bound to this candidate and evidence record/u,
    );
  });

  withPromotionFixture(({ commitSha, manifest, root, trackedFiles }) => {
    const ciWrapper = JSON.parse(readFileSync(
      join(root, manifest.evidence.ci[0].artifact),
      "utf8",
    ));
    const testEntry = manifest.evidence.tests[0];
    const testWrapper = JSON.parse(readFileSync(join(root, testEntry.artifact), "utf8"));
    testWrapper.reportArtifacts = ciWrapper.reportArtifacts;
    testEntry.sha256 = write(root, testEntry.artifact, testWrapper);
    assert.throws(
      () => verifyCandidateManifest(manifest, {
        repositoryCommit: commitSha,
        root,
        trackedFiles,
        worktreeDirty: false,
      }),
      /must not reuse one raw report/u,
    );
  });
});

test("registry readback hashes must identify actual OCI image-manifest bytes", () => {
  withPromotionFixture(({ commitSha, manifest, root, trackedFiles }) => {
    const ci = manifest.evidence.ci[0];
    const wrapper = JSON.parse(readFileSync(join(root, ci.artifact), "utf8"));
    const manifestPath = wrapper.registryReadback.manifestPath;
    const nonOciSha = write(root, manifestPath, { result: "not-an-oci-manifest" });
    const nonOciDigest = `sha256:${nonOciSha}`;
    const nonOciReference = `${manifest.image.repository}@${nonOciDigest}`;
    manifest.image.manifestDigest = nonOciDigest;
    manifest.image.immutableReference = nonOciReference;
    wrapper.imageManifestDigest = nonOciDigest;
    wrapper.registryReadback.manifestSha256 = nonOciSha;
    wrapper.registryReadback.immutableReference = nonOciReference;
    ci.sha256 = write(root, ci.artifact, wrapper);
    assert.throws(
      () => verifyCandidateManifest(manifest, {
        repositoryCommit: commitSha,
        root,
        trackedFiles,
        worktreeDirty: false,
      }),
      /registry bytes are not an OCI image manifest/u,
    );
  });
});

test("promotion rejects dirty source, placeholders, and dummy OCI digests", () => {
  withPromotionFixture(({ commitSha, manifest, root, trackedFiles }) => {
    const dirty = structuredClone(manifest);
    assert.throws(
      () => verifyCandidateManifest(dirty, {
        repositoryCommit: commitSha,
        root,
        worktreeDirty: true,
      }),
      /dirty worktree cannot be a promotion candidate/u,
    );

    const placeholder = structuredClone(manifest);
    placeholder.evidence.ci[0].command = "TODO verify release";
    assert.throws(
      () => verifyCandidateManifest(placeholder, {
        repositoryCommit: commitSha,
        root,
        trackedFiles,
        worktreeDirty: false,
      }),
      /contains placeholder text/u,
    );

    const dummyDigest = structuredClone(manifest);
    dummyDigest.image.manifestDigest = `sha256:${"a".repeat(64)}`;
    dummyDigest.image.immutableReference = `registry.example/handleplan@${dummyDigest.image.manifestDigest}`;
    assert.throws(
      () => verifyCandidateManifest(dummyDigest, {
        repositoryCommit: commitSha,
        root,
        trackedFiles,
        worktreeDirty: false,
      }),
      /ambiguous repeated-character digest/u,
    );
  });
});

test("promotion rejects unverified recovery and attestations for another image", () => {
  withPromotionFixture(({ commitSha, manifest, root, trackedFiles }) => {
    const unverifiedBackup = structuredClone(manifest);
    unverifiedBackup.backup.status = "unverified";
    unverifiedBackup.backup.restoreTestedAt = null;
    const backupWrapper = JSON.parse(readFileSync(
      join(root, unverifiedBackup.backup.artifact),
      "utf8",
    ));
    backupWrapper.status = "unverified";
    backupWrapper.restoreTestedAt = null;
    unverifiedBackup.backup.sha256 = write(
      root,
      unverifiedBackup.backup.artifact,
      backupWrapper,
    );
    assert.throws(
      () => verifyCandidateManifest(unverifiedBackup, {
        repositoryCommit: commitSha,
        root,
        trackedFiles,
        worktreeDirty: false,
      }),
      /restore-verified backup/u,
    );
  });

  withPromotionFixture(({ commitSha, manifest, root, trackedFiles }) => {
    const unsignedProvenance = structuredClone(manifest);
    unsignedProvenance.attestations.provenance.status = "unsigned";
    const provenanceEnvelope = JSON.parse(readFileSync(
      join(root, unsignedProvenance.attestations.provenance.artifact),
      "utf8",
    ));
    const unsignedStatement = JSON.parse(
      Buffer.from(provenanceEnvelope.payload, "base64").toString("utf8"),
    );
    unsignedProvenance.attestations.provenance.sha256 = write(
      root,
      unsignedProvenance.attestations.provenance.artifact,
      unsignedStatement,
    );
    assert.throws(
      () => verifyCandidateManifest(unsignedProvenance, {
        repositoryCommit: commitSha,
        root,
        trackedFiles,
        worktreeDirty: false,
      }),
      /signed and verified provenance/u,
    );
  });

  withPromotionFixture(({ commitSha, manifest, root, trackedFiles }) => {
    const wrongSignatureSubject = structuredClone(manifest);
    wrongSignatureSubject.attestations.imageSignature.subjectManifestDigest = (
      `sha256:${sha256("another OCI manifest")}`
    );
    assert.throws(
      () => verifyCandidateManifest(wrongSignatureSubject, {
        repositoryCommit: commitSha,
        root,
        trackedFiles,
        worktreeDirty: false,
      }),
      /subject must equal the candidate OCI manifest digest/u,
    );
  });

  withPromotionFixture(({ commitSha, manifest, root, trackedFiles }) => {
    const wrongProvenanceSubject = structuredClone(manifest);
    wrongProvenanceSubject.attestations.provenance.subjectManifestDigest = (
      `sha256:${sha256("unrelated provenance subject")}`
    );
    assert.throws(
      () => verifyCandidateManifest(wrongProvenanceSubject, {
        repositoryCommit: commitSha,
        root,
        trackedFiles,
        worktreeDirty: false,
      }),
      /provenance subject must equal the candidate OCI manifest digest/u,
    );
  });
});

test("promotion fails when selected coverage is not rights-cleared", () => {
  withPromotionFixture(({ commitSha, coverage, manifest, root, trackedFiles }) => {
    coverage.coverage[0].evidenceLevel = "measured";
    manifest.coverageManifest.sha256 = write(
      root,
      "docs/data/launch-coverage.v1.json",
      coverage,
    );
    assert.throws(
      () => verifyCandidateManifest(manifest, {
        repositoryCommit: commitSha,
        root,
        trackedFiles,
        worktreeDirty: false,
      }),
      /is not launch-eligible/u,
    );
  });
});
