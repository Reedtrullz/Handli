import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(import.meta.url);
const defaultRepositoryRoot = path.resolve(path.dirname(modulePath), "../..");
export const PUBLIC_BUILD_ID_PLACEHOLDER = "__HANDLEPLAN_PUBLIC_BUILD_ID__";
const bindingRelativePath = "apps/web/.next/handleplan-public-build-binding.json";
const environmentRelativePath = "apps/web/.next/handleplan-public-build-environment.json";
const buildInputPaths = [
  "apps/web",
  "docs/data/launch-coverage.v1.json",
  "packages/db",
  "packages/domain",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts/e2e/public-build-binding.mjs",
  "tsconfig.base.json",
];
const emittedRoots = [
  { kind: "file", relativePath: "apps/web/.next/BUILD_ID" },
  { kind: "directory", relativePath: "apps/web/.next/static" },
  { kind: "directory", relativePath: "apps/web/.next/standalone" },
  { kind: "file", relativePath: environmentRelativePath },
];
const excludedRelativeDirectories = new Set([
  "apps/web/.next",
  "apps/web/.turbo",
  "apps/web/coverage",
  "apps/web/node_modules",
  "apps/web/playwright-report",
  "apps/web/test-results",
  "packages/db/.turbo",
  "packages/db/coverage",
  "packages/db/node_modules",
  "packages/domain/.turbo",
  "packages/domain/coverage",
  "packages/domain/node_modules",
]);
const excludedRelativePaths = new Set([
  // Next rewrites this generated declaration during builds. It is not a build
  // input and must not invalidate the source snapshot after the build returns.
  "apps/web/next-env.d.ts",
]);
const excludedInputBasenames = new Set([
  // Finder may rewrite this ignored host metadata while a build is running.
  // It is neither tracked nor present in the CI source archive.
  ".DS_Store",
]);
const productionDotenvNames = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.production.local",
]);

export function materializePublicBuildFile(relativePath, bytes, buildId) {
  if (!/^hpv2-[0-9a-f]{64}$/u.test(buildId ?? "")) {
    throw new Error("public file materialization requires a canonical source-bound build ID");
  }
  const input = Buffer.from(bytes);
  if (relativePath !== "sw.js") return input;
  const source = input.toString("utf8");
  const occurrences = source.split(PUBLIC_BUILD_ID_PLACEHOLDER).length - 1;
  if (occurrences !== 1) {
    throw new Error("service worker must contain exactly one public build ID placeholder");
  }
  return Buffer.from(source.replace(PUBLIC_BUILD_ID_PLACEHOLDER, buildId), "utf8");
}

function normalizedRelativePath(repositoryRoot, absolutePath) {
  return path.relative(repositoryRoot, absolutePath).split(path.sep).join("/");
}

function collectInputFiles(repositoryRoot) {
  const files = [];

  function visit(absolutePath) {
    const relativePath = normalizedRelativePath(repositoryRoot, absolutePath);
    if (excludedRelativePaths.has(relativePath)) return;
    if (excludedInputBasenames.has(path.basename(absolutePath))) return;
    const stat = lstatSync(absolutePath);
    if (stat.isDirectory()) {
      if (excludedRelativeDirectories.has(relativePath)) return;
      for (const name of readdirSync(absolutePath).sort()) {
        visit(path.join(absolutePath, name));
      }
      return;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`symbolic links are not permitted in public build inputs: ${relativePath}`);
    }
    if (!stat.isFile()) {
      throw new Error(`unsupported public build input: ${relativePath}`);
    }
    files.push({ absolutePath, relativePath });
  }

  for (const inputPath of buildInputPaths) visit(path.join(repositoryRoot, inputPath));
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function updateFramed(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

function hashSourceFiles(files) {
  const hash = createHash("sha256");
  updateFramed(hash, "handleplan-public-build-source-v2");
  updateFramed(hash, `node:${process.versions.node}`);
  for (const file of files) {
    updateFramed(hash, file.relativePath);
    updateFramed(hash, readFileSync(file.absolutePath));
  }
  return hash.digest("hex");
}

export function computePublicSourceBinding(repositoryRoot = defaultRepositoryRoot) {
  const files = collectInputFiles(repositoryRoot);
  return {
    digestSha256: hashSourceFiles(files),
    fileCount: files.length,
  };
}

export function resolveExpectedPublicBuildRevision(environment = process.env) {
  const revision = environment.APP_COMMIT_SHA;
  if (environment.CI === "true") {
    if (typeof revision !== "string" || !/^[0-9a-f]{40}$/u.test(revision)) {
      throw new Error(
        "CI public builds and browser harnesses require APP_COMMIT_SHA as a full lowercase commit SHA",
      );
    }
    return revision;
  }
  if (revision === undefined) return "development";
  if (!/^(?:development|[0-9a-f]{40})$/u.test(revision)) {
    throw new Error("APP_COMMIT_SHA must be development or a full lowercase commit SHA");
  }
  return revision;
}

export function assertExpectedPublicBuildRevision(binding, environment = process.env) {
  const expectedRevision = resolveExpectedPublicBuildRevision(environment);
  if (binding?.buildEnvironment?.environment?.APP_COMMIT_SHA !== expectedRevision) {
    throw new Error("sealed public build revision does not match the expected browser evidence revision");
  }
  return expectedRevision;
}

function assertDirectoryDotenvFree(repositoryRoot, directory) {
  if (!existsSync(directory)) return;
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`public build dotenv boundary is not a directory: ${normalizedRelativePath(repositoryRoot, directory)}`);
  }
  for (const name of readdirSync(directory)) {
    if (productionDotenvNames.has(name.toLowerCase())) {
      throw new Error(`production dotenv files are forbidden in public builds: ${normalizedRelativePath(repositoryRoot, path.join(directory, name))}`);
    }
  }
}

export function assertPublicBuildDotenvFree(repositoryRoot = defaultRepositoryRoot) {
  const webRoot = path.join(repositoryRoot, "apps", "web");
  const standaloneRoot = path.join(webRoot, ".next", "standalone");
  for (const directory of [
    repositoryRoot,
    webRoot,
    standaloneRoot,
    path.join(standaloneRoot, "apps", "web"),
  ]) {
    assertDirectoryDotenvFree(repositoryRoot, directory);
  }
}

function assertEmittedRoots(repositoryRoot) {
  return emittedRoots.map((emittedRoot) => {
    const absolutePath = path.join(repositoryRoot, emittedRoot.relativePath);
    if (!existsSync(absolutePath)) {
      throw new Error(`public build artifact is missing: ${emittedRoot.relativePath}`);
    }
    const stat = lstatSync(absolutePath);
    if (
      stat.isSymbolicLink()
      || (emittedRoot.kind === "file" && !stat.isFile())
      || (emittedRoot.kind === "directory" && !stat.isDirectory())
    ) {
      throw new Error(
        `public build emitted root must be a real ${emittedRoot.kind}: ${emittedRoot.relativePath}`,
      );
    }
    return { ...emittedRoot, absolutePath };
  });
}

function isWithinRoot(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function inspectEmittedSymlink(repositoryRoot, absolutePath, artifactRoot) {
  const relativePath = normalizedRelativePath(repositoryRoot, absolutePath);
  const target = readlinkSync(absolutePath);
  if (path.isAbsolute(target)) {
    throw new Error(`absolute symbolic links are forbidden in public build artifacts: ${relativePath}`);
  }

  const resolvedTarget = path.resolve(path.dirname(absolutePath), target);
  if (!isWithinRoot(artifactRoot, resolvedTarget)) {
    throw new Error(`escaping symbolic links are forbidden in public build artifacts: ${relativePath}`);
  }

  let targetStat;
  let realTarget;
  try {
    targetStat = lstatSync(resolvedTarget);
    realTarget = realpathSync(resolvedTarget);
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") {
      return { dangling: true, relativePath, target };
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`public build symbolic link target cannot be resolved: ${relativePath}: ${detail}`);
  }

  if (!targetStat.isFile() && !targetStat.isDirectory() && !targetStat.isSymbolicLink()) {
    throw new Error(`unsupported public build symbolic link target: ${relativePath}`);
  }

  const realArtifactRoot = realpathSync(artifactRoot);
  if (!isWithinRoot(realArtifactRoot, realTarget)) {
    throw new Error(`resolving symbolic links are forbidden from escaping public build artifacts: ${relativePath}`);
  }
  const realTargetStat = lstatSync(realTarget);
  if (!realTargetStat.isFile() && !realTargetStat.isDirectory()) {
    throw new Error(`unsupported resolved public build symbolic link target: ${relativePath}`);
  }

  return { dangling: false, relativePath, target };
}

function collectEmittedEntries(repositoryRoot) {
  const entries = [];

  function visit(absolutePath, artifactRoot) {
    const relativePath = normalizedRelativePath(repositoryRoot, absolutePath);
    const stat = lstatSync(absolutePath);
    if (stat.isDirectory()) {
      entries.push({ kind: "directory", relativePath });
      for (const name of readdirSync(absolutePath).sort()) {
        visit(path.join(absolutePath, name), artifactRoot);
      }
      return;
    }
    if (stat.isSymbolicLink()) {
      const inspected = inspectEmittedSymlink(repositoryRoot, absolutePath, artifactRoot);
      if (inspected.dangling) {
        throw new Error(`dangling symbolic links are forbidden in public build artifacts: ${relativePath}`);
      }
      entries.push({ kind: "symlink", relativePath, target: inspected.target });
      return;
    }
    if (!stat.isFile()) {
      throw new Error(`unsupported public build artifact: ${relativePath}`);
    }
    entries.push({ absolutePath, kind: "file", relativePath });
  }

  for (const emittedRoot of assertEmittedRoots(repositoryRoot)) {
    visit(
      emittedRoot.absolutePath,
      emittedRoot.kind === "directory"
        ? emittedRoot.absolutePath
        : path.dirname(emittedRoot.absolutePath),
    );
  }
  return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function pruneGeneratedDanglingSymlinks(repositoryRoot) {
  for (const relativeRoot of [
    "apps/web/.next/static",
    "apps/web/.next/standalone",
  ]) {
    const artifactRoot = path.join(repositoryRoot, relativeRoot);
    const rootStat = lstatSync(artifactRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error(`public build generated output must be a real directory: ${relativeRoot}`);
    }

    function visit(absolutePath) {
      const stat = lstatSync(absolutePath);
      if (stat.isDirectory()) {
        for (const name of readdirSync(absolutePath).sort()) {
          visit(path.join(absolutePath, name));
        }
        return;
      }
      if (!stat.isSymbolicLink()) return;
      const inspected = inspectEmittedSymlink(repositoryRoot, absolutePath, artifactRoot);
      if (inspected.dangling) rmSync(absolutePath);
    }

    visit(artifactRoot);
  }
}

function digestEntries(entries, rootPrefix) {
  const hash = createHash("sha256");
  updateFramed(hash, rootPrefix);
  for (const entry of entries) {
    updateFramed(hash, entry.kind);
    updateFramed(hash, entry.relativePath);
    if (entry.kind === "file") updateFramed(hash, readFileSync(entry.absolutePath));
    if (entry.kind === "symlink") updateFramed(hash, entry.target);
  }
  return hash.digest("hex");
}

function relativeTreeDigest(directory, materializeFile) {
  const entries = [];

  function visit(absolutePath) {
    const relativePath = path.relative(directory, absolutePath).split(path.sep).join("/") || ".";
    const stat = lstatSync(absolutePath);
    if (stat.isDirectory()) {
      entries.push({ kind: "directory", relativePath });
      for (const name of readdirSync(absolutePath).sort()) visit(path.join(absolutePath, name));
      return;
    }
    if (stat.isSymbolicLink()) {
      entries.push({ kind: "symlink", relativePath, target: readlinkSync(absolutePath) });
      return;
    }
    if (!stat.isFile()) throw new Error(`unsupported compared public build artifact: ${relativePath}`);
    entries.push({ absolutePath, kind: "file", relativePath });
  }

  visit(directory);
  const hash = createHash("sha256");
  updateFramed(hash, "handleplan-public-build-tree-v1");
  for (const entry of entries) {
    updateFramed(hash, entry.kind);
    updateFramed(hash, entry.relativePath);
    if (entry.kind === "file") {
      const bytes = readFileSync(entry.absolutePath);
      updateFramed(
        hash,
        materializeFile === undefined
          ? bytes
          : materializeFile(entry.relativePath, bytes),
      );
    }
    if (entry.kind === "symlink") updateFramed(hash, entry.target);
  }
  return hash.digest("hex");
}

function readBuildEnvironment(repositoryRoot) {
  const environmentPath = path.join(repositoryRoot, environmentRelativePath);
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(environmentPath, "utf8"));
  } catch {
    throw new Error("public build environment receipt is missing or invalid");
  }
  const expectedKeys = [
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
    receipt?.contractVersion !== 1
    || receipt?.nodeVersion !== process.versions.node
    || receipt?.wrapper !== "handleplan-public-build-v2"
    || typeof receipt?.environment !== "object"
    || receipt.environment === null
    || JSON.stringify(Object.keys(receipt.environment).sort()) !== JSON.stringify(expectedKeys)
    || !/^(?:development|[0-9a-f]{40})$/u.test(receipt.environment.APP_COMMIT_SHA)
    || !/^[0-9a-f]{64}$/u.test(receipt.environment.HANDLEPLAN_PUBLIC_BUILD_SOURCE_DIGEST)
    || receipt.environment.NEXT_PUBLIC_HANDLEPLAN_BUILD_ID
      !== `hpv2-${receipt.environment.HANDLEPLAN_PUBLIC_BUILD_SOURCE_DIGEST}`
    || receipt.environment.CI !== "true"
    || receipt.environment.LANG !== "C.UTF-8"
    || receipt.environment.LC_ALL !== "C.UTF-8"
    || receipt.environment.NEXT_TELEMETRY_DISABLED !== "1"
    || receipt.environment.NODE_ENV !== "production"
    || receipt.environment.TZ !== "UTC"
  ) {
    throw new Error("public build environment receipt does not match the sanitized contract");
  }
  return receipt;
}

function validateMaterializedOutput(repositoryRoot, source) {
  const webRoot = path.join(repositoryRoot, "apps", "web");
  const nextRoot = path.join(webRoot, ".next");
  const standaloneWeb = path.join(nextRoot, "standalone", "apps", "web");
  const expectedBuildId = `hpv2-${source.digestSha256}`;
  const rootBuildId = readFileSync(path.join(nextRoot, "BUILD_ID"), "utf8");
  const standaloneBuildId = readFileSync(path.join(standaloneWeb, ".next", "BUILD_ID"), "utf8");
  if (rootBuildId !== expectedBuildId || standaloneBuildId !== expectedBuildId) {
    throw new Error("public build IDs are not bound to the source snapshot");
  }
  for (const staticRoot of [
    path.join(nextRoot, "static"),
    path.join(standaloneWeb, ".next", "static"),
  ]) {
    const buildStatic = path.join(staticRoot, expectedBuildId);
    if (!existsSync(buildStatic) || !lstatSync(buildStatic).isDirectory()) {
      throw new Error("public build static assets do not contain the source-bound build ID");
    }
  }
  if (
    relativeTreeDigest(
      path.join(webRoot, "public"),
      (relativePath, bytes) => materializePublicBuildFile(relativePath, bytes, expectedBuildId),
    )
      !== relativeTreeDigest(path.join(standaloneWeb, "public"))
    || relativeTreeDigest(path.join(nextRoot, "static"))
      !== relativeTreeDigest(path.join(standaloneWeb, ".next", "static"))
  ) {
    throw new Error("public build materialization differs from the sealed source assets");
  }
  return expectedBuildId;
}

export function computePublicBuildBinding(repositoryRoot = defaultRepositoryRoot) {
  assertEmittedRoots(repositoryRoot);
  assertPublicBuildDotenvFree(repositoryRoot);
  const source = computePublicSourceBinding(repositoryRoot);
  const buildEnvironment = readBuildEnvironment(repositoryRoot);
  if (buildEnvironment.environment.HANDLEPLAN_PUBLIC_BUILD_SOURCE_DIGEST !== source.digestSha256) {
    throw new Error("public build environment is bound to a different source snapshot");
  }
  const buildId = validateMaterializedOutput(repositoryRoot, source);
  const entries = collectEmittedEntries(repositoryRoot);
  return {
    artifactDigestSha256: digestEntries(entries, "handleplan-public-build-artifact-v2"),
    artifactEntryCount: entries.length,
    artifactFileCount: entries.filter(({ kind }) => kind === "file").length,
    artifactSymlinkCount: entries.filter(({ kind }) => kind === "symlink").length,
    architecture: process.arch,
    buildEnvironment,
    buildId,
    contractVersion: 2,
    nodeVersion: process.versions.node,
    platform: process.platform,
    sourceDigestSha256: source.digestSha256,
    sourceFileCount: source.fileCount,
  };
}

function bindingPath(repositoryRoot) {
  return path.join(repositoryRoot, bindingRelativePath);
}

function sealPublicBuild(repositoryRoot = defaultRepositoryRoot) {
  const outputPath = bindingPath(repositoryRoot);
  const binding = computePublicBuildBinding(repositoryRoot);
  writeFileSync(outputPath, `${JSON.stringify(binding, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return binding;
}

export function assertPublicBuildBinding(repositoryRoot = defaultRepositoryRoot) {
  const outputPath = bindingPath(repositoryRoot);
  let recorded;
  try {
    recorded = JSON.parse(readFileSync(outputPath, "utf8"));
  } catch {
    throw new Error(`public browser tests require a sealed standalone build: missing ${outputPath}`);
  }
  const current = computePublicBuildBinding(repositoryRoot);
  if (JSON.stringify(recorded) !== JSON.stringify(current)) {
    throw new Error("public browser tests require an untampered sealed build for the current source and emitted artifacts");
  }
  return current;
}

function sanitizedBuildEnvironment(sourceDigestSha256, revision) {
  return {
    APP_COMMIT_SHA: revision,
    CI: "true",
    HANDLEPLAN_PUBLIC_BUILD_SOURCE_DIGEST: sourceDigestSha256,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NEXT_PUBLIC_HANDLEPLAN_BUILD_ID: `hpv2-${sourceDigestSha256}`,
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_ENV: "production",
    TZ: "UTC",
  };
}

export function buildAndSealPublicWeb(repositoryRoot = defaultRepositoryRoot) {
  assertPublicBuildDotenvFree(repositoryRoot);
  const sourceBefore = computePublicSourceBinding(repositoryRoot);
  const revision = resolveExpectedPublicBuildRevision();

  const webRoot = path.join(repositoryRoot, "apps", "web");
  const nextRoot = path.join(webRoot, ".next");
  rmSync(nextRoot, { force: true, recursive: true });
  const semanticEnvironment = sanitizedBuildEnvironment(sourceBefore.digestSha256, revision);
  const nextCli = path.join(webRoot, "node_modules", "next", "dist", "bin", "next");
  if (!existsSync(nextCli)) throw new Error("the pinned Next CLI is unavailable");
  const result = spawnSync(process.execPath, [nextCli, "build"], {
    cwd: webRoot,
    env: {
      ...semanticEnvironment,
      __CF_USER_TEXT_ENCODING: "0x0:0x0:0x0",
      HOME: webRoot,
      PATH: process.env.PATH ?? "",
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
    },
    stdio: "inherit",
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.error === undefined
      ? `exit status ${result.status ?? "unknown"}${result.signal === null ? "" : ` signal ${result.signal}`}`
      : result.error.message;
    throw new Error(`Next public build failed: ${detail}`);
  }

  assertPublicBuildDotenvFree(repositoryRoot);
  const sourceAfter = computePublicSourceBinding(repositoryRoot);
  if (JSON.stringify(sourceAfter) !== JSON.stringify(sourceBefore)) {
    throw new Error("public build source changed while Next was producing the artifact");
  }

  const standaloneWeb = path.join(nextRoot, "standalone", "apps", "web");
  const standalonePublic = path.join(standaloneWeb, "public");
  rmSync(standalonePublic, { force: true, recursive: true });
  cpSync(path.join(webRoot, "public"), standalonePublic, { recursive: true });
  const serviceWorkerPath = path.join(standalonePublic, "sw.js");
  writeFileSync(
    serviceWorkerPath,
    materializePublicBuildFile(
      "sw.js",
      readFileSync(serviceWorkerPath),
      `hpv2-${sourceBefore.digestSha256}`,
    ),
  );
  const standaloneStatic = path.join(standaloneWeb, ".next", "static");
  rmSync(standaloneStatic, { force: true, recursive: true });
  cpSync(path.join(nextRoot, "static"), standaloneStatic, { recursive: true });
  pruneGeneratedDanglingSymlinks(repositoryRoot);
  writeFileSync(
    path.join(repositoryRoot, environmentRelativePath),
    `${JSON.stringify({
      contractVersion: 1,
      environment: semanticEnvironment,
      nodeVersion: process.versions.node,
      wrapper: "handleplan-public-build-v2",
    }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  assertPublicBuildDotenvFree(repositoryRoot);
  const binding = sealPublicBuild(repositoryRoot);
  assertPublicBuildBinding(repositoryRoot);
  return binding;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === modulePath) {
  const command = process.argv[2];
  if (command === "build") {
    const binding = buildAndSealPublicWeb();
    process.stdout.write(
      `sealed public build source=${binding.sourceDigestSha256} artifact=${binding.artifactDigestSha256} (${binding.artifactFileCount} files, ${binding.artifactSymlinkCount} symlinks)\n`,
    );
  } else if (command === "verify") {
    const binding = assertPublicBuildBinding();
    process.stdout.write(
      `verified sealed public build source=${binding.sourceDigestSha256} artifact=${binding.artifactDigestSha256} (${binding.artifactFileCount} files, ${binding.artifactSymlinkCount} symlinks)\n`,
    );
  } else {
    throw new Error("usage: public-build-binding.mjs build|verify");
  }
}
