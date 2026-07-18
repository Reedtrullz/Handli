import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function declaredLicense(manifest) {
  if (typeof manifest.license === "string" && manifest.license.trim() !== "") {
    return manifest.license.trim();
  }
  if (Array.isArray(manifest.licenses) && manifest.licenses.length > 0) {
    const licenses = manifest.licenses.map((entry) => (
      typeof entry === "string" ? entry : entry?.type
    ));
    if (licenses.every((license) => typeof license === "string" && license.trim() !== "")) {
      return licenses.map((license) => license.trim()).sort().join(" OR ");
    }
  }
  return "NOASSERTION";
}

function workspaceRoots(root) {
  const roots = [root];
  for (const parent of ["apps", "packages"]) {
    const parentPath = join(root, parent);
    if (!existsSync(parentPath)) continue;
    for (const entry of readdirSync(parentPath, { withFileTypes: true })) {
      const packageRoot = join(parentPath, entry.name);
      if (entry.isDirectory() && existsSync(join(packageRoot, "package.json"))) {
        roots.push(packageRoot);
      }
    }
  }
  return roots;
}

function dependencyRequests(manifest, includeDevelopment) {
  const requests = new Map();
  for (const [field, optional] of [
    ["dependencies", false],
    ["optionalDependencies", true],
    ["peerDependencies", false],
    ...(includeDevelopment ? [["devDependencies", false]] : []),
  ]) {
    const dependencies = manifest[field];
    if (dependencies === undefined) continue;
    for (const name of Object.keys(dependencies)) {
      const peerOptional = field === "peerDependencies"
        && manifest.peerDependenciesMeta?.[name]?.optional === true;
      const current = requests.get(name);
      requests.set(name, (current ?? true) && (optional || peerOptional));
    }
  }
  return requests;
}

function installedDependencyRoot(packageRoot, packageName, dependencyName, repository) {
  const realPackageRoot = realpathSync(packageRoot);
  const modulesRoot = packageName?.startsWith("@")
    ? dirname(dirname(realPackageRoot))
    : dirname(realPackageRoot);
  const candidates = [
    join(packageRoot, "node_modules", dependencyName),
    join(modulesRoot, dependencyName),
    join(repository, "node_modules", dependencyName),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
  }
  return undefined;
}

export function readDependencyInventory(root = repositoryRoot) {
  const virtualStorePath = join(root, "node_modules/.pnpm");
  if (!existsSync(virtualStorePath)) {
    throw new Error("node_modules/.pnpm is missing; run the frozen pnpm install first");
  }
  const packages = new Map();
  const visitedRoots = new Set();
  const pending = workspaceRoots(root).map((packageRoot) => ({
    includeDevelopment: true,
    packageRoot,
  }));
  while (pending.length > 0) {
    const current = pending.pop();
    const realPackageRoot = realpathSync(current.packageRoot);
    const visitKey = `${realPackageRoot}\0${current.includeDevelopment ? "development" : "runtime"}`;
    if (visitedRoots.has(visitKey)) continue;
    visitedRoots.add(visitKey);
    const manifest = JSON.parse(readFileSync(join(realPackageRoot, "package.json"), "utf8"));
    if (!current.includeDevelopment) {
      if (typeof manifest.name !== "string" || typeof manifest.version !== "string") continue;
      if (!manifest.name.startsWith("@handleplan/")) {
        const dependency = Object.freeze({
          license: declaredLicense(manifest),
          name: manifest.name,
          platformRestricted: manifest.os !== undefined
            || manifest.cpu !== undefined
            || manifest.libc !== undefined,
          version: manifest.version,
        });
        const identity = `${dependency.name}@${dependency.version}`;
        const previous = packages.get(identity);
        if (previous !== undefined && previous.license !== dependency.license) {
          throw new Error(`conflicting installed license declarations for ${identity}`);
        }
        packages.set(identity, dependency);
      }
    }

    for (const [dependencyName, optional] of dependencyRequests(
      manifest,
      current.includeDevelopment,
    )) {
      if (dependencyName.startsWith("@handleplan/")) continue;
      const dependencyRoot = installedDependencyRoot(
        realPackageRoot,
        manifest.name,
        dependencyName,
        root,
      );
      if (dependencyRoot === undefined) {
        if (optional) continue;
        throw new Error(`installed dependency ${dependencyName} required by ${manifest.name ?? realPackageRoot} is missing`);
      }
      pending.push({ includeDevelopment: false, packageRoot: dependencyRoot });
    }
  }

  const sorted = [...packages.values()].sort((left, right) => (
    left.name.localeCompare(right.name) || left.version.localeCompare(right.version)
  ));
  if (sorted.length === 0) throw new Error("installed dependency inventory is empty");
  return sorted;
}

export function inventoryDigest(packages) {
  return createHash("sha256").update(JSON.stringify(packages)).digest("hex");
}
