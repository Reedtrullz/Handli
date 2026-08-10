import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const helper = fileURLToPath(
  new URL("../../../deploy/deployment-state.sh", import.meta.url),
);
const createdDirectories: string[] = [];
const LEGACY_REVISION = "1111111111111111111111111111111111111111";
const CURRENT_REVISION = "2222222222222222222222222222222222222222";
const ROLLBACK_REVISION = "3333333333333333333333333333333333333333";
const CURRENT_IMAGE_ID = `sha256:${"a".repeat(64)}`;
const ROLLBACK_IMAGE_ID = `sha256:${"b".repeat(64)}`;

async function stateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "handleplan-deployment-state-"));
  createdDirectories.push(directory);
  return directory;
}

function runStateScript(directory: string, source: string, ...args: string[]) {
  return spawnSync(
    "sh",
    ["-c", `. "$1"; ${source}`, "deployment-state-test", helper, directory, ...args],
    { encoding: "utf8" },
  );
}

afterEach(async () => {
  await Promise.all(createdDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })));
});

describe("durable deployment compatibility state", () => {
  it("treats missing state and an old revision-only marker as legacy", async () => {
    const directory = await stateDirectory();
    const missing = runStateScript(
      directory,
      'load_deployment_state "$2"; printf "%s|%s" "$previous_revision" "$previous_compatibility_mode"',
    );
    expect(missing.status).toBe(0);
    expect(missing.stdout).toBe("|legacy");

    await writeFile(join(directory, "current-revision"), `${LEGACY_REVISION}\n`);
    const old = runStateScript(
      directory,
      'load_deployment_state "$2"; mode=$(deployment_compose_mode "$previous_compatibility_mode"); printf "%s|%s" "$previous_revision" "$mode"',
    );
    expect(old.status).toBe(0);
    expect(old.stdout).toBe(`${LEGACY_REVISION}|legacy`);
  });

  it("atomically records and reloads the revision with current compatibility", async () => {
    const directory = await stateDirectory();
    const recorded = runStateScript(
      directory,
      'record_deployment_state "$2" "$3" current',
      CURRENT_REVISION,
    );
    expect(recorded.status).toBe(0);
    expect(await readFile(join(directory, "current-deployment"), "utf8")).toBe(
      `v1 ${CURRENT_REVISION} current\n`,
    );
    expect(await readFile(join(directory, "current-revision"), "utf8")).toBe(
      `${CURRENT_REVISION}\n`,
    );

    const loaded = runStateScript(
      directory,
      'load_deployment_state "$2"; mode=$(deployment_compose_mode "$previous_compatibility_mode"); printf "%s|%s" "$previous_revision" "$mode"',
    );
    expect(loaded.status).toBe(0);
    expect(loaded.stdout).toBe(`${CURRENT_REVISION}|current`);
  });

  it("records immutable image bindings while preserving a monotonic high-water revision", async () => {
    const directory = await stateDirectory();
    const current = runStateScript(
      directory,
      'record_immutable_deployment_state "$2" "$3" current "$4" "$3"',
      CURRENT_REVISION,
      CURRENT_IMAGE_ID,
    );
    expect(current.status, current.stderr).toBe(0);
    expect(await readFile(join(directory, "current-deployment"), "utf8")).toBe(
      `v1 ${CURRENT_REVISION} current\n`,
    );
    expect(await readFile(join(directory, "current-image-id"), "utf8")).toBe(
      `${CURRENT_IMAGE_ID}\n`,
    );
    expect(await readFile(join(directory, "deployment-high-water"), "utf8")).toBe(
      `${CURRENT_REVISION}\n`,
    );

    const rollback = runStateScript(
      directory,
      'record_immutable_deployment_state "$2" "$3" current "$4" "$5"',
      ROLLBACK_REVISION,
      ROLLBACK_IMAGE_ID,
      CURRENT_REVISION,
    );
    expect(rollback.status, rollback.stderr).toBe(0);
    const loaded = runStateScript(
      directory,
      'load_deployment_state "$2"; printf "%s|%s|%s|%s" "$previous_revision" "$previous_compatibility_mode" "$previous_image_id" "$deployment_high_water_revision"',
    );
    expect(loaded.status, loaded.stderr).toBe(0);
    expect(loaded.stdout).toBe(
      `${ROLLBACK_REVISION}|current|${ROLLBACK_IMAGE_ID}|${CURRENT_REVISION}`,
    );
    const verified = runStateScript(
      directory,
      'load_verified_deployment_image "$2" "$3"',
      CURRENT_REVISION,
    );
    expect(verified.status, verified.stderr).toBe(0);
    expect(verified.stdout).toBe(`${CURRENT_IMAGE_ID}\n`);
  });

  it("fails closed on partial or conflicting immutable state", async () => {
    const directory = await stateDirectory();
    await writeFile(
      join(directory, "current-deployment"),
      `v1 ${CURRENT_REVISION} current\n`,
    );
    await writeFile(join(directory, "current-revision"), `${CURRENT_REVISION}\n`);
    await writeFile(join(directory, "current-image-id"), `${CURRENT_IMAGE_ID}\n`);
    const partial = runStateScript(directory, 'load_deployment_state "$2"');
    expect(partial.status).not.toBe(0);
    expect(partial.stderr).toContain("Invalid deployment state");

    await writeFile(join(directory, "deployment-high-water"), `${CURRENT_REVISION}\n`);
    const missingBinding = runStateScript(directory, 'load_deployment_state "$2"');
    expect(missingBinding.status).not.toBe(0);
    expect(missingBinding.stderr).toContain("Invalid deployment state");
  });

  it("never replaces an immutable revision-to-image binding", async () => {
    const directory = await stateDirectory();
    const first = runStateScript(
      directory,
      'record_verified_deployment_image "$2" "$3" "$4"',
      CURRENT_REVISION,
      CURRENT_IMAGE_ID,
    );
    expect(first.status, first.stderr).toBe(0);
    const conflict = runStateScript(
      directory,
      'record_verified_deployment_image "$2" "$3" "$4"',
      CURRENT_REVISION,
      ROLLBACK_IMAGE_ID,
    );
    expect(conflict.status).not.toBe(0);
    expect(conflict.stderr).toContain("Invalid deployment state");
    expect(await readFile(
      join(directory, "verified-images", CURRENT_REVISION),
      "utf8",
    )).toBe(`v1 ${CURRENT_REVISION} ${CURRENT_IMAGE_ID}\n`);
  });

  it.each([
    ["malformed manifest", `v2 ${CURRENT_REVISION} current\n`, `${CURRENT_REVISION}\n`],
    ["unknown mode", `v1 ${CURRENT_REVISION} automatic\n`, `${CURRENT_REVISION}\n`],
    ["mismatched compatibility marker", `v1 ${CURRENT_REVISION} current\n`, `${LEGACY_REVISION}\n`],
  ])("fails closed for %s", async (_label, manifest, marker) => {
    const directory = await stateDirectory();
    await writeFile(join(directory, "current-deployment"), manifest);
    await writeFile(join(directory, "current-revision"), marker);

    const result = runStateScript(directory, 'load_deployment_state "$2"');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid deployment state");
  });
});
