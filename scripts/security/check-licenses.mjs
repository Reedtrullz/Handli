import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  inventoryDigest,
  readDependencyInventory,
  repositoryRoot,
} from "./dependency-inventory.mjs";

const policyPath = join(repositoryRoot, "docs/security/license-policy.v1.json");
const inventoryPath = join(repositoryRoot, "docs/security/third-party-licenses.v1.json");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function buildLicenseInventory(packages, policy, lockfileSha256) {
  if (!/^[0-9a-f]{64}$/u.test(lockfileSha256)) {
    throw new Error("lockfile digest must be a lowercase sha256");
  }
  const approvedLicenses = new Set(policy.approvedLicenseExpressions);
  const rejected = packages.filter((dependency) => !approvedLicenses.has(dependency.license));
  if (rejected.length > 0) {
    throw new Error(`unapproved dependency license declarations: ${rejected.map((entry) => `${entry.name}@${entry.version} (${entry.license})`).join(", ")}`);
  }
  const platformPackages = packages.filter((dependency) => dependency.platformRestricted);
  const unapprovedPlatformPackages = platformPackages.filter((dependency) => !policy.platformPackageRules.some((rule) => (
    rule.names.includes(dependency.name)
      && rule.versions.includes(dependency.version)
      && rule.approvedLicenseExpressions.includes(dependency.license)
  )));
  if (unapprovedPlatformPackages.length > 0) {
    throw new Error(`unapproved platform dependency: ${unapprovedPlatformPackages.map((entry) => `${entry.name}@${entry.version} (${entry.license})`).join(", ")}`);
  }
  const portablePackages = packages
    .filter((dependency) => !dependency.platformRestricted)
    .map(({ platformRestricted: _platformRestricted, ...dependency }) => dependency);
  const licenseCounts = Object.fromEntries(
    [...new Set(portablePackages.map((entry) => entry.license))]
      .sort()
      .map((license) => [license, portablePackages.filter((entry) => entry.license === license).length]),
  );
  return {
    contractVersion: 1,
    generatedFrom: "installed frozen pnpm dependency manifests",
    inventorySha256: inventoryDigest(portablePackages),
    licenseCounts,
    lockfileSha256,
    packageCount: portablePackages.length,
    packages: portablePackages,
    platformPackageRules: policy.platformPackageRules,
    policyVersion: policy.contractVersion,
  };
}

export function verifyLicenseInventory({ write = false } = {}) {
  const policy = readJson(policyPath);
  if (
    policy.contractVersion !== 1
    || !Array.isArray(policy.approvedLicenseExpressions)
    || !Array.isArray(policy.platformPackageRules)
  ) {
    throw new Error("license policy has an unsupported contract");
  }
  const lockfileSha256 = createHash("sha256")
    .update(readFileSync(join(repositoryRoot, "pnpm-lock.yaml")))
    .digest("hex");
  const inventory = buildLicenseInventory(
    readDependencyInventory(),
    policy,
    lockfileSha256,
  );
  const serialized = `${JSON.stringify(inventory, null, 2)}\n`;
  if (write) {
    writeFileSync(inventoryPath, serialized, { encoding: "utf8", mode: 0o644 });
  } else if (readFileSync(inventoryPath, "utf8") !== serialized) {
    throw new Error("third-party license inventory is stale; review changes and run security:licenses:write");
  }
  return inventory;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const write = process.argv.slice(2).includes("--write");
  const inventory = verifyLicenseInventory({ write });
  process.stdout.write(`license-policy-ok packages=${inventory.packageCount} digest=${inventory.inventorySha256}\n`);
}
