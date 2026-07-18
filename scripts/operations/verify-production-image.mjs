import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  computePublicSourceBinding,
  materializePublicBuildFile,
} from "../e2e/public-build-binding.mjs";

const defaultRepositoryRoot = path.resolve(import.meta.dirname, "../..");
const imagePublicPath = "/app/apps/web/public";
const imageBindingPath = "/app/apps/web/.next/handleplan-public-build-binding.json";
const imageServerPath = "/app/apps/web/server.js";
const imageStaticPath = "/app/apps/web/.next/static";
const imageReleaseProofPath = "/app/.handleplan-release";
const runtimeShipmentBindingFilename = "handleplan-runtime-shipment-binding.json";
const runtimeShipmentBindingPath =
  `/app/.handleplan-release/runtime/${runtimeShipmentBindingFilename}`;
const maximumCommandOutputBytes = 1024 * 1024;
const imageIdPattern = /^sha256:[0-9a-f]{64}$/u;
const revisionPattern = /^[0-9a-f]{40}$/u;
const productionImagePlatform = "linux/amd64";
const ociIndexMediaTypes = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);
const ociManifestMediaTypes = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);
const ociConfigMediaTypes = new Set([
  "application/vnd.oci.image.config.v1+json",
  "application/vnd.docker.container.image.v1+json",
]);
const ociLayerMediaTypes = new Set([
  "application/vnd.oci.image.layer.v1.tar",
  "application/vnd.oci.image.layer.v1.tar+gzip",
  "application/vnd.oci.image.layer.v1.tar+zstd",
  "application/vnd.docker.image.rootfs.diff.tar",
  "application/vnd.docker.image.rootfs.diff.tar.gzip",
]);
const uncompressedOciLayerMediaTypes = new Set([
  "application/vnd.oci.image.layer.v1.tar",
  "application/vnd.docker.image.rootfs.diff.tar",
]);
const ociDigestPattern = /^sha256:([0-9a-f]{64})$/u;
const ociBlobPathPattern = /^blobs\/sha256\/([0-9a-f]{64})$/u;
const runtimeSourceInputPaths = Object.freeze([
  ".dockerignore",
  "Dockerfile",
  "apps/worker",
  "deploy",
  "package.json",
  "packages/db",
  "packages/domain",
  "packages/kassalapp",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts/operations/verify-production-image.mjs",
  "tsconfig.base.json",
]);
const excludedRuntimeSourceDirectories = new Set([
  "apps/worker/.turbo",
  "apps/worker/coverage",
  "apps/worker/dist",
  "apps/worker/node_modules",
  "packages/db/.turbo",
  "packages/db/coverage",
  "packages/db/dist",
  "packages/db/node_modules",
  "packages/domain/.turbo",
  "packages/domain/coverage",
  "packages/domain/dist",
  "packages/domain/node_modules",
  "packages/kassalapp/.turbo",
  "packages/kassalapp/coverage",
  "packages/kassalapp/dist",
  "packages/kassalapp/node_modules",
]);

export class ProductionImageVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProductionImageVerificationError";
  }
}

function fail(message) {
  throw new ProductionImageVerificationError(message);
}

function exactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return actual.length === required.length
    && actual.every((key, index) => key === required[index]);
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    maxBuffer: maximumCommandOutputBytes,
    ...options,
  });
  if (result.error !== undefined || result.status !== 0) {
    fail(`production image verification command failed: ${command} ${arguments_[0] ?? ""}`);
  }
  return result.stdout;
}

function dockerJson(arguments_, commandRunner) {
  let value;
  try {
    value = JSON.parse(commandRunner("docker", arguments_));
  } catch (error) {
    if (error instanceof ProductionImageVerificationError) throw error;
    fail("Docker returned an invalid production image inspection document");
  }
  return value;
}

function validateInputs({ imageReference, expectedImageId, expectedRevision }) {
  if (!revisionPattern.test(expectedRevision ?? "")) {
    fail("expected revision must be a full lowercase commit SHA");
  }
  if (!imageIdPattern.test(expectedImageId ?? "")) {
    fail("expected image ID must be a canonical sha256 digest");
  }
  if (imageReference !== `handleplan:${expectedRevision}`) {
    fail("production image reference must be the exact Handleplan revision tag");
  }
}

const exactImageEnvironment = new Map([
  ["HOSTNAME", "0.0.0.0"],
  ["NEXT_TELEMETRY_DISABLED", "1"],
  ["NODE_ENV", "production"],
  ["NODE_VERSION", "22.22.3"],
  ["PATH", "/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
  ["PNPM_HOME", "/pnpm"],
  ["PORT", "3000"],
  ["YARN_VERSION", "1.22.22"],
]);

function matchesExactImageEnvironment(environment) {
  if (!Array.isArray(environment) || environment.length !== exactImageEnvironment.size) return false;
  const actual = new Map();
  for (const entry of environment) {
    if (typeof entry !== "string") return false;
    const separator = entry.indexOf("=");
    if (separator < 1) return false;
    const name = entry.slice(0, separator);
    if (actual.has(name)) return false;
    actual.set(name, entry.slice(separator + 1));
  }
  return [...exactImageEnvironment].every(([name, value]) => actual.get(name) === value);
}

export function validateProductionImageInspection(
  inspection,
  { imageReference, expectedImageId, expectedRevision },
) {
  validateInputs({ imageReference, expectedImageId, expectedRevision });
  if (!Array.isArray(inspection) || inspection.length !== 1) {
    fail("Docker image inspection must contain exactly one image");
  }
  const image = inspection[0];
  if (image?.Id !== expectedImageId) fail("production image tag resolves to a different image ID");
  if (image?.Os !== "linux" || image?.Architecture !== "amd64") {
    fail("production image must be the exact linux/amd64 platform");
  }
  if (
    !Array.isArray(image.RepoTags)
    || image.RepoTags.length !== 1
    || image.RepoTags[0] !== imageReference
  ) {
    fail("production image must have exactly the revision-bound repository tag");
  }
  if (image?.Config?.Labels?.["org.opencontainers.image.revision"] !== expectedRevision) {
    fail("production image revision label does not match the expected revision");
  }
  if (
    !Array.isArray(image?.Config?.Entrypoint)
    || image.Config.Entrypoint.length !== 1
    || image.Config.Entrypoint[0] !== "/app/deploy/entrypoint.sh"
  ) {
    fail("production image does not use the approved default entrypoint");
  }
  if (image?.Config?.User !== "nextjs" || image?.Config?.WorkingDir !== "/app") {
    fail("production image runtime identity does not match the hardened contract");
  }
  if (image.Config.Volumes !== undefined && image.Config.Volumes !== null) {
    fail("production image must not declare writable runtime volumes");
  }
  if (!matchesExactImageEnvironment(image?.Config?.Env)) {
    fail("production image environment differs from the exact baked allowlist");
  }
  return image;
}

function updateFramed(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

function normalizedRelativePath(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

function collectRuntimeSourceFiles(repositoryRoot) {
  const files = [];

  function visit(absolutePath) {
    const relativePath = normalizedRelativePath(repositoryRoot, absolutePath);
    let stat;
    try {
      stat = lstatSync(absolutePath);
    } catch {
      fail(`privileged runtime source input is missing: ${relativePath}`);
    }
    if (stat.isSymbolicLink()) {
      fail(`privileged runtime source input contains a symbolic link: ${relativePath}`);
    }
    if (stat.isDirectory()) {
      if (excludedRuntimeSourceDirectories.has(relativePath)) return;
      for (const name of readdirSync(absolutePath).sort()) {
        visit(path.join(absolutePath, name));
      }
      return;
    }
    if (!stat.isFile()) {
      fail(`privileged runtime source input contains an unsupported entry: ${relativePath}`);
    }
    files.push({ absolutePath, relativePath });
  }

  for (const inputPath of runtimeSourceInputPaths) {
    visit(path.join(repositoryRoot, inputPath));
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export function computePrivilegedRuntimeSourceBinding(
  repositoryRoot = defaultRepositoryRoot,
) {
  const files = collectRuntimeSourceFiles(repositoryRoot);
  const hash = createHash("sha256");
  updateFramed(hash, "handleplan-privileged-runtime-source-v1");
  updateFramed(hash, `node:${process.versions.node}`);
  for (const file of files) {
    updateFramed(hash, file.relativePath);
    updateFramed(hash, readFileSync(file.absolutePath));
  }
  return Object.freeze({
    digestSha256: hash.digest("hex"),
    fileCount: files.length,
  });
}

function collectTree(root, materializedBuildId) {
  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    fail("production image public tree is missing");
  }
  const entries = [];

  function visit(absolutePath) {
    const relativePath = path.relative(root, absolutePath).split(path.sep).join("/") || ".";
    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink()) fail(`public tree contains a symbolic link: ${relativePath}`);
    if (stat.isDirectory()) {
      entries.push({ kind: "directory", relativePath });
      for (const name of readdirSync(absolutePath).sort()) visit(path.join(absolutePath, name));
      return;
    }
    if (!stat.isFile()) fail(`public tree contains an unsupported entry: ${relativePath}`);
    entries.push({ absolutePath, kind: "file", relativePath });
  }

  visit(root);
  const hash = createHash("sha256");
  updateFramed(hash, "handleplan-production-public-tree-v1");
  for (const entry of entries) {
    updateFramed(hash, entry.kind);
    updateFramed(hash, entry.relativePath);
    if (entry.kind === "file") {
      const bytes = readFileSync(entry.absolutePath);
      let materializedBytes = bytes;
      if (materializedBuildId !== undefined) {
        try {
          materializedBytes = materializePublicBuildFile(
            entry.relativePath,
            bytes,
            materializedBuildId,
          );
        } catch {
          fail("production image public source materialization is invalid");
        }
      }
      updateFramed(hash, materializedBytes);
    }
  }
  return {
    digestSha256: hash.digest("hex"),
    entries: entries.map(({ kind, relativePath }) => ({ kind, relativePath })),
    fileCount: entries.filter(({ kind }) => kind === "file").length,
  };
}

export function comparePublicTrees(expectedRoot, actualRoot, materializedBuildId) {
  const expected = collectTree(expectedRoot, materializedBuildId);
  const actual = collectTree(actualRoot);
  if (
    expected.digestSha256 !== actual.digestSha256
    || JSON.stringify(expected.entries) !== JSON.stringify(actual.entries)
  ) {
    fail("production image public tree differs from the revision source tree");
  }
  return { digestSha256: expected.digestSha256, fileCount: expected.fileCount };
}

function collectCanonicalEntries(specifications, contract, { forbidSymlinks = false } = {}) {
  const entries = [];

  function visit(absolutePath, relativePath, artifactRoot) {
    const stat = lstatSync(absolutePath);
    if (stat.isDirectory()) {
      entries.push({ kind: "directory", relativePath });
      for (const name of readdirSync(absolutePath).sort()) {
        visit(
          path.join(absolutePath, name),
          `${relativePath}/${name}`,
          artifactRoot,
        );
      }
      return;
    }
    if (stat.isSymbolicLink()) {
      if (forbidSymlinks) fail(`${contract} contains a forbidden symbolic link`);
      const target = readlinkSync(absolutePath);
      if (path.isAbsolute(target)) fail(`${contract} contains an absolute symbolic link`);
      const resolvedTarget = path.resolve(path.dirname(absolutePath), target);
      if (
        resolvedTarget !== artifactRoot
        && !resolvedTarget.startsWith(`${artifactRoot}${path.sep}`)
      ) {
        fail(`${contract} contains an escaping symbolic link`);
      }
      entries.push({ kind: "symlink", relativePath, target });
      return;
    }
    if (!stat.isFile()) fail(`${contract} contains an unsupported entry`);
    entries.push({ absolutePath, kind: "file", relativePath });
  }

  for (const specification of specifications) {
    if (!existsSync(specification.absolutePath)) fail(`${contract} is missing an expected path`);
    const stat = lstatSync(specification.absolutePath);
    visit(
      specification.absolutePath,
      specification.relativePath,
      specification.artifactRoot
        ?? (stat.isDirectory() ? specification.absolutePath : path.dirname(specification.absolutePath)),
    );
  }
  return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function digestCanonicalEntries(entries, contract) {
  const hash = createHash("sha256");
  updateFramed(hash, contract);
  for (const entry of entries) {
    updateFramed(hash, entry.kind);
    updateFramed(hash, entry.relativePath);
    if (entry.kind === "file") updateFramed(hash, readFileSync(entry.absolutePath));
    if (entry.kind === "symlink") updateFramed(hash, entry.target);
  }
  return hash.digest("hex");
}

function assertExactDirectoryEntries(directory, expectedNames, contract) {
  let stat;
  try {
    stat = lstatSync(directory);
  } catch {
    fail(`${contract} directory is missing`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`${contract} must be a real directory`);
  }
  const actualNames = readdirSync(directory).sort();
  const requiredNames = [...expectedNames].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(requiredNames)) {
    fail(`${contract} contains an unexpected or missing entry`);
  }
}

export function computePrivilegedRuntimeShipmentSnapshot(runtimeRoot) {
  assertExactDirectoryEntries(
    path.join(runtimeRoot, "apps", "worker"),
    ["dist"],
    "privileged runtime worker root",
  );
  assertExactDirectoryEntries(
    path.join(runtimeRoot, "apps", "worker", "dist"),
    ["main.mjs"],
    "privileged runtime worker distribution",
  );
  assertExactDirectoryEntries(
    path.join(runtimeRoot, "deploy"),
    ["entrypoint.sh", "migrate.mjs", "migrations"],
    "privileged runtime deploy root",
  );
  const entries = collectCanonicalEntries([
    {
      absolutePath: path.join(runtimeRoot, "apps", "worker"),
      relativePath: "app/apps/worker",
    },
    {
      absolutePath: path.join(runtimeRoot, "deploy"),
      relativePath: "app/deploy",
    },
    {
      absolutePath: path.join(runtimeRoot, "node_modules", "postgres"),
      relativePath: "app/node_modules/postgres",
    },
  ], "privileged runtime shipment", { forbidSymlinks: true });
  return Object.freeze({
    digestSha256: digestCanonicalEntries(
      entries,
      "handleplan-privileged-runtime-shipment-v1",
    ),
    entryCount: entries.length,
    fileCount: entries.filter(({ kind }) => kind === "file").length,
    symlinkCount: entries.filter(({ kind }) => kind === "symlink").length,
  });
}

export function createPrivilegedRuntimeShipmentBinding({
  expectedRevision,
  repositoryRoot = defaultRepositoryRoot,
  runtimeRoot,
  sourceBindingProvider = computePrivilegedRuntimeSourceBinding,
}) {
  if (!revisionPattern.test(expectedRevision ?? "")) {
    fail("privileged runtime receipt revision must be a full lowercase commit SHA");
  }
  const source = sourceBindingProvider(repositoryRoot);
  const shipment = computePrivilegedRuntimeShipmentSnapshot(runtimeRoot);
  return Object.freeze({
    contractVersion: 1,
    nodeVersion: process.versions.node,
    revision: expectedRevision,
    shipmentDigestSha256: shipment.digestSha256,
    shipmentEntryCount: shipment.entryCount,
    shipmentFileCount: shipment.fileCount,
    shipmentSymlinkCount: shipment.symlinkCount,
    sourceDigestSha256: source.digestSha256,
    sourceFileCount: source.fileCount,
  });
}

export function validateEmbeddedRuntimeShipmentBinding(value, expectedRevision) {
  const expectedKeys = [
    "contractVersion",
    "nodeVersion",
    "revision",
    "shipmentDigestSha256",
    "shipmentEntryCount",
    "shipmentFileCount",
    "shipmentSymlinkCount",
    "sourceDigestSha256",
    "sourceFileCount",
  ];
  if (
    !exactKeys(value, expectedKeys)
    || value.contractVersion !== 1
    || value.nodeVersion !== "22.22.3"
    || value.revision !== expectedRevision
    || !revisionPattern.test(value.revision ?? "")
    || !/^[0-9a-f]{64}$/u.test(value.sourceDigestSha256 ?? "")
    || !Number.isSafeInteger(value.sourceFileCount)
    || value.sourceFileCount < 1
    || !/^[0-9a-f]{64}$/u.test(value.shipmentDigestSha256 ?? "")
    || !Number.isSafeInteger(value.shipmentEntryCount)
    || value.shipmentEntryCount < 1
    || !Number.isSafeInteger(value.shipmentFileCount)
    || value.shipmentFileCount < 1
    || !Number.isSafeInteger(value.shipmentSymlinkCount)
    || value.shipmentSymlinkCount < 0
    || value.shipmentFileCount + value.shipmentSymlinkCount > value.shipmentEntryCount
  ) {
    fail("production image privileged runtime shipment receipt is invalid");
  }
  return value;
}

export function writePrivilegedRuntimeShipmentBinding({
  expectedRevision,
  outputPath,
  repositoryRoot = defaultRepositoryRoot,
  runtimeRoot,
}) {
  if (typeof outputPath !== "string" || outputPath.length === 0) {
    fail("privileged runtime receipt output path is required");
  }
  assertExactDirectoryEntries(
    runtimeRoot,
    ["apps", "deploy", "node_modules"],
    "privileged runtime staging root",
  );
  assertExactDirectoryEntries(
    path.join(runtimeRoot, "apps"),
    ["worker"],
    "privileged runtime staging applications root",
  );
  assertExactDirectoryEntries(
    path.join(runtimeRoot, "node_modules"),
    ["postgres"],
    "privileged runtime staging dependency root",
  );
  const receipt = createPrivilegedRuntimeShipmentBinding({
    expectedRevision,
    repositoryRoot,
    runtimeRoot,
  });
  try {
    writeFileSync(outputPath, `${JSON.stringify(receipt)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch {
    fail("privileged runtime receipt could not be created exclusively");
  }
  return receipt;
}

function compareSealedStandaloneToRuntime(sealedRoot, runtimeRoot) {
  const sealedEntries = collectCanonicalEntries([{
    absolutePath: sealedRoot,
    relativePath: ".",
  }], "sealed standalone proof");
  for (const entry of sealedEntries) {
    const relativePath = entry.relativePath === "." ? "" : entry.relativePath.slice(2);
    const runtimePath = path.join(runtimeRoot, relativePath);
    let runtimeStat;
    try {
      runtimeStat = lstatSync(runtimePath);
    } catch {
      fail("runtime image is missing a sealed standalone entry");
    }
    if (entry.kind === "directory" && !runtimeStat.isDirectory()) {
      fail("runtime image changed a sealed standalone entry type");
    }
    if (entry.kind === "file") {
      if (!runtimeStat.isFile() || runtimeStat.isSymbolicLink()) {
        fail("runtime image changed a sealed standalone entry type");
      }
      if (!readFileSync(entry.absolutePath).equals(readFileSync(runtimePath))) {
        fail("runtime image changed a sealed standalone file after sealing");
      }
    }
    if (
      entry.kind === "symlink"
      && (!runtimeStat.isSymbolicLink() || readlinkSync(runtimePath) !== entry.target)
    ) {
      fail("runtime image changed a sealed standalone symbolic link");
    }
  }

  const sealedWebRoot = path.join(sealedRoot, "apps", "web");
  const runtimeWebRoot = path.join(runtimeRoot, "apps", "web");
  const sealedWebEntries = collectCanonicalEntries([{
    absolutePath: sealedWebRoot,
    artifactRoot: sealedRoot,
    relativePath: ".",
  }], "sealed standalone web proof");
  const runtimeWebEntries = collectCanonicalEntries([{
    absolutePath: runtimeWebRoot,
    artifactRoot: runtimeRoot,
    relativePath: ".",
  }], "runtime web tree");
  const sealedWebByPath = new Map(
    sealedWebEntries.map((entry) => [entry.relativePath, entry]),
  );
  const runtimeWebPaths = new Set(runtimeWebEntries.map((entry) => entry.relativePath));
  const bindingOverlayPath = "./.next/handleplan-public-build-binding.json";
  if (sealedWebByPath.has(bindingOverlayPath)) {
    fail("sealed standalone web tree collides with the build binding overlay");
  }
  for (const entry of runtimeWebEntries) {
    const sealedEntry = sealedWebByPath.get(entry.relativePath);
    if (sealedEntry !== undefined) {
      if (
        entry.kind !== sealedEntry.kind
        || (entry.kind === "symlink" && entry.target !== sealedEntry.target)
      ) {
        fail("runtime web tree changed a sealed standalone entry");
      }
      continue;
    }
    if (entry.relativePath !== bindingOverlayPath || entry.kind !== "file") {
      fail("runtime web tree contains an entry outside the sealed tree and build binding overlay");
    }
  }
  for (const relativePath of sealedWebByPath.keys()) {
    if (!runtimeWebPaths.has(relativePath)) {
      fail("runtime web tree is missing a sealed standalone entry");
    }
  }
  return sealedEntries.length;
}

function proveRuntimeDependenciesAreSealedPlusPostgres(sealedRoot, runtimeRoot) {
  const sealedNodeModules = path.join(sealedRoot, "node_modules");
  const runtimeNodeModules = path.join(runtimeRoot, "node_modules");
  const sealedEntries = collectCanonicalEntries([{
    absolutePath: sealedNodeModules,
    relativePath: ".",
  }], "sealed standalone dependency proof");
  const runtimeEntries = collectCanonicalEntries([{
    absolutePath: runtimeNodeModules,
    relativePath: ".",
  }], "runtime dependency tree");
  const sealedByPath = new Map(sealedEntries.map((entry) => [entry.relativePath, entry]));
  const runtimePaths = new Set(runtimeEntries.map((entry) => entry.relativePath));
  if (
    sealedByPath.has("./postgres")
    || [...sealedByPath.keys()].some((relativePath) => relativePath.startsWith("./postgres/"))
  ) {
    fail("sealed standalone dependencies collide with the privileged postgres overlay");
  }
  for (const entry of runtimeEntries) {
    const sealedEntry = sealedByPath.get(entry.relativePath);
    if (sealedEntry !== undefined) {
      if (
        entry.kind !== sealedEntry.kind
        || (entry.kind === "symlink" && entry.target !== sealedEntry.target)
      ) {
        fail("runtime dependency tree changed a sealed standalone dependency entry");
      }
      continue;
    }
    if (
      entry.relativePath !== "./postgres"
      && !entry.relativePath.startsWith("./postgres/")
    ) {
      fail("runtime dependency tree contains an entry outside the sealed tree and postgres overlay");
    }
  }
  for (const relativePath of sealedByPath.keys()) {
    if (!runtimePaths.has(relativePath)) {
      fail("runtime dependency tree is missing a sealed standalone dependency entry");
    }
  }
}

export function computeSealedArtifactSnapshot(releaseProofRoot) {
  const buildRoot = path.join(releaseProofRoot, "build-root");
  const environmentPath = path.join(buildRoot, "handleplan-public-build-environment.json");
  const entries = collectCanonicalEntries([
    {
      absolutePath: path.join(buildRoot, "BUILD_ID"),
      relativePath: "apps/web/.next/BUILD_ID",
    },
    {
      absolutePath: path.join(buildRoot, "static"),
      relativePath: "apps/web/.next/static",
    },
    {
      absolutePath: path.join(releaseProofRoot, "standalone"),
      relativePath: "apps/web/.next/standalone",
    },
    {
      absolutePath: environmentPath,
      relativePath: "apps/web/.next/handleplan-public-build-environment.json",
    },
  ], "sealed public build artifact proof");
  const digestSha256 = digestCanonicalEntries(
    entries,
    "handleplan-public-build-artifact-v2",
  );
  const fileCount = entries.filter(({ kind }) => kind === "file").length;
  const symlinkCount = entries.filter(({ kind }) => kind === "symlink").length;
  return { digestSha256, entryCount: entries.length, fileCount, symlinkCount };
}

export function recomputeSealedArtifact(releaseProofRoot, runtimeRoot, binding) {
  const buildRoot = path.join(releaseProofRoot, "build-root");
  const environmentPath = path.join(buildRoot, "handleplan-public-build-environment.json");
  let environment;
  try {
    environment = JSON.parse(readFileSync(environmentPath, "utf8"));
  } catch {
    fail("sealed build environment proof is missing or invalid");
  }
  if (JSON.stringify(environment) !== JSON.stringify(binding.buildEnvironment)) {
    fail("sealed build environment proof differs from the binding receipt");
  }
  const snapshot = computeSealedArtifactSnapshot(releaseProofRoot);
  if (
    snapshot.digestSha256 !== binding.artifactDigestSha256
    || snapshot.entryCount !== binding.artifactEntryCount
    || snapshot.fileCount !== binding.artifactFileCount
    || snapshot.symlinkCount !== binding.artifactSymlinkCount
  ) {
    fail("shipped sealed artifact does not match the v2 binding digest and counts");
  }
  const buildId = readFileSync(path.join(buildRoot, "BUILD_ID"), "utf8");
  if (buildId !== binding.buildId) fail("shipped sealed artifact has a different build ID");
  const runtimeEntryCount = compareSealedStandaloneToRuntime(
    path.join(releaseProofRoot, "standalone"),
    runtimeRoot,
  );
  proveRuntimeDependenciesAreSealedPlusPostgres(
    path.join(releaseProofRoot, "standalone"),
    runtimeRoot,
  );
  return { ...snapshot, runtimeEntryCount };
}

export function validateEmbeddedBuildBinding(value, expectedRevision) {
  const expectedTopLevelKeys = [
    "artifactDigestSha256",
    "artifactEntryCount",
    "artifactFileCount",
    "artifactSymlinkCount",
    "architecture",
    "buildEnvironment",
    "buildId",
    "contractVersion",
    "nodeVersion",
    "platform",
    "sourceDigestSha256",
    "sourceFileCount",
  ];
  const environment = value?.buildEnvironment?.environment;
  const expectedEnvironmentKeys = [
    "APP_COMMIT_SHA",
    "CI",
    "HANDLEPLAN_PUBLIC_BUILD_SOURCE_DIGEST",
    "LANG",
    "LC_ALL",
    "NEXT_PUBLIC_HANDLEPLAN_BUILD_ID",
    "NEXT_TELEMETRY_DISABLED",
    "NODE_ENV",
    "TZ",
  ];
  if (
    !exactKeys(value, expectedTopLevelKeys)
    || value.contractVersion !== 2
    || !/^[0-9a-f]{64}$/u.test(value.sourceDigestSha256 ?? "")
    || !/^[0-9a-f]{64}$/u.test(value.artifactDigestSha256 ?? "")
    || value.buildId !== `hpv2-${value.sourceDigestSha256}`
    || value.platform !== "linux"
    || value.architecture !== "x64"
    || value.nodeVersion !== "22.22.3"
    || !Number.isSafeInteger(value.sourceFileCount)
    || value.sourceFileCount < 1
    || !Number.isSafeInteger(value.artifactEntryCount)
    || value.artifactEntryCount < 1
    || !Number.isSafeInteger(value.artifactFileCount)
    || value.artifactFileCount < 1
    || !Number.isSafeInteger(value.artifactSymlinkCount)
    || value.artifactSymlinkCount < 0
    || value.artifactFileCount + value.artifactSymlinkCount > value.artifactEntryCount
    || value?.buildEnvironment?.contractVersion !== 1
    || value.buildEnvironment.nodeVersion !== "22.22.3"
    || value.buildEnvironment.wrapper !== "handleplan-public-build-v2"
    || !exactKeys(environment, expectedEnvironmentKeys)
    || environment?.APP_COMMIT_SHA !== expectedRevision
    || environment?.HANDLEPLAN_PUBLIC_BUILD_SOURCE_DIGEST !== value.sourceDigestSha256
    || environment?.NEXT_PUBLIC_HANDLEPLAN_BUILD_ID !== value.buildId
    || environment?.NODE_ENV !== "production"
    || environment?.CI !== "true"
    || environment?.LANG !== "C.UTF-8"
    || environment?.LC_ALL !== "C.UTF-8"
    || environment?.NEXT_TELEMETRY_DISABLED !== "1"
    || environment?.TZ !== "UTC"
  ) {
    fail("production image build binding receipt is invalid");
  }
  return value;
}

function validateDockerArchiveManifestShape(
  manifest,
  { imageReference, expectedImageId, expectedRevision },
  { allowLinkedContentStoreConfig = false } = {},
) {
  validateInputs({ imageReference, expectedImageId, expectedRevision });
  if (!Array.isArray(manifest) || manifest.length !== 1) {
    fail("Docker image archive must contain exactly one manifest entry");
  }
  const entry = manifest[0];
  const expectedConfigDigest = expectedImageId.slice("sha256:".length);
  const expectedLegacyConfig = `${expectedConfigDigest}.json`;
  const expectedContentStoreConfig = `blobs/sha256/${expectedConfigDigest}`;
  const legacyLayerPattern = /^[0-9a-f]{64}\/layer\.tar$/u;
  const contentStoreLayerPattern = /^blobs\/sha256\/[0-9a-f]{64}$/u;
  const legacyConfigPattern = /^[0-9a-f]{64}\.json$/u;
  const contentStoreConfigPattern = /^blobs\/sha256\/[0-9a-f]{64}$/u;
  const isLegacyConfig = typeof entry?.Config === "string"
    && legacyConfigPattern.test(entry.Config);
  const isContentStoreConfig = typeof entry?.Config === "string"
    && contentStoreConfigPattern.test(entry.Config);
  const isDirectLegacyConfig = entry?.Config === expectedLegacyConfig;
  const isExpectedContentStoreConfig = entry?.Config === expectedContentStoreConfig;
  const entryKeys = entry?.LayerSources === undefined
    ? ["Config", "Layers", "RepoTags"]
    : ["Config", "LayerSources", "Layers", "RepoTags"];
  const hasSafeLayerSources = (() => {
    if (entry?.LayerSources === undefined) return true;
    if (
      !allowLinkedContentStoreConfig
      || !isContentStoreConfig
      || !isExpectedContentStoreConfig
      || entry.LayerSources === null
      || typeof entry.LayerSources !== "object"
      || Array.isArray(entry.LayerSources)
      || !Array.isArray(entry.Layers)
    ) {
      return false;
    }
    const expectedSourceKeys = entry.Layers.map((layer) => {
      const digest = typeof layer === "string"
        ? ociBlobPathPattern.exec(layer)?.[1]
        : undefined;
      return digest === undefined ? undefined : `sha256:${digest}`;
    });
    if (expectedSourceKeys.some((key) => key === undefined)) return false;
    const actualSourceKeys = Object.keys(entry.LayerSources).sort();
    const sortedExpectedSourceKeys = [...expectedSourceKeys].sort();
    if (
      new Set(sortedExpectedSourceKeys).size !== sortedExpectedSourceKeys.length
      || actualSourceKeys.length !== sortedExpectedSourceKeys.length
      || actualSourceKeys.some((key, index) => key !== sortedExpectedSourceKeys[index])
    ) {
      return false;
    }
    return actualSourceKeys.every((key) => {
      const descriptor = entry.LayerSources[key];
      return exactKeys(descriptor, ["digest", "mediaType", "size"])
        && descriptor.digest === key
        && uncompressedOciLayerMediaTypes.has(descriptor.mediaType)
        && Number.isSafeInteger(descriptor.size)
        && descriptor.size > 0;
    });
  })();
  if (
    !exactKeys(entry, entryKeys)
    || typeof entry.Config !== "string"
    || (!isDirectLegacyConfig
      && !(allowLinkedContentStoreConfig
        && (isExpectedContentStoreConfig || isContentStoreConfig)))
    || !Array.isArray(entry.RepoTags)
    || entry.RepoTags.length !== 1
    || entry.RepoTags[0] !== imageReference
    || !Array.isArray(entry.Layers)
    || entry.Layers.length < 1
    || (isLegacyConfig && entry.Layers.some((layer) =>
      typeof layer !== "string" || !legacyLayerPattern.test(layer)))
    || (isContentStoreConfig && entry.Layers.some((layer) =>
      typeof layer !== "string" || !contentStoreLayerPattern.test(layer)))
    || !hasSafeLayerSources
  ) {
    fail("Docker image archive manifest has an unsafe shape or the wrong revision tag");
  }
  return entry;
}

export function validateDockerArchiveManifest(manifest, expected) {
  return validateDockerArchiveManifestShape(manifest, expected);
}

function parseArchiveJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch {
    fail(`Docker image archive ${label} is invalid JSON`);
  }
}

function validateOciDescriptor(descriptor, expectedKeys, mediaTypes, label) {
  if (
    !exactKeys(descriptor, expectedKeys)
    || !mediaTypes.has(descriptor?.mediaType)
    || !ociDigestPattern.test(descriptor?.digest ?? "")
    || !Number.isSafeInteger(descriptor?.size)
    || descriptor.size < 1
  ) {
    fail(`Docker image archive ${label} descriptor is invalid`);
  }
  return descriptor;
}

function readVerifiedOciJsonBlob(archivePath, descriptor, commandRunner, label) {
  const digest = ociDigestPattern.exec(descriptor.digest)?.[1];
  if (digest === undefined) fail(`Docker image archive ${label} digest is invalid`);
  const blobPath = `blobs/sha256/${digest}`;
  let raw;
  try {
    raw = commandRunner("tar", ["-xOf", archivePath, blobPath]);
  } catch (error) {
    if (error instanceof ProductionImageVerificationError) throw error;
    fail(`Docker image archive ${label} blob is missing`);
  }
  if (
    Buffer.byteLength(raw) !== descriptor.size
    || createHash("sha256").update(raw).digest("hex") !== digest
  ) {
    fail(`Docker image archive ${label} blob does not match its descriptor`);
  }
  return parseArchiveJson(raw, `${label} blob`);
}

const streamDigestProgram = [
  'const { createHash } = require("node:crypto");',
  'const hash = createHash("sha256");',
  "let size = 0;",
  "process.stdin.on(\"data\", (chunk) => { size += chunk.length; hash.update(chunk); });",
  "process.stdin.on(\"error\", () => { process.exitCode = 1; });",
  "process.stdin.on(\"end\", () => {",
  "  process.stdout.write(JSON.stringify({ digest: `sha256:${hash.digest(\"hex\")}`, size }));",
  "});",
].join("\n");

function validateOciLayerBlob(archivePath, descriptor, commandRunner, label) {
  const digest = ociDigestPattern.exec(descriptor.digest)?.[1];
  if (digest === undefined) fail(`Docker image archive ${label} digest is invalid`);
  const blobPath = `blobs/sha256/${digest}`;
  let proof;
  try {
    const raw = commandRunner("bash", [
      "-o",
      "pipefail",
      "-c",
      'tar -xOf "$1" "$2" | "$3" -e "$4"',
      "handleplan-layer-proof",
      archivePath,
      blobPath,
      process.execPath,
      streamDigestProgram,
    ]);
    proof = JSON.parse(raw);
  } catch (error) {
    if (error instanceof ProductionImageVerificationError) throw error;
    fail(`Docker image archive ${label} blob is missing or unreadable`);
  }
  if (
    !exactKeys(proof, ["digest", "size"])
    || proof.digest !== descriptor.digest
    || proof.size !== descriptor.size
  ) {
    fail(`Docker image archive ${label} blob does not match its descriptor`);
  }
}

function validateOciRuntimeManifest(
  archivePath,
  entry,
  descriptor,
  platform,
  expectedRevision,
  commandRunner,
) {
  const manifest = readVerifiedOciJsonBlob(
    archivePath,
    descriptor,
    commandRunner,
    "runtime manifest",
  );
  if (
    !exactKeys(manifest, ["config", "layers", "mediaType", "schemaVersion"])
    || manifest.schemaVersion !== 2
    || manifest.mediaType !== descriptor.mediaType
    || !Array.isArray(manifest.layers)
    || manifest.layers.length < 1
  ) {
    fail("Docker image archive runtime manifest is invalid");
  }
  validateOciDescriptor(
    manifest.config,
    ["digest", "mediaType", "size"],
    ociConfigMediaTypes,
    "runtime config",
  );
  for (const layer of manifest.layers) {
    validateOciDescriptor(
      layer,
      ["digest", "mediaType", "size"],
      ociLayerMediaTypes,
      "runtime layer",
    );
  }
  const configDigest = ociDigestPattern.exec(manifest.config.digest)?.[1];
  const archivedConfigDigest = ociBlobPathPattern.exec(entry.Config)?.[1];
  const archivedLayerDigests = entry.Layers.map(
    (layer) => ociBlobPathPattern.exec(layer)?.[1],
  );
  const manifestLayerDigests = manifest.layers.map(
    (layer) => ociDigestPattern.exec(layer.digest)?.[1],
  );
  const layerSourcesMatchManifest = entry.LayerSources === undefined
    || manifest.layers.every((layer, index) => {
      const archivedDigest = archivedLayerDigests[index];
      const source = archivedDigest === undefined
        ? undefined
        : entry.LayerSources[`sha256:${archivedDigest}`];
      return source?.digest === layer.digest
        && source.mediaType === layer.mediaType
        && source.size === layer.size;
    });
  if (
    configDigest === undefined
    || configDigest !== archivedConfigDigest
    || archivedLayerDigests.some((digest) => digest === undefined)
    || JSON.stringify(archivedLayerDigests) !== JSON.stringify(manifestLayerDigests)
    || !layerSourcesMatchManifest
  ) {
    fail("Docker image archive manifest.json is not linked to the OCI runtime manifest");
  }
  const config = readVerifiedOciJsonBlob(
    archivePath,
    manifest.config,
    commandRunner,
    "runtime config",
  );
  const hasMobyLayerSources = entry.LayerSources !== undefined;
  const expectedDiffIds = archivedLayerDigests.map((digest) => `sha256:${digest}`);
  if (
    config?.os !== "linux"
    || config?.architecture !== "amd64"
    || config?.config?.Labels?.["org.opencontainers.image.revision"] !== expectedRevision
    || (hasMobyLayerSources
      && (!exactKeys(config?.rootfs, ["diff_ids", "type"])
        || config.rootfs.type !== "layers"
        || !Array.isArray(config.rootfs.diff_ids)
        || JSON.stringify(config.rootfs.diff_ids) !== JSON.stringify(expectedDiffIds)))
    || (platform !== undefined
      && (platform.os !== config.os || platform.architecture !== config.architecture))
  ) {
    fail("Docker image archive runtime config is invalid or has a mismatched platform");
  }
  if (hasMobyLayerSources) {
    for (const [index, layer] of manifest.layers.entries()) {
      validateOciLayerBlob(
        archivePath,
        layer,
        commandRunner,
        `runtime layer ${index + 1}`,
      );
    }
  }
}

function validateOciArchiveBinding(archivePath, entry, expected, commandRunner) {
  let layoutRaw;
  try {
    layoutRaw = commandRunner("tar", ["-xOf", archivePath, "oci-layout"]);
  } catch (error) {
    if (error instanceof ProductionImageVerificationError) throw error;
    fail("Docker image archive OCI layout marker is missing");
  }
  const layout = parseArchiveJson(layoutRaw, "OCI layout marker");
  if (
    !exactKeys(layout, ["imageLayoutVersion"])
    || layout.imageLayoutVersion !== "1.0.0"
  ) {
    fail("Docker image archive OCI layout marker is invalid");
  }
  let indexRaw;
  try {
    indexRaw = commandRunner("tar", ["-xOf", archivePath, "index.json"]);
  } catch (error) {
    if (error instanceof ProductionImageVerificationError) throw error;
    fail("Docker image archive OCI index is missing");
  }
  const index = parseArchiveJson(indexRaw, "OCI index");
  if (
    !exactKeys(index, ["manifests", "mediaType", "schemaVersion"])
    || index.schemaVersion !== 2
    || index.mediaType !== "application/vnd.oci.image.index.v1+json"
    || !Array.isArray(index.manifests)
    || index.manifests.length !== 1
  ) {
    fail("Docker image archive OCI index is invalid");
  }
  const rootDescriptor = validateOciDescriptor(
    index.manifests[0],
    ["annotations", "digest", "mediaType", "size"],
    new Set([...ociIndexMediaTypes, ...ociManifestMediaTypes]),
    "root",
  );
  const expectedCanonicalName = `docker.io/library/${expected.imageReference}`;
  const isMobyImageStoreArchive = entry.LayerSources !== undefined;
  if (
    (!isMobyImageStoreArchive && rootDescriptor.digest !== expected.expectedImageId)
    || (isMobyImageStoreArchive && !ociManifestMediaTypes.has(rootDescriptor.mediaType))
    || !exactKeys(rootDescriptor.annotations, [
      "io.containerd.image.name",
      "org.opencontainers.image.ref.name",
    ])
    || rootDescriptor.annotations["io.containerd.image.name"] !== expectedCanonicalName
    || rootDescriptor.annotations["org.opencontainers.image.ref.name"] !== expected.expectedRevision
  ) {
    fail("Docker image archive OCI root is not bound to the exact image ID and revision tag");
  }
  const root = readVerifiedOciJsonBlob(
    archivePath,
    rootDescriptor,
    commandRunner,
    "root",
  );
  if (ociManifestMediaTypes.has(rootDescriptor.mediaType)) {
    validateOciRuntimeManifest(
      archivePath,
      entry,
      rootDescriptor,
      undefined,
      expected.expectedRevision,
      commandRunner,
    );
    return;
  }
  if (
    !exactKeys(root, ["manifests", "mediaType", "schemaVersion"])
    || root.schemaVersion !== 2
    || root.mediaType !== rootDescriptor.mediaType
    || !Array.isArray(root.manifests)
    || root.manifests.length < 1
    || root.manifests.length > 2
  ) {
    fail("Docker image archive OCI root index is invalid");
  }
  const runtimeDescriptors = [];
  const attestationDescriptors = [];
  for (const child of root.manifests) {
    if (
      exactKeys(child, ["digest", "mediaType", "platform", "size"])
      && exactKeys(child.platform, ["architecture", "os"])
      && child.platform.os === "linux"
      && child.platform.architecture === "amd64"
    ) {
      validateOciDescriptor(
        child,
        ["digest", "mediaType", "platform", "size"],
        ociManifestMediaTypes,
        "runtime",
      );
      runtimeDescriptors.push(child);
      continue;
    }
    if (
      exactKeys(child, ["annotations", "digest", "mediaType", "platform", "size"])
      && exactKeys(child.platform, ["architecture", "os"])
      && child.platform.architecture === "unknown"
      && child.platform.os === "unknown"
      && exactKeys(child.annotations, [
        "vnd.docker.reference.digest",
        "vnd.docker.reference.type",
      ])
      && child.annotations["vnd.docker.reference.type"] === "attestation-manifest"
    ) {
      validateOciDescriptor(
        child,
        ["annotations", "digest", "mediaType", "platform", "size"],
        ociManifestMediaTypes,
        "attestation",
      );
      attestationDescriptors.push(child);
      continue;
    }
    fail("Docker image archive OCI child descriptor is invalid");
  }
  if (
    runtimeDescriptors.length !== 1
    || attestationDescriptors.length > 1
    || (attestationDescriptors.length === 1
      && (attestationDescriptors[0].digest === runtimeDescriptors[0].digest
        || attestationDescriptors[0].annotations["vnd.docker.reference.digest"]
          !== runtimeDescriptors[0].digest))
  ) {
    fail("Docker image archive OCI index does not identify exactly one runtime image");
  }
  for (const attestation of attestationDescriptors) {
    const attestationManifest = readVerifiedOciJsonBlob(
      archivePath,
      attestation,
      commandRunner,
      "attestation manifest",
    );
    if (
      !exactKeys(attestationManifest, ["config", "layers", "mediaType", "schemaVersion"])
      || attestationManifest.schemaVersion !== 2
      || attestationManifest.mediaType !== attestation.mediaType
      || !Array.isArray(attestationManifest.layers)
      || attestationManifest.layers.length < 1
    ) {
      fail("Docker image archive attestation manifest is invalid");
    }
    validateOciDescriptor(
      attestationManifest.config,
      ["digest", "mediaType", "size"],
      ociConfigMediaTypes,
      "attestation config",
    );
    const attestationConfig = readVerifiedOciJsonBlob(
      archivePath,
      attestationManifest.config,
      commandRunner,
      "attestation config",
    );
    if (
      attestationConfig?.architecture !== "unknown"
      || attestationConfig?.os !== "unknown"
    ) {
      fail("Docker image archive attestation config is invalid");
    }
    for (const layer of attestationManifest.layers) {
      validateOciDescriptor(
        layer,
        ["annotations", "digest", "mediaType", "size"],
        new Set(["application/vnd.in-toto+json"]),
        "attestation layer",
      );
      if (
        !exactKeys(layer.annotations, ["in-toto.io/predicate-type"])
        || typeof layer.annotations["in-toto.io/predicate-type"] !== "string"
        || layer.annotations["in-toto.io/predicate-type"].length < 1
      ) {
        fail("Docker image archive attestation layer annotations are invalid");
      }
      const statement = readVerifiedOciJsonBlob(
        archivePath,
        layer,
        commandRunner,
        "attestation layer",
      );
      if (statement === null || typeof statement !== "object" || Array.isArray(statement)) {
        fail("Docker image archive attestation statement is invalid");
      }
    }
  }
  validateOciRuntimeManifest(
    archivePath,
    entry,
    runtimeDescriptors[0],
    runtimeDescriptors[0].platform,
    expected.expectedRevision,
    commandRunner,
  );
}

function validateClassicArchiveBinding(archivePath, entry, expected, commandRunner) {
  const expectedDigest = expected.expectedImageId.slice("sha256:".length);
  const expectedConfigPath = `${expectedDigest}.json`;
  if (entry.Config !== expectedConfigPath) {
    fail("Docker image archive classic config is not bound to the exact image ID");
  }
  let raw;
  try {
    raw = commandRunner("tar", ["-xOf", archivePath, expectedConfigPath]);
  } catch (error) {
    if (error instanceof ProductionImageVerificationError) throw error;
    fail("Docker image archive classic config is missing");
  }
  if (createHash("sha256").update(raw).digest("hex") !== expectedDigest) {
    fail("Docker image archive classic config does not match the exact image ID");
  }
  const config = parseArchiveJson(raw, "classic config");
  if (
    config?.os !== "linux"
    || config?.architecture !== "amd64"
    || config?.config?.Labels?.["org.opencontainers.image.revision"]
      !== expected.expectedRevision
  ) {
    fail("Docker image archive classic config is invalid");
  }
}

export function readAndValidateDockerArchive(
  archivePath,
  expected,
  commandRunner = run,
) {
  if (!existsSync(archivePath) || !lstatSync(archivePath).isFile()) {
    fail("Docker image archive is missing");
  }
  let manifest;
  try {
    manifest = JSON.parse(commandRunner("tar", ["-xOf", archivePath, "manifest.json"]));
  } catch (error) {
    if (error instanceof ProductionImageVerificationError) throw error;
    fail("Docker image archive manifest is invalid");
  }
  const entry = validateDockerArchiveManifestShape(manifest, expected, {
    allowLinkedContentStoreConfig: true,
  });
  if (entry.Config.endsWith(".json")) {
    validateClassicArchiveBinding(archivePath, entry, expected, commandRunner);
  } else {
    validateOciArchiveBinding(archivePath, entry, expected, commandRunner);
  }
  return entry;
}

function defaultCommandRunner(command, arguments_) {
  return run(command, arguments_);
}

export function verifyProductionImage({
  archivePath,
  commandRunner = defaultCommandRunner,
  expectedImageId,
  expectedRevision,
  imageReference,
  repositoryRoot = defaultRepositoryRoot,
  runtimeSourceBindingProvider = computePrivilegedRuntimeSourceBinding,
  sourceBindingProvider = computePublicSourceBinding,
}) {
  const expected = { imageReference, expectedImageId, expectedRevision };
  validateInputs(expected);
  const inspection = dockerJson(["image", "inspect", imageReference], commandRunner);
  validateProductionImageInspection(inspection, expected);
  const exactIdInspection = dockerJson(["image", "inspect", expectedImageId], commandRunner);
  validateProductionImageInspection(exactIdInspection, expected);

  const scratch = mkdtempSync(path.join(tmpdir(), "handleplan-production-image-"));
  const containerName = `handleplan-image-verify-${process.pid}-${randomBytes(6).toString("hex")}`;
  const runtimeRoot = path.join(scratch, "runtime");
  mkdirSync(runtimeRoot, { mode: 0o700 });
  let containerCreated = false;
  try {
    commandRunner("docker", ["create", "--name", containerName, expectedImageId]);
    containerCreated = true;
    commandRunner("docker", ["cp", `${containerName}:/app/.`, runtimeRoot]);
    const runtimeRootEntries = readdirSync(runtimeRoot).sort();
    if (JSON.stringify(runtimeRootEntries) !== JSON.stringify([
      ".handleplan-release",
      "apps",
      "deploy",
      "node_modules",
    ])) {
      fail("production image /app root contains an unexpected or missing entry");
    }
    const releaseProofRoot = path.join(runtimeRoot, imageReleaseProofPath.slice("/app/".length));
    assertExactDirectoryEntries(
      path.join(runtimeRoot, "apps"),
      ["web", "worker"],
      "production image applications root",
    );
    assertExactDirectoryEntries(
      releaseProofRoot,
      ["build-root", "packaging", "runtime", "standalone"],
      "production image release proof root",
    );
    assertExactDirectoryEntries(
      path.join(releaseProofRoot, "build-root"),
      ["BUILD_ID", "handleplan-public-build-environment.json", "static"],
      "production image sealed build proof",
    );
    assertExactDirectoryEntries(
      path.join(releaseProofRoot, "packaging"),
      [".dockerignore", "Dockerfile"],
      "production image packaging proof",
    );
    assertExactDirectoryEntries(
      path.join(releaseProofRoot, "runtime"),
      [runtimeShipmentBindingFilename],
      "production image privileged runtime proof",
    );
    const copiedPublic = path.join(runtimeRoot, imagePublicPath.slice("/app/".length));
    const copiedBinding = path.join(runtimeRoot, imageBindingPath.slice("/app/".length));
    let binding;
    try {
      binding = JSON.parse(readFileSync(copiedBinding, "utf8"));
    } catch {
      fail("production image build binding receipt is missing or invalid JSON");
    }
    validateEmbeddedBuildBinding(binding, expectedRevision);
    const publicTree = comparePublicTrees(
      path.join(repositoryRoot, "apps", "web", "public"),
      copiedPublic,
      binding.buildId,
    );
    const sourceBinding = sourceBindingProvider(repositoryRoot);
    if (
      sourceBinding.digestSha256 !== binding.sourceDigestSha256
      || sourceBinding.fileCount !== binding.sourceFileCount
    ) {
      fail("production image build binding is not bound to the exact revision source tree");
    }
    for (const packagingInput of ["Dockerfile", ".dockerignore"]) {
      const sourceBytes = readFileSync(path.join(repositoryRoot, packagingInput));
      const copiedBytes = readFileSync(
        path.join(releaseProofRoot, "packaging", packagingInput),
      );
      if (!sourceBytes.equals(copiedBytes)) {
        fail(`production image packaging ${packagingInput} differs from the revision source`);
      }
    }
    const sealedArtifact = recomputeSealedArtifact(releaseProofRoot, runtimeRoot, binding);
    const copiedServer = path.join(runtimeRoot, imageServerPath.slice("/app/".length));
    if (!existsSync(copiedServer) || !lstatSync(copiedServer).isFile()) {
      fail("production image standalone server is missing");
    }
    const staticTree = collectTree(
      path.join(runtimeRoot, imageStaticPath.slice("/app/".length)),
    );
    if (staticTree.fileCount < 1) fail("production image static tree is empty");
    const runtimeBindingFile = path.join(
      runtimeRoot,
      runtimeShipmentBindingPath.slice("/app/".length),
    );
    let runtimeBinding;
    try {
      runtimeBinding = JSON.parse(readFileSync(runtimeBindingFile, "utf8"));
    } catch {
      fail("production image privileged runtime shipment receipt is missing or invalid JSON");
    }
    validateEmbeddedRuntimeShipmentBinding(runtimeBinding, expectedRevision);
    const runtimeSourceBinding = runtimeSourceBindingProvider(repositoryRoot);
    if (
      runtimeSourceBinding.digestSha256 !== runtimeBinding.sourceDigestSha256
      || runtimeSourceBinding.fileCount !== runtimeBinding.sourceFileCount
    ) {
      fail("production image privileged runtime is not bound to the exact revision source tree");
    }
    const shipment = computePrivilegedRuntimeShipmentSnapshot(runtimeRoot);
    if (
      shipment.digestSha256 !== runtimeBinding.shipmentDigestSha256
      || shipment.entryCount !== runtimeBinding.shipmentEntryCount
      || shipment.fileCount !== runtimeBinding.shipmentFileCount
      || shipment.symlinkCount !== runtimeBinding.shipmentSymlinkCount
    ) {
      fail("production image privileged runtime differs from its source-bound shipment receipt");
    }
    if (archivePath !== undefined) {
      readAndValidateDockerArchive(archivePath, expected, commandRunner);
    }
    return {
      artifactDigestSha256: sealedArtifact.digestSha256,
      artifactEntryCount: sealedArtifact.entryCount,
      imageId: expectedImageId,
      platform: productionImagePlatform,
      publicFileCount: publicTree.fileCount,
      publicTreeDigestSha256: publicTree.digestSha256,
      revision: expectedRevision,
      shipmentDigestSha256: shipment.digestSha256,
      shipmentEntryCount: shipment.entryCount,
      shipmentFileCount: shipment.fileCount,
      shipmentSymlinkCount: shipment.symlinkCount,
      staticFileCount: staticTree.fileCount,
      runtimeSourceDigestSha256: runtimeSourceBinding.digestSha256,
      runtimeSourceFileCount: runtimeSourceBinding.fileCount,
    };
  } finally {
    if (containerCreated) {
      try {
        commandRunner("docker", ["rm", "-f", containerName]);
      } catch {
        // Preserve the primary verification result while still attempting cleanup.
      }
    }
    rmSync(scratch, { force: true, recursive: true });
  }
}

export function parseArguments(arguments_) {
  const parsed = {};
  const known = new Map([
    ["--archive", "archivePath"],
    ["--expected-image-id", "expectedImageId"],
    ["--expected-revision", "expectedRevision"],
    ["--image-reference", "imageReference"],
    ["--repository-root", "repositoryRoot"],
  ]);
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const key = known.get(name);
    const value = arguments_[index + 1];
    if (key === undefined || value === undefined || value.length === 0 || parsed[key] !== undefined) {
      fail("usage: verify-production-image.mjs --image-reference REF --expected-image-id SHA256 --expected-revision SHA [--archive PATH] [--repository-root PATH]");
    }
    parsed[key] = key === "repositoryRoot" ? path.resolve(value) : value;
  }
  if (
    parsed.imageReference === undefined
    || parsed.expectedImageId === undefined
    || parsed.expectedRevision === undefined
  ) {
    fail("usage: verify-production-image.mjs --image-reference REF --expected-image-id SHA256 --expected-revision SHA [--archive PATH] [--repository-root PATH]");
  }
  return parsed;
}

export function parseRuntimeSealArguments(arguments_) {
  const parsed = {};
  const known = new Map([
    ["--expected-revision", "expectedRevision"],
    ["--output", "outputPath"],
    ["--repository-root", "repositoryRoot"],
    ["--runtime-root", "runtimeRoot"],
  ]);
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const key = known.get(name);
    const value = arguments_[index + 1];
    if (key === undefined || value === undefined || value.length === 0 || parsed[key] !== undefined) {
      fail("usage: verify-production-image.mjs seal-runtime --runtime-root PATH --output PATH --expected-revision SHA --repository-root PATH");
    }
    parsed[key] = ["outputPath", "repositoryRoot", "runtimeRoot"].includes(key)
      ? path.resolve(value)
      : value;
  }
  if (
    parsed.runtimeRoot === undefined
    || parsed.outputPath === undefined
    || parsed.expectedRevision === undefined
    || parsed.repositoryRoot === undefined
  ) {
    fail("usage: verify-production-image.mjs seal-runtime --runtime-root PATH --output PATH --expected-revision SHA --repository-root PATH");
  }
  return parsed;
}

const moduleUrl = pathToFileURL(process.argv[1] ?? "").href;
if (import.meta.url === moduleUrl) {
  const sealRuntime = process.argv[2] === "seal-runtime";
  const result = sealRuntime
    ? writePrivilegedRuntimeShipmentBinding(
      parseRuntimeSealArguments(process.argv.slice(3)),
    )
    : verifyProductionImage(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
