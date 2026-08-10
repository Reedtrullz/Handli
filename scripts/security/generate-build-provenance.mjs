import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { repositoryRoot } from "./dependency-inventory.mjs";

const SOURCE_URI = "https://github.com/Reedtrullz/Handli";

function fullCommit() {
  const revision = process.env.GITHUB_SHA ?? process.env.APP_COMMIT_SHA;
  if (revision === undefined || !/^[0-9a-f]{40}$/u.test(revision)) {
    throw new Error("GITHUB_SHA or APP_COMMIT_SHA must be a full lowercase commit");
  }
  return revision;
}

function baseImageDigest(root) {
  const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8");
  const match = dockerfile.match(/^FROM node:22\.22\.3-alpine@sha256:([0-9a-f]{64}) AS base$/mu);
  if (match?.[1] === undefined) throw new Error("Dockerfile base image is not the expected pinned Node image");
  return match[1];
}

export function createUnsignedProvenance({
  baseDigest,
  imageArchiveDigest,
  revision,
  runId,
}) {
  const gitMaterial = { digest: { sha1: revision }, uri: `git+${SOURCE_URI}.git` };
  const baseMaterial = {
    digest: { sha256: baseDigest },
    uri: "pkg:docker/node@22.22.3-alpine?repository_url=docker.io/library/node",
  };
  return {
    _type: "https://in-toto.io/Statement/v1",
    predicate: {
      buildDefinition: {
        buildType: `${SOURCE_URI}/blob/${revision}/docs/security/supply-chain.md#docker-build-v1`,
        externalParameters: {
          artifactFormat: "docker-archive",
          commitSha: revision,
          dockerfile: "Dockerfile",
        },
        internalParameters: {},
        resolvedDependencies: [gitMaterial, baseMaterial],
      },
      runDetails: {
        builder: { id: `${SOURCE_URI}/actions/workflows/ci.yml` },
        metadata: { invocationId: runId },
      },
    },
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [{
      digest: { sha256: imageArchiveDigest },
      name: "handleplan-image.docker.tar",
    }],
  };
}

async function fileSha256(path) {
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const fragment of createReadStream(path)) {
    bytes += fragment.byteLength;
    digest.update(fragment);
  }
  if (bytes === 0) throw new Error("Docker archive is empty");
  return digest.digest("hex");
}

export async function writeUnsignedProvenance(
  imageArchivePath,
  outputPath,
  root = repositoryRoot,
) {
  const revision = fullCommit();
  const runId = process.env.GITHUB_RUN_ID ?? "local-unverified";
  if (!/^(?:[1-9]\d{0,19}|local-unverified)$/u.test(runId)) throw new Error("invalid build invocation ID");
  const statement = createUnsignedProvenance({
    baseDigest: baseImageDigest(root),
    imageArchiveDigest: await fileSha256(imageArchivePath),
    revision,
    runId,
  });
  const serialized = `${JSON.stringify(statement, null, 2)}\n`;
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serialized, { encoding: "utf8", mode: 0o644 });
  return {
    bytes: Buffer.byteLength(serialized),
    sha256: createHash("sha256").update(serialized).digest("hex"),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv[2] === undefined || process.argv[3] === undefined) {
    throw new Error("usage: generate-build-provenance.mjs <image-archive.tar> <output.json>");
  }
  const imageArchivePath = resolve(repositoryRoot, process.argv[2]);
  const outputPath = resolve(repositoryRoot, process.argv[3]);
  const result = await writeUnsignedProvenance(imageArchivePath, outputPath);
  process.stdout.write(`unsigned-provenance-generated file=${basename(outputPath)} bytes=${result.bytes} sha256=${result.sha256}\n`);
}
