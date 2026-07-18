import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  comparePublicTrees,
  computePrivilegedRuntimeShipmentSnapshot,
  computeSealedArtifactSnapshot,
  createPrivilegedRuntimeShipmentBinding,
  parseArguments,
  parseRuntimeSealArguments,
  ProductionImageVerificationError,
  readAndValidateDockerArchive,
  validateDockerArchiveManifest,
  validateEmbeddedBuildBinding,
  validateEmbeddedRuntimeShipmentBinding,
  validateProductionImageInspection,
  verifyProductionImage,
} from "../../scripts/operations/verify-production-image.mjs";

const revision = "a".repeat(40);
const classicArchiveConfigRaw = JSON.stringify({
  architecture: "amd64",
  config: { Labels: { "org.opencontainers.image.revision": revision } },
  os: "linux",
});
const imageId = `sha256:${createHash("sha256").update(classicArchiveConfigRaw).digest("hex")}`;
const imageReference = `handleplan:${revision}`;
const publicBuildIdPlaceholder = "__HANDLEPLAN_PUBLIC_BUILD_ID__";

function inspection(overrides = {}) {
  const baseConfig = {
    Entrypoint: ["/app/deploy/entrypoint.sh"],
    Env: [
      "PATH=/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "NODE_VERSION=22.22.3",
      "YARN_VERSION=1.22.22",
      "NEXT_TELEMETRY_DISABLED=1",
      "PNPM_HOME=/pnpm",
      "NODE_ENV=production",
      "HOSTNAME=0.0.0.0",
      "PORT=3000",
    ],
    Labels: { "org.opencontainers.image.revision": revision },
    User: "nextjs",
    WorkingDir: "/app",
  };
  return [{
    Architecture: "amd64",
    Id: imageId,
    Os: "linux",
    RepoTags: [imageReference],
    ...overrides,
    Config: { ...baseConfig, ...overrides.Config },
  }];
}

function binding() {
  const sourceDigestSha256 = "c".repeat(64);
  return {
    artifactDigestSha256: "d".repeat(64),
    artifactEntryCount: 12,
    artifactFileCount: 8,
    artifactSymlinkCount: 2,
    architecture: "x64",
    buildEnvironment: {
      contractVersion: 1,
      environment: {
        APP_COMMIT_SHA: revision,
        CI: "true",
        HANDLEPLAN_PUBLIC_BUILD_SOURCE_DIGEST: sourceDigestSha256,
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        NEXT_PUBLIC_HANDLEPLAN_BUILD_ID: `hpv2-${sourceDigestSha256}`,
        NEXT_TELEMETRY_DISABLED: "1",
        NODE_ENV: "production",
        TZ: "UTC",
      },
      nodeVersion: "22.22.3",
      wrapper: "handleplan-public-build-v2",
    },
    buildId: `hpv2-${sourceDigestSha256}`,
    contractVersion: 2,
    nodeVersion: "22.22.3",
    platform: "linux",
    sourceDigestSha256,
    sourceFileCount: 5,
  };
}

function runtimeSourceBinding() {
  return {
    digestSha256: "e".repeat(64),
    fileCount: 17,
  };
}

function runtimeReceipt(overrides = {}) {
  return {
    contractVersion: 1,
    nodeVersion: "22.22.3",
    revision,
    shipmentDigestSha256: "f".repeat(64),
    shipmentEntryCount: 12,
    shipmentFileCount: 7,
    shipmentSymlinkCount: 0,
    sourceDigestSha256: runtimeSourceBinding().digestSha256,
    sourceFileCount: runtimeSourceBinding().fileCount,
    ...overrides,
  };
}

function makeTree(root, body = "service-worker\n") {
  mkdirSync(path.join(root, "icons"), { recursive: true });
  writeFileSync(path.join(root, "sw.js"), body);
  writeFileSync(path.join(root, "icons", "handleplan.svg"), "<svg />\n");
}

test("validates the exact revision tag, image ID, runtime identity, and entrypoint", () => {
  const result = validateProductionImageInspection(inspection(), {
    expectedImageId: imageId,
    expectedRevision: revision,
    imageReference,
  });
  assert.equal(result.Id, imageId);

  for (const invalid of [
    inspection({ Id: `sha256:${"e".repeat(64)}` }),
    inspection({ Architecture: "arm64" }),
    inspection({ Os: "windows" }),
    inspection({ RepoTags: ["handleplan:ci"] }),
    inspection({ Config: { Entrypoint: ["node"] } }),
    inspection({ Config: { Env: ["DATABASE_URL=postgresql://embedded"] } }),
    inspection({ Config: { Env: [...baseEnvironment(), "WEB_DATABASE_URL=postgresql://embedded"] } }),
    inspection({ Config: { Env: [...baseEnvironment(), "NEXT_PUBLIC_DEBUG=1"] } }),
    inspection({ Config: { Labels: { "org.opencontainers.image.revision": "f".repeat(40) } } }),
    inspection({ Config: { Volumes: { "/tmp": {} } } }),
  ]) {
    assert.throws(
      () => validateProductionImageInspection(invalid, {
        expectedImageId: imageId,
        expectedRevision: revision,
        imageReference,
      }),
      ProductionImageVerificationError,
    );
  }
});

function baseEnvironment() {
  return inspection()[0].Config.Env;
}

test("compares complete byte-identical public trees and rejects unsafe entries", (t) => {
  const temp = mkdtempSync(path.join(tmpdir(), "handleplan-public-tree-test-"));
  t.after(() => rmSync(temp, { force: true, recursive: true }));
  const expected = path.join(temp, "expected");
  const actual = path.join(temp, "actual");
  makeTree(expected);
  cpSync(expected, actual, { recursive: true });
  assert.equal(comparePublicTrees(expected, actual).fileCount, 2);

  writeFileSync(path.join(actual, "sw.js"), "changed\n");
  assert.throws(() => comparePublicTrees(expected, actual), /differs/u);
  rmSync(actual, { recursive: true });
  cpSync(expected, actual, { recursive: true });
  writeFileSync(path.join(actual, "extra"), "unexpected\n");
  assert.throws(() => comparePublicTrees(expected, actual), /differs/u);
  rmSync(path.join(actual, "extra"));
  rmSync(path.join(actual, "sw.js"));
  assert.throws(() => comparePublicTrees(expected, actual), /differs/u);
  symlinkSync("../icons/handleplan.svg", path.join(actual, "sw.js"));
  assert.throws(() => comparePublicTrees(expected, actual), /symbolic link/u);
});

test("compares source public trees after exact service-worker build ID materialization", (t) => {
  const temp = mkdtempSync(path.join(tmpdir(), "handleplan-materialized-public-test-"));
  t.after(() => rmSync(temp, { force: true, recursive: true }));
  const expected = path.join(temp, "expected");
  const actual = path.join(temp, "actual");
  const buildId = `hpv2-${"1".repeat(64)}`;
  const wrongBuildId = `hpv2-${"2".repeat(64)}`;
  const serviceWorkerSource = `const BUILD_ID = "${publicBuildIdPlaceholder}";\n`;
  makeTree(expected, serviceWorkerSource);
  makeTree(actual, serviceWorkerSource.replace(publicBuildIdPlaceholder, buildId));

  assert.equal(comparePublicTrees(expected, actual, buildId).fileCount, 2);
  assert.throws(() => comparePublicTrees(expected, actual, wrongBuildId), /differs/u);
});

test("public tree framing resists binary NUL boundary collisions with identical paths and counts", (t) => {
  const temp = mkdtempSync(path.join(tmpdir(), "handleplan-public-framing-test-"));
  t.after(() => rmSync(temp, { force: true, recursive: true }));
  const left = path.join(temp, "left");
  const right = path.join(temp, "right");
  mkdirSync(left);
  mkdirSync(right);
  const oldFrameBoundary = Buffer.from("\0file\0b\0", "utf8");
  writeFileSync(path.join(left, "a"), Buffer.alloc(0));
  writeFileSync(path.join(left, "b"), Buffer.concat([oldFrameBoundary, Buffer.from("z")]));
  writeFileSync(path.join(right, "a"), oldFrameBoundary);
  writeFileSync(path.join(right, "b"), Buffer.from("z"));
  assert.throws(() => comparePublicTrees(left, right), /differs/u);
});

test("validates the embedded v2 build receipt and safe exact Docker archive RepoTag", () => {
  assert.equal(validateEmbeddedBuildBinding(binding(), revision).contractVersion, 2);
  assert.throws(
    () => validateEmbeddedBuildBinding({ ...binding(), contractVersion: 1 }, revision),
    /binding receipt/u,
  );
  assert.throws(
    () => validateEmbeddedBuildBinding({ ...binding(), architecture: "arm64" }, revision),
    /binding receipt/u,
  );
  const manifest = [{
    Config: `${imageId.slice("sha256:".length)}.json`,
    Layers: [`${"e".repeat(64)}/layer.tar`],
    RepoTags: [imageReference],
  }];
  assert.equal(validateDockerArchiveManifest(manifest, {
    expectedImageId: imageId,
    expectedRevision: revision,
    imageReference,
  }).RepoTags[0], imageReference);
  assert.throws(
    () => validateDockerArchiveManifest([{ ...manifest[0], RepoTags: ["handleplan:ci"] }], {
      expectedImageId: imageId,
      expectedRevision: revision,
      imageReference,
    }),
    /archive/u,
  );
  const contentStoreManifest = [{
    Config: `blobs/sha256/${imageId.slice("sha256:".length)}`,
    Layers: [`blobs/sha256/${"1".repeat(64)}`],
    RepoTags: [imageReference],
  }];
  assert.throws(
    () => validateDockerArchiveManifest(contentStoreManifest, {
      expectedImageId: imageId,
      expectedRevision: revision,
      imageReference,
    }),
    /archive/u,
    "manifest.json alone cannot authorize a content-store archive",
  );
  assert.throws(
    () => validateDockerArchiveManifest([{
      ...contentStoreManifest[0],
      Config: `blobs/sha256/${"f".repeat(64)}`,
    }], {
      expectedImageId: imageId,
      expectedRevision: revision,
      imageReference,
    }),
    /archive/u,
  );
});

test("rejects a classic Linux ARM64 archive even when its revision and immutable ID match", (t) => {
  const temp = mkdtempSync(path.join(tmpdir(), "handleplan-arm64-archive-test-"));
  t.after(() => rmSync(temp, { force: true, recursive: true }));
  const archive = path.join(temp, "image.tar");
  writeFileSync(archive, "archive fixture\n");
  const armConfig = JSON.stringify({
    architecture: "arm64",
    config: { Labels: { "org.opencontainers.image.revision": revision } },
    os: "linux",
  });
  const armImageId = `sha256:${createHash("sha256").update(armConfig).digest("hex")}`;
  const armManifest = [{
    Config: `${armImageId.slice("sha256:".length)}.json`,
    Layers: [`${"e".repeat(64)}/layer.tar`],
    RepoTags: [imageReference],
  }];
  assert.throws(
    () => readAndValidateDockerArchive(archive, {
      expectedImageId: armImageId,
      expectedRevision: revision,
      imageReference,
    }, (_command, arguments_) => arguments_.at(-1) === "manifest.json"
      ? JSON.stringify(armManifest)
      : armConfig),
    /classic config is invalid/u,
  );
});

test("cryptographically links a containerd OCI index image ID to manifest.json", (t) => {
  const temp = mkdtempSync(path.join(tmpdir(), "handleplan-oci-archive-test-"));
  t.after(() => rmSync(temp, { force: true, recursive: true }));
  const archive = path.join(temp, "image.tar");
  writeFileSync(archive, "archive fixture\n");
  const digest = (raw) => `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  const configRaw = JSON.stringify({
    architecture: "amd64",
    config: { Labels: { "org.opencontainers.image.revision": revision } },
    os: "linux",
  });
  const configDescriptor = {
    digest: digest(configRaw),
    mediaType: "application/vnd.oci.image.config.v1+json",
    size: Buffer.byteLength(configRaw),
  };
  const layerDescriptor = {
    digest: `sha256:${"1".repeat(64)}`,
    mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
    size: 123,
  };
  const secondLayerDescriptor = {
    digest: `sha256:${"2".repeat(64)}`,
    mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
    size: 456,
  };
  const runtimeManifestRaw = JSON.stringify({
    config: configDescriptor,
    layers: [layerDescriptor, secondLayerDescriptor],
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    schemaVersion: 2,
  });
  const runtimeDescriptor = {
    digest: digest(runtimeManifestRaw),
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    platform: { architecture: "amd64", os: "linux" },
    size: Buffer.byteLength(runtimeManifestRaw),
  };
  const attestationConfigRaw = JSON.stringify({
    architecture: "unknown",
    config: {},
    os: "unknown",
  });
  const attestationConfigDescriptor = {
    digest: digest(attestationConfigRaw),
    mediaType: "application/vnd.oci.image.config.v1+json",
    size: Buffer.byteLength(attestationConfigRaw),
  };
  const attestationStatementRaw = JSON.stringify({
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
  });
  const attestationLayerDescriptor = {
    annotations: { "in-toto.io/predicate-type": "https://slsa.dev/provenance/v1" },
    digest: digest(attestationStatementRaw),
    mediaType: "application/vnd.in-toto+json",
    size: Buffer.byteLength(attestationStatementRaw),
  };
  const attestationManifestRaw = JSON.stringify({
    config: attestationConfigDescriptor,
    layers: [attestationLayerDescriptor],
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    schemaVersion: 2,
  });
  const attestationDescriptor = {
    annotations: {
      "vnd.docker.reference.digest": runtimeDescriptor.digest,
      "vnd.docker.reference.type": "attestation-manifest",
    },
    digest: digest(attestationManifestRaw),
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    platform: { architecture: "unknown", os: "unknown" },
    size: Buffer.byteLength(attestationManifestRaw),
  };
  const rootRaw = JSON.stringify({
    manifests: [runtimeDescriptor, attestationDescriptor],
    mediaType: "application/vnd.oci.image.index.v1+json",
    schemaVersion: 2,
  });
  const contentStoreImageId = digest(rootRaw);
  const indexRaw = JSON.stringify({
    manifests: [{
      annotations: {
        "io.containerd.image.name": `docker.io/library/${imageReference}`,
        "org.opencontainers.image.ref.name": revision,
      },
      digest: contentStoreImageId,
      mediaType: "application/vnd.oci.image.index.v1+json",
      size: Buffer.byteLength(rootRaw),
    }],
    mediaType: "application/vnd.oci.image.index.v1+json",
    schemaVersion: 2,
  });
  const manifest = [{
    Config: `blobs/sha256/${configDescriptor.digest.slice("sha256:".length)}`,
    Layers: [layerDescriptor, secondLayerDescriptor].map(
      (layer) => `blobs/sha256/${layer.digest.slice("sha256:".length)}`,
    ),
    RepoTags: [imageReference],
  }];
  const blobs = new Map([
    [`blobs/sha256/${contentStoreImageId.slice("sha256:".length)}`, rootRaw],
    [`blobs/sha256/${runtimeDescriptor.digest.slice("sha256:".length)}`, runtimeManifestRaw],
    [`blobs/sha256/${configDescriptor.digest.slice("sha256:".length)}`, configRaw],
    [`blobs/sha256/${attestationDescriptor.digest.slice("sha256:".length)}`, attestationManifestRaw],
    [`blobs/sha256/${attestationConfigDescriptor.digest.slice("sha256:".length)}`, attestationConfigRaw],
    [`blobs/sha256/${attestationLayerDescriptor.digest.slice("sha256:".length)}`, attestationStatementRaw],
  ]);
  function commandRunner(_command, arguments_) {
    const member = arguments_.at(-1);
    if (member === "manifest.json") return JSON.stringify(manifest);
    if (member === "oci-layout") return JSON.stringify({ imageLayoutVersion: "1.0.0" });
    if (member === "index.json") return indexRaw;
    const blob = blobs.get(member);
    if (blob === undefined) throw new Error(`unexpected archive member ${member}`);
    return blob;
  }
  const expected = {
    expectedImageId: contentStoreImageId,
    expectedRevision: revision,
    imageReference,
  };
  assert.equal(
    readAndValidateDockerArchive(archive, expected, commandRunner).RepoTags[0],
    imageReference,
  );
  assert.throws(
    () => validateDockerArchiveManifest(manifest, expected),
    /archive/u,
    "manifest.json alone must not authorize a different content-store image ID",
  );
  assert.throws(
    () => readAndValidateDockerArchive(archive, expected, (_command, arguments_) => {
      const member = arguments_.at(-1);
      if (member === "manifest.json") return JSON.stringify(manifest);
      if (member === "index.json") return indexRaw;
      if (member === `blobs/sha256/${contentStoreImageId.slice("sha256:".length)}`) {
        return `${rootRaw} `;
      }
      return commandRunner(_command, arguments_);
    }),
    /does not match/u,
  );
  const unlinkedManifest = [{
    ...manifest[0],
    Config: `blobs/sha256/${"f".repeat(64)}`,
  }];
  assert.throws(
    () => readAndValidateDockerArchive(archive, expected, (_command, arguments_) => {
      if (arguments_.at(-1) === "manifest.json") return JSON.stringify(unlinkedManifest);
      return commandRunner(_command, arguments_);
    }),
    /not linked/u,
  );
  const reversedLayerManifest = [{
    ...manifest[0],
    Layers: [...manifest[0].Layers].reverse(),
  }];
  assert.throws(
    () => readAndValidateDockerArchive(archive, expected, (_command, arguments_) => {
      if (arguments_.at(-1) === "manifest.json") {
        return JSON.stringify(reversedLayerManifest);
      }
      return commandRunner(_command, arguments_);
    }),
    /not linked/u,
  );
  function rootVariant(mutatedRoot) {
    const mutatedRootRaw = JSON.stringify(mutatedRoot);
    const mutatedImageId = digest(mutatedRootRaw);
    const mutatedIndexRaw = JSON.stringify({
      manifests: [{
        annotations: {
          "io.containerd.image.name": `docker.io/library/${imageReference}`,
          "org.opencontainers.image.ref.name": revision,
        },
        digest: mutatedImageId,
        mediaType: "application/vnd.oci.image.index.v1+json",
        size: Buffer.byteLength(mutatedRootRaw),
      }],
      mediaType: "application/vnd.oci.image.index.v1+json",
      schemaVersion: 2,
    });
    return {
      expected: { ...expected, expectedImageId: mutatedImageId },
      runner(_command, arguments_) {
        const member = arguments_.at(-1);
        if (member === "index.json") return mutatedIndexRaw;
        if (member === `blobs/sha256/${mutatedImageId.slice("sha256:".length)}`) {
          return mutatedRootRaw;
        }
        return commandRunner(_command, arguments_);
      },
    };
  }
  const wrongReference = rootVariant({
    ...JSON.parse(rootRaw),
    manifests: [runtimeDescriptor, {
      ...attestationDescriptor,
      annotations: {
        ...attestationDescriptor.annotations,
        "vnd.docker.reference.digest": `sha256:${"9".repeat(64)}`,
      },
    }],
  });
  assert.throws(
    () => readAndValidateDockerArchive(archive, wrongReference.expected, wrongReference.runner),
    /exactly one runtime/u,
  );
  const duplicateDigest = rootVariant({
    ...JSON.parse(rootRaw),
    manifests: [runtimeDescriptor, {
      ...attestationDescriptor,
      digest: runtimeDescriptor.digest,
      size: runtimeDescriptor.size,
    }],
  });
  assert.throws(
    () => readAndValidateDockerArchive(archive, duplicateDigest.expected, duplicateDigest.runner),
    /exactly one runtime/u,
  );
  const armRuntime = rootVariant({
    ...JSON.parse(rootRaw),
    manifests: [{
      ...runtimeDescriptor,
      platform: { architecture: "arm64", os: "linux" },
    }, attestationDescriptor],
  });
  assert.throws(
    () => readAndValidateDockerArchive(archive, armRuntime.expected, armRuntime.runner),
    /child descriptor is invalid/u,
  );
});

test("cryptographically links a Docker 28 image-store archive to its config image ID", (t) => {
  const temp = mkdtempSync(path.join(tmpdir(), "handleplan-moby-archive-test-"));
  t.after(() => rmSync(temp, { force: true, recursive: true }));
  const archive = path.join(temp, "image.tar");
  writeFileSync(archive, "archive fixture\n");
  const digest = (raw) => `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  const layerBlobs = [Buffer.from("first Docker 28 layer\n"), Buffer.from("second layer\n")];
  const layers = layerBlobs.map((raw, index) => ({
    digest: digest(raw),
    mediaType: index === 0
      ? "application/vnd.oci.image.layer.v1.tar"
      : "application/vnd.docker.image.rootfs.diff.tar",
    size: raw.length,
  }));
  const configRaw = JSON.stringify({
    architecture: "amd64",
    config: { Labels: { "org.opencontainers.image.revision": revision } },
    os: "linux",
    rootfs: { diff_ids: layers.map((layer) => layer.digest), type: "layers" },
  });
  const configDescriptor = {
    digest: digest(configRaw),
    mediaType: "application/vnd.oci.image.config.v1+json",
    size: Buffer.byteLength(configRaw),
  };
  const runtimeManifestRaw = JSON.stringify({
    config: configDescriptor,
    layers,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    schemaVersion: 2,
  });
  const rootDescriptor = {
    annotations: {
      "io.containerd.image.name": `docker.io/library/${imageReference}`,
      "org.opencontainers.image.ref.name": revision,
    },
    digest: digest(runtimeManifestRaw),
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    size: Buffer.byteLength(runtimeManifestRaw),
  };
  const index = {
    manifests: [rootDescriptor],
    mediaType: "application/vnd.oci.image.index.v1+json",
    schemaVersion: 2,
  };
  const manifest = [{
    Config: `blobs/sha256/${configDescriptor.digest.slice("sha256:".length)}`,
    LayerSources: Object.fromEntries(layers.map((layer) => [layer.digest, layer])),
    Layers: layers.map((layer) => `blobs/sha256/${layer.digest.slice("sha256:".length)}`),
    RepoTags: [imageReference],
  }];
  const blobs = new Map([
    [`blobs/sha256/${rootDescriptor.digest.slice("sha256:".length)}`, runtimeManifestRaw],
    [`blobs/sha256/${configDescriptor.digest.slice("sha256:".length)}`, configRaw],
    ...layers.map((layer, index) => [
      `blobs/sha256/${layer.digest.slice("sha256:".length)}`,
      layerBlobs[index],
    ]),
  ]);
  function commandRunner(_command, arguments_) {
    if (_command === "bash") {
      const member = arguments_.at(-3);
      const blob = blobs.get(member);
      if (blob === undefined) throw new Error(`unexpected archive member ${member}`);
      return JSON.stringify({ digest: digest(blob), size: Buffer.byteLength(blob) });
    }
    const member = arguments_.at(-1);
    if (member === "manifest.json") return JSON.stringify(manifest);
    if (member === "oci-layout") return JSON.stringify({ imageLayoutVersion: "1.0.0" });
    if (member === "index.json") return JSON.stringify(index);
    const blob = blobs.get(member);
    if (blob === undefined) throw new Error(`unexpected archive member ${member}`);
    return blob;
  }
  const expected = {
    expectedImageId: configDescriptor.digest,
    expectedRevision: revision,
    imageReference,
  };
  const archiveRoot = path.join(temp, "archive-root");
  const blobRoot = path.join(archiveRoot, "blobs", "sha256");
  mkdirSync(blobRoot, { recursive: true });
  writeFileSync(path.join(archiveRoot, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(path.join(archiveRoot, "index.json"), JSON.stringify(index));
  writeFileSync(
    path.join(archiveRoot, "oci-layout"),
    JSON.stringify({ imageLayoutVersion: "1.0.0" }),
  );
  for (const [member, raw] of blobs) {
    writeFileSync(path.join(archiveRoot, member), raw);
  }
  const tarResult = spawnSync(
    "tar",
    ["-cf", archive, "-C", archiveRoot, "manifest.json", "index.json", "oci-layout", "blobs"],
    { encoding: "utf8" },
  );
  assert.equal(tarResult.status, 0, tarResult.stderr);
  assert.equal(
    readAndValidateDockerArchive(archive, expected).RepoTags[0],
    imageReference,
    "the default verifier streams and hashes real Docker 28 layer members",
  );
  assert.equal(
    readAndValidateDockerArchive(archive, expected, commandRunner).RepoTags[0],
    imageReference,
  );
  assert.throws(
    () => validateDockerArchiveManifest(manifest, expected),
    /archive/u,
    "manifest.json alone must not authorize the Docker 28 content-store layout",
  );
  const firstLayerSource = manifest[0].LayerSources[layers[0].digest];
  const externalLayerSourceManifest = [{
    ...manifest[0],
    LayerSources: {
      ...manifest[0].LayerSources,
      [layers[0].digest]: {
        ...firstLayerSource,
        urls: ["https://layers.invalid/external.tar"],
      },
    },
  }];
  assert.throws(
    () => readAndValidateDockerArchive(archive, expected, (_command, arguments_) =>
      arguments_.at(-1) === "manifest.json"
        ? JSON.stringify(externalLayerSourceManifest)
        : commandRunner(_command, arguments_)),
    /unsafe shape/u,
    "Docker 28 layer-source metadata must not authorize external layer URLs",
  );
  const incompleteLayerSourcesManifest = [{
    ...manifest[0],
    LayerSources: { [layers[0].digest]: firstLayerSource },
  }];
  assert.throws(
    () => readAndValidateDockerArchive(archive, expected, (_command, arguments_) =>
      arguments_.at(-1) === "manifest.json"
        ? JSON.stringify(incompleteLayerSourcesManifest)
        : commandRunner(_command, arguments_)),
    /unsafe shape/u,
    "Docker 28 layer-source metadata must bind every archived layer exactly once",
  );
  const wrongConfigManifest = [{
    ...manifest[0],
    Config: `blobs/sha256/${"f".repeat(64)}`,
  }];
  assert.throws(
    () => readAndValidateDockerArchive(archive, expected, (_command, arguments_) =>
      arguments_.at(-1) === "manifest.json"
        ? JSON.stringify(wrongConfigManifest)
        : commandRunner(_command, arguments_)),
    /unsafe shape/u,
    "the Docker 28 config blob path must be the exact inspected image ID",
  );
  const mismatchedLayerSourceManifest = [{
    ...manifest[0],
    LayerSources: {
      ...manifest[0].LayerSources,
      [layers[0].digest]: { ...firstLayerSource, size: firstLayerSource.size + 1 },
    },
  }];
  assert.throws(
    () => readAndValidateDockerArchive(archive, expected, (_command, arguments_) =>
      arguments_.at(-1) === "manifest.json"
        ? JSON.stringify(mismatchedLayerSourceManifest)
        : commandRunner(_command, arguments_)),
    /not linked/u,
    "layer-source sizes must match the hash-verified runtime manifest",
  );
  assert.throws(
    () => readAndValidateDockerArchive(archive, expected, (_command, arguments_) => {
      if (_command === "bash" && arguments_.at(-3) === manifest[0].Layers[0]) {
        throw new Error("missing layer");
      }
      return commandRunner(_command, arguments_);
    }),
    /missing or unreadable/u,
    "every Docker 28 runtime layer must be present in the archive",
  );
  assert.throws(
    () => readAndValidateDockerArchive(archive, expected, (_command, arguments_) => {
      if (_command === "bash" && arguments_.at(-3) === manifest[0].Layers[0]) {
        return JSON.stringify({ digest: `sha256:${"0".repeat(64)}`, size: layers[0].size });
      }
      return commandRunner(_command, arguments_);
    }),
    /does not match its descriptor/u,
    "every Docker 28 runtime layer must match its digest and size",
  );
  const rootfsFreeConfigRaw = JSON.stringify({
    architecture: "amd64",
    config: { Labels: { "org.opencontainers.image.revision": revision } },
    os: "linux",
  });
  const rootfsFreeConfigDescriptor = {
    ...configDescriptor,
    digest: digest(rootfsFreeConfigRaw),
    size: Buffer.byteLength(rootfsFreeConfigRaw),
  };
  const rootfsFreeRuntimeRaw = JSON.stringify({
    ...JSON.parse(runtimeManifestRaw),
    config: rootfsFreeConfigDescriptor,
  });
  const rootfsFreeRootDescriptor = {
    ...rootDescriptor,
    digest: digest(rootfsFreeRuntimeRaw),
    size: Buffer.byteLength(rootfsFreeRuntimeRaw),
  };
  const rootfsFreeExpected = { ...expected, expectedImageId: rootfsFreeConfigDescriptor.digest };
  const rootfsFreeManifest = [{
    ...manifest[0],
    Config: `blobs/sha256/${rootfsFreeConfigDescriptor.digest.slice("sha256:".length)}`,
  }];
  assert.throws(
    () => readAndValidateDockerArchive(
      archive,
      rootfsFreeExpected,
      (_command, arguments_) => {
        const member = arguments_.at(-1);
        if (member === "manifest.json") return JSON.stringify(rootfsFreeManifest);
        if (member === "index.json") {
          return JSON.stringify({ ...index, manifests: [rootfsFreeRootDescriptor] });
        }
        if (member === `blobs/sha256/${rootfsFreeRootDescriptor.digest.slice("sha256:".length)}`) {
          return rootfsFreeRuntimeRaw;
        }
        if (member === `blobs/sha256/${rootfsFreeConfigDescriptor.digest.slice("sha256:".length)}`) {
          return rootfsFreeConfigRaw;
        }
        return commandRunner(_command, arguments_);
      },
    ),
    /runtime config is invalid/u,
    "the inspected config ID must bind the ordered uncompressed layer diff IDs",
  );
  const indexRoot = {
    ...index,
    manifests: [{
      ...rootDescriptor,
      mediaType: "application/vnd.oci.image.index.v1+json",
    }],
  };
  assert.throws(
    () => readAndValidateDockerArchive(archive, expected, (_command, arguments_) =>
      arguments_.at(-1) === "index.json"
        ? JSON.stringify(indexRoot)
        : commandRunner(_command, arguments_)),
    /exact image ID and revision tag/u,
    "the Docker 28 dialect must point directly to one runtime manifest",
  );
});

test("validates the exact privileged runtime receipt shape and counts", () => {
  assert.equal(
    validateEmbeddedRuntimeShipmentBinding(runtimeReceipt(), revision).contractVersion,
    1,
  );
  for (const invalid of [
    runtimeReceipt({ revision: "0".repeat(40) }),
    runtimeReceipt({ shipmentDigestSha256: "not-a-digest" }),
    runtimeReceipt({ shipmentEntryCount: 0 }),
    runtimeReceipt({ shipmentEntryCount: 2, shipmentFileCount: 3 }),
    { ...runtimeReceipt(), unexpected: true },
  ]) {
    assert.throws(
      () => validateEmbeddedRuntimeShipmentBinding(invalid, revision),
      /runtime shipment receipt/u,
    );
  }
});

test("verifies copied image contents by immutable ID and always removes the stopped container", (t) => {
  const temp = mkdtempSync(path.join(tmpdir(), "handleplan-image-contract-test-"));
  t.after(() => rmSync(temp, { force: true, recursive: true }));
  const repositoryRoot = path.join(temp, "repository");
  const sourcePublic = path.join(repositoryRoot, "apps", "web", "public");
  const releaseProof = path.join(temp, "release-proof");
  const imageAppRoot = path.join(temp, "image-app-root");
  const imageApps = path.join(temp, "image-apps");
  const imageDeploy = path.join(temp, "image-deploy");
  const imageNodeModules = path.join(temp, "image-node-modules");
  const archive = path.join(temp, "image.tar");
  const fixtureBinding = binding();
  const fixtureDockerfile = "FROM fixture\nCOPY sealed runtime\n";
  const fixtureDockerignore = "node_modules\n";
  const sourceServiceWorker = `const BUILD_ID = "${publicBuildIdPlaceholder}";\n`;
  makeTree(sourcePublic, sourceServiceWorker);
  writeFileSync(path.join(repositoryRoot, "Dockerfile"), fixtureDockerfile);
  writeFileSync(path.join(repositoryRoot, ".dockerignore"), fixtureDockerignore);
  const standaloneWeb = path.join(releaseProof, "standalone", "apps", "web");
  const standaloneStatic = path.join(standaloneWeb, ".next", "static");
  const standaloneNodeModules = path.join(releaseProof, "standalone", "node_modules");
  const standalonePnpm = path.join(standaloneNodeModules, ".pnpm");
  mkdirSync(standaloneStatic, { recursive: true });
  mkdirSync(standalonePnpm, { recursive: true });
  cpSync(sourcePublic, path.join(standaloneWeb, "public"), { recursive: true });
  writeFileSync(
    path.join(standaloneWeb, "public", "sw.js"),
    sourceServiceWorker.replace(publicBuildIdPlaceholder, fixtureBinding.buildId),
  );
  writeFileSync(path.join(standaloneWeb, ".next", "BUILD_ID"), fixtureBinding.buildId);
  writeFileSync(path.join(standaloneStatic, "chunk.js"), "chunk\n");
  writeFileSync(path.join(standaloneWeb, "server.js"), "server\n");
  writeFileSync(path.join(standalonePnpm, "fixture.js"), "sealed dependency\n");
  mkdirSync(path.join(standaloneWeb, "node_modules"), { recursive: true });
  symlinkSync(
    "../../../node_modules/.pnpm/fixture.js",
    path.join(standaloneWeb, "node_modules", "fixture.js"),
  );
  mkdirSync(path.join(releaseProof, "build-root"), { recursive: true });
  writeFileSync(path.join(releaseProof, "build-root", "BUILD_ID"), fixtureBinding.buildId);
  cpSync(standaloneStatic, path.join(releaseProof, "build-root", "static"), { recursive: true });
  writeFileSync(
    path.join(releaseProof, "build-root", "handleplan-public-build-environment.json"),
    `${JSON.stringify(fixtureBinding.buildEnvironment)}\n`,
  );
  mkdirSync(path.join(releaseProof, "packaging"), { recursive: true });
  writeFileSync(path.join(releaseProof, "packaging", "Dockerfile"), fixtureDockerfile);
  writeFileSync(path.join(releaseProof, "packaging", ".dockerignore"), fixtureDockerignore);
  const artifact = computeSealedArtifactSnapshot(releaseProof);
  Object.assign(fixtureBinding, {
    artifactDigestSha256: artifact.digestSha256,
    artifactEntryCount: artifact.entryCount,
    artifactFileCount: artifact.fileCount,
    artifactSymlinkCount: artifact.symlinkCount,
  });
  cpSync(path.join(releaseProof, "standalone", "apps"), imageApps, {
    recursive: true,
    verbatimSymlinks: true,
  });
  cpSync(standaloneNodeModules, imageNodeModules, {
    recursive: true,
    verbatimSymlinks: true,
  });
  mkdirSync(path.join(imageNodeModules, "postgres"), { recursive: true });
  writeFileSync(
    path.join(imageNodeModules, "postgres", "fixture.js"),
    "dependency\n",
  );
  mkdirSync(imageDeploy, { recursive: true });
  mkdirSync(path.join(imageApps, "worker", "dist"), { recursive: true });
  writeFileSync(path.join(imageApps, "worker", "dist", "main.mjs"), "worker\n");
  writeFileSync(path.join(imageDeploy, "entrypoint.sh"), "#!/bin/sh\n");
  writeFileSync(path.join(imageDeploy, "migrate.mjs"), "export {};\n");
  mkdirSync(path.join(imageDeploy, "migrations"), { recursive: true });
  writeFileSync(path.join(imageDeploy, "migrations", "001.sql"), "select 1;\n");
  writeFileSync(
    path.join(imageApps, "web", ".next", "handleplan-public-build-binding.json"),
    `${JSON.stringify(fixtureBinding)}\n`,
  );
  writeFileSync(archive, "archive fixture\n");
  mkdirSync(imageAppRoot);
  cpSync(imageApps, path.join(imageAppRoot, "apps"), { recursive: true, verbatimSymlinks: true });
  cpSync(imageDeploy, path.join(imageAppRoot, "deploy"), { recursive: true, verbatimSymlinks: true });
  cpSync(imageNodeModules, path.join(imageAppRoot, "node_modules"), { recursive: true, verbatimSymlinks: true });
  const runtimeBinding = createPrivilegedRuntimeShipmentBinding({
    expectedRevision: revision,
    repositoryRoot,
    runtimeRoot: imageAppRoot,
    sourceBindingProvider: runtimeSourceBinding,
  });
  mkdirSync(path.join(releaseProof, "runtime"), { recursive: true });
  writeFileSync(
    path.join(releaseProof, "runtime", "handleplan-runtime-shipment-binding.json"),
    `${JSON.stringify(runtimeBinding)}\n`,
  );
  cpSync(releaseProof, path.join(imageAppRoot, ".handleplan-release"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  const commands = [];
  let failRuntimeCopy = false;
  function commandRunner(command, arguments_) {
    commands.push([command, ...arguments_]);
    if (command === "tar" && arguments_.at(-1) === "manifest.json") {
      return JSON.stringify([{
        Config: `${imageId.slice("sha256:".length)}.json`,
        Layers: [`${"1".repeat(64)}/layer.tar`],
        RepoTags: [imageReference],
      }]);
    }
    if (command === "tar" && arguments_.at(-1) === `${imageId.slice("sha256:".length)}.json`) {
      return classicArchiveConfigRaw;
    }
    assert.equal(command, "docker");
    if (arguments_[0] === "image" && arguments_[1] === "inspect") {
      return JSON.stringify(inspection());
    }
    if (arguments_[0] === "create") return "container-id\n";
    if (arguments_[0] === "rm") return "container-id\n";
    if (arguments_[0] !== "cp") throw new Error("unexpected Docker command");
    const [source, destination] = arguments_.slice(1);
    if (source.endsWith("/app/.")) {
      if (failRuntimeCopy) throw new ProductionImageVerificationError("copy failed");
      cpSync(imageAppRoot, destination, { recursive: true, verbatimSymlinks: true });
    } else {
      throw new Error(`unexpected copy source ${source}`);
    }
    return "";
  }

  const result = verifyProductionImage({
    archivePath: archive,
    commandRunner,
    expectedImageId: imageId,
    expectedRevision: revision,
    imageReference,
    repositoryRoot,
    runtimeSourceBindingProvider: runtimeSourceBinding,
    sourceBindingProvider: () => ({
      digestSha256: fixtureBinding.sourceDigestSha256,
      fileCount: fixtureBinding.sourceFileCount,
    }),
  });
  assert.equal(result.imageId, imageId);
  assert.equal(result.platform, "linux/amd64");
  assert.equal(result.publicFileCount, 2);
  assert.equal(result.artifactDigestSha256, fixtureBinding.artifactDigestSha256);
  assert.equal(result.shipmentDigestSha256, runtimeBinding.shipmentDigestSha256);
  assert.equal(result.shipmentEntryCount, runtimeBinding.shipmentEntryCount);
  assert.equal(result.runtimeSourceDigestSha256, runtimeBinding.sourceDigestSha256);
  assert.equal(result.runtimeSourceFileCount, runtimeBinding.sourceFileCount);
  assert.ok(commands.some((command) =>
    command[1] === "create"
    && command.at(-1) === imageId
    && !command.includes("--entrypoint")
    && !command.includes("--mount")
    && !command.includes("--volume")));
  assert.ok(commands.some((command) => command[1] === "rm" && command[2] === "-f"));

  assert.throws(() => verifyProductionImage({
    commandRunner,
    expectedImageId: imageId,
    expectedRevision: revision,
    imageReference,
    repositoryRoot,
    runtimeSourceBindingProvider: runtimeSourceBinding,
    sourceBindingProvider: () => ({
      digestSha256: "0".repeat(64),
      fileCount: fixtureBinding.sourceFileCount,
    }),
  }), /exact revision source tree/u);

  commands.length = 0;
  failRuntimeCopy = true;
  assert.throws(() => verifyProductionImage({
    commandRunner,
    expectedImageId: imageId,
    expectedRevision: revision,
    imageReference,
    repositoryRoot,
    runtimeSourceBindingProvider: runtimeSourceBinding,
    sourceBindingProvider: () => ({
      digestSha256: fixtureBinding.sourceDigestSha256,
      fileCount: fixtureBinding.sourceFileCount,
    }),
  }), /copy failed/u);
  assert.ok(commands.some((command) => command[1] === "rm" && command[2] === "-f"));

  failRuntimeCopy = false;
  writeFileSync(
    path.join(imageAppRoot, "apps", "web", "server.js"),
    "tampered after sealing\n",
  );
  assert.throws(() => verifyProductionImage({
    commandRunner,
    expectedImageId: imageId,
    expectedRevision: revision,
    imageReference,
    repositoryRoot,
    runtimeSourceBindingProvider: runtimeSourceBinding,
    sourceBindingProvider: () => ({
      digestSha256: fixtureBinding.sourceDigestSha256,
      fileCount: fixtureBinding.sourceFileCount,
    }),
  }), /changed a sealed standalone file/u);

  writeFileSync(path.join(imageAppRoot, "apps", "web", "server.js"), "server\n");
  const runtimeWebExtras = [
    path.join(imageAppRoot, "apps", "web", ".env.production"),
    path.join(imageAppRoot, "apps", "web", ".next", "unsealed.js"),
    path.join(imageAppRoot, "apps", "web", "node_modules", "backdoor.js"),
  ];
  for (const pathname of runtimeWebExtras) {
    writeFileSync(pathname, "outside sealed web tree\n");
    assert.throws(() => verifyProductionImage({
      commandRunner,
      expectedImageId: imageId,
      expectedRevision: revision,
      imageReference,
      repositoryRoot,
      runtimeSourceBindingProvider: runtimeSourceBinding,
      sourceBindingProvider: () => ({
        digestSha256: fixtureBinding.sourceDigestSha256,
        fileCount: fixtureBinding.sourceFileCount,
      }),
    }), /runtime web tree contains an entry outside/u);
    rmSync(pathname);
  }
  const escapingRuntimeWebSymlink = path.join(
    imageAppRoot,
    "apps",
    "web",
    ".next",
    "escape",
  );
  symlinkSync("../../../../outside", escapingRuntimeWebSymlink);
  assert.throws(() => verifyProductionImage({
    commandRunner,
    expectedImageId: imageId,
    expectedRevision: revision,
    imageReference,
    repositoryRoot,
    runtimeSourceBindingProvider: runtimeSourceBinding,
    sourceBindingProvider: () => ({
      digestSha256: fixtureBinding.sourceDigestSha256,
      fileCount: fixtureBinding.sourceFileCount,
    }),
  }), /runtime web tree contains an escaping symbolic link/u);
  rmSync(escapingRuntimeWebSymlink);
  const copiedProofChunk = path.join(
    imageAppRoot,
    ".handleplan-release",
    "build-root",
    "static",
    "chunk.js",
  );
  writeFileSync(copiedProofChunk, "tampered proof\n");
  assert.throws(() => verifyProductionImage({
    commandRunner,
    expectedImageId: imageId,
    expectedRevision: revision,
    imageReference,
    repositoryRoot,
    runtimeSourceBindingProvider: runtimeSourceBinding,
    sourceBindingProvider: () => ({
      digestSha256: fixtureBinding.sourceDigestSha256,
      fileCount: fixtureBinding.sourceFileCount,
    }),
  }), /does not match the v2 binding digest/u);
  writeFileSync(copiedProofChunk, "chunk\n");

  const privilegedPayloadMutations = [
    [path.join(imageAppRoot, "apps", "worker", "dist", "main.mjs"), "worker\n"],
    [path.join(imageAppRoot, "deploy", "migrations", "001.sql"), "select 1;\n"],
    [path.join(imageAppRoot, "node_modules", "postgres", "fixture.js"), "dependency\n"],
  ];
  for (const [pathname, original] of privilegedPayloadMutations) {
    writeFileSync(pathname, "nested tampering\n");
    assert.throws(() => verifyProductionImage({
      commandRunner,
      expectedImageId: imageId,
      expectedRevision: revision,
      imageReference,
      repositoryRoot,
      runtimeSourceBindingProvider: runtimeSourceBinding,
      sourceBindingProvider: () => ({
        digestSha256: fixtureBinding.sourceDigestSha256,
        fileCount: fixtureBinding.sourceFileCount,
      }),
    }), /differs from its source-bound shipment receipt/u);
    writeFileSync(pathname, original);
  }

  const nestedRuntimeSymlink = path.join(
    imageAppRoot,
    "node_modules",
    "postgres",
    "unexpected-link",
  );
  symlinkSync("fixture.js", nestedRuntimeSymlink);
  assert.throws(() => verifyProductionImage({
    commandRunner,
    expectedImageId: imageId,
    expectedRevision: revision,
    imageReference,
    repositoryRoot,
    runtimeSourceBindingProvider: runtimeSourceBinding,
    sourceBindingProvider: () => ({
      digestSha256: fixtureBinding.sourceDigestSha256,
      fileCount: fixtureBinding.sourceFileCount,
    }),
  }), /forbidden symbolic link/u);
  rmSync(nestedRuntimeSymlink);

  const dependencyBackdoor = path.join(imageAppRoot, "node_modules", "backdoor.js");
  writeFileSync(dependencyBackdoor, "outside overlay\n");
  assert.throws(() => verifyProductionImage({
    commandRunner,
    expectedImageId: imageId,
    expectedRevision: revision,
    imageReference,
    repositoryRoot,
    runtimeSourceBindingProvider: runtimeSourceBinding,
    sourceBindingProvider: () => ({
      digestSha256: fixtureBinding.sourceDigestSha256,
      fileCount: fixtureBinding.sourceFileCount,
    }),
  }), /outside the sealed tree and postgres overlay/u);
  rmSync(dependencyBackdoor);

  assert.throws(() => verifyProductionImage({
    commandRunner,
    expectedImageId: imageId,
    expectedRevision: revision,
    imageReference,
    repositoryRoot,
    runtimeSourceBindingProvider: () => ({
      digestSha256: "0".repeat(64),
      fileCount: runtimeBinding.sourceFileCount,
    }),
    sourceBindingProvider: () => ({
      digestSha256: fixtureBinding.sourceDigestSha256,
      fileCount: fixtureBinding.sourceFileCount,
    }),
  }), /privileged runtime is not bound to the exact revision source tree/u);

  writeFileSync(path.join(imageAppRoot, "backdoor"), "unexpected\n");
  assert.throws(() => verifyProductionImage({
    commandRunner,
    expectedImageId: imageId,
    expectedRevision: revision,
    imageReference,
    repositoryRoot,
    runtimeSourceBindingProvider: runtimeSourceBinding,
    sourceBindingProvider: () => ({
      digestSha256: fixtureBinding.sourceDigestSha256,
      fileCount: fixtureBinding.sourceFileCount,
    }),
  }), /unexpected or missing entry/u);
});

test("CLI arguments are exact, complete, and duplicate-free", () => {
  assert.deepEqual(parseArguments([
    "--image-reference", imageReference,
    "--expected-image-id", imageId,
    "--expected-revision", revision,
    "--archive", "/tmp/image.tar",
  ]), {
    archivePath: "/tmp/image.tar",
    expectedImageId: imageId,
    expectedRevision: revision,
    imageReference,
  });
  assert.throws(() => parseArguments(["--image-reference", imageReference]), /usage/u);
  assert.throws(() => parseArguments([
    "--image-reference", imageReference,
    "--image-reference", imageReference,
    "--expected-image-id", imageId,
    "--expected-revision", revision,
  ]), /usage/u);
  assert.deepEqual(parseRuntimeSealArguments([
    "--runtime-root", "/tmp/runtime",
    "--output", "/tmp/receipt.json",
    "--expected-revision", revision,
    "--repository-root", "/tmp/repository",
  ]), {
    expectedRevision: revision,
    outputPath: "/tmp/receipt.json",
    repositoryRoot: "/tmp/repository",
    runtimeRoot: "/tmp/runtime",
  });
  assert.throws(
    () => parseRuntimeSealArguments(["--runtime-root", "/tmp/runtime"]),
    /usage/u,
  );
});
