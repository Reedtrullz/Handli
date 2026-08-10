import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertExpectedPublicBuildRevision,
  assertPublicBuildBinding,
  buildAndSealPublicWeb,
  computePublicBuildBinding,
  computePublicSourceBinding,
  materializePublicBuildFile,
  resolveExpectedPublicBuildRevision,
} from "../../scripts/e2e/public-build-binding.mjs";

const bindingPath = "apps/web/.next/handleplan-public-build-binding.json";

function write(root, relativePath, contents) {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
}

function fixtureRepository() {
  const root = mkdtempSync(path.join(tmpdir(), "handleplan-public-build-binding-test-"));
  const sourceFiles = {
    "apps/web/app/page.tsx": "export default function Page() { return null; }\n",
    "apps/web/next-env.d.ts": "generated-before-build\n",
    "apps/web/.env.example": "DOCUMENTATION_ONLY=true\n",
    "apps/web/package.json": "{}\n",
    "apps/web/public/sw.js": "const buildId = '__HANDLEPLAN_PUBLIC_BUILD_ID__'; self.addEventListener('fetch', () => buildId);\n",
    "docs/data/launch-coverage.v1.json": "{\"regions\":[]}\n",
    "package.json": "{}\n",
    "packages/db/src/index.ts": "export const database = true;\n",
    "packages/domain/src/index.ts": "export const domain = true;\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "pnpm-workspace.yaml": "packages: []\n",
    "scripts/e2e/public-build-binding.mjs": "fixture-copy\n",
    "tsconfig.base.json": "{}\n",
  };
  for (const [relativePath, contents] of Object.entries(sourceFiles)) {
    write(root, relativePath, contents);
  }

  const source = computePublicSourceBinding(root);
  const buildId = `hpv2-${source.digestSha256}`;
  const staticFile = `apps/web/.next/static/${buildId}/_buildManifest.js`;
  const standaloneStaticFile = `apps/web/.next/standalone/apps/web/.next/static/${buildId}/_buildManifest.js`;
  write(root, "apps/web/.next/BUILD_ID", buildId);
  write(root, staticFile, "self.__BUILD_MANIFEST={};\n");
  write(root, "apps/web/.next/standalone/apps/web/.next/BUILD_ID", buildId);
  write(root, standaloneStaticFile, "self.__BUILD_MANIFEST={};\n");
  write(root, "apps/web/.next/standalone/apps/web/server.js", "process.stdout.write('server');\n");
  write(root, "apps/web/.next/standalone/apps/web/package.json", "{}\n");
  write(
    root,
    "apps/web/.next/standalone/apps/web/public/sw.js",
    materializePublicBuildFile(
      "sw.js",
      Buffer.from(sourceFiles["apps/web/public/sw.js"]),
      buildId,
    ),
  );
  write(root, "apps/web/.next/handleplan-public-build-environment.json", `${JSON.stringify({
    contractVersion: 1,
    environment: {
      APP_COMMIT_SHA: "development",
      CI: "true",
      HANDLEPLAN_PUBLIC_BUILD_SOURCE_DIGEST: source.digestSha256,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      NEXT_PUBLIC_HANDLEPLAN_BUILD_ID: `hpv2-${source.digestSha256}`,
      NEXT_TELEMETRY_DISABLED: "1",
      NODE_ENV: "production",
      TZ: "UTC",
    },
    nodeVersion: process.versions.node,
    wrapper: "handleplan-public-build-v2",
  }, null, 2)}\n`);
  return { buildId, root, staticFile, standaloneStaticFile };
}

function recordBinding(root) {
  const binding = computePublicBuildBinding(root);
  write(root, bindingPath, `${JSON.stringify(binding, null, 2)}\n`);
  return binding;
}

test("materializes exactly one source-bound service-worker identity", () => {
  const buildId = `hpv2-${"a".repeat(64)}`;
  const source = Buffer.from(
    "const embedded = '__HANDLEPLAN_PUBLIC_BUILD_ID__';\n",
    "utf8",
  );
  assert.equal(
    materializePublicBuildFile("sw.js", source, buildId).toString("utf8"),
    `const embedded = '${buildId}';\n`,
  );
  assert.equal(
    materializePublicBuildFile("icon.svg", Buffer.from("<svg/>"), buildId).toString(),
    "<svg/>",
  );
  assert.throws(
    () => materializePublicBuildFile("sw.js", Buffer.from("no marker"), buildId),
    /exactly one/u,
  );
  assert.throws(
    () => materializePublicBuildFile("sw.js", source, "development"),
    /canonical/u,
  );
});

test("CI requires a full expected revision and rejects a differently labelled sealed build", () => {
  const revision = "a".repeat(40);
  const binding = {
    buildEnvironment: { environment: { APP_COMMIT_SHA: revision } },
  };

  assert.equal(resolveExpectedPublicBuildRevision({}), "development");
  assert.equal(
    resolveExpectedPublicBuildRevision({ APP_COMMIT_SHA: "development" }),
    "development",
  );
  assert.equal(
    resolveExpectedPublicBuildRevision({ APP_COMMIT_SHA: revision, CI: "true" }),
    revision,
  );
  assert.equal(
    assertExpectedPublicBuildRevision(binding, { APP_COMMIT_SHA: revision, CI: "true" }),
    revision,
  );
  assert.throws(
    () => resolveExpectedPublicBuildRevision({ CI: "true" }),
    /require APP_COMMIT_SHA/u,
  );
  assert.throws(
    () => resolveExpectedPublicBuildRevision({ APP_COMMIT_SHA: "development", CI: "true" }),
    /require APP_COMMIT_SHA/u,
  );
  assert.throws(
    () => assertExpectedPublicBuildRevision(binding, {
      APP_COMMIT_SHA: "b".repeat(40),
      CI: "true",
    }),
    /does not match/u,
  );
});

test("CI binds the host build, lifecycle proof, and browser harnesses to github.sha", () => {
  const workflow = readFileSync(path.resolve(".github/workflows/ci.yml"), "utf8");
  for (const [name, command] of [
    ["Build the revision-bound public host artifact", "corepack pnpm build"],
    [
      "Prove the public browser harness fails closed on upstream exit",
      "corepack pnpm e2e:public-lifecycle",
    ],
    [
      "Prove revision-bound Handlemodus in Chromium, Firefox, and WebKit",
      "corepack pnpm e2e:handlemodus",
    ],
    [
      "Prove the revision-bound public host artifact in Chromium, Firefox, and WebKit",
      "corepack pnpm exec playwright test",
    ],
  ]) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const escapedCommand = command.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    assert.match(
      workflow,
      new RegExp(
        `- name: ${escapedName}\\n\\s+env:\\n\\s+APP_COMMIT_SHA: \\$\\{\\{ github\\.sha \\}\\}\\n\\s+run: ${escapedCommand}`,
        "u",
      ),
    );
  }

  const publicHarness = readFileSync(path.resolve("tests/e2e/start-https-server.mjs"), "utf8");
  const handlemodusHarness = readFileSync(
    path.resolve("apps/web/tests/handlemodus/start-production-server.mjs"),
    "utf8",
  );
  for (const harness of [publicHarness, handlemodusHarness]) {
    assert.match(harness, /assertExpectedPublicBuildRevision\(binding\)/u);
    assert.match(harness, /APP_COMMIT_SHA: expectedRevision/u);
  }
});

test("the sealed public build fails closed after a source input changes", () => {
  const { root } = fixtureRepository();
  try {
    const written = recordBinding(root);
    assert.deepEqual(assertPublicBuildBinding(root), written);

    write(root, "apps/web/app/page.tsx", "export default function Page() { return 1; }\n");
    assert.throws(
      () => assertPublicBuildBinding(root),
      /different source snapshot|untampered sealed build/u,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("the production launch coverage manifest is part of the canonical source binding", () => {
  const { root } = fixtureRepository();
  try {
    const before = computePublicSourceBinding(root);
    write(root, "docs/data/launch-coverage.v1.json", "{\"regions\":[\"oslo\"]}\n");
    const after = computePublicSourceBinding(root);
    assert.equal(after.fileCount, before.fileCount);
    assert.notEqual(after.digestSha256, before.digestSha256);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("source framing distinguishes binary NUL boundaries and includes nested coverage routes", () => {
  const first = fixtureRepository();
  const second = fixtureRepository();
  try {
    const prefix = "apps/web/app/";
    write(first.root, `${prefix}a`, Buffer.from(`X\0${prefix}b`));
    write(first.root, `${prefix}c`, Buffer.from("Y"));
    write(second.root, `${prefix}a`, Buffer.from("X"));
    write(second.root, `${prefix}b`, Buffer.from(`${prefix}c\0Y`));

    const firstBinding = computePublicSourceBinding(first.root);
    const secondBinding = computePublicSourceBinding(second.root);
    assert.equal(firstBinding.fileCount, secondBinding.fileCount);
    assert.notEqual(firstBinding.digestSha256, secondBinding.digestSha256);

    const beforeCoverage = computePublicSourceBinding(first.root);
    write(first.root, "apps/web/app/coverage/page.tsx", "export default function Coverage() {}\n");
    const afterCoverage = computePublicSourceBinding(first.root);
    assert.equal(afterCoverage.fileCount, beforeCoverage.fileCount + 1);
    assert.notEqual(afterCoverage.digestSha256, beforeCoverage.digestSha256);
  } finally {
    rmSync(first.root, { force: true, recursive: true });
    rmSync(second.root, { force: true, recursive: true });
  }
});

test("generated declarations and ignored host metadata are excluded but every shipped artifact is bound", () => {
  const { buildId, root, standaloneStaticFile, staticFile } = fixtureRepository();
  try {
    const written = recordBinding(root);
    write(root, "apps/web/next-env.d.ts", "generated-after-build\n");
    write(root, "apps/web/.DS_Store", "ignored-host-metadata-before\n");
    write(root, "apps/web/.DS_Store", "ignored-host-metadata-after\n");
    assert.deepEqual(assertPublicBuildBinding(root), written);

    const mutations = [
      ["apps/web/.next/standalone/apps/web/server.js", "tampered server\n"],
      [staticFile, "tampered root static\n"],
      [standaloneStaticFile, "tampered standalone static\n"],
      ["apps/web/.next/standalone/apps/web/public/sw.js", "tampered service worker\n"],
      ["apps/web/.next/BUILD_ID", `${buildId}-tampered`],
      ["apps/web/.next/standalone/apps/web/.next/BUILD_ID", `${buildId}-tampered`],
    ];
    for (const [relativePath, contents] of mutations) {
      const original = readFileSync(path.join(root, relativePath));
      write(root, relativePath, contents);
      assert.throws(
        () => assertPublicBuildBinding(root),
        /build IDs|materialization differs|untampered sealed build/u,
        relativePath,
      );
      write(root, relativePath, original);
      assert.deepEqual(assertPublicBuildBinding(root), written);
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("artifact creation order and timestamps do not alter the canonical binding", () => {
  const { root } = fixtureRepository();
  const { root: reorderedRoot } = fixtureRepository();
  try {
    write(root, "apps/web/.next/standalone/apps/web/order-a", "a\n");
    write(root, "apps/web/.next/standalone/apps/web/order-b", "b\n");
    write(reorderedRoot, "apps/web/.next/standalone/apps/web/order-b", "b\n");
    write(reorderedRoot, "apps/web/.next/standalone/apps/web/order-a", "a\n");
    const before = computePublicBuildBinding(root);
    assert.deepEqual(computePublicBuildBinding(reorderedRoot), before);
    const server = path.join(root, "apps/web/.next/standalone/apps/web/server.js");
    utimesSync(server, new Date("2000-01-01T00:00:00Z"), new Date("2001-01-01T00:00:00Z"));
    assert.deepEqual(computePublicBuildBinding(root), before);
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(reorderedRoot, { force: true, recursive: true });
  }
});

test("artifact framing distinguishes binary NUL boundaries", () => {
  const first = fixtureRepository();
  const second = fixtureRepository();
  try {
    const prefix = "apps/web/.next/standalone/apps/web/";
    write(first.root, `${prefix}a`, Buffer.from(`X\0file\0${prefix}b`));
    write(first.root, `${prefix}c`, Buffer.from("Y"));
    write(second.root, `${prefix}a`, Buffer.from("X"));
    write(second.root, `${prefix}b`, Buffer.from(`file\0${prefix}c\0Y`));
    const firstBinding = computePublicBuildBinding(first.root);
    const secondBinding = computePublicBuildBinding(second.root);
    assert.equal(firstBinding.artifactEntryCount, secondBinding.artifactEntryCount);
    assert.notEqual(firstBinding.artifactDigestSha256, secondBinding.artifactDigestSha256);
  } finally {
    rmSync(first.root, { force: true, recursive: true });
    rmSync(second.root, { force: true, recursive: true });
  }
});

test("missing emitted roots and special artifact entries fail closed", () => {
  const missing = fixtureRepository();
  try {
    rmSync(path.join(missing.root, "apps/web/.next/static"), { recursive: true });
    assert.throws(
      () => computePublicBuildBinding(missing.root),
      /missing|ENOENT|static assets/u,
    );
  } finally {
    rmSync(missing.root, { force: true, recursive: true });
  }

  const special = fixtureRepository();
  try {
    const fifo = path.join(special.root, "apps/web/.next/standalone/apps/web/special-fifo");
    const created = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    assert.throws(
      () => computePublicBuildBinding(special.root),
      /unsupported public build artifact/u,
    );
  } finally {
    rmSync(special.root, { force: true, recursive: true });
  }
});

test("every emitted root must be real while nested in-tree symlinks remain supported", () => {
  for (const relativePath of [
    "apps/web/.next/BUILD_ID",
    "apps/web/.next/static",
    "apps/web/.next/standalone",
    "apps/web/.next/handleplan-public-build-environment.json",
  ]) {
    const { root } = fixtureRepository();
    try {
      const absolutePath = path.join(root, relativePath);
      const targetPath = `${absolutePath}-symlink-target`;
      renameSync(absolutePath, targetPath);
      symlinkSync(path.basename(targetPath), absolutePath);
      assert.throws(
        () => computePublicBuildBinding(root),
        /emitted root must be a real|materialization differs/u,
        relativePath,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }
});

test("relative in-tree emitted symlinks are bound while unsafe targets are rejected", () => {
  const { root } = fixtureRepository();
  try {
    const link = path.join(root, "apps/web/.next/standalone/apps/web/server-link.js");
    const chainedLink = path.join(
      root,
      "apps/web/.next/standalone/apps/web/chained-server-link.js",
    );
    symlinkSync("server.js", link);
    symlinkSync("server-link.js", chainedLink);
    const written = recordBinding(root);
    assert.equal(written.artifactSymlinkCount, 2);
    rmSync(link);
    symlinkSync("package.json", link);
    assert.throws(() => assertPublicBuildBinding(root), /untampered sealed build/u);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }

  for (const target of ["/absolute/server.js", "../../../../../../outside.js"]) {
    const { root } = fixtureRepository();
    try {
      symlinkSync(target, path.join(root, "apps/web/.next/standalone/apps/web/unsafe-link.js"));
      assert.throws(
        () => computePublicBuildBinding(root),
        /symbolic links are forbidden/u,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }

  const { root: danglingRoot } = fixtureRepository();
  try {
    symlinkSync("missing-but-in-tree.js", path.join(
      danglingRoot,
      "apps/web/.next/standalone/apps/web/dangling-link.js",
    ));
    assert.throws(
      () => computePublicBuildBinding(danglingRoot),
      /dangling symbolic links are forbidden/u,
    );
  } finally {
    rmSync(danglingRoot, { force: true, recursive: true });
  }

  const { root: indirectEscapeRoot } = fixtureRepository();
  try {
    write(indirectEscapeRoot, "outside.js", "outside\n");
    const standaloneWeb = path.join(
      indirectEscapeRoot,
      "apps/web/.next/standalone/apps/web",
    );
    symlinkSync("../../../../../../outside.js", path.join(standaloneWeb, "indirect-target.js"));
    symlinkSync("indirect-target.js", path.join(standaloneWeb, "indirect-link.js"));
    assert.throws(
      () => computePublicBuildBinding(indirectEscapeRoot),
      /symbolic links are forbidden/u,
    );
  } finally {
    rmSync(indirectEscapeRoot, { force: true, recursive: true });
  }

  const { root: specialTargetRoot } = fixtureRepository();
  try {
    const standaloneWeb = path.join(
      specialTargetRoot,
      "apps/web/.next/standalone/apps/web",
    );
    const fifo = path.join(standaloneWeb, "z-special-target");
    const created = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    symlinkSync("z-special-target", path.join(standaloneWeb, "a-special-target-link"));
    assert.throws(
      () => computePublicBuildBinding(specialTargetRoot),
      /unsupported public build symbolic link target/u,
    );
  } finally {
    rmSync(specialTargetRoot, { force: true, recursive: true });
  }
});

test("source symlinks are rejected instead of binding only their target text", () => {
  const { root } = fixtureRepository();
  try {
    symlinkSync(
      path.join(root, "packages/domain/src/index.ts"),
      path.join(root, "apps/web/app/domain-link.ts"),
    );
    assert.throws(
      () => computePublicBuildBinding(root),
      /symbolic links are not permitted in public build inputs/u,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("every production dotenv candidate is rejected case-insensitively in source and standalone", () => {
  for (const name of [
    ".env",
    ".ENV.LOCAL",
    ".Env.Production",
    ".eNv.PrOdUcTiOn.LoCaL",
  ]) {
    for (const directory of [
      ".",
      "apps/web",
      "apps/web/.next/standalone",
      "apps/web/.next/standalone/apps/web",
    ]) {
      const { root } = fixtureRepository();
      try {
        write(root, path.join(directory, name), "KASSAL_API_KEY=must-not-load\n");
        assert.throws(
          () => computePublicBuildBinding(root),
          /production dotenv files are forbidden/u,
        );
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    }
  }

  const { root } = fixtureRepository();
  try {
    assert.doesNotThrow(() => computePublicBuildBinding(root));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("the supported CLI cannot relabel an existing artifact without rebuilding", () => {
  const script = path.resolve("scripts/e2e/public-build-binding.mjs");
  const result = spawnSync(process.execPath, [script, "write"], {
    cwd: path.resolve("."),
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /build\|verify/u);
});

test("the build transaction cleans output and gives Next only the explicit environment", () => {
  const { root } = fixtureRepository();
  const nextCli = "apps/web/node_modules/next/dist/bin/next";
  const fakeNext = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const expected = [
  "APP_COMMIT_SHA", "CI", "HANDLEPLAN_PUBLIC_BUILD_SOURCE_DIGEST", "HOME",
  "LANG", "LC_ALL", "NEXT_PUBLIC_HANDLEPLAN_BUILD_ID",
  "NEXT_TELEMETRY_DISABLED", "NODE_ENV", "PATH",
  "TMPDIR", "TZ",
  "__CF_USER_TEXT_ENCODING",
];
if (JSON.stringify(Object.keys(process.env).sort()) !== JSON.stringify(expected)) {
  process.stderr.write("unexpected fake Next environment: " + JSON.stringify(Object.keys(process.env).sort()) + "\n");
  process.exit(81);
}
for (const forbidden of ["DATABASE_URL", "KASSAL_API_KEY", "NEXT_PUBLIC_POISON", "NODE_OPTIONS"]) {
  if (process.env[forbidden] !== undefined) process.exit(82);
}
const buildId = "hpv2-" + process.env.HANDLEPLAN_PUBLIC_BUILD_SOURCE_DIGEST;
const nextRoot = path.join(process.cwd(), ".next");
const standaloneWeb = path.join(nextRoot, "standalone", "apps", "web");
fs.mkdirSync(path.join(nextRoot, "static", buildId), { recursive: true });
fs.mkdirSync(path.join(standaloneWeb, ".next"), { recursive: true });
fs.writeFileSync(path.join(nextRoot, "BUILD_ID"), buildId);
fs.writeFileSync(path.join(nextRoot, "static", buildId, "_buildManifest.js"), "manifest\n");
fs.writeFileSync(path.join(standaloneWeb, ".next", "BUILD_ID"), buildId);
fs.writeFileSync(path.join(standaloneWeb, "server.js"), "server\n");
fs.writeFileSync(path.join(standaloneWeb, "package.json"), "{}\n");
fs.symlinkSync("missing-generated-dependency", path.join(standaloneWeb, "dangling-generated-link"));
`;
  const parentValues = new Map();
  for (const [name, value] of Object.entries({
    APP_COMMIT_SHA: "a".repeat(40),
    DATABASE_URL: "postgresql://parent-poison",
    KASSAL_API_KEY: "parent-poison",
    NEXT_PUBLIC_POISON: "parent-poison",
    NODE_OPTIONS: "--no-warnings",
  })) {
    parentValues.set(name, process.env[name]);
    process.env[name] = value;
  }
  try {
    write(root, nextCli, fakeNext);
    write(root, "apps/web/.next/stale-output.txt", "must be removed\n");
    const unrelatedDanglingLink = path.join(root, "unrelated", "dangling-link");
    mkdirSync(path.dirname(unrelatedDanglingLink), { recursive: true });
    symlinkSync("missing-unrelated-target", unrelatedDanglingLink);
    const sealed = buildAndSealPublicWeb(root);
    assert.deepEqual(assertPublicBuildBinding(root), sealed);
    assert.equal(sealed.contractVersion, 2);
    assert.equal(existsSync(path.join(root, "apps/web/.next/stale-output.txt")), false);
    assert.throws(
      () => lstatSync(path.join(
        root,
        "apps/web/.next/standalone/apps/web/dangling-generated-link",
      )),
      (error) => error !== null && typeof error === "object" && error.code === "ENOENT",
    );
    assert.equal(lstatSync(unrelatedDanglingLink).isSymbolicLink(), true);
  } finally {
    for (const [name, value] of parentValues) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { force: true, recursive: true });
  }
});
