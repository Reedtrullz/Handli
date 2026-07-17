import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import {
  inventoryDigest,
  readDependencyInventory,
  repositoryRoot,
} from "./dependency-inventory.mjs";

function repositoryRevision(root) {
  const fromEnvironment = process.env.GITHUB_SHA;
  if (fromEnvironment !== undefined) {
    if (!/^[0-9a-f]{40}$/u.test(fromEnvironment)) throw new Error("GITHUB_SHA must be a full lowercase commit");
    return fromEnvironment;
  }
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  const revision = result.stdout.trim();
  if (result.status !== 0 || !/^[0-9a-f]{40}$/u.test(revision)) {
    throw new Error("cannot resolve repository revision for SBOM");
  }
  return revision;
}

function creationTime() {
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch === undefined) return new Date().toISOString();
  if (!/^\d{1,12}$/u.test(epoch)) throw new Error("SOURCE_DATE_EPOCH must be integer seconds");
  return new Date(Number(epoch) * 1_000).toISOString();
}

export function createSpdxDocument(packages, { created, revision }) {
  const digest = inventoryDigest(packages);
  const rootId = "SPDXRef-Package-Handleplan";
  const spdxPackages = [{
    SPDXID: rootId,
    downloadLocation: "https://github.com/Reedtrullz/Handli",
    filesAnalyzed: false,
    licenseConcluded: "AGPL-3.0-or-later",
    licenseDeclared: "AGPL-3.0-or-later",
    name: "handleplan",
    versionInfo: revision,
  }, ...packages.map((dependency, index) => ({
    SPDXID: `SPDXRef-Package-${String(index + 1).padStart(4, "0")}`,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: dependency.license,
    name: dependency.name,
    primaryPackagePurpose: dependency.platformRestricted ? "BINARY" : "LIBRARY",
    versionInfo: dependency.version,
  }))];
  return {
    SPDXID: "SPDXRef-DOCUMENT",
    creationInfo: {
      created,
      creators: ["Tool: handleplan-repository-sbom-v1"],
    },
    dataLicense: "CC0-1.0",
    documentDescribes: [rootId],
    documentNamespace: `https://handleplan.no/security/sbom/${revision}/${digest}`,
    name: `handleplan-source-${revision}`,
    packages: spdxPackages,
    relationships: packages.map((_, index) => ({
      relatedSpdxElement: `SPDXRef-Package-${String(index + 1).padStart(4, "0")}`,
      relationshipType: "DEPENDS_ON",
      spdxElementId: rootId,
    })),
    spdxVersion: "SPDX-2.3",
  };
}

export function writeSpdxDocument(outputPath, root = repositoryRoot) {
  const packages = readDependencyInventory(root);
  const document = createSpdxDocument(packages, {
    created: creationTime(),
    revision: repositoryRevision(root),
  });
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  JSON.parse(serialized);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serialized, { encoding: "utf8", mode: 0o644 });
  return {
    bytes: Buffer.byteLength(serialized),
    packages: document.packages.length,
    sha256: createHash("sha256").update(serialized).digest("hex"),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const outputArgument = process.argv[2];
  if (outputArgument === undefined || outputArgument.startsWith("-")) {
    throw new Error("usage: generate-sbom.mjs <output.spdx.json>");
  }
  const outputPath = resolve(repositoryRoot, outputArgument);
  const result = writeSpdxDocument(outputPath);
  process.stdout.write(`sbom-generated file=${basename(outputPath)} packages=${result.packages} bytes=${result.bytes} sha256=${result.sha256}\n`);
}
