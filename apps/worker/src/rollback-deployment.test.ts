import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const rollbackScript = fileURLToPath(
  new URL("../../../deploy/rollback-on-vps.sh", import.meta.url),
);
const deployScript = fileURLToPath(
  new URL("../../../deploy/deploy-on-vps.sh", import.meta.url),
);
const currentImageId = `sha256:${"a".repeat(64)}`;
const targetImageId = `sha256:${"b".repeat(64)}`;

function git(argumentsList: string[], cwd?: string): string {
  const result = spawnSync("git", argumentsList, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${argumentsList.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "handleplan-explicit-rollback-"));
  const appRoot = join(root, "app");
  const source = join(appRoot, "source");
  const remote = join(root, "origin.git");
  const bin = join(root, "bin");
  const runtime = join(root, "runtime");
  const release = join(appRoot, "operations", "releases", "current-controls");
  await Promise.all([
    mkdir(join(appRoot, "shared"), { recursive: true }),
    mkdir(join(appRoot, "state", "verified-images"), { recursive: true }),
    mkdir(join(release, "deploy"), { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(runtime, { recursive: true }),
    mkdir(source, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(appRoot, "shared", "production.env"), "fixture=true\n"),
    writeFile(join(release, "deploy", "compose.production.yml"), "services: {}\n"),
    symlink("releases/current-controls", join(appRoot, "operations", "current")),
  ]);

  git(["init", "--bare", remote]);
  git(["init", "--initial-branch=main"], source);
  git(["config", "user.email", "rollback-fixture@invalid.example"], source);
  git(["config", "user.name", "Rollback Fixture"], source);
  await writeFile(join(source, "proof.txt"), "target\n");
  git(["add", "proof.txt"], source);
  git(["-c", "commit.gpgsign=false", "commit", "-m", "target"], source);
  const targetRevision = git(["rev-parse", "HEAD"], source);
  await writeFile(join(source, "proof.txt"), "current\n");
  git(["add", "proof.txt"], source);
  git(["-c", "commit.gpgsign=false", "commit", "-m", "current"], source);
  const currentRevision = git(["rev-parse", "HEAD"], source);
  git(["remote", "add", "origin", remote], source);
  git(["push", "--set-upstream", "origin", "main"], source);

  await Promise.all([
    writeFile(
      join(appRoot, "state", "current-deployment"),
      `v1 ${currentRevision} current\n`,
      { mode: 0o600 },
    ),
    writeFile(join(appRoot, "state", "current-revision"), `${currentRevision}\n`, {
      mode: 0o600,
    }),
    writeFile(join(appRoot, "state", "current-image-id"), `${currentImageId}\n`, {
      mode: 0o600,
    }),
    writeFile(
      join(appRoot, "state", "deployment-high-water"),
      `${currentRevision}\n`,
      { mode: 0o600 },
    ),
    writeFile(
      join(appRoot, "state", "verified-images", currentRevision),
      `v1 ${currentRevision} ${currentImageId}\n`,
      { mode: 0o600 },
    ),
    writeFile(
      join(appRoot, "state", "verified-images", targetRevision),
      `v1 ${targetRevision} ${targetImageId}\n`,
      { mode: 0o600 },
    ),
  ]);

  const docker = join(bin, "docker");
  await writeFile(docker, [
    `#!${process.execPath}`,
    'import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    "const args = process.argv.slice(2);",
    "appendFileSync(process.env.FAKE_DOCKER_LOG, `${process.env.APP_COMMIT_SHA ?? '-'}|${process.env.HANDLEPLAN_IMAGE ?? '-'}|${args.join(' ')}\\n`);",
    "const imageRevision = (id) => id === process.env.FAKE_CURRENT_IMAGE_ID ? process.env.FAKE_CURRENT_REVISION : id === process.env.FAKE_TARGET_IMAGE_ID ? process.env.FAKE_TARGET_REVISION : '';",
    "if (args[0] === 'image' && args[1] === 'inspect') {",
    "  const image = args.at(-1); const format = args[3];",
    "  if (!imageRevision(image)) process.exit(1);",
    "  process.stdout.write(format === '{{.Id}}' ? `${image}\\n` : `${imageRevision(image)}\\n`);",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'inspect') {",
    "  const service = args.at(-1).replace(/^fixture-/, '');",
    "  const state = JSON.parse(readFileSync(join(process.env.FAKE_RUNTIME, service), 'utf8'));",
    "  const format = args[2];",
    "  const value = format === '{{.State.Status}}' ? 'running' : format === '{{.RestartCount}}' ? '0' : format.includes('.State.Health') ? 'healthy' : format === '{{.Image}}' ? state.image : state.revision;",
    "  process.stdout.write(`${value}\\n`); process.exit(0);",
    "}",
    "if (args[0] !== 'compose') process.exit(1);",
    "const commandIndex = args.findIndex((value) => ['config', 'stop', 'rm', 'ps', 'up', 'exec'].includes(value));",
    "const command = args[commandIndex]; const tail = args.slice(commandIndex + 1);",
    "if (command === 'config') process.exit(0);",
    "if (command === 'stop' || command === 'rm') { rmSync(join(process.env.FAKE_RUNTIME, tail.at(-1)), { force: true }); process.exit(0); }",
    "if (command === 'ps') { const service = tail.at(-1); if (existsSync(join(process.env.FAKE_RUNTIME, service))) process.stdout.write(`fixture-${service}\\n`); process.exit(0); }",
    "if (command === 'up') {",
    "  if (process.env.FAKE_FAIL_TARGET_UP === 'true' && process.env.APP_COMMIT_SHA === process.env.FAKE_TARGET_REVISION) process.exit(1);",
    "  for (const service of ['app', 'review', 'operations', 'worker']) writeFileSync(join(process.env.FAKE_RUNTIME, service), JSON.stringify({ image: process.env.HANDLEPLAN_IMAGE, revision: process.env.APP_COMMIT_SHA }));",
    "  process.exit(0);",
    "}",
    "if (command === 'exec') { process.stdout.write(JSON.stringify({ ready: true, revision: process.env.APP_COMMIT_SHA })); process.exit(0); }",
    "process.exit(1);",
    "",
  ].join("\n"), { mode: 0o700 });
  await chmod(docker, 0o700);

  const curl = join(bin, "curl");
  await writeFile(curl, [
    `#!${process.execPath}`,
    'import { readFileSync } from "node:fs";',
    'import { join } from "node:path";',
    "const state = JSON.parse(readFileSync(join(process.env.FAKE_RUNTIME, 'app'), 'utf8'));",
    "process.stdout.write(JSON.stringify({ commit: state.revision }));",
    "",
  ].join("\n"), { mode: 0o700 });
  await chmod(curl, 0o700);

  const environment = {
    ...process.env,
    FAKE_CURRENT_IMAGE_ID: currentImageId,
    FAKE_CURRENT_REVISION: currentRevision,
    FAKE_DOCKER_LOG: join(root, "docker.log"),
    FAKE_RUNTIME: runtime,
    FAKE_TARGET_IMAGE_ID: targetImageId,
    FAKE_TARGET_REVISION: targetRevision,
    HANDLEPLAN_APP_ROOT: appRoot,
    HANDLEPLAN_REPOSITORY_URL: remote,
    PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  };
  for (const service of ["app", "review", "operations", "worker"]) {
    await writeFile(
      join(runtime, service),
      JSON.stringify({ image: currentImageId, revision: currentRevision }),
    );
  }
  return { appRoot, currentRevision, environment, root, runtime, targetRevision };
}

describe("explicit post-commit rollback", () => {
  it("is digest-bound, migration-free, fail-closed, and high-water preserving", async () => {
    const [rollback, deploy] = await Promise.all([
      readFile(rollbackScript, "utf8"),
      readFile(deployScript, "utf8"),
    ]);
    expect(rollback).toContain('load_verified_deployment_image "$state_dir" "$target_revision"');
    expect(rollback).toContain("{{.Id}}");
    expect(rollback).toContain("org.opencontainers.image.revision");
    expect(rollback).toContain('test "$previous_revision" = "$expected_current_revision"');
    expect(rollback).toContain('"$target_revision" "$previous_revision"');
    expect(rollback).not.toContain("run --rm migrate");
    expect(rollback).toContain('restore_committed_runtime || true');
    expect(rollback).toContain('"$target_image_id" "$deployment_high_water_revision"');
    expect(deploy).toContain('"$deployment_high_water_revision" "$revision"');
    expect(deploy).toContain("record_immutable_deployment_state");
    expect(deploy).toContain('"$loaded_image_id" "$revision"');
    expect(deploy).toContain("activate_operations_release");
  });

  // These integration cases create and push a real two-commit Git fixture,
  // then exercise the complete four-runtime rollback shell flow. On a loaded
  // filesystem that intentionally exceeds Vitest's generic five-second unit ceiling.
  it("moves committed state backward without moving the normal-deploy high-water mark", async () => {
    const values = await fixture();
    try {
      const result = spawnSync(
        "sh",
        [rollbackScript, values.targetRevision, values.currentRevision],
        { encoding: "utf8", env: values.environment, timeout: 30_000 },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(await readFile(join(values.appRoot, "state", "current-deployment"), "utf8"))
        .toBe(`v1 ${values.targetRevision} current\n`);
      expect(await readFile(join(values.appRoot, "state", "current-image-id"), "utf8"))
        .toBe(`${targetImageId}\n`);
      expect(await readFile(join(values.appRoot, "state", "deployment-high-water"), "utf8"))
        .toBe(`${values.currentRevision}\n`);
      const log = await readFile(values.environment.FAKE_DOCKER_LOG, "utf8");
      expect(log).not.toContain("run --rm migrate");
      for (const service of ["app", "review", "operations", "worker"]) {
        expect(JSON.parse(await readFile(join(values.runtime, service), "utf8"))).toEqual({
          image: targetImageId,
          revision: values.targetRevision,
        });
      }
    } finally {
      await rm(values.root, { force: true, recursive: true });
    }
  }, 20_000);

  it("restores the committed immutable runtime when target startup fails", async () => {
    const values = await fixture();
    try {
      const result = spawnSync(
        "sh",
        [rollbackScript, values.targetRevision, values.currentRevision],
        {
          encoding: "utf8",
          env: { ...values.environment, FAKE_FAIL_TARGET_UP: "true" },
          timeout: 30_000,
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Rollback failed; restored the previously committed immutable runtime",
      );
      expect(await readFile(join(values.appRoot, "state", "current-deployment"), "utf8"))
        .toBe(`v1 ${values.currentRevision} current\n`);
      for (const service of ["app", "review", "operations", "worker"]) {
        expect(JSON.parse(await readFile(join(values.runtime, service), "utf8"))).toEqual({
          image: currentImageId,
          revision: values.currentRevision,
        });
      }
    } finally {
      await rm(values.root, { force: true, recursive: true });
    }
  }, 20_000);
});
