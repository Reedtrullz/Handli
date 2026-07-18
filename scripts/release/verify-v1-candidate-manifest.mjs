import { execFileSync } from "node:child_process";
import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import {
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const gateIds = Object.freeze([
  "G1",
  "G2",
  "G3",
  "G4",
  "G5",
  "G6",
  "G7",
  "G8",
  "G9",
  "G10",
  "G11",
  "G12",
]);
const requiredChainIds = Object.freeze(["bunnpris", "rema-1000", "extra"]);
const requiredEvidenceKindsByGate = Object.freeze({
  G1: ["reviews"],
  G2: ["tests"],
  G3: ["tests"],
  G4: ["tests"],
  G5: ["tests"],
  G6: ["tests"],
  G7: ["tests", "reviews"],
  G8: ["tests", "reviews"],
  G9: ["scans", "reviews"],
  G10: ["ci", "tests", "scans"],
  G11: ["tests", "reviews"],
  G12: ["reviews"],
});
export const requiredEvidenceProtocolByGate = Object.freeze({
  G1: "handleplan.gate-evidence.source-rights.v1",
  G2: "handleplan.gate-evidence.declared-coverage.v1",
  G3: "handleplan.gate-evidence.data-truth.v1",
  G4: "handleplan.gate-evidence.planner-correctness.v1",
  G5: "handleplan.gate-evidence.three-chain.v1",
  G6: "handleplan.gate-evidence.travel-privacy.v1",
  G7: "handleplan.gate-evidence.offline-shopping.v1",
  G8: "handleplan.gate-evidence.accessibility.v1",
  G9: "handleplan.gate-evidence.security-privacy-legal.v1",
  G10: "handleplan.gate-evidence.operations.v1",
  G11: "handleplan.gate-evidence.real-baskets.v1",
  G12: "handleplan.gate-evidence.public-good-governance.v1",
});

const schema = JSON.parse(readFileSync(
  resolve(repositoryRoot, "docs/release/v1-candidate-manifest.schema.json"),
  "utf8",
));
const sourceRegistrySchema = JSON.parse(readFileSync(
  resolve(repositoryRoot, "docs/data/source-registry.v1.schema.json"),
  "utf8",
));
const coverageManifestSchema = JSON.parse(readFileSync(
  resolve(repositoryRoot, "docs/data/launch-coverage.v1.schema.json"),
  "utf8",
));
const externalTrustReceiptSchema = JSON.parse(readFileSync(
  resolve(repositoryRoot, "docs/release/v1-external-trust-receipt.schema.json"),
  "utf8",
));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateSchema = ajv.compile(schema);
const validateSourceRegistrySchema = ajv.compile(sourceRegistrySchema);
const validateCoverageManifestSchema = ajv.compile(coverageManifestSchema);
const validateExternalTrustReceiptSchema = ajv.compile(externalTrustReceiptSchema);
const placeholderPattern = /(?:^|[^a-z0-9])(todo|tbd|placeholder|replace[-_ ]?me|fill[-_ ]?me)(?:$|[^a-z0-9])/iu;
const migrationNamePattern = /^\d{3}_[a-z0-9_]+\.sql$/u;
const repositoryImagePattern = /^[a-z0-9.-]+(?::[1-9]\d{0,4})?\/(?:[a-z0-9._-]+\/)*[a-z0-9._-]+$/u;
const releaseTrustReceiptFilename = "external-release-trust-receipt.v1.json";
const releaseTrustMaximumValidityMilliseconds = 24 * 60 * 60 * 1_000;

function fail(message) {
  throw new Error(`candidate manifest rejected: ${message}`);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertUnambiguousDigest(value, label) {
  const digest = value.startsWith("sha256:") ? value.slice(7) : value;
  if (!/^[0-9a-f]{64}$/u.test(digest)) fail(`${label} is not a lowercase SHA-256 digest`);
  if (/^([0-9a-f])\1{63}$/u.test(digest)) fail(`${label} is an ambiguous repeated-character digest`);
}

function checkedRepositoryFile(root, relativePath, label) {
  if (
    relativePath.includes("\\")
    || relativePath.includes("\0")
    || relativePath.startsWith("/")
    || relativePath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(`${label} must be a normalized repository-relative path`);
  }

  const rootPath = realpathSync(root);
  const candidate = resolve(rootPath, relativePath);
  let actual;
  try {
    actual = realpathSync(candidate);
  } catch {
    fail(`${label} does not exist: ${relativePath}`);
  }
  if (actual !== rootPath && !actual.startsWith(`${rootPath}${sep}`)) {
    fail(`${label} escapes the repository: ${relativePath}`);
  }
  if (!statSync(actual).isFile()) fail(`${label} is not a regular file: ${relativePath}`);
  if (relative(rootPath, actual).split(sep).join("/") !== relativePath) {
    fail(`${label} must not traverse a symlink or use a non-canonical path`);
  }
  return actual;
}

function assertFileBinding(root, binding, label) {
  assertUnambiguousDigest(binding.sha256, `${label} checksum`);
  const path = checkedRepositoryFile(root, binding.path ?? binding.artifact, label);
  if (sha256File(path) !== binding.sha256) fail(`${label} checksum does not match repository bytes`);
}

function assertTrackedPromotionPath(path, label, promotion, trackedFiles) {
  if (promotion && !trackedFiles.has(path)) fail(`${label} is not a tracked blob at candidate HEAD`);
}

function assertCandidateEvidencePath(path, manifest, label, promotion, trackedFiles) {
  const prefix = `docs/evidence/v1/${manifest.candidateId}/`;
  if (!path.startsWith(prefix)) fail(`${label} must live under ${prefix}`);
  assertTrackedPromotionPath(path, label, promotion, trackedFiles);
}

function readBoundJson(root, binding, label) {
  assertFileBinding(root, binding, label);
  return JSON.parse(readFileSync(resolve(root, binding.path), "utf8"));
}

function assertExactKeys(value, expectedKeys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} has unexpected or missing fields`);
  }
}

export function canonicalReleaseTrustStatement(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("external trust statement contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalReleaseTrustStatement(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalReleaseTrustStatement(value[key])}`
    )).join(",")}}`;
  }
  fail("external trust statement contains a non-JSON value");
}

export function releaseTrustPolicyFromEnvironment(environment = process.env) {
  const required = {
    imageSigner: environment.HANDLEPLAN_RELEASE_IMAGE_SIGNER,
    keyId: environment.HANDLEPLAN_RELEASE_TRUST_KEY_ID,
    provenanceSigner: environment.HANDLEPLAN_RELEASE_PROVENANCE_SIGNER,
    publicKeyBase64: environment.HANDLEPLAN_RELEASE_TRUST_PUBLIC_KEY_BASE64,
    repository: environment.HANDLEPLAN_RELEASE_TRUST_REPOSITORY,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => typeof value !== "string" || value.trim().length === 0)
    .map(([key]) => key);
  if (missing.length > 0) {
    fail(`promotion requires external trust policy values: ${missing.join(", ")}`);
  }
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
      .test(required.publicKeyBase64)
  ) {
    fail("external trust public key is not canonical base64");
  }
  const publicKey = Buffer.from(required.publicKeyBase64, "base64").toString("utf8");
  if (publicKey.length < 80 || publicKey.length > 8_192) {
    fail("external trust public key has an unsafe size");
  }
  return {
    imageSigner: required.imageSigner,
    keyId: required.keyId,
    provenanceSigner: required.provenanceSigner,
    publicKey,
    repository: required.repository,
  };
}

function assertExternalReleaseTrustReceipt({
  manifest,
  manifestPath,
  now,
  root,
  trackedFiles,
  trustPolicy,
}) {
  if (trustPolicy === null || typeof trustPolicy !== "object") {
    fail("promotion requires a cryptographically verified external release trust receipt");
  }
  for (const key of ["imageSigner", "keyId", "provenanceSigner", "publicKey", "repository"]) {
    if (typeof trustPolicy[key] !== "string" || trustPolicy[key].trim().length === 0) {
      fail(`external trust policy has no ${key}`);
    }
  }
  if (trustPolicy.repository !== manifest.image.repository) {
    fail("external trust policy does not authorize the candidate registry repository");
  }
  if (trustPolicy.imageSigner !== manifest.attestations.imageSignature.signer) {
    fail("external trust policy does not authorize the candidate image signer");
  }
  if (typeof manifestPath !== "string") {
    fail("promotion trust verification requires the candidate manifest path");
  }
  const expectedManifestPath = `docs/evidence/v1/${manifest.candidateId}/release-candidate.v1.json`;
  if (manifestPath !== expectedManifestPath) {
    fail(`promotion trust verification requires ${expectedManifestPath}`);
  }
  const receiptPath = `docs/evidence/v1/${manifest.candidateId}/${releaseTrustReceiptFilename}`;
  assertCandidateEvidencePath(
    receiptPath,
    manifest,
    "external release trust receipt",
    true,
    trackedFiles,
  );
  const receiptFile = checkedRepositoryFile(root, receiptPath, "external release trust receipt");
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
  } catch {
    fail("external release trust receipt is not valid JSON");
  }
  if (!validateExternalTrustReceiptSchema(receipt)) {
    fail(`external release trust receipt schema validation failed:\n${ajv.errorsText(
      validateExternalTrustReceiptSchema.errors,
      { separator: "\n" },
    )}`);
  }
  const statement = receipt.statement;
  const manifestFile = checkedRepositoryFile(root, manifestPath, "candidate manifest");
  if (
    statement.candidateId !== manifest.candidateId
    || statement.sourceCommitSha !== manifest.source.commitSha
    || statement.candidateManifestSha256 !== sha256File(manifestFile)
    || statement.repository !== manifest.image.repository
    || statement.immutableReference !== manifest.image.immutableReference
    || statement.manifestDigest !== manifest.image.manifestDigest
  ) {
    fail("external release trust receipt is not bound to the candidate manifest and image");
  }
  if (
    statement.checks.registryReadback !== "verified"
    || statement.checks.imageSignature.status !== "verified"
    || statement.checks.imageSignature.signer !== trustPolicy.imageSigner
    || statement.checks.provenance.status !== "verified"
    || statement.checks.provenance.signer !== trustPolicy.provenanceSigner
    || statement.checks.gateEvidence.status !== "verified"
    || JSON.stringify(statement.checks.gateEvidence.gateIds) !== JSON.stringify(gateIds)
  ) {
    fail("external release trust receipt does not verify every required trust domain");
  }
  const verifiedAt = Date.parse(statement.verifiedAt);
  const expiresAt = Date.parse(statement.expiresAt);
  const verificationTime = now instanceof Date ? now.getTime() : Date.parse(now ?? "");
  if (
    !Number.isFinite(verificationTime)
    || expiresAt <= verifiedAt
    || expiresAt - verifiedAt > releaseTrustMaximumValidityMilliseconds
    || verificationTime < verifiedAt
    || verificationTime > expiresAt
  ) {
    fail("external release trust receipt is not current within its bounded validity window");
  }
  const candidateEvidenceTimes = [
    manifest.createdAt,
    manifest.backup.restoreTestedAt,
    manifest.attestations.imageSignature.verifiedAt,
    ...Object.values(manifest.evidence).flatMap((entries) => (
      entries.map(({ reviewedAt }) => reviewedAt)
    )),
  ].filter((value) => value !== null).map((value) => Date.parse(value));
  if (
    candidateEvidenceTimes.some((value) => !Number.isFinite(value))
    || candidateEvidenceTimes.some((value) => value > verifiedAt)
  ) {
    fail("external release trust receipt predates candidate evidence or review");
  }
  if (
    receipt.signature.algorithm !== "ed25519"
    || receipt.signature.keyId !== trustPolicy.keyId
  ) {
    fail("external release trust receipt uses an unauthorized signing identity");
  }
  const signatureBytes = Buffer.from(receipt.signature.value, "base64");
  if (signatureBytes.byteLength !== 64) {
    fail("external release trust receipt has an invalid Ed25519 signature size");
  }
  let publicKey;
  try {
    publicKey = createPublicKey(trustPolicy.publicKey);
  } catch {
    fail("external release trust policy public key cannot be parsed");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    fail("external release trust policy requires an Ed25519 public key");
  }
  if (!verifySignature(
    null,
    Buffer.from(canonicalReleaseTrustStatement(statement), "utf8"),
    publicKey,
    signatureBytes,
  )) {
    fail("external release trust receipt signature is invalid");
  }
  return receiptPath;
}

function readBoundArtifactJson(root, binding, label) {
  assertFileBinding(root, binding, label);
  try {
    return JSON.parse(readFileSync(resolve(root, binding.artifact), "utf8"));
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function assertReportArtifacts(root, reportArtifacts, manifest, label, promotion, trackedFiles) {
  if (!Array.isArray(reportArtifacts) || reportArtifacts.length === 0) {
    fail(`${label} must retain at least one raw report artifact`);
  }
  const paths = [];
  for (const [index, binding] of reportArtifacts.entries()) {
    assertExactKeys(binding, ["path", "sha256"], `${label} report ${index + 1}`);
    assertCandidateEvidencePath(binding.path, manifest, `${label} report ${index + 1}`, promotion, trackedFiles);
    assertFileBinding(root, binding, `${label} report ${index + 1}`);
    paths.push(binding.path);
  }
  if (new Set(paths).size !== paths.length) fail(`${label} report paths must be unique`);
  return paths;
}

function assertOciDescriptor(descriptor, label) {
  if (descriptor === null || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    fail(`${label} must be an OCI descriptor`);
  }
  if (typeof descriptor.mediaType !== "string" || descriptor.mediaType.length === 0) {
    fail(`${label} has no media type`);
  }
  if (typeof descriptor.digest !== "string" || !descriptor.digest.startsWith("sha256:")) {
    fail(`${label} has no SHA-256 digest`);
  }
  assertUnambiguousDigest(descriptor.digest, `${label} digest`);
  if (!Number.isSafeInteger(descriptor.size) || descriptor.size < 1) {
    fail(`${label} has no positive byte size`);
  }
}

function assertRegistryReadback(
  root,
  readback,
  manifest,
  label,
  promotion,
  trackedFiles,
) {
  assertExactKeys(readback, [
    "repository",
    "immutableReference",
    "mediaType",
    "manifestPath",
    "manifestSha256",
    "observedAt",
  ], `${label} registry readback`);
  if (
    readback.repository !== manifest.image.repository
    || readback.immutableReference !== manifest.image.immutableReference
    || readback.mediaType !== "application/vnd.oci.image.manifest.v1+json"
    || `sha256:${readback.manifestSha256}` !== manifest.image.manifestDigest
    || Number.isNaN(Date.parse(readback.observedAt))
  ) {
    fail(`${label} registry readback does not bind the candidate OCI image manifest`);
  }
  const binding = { path: readback.manifestPath, sha256: readback.manifestSha256 };
  assertCandidateEvidencePath(binding.path, manifest, `${label} raw OCI manifest`, promotion, trackedFiles);
  assertFileBinding(root, binding, `${label} raw OCI manifest`);
  let rawManifest;
  try {
    rawManifest = JSON.parse(readFileSync(resolve(root, binding.path), "utf8"));
  } catch {
    fail(`${label} registry bytes are not JSON OCI manifest bytes`);
  }
  if (
    rawManifest?.schemaVersion !== 2
    || rawManifest.mediaType !== readback.mediaType
    || !Array.isArray(rawManifest.layers)
    || rawManifest.layers.length === 0
  ) {
    fail(`${label} registry bytes are not an OCI image manifest`);
  }
  assertOciDescriptor(rawManifest.config, `${label} OCI config`);
  if (rawManifest.config.mediaType !== "application/vnd.oci.image.config.v1+json") {
    fail(`${label} OCI config has an unexpected media type`);
  }
  rawManifest.layers.forEach((layer, index) => {
    assertOciDescriptor(layer, `${label} OCI layer ${index + 1}`);
    if (!layer.mediaType.startsWith("application/vnd.oci.image.layer.v1")) {
      fail(`${label} OCI layer ${index + 1} has an unexpected media type`);
    }
  });
}

function assertEvidence(root, manifest, promotion, trackedFiles) {
  const allEvidence = Object.entries(manifest.evidence)
    .flatMap(([kind, entries]) => entries.map((entry) => ({ ...entry, kind })));
  const evidenceIds = allEvidence.map(({ id }) => id);
  const rawReportPaths = [];
  if (new Set(evidenceIds).size !== evidenceIds.length) fail("evidence IDs must be globally unique");

  for (const entry of allEvidence) {
    const label = `${entry.kind} evidence ${entry.id}`;
    if ((entry.artifact === null) !== (entry.sha256 === null)) {
      fail(`${label} must provide artifact and checksum together`);
    }
    if (entry.artifact !== null) {
      assertFileBinding(root, { artifact: entry.artifact, sha256: entry.sha256 }, label);
      assertCandidateEvidencePath(entry.artifact, manifest, label, promotion, trackedFiles);
      const wrapper = readBoundArtifactJson(
        root,
        { artifact: entry.artifact, sha256: entry.sha256 },
        label,
      );
      const wrapperKeys = [
        "contractVersion",
        "candidateId",
        "evidenceId",
        "kind",
        "candidateCommit",
        "imageManifestDigest",
        "status",
        "command",
        "environment",
        "reviewedAt",
        "reviewer",
        "reportArtifacts",
        "registryReadback",
      ];
      if (wrapper.contractVersion === "handleplan.release-evidence.v2") {
        wrapperKeys.push("gateIds", "protocol");
      }
      assertExactKeys(wrapper, wrapperKeys, `${label} wrapper`);
      if (
        !["handleplan.release-evidence.v1", "handleplan.release-evidence.v2"]
          .includes(wrapper.contractVersion)
        || wrapper.candidateId !== manifest.candidateId
        || wrapper.evidenceId !== entry.id
        || wrapper.kind !== entry.kind
        || wrapper.candidateCommit !== manifest.source.commitSha
        || wrapper.imageManifestDigest !== manifest.image.manifestDigest
        || wrapper.status !== entry.status
        || wrapper.command !== entry.command
        || wrapper.environment !== entry.environment
        || wrapper.reviewedAt !== entry.reviewedAt
      ) {
        fail(`${label} wrapper is not bound to this candidate and evidence record`);
      }
      if (promotion && wrapper.contractVersion !== "handleplan.release-evidence.v2") {
        fail(`${label} promotion evidence requires a gate-specific v2 wrapper`);
      }
      if (wrapper.contractVersion === "handleplan.release-evidence.v2") {
        if (
          !Array.isArray(wrapper.gateIds)
          || wrapper.gateIds.length === 0
          || new Set(wrapper.gateIds).size !== wrapper.gateIds.length
          || wrapper.gateIds.some((gateId) => !gateIds.includes(gateId))
          || JSON.stringify(wrapper.gateIds) !== JSON.stringify(
            gateIds.filter((gateId) => wrapper.gateIds.includes(gateId)),
          )
          || typeof wrapper.protocol !== "string"
          || !Object.values(requiredEvidenceProtocolByGate).includes(wrapper.protocol)
        ) {
          fail(`${label} has an invalid gate-specific protocol binding`);
        }
        entry.gateIds = wrapper.gateIds;
        entry.protocol = wrapper.protocol;
      } else {
        entry.gateIds = [];
        entry.protocol = null;
      }
      if (entry.status === "passed") {
        if (typeof wrapper.reviewer !== "string" || wrapper.reviewer.trim().length === 0) {
          fail(`${label} passed wrapper has no named reviewer`);
        }
        rawReportPaths.push(...assertReportArtifacts(
          root,
          wrapper.reportArtifacts,
          manifest,
          label,
          promotion,
          trackedFiles,
        ));
      }
      if (wrapper.registryReadback !== null) {
        assertRegistryReadback(
          root,
          wrapper.registryReadback,
          manifest,
          label,
          promotion,
          trackedFiles,
        );
      }
      entry.registryReadbackValid = wrapper.registryReadback !== null;
    }
    if (entry.status === "passed") {
      if (entry.artifact === null || entry.reviewedAt === null) {
        fail(`${label} cannot pass without a checksummed artifact and review time`);
      }
    }
    if (promotion && entry.status !== "passed") fail(`${label} is not passed`);
  }
  const evidenceArtifactPaths = allEvidence
    .map(({ artifact }) => artifact)
    .filter((path) => path !== null);
  if (new Set(evidenceArtifactPaths).size !== evidenceArtifactPaths.length) {
    fail("each evidence record requires its own candidate-bound wrapper artifact");
  }
  if (new Set(rawReportPaths).size !== rawReportPaths.length) {
    fail("passed evidence records must not reuse one raw report across evidence kinds");
  }
  return new Map(allEvidence.map((entry) => [entry.id, entry]));
}

function assertArtifact(root, artifact, label) {
  if ((artifact.artifact === null) !== (artifact.sha256 === null)) {
    fail(`${label} must provide artifact and checksum together`);
  }
  if (artifact.artifact !== null) assertFileBinding(root, artifact, label);
  if (artifact.status !== "missing" && artifact.artifact === null) {
    fail(`${label} status ${artifact.status} requires a checksummed artifact`);
  }
}

function assertBackupEvidence(root, backup, manifest, promotion, trackedFiles) {
  if ((backup.artifact === null) !== (backup.sha256 === null)) {
    fail("backup evidence must provide artifact and checksum together");
  }
  if (backup.artifact === null) return;
  assertCandidateEvidencePath(
    backup.artifact,
    manifest,
    "backup restore evidence",
    promotion,
    trackedFiles,
  );
  const wrapper = readBoundArtifactJson(root, backup, "backup restore evidence");
  assertExactKeys(wrapper, [
    "contractVersion",
    "candidateId",
    "candidateCommit",
    "imageManifestDigest",
    "status",
    "backupIdentifier",
    "backupCreatedAt",
    "restoreTestedAt",
    "reviewedAt",
    "reviewer",
    "reportArtifacts",
  ], "backup restore evidence wrapper");
  if (
    wrapper.contractVersion !== "handleplan.backup-restore-evidence.v1"
    || wrapper.candidateId !== manifest.candidateId
    || wrapper.candidateCommit !== manifest.source.commitSha
    || wrapper.imageManifestDigest !== manifest.image.manifestDigest
    || wrapper.status !== backup.status
    || wrapper.backupIdentifier !== backup.identifier
    || wrapper.backupCreatedAt !== backup.createdAt
    || wrapper.restoreTestedAt !== backup.restoreTestedAt
  ) {
    fail("backup restore evidence is not bound to this candidate and backup");
  }
  if (backup.status === "restore_verified") {
    if (
      typeof wrapper.reviewer !== "string"
      || wrapper.reviewer.trim().length === 0
      || Number.isNaN(Date.parse(wrapper.reviewedAt))
    ) {
      fail("restore-verified backup evidence requires a named reviewer and review time");
    }
    assertReportArtifacts(
      root,
      wrapper.reportArtifacts,
      manifest,
      "backup restore evidence",
      promotion,
      trackedFiles,
    );
  }
}

function assertSpdxArtifact(root, sbom, manifest, promotion, trackedFiles) {
  if (sbom.artifact === null) return;
  assertCandidateEvidencePath(sbom.artifact, manifest, "SBOM", promotion, trackedFiles);
  const document = readBoundArtifactJson(root, sbom, "SBOM");
  const rootPackage = Array.isArray(document.packages)
    ? document.packages.find((entry) => entry?.SPDXID === "SPDXRef-Package-Handleplan")
    : undefined;
  if (
    document.spdxVersion !== "SPDX-2.3"
    || document.SPDXID !== "SPDXRef-DOCUMENT"
    || !document.documentNamespace?.includes(`/${manifest.source.commitSha}/`)
    || rootPackage?.name !== "handleplan"
    || rootPackage.versionInfo !== manifest.source.commitSha
  ) {
    fail("SBOM artifact is not an SPDX 2.3 document bound to the candidate commit");
  }
}

function decodeDssePayload(envelope, label) {
  if (
    envelope?.payloadType !== "application/vnd.in-toto+json"
    || typeof envelope.payload !== "string"
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(envelope.payload)
    || !Array.isArray(envelope.signatures)
    || envelope.signatures.length === 0
  ) {
    fail(`${label} is not a signed DSSE in-toto envelope`);
  }
  for (const signature of envelope.signatures) {
    if (
      typeof signature?.keyid !== "string"
      || signature.keyid.length === 0
      || typeof signature.sig !== "string"
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(signature.sig)
      || Buffer.from(signature.sig, "base64").byteLength < 16
    ) {
      fail(`${label} contains a malformed DSSE signature`);
    }
  }
  try {
    return JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
  } catch {
    fail(`${label} payload is not valid JSON`);
  }
}

function assertProvenanceArtifact(root, provenance, manifest, promotion, trackedFiles) {
  if (provenance.artifact === null) return;
  assertCandidateEvidencePath(
    provenance.artifact,
    manifest,
    "provenance",
    promotion,
    trackedFiles,
  );
  const artifact = readBoundArtifactJson(root, provenance, "provenance");
  const statement = provenance.status === "unsigned"
    ? artifact
    : decodeDssePayload(artifact, "provenance");
  const subject = Array.isArray(statement.subject) && statement.subject.length === 1
    ? statement.subject[0]
    : undefined;
  if (
    statement._type !== "https://in-toto.io/Statement/v1"
    || statement.predicateType !== "https://slsa.dev/provenance/v1"
    || statement.predicate?.buildDefinition?.externalParameters?.commitSha
      !== manifest.source.commitSha
  ) {
    fail("provenance payload is not bound to the candidate commit");
  }
  if (
    provenance.status !== "unsigned"
    && (
      subject?.name !== manifest.image.immutableReference
      || subject?.digest?.sha256 !== manifest.image.manifestDigest?.slice(7)
    )
  ) {
    fail("signed provenance payload is not bound to the candidate OCI manifest");
  }
}

function assertImageSignatureArtifact(root, signature, manifest, promotion, trackedFiles) {
  if (signature.artifact === null) return;
  assertCandidateEvidencePath(
    signature.artifact,
    manifest,
    "image-signature verification evidence",
    promotion,
    trackedFiles,
  );
  const report = readBoundArtifactJson(root, signature, "image-signature verification evidence");
  assertExactKeys(report, [
    "contractVersion",
    "candidateId",
    "candidateCommit",
    "repository",
    "immutableReference",
    "manifestDigest",
    "status",
    "signer",
    "verifiedAt",
    "verificationCommand",
  ], "image-signature verification report");
  if (
    report.contractVersion !== "handleplan.image-signature-verification.v1"
    || report.candidateId !== manifest.candidateId
    || report.candidateCommit !== manifest.source.commitSha
    || report.repository !== manifest.image.repository
    || report.immutableReference !== manifest.image.immutableReference
    || report.manifestDigest !== manifest.image.manifestDigest
    || report.status !== signature.status
    || report.signer !== signature.signer
    || report.verifiedAt !== signature.verifiedAt
    || typeof report.verificationCommand !== "string"
    || report.verificationCommand.trim().length === 0
  ) {
    fail("image-signature report is not bound to this candidate and OCI manifest");
  }
}

function collectPlaceholderPaths(value, path = "$", found = []) {
  if (typeof value === "string" && placeholderPattern.test(value)) found.push(path);
  if (Array.isArray(value)) {
    value.forEach((child, index) => collectPlaceholderPaths(child, `${path}[${index}]`, found));
  } else if (value !== null && typeof value === "object") {
    Object.entries(value).forEach(([key, child]) => {
      collectPlaceholderPaths(child, `${path}.${key}`, found);
    });
  }
  return found;
}

function assertImage(image, promotion) {
  const absent = image.manifestDigest === null;
  if (absent) {
    if (
      image.repository !== null
      || image.immutableReference !== null
      || image.registryReadbackEvidenceId !== null
      || image.promoted
    ) {
      fail("an absent image digest must not have a repository, readback, immutable reference, or promoted state");
    }
    if (promotion) fail("promotion requires an immutable OCI manifest digest");
    return;
  }

  assertUnambiguousDigest(image.manifestDigest, "image OCI manifest digest");
  if (
    image.repository === null
    || !repositoryImagePattern.test(image.repository)
    || image.repository.includes("@")
  ) {
    fail("image repository must be an untagged registry repository name");
  }
  if (image.immutableReference !== `${image.repository}@${image.manifestDigest}`) {
    fail("immutable image reference must bind the repository to the same OCI manifest digest");
  }
  if (promotion !== image.promoted) {
    fail("image promoted state must be false for drafts and true for promotion candidates");
  }
}

function assertDatabase(root, database, promotion, trackedFiles) {
  const migrationDirectory = resolve(root, "deploy/migrations");
  const expectedPaths = readdirSync(migrationDirectory)
    .filter((name) => migrationNamePattern.test(name))
    .sort()
    .map((name) => `deploy/migrations/${name}`);
  const actualPaths = database.migrations.map(({ path }) => path);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    fail("migration ledger must enumerate every repository migration exactly once in lexical order");
  }
  database.migrations.forEach((binding, index) => {
    assertFileBinding(root, binding, `migration ${expectedPaths[index]}`);
    assertTrackedPromotionPath(binding.path, `migration ${expectedPaths[index]}`, promotion, trackedFiles);
  });

  const { identifier, kind } = database.startingState;
  if (kind === "unverified" && identifier !== null) {
    fail("unverified database starting state cannot claim an identifier");
  }
  if (kind !== "unverified" && identifier === null) {
    fail("verified database starting state requires an identifier");
  }
  if (promotion && kind === "unverified") fail("promotion requires a verified database starting state");
}

function assertSupportedRegions(manifest, coverage, registry, promotion) {
  if (!Array.isArray(coverage.requiredChains)) fail("coverage manifest has no required-chain list");
  const actualChainIds = coverage.requiredChains.map(({ id }) => id);
  if (JSON.stringify(actualChainIds) !== JSON.stringify(requiredChainIds)) {
    fail("coverage manifest must require Bunnpris, REMA 1000, and Extra in canonical order");
  }
  if (!Array.isArray(registry.sources)) fail("source registry has no source list");
  const sourceIds = registry.sources.map(({ id }) => id);
  if (new Set(sourceIds).size !== sourceIds.length) fail("source registry IDs must be unique");
  if (!Array.isArray(coverage.candidateRegions) || !Array.isArray(coverage.coverage)) {
    fail("coverage manifest has no candidate-region or coverage-cell list");
  }
  const selectedRegions = coverage.candidateRegions
    .filter((region) => region.selected === true && region.selectionStatus === "selected")
    .map((region) => region.id)
    .sort();
  const supportedRegions = [...manifest.supportedRegions].sort();
  if (JSON.stringify(supportedRegions) !== JSON.stringify(selectedRegions)) {
    fail("supported regions must equal the selected regions in the bound coverage manifest");
  }

  const sourceById = new Map(registry.sources.map((source) => [source.id, source]));
  for (const regionId of supportedRegions) {
    const region = coverage.candidateRegions.find((entry) => entry.id === regionId);
    if (region.knownGaps.length > 0) fail(`${regionId} still declares unresolved regional gaps`);
    const rows = coverage.coverage.filter((row) => row.regionId === regionId);
    if (rows.length !== requiredChainIds.length * 2) {
      fail(`${regionId} must contain exactly six required launch-coverage cells`);
    }
    for (const chain of coverage.requiredChains) {
      for (const priceClass of ["ordinary", "official_offer"]) {
        const matches = rows.filter((entry) => (
          entry.chainId === chain.id && entry.priceClass === priceClass
        ));
        if (matches.length !== 1) {
          fail(`${regionId}/${chain.id}/${priceClass} must have exactly one coverage cell`);
        }
        const [row] = matches;
        if (
          row.launchEligible !== true
          || row.coverageStatus !== "verified"
          || row.evidenceLevel !== "rights_cleared_measured"
          || row.activeSourceId === null
        ) {
          fail(`${regionId}/${chain.id}/${priceClass} is not launch-eligible`);
        }
        if (row.knownGaps.length > 0) {
          fail(`${regionId}/${chain.id}/${priceClass} still declares unresolved coverage gaps`);
        }
        if (!row.candidateSourceIds.includes(row.activeSourceId)) {
          fail(`${regionId}/${chain.id}/${priceClass} active source is outside its candidate set`);
        }
        const source = sourceById.get(row.activeSourceId);
        if (source?.runtimeState !== "approved" || source.publicRankingEligible !== true) {
          fail(`${regionId}/${chain.id}/${priceClass} does not bind an approved public-ranking source`);
        }
        for (const requiredRight of ["access", "processing", "retention", "derivedDisplay"]) {
          if (source.rights[requiredRight] !== "permitted") {
            fail(`${regionId}/${chain.id}/${priceClass} source has unresolved ${requiredRight} rights`);
          }
        }
        if (source.knownUnknowns.length > 0) {
          fail(`${regionId}/${chain.id}/${priceClass} source still declares rights unknowns`);
        }
        const expectedDataClass = priceClass === "ordinary"
          ? "ordinary_price_observation"
          : "official_offer";
        if (!source.dataClasses.includes(expectedDataClass)) {
          fail(`${regionId}/${chain.id}/${priceClass} source lacks ${expectedDataClass}`);
        }
      }
    }
  }

  if (promotion) {
    if (
      coverage.launchDecision !== "selected"
      || coverage.selectionGate.passed !== true
      || coverage.selectionGate.blockers.length > 0
    ) {
      fail("promotion requires a passed selected launch-coverage decision");
    }
    if (supportedRegions.length === 0) fail("promotion requires at least one supported region");
  }
}

function assertGates(manifest, evidenceById, promotion) {
  const actualGateIds = manifest.gates.map(({ id }) => id);
  if (JSON.stringify(actualGateIds) !== JSON.stringify(gateIds)) {
    fail("gates must enumerate G1 through G12 exactly once in canonical order");
  }

  for (const gate of manifest.gates) {
    for (const evidenceId of gate.evidenceIds) {
      if (!evidenceById.has(evidenceId)) fail(`${gate.id} references unknown evidence ${evidenceId}`);
    }
    if (gate.status === "passed") {
      if (gate.evidenceIds.length === 0) fail(`${gate.id} cannot pass without evidence`);
      if (gate.evidenceIds.some((id) => evidenceById.get(id).status !== "passed")) {
        fail(`${gate.id} references evidence that is not passed`);
      }
      for (const requiredKind of requiredEvidenceKindsByGate[gate.id]) {
        if (!gate.evidenceIds.some((id) => evidenceById.get(id).kind === requiredKind)) {
          fail(`${gate.id} lacks passed ${requiredKind} evidence required by its acceptance rule`);
        }
      }
      const expectedProtocol = requiredEvidenceProtocolByGate[gate.id];
      if (gate.evidenceIds.some((id) => {
        const evidence = evidenceById.get(id);
        return !evidence.gateIds.includes(gate.id) || evidence.protocol !== expectedProtocol;
      })) {
        fail(`${gate.id} references evidence outside its gate-specific protocol contract`);
      }
    }
  }

  const expectedMissing = manifest.gates
    .filter(({ status }) => status !== "passed")
    .map(({ id }) => id);
  if (JSON.stringify(manifest.missingOrUnverifiedGateIds) !== JSON.stringify(expectedMissing)) {
    fail("missingOrUnverifiedGateIds must exactly list every non-passed gate in canonical order");
  }
  if (promotion && expectedMissing.length > 0) fail("promotion requires all twelve gates to pass");
}

export function assertManifestSchema(manifest) {
  if (!validateSchema(manifest)) {
    fail(`schema validation failed:\n${ajv.errorsText(validateSchema.errors, { separator: "\n" })}`);
  }
}

function assertBoundDocumentSchema(label, validate, document) {
  if (!validate(document)) {
    fail(`${label} schema validation failed:\n${ajv.errorsText(validate.errors, { separator: "\n" })}`);
  }
}

export function verifyCandidateManifest(manifest, {
  manifestPath,
  root = repositoryRoot,
  repositoryCommit,
  sourceCandidateEvidencePaths,
  sourceCommitIsAncestor,
  sourceToEvidenceChangedPaths,
  sourceToEvidenceCommitCount,
  trackedFiles,
  trustPolicy = null,
  verificationTime = new Date(),
  worktreeDirty,
} = {}) {
  assertManifestSchema(manifest);
  const promotion = manifest.mode === "promotion_candidate";
  if (!/^[0-9a-f]{40}$/u.test(repositoryCommit ?? "")) {
    fail("verification requires the current full lowercase repository commit");
  }
  if (typeof worktreeDirty !== "boolean") fail("verification requires explicit worktree state");
  if (promotion && worktreeDirty) fail("a dirty worktree cannot be a promotion candidate");
  if (promotion && !(trackedFiles instanceof Set)) {
    fail("promotion verification requires the tracked file set at candidate HEAD");
  }
  if (!promotion && manifest.source.commitSha !== repositoryCommit) {
    fail("source commit does not match the repository HEAD");
  }
  const expectedTreeState = worktreeDirty ? "dirty" : "clean";
  const expectedCommitBinding = promotion
    ? "source_exact_evidence_append"
    : worktreeDirty ? "baseline_only" : "exact";
  if (manifest.source.treeState !== expectedTreeState) {
    fail(`source treeState must be ${expectedTreeState}`);
  }
  if (manifest.source.commitBinding !== expectedCommitBinding) {
    fail(`source commitBinding must be ${expectedCommitBinding}`);
  }

  if (promotion && collectPlaceholderPaths(manifest).length > 0) {
    fail(`promotion contains placeholder text at ${collectPlaceholderPaths(manifest).join(", ")}`);
  }

  assertImage(manifest.image, promotion);
  assertDatabase(root, manifest.database, promotion, trackedFiles);

  if (manifest.sourceRegistry.path !== "docs/data/source-registry.v1.json") {
    fail("source registry must bind docs/data/source-registry.v1.json");
  }
  if (manifest.coverageManifest.path !== "docs/data/launch-coverage.v1.json") {
    fail("coverage manifest must bind docs/data/launch-coverage.v1.json");
  }
  const registry = readBoundJson(root, manifest.sourceRegistry, "source registry");
  const coverage = readBoundJson(root, manifest.coverageManifest, "coverage manifest");
  assertTrackedPromotionPath(
    manifest.sourceRegistry.path,
    "source registry",
    promotion,
    trackedFiles,
  );
  assertTrackedPromotionPath(
    manifest.coverageManifest.path,
    "coverage manifest",
    promotion,
    trackedFiles,
  );
  assertBoundDocumentSchema("source registry", validateSourceRegistrySchema, registry);
  assertBoundDocumentSchema("coverage manifest", validateCoverageManifestSchema, coverage);
  if (registry.registryVersion !== manifest.sourceRegistry.version) {
    fail("source registry version does not match the bound document");
  }
  if (coverage.manifestVersion !== manifest.coverageManifest.version) {
    fail("coverage manifest version does not match the bound document");
  }

  const evidenceById = assertEvidence(root, manifest, promotion, trackedFiles);
  if (manifest.image.registryReadbackEvidenceId !== null) {
    const readback = evidenceById.get(manifest.image.registryReadbackEvidenceId);
    if (readback?.status !== "passed" || readback.registryReadbackValid !== true) {
      fail("image registry readback must reference passed typed registry evidence");
    }
  } else if (promotion) {
    fail("promotion requires passed immutable-image registry readback evidence");
  }
  const retainedArtifactPaths = [
    ...Object.values(manifest.evidence).flatMap((entries) => entries.map(({ artifact }) => artifact)),
    manifest.backup.artifact,
    manifest.attestations.sbom.artifact,
    manifest.attestations.provenance.artifact,
    manifest.attestations.imageSignature.artifact,
  ].filter((path) => path !== null);
  if (new Set(retainedArtifactPaths).size !== retainedArtifactPaths.length) {
    fail("evidence, backup, SBOM, provenance, and signature require distinct retained artifacts");
  }
  assertGates(manifest, evidenceById, promotion);
  assertSupportedRegions(manifest, coverage, registry, promotion);

  const backup = manifest.backup;
  assertBackupEvidence(root, backup, manifest, promotion, trackedFiles);
  if (backup.status === "restore_verified") {
    if (
      backup.identifier === null
      || backup.createdAt === null
      || backup.restoreTestedAt === null
      || backup.artifact === null
    ) {
      fail("restore-verified backup requires identifier, clocks, and checksummed evidence");
    }
  } else if (backup.status === "unverified") {
    if (backup.identifier === null || backup.createdAt === null || backup.restoreTestedAt !== null) {
      fail("unverified backup requires an identifier and creation time but no restore-verification time");
    }
  } else if (
    backup.identifier !== null
    || backup.createdAt !== null
    || backup.restoreTestedAt !== null
    || backup.artifact !== null
  ) {
    fail("missing backup must not claim an identifier, clocks, or evidence");
  }
  if (promotion && backup.status !== "restore_verified") {
    fail("promotion requires a restore-verified backup identifier");
  }

  const sbom = manifest.attestations.sbom;
  assertArtifact(root, sbom, "SBOM");
  if (sbom.status === "missing") {
    if (sbom.subjectCommitSha !== null) fail("missing SBOM must not claim a source commit");
  } else if (sbom.subjectCommitSha !== manifest.source.commitSha) {
    fail("SBOM subject commit must equal the candidate source commit");
  }
  assertSpdxArtifact(root, sbom, manifest, promotion, trackedFiles);

  const provenance = manifest.attestations.provenance;
  assertArtifact(root, provenance, "provenance");
  if (provenance.status === "missing") {
    if (provenance.subjectCommitSha !== null || provenance.subjectManifestDigest !== null) {
      fail("missing provenance must not claim source or image subjects");
    }
  } else {
    if (provenance.subjectCommitSha !== manifest.source.commitSha) {
      fail("provenance subject commit must equal the candidate source commit");
    }
    if (provenance.subjectManifestDigest !== manifest.image.manifestDigest) {
      fail("provenance subject must equal the candidate OCI manifest digest");
    }
  }
  assertProvenanceArtifact(root, provenance, manifest, promotion, trackedFiles);
  const signature = manifest.attestations.imageSignature;
  if ((signature.artifact === null) !== (signature.sha256 === null)) {
    fail("image-signature evidence must provide artifact and checksum together");
  }
  if (signature.artifact !== null) {
    assertFileBinding(root, signature, "image-signature verification evidence");
  }
  if (signature.status === "verified") {
    if (
      signature.signer === null
      || signature.verifiedAt === null
      || signature.subjectManifestDigest === null
      || signature.artifact === null
    ) {
      fail("verified image signature requires subject, evidence, signer, and verification time");
    }
  } else if (signature.status === "unverified") {
    if (
      signature.subjectManifestDigest === null
      || signature.artifact === null
      || signature.signer !== null
      || signature.verifiedAt !== null
    ) {
      fail("unverified image signature requires a subject and evidence but no verified signer or time");
    }
  } else if (
    signature.subjectManifestDigest !== null
    || signature.artifact !== null
    || signature.signer !== null
    || signature.verifiedAt !== null
  ) {
    fail("missing image signature must not claim a subject, evidence, signer, or verification time");
  }
  if (
    signature.subjectManifestDigest !== null
    && signature.subjectManifestDigest !== manifest.image.manifestDigest
  ) {
    fail("image-signature subject must equal the candidate OCI manifest digest");
  }
  assertImageSignatureArtifact(root, signature, manifest, promotion, trackedFiles);
  if (promotion) {
    if (sbom.status !== "verified") fail("promotion requires a verified retained SBOM");
    if (provenance.status !== "signed_verified") {
      fail("promotion requires signed and verified provenance");
    }
    if (signature.status !== "verified") fail("promotion requires a verified image signature");
  }

  if (promotion) {
    const evidencePrefix = `docs/evidence/v1/${manifest.candidateId}/`;
    const expectedManifestPath = `${evidencePrefix}release-candidate.v1.json`;
    if (manifest.source.commitSha === repositoryCommit) {
      fail("promotion requires a distinct source commit followed by one evidence commit");
    }
    if (sourceCommitIsAncestor !== true) {
      fail("promotion source commit is not an ancestor of the evidence commit");
    }
    if (sourceToEvidenceCommitCount !== 1) {
      fail("promotion requires exactly one evidence commit after the source commit");
    }
    if (!Array.isArray(sourceCandidateEvidencePaths)) {
      fail("promotion verification requires the source candidate-evidence path set");
    }
    if (sourceCandidateEvidencePaths.length > 0) {
      fail("promotion candidate evidence must not pre-exist in the source commit");
    }
    if (!Array.isArray(sourceToEvidenceChangedPaths) || sourceToEvidenceChangedPaths.length === 0) {
      fail("promotion evidence commit must add candidate-local evidence files");
    }
    if (!sourceToEvidenceChangedPaths.includes(expectedManifestPath)) {
      fail("promotion evidence commit must add the candidate manifest");
    }
    const trustReceiptPath = `${evidencePrefix}${releaseTrustReceiptFilename}`;
    if (!sourceToEvidenceChangedPaths.includes(trustReceiptPath)) {
      fail("promotion evidence commit must add the external release trust receipt");
    }
    if (sourceToEvidenceChangedPaths.some((path) => !path.startsWith(evidencePrefix))) {
      fail("promotion evidence commit may change only its candidate evidence directory");
    }
    assertExternalReleaseTrustReceipt({
      manifest,
      manifestPath,
      now: verificationTime,
      root,
      trackedFiles,
      trustPolicy,
    });
  }
  if (!promotion && manifest.releaseDecision !== "blocked") {
    fail("draft manifests must remain blocked");
  }
  return {
    candidateId: manifest.candidateId,
    mode: manifest.mode,
    releaseDecision: manifest.releaseDecision,
  };
}

function repositoryState(root, manifest) {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
  });
  const tracked = execFileSync("git", ["ls-files", "--cached", "-z"], {
    cwd: root,
    encoding: "utf8",
  });
  const state = {
    commit,
    dirty: status.length > 0,
    trackedFiles: new Set(tracked.split("\0").filter((path) => path.length > 0)),
  };
  if (manifest.mode !== "promotion_candidate") return state;

  const sourceCommit = manifest.source.commitSha;
  const evidencePrefix = `docs/evidence/v1/${manifest.candidateId}/`;
  let sourceCommitIsAncestor = false;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sourceCommit, commit], {
      cwd: root,
      stdio: "ignore",
    });
    sourceCommitIsAncestor = true;
  } catch {
    // The semantic verifier emits the bounded fail-closed reason below.
  }
  if (!sourceCommitIsAncestor) {
    return {
      ...state,
      sourceCandidateEvidencePaths: [],
      sourceCommitIsAncestor,
      sourceToEvidenceChangedPaths: [],
      sourceToEvidenceCommitCount: 0,
    };
  }

  const sourceToEvidenceCommitCount = Number.parseInt(execFileSync(
    "git",
    ["rev-list", "--count", `${sourceCommit}..${commit}`],
    { cwd: root, encoding: "utf8" },
  ).trim(), 10);
  const changed = execFileSync(
    "git",
    ["diff", "--name-only", "-z", "--diff-filter=ACMRTUXBD", sourceCommit, commit, "--"],
    { cwd: root, encoding: "utf8" },
  );
  const sourceCandidateEvidence = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", "-z", sourceCommit, "--", evidencePrefix],
    { cwd: root, encoding: "utf8" },
  );
  return {
    ...state,
    sourceCandidateEvidencePaths: sourceCandidateEvidence
      .split("\0")
      .filter((path) => path.length > 0),
    sourceCommitIsAncestor,
    sourceToEvidenceChangedPaths: changed.split("\0").filter((path) => path.length > 0),
    sourceToEvidenceCommitCount,
  };
}

export function verifyManifestFile(
  manifestPath,
  root = repositoryRoot,
  { requirePromotion = false, trustPolicy, verificationTime } = {},
) {
  const resolvedPath = checkedRepositoryFile(root, manifestPath, "candidate manifest");
  const manifest = JSON.parse(readFileSync(resolvedPath, "utf8"));
  // Validate untrusted manifest strings before using the source commit or
  // candidate ID as arguments and pathspecs in repository-state commands.
  assertManifestSchema(manifest);
  if (
    requirePromotion
    && (manifest.mode !== "promotion_candidate" || manifest.releaseDecision !== "eligible")
  ) {
    fail("the selected workflow input is not an eligible promotion_candidate manifest");
  }
  const state = repositoryState(root, manifest);
  const expectedManifestPath = `docs/evidence/v1/${manifest.candidateId}/release-candidate.v1.json`;
  if (manifestPath !== expectedManifestPath) {
    fail(`candidate manifest must be stored at ${expectedManifestPath}`);
  }
  if (manifest.mode === "promotion_candidate" && !state.trackedFiles.has(manifestPath)) {
    fail("promotion candidate manifest is not a tracked blob at candidate HEAD");
  }
  const effectiveTrustPolicy = manifest.mode === "promotion_candidate"
    ? trustPolicy ?? releaseTrustPolicyFromEnvironment()
    : null;
  return verifyCandidateManifest(manifest, {
    manifestPath,
    repositoryCommit: state.commit,
    root,
    sourceCandidateEvidencePaths: state.sourceCandidateEvidencePaths,
    sourceCommitIsAncestor: state.sourceCommitIsAncestor,
    sourceToEvidenceChangedPaths: state.sourceToEvidenceChangedPaths,
    sourceToEvidenceCommitCount: state.sourceToEvidenceCommitCount,
    trackedFiles: state.trackedFiles,
    trustPolicy: effectiveTrustPolicy,
    verificationTime,
    worktreeDirty: state.dirty,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const argumentsAfterSeparator = process.argv[2] === "--"
    ? process.argv.slice(3)
    : process.argv.slice(2);
  const requirePromotion = argumentsAfterSeparator[0] === "--require-promotion";
  const positionalArguments = requirePromotion
    ? argumentsAfterSeparator.slice(1)
    : argumentsAfterSeparator;
  if (positionalArguments.length !== 1) {
    throw new Error(
      "usage: verify-v1-candidate-manifest.mjs [--require-promotion] <repository-relative-manifest.json>",
    );
  }
  const result = verifyManifestFile(positionalArguments[0], repositoryRoot, { requirePromotion });
  process.stdout.write(
    [
      "candidate-manifest-bindings-valid",
      `candidate=${result.candidateId}`,
      `mode=${result.mode}`,
      `releaseDecision=${result.releaseDecision}`,
    ].join(" ").concat("\n"),
  );
}
