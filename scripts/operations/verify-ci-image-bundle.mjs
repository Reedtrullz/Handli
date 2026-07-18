import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { readDependencyInventory } from "../security/dependency-inventory.mjs";
import { createUnsignedProvenance } from "../security/generate-build-provenance.mjs";
import { createSpdxDocument } from "../security/generate-sbom.mjs";

const sha256Pattern = /^[0-9a-f]{64}$/u;
const revisionPattern = /^[0-9a-f]{40}$/u;
const positiveIntegerPattern = /^[1-9][0-9]{0,19}$/u;
const boundedCountPattern = /^[1-9][0-9]{0,15}$/u;
const productionImagePlatform = "linux/amd64";
const defaultRepositoryRoot = path.resolve(import.meta.dirname, "../..");
const expectedArtifactNames = Object.freeze([
  "handleplan-image-bundle.v1",
  "handleplan-image.docker.tar",
  "handleplan-source.tar",
  "handleplan.provenance.json",
  "handleplan.spdx.json",
]);
const artifactContracts = new Map([
  ["handleplan-image.docker.tar", {
    digestField: "image_archive_sha256",
    label: "CI Docker image archive",
    maximumBytes: 2 * 1024 * 1024 * 1024,
  }],
  ["handleplan-source.tar", {
    digestField: "source_archive_sha256",
    label: "CI source archive",
    maximumBytes: 128 * 1024 * 1024,
  }],
  ["handleplan.provenance.json", {
    digestField: "provenance_sha256",
    label: "CI provenance",
    maximumBytes: 1024 * 1024,
  }],
  ["handleplan.spdx.json", {
    digestField: "sbom_sha256",
    label: "CI SPDX SBOM",
    maximumBytes: 16 * 1024 * 1024,
  }],
]);

export class CiImageBundleVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CiImageBundleVerificationError";
  }
}

function fail(message) {
  throw new CiImageBundleVerificationError(message);
}

function regularFile(pathname, label, { maximumBytes, minimumBytes = 1 } = {}) {
  let stat;
  try {
    stat = lstatSync(pathname);
  } catch {
    fail(`${label} is missing`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular file`);
  if (
    !Number.isSafeInteger(stat.size)
    || stat.size < minimumBytes
    || (maximumBytes !== undefined && stat.size > maximumBytes)
  ) {
    fail(`${label} is empty or exceeds its byte limit`);
  }
  return stat;
}

async function sha256(pathname, expectedBytes) {
  const digest = createHash("sha256");
  let bytes = 0;
  try {
    for await (const fragment of createReadStream(pathname)) {
      bytes += fragment.byteLength;
      if (bytes > expectedBytes) fail("CI image bundle artifact changed while it was hashed");
      digest.update(fragment);
    }
  } catch (error) {
    if (error instanceof CiImageBundleVerificationError) throw error;
    fail("CI image bundle artifact could not be streamed safely");
  }
  if (bytes !== expectedBytes) fail("CI image bundle artifact changed while it was hashed");
  return digest.digest("hex");
}

function parseUniqueJson(text, label) {
  let index = 0;

  function invalid() {
    fail(`${label} is not valid unambiguous JSON`);
  }

  function skipWhitespace() {
    while (
      text[index] === " "
      || text[index] === "\t"
      || text[index] === "\n"
      || text[index] === "\r"
    ) index += 1;
  }

  function parseString() {
    if (text[index] !== "\"") invalid();
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === "\"") {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index));
        } catch {
          invalid();
        }
      }
      if (character === "\\") {
        index += 2;
      } else {
        index += 1;
      }
    }
    invalid();
  }

  function parseValue(depth) {
    if (depth > 128) invalid();
    skipWhitespace();
    const character = text[index];
    if (character === "{") return parseObject(depth + 1);
    if (character === "[") return parseArray(depth + 1);
    if (character === "\"") return parseString();
    for (const [literal, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ]) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return value;
      }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u
      .exec(text.slice(index))?.[0];
    if (number === undefined) invalid();
    index += number.length;
    try {
      return JSON.parse(number);
    } catch {
      invalid();
    }
  }

  function parseObject(depth) {
    index += 1;
    skipWhitespace();
    const value = {};
    const keys = new Set();
    if (text[index] === "}") {
      index += 1;
      return value;
    }
    while (index < text.length) {
      skipWhitespace();
      const key = parseString();
      if (keys.has(key)) fail(`${label} contains a duplicate object key`);
      keys.add(key);
      skipWhitespace();
      if (text[index] !== ":") invalid();
      index += 1;
      const member = parseValue(depth);
      Object.defineProperty(value, key, {
        configurable: true,
        enumerable: true,
        value: member,
        writable: true,
      });
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return value;
      }
      if (text[index] !== ",") invalid();
      index += 1;
    }
    invalid();
  }

  function parseArray(depth) {
    index += 1;
    skipWhitespace();
    const value = [];
    if (text[index] === "]") {
      index += 1;
      return value;
    }
    while (index < text.length) {
      value.push(parseValue(depth));
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return value;
      }
      if (text[index] !== ",") invalid();
      index += 1;
    }
    invalid();
  }

  const result = parseValue(0);
  skipWhitespace();
  if (index !== text.length) invalid();
  return result;
}

function parseBoundedJson(pathname, label) {
  try {
    return parseUniqueJson(readFileSync(pathname, "utf8"), label);
  } catch (error) {
    if (error instanceof CiImageBundleVerificationError) throw error;
    fail(`${label} is not valid JSON`);
  }
}

function baseImageDigest(repositoryRoot) {
  const dockerfilePath = path.join(repositoryRoot, "Dockerfile");
  regularFile(dockerfilePath, "repository Dockerfile", { maximumBytes: 1024 * 1024 });
  const dockerfile = readFileSync(dockerfilePath, "utf8");
  const directives = dockerfile
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^from(?:\s|$)/iu.test(line));
  const external = directives[0]?.match(
    /^FROM node:22\.22\.3-alpine@sha256:([0-9a-f]{64}) AS base$/u,
  );
  if (
    external?.[1] === undefined
    || directives.length !== 4
    || directives[1] !== "FROM base AS dependencies"
    || directives[2] !== "FROM dependencies AS builder"
    || directives[3] !== "FROM base AS runner"
  ) {
    fail("repository Dockerfile does not match the exact represented stage graph");
  }
  return external[1];
}

export function validateCiProvenance(
  document,
  { baseDigest, expectedRevision, expectedRunId, imageArchiveDigest },
) {
  const expected = createUnsignedProvenance({
    baseDigest,
    imageArchiveDigest,
    revision: expectedRevision,
    runId: expectedRunId,
  });
  if (!isDeepStrictEqual(document, expected)) {
    fail("CI provenance does not match the exact build, source, base, run, and image archive");
  }
  return document;
}

export function validateCiSpdx(document, { dependencyInventory, expectedRevision }) {
  const created = document?.creationInfo?.created;
  if (
    typeof created !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(created)
    || Number.isNaN(Date.parse(created))
    || new Date(created).toISOString() !== created
  ) {
    fail("CI SPDX SBOM has an invalid creation time");
  }
  const expected = createSpdxDocument(dependencyInventory, {
    created,
    revision: expectedRevision,
  });
  if (!isDeepStrictEqual(document, expected)) {
    fail("CI SPDX SBOM does not match the exact revision and installed dependency inventory");
  }
  return document;
}

export async function verifyCiImageBundle({
  dependencyInventoryProvider = readDependencyInventory,
  expectedImageId,
  expectedManifestSha256,
  expectedRevision,
  expectedRunAttempt,
  expectedRunId,
  manifestPath,
  repositoryRoot = defaultRepositoryRoot,
}) {
  if (
    !sha256Pattern.test(expectedManifestSha256 ?? "")
    || !revisionPattern.test(expectedRevision ?? "")
    || !/^sha256:[0-9a-f]{64}$/u.test(expectedImageId ?? "")
    || !positiveIntegerPattern.test(expectedRunId ?? "")
    || !positiveIntegerPattern.test(expectedRunAttempt ?? "")
    || typeof manifestPath !== "string"
    || manifestPath.length === 0
    || typeof repositoryRoot !== "string"
    || repositoryRoot.length === 0
    || typeof dependencyInventoryProvider !== "function"
  ) fail("CI image bundle verifier inputs are invalid");

  const absoluteManifestPath = path.resolve(manifestPath);
  const artifactDirectory = path.dirname(absoluteManifestPath);
  const manifestStat = regularFile(absoluteManifestPath, "CI image bundle manifest", {
    maximumBytes: 4_096,
  });
  const names = readdirSync(artifactDirectory).sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedArtifactNames)) {
    fail("CI image bundle directory has unexpected or missing artifacts");
  }
  if (await sha256(absoluteManifestPath, manifestStat.size) !== expectedManifestSha256) {
    fail("CI image bundle manifest changed after its evidence boundary");
  }

  const bytes = readFileSync(absoluteManifestPath);
  if (bytes.length > 4_096 || bytes.includes(0)) fail("CI image bundle manifest is not bounded text");
  const text = bytes.toString("utf8");
  const expectedKeys = [
    "format",
    "revision",
    "image_reference",
    "image_id",
    "platform",
    "runtime_source_digest_sha256",
    "runtime_source_file_count",
    "runtime_shipment_digest_sha256",
    "runtime_shipment_entry_count",
    "image_archive_sha256",
    "source_archive_sha256",
    "provenance_sha256",
    "sbom_sha256",
    "ci_run_id",
    "ci_run_attempt",
  ];
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : [];
  if (lines.length !== expectedKeys.length) fail("CI image bundle manifest has an invalid shape");
  const values = new Map();
  for (let index = 0; index < expectedKeys.length; index += 1) {
    const key = expectedKeys[index];
    const prefix = `${key}=`;
    const line = lines[index] ?? "";
    if (!line.startsWith(prefix) || line.length === prefix.length) {
      fail("CI image bundle manifest has an invalid shape");
    }
    values.set(key, line.slice(prefix.length));
  }
  if (
    values.get("format") !== "handleplan-ci-image-bundle-v3"
    || values.get("revision") !== expectedRevision
    || values.get("image_reference") !== `handleplan:${expectedRevision}`
    || values.get("image_id") !== expectedImageId
    || values.get("platform") !== productionImagePlatform
    || values.get("ci_run_id") !== expectedRunId
    || values.get("ci_run_attempt") !== expectedRunAttempt
  ) fail("CI image bundle manifest identity differs from the proven candidate");

  const runtimeSourceDigestSha256 = values.get("runtime_source_digest_sha256") ?? "";
  const runtimeSourceFileCount = values.get("runtime_source_file_count") ?? "";
  const runtimeShipmentDigestSha256 = values.get("runtime_shipment_digest_sha256") ?? "";
  const runtimeShipmentEntryCount = values.get("runtime_shipment_entry_count") ?? "";
  if (
    !sha256Pattern.test(runtimeSourceDigestSha256)
    || !boundedCountPattern.test(runtimeSourceFileCount)
    || !sha256Pattern.test(runtimeShipmentDigestSha256)
    || !boundedCountPattern.test(runtimeShipmentEntryCount)
  ) fail("CI image bundle runtime shipment proof is invalid");

  for (const [filename, contract] of artifactContracts) {
    const pathname = path.join(artifactDirectory, filename);
    const stat = regularFile(pathname, contract.label, {
      maximumBytes: contract.maximumBytes,
    });
    const expectedDigest = values.get(contract.digestField) ?? "";
    if (
      !sha256Pattern.test(expectedDigest)
      || await sha256(pathname, stat.size) !== expectedDigest
    ) {
      fail(`CI image bundle artifact changed after its evidence boundary: ${filename}`);
    }
  }

  let dependencyInventory;
  try {
    dependencyInventory = dependencyInventoryProvider(path.resolve(repositoryRoot));
  } catch {
    fail("installed dependency inventory could not be reproduced for CI SBOM verification");
  }
  if (!Array.isArray(dependencyInventory) || dependencyInventory.length < 1) {
    fail("installed dependency inventory is invalid for CI SBOM verification");
  }
  const provenancePath = path.join(artifactDirectory, "handleplan.provenance.json");
  validateCiProvenance(parseBoundedJson(provenancePath, "CI provenance"), {
    baseDigest: baseImageDigest(path.resolve(repositoryRoot)),
    expectedRevision,
    expectedRunId,
    imageArchiveDigest: values.get("image_archive_sha256"),
  });
  const sbomPath = path.join(artifactDirectory, "handleplan.spdx.json");
  validateCiSpdx(parseBoundedJson(sbomPath, "CI SPDX SBOM"), {
    dependencyInventory,
    expectedRevision,
  });
  return Object.freeze({
    imageId: expectedImageId,
    manifestSha256: expectedManifestSha256,
    platform: productionImagePlatform,
    revision: expectedRevision,
    runtimeShipmentDigestSha256,
    runtimeShipmentEntryCount: Number(runtimeShipmentEntryCount),
    runtimeSourceDigestSha256,
    runtimeSourceFileCount: Number(runtimeSourceFileCount),
  });
}

function parseArguments(arguments_) {
  if (arguments_.length !== 6) {
    fail("usage: verify-ci-image-bundle.mjs MANIFEST MANIFEST_SHA REVISION IMAGE_ID RUN_ID RUN_ATTEMPT");
  }
  const [manifestPath, expectedManifestSha256, expectedRevision, expectedImageId, expectedRunId, expectedRunAttempt] = arguments_;
  return {
    expectedImageId,
    expectedManifestSha256,
    expectedRevision,
    expectedRunAttempt,
    expectedRunId,
    manifestPath,
  };
}

const moduleUrl = pathToFileURL(process.argv[1] ?? "").href;
if (import.meta.url === moduleUrl) {
  const result = await verifyCiImageBundle(parseArguments(process.argv.slice(2)));
  process.stdout.write(
    `verified CI image bundle revision=${result.revision} image=${result.imageId} manifest=${result.manifestSha256}\n`,
  );
}
