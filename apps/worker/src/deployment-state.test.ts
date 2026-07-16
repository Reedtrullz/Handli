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
