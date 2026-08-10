import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CiImageBundleVerificationError,
  verifyCiImageBundle,
} from "../../scripts/operations/verify-ci-image-bundle.mjs";
import { createUnsignedProvenance } from "../../scripts/security/generate-build-provenance.mjs";
import { createSpdxDocument } from "../../scripts/security/generate-sbom.mjs";

const revision = "a".repeat(40);
const imageId = `sha256:${"b".repeat(64)}`;
const runId = "12345";
const runAttempt = "2";
const runtimeSourceDigest = "c".repeat(64);
const runtimeShipmentDigest = "d".repeat(64);
const baseImageDigest = "e".repeat(64);
const created = "2026-07-18T10:11:12.345Z";
const dependencyInventory = Object.freeze([
  Object.freeze({
    license: "MIT",
    name: "fixture-dependency",
    platformRestricted: false,
    version: "1.2.3",
  }),
  Object.freeze({
    license: "Apache-2.0",
    name: "fixture-native-dependency",
    platformRestricted: true,
    version: "4.5.6",
  }),
]);

function sha256(pathname) {
  return createHash("sha256").update(readFileSync(pathname)).digest("hex");
}

function writeJson(pathname, value) {
  writeFileSync(pathname, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "handleplan-ci-bundle-verifier-"));
  const artifactRoot = path.join(root, "bundle");
  const repositoryRoot = path.join(root, "repository");
  mkdirSync(artifactRoot, { recursive: true });
  mkdirSync(repositoryRoot, { recursive: true });
  writeFileSync(
    path.join(repositoryRoot, "Dockerfile"),
    [
      `FROM node:22.22.3-alpine@sha256:${baseImageDigest} AS base`,
      "FROM base AS dependencies",
      "FROM dependencies AS builder",
      "FROM base AS runner",
      "",
    ].join("\n"),
  );
  const imageArchive = path.join(artifactRoot, "handleplan-image.docker.tar");
  const sourceArchive = path.join(artifactRoot, "handleplan-source.tar");
  const provenance = path.join(artifactRoot, "handleplan.provenance.json");
  const sbom = path.join(artifactRoot, "handleplan.spdx.json");
  writeFileSync(imageArchive, "image archive\n");
  writeFileSync(sourceArchive, "source archive\n");
  writeJson(provenance, createUnsignedProvenance({
    baseDigest: baseImageDigest,
    imageArchiveDigest: sha256(imageArchive),
    revision,
    runId,
  }));
  writeJson(sbom, createSpdxDocument(dependencyInventory, { created, revision }));
  const manifestPath = path.join(artifactRoot, "handleplan-image-bundle.v1");
  writeFileSync(manifestPath, [
    "format=handleplan-ci-image-bundle-v3",
    `revision=${revision}`,
    `image_reference=handleplan:${revision}`,
    `image_id=${imageId}`,
    "platform=linux/amd64",
    `runtime_source_digest_sha256=${runtimeSourceDigest}`,
    "runtime_source_file_count=217",
    `runtime_shipment_digest_sha256=${runtimeShipmentDigest}`,
    "runtime_shipment_entry_count=43",
    `image_archive_sha256=${sha256(imageArchive)}`,
    `source_archive_sha256=${sha256(sourceArchive)}`,
    `provenance_sha256=${sha256(provenance)}`,
    `sbom_sha256=${sha256(sbom)}`,
    `ci_run_id=${runId}`,
    `ci_run_attempt=${runAttempt}`,
    "",
  ].join("\n"));
  return { artifactRoot, manifestPath, repositoryRoot, root };
}

function refreshArtifactDigest(candidate, field, filename) {
  const artifactPath = path.join(candidate.artifactRoot, filename);
  const manifest = readFileSync(candidate.manifestPath, "utf8");
  writeFileSync(
    candidate.manifestPath,
    manifest.replace(new RegExp(`^${field}=[0-9a-f]{64}$`, "mu"), `${field}=${sha256(artifactPath)}`),
  );
}

function mutateJsonArtifact(candidate, { digestField, filename, mutate }) {
  const pathname = path.join(candidate.artifactRoot, filename);
  const document = JSON.parse(readFileSync(pathname, "utf8"));
  mutate(document);
  writeJson(pathname, document);
  refreshArtifactDigest(candidate, digestField, filename);
}

function verify(candidate, expectedManifestSha256 = sha256(candidate.manifestPath)) {
  return verifyCiImageBundle({
    dependencyInventoryProvider: () => dependencyInventory,
    expectedImageId: imageId,
    expectedManifestSha256,
    expectedRevision: revision,
    expectedRunAttempt: runAttempt,
    expectedRunId: runId,
    manifestPath: candidate.manifestPath,
    repositoryRoot: candidate.repositoryRoot,
  });
}

test("revalidates the exact frozen CI image bundle", async (t) => {
  const candidate = fixture();
  t.after(() => rmSync(candidate.root, { force: true, recursive: true }));
  const result = await verify(candidate);
  assert.equal(result.imageId, imageId);
  assert.equal(result.revision, revision);
  assert.equal(result.platform, "linux/amd64");
  assert.equal(result.runtimeSourceDigestSha256, runtimeSourceDigest);
  assert.equal(result.runtimeSourceFileCount, 217);
  assert.equal(result.runtimeShipmentDigestSha256, runtimeShipmentDigest);
  assert.equal(result.runtimeShipmentEntryCount, 43);
});

test("rejects manifest, artifact, identity, directory, and size mutations", async (t) => {
  const candidate = fixture();
  t.after(() => rmSync(candidate.root, { force: true, recursive: true }));
  const frozenManifestDigest = sha256(candidate.manifestPath);
  writeFileSync(path.join(candidate.artifactRoot, "handleplan-image.docker.tar"), "mutated archive\n");
  await assert.rejects(
    () => verify(candidate, frozenManifestDigest),
    CiImageBundleVerificationError,
  );

  const changedManifest = fixture();
  t.after(() => rmSync(changedManifest.root, { force: true, recursive: true }));
  const changedManifestDigest = sha256(changedManifest.manifestPath);
  writeFileSync(
    changedManifest.manifestPath,
    `${readFileSync(changedManifest.manifestPath, "utf8")}extra=field\n`,
  );
  await assert.rejects(
    () => verify(changedManifest, changedManifestDigest),
    /manifest changed/u,
  );

  const extra = fixture();
  t.after(() => rmSync(extra.root, { force: true, recursive: true }));
  writeFileSync(path.join(extra.artifactRoot, "unexpected"), "unexpected\n");
  await assert.rejects(() => verify(extra), /unexpected or missing/u);

  const wrongIdentity = fixture();
  t.after(() => rmSync(wrongIdentity.root, { force: true, recursive: true }));
  await assert.rejects(() => verifyCiImageBundle({
    dependencyInventoryProvider: () => dependencyInventory,
    expectedImageId: imageId,
    expectedManifestSha256: sha256(wrongIdentity.manifestPath),
    expectedRevision: "c".repeat(40),
    expectedRunAttempt: runAttempt,
    expectedRunId: runId,
    manifestPath: wrongIdentity.manifestPath,
    repositoryRoot: wrongIdentity.repositoryRoot,
  }), /identity/u);

  const wrongPlatform = fixture();
  t.after(() => rmSync(wrongPlatform.root, { force: true, recursive: true }));
  writeFileSync(
    wrongPlatform.manifestPath,
    readFileSync(wrongPlatform.manifestPath, "utf8")
      .replace("platform=linux/amd64", "platform=linux/arm64"),
  );
  await assert.rejects(() => verify(wrongPlatform), /identity/u);

  const invalidRuntimeProof = fixture();
  t.after(() => rmSync(invalidRuntimeProof.root, { force: true, recursive: true }));
  const invalidRuntimeBytes = readFileSync(invalidRuntimeProof.manifestPath, "utf8")
    .replace(
      `runtime_shipment_digest_sha256=${runtimeShipmentDigest}`,
      "runtime_shipment_digest_sha256=invalid",
    );
  writeFileSync(invalidRuntimeProof.manifestPath, invalidRuntimeBytes);
  await assert.rejects(() => verify(invalidRuntimeProof), /runtime shipment proof/u);

  const emptySource = fixture();
  t.after(() => rmSync(emptySource.root, { force: true, recursive: true }));
  writeFileSync(path.join(emptySource.artifactRoot, "handleplan-source.tar"), "");
  await assert.rejects(() => verify(emptySource), /empty or exceeds/u);

  const oversizedImage = fixture();
  t.after(() => rmSync(oversizedImage.root, { force: true, recursive: true }));
  truncateSync(
    path.join(oversizedImage.artifactRoot, "handleplan-image.docker.tar"),
    (2 * 1024 * 1024 * 1024) + 1,
  );
  await assert.rejects(() => verify(oversizedImage), /empty or exceeds/u);
});

test("rejects provenance that is digest-bound but semantically stale or malformed", async (t) => {
  const mutations = [
    ["empty document", (document) => {
      for (const key of Object.keys(document)) delete document[key];
    }],
    ["base image", (document) => {
      document.predicate.buildDefinition.resolvedDependencies[1].digest.sha256 = "f".repeat(64);
    }],
    ["builder", (document) => {
      document.predicate.runDetails.builder.id = "https://example.invalid/builder";
    }],
    ["build type", (document) => {
      document.predicate.buildDefinition.buildType = "https://example.invalid/build";
    }],
    ["invocation", (document) => {
      document.predicate.runDetails.metadata.invocationId = "99999";
    }],
    ["source material", (document) => {
      document.predicate.buildDefinition.resolvedDependencies[0].digest.sha1 = "0".repeat(40);
    }],
    ["subject", (document) => {
      document.subject[0].digest.sha256 = "0".repeat(64);
    }],
  ];
  for (const [label, mutate] of mutations) {
    const candidate = fixture();
    t.after(() => rmSync(candidate.root, { force: true, recursive: true }));
    mutateJsonArtifact(candidate, {
      digestField: "provenance_sha256",
      filename: "handleplan.provenance.json",
      mutate,
    });
    await assert.rejects(
      () => verify(candidate),
      /provenance does not match/u,
      label,
    );
  }
});

test("rejects an SPDX document that is digest-bound but stale or malformed", async (t) => {
  const empty = fixture();
  t.after(() => rmSync(empty.root, { force: true, recursive: true }));
  writeJson(path.join(empty.artifactRoot, "handleplan.spdx.json"), {});
  refreshArtifactDigest(empty, "sbom_sha256", "handleplan.spdx.json");
  await assert.rejects(() => verify(empty), /invalid creation time/u);

  const stale = fixture();
  t.after(() => rmSync(stale.root, { force: true, recursive: true }));
  writeJson(
    path.join(stale.artifactRoot, "handleplan.spdx.json"),
    createSpdxDocument(dependencyInventory, { created, revision: "f".repeat(40) }),
  );
  refreshArtifactDigest(stale, "sbom_sha256", "handleplan.spdx.json");
  await assert.rejects(() => verify(stale), /does not match the exact revision/u);

  for (const [label, mutate] of [
    ["package inventory", (document) => {
      document.packages[1].versionInfo = "9.9.9";
    }],
    ["relationship", (document) => {
      document.relationships[0].relationshipType = "CONTAINS";
    }],
    ["unexpected field", (document) => {
      document.unexpected = true;
    }],
  ]) {
    const candidate = fixture();
    t.after(() => rmSync(candidate.root, { force: true, recursive: true }));
    mutateJsonArtifact(candidate, {
      digestField: "sbom_sha256",
      filename: "handleplan.spdx.json",
      mutate,
    });
    await assert.rejects(
      () => verify(candidate),
      /SPDX SBOM does not match/u,
      label,
    );
  }
});

test("rejects every Dockerfile base or final stage outside the represented graph", async (t) => {
  for (const directive of [
    `FROM alpine:3.23@sha256:${"f".repeat(64)} AS unrepresented`,
    "FROM scratch AS unrepresented-final",
  ]) {
    const candidate = fixture();
    t.after(() => rmSync(candidate.root, { force: true, recursive: true }));
    const dockerfilePath = path.join(candidate.repositoryRoot, "Dockerfile");
    writeFileSync(
      dockerfilePath,
      `${readFileSync(dockerfilePath, "utf8")}${directive}\n`,
    );
    await assert.rejects(
      () => verify(candidate),
      /exact represented stage graph/u,
      directive,
    );
  }
});

test("rejects duplicate JSON keys at top level and nested escaped-key depth", async (t) => {
  const duplicateProvenance = fixture();
  t.after(() => rmSync(duplicateProvenance.root, { force: true, recursive: true }));
  const provenancePath = path.join(
    duplicateProvenance.artifactRoot,
    "handleplan.provenance.json",
  );
  const originalProvenance = readFileSync(provenancePath, "utf8");
  const ambiguousProvenance = originalProvenance.replace(
    '  "predicateType": "https://slsa.dev/provenance/v1",',
    [
      '  "predicateType": "https://example.invalid/wrong",',
      '  "predicateType": "https://slsa.dev/provenance/v1",',
    ].join("\n"),
  );
  assert.deepEqual(JSON.parse(ambiguousProvenance), JSON.parse(originalProvenance));
  writeFileSync(provenancePath, ambiguousProvenance);
  refreshArtifactDigest(
    duplicateProvenance,
    "provenance_sha256",
    "handleplan.provenance.json",
  );
  await assert.rejects(() => verify(duplicateProvenance), /duplicate object key/u);

  const escapedNestedSbom = fixture();
  t.after(() => rmSync(escapedNestedSbom.root, { force: true, recursive: true }));
  const sbomPath = path.join(escapedNestedSbom.artifactRoot, "handleplan.spdx.json");
  const originalSbom = readFileSync(sbomPath, "utf8");
  const ambiguousSbom = originalSbom.replace(
    '      "name": "handleplan",',
    [
      '      "name": "wrong",',
      '      "n\\u0061me": "handleplan",',
    ].join("\n"),
  );
  assert.deepEqual(JSON.parse(ambiguousSbom), JSON.parse(originalSbom));
  writeFileSync(sbomPath, ambiguousSbom);
  refreshArtifactDigest(escapedNestedSbom, "sbom_sha256", "handleplan.spdx.json");
  await assert.rejects(() => verify(escapedNestedSbom), /duplicate object key/u);
});
