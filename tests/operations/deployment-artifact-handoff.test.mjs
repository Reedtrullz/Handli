import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const ciWorkflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
const deployWorkflow = readFileSync(
  join(root, ".github/workflows/deploy-preview.yml"),
  "utf8",
);
const deployScript = readFileSync(join(root, "deploy/deploy-on-vps.sh"), "utf8");
const revision = "a".repeat(40);
const imageId = `sha256:${"b".repeat(64)}`;

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function shell(path, source) {
  writeFileSync(path, source, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function createTar(archive, tree) {
  const result = spawnSync("tar", ["-cf", archive, "-C", tree, "."], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
}

function makeFixture() {
  const temp = mkdtempSync(join(tmpdir(), "handleplan-ci-image-"));
  const appRoot = join(temp, "app");
  const scriptDir = join(temp, "bundle");
  const artifactDir = join(scriptDir, "image");
  const sourceTree = join(temp, "source-tree");
  const imageTree = join(temp, "image-tree");
  const bin = join(temp, "bin");
  const log = join(temp, "commands.log");
  mkdirSync(join(appRoot, "shared"), { recursive: true });
  mkdirSync(artifactDir, { recursive: true });
  mkdirSync(join(sourceTree, "deploy"), { recursive: true });
  mkdirSync(imageTree, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(log, "");
  writeFileSync(join(appRoot, "shared/production.env"), [
    "REVIEW_ACCESS_AUDIENCE=review-audience-0123456789abcdef",
    "OPERATIONS_ACCESS_AUDIENCE=operations-audience-0123456789abcdef",
    "",
  ].join("\n"));
  writeFileSync(join(sourceTree, "Dockerfile"), "FROM scratch\n");
  writeFileSync(join(sourceTree, "deploy/compose.production.yml"), "services: {}\n");
  writeFileSync(join(sourceTree, "deploy/compose.rollback-legacy.yml"), "services: {}\n");
  writeFileSync(join(imageTree, "fixture"), "docker-archive-fixture\n");
  writeFileSync(join(artifactDir, "handleplan.provenance.json"), "{}\n");
  writeFileSync(join(artifactDir, "handleplan.spdx.json"), "{}\n");
  createTar(join(artifactDir, "handleplan-source.tar"), sourceTree);
  createTar(join(artifactDir, "handleplan-image.docker.tar"), imageTree);
  cpSync(join(root, "deploy/deploy-on-vps.sh"), join(scriptDir, "deploy-on-vps.sh"));
  cpSync(join(root, "deploy/deployment-state.sh"), join(scriptDir, "deployment-state.sh"));
  chmodSync(join(scriptDir, "deploy-on-vps.sh"), 0o700);

  shell(join(bin, "git"), `#!/bin/sh
set -eu
printf 'git %s\\n' "$*" >> "$MOCK_LOG"
case " $* " in
  *" clone "*)
    last=""
    for argument in "$@"; do last=$argument; done
    mkdir -p "$last/.git"
    ;;
  *" archive "*)
    output=""
    for argument in "$@"; do
      case "$argument" in --output=*) output=\${argument#--output=} ;; esac
    done
    test -n "$output"
    cp "$MOCK_SOURCE_ARCHIVE" "$output"
    ;;
  *" rev-parse "*) printf '%s\\n' "$REVISION" ;;
esac
`);
  shell(join(bin, "docker"), `#!/bin/sh
set -eu
printf 'docker %s\\n' "$*" >> "$MOCK_LOG"
if [ "$1" = compose ]; then exit 0; fi
if [ "$1" = image ] && [ "$2" = load ]; then exit 44; fi
exit 91
`);

  const imageArchive = join(artifactDir, "handleplan-image.docker.tar");
  const sourceArchive = join(artifactDir, "handleplan-source.tar");
  const provenance = join(artifactDir, "handleplan.provenance.json");
  const sbom = join(artifactDir, "handleplan.spdx.json");
  const manifest = [
    "format=handleplan-ci-image-bundle-v1",
    `revision=${revision}`,
    `image_reference=handleplan:${revision}`,
    `image_id=${imageId}`,
    `image_archive_sha256=${sha256(imageArchive)}`,
    `source_archive_sha256=${sha256(sourceArchive)}`,
    `provenance_sha256=${sha256(provenance)}`,
    `sbom_sha256=${sha256(sbom)}`,
    "ci_run_id=12345",
    "ci_run_attempt=2",
    "",
  ].join("\n");
  writeFileSync(join(artifactDir, "handleplan-image-bundle.v1"), manifest);

  return {
    appRoot,
    artifactDir,
    bin,
    log,
    run() {
      const manifestSha256 = sha256(
        join(artifactDir, "handleplan-image-bundle.v1"),
      );
      return spawnSync(
        join(scriptDir, "deploy-on-vps.sh"),
        [revision, "12345", "2", manifestSha256],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HANDLEPLAN_APP_ROOT: appRoot,
            MOCK_LOG: log,
            MOCK_SOURCE_ARCHIVE: join(artifactDir, "handleplan-source.tar"),
            PATH: `${bin}:${process.env.PATH}`,
            REVISION: revision,
          },
        },
      );
    },
    temp,
  };
}

test("CI uploads one exact revision/run-attempt image bundle", () => {
  assert.match(ciWorkflow, /docker build --build-arg APP_COMMIT_SHA="\$APP_COMMIT_SHA"/u);
  assert.match(ciWorkflow, /docker image save --output \.artifacts\/security\/handleplan-image\.docker\.tar/u);
  assert.match(ciWorkflow, /format=handleplan-ci-image-bundle-v1/u);
  assert.match(ciWorkflow, /image_id=\$image_id/u);
  assert.match(ciWorkflow, /ci_run_id=\$GITHUB_RUN_ID/u);
  assert.match(ciWorkflow, /ci_run_attempt=\$GITHUB_RUN_ATTEMPT/u);
  assert.match(
    ciWorkflow,
    /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/u,
  );
  assert.match(
    ciWorkflow,
    /name: handleplan-ci-image-\$\{\{ github\.sha \}\}-attempt-\$\{\{ github\.run_attempt \}\}/u,
  );
  assert.match(ciWorkflow, /fetch-depth: 2/u);
  assert.match(
    ciWorkflow,
    /Boot the exact previous application image against the expanded schema/u,
  );
  assert.match(
    ciWorkflow,
    /previous_revision=\$\(git rev-parse --verify "\$APP_COMMIT_SHA\^"\)/u,
  );
  assert.match(
    ciWorkflow,
    /handleplan_web:\$WEB_DATABASE_PASSWORD@127\.0\.0\.1:5432/u,
  );
  assert.match(ciWorkflow, /127\.0\.0\.1:3014\/api\/ready/u);
});

test("protected deploy downloads only the exact successful CI run artifact", () => {
  assert.doesNotMatch(deployWorkflow, /workflow_dispatch:/u);
  assert.match(deployWorkflow, /head_repository\.full_name == github\.repository/u);
  assert.match(deployWorkflow, /actions: read/u);
  assert.match(
    deployWorkflow,
    /actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093/u,
  );
  assert.match(deployWorkflow, /run-id: \$\{\{ env\.CI_RUN_ID \}\}/u);
  assert.match(deployWorkflow, /ci_run_id=\$CI_RUN_ID/u);
  assert.match(deployWorkflow, /ci_run_attempt=\$CI_RUN_ATTEMPT/u);
  assert.match(deployWorkflow, /sha256sum "\$image_archive"/u);
  assert.match(deployWorkflow, /docker image load --input "\$image_archive"/u);
  assert.match(deployWorkflow, /EXPECTED_IMAGE_ID/u);
  assert.match(deployWorkflow, /EXPECTED_BUNDLE_MANIFEST_SHA256/u);
  assert.doesNotMatch(deployWorkflow, /docker build/u);
});

test("VPS verifies bundle bytes before loading and never builds", () => {
  assert.doesNotMatch(deployScript, /docker build/u);
  const digestCheck = deployScript.indexOf('sha256sum "$image_archive"');
  const manifestDigestCheck = deployScript.indexOf('sha256sum "$bundle_manifest"');
  const imageLoad = deployScript.indexOf('docker image load --input "$image_archive"');
  const configDigestCheck = deployScript.indexOf(
    'test "$loaded_image_id" = "$expected_image_id"',
  );
  assert.ok(manifestDigestCheck > 0);
  assert.ok(digestCheck > manifestDigestCheck);
  assert.ok(imageLoad > digestCheck);
  assert.ok(configDigestCheck > imageLoad);
  assert.match(deployScript, /origin-main-source\.tar/u);
  assert.match(
    deployScript,
    /CI source archive is not the exact fetched origin\/main commit/u,
  );
  assert.match(deployScript, /review_image_id.*loaded_image_id/su);
  assert.match(deployScript, /operations_image_id.*loaded_image_id/su);
  assert.match(deployScript, /worker_image_id.*loaded_image_id/su);
  assert.match(deployScript, /app_image_id.*loaded_image_id/su);
});

test("VPS rejects a tampered archive before any Docker command", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.temp, { force: true, recursive: true }));
  writeFileSync(
    join(fixture.artifactDir, "handleplan-image.docker.tar"),
    "tampered-after-manifest\n",
  );
  const result = fixture.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /digest verification failed before image load/u);
  assert.equal(readFileSync(fixture.log, "utf8"), "");
});

test("VPS reaches docker load only after every bundle digest verifies", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.temp, { force: true, recursive: true }));
  const result = fixture.run();
  assert.equal(result.status, 44, result.stderr);
  const commands = readFileSync(fixture.log, "utf8");
  assert.match(commands, /git .*fetch --no-tags --prune origin/u);
  assert.match(commands, /docker compose .* config/u);
  assert.match(commands, /docker image load --input .*handleplan-image\.docker\.tar/u);
  assert.doesNotMatch(commands, /docker build/u);
});
