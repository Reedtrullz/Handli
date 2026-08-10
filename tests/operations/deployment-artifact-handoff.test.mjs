import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const ciWorkflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
const deployWorkflow = readFileSync(
  join(root, ".github/workflows/deploy-preview.yml"),
  "utf8",
);
const deployScript = readFileSync(join(root, "deploy/deploy-on-vps.sh"), "utf8");
const pendingResolverScript = readFileSync(
  join(root, "deploy/resolve-pending-deployment-on-vps.sh"),
  "utf8",
);
const pendingWatchdogScript = readFileSync(
  join(root, "deploy/watch-pending-deployment-on-vps.sh"),
  "utf8",
);
const bundlePrepareScript = readFileSync(
  join(root, "deploy/prepare-deployment-bundle-on-vps.sh"),
  "utf8",
);
const bundleCleanupScript = readFileSync(
  join(root, "deploy/cleanup-deployment-bundle-on-vps.sh"),
  "utf8",
);
const explicitRollbackScript = readFileSync(
  join(root, "deploy/rollback-on-vps.sh"),
  "utf8",
);
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
const dockerignore = readFileSync(join(root, ".dockerignore"), "utf8");
const imageVerifier = readFileSync(
  join(root, "scripts/operations/verify-production-image.mjs"),
  "utf8",
);
const imageBrowserLauncher = readFileSync(
  join(root, "tests/image-e2e/start-production-image.mjs"),
  "utf8",
);
const revision = "a".repeat(40);
const imageId = `sha256:${"b".repeat(64)}`;
const previousRevision = "d".repeat(40);
const previousImageId = `sha256:${"e".repeat(64)}`;
const pendingDeploymentToken = "f".repeat(64);
const migration = "026_official_offer_publication_runtime.sql";
const publicBuildId = `hpv2-${"c".repeat(64)}`;

function externalDeploymentProbeSource() {
  const marker = "node --input-type=module <<'NODE'";
  const markerIndex = deployWorkflow.indexOf(marker);
  assert.ok(markerIndex > 0);
  const sourceStart = deployWorkflow.indexOf("\n", markerIndex) + 1;
  const sourceEnd = deployWorkflow.indexOf("\n          NODE", sourceStart);
  assert.ok(sourceEnd > sourceStart);
  const source = deployWorkflow.slice(sourceStart, sourceEnd);
  return source.replace(/^ {10}/gmu, "");
}

function runExternalDeploymentProbe({
  healthRevision = revision,
  oversizedShell = false,
  readinessStatus = 200,
  rootLocation = "/planlegg",
  rootStatus = 307,
  shellBuildId = publicBuildId,
  shellContentType = "text/html; charset=utf-8",
  shellMarkerPlacement = "head",
} = {}) {
  const prelude = `
  const fixtureExpectedMigration = ${JSON.stringify(migration)};
  const fixtureHealthRevision = ${JSON.stringify(healthRevision)};
  const fixtureOversizedShell = ${JSON.stringify(oversizedShell)};
  const fixtureRootLocation = ${JSON.stringify(rootLocation)};
  const fixtureShellBuildId = ${JSON.stringify(shellBuildId)};
  const fixtureShellContentType = ${JSON.stringify(shellContentType)};
  const fixtureShellMarkerPlacement = ${JSON.stringify(shellMarkerPlacement)};
  function fixtureShellHtml() {
    const marker = '<meta content="' + fixtureShellBuildId
      + '" name="handleplan-public-build-id">';
    if (fixtureShellMarkerPlacement === "comment") {
      return '<!doctype html><html lang="nb"><head><title>Handleplan</title><!--'
        + marker + '--></head><body>Handleplan</body></html>';
    }
    if (fixtureShellMarkerPlacement === "body") {
      return '<!doctype html><html lang="nb"><head><title>Handleplan</title></head><body>'
        + marker + 'Handleplan</body></html>';
    }
    if (fixtureShellMarkerPlacement === "script") {
      return '<!doctype html><html lang="nb"><head><title>Handleplan</title><script>'
        + 'globalThis.decoy = ' + JSON.stringify(marker)
        + '</script></head><body>Handleplan</body></html>';
    }
    if (fixtureShellMarkerPlacement === "duplicate") {
      return '<!doctype html><html lang="nb"><head><title>Handleplan</title>'
        + marker + marker + '</head><body>Handleplan</body></html>';
    }
    return '<!doctype html><html lang="nb"><head><title>Handleplan</title>'
      + marker + '</head><body>Handleplan</body></html>';
  }
  globalThis.fetch = async (url, init) => {
    if (
      init?.method !== "GET"
      || init?.redirect !== "manual"
      || init?.headers?.accept !== (url.pathname.startsWith("/api/")
        ? "application/json"
        : "text/html")
      || init?.headers?.["cf-access-client-id"] !== "test-access-id"
      || init?.headers?.["cf-access-client-secret"] !== "test-access-secret"
    ) throw new Error("unsafe external probe request");
    if (url.pathname === "/") {
      return new Response("root", {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "location": fixtureRootLocation,
        },
        status: ${rootStatus},
      });
    }
    if (url.pathname === "/planlegg") {
      return new Response(
        fixtureOversizedShell
          ? "x".repeat(513 * 1024)
          : fixtureShellHtml(),
        { headers: { "content-type": fixtureShellContentType }, status: 200 },
      );
    }
    if (url.pathname === "/api/health") {
      return Response.json(
        { commit: fixtureHealthRevision, status: "ok", version: 1 },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (url.pathname === "/api/ready") {
      return Response.json(
        {
          database: { requiredMigration: fixtureExpectedMigration, status: "ok" },
          status: "ok",
          version: 1,
        },
        { headers: { "cache-control": "no-store" }, status: ${readinessStatus} },
      );
    }
    throw new Error("unexpected external path");
  };
  `;
  return spawnSync(process.execPath, ["--input-type=module"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      HANDLEPLAN_MONITOR_BASE_URL: "https://handle.reidar.tech/",
      HANDLEPLAN_MONITOR_CF_ACCESS_CLIENT_ID: "test-access-id",
      HANDLEPLAN_MONITOR_CF_ACCESS_CLIENT_SECRET: "test-access-secret",
      HANDLEPLAN_MONITOR_EXPECTED_MIGRATION: migration,
      HANDLEPLAN_MONITOR_EXPECTED_PUBLIC_BUILD_ID: publicBuildId,
      HANDLEPLAN_MONITOR_EXPECTED_REVISION: revision,
    },
    input: `${prelude}\n${externalDeploymentProbeSource()}\n`,
  });
}

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

function dockerignoreMatcher(pattern) {
  const directoryOnly = pattern.endsWith("/");
  const normalized = pattern.replace(/^\//u, "").replace(/\/$/u, "");
  const hasSlash = normalized.includes("/");
  let expression = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*" && normalized[index + 1] === "*") {
      if (normalized[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    }
  }
  return new RegExp(
    `^${hasSlash ? "" : "(?:.*/)?"}${expression}${directoryOnly ? "/.*" : "(?:/.*)?"}$`,
    "u",
  );
}

function ignoredByDockerContext(relativePath) {
  let ignored = false;
  for (const rawLine of dockerignore.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    const pattern = negated ? line.slice(1) : line;
    if (dockerignoreMatcher(pattern).test(relativePath)) ignored = !negated;
  }
  return ignored;
}

function makeFixture() {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "handleplan-ci-image-")));
  const appRoot = join(temp, "app");
  const bundleRoot = join(appRoot, "deploy-bundles");
  const scriptDir = join(bundleRoot, revision, "12345-2", "98765-1");
  const artifactDir = join(scriptDir, "image");
  const sourceTree = join(temp, "source-tree");
  const imageTree = join(temp, "image-tree");
  const bin = join(temp, "bin");
  const log = join(temp, "commands.log");
  mkdirSync(join(appRoot, "shared"), { recursive: true });
  mkdirSync(join(appRoot, "state", "verified-images"), { recursive: true });
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
  writeFileSync(
    join(appRoot, "state/current-deployment"),
    `v1 ${previousRevision} current\n`,
  );
  writeFileSync(join(appRoot, "state/current-revision"), `${previousRevision}\n`);
  writeFileSync(join(appRoot, "state/current-image-id"), `${previousImageId}\n`);
  writeFileSync(join(appRoot, "state/deployment-high-water"), `${previousRevision}\n`);
  writeFileSync(
    join(appRoot, "state", "verified-images", previousRevision),
    `v1 ${previousRevision} ${previousImageId}\n`,
  );
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
  writeFileSync(
    join(scriptDir, ".lease.v1"),
    `v1 ${revision} 12345 2 98765 1 ${Math.floor(Date.now() / 1000) + 10_800}\n`,
    { mode: 0o600 },
  );

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
  *" rev-parse "*)
    case "$*" in
      *"$PREVIOUS_REVISION"*) printf '%s\\n' "$PREVIOUS_REVISION" ;;
      *) printf '%s\\n' "$REVISION" ;;
    esac
    ;;
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
    "format=handleplan-ci-image-bundle-v3",
    `revision=${revision}`,
    `image_reference=handleplan:${revision}`,
    `image_id=${imageId}`,
    "platform=linux/amd64",
    `runtime_source_digest_sha256=${"c".repeat(64)}`,
    "runtime_source_file_count=217",
    `runtime_shipment_digest_sha256=${"d".repeat(64)}`,
    "runtime_shipment_entry_count=43",
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
    bundleRoot,
    log,
    run() {
      const manifestSha256 = sha256(
        join(artifactDir, "handleplan-image-bundle.v1"),
      );
      return spawnSync(
        join(scriptDir, "deploy-on-vps.sh"),
        [
          revision,
          "12345",
          "2",
          manifestSha256,
          pendingDeploymentToken,
          previousRevision,
          previousImageId,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HANDLEPLAN_APP_ROOT: appRoot,
            MOCK_LOG: log,
            MOCK_SOURCE_ARCHIVE: join(artifactDir, "handleplan-source.tar"),
            PATH: `${bin}:${process.env.PATH}`,
            PREVIOUS_REVISION: previousRevision,
            REVISION: revision,
          },
        },
      );
    },
    scriptDir,
    temp,
  };
}

function makePendingResolverFixture({
  blockReject = false,
  configFails = false,
  currentImageId = imageId,
  currentRevision = revision,
  deadline = Math.floor(Date.now() / 1000) + 300,
  highWaterRevision = revision,
  token = pendingDeploymentToken,
} = {}) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "handleplan-pending-deploy-")));
  const appRoot = join(temp, "app");
  const state = join(appRoot, "state");
  const controls = join(temp, "controls");
  const operationsRoot = join(appRoot, "operations");
  const operationsRelease = join(operationsRoot, "releases", revision);
  const operations = join(operationsRelease, "deploy");
  const bin = join(temp, "bin");
  const runtime = join(temp, "runtime");
  const commandLog = join(temp, "commands.log");
  const rejectMarker = join(temp, "reject.locked");
  const rejectRelease = join(temp, "reject.release");
  mkdirSync(join(state, "verified-images"), { recursive: true });
  mkdirSync(join(state, "pending-watchdogs"));
  mkdirSync(join(appRoot, "shared"), { recursive: true });
  mkdirSync(controls, { recursive: true });
  mkdirSync(operations, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(runtime, { recursive: true });
  writeFileSync(commandLog, "");
  writeFileSync(join(appRoot, "shared", "production.env"), "FIXTURE=1\n");
  writeFileSync(join(operationsRelease, "release.v1"), `v1 ${revision} fixture\n`);
  symlinkSync(`releases/${revision}`, join(operationsRoot, "current"));
  for (const [stateRevision, stateImageId] of [
    [revision, imageId],
    [previousRevision, previousImageId],
  ]) {
    writeFileSync(
      join(state, "verified-images", stateRevision),
      `v1 ${stateRevision} ${stateImageId}\n`,
    );
  }
  if (![revision, previousRevision].includes(currentRevision)) {
    writeFileSync(
      join(state, "verified-images", currentRevision),
      `v1 ${currentRevision} ${currentImageId}\n`,
    );
  }
  writeFileSync(join(state, "current-deployment"), `v1 ${currentRevision} current\n`);
  writeFileSync(join(state, "current-revision"), `${currentRevision}\n`);
  writeFileSync(join(state, "current-image-id"), `${currentImageId}\n`);
  writeFileSync(join(state, "deployment-high-water"), `${highWaterRevision}\n`);
  writeFileSync(
    join(state, "pending-deployment"),
    `v1 ${revision} ${imageId} ${previousRevision} ${previousImageId} ${deadline} ${token}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(state, "pending-watchdogs", token),
    `v1 ${revision} ${imageId} ${previousRevision} ${previousImageId} ${deadline} ${token}\n`,
    { mode: 0o600 },
  );

  for (const directory of [controls, operations]) {
    cpSync(join(root, "deploy/deployment-state.sh"), join(directory, "deployment-state.sh"));
    cpSync(
      join(root, "deploy/resolve-pending-deployment-on-vps.sh"),
      join(directory, "resolve-pending-deployment-on-vps.sh"),
    );
    cpSync(
      join(root, "deploy/watch-pending-deployment-on-vps.sh"),
      join(directory, "watch-pending-deployment-on-vps.sh"),
    );
    chmodSync(join(directory, "resolve-pending-deployment-on-vps.sh"), 0o755);
    chmodSync(join(directory, "watch-pending-deployment-on-vps.sh"), 0o755);
  }
  cpSync(
    join(root, "deploy/compose.production.yml"),
    join(operations, "compose.production.yml"),
  );
  for (const service of ["app", "review", "operations", "worker"]) {
    writeFileSync(join(runtime, service), `${revision} ${imageId}\n`);
  }
  shell(join(bin, "docker"), `#!/bin/sh
set -eu
printf 'docker %s\\n' "$*" >> "$MOCK_COMMAND_LOG"
container_for_service() {
  case "$1" in
    app) printf '%064d\\n' 1 ;;
    review) printf '%064d\\n' 2 ;;
    operations) printf '%064d\\n' 3 ;;
    worker) printf '%064d\\n' 4 ;;
    *) return 1 ;;
  esac
}
service_for_container() {
  case "$1" in
    0000000000000000000000000000000000000000000000000000000000000001) printf 'app\\n' ;;
    0000000000000000000000000000000000000000000000000000000000000002) printf 'review\\n' ;;
    0000000000000000000000000000000000000000000000000000000000000003) printf 'operations\\n' ;;
    0000000000000000000000000000000000000000000000000000000000000004) printf 'worker\\n' ;;
    *) return 1 ;;
  esac
}
if [ "$1" = image ] && [ "$2" = inspect ]; then
  format=$4
  inspected_image=$5
  case "$format" in
    '{{.Id}}') printf '%s\\n' "$inspected_image" ;;
    *org.opencontainers.image.revision*)
      if [ "$inspected_image" = "$CANDIDATE_IMAGE_ID" ]; then
        printf '%s\\n' "$CANDIDATE_REVISION"
      elif [ "$inspected_image" = "$PREVIOUS_IMAGE_ID" ]; then
        printf '%s\\n' "$PREVIOUS_REVISION"
      else
        exit 1
      fi
      ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [ "$1" = ps ]; then
  service=""
  for argument in "$@"; do
    case "$argument" in
      label=com.docker.compose.service=*) service=\${argument##*=} ;;
    esac
  done
  if [ -n "$service" ] && [ -f "$MOCK_RUNTIME/$service" ]; then
    container_for_service "$service"
  fi
  exit 0
fi
if [ "$1" = inspect ]; then
  format=$3
  container=$4
  service=$(service_for_container "$container")
  read -r runtime_revision runtime_image < "$MOCK_RUNTIME/$service"
  case "$format" in
    *com.docker.compose.project*) printf 'handleplan\\n' ;;
    *com.docker.compose.service*) printf '%s\\n' "$service" ;;
    '{{.Image}}') printf '%s\\n' "$runtime_image" ;;
    *org.opencontainers.image.revision*) printf '%s\\n' "$runtime_revision" ;;
    '{{.State.Status}}') printf 'running\\n' ;;
    '{{.RestartCount}}') printf '0\\n' ;;
    *State.Health*) printf 'healthy\\n' ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [ "$1" = stop ]; then exit 0; fi
if [ "$1" = rm ]; then
  container=""
  for argument in "$@"; do container=$argument; done
  service=$(service_for_container "$container")
  rm -f "$MOCK_RUNTIME/$service"
  exit 0
fi
if [ "$1" = compose ]; then
  compose_action=""
  compose_service=""
  for argument in "$@"; do
    case "$argument" in
      config|up|ps|exec) compose_action=$argument ;;
      app|review|operations|worker) compose_service=$argument ;;
    esac
  done
  case "$compose_action" in
    config)
      if [ "$MOCK_BLOCK_REJECT" = 1 ]; then
        : > "$MOCK_REJECT_MARKER"
        while [ ! -e "$MOCK_REJECT_RELEASE" ]; do sleep 0.05; done
      fi
      if [ "$MOCK_CONFIG_FAILS" = 1 ]; then exit 42; fi
      ;;
    up)
      for service in app review operations worker; do
        printf '%s %s\\n' "$APP_COMMIT_SHA" "$HANDLEPLAN_IMAGE" \
          > "$MOCK_RUNTIME/$service"
      done
      ;;
    ps)
      [ -f "$MOCK_RUNTIME/$compose_service" ] \
        && container_for_service "$compose_service"
      ;;
    exec)
      printf '{"ready":true,"revision":"%s"}\\n' "$PREVIOUS_REVISION"
      ;;
    *) exit 1 ;;
  esac
  exit 0
fi
exit 1
`);
  shell(join(bin, "curl"), `#!/bin/sh
set -eu
read -r runtime_revision runtime_image < "$MOCK_RUNTIME/app"
printf '{"commit":"%s","status":"ok"}\\n' "$runtime_revision"
`);

  const env = {
    ...process.env,
    CANDIDATE_IMAGE_ID: imageId,
    CANDIDATE_REVISION: revision,
    EXPECTED_CANDIDATE_REVISION: revision,
    EXPECTED_PREVIOUS_IMAGE_ID: previousImageId,
    EXPECTED_PREVIOUS_REVISION: previousRevision,
    HANDLEPLAN_APP_ROOT: appRoot,
    MOCK_BLOCK_REJECT: blockReject ? "1" : "0",
    MOCK_COMMAND_LOG: commandLog,
    MOCK_CONFIG_FAILS: configFails ? "1" : "0",
    MOCK_REJECT_MARKER: rejectMarker,
    MOCK_REJECT_RELEASE: rejectRelease,
    MOCK_RUNTIME: runtime,
    PATH: `${bin}:${process.env.PATH}`,
    PREVIOUS_IMAGE_ID: previousImageId,
    PREVIOUS_REVISION: previousRevision,
  };
  return {
    appRoot,
    bin,
    commandLog,
    controls,
    deadline,
    env,
    operations,
    rejectMarker,
    rejectRelease,
    run(action, candidateToken = token, expectedDeadline = deadline) {
      return spawnSync(
        join(controls, "resolve-pending-deployment-on-vps.sh"),
        [
          action,
          revision,
          imageId,
          candidateToken,
          previousRevision,
          previousImageId,
          String(expectedDeadline),
        ],
        { encoding: "utf8", env },
      );
    },
    runtime,
    state,
    temp,
    token,
  };
}

function makeExplicitRollbackPendingFixture({ brokenSymlink = false } = {}) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "handleplan-explicit-rollback-")));
  const appRoot = join(temp, "app");
  const state = join(appRoot, "state");
  const operationsRelease = join(appRoot, "operations", "releases", revision);
  const operations = join(operationsRelease, "deploy");
  const log = join(temp, "commands.log");
  const bin = join(temp, "bin");
  mkdirSync(join(appRoot, "shared"), { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(operations, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(appRoot, "shared", "production.env"), "FIXTURE=1\n");
  writeFileSync(join(operations, "compose.production.yml"), "services: {}\n");
  symlinkSync(`releases/${revision}`, join(appRoot, "operations", "current"));
  writeFileSync(log, "");
  if (brokenSymlink) {
    symlinkSync(join(temp, "missing-pending-target"), join(state, "pending-deployment"));
  } else {
    writeFileSync(join(state, "pending-deployment"), "pending fixture\n");
  }
  for (const command of ["curl", "docker", "git"]) {
    shell(join(bin, command), `#!/bin/sh
printf '${command} %s\\n' "$*" >> "$MOCK_COMMAND_LOG"
exit 97
`);
  }
  return {
    appRoot,
    log,
    run: () => spawnSync(
      "sh",
      [join(root, "deploy/rollback-on-vps.sh"), previousRevision, revision],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HANDLEPLAN_APP_ROOT: appRoot,
          MOCK_COMMAND_LOG: log,
          PATH: `${bin}:${process.env.PATH}`,
        },
      },
    ),
    state,
    temp,
  };
}

test("CI uploads one exact revision/run-attempt image bundle", () => {
  assert.match(
    ciWorkflow,
    /docker build --platform=linux\/amd64[\s\\]*--build-arg APP_COMMIT_SHA="\$APP_COMMIT_SHA"/u,
  );
  assert.match(ciWorkflow, /HANDLEPLAN_IMAGE: handleplan:\$\{\{ github\.sha \}\}/u);
  assert.match(ciWorkflow, /HANDLEPLAN_MIGRATION_IMAGE: handleplan:\$\{\{ github\.sha \}\}/u);
  assert.doesNotMatch(ciWorkflow, /HANDLEPLAN_(?:MIGRATION_)?IMAGE: handleplan:ci(?:\s|$)/u);
  assert.match(ciWorkflow, /test "\$HANDLEPLAN_IMAGE" = "handleplan:\$APP_COMMIT_SHA"/u);
  assert.match(ciWorkflow, /docker image save --output \.artifacts\/security\/handleplan-image\.docker\.tar/u);
  assert.match(ciWorkflow, /docker image rm "\$HANDLEPLAN_IMAGE"/u);
  assert.match(
    ciWorkflow,
    /docker image load --input \.artifacts\/security\/handleplan-image\.docker\.tar/u,
  );
  assert.match(
    ciWorkflow,
    /node scripts\/operations\/verify-production-image\.mjs[\s\S]*--image-reference "\$HANDLEPLAN_IMAGE"[\s\S]*--expected-image-id "\$image_id"[\s\S]*--archive \.artifacts\/security\/handleplan-image\.docker\.tar/u,
  );
  assert.match(ciWorkflow, /id: validate-deployment-assets/u);
  assert.match(ciWorkflow, /printf 'image_id=%s\\n'.*\$GITHUB_OUTPUT/u);
  assert.match(ciWorkflow, /printf 'bundle_manifest_sha256=%s\\n'.*\$GITHUB_OUTPUT/u);
  assert.match(
    ciWorkflow,
    /HANDLEPLAN_IMAGE_ID: \$\{\{ steps\.validate-deployment-assets\.outputs\.image_id \}\}/u,
  );
  assert.equal(
    [...ciWorkflow.matchAll(/node scripts\/operations\/verify-ci-image-bundle\.mjs/gu)].length,
    2,
  );
  const imageSave = ciWorkflow.indexOf("docker image save --output");
  const imageRemove = ciWorkflow.indexOf('docker image rm "$HANDLEPLAN_IMAGE"');
  const imageLoad = ciWorkflow.indexOf("docker image load --input");
  const imageFilesystemVerify = ciWorkflow.indexOf("node scripts/operations/verify-production-image.mjs");
  assert.ok(imageRemove > imageSave);
  assert.ok(imageLoad > imageRemove);
  assert.ok(imageFilesystemVerify > imageLoad);
  assert.match(ciWorkflow, /format=handleplan-ci-image-bundle-v3/u);
  assert.match(ciWorkflow, /platform=linux\/amd64/u);
  assert.match(ciWorkflow, /\{\{\.Os\}\}\/\{\{\.Architecture\}\}.*linux\/amd64/u);
  assert.match(ciWorkflow, /runtime_source_digest_sha256=\$runtime_source_digest_sha256/u);
  assert.match(ciWorkflow, /runtime_source_file_count=\$runtime_source_file_count/u);
  assert.match(ciWorkflow, /runtime_shipment_digest_sha256=\$runtime_shipment_digest_sha256/u);
  assert.match(ciWorkflow, /runtime_shipment_entry_count=\$runtime_shipment_entry_count/u);
  assert.match(ciWorkflow, /"image_reference=\$HANDLEPLAN_IMAGE"/u);
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
  const previousImageGate = ciWorkflow.slice(
    ciWorkflow.indexOf("name: Boot the exact previous application image against the expanded schema"),
    ciWorkflow.indexOf("run: corepack pnpm lint"),
  );
  assert.doesNotMatch(previousImageGate, /--entrypoint node/u);
  assert.match(ciWorkflow, /name: Prove the packaged migrator and worker from the exact image/u);
  assert.match(
    ciWorkflow,
    /--entrypoint node[\s\S]*"\$EXPECTED_IMAGE_ID" \/app\/deploy\/migrate\.mjs/u,
  );
  assert.match(
    ciWorkflow,
    /--entrypoint node[\s\S]*"\$EXPECTED_IMAGE_ID" \/app\/apps\/worker\/dist\/main\.mjs/u,
  );
  assert.match(ciWorkflow, /KASSAL_SOURCE_ACCESS=blocked/u);
  assert.match(ciWorkflow, /KASSAL_BASE_URL=https:\/\/127\.0\.0\.1:1/u);
  assert.match(ciWorkflow, /\.scheduler\.completedCycles >= 1/u);
  assert.match(ciWorkflow, /\.scheduler\.failedCycles == 0/u);
  assert.match(ciWorkflow, /\.scheduler\.lastCycle\.leaseAcquired == true/u);
  assert.match(ciWorkflow, /exact-image-private-runtime-proof=ok/u);
  const buildGate = ciWorkflow.indexOf("run: corepack pnpm build");
  const publicHarnessLifecycleGate = ciWorkflow.indexOf(
    "run: corepack pnpm e2e:public-lifecycle",
  );
  const deploymentAssetGate = ciWorkflow.indexOf("name: Validate deployment assets");
  const exactDatabaseResetGate = ciWorkflow.indexOf(
    "name: Reset the exact-image PostgreSQL database",
  );
  const privateRuntimeGate = ciWorkflow.indexOf(
    "name: Prove the packaged migrator and worker from the exact image",
  );
  const governedSeedGate = ciWorkflow.indexOf(
    "name: Seed the governed exact-image browser fixture from the host",
  );
  const imageBrowserGate = ciWorkflow.indexOf("run: corepack pnpm e2e:image");
  const handlemodusGate = ciWorkflow.indexOf("run: corepack pnpm e2e:handlemodus");
  const publicBrowserGate = ciWorkflow.indexOf("run: corepack pnpm exec playwright test");
  const exactImageRecheck = ciWorkflow.indexOf(
    "Reconfirm the exact image and frozen bundle before upload",
  );
  const upload = ciWorkflow.indexOf("name: Upload exact CI image bundle");
  assert.ok(buildGate > 0);
  assert.ok(publicHarnessLifecycleGate > buildGate);
  assert.ok(deploymentAssetGate > publicHarnessLifecycleGate);
  assert.ok(exactDatabaseResetGate > deploymentAssetGate);
  assert.ok(privateRuntimeGate > exactDatabaseResetGate);
  assert.ok(governedSeedGate > privateRuntimeGate);
  assert.ok(imageBrowserGate > governedSeedGate);
  assert.ok(handlemodusGate > imageBrowserGate);
  assert.ok(publicBrowserGate > handlemodusGate);
  assert.ok(exactImageRecheck > publicBrowserGate);
  assert.ok(upload > exactImageRecheck);

  const exactDatabaseReset = ciWorkflow.slice(exactDatabaseResetGate, privateRuntimeGate);
  assert.match(
    exactDatabaseReset,
    /POSTGRES_SERVICE_CONTAINER: \$\{\{ job\.services\.postgres\.id \}\}/u,
  );
  assert.match(exactDatabaseReset, /drop database if exists handleplan with \(force\);/u);
  assert.match(
    exactDatabaseReset,
    /create database handleplan\s+with owner handleplan template template0 encoding 'UTF8';/u,
  );
  assert.match(exactDatabaseReset, /revoke all privileges on database handleplan from public;/u);
  assert.match(exactDatabaseReset, /revoke all privileges on schema public from public;/u);
  assert.match(
    exactDatabaseReset,
    /to_regclass\('public\.handleplan_schema_migrations'\) is null/u,
  );
  assert.match(exactDatabaseReset, /not has_database_privilege\(/u);
  assert.doesNotMatch(exactDatabaseReset, /postgres(?:ql)?:\/\//u);
  assert.doesNotMatch(exactDatabaseReset, /(?:DATABASE_URL|PASSWORD)/u);
});

test("the production image includes and verifies the sealed public browser artifact", () => {
  assert.doesNotMatch(
    dockerfile,
    /COPY --from=builder --chown=nextjs:nodejs \/app\/apps\/web\/public \.\/apps\/web\/public/u,
  );
  assert.match(
    dockerfile,
    /COPY --from=builder --chown=nextjs:nodejs \/app\/apps\/web\/\.next\/handleplan-public-build-binding\.json \.\/apps\/web\/\.next\/handleplan-public-build-binding\.json/u,
  );
  assert.match(dockerfile, /RUN node scripts\/e2e\/public-build-binding\.mjs verify/u);
  assert.match(
    dockerfile,
    /\/app\/apps\/web\/\.next\/standalone \/app\/\.handleplan-release\/standalone/u,
  );
  assert.match(
    dockerfile,
    /\/app\/Dockerfile \/app\/\.handleplan-release\/packaging\/Dockerfile/u,
  );
  assert.match(
    dockerfile,
    /\/app\/\.dockerignore \/app\/\.handleplan-release\/packaging\/\.dockerignore/u,
  );
  assert.match(
    dockerfile,
    /verify-production-image\.mjs seal-runtime[\s\S]*--runtime-root \/app\/\.handleplan-runtime-stage[\s\S]*--expected-revision "\$APP_COMMIT_SHA"/u,
  );
  assert.match(
    dockerfile,
    /handleplan-runtime-shipment-binding\.json \/app\/\.handleplan-release\/runtime\/handleplan-runtime-shipment-binding\.json/u,
  );
  assert.match(
    dockerfile,
    /\/app\/\.handleplan-runtime-stage\/apps\/worker \/app\/apps\/worker/u,
  );
  assert.doesNotMatch(dockerignore, /^\*\*\/\*\.test\.tsx?$/mu);
  assert.doesNotMatch(dockerignore, /^\*\*\/tests$/mu);
  assert.match(imageVerifier, /docker", \["create", "--name", containerName, expectedImageId\]/u);
  assert.ok(imageVerifier.includes("${containerName}:/app/."));
  assert.match(imageVerifier, /recomputeSealedArtifact/u);
  assert.match(imageVerifier, /computePublicSourceBinding/u);
  assert.match(imageVerifier, /computePrivilegedRuntimeSourceBinding/u);
  assert.match(imageVerifier, /computePrivilegedRuntimeShipmentSnapshot/u);
  assert.match(imageVerifier, /differs from its source-bound shipment receipt/u);
  assert.match(imageVerifier, /production image \/app root contains an unexpected or missing entry/u);
  assert.match(imageVerifier, /validateDockerArchiveManifest/u);
  assert.match(imageVerifier, /entry\.RepoTags\[0\] !== imageReference/u);
  assert.doesNotMatch(imageVerifier, /--entrypoint|--mount|--volume/u);
});

test("the Docker-filtered context retains every tracked sealed-source file", () => {
  const sourcePaths = [
    ".dockerignore",
    "Dockerfile",
    "apps/web",
    "apps/worker",
    "deploy",
    "packages/db",
    "packages/domain",
    "packages/kassalapp",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "scripts/e2e/public-build-binding.mjs",
    "scripts/operations/verify-production-image.mjs",
    "tsconfig.base.json",
  ];
  const tracked = spawnSync("git", ["ls-files", "--", ...sourcePaths], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(tracked.status, 0, tracked.stderr);
  const files = tracked.stdout.trim().split("\n").filter(Boolean);
  assert.ok(files.length > 100);
  assert.deepEqual(files.filter(ignoredByDockerContext), []);
});

test("the image browser gate boots the immutable ID with the default entrypoint and no writable mounts", () => {
  assert.match(imageBrowserLauncher, /expectedImageId,[\s\S]*\], \{/u);
  assert.match(imageBrowserLauncher, /"--read-only"/u);
  assert.match(imageBrowserLauncher, /"--cap-drop",[\s\S]*"ALL"/u);
  assert.match(imageBrowserLauncher, /"no-new-privileges:true"/u);
  assert.match(imageBrowserLauncher, /container\?\.Image !== expectedImageId/u);
  assert.match(imageBrowserLauncher, /container\.Mounts\.length !== 0/u);
  assert.doesNotMatch(imageBrowserLauncher, /--entrypoint|--mount|--volume|-v,/u);
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
  assert.match(deployWorkflow, /node-version: 22\.22\.3/u);
  assert.match(
    deployWorkflow,
    /corepack pnpm install --frozen-lockfile --ignore-scripts/u,
  );
  assert.match(deployWorkflow, /ci_run_id=\$CI_RUN_ID/u);
  assert.match(deployWorkflow, /ci_run_attempt=\$CI_RUN_ATTEMPT/u);
  assert.match(deployWorkflow, /sha256sum "\$image_archive"/u);
  assert.match(deployWorkflow, /docker image load --input "\$image_archive"/u);
  assert.match(deployWorkflow, /format=handleplan-ci-image-bundle-v3/u);
  assert.match(deployWorkflow, /platform=linux\/amd64/u);
  assert.match(deployWorkflow, /\{\{\.Os\}\}\/\{\{\.Architecture\}\}.*linux\/amd64/u);
  assert.match(
    deployWorkflow,
    /node scripts\/operations\/verify-production-image\.mjs[\s\S]*--archive "\$image_archive"/u,
  );
  assert.match(deployWorkflow, /\.runtimeSourceDigestSha256/u);
  assert.match(deployWorkflow, /\.shipmentDigestSha256/u);
  assert.match(deployWorkflow, /EXPECTED_IMAGE_ID/u);
  assert.match(deployWorkflow, /EXPECTED_BUNDLE_MANIFEST_SHA256/u);
  assert.match(
    deployWorkflow,
    /node scripts\/operations\/verify-ci-image-bundle\.mjs[\s\S]*"\$manifest"[\s\S]*"\$bundle_manifest_sha256"[\s\S]*"\$DEPLOY_SHA"[\s\S]*"\$expected_image_id"[\s\S]*"\$CI_RUN_ID"[\s\S]*"\$CI_RUN_ATTEMPT"/u,
  );
  assert.doesNotMatch(deployWorkflow, /docker build/u);
});

test("protected deploy gates success on external HTTPS revision and readiness readback", () => {
  assert.match(
    deployWorkflow,
    /HANDLEPLAN_MONITOR_CF_ACCESS_CLIENT_ID: \$\{\{ secrets\.HANDLEPLAN_MONITOR_CF_ACCESS_CLIENT_ID \}\}/u,
  );
  assert.match(
    deployWorkflow,
    /HANDLEPLAN_MONITOR_CF_ACCESS_CLIENT_SECRET: \$\{\{ secrets\.HANDLEPLAN_MONITOR_CF_ACCESS_CLIENT_SECRET \}\}/u,
  );
  assert.match(deployWorkflow, /test -n "\$HANDLEPLAN_MONITOR_CF_ACCESS_CLIENT_ID"/u);
  assert.match(deployWorkflow, /test -n "\$HANDLEPLAN_MONITOR_CF_ACCESS_CLIENT_SECRET"/u);
  assert.match(
    deployWorkflow,
    /HANDLEPLAN_MONITOR_BASE_URL=https:\/\/handle\.reidar\.tech\//u,
  );
  assert.match(deployWorkflow, /redirect: "manual"/u);
  assert.match(deployWorkflow, /await verifyPublicShell\(\)/u);
  assert.match(deployWorkflow, /readBounded\("\/"/u);
  assert.match(deployWorkflow, /target\.pathname !== "\/planlegg"/u);
  assert.match(deployWorkflow, /readBounded\(\s*"\/planlegg"/u);
  assert.match(deployWorkflow, /hasExplicitUtf8Charset\(contentType\)/u);
  assert.match(deployWorkflow, /new TextDecoder\("utf-8", \{ fatal: true \}\)/u);
  const charsetCheck = deployWorkflow.indexOf(
    "!hasExplicitUtf8Charset(contentType)",
  );
  const htmlDecode = deployWorkflow.indexOf(
    "const html = decodeUtf8(shell.bytes);",
  );
  assert.ok(charsetCheck > 0);
  assert.ok(htmlDecode > charsetCheck);
  assert.match(deployWorkflow, /handleplan-public-build-id/u);
  assert.match(deployWorkflow, /expectedPublicBuildId/u);
  assert.match(
    deployWorkflow,
    /validateHealthContract\(await readJsonContract\("\/api\/health"\)/u,
  );
  assert.match(
    deployWorkflow,
    /validateReadinessContract\(await readJsonContract\("\/api\/ready"\)/u,
  );
  assert.match(deployWorkflow, /external-deployment-readback=failed/u);
  assert.doesNotMatch(deployWorkflow, /continue-on-error/u);

  const localReadback = deployWorkflow.indexOf("name: Verify container and exact local health");
  const externalReadback = deployWorkflow.indexOf(
    "name: Verify the externally routed HTTPS revision and readiness",
  );
  const cleanup = deployWorkflow.indexOf("name: Remove the finished VPS transfer bundle");
  assert.ok(localReadback > 0);
  assert.ok(externalReadback > localReadback);
  assert.ok(cleanup > externalReadback);
});

test("external promotion proof accepts the exact shell and rejects root or API failures", () => {
  const success = runExternalDeploymentProbe();
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /external-deployment-readback=ok/u);

  const root404 = runExternalDeploymentProbe({ rootStatus: 404 });
  assert.equal(root404.status, 1);
  assert.equal(root404.stderr, "external-deployment-readback=failed\n");

  const permanentRootRedirect = runExternalDeploymentProbe({ rootStatus: 308 });
  assert.equal(permanentRootRedirect.status, 1);
  assert.equal(
    permanentRootRedirect.stderr,
    "external-deployment-readback=failed\n",
  );

  const wrongRootTarget = runExternalDeploymentProbe({ rootLocation: "/oppdag" });
  assert.equal(wrongRootTarget.status, 1);
  assert.equal(wrongRootTarget.stderr, "external-deployment-readback=failed\n");

  const noncanonicalRootTarget = runExternalDeploymentProbe({
    rootLocation: "https://handle.reidar.tech/planlegg",
  });
  assert.equal(noncanonicalRootTarget.status, 1);
  assert.equal(
    noncanonicalRootTarget.stderr,
    "external-deployment-readback=failed\n",
  );

  const wrongBuild = runExternalDeploymentProbe({
    shellBuildId: `hpv2-${"0".repeat(64)}`,
  });
  assert.equal(wrongBuild.status, 1);
  assert.equal(wrongBuild.stderr, "external-deployment-readback=failed\n");

  const utf8Alias = runExternalDeploymentProbe({
    shellContentType: "text/html; charset=UTF8",
  });
  assert.equal(utf8Alias.status, 0, utf8Alias.stderr);

  const wrongCharset = runExternalDeploymentProbe({
    shellContentType: "text/html; charset=iso-8859-1",
  });
  assert.equal(wrongCharset.status, 1);
  assert.equal(wrongCharset.stderr, "external-deployment-readback=failed\n");

  const missingCharset = runExternalDeploymentProbe({
    shellContentType: "text/html",
  });
  assert.equal(missingCharset.status, 1);
  assert.equal(missingCharset.stderr, "external-deployment-readback=failed\n");

  for (const shellMarkerPlacement of ["comment", "script", "body", "duplicate"]) {
    const decoyMarker = runExternalDeploymentProbe({ shellMarkerPlacement });
    assert.equal(decoyMarker.status, 1);
    assert.equal(
      decoyMarker.stderr,
      "external-deployment-readback=failed\n",
    );
  }

  const wrongHealthRevision = runExternalDeploymentProbe({
    healthRevision: "0".repeat(40),
  });
  assert.equal(wrongHealthRevision.status, 1);
  assert.equal(wrongHealthRevision.stderr, "external-deployment-readback=failed\n");

  const oversizedShell = runExternalDeploymentProbe({ oversizedShell: true });
  assert.equal(oversizedShell.status, 1);
  assert.equal(oversizedShell.stderr, "external-deployment-readback=failed\n");

  const readinessFailure = runExternalDeploymentProbe({ readinessStatus: 503 });
  assert.equal(readinessFailure.status, 1);
  assert.equal(readinessFailure.stderr, "external-deployment-readback=failed\n");
});

test("an externally rejected candidate is guardedly rolled back and cannot race newer state", () => {
  assert.match(deployWorkflow, /name: Capture the exact immutable rollback guard/u);
  assert.match(deployWorkflow, /PREVIOUS_REVISION=%s/u);
  assert.match(deployWorkflow, /PREVIOUS_IMAGE_ID=%s/u);
  assert.match(
    deployWorkflow,
    /always\(\) && steps\.rollback_guard\.outcome == 'success' && steps\.transfer_deploy\.outcome != 'skipped' && steps\.finalize_deployment\.outcome != 'success'/u,
  );
  assert.match(deployWorkflow, /PENDING_DEPLOYMENT_TOKEN/u);
  assert.match(deployWorkflow, /pending-deployment-deadline=/u);
  assert.match(deployWorkflow, /PENDING_DEPLOYMENT_DEADLINE=%s/u);
  assert.equal(
    [...deployWorkflow.matchAll(/'\$PENDING_DEPLOYMENT_DEADLINE'/gu)].length,
    4,
  );
  assert.match(deployWorkflow, /resolve-pending-deployment-on-vps\.sh verify/u);
  assert.equal(
    [...deployWorkflow.matchAll(/resolve-pending-deployment-on-vps\.sh verify/gu)].length,
    2,
  );
  assert.match(deployWorkflow, /resolve-pending-deployment-on-vps\.sh accept/u);
  assert.match(deployWorkflow, /already-accepted/u);
  assert.ok(deployWorkflow.includes(String.raw`\"\$resolver\" reject`));
  assert.match(
    deployWorkflow,
    /current-deployment[\s\S]*'v1 \$PREVIOUS_REVISION current'/u,
  );
  assert.match(deployScript, /record_pending_deployment_state/u);
  assert.match(deployScript, /watch-pending-deployment-on-vps\.sh/u);
  assert.match(deployScript, /pending_deployment_timeout_seconds=900/u);
  assert.match(
    deployScript,
    /test "\$previous_revision" = "\$expected_previous_revision"/u,
  );
  const externalProbe = deployWorkflow.indexOf(
    "name: Verify the externally routed HTTPS revision and readiness",
  );
  const pendingVerification = deployWorkflow.indexOf(
    "resolve-pending-deployment-on-vps.sh verify",
  );
  const rollback = deployWorkflow.indexOf(
    "name: Roll back a candidate rejected by external promotion proof",
  );
  const cleanup = deployWorkflow.indexOf("name: Remove the finished VPS transfer bundle");
  assert.ok(pendingVerification > 0);
  assert.ok(externalProbe > pendingVerification);
  const finalize = deployWorkflow.indexOf(
    "name: Finalize the externally verified pending deployment",
  );
  const externalStep = deployWorkflow.slice(externalProbe, finalize);
  const immediatePendingVerification = externalStep.indexOf(
    "resolve-pending-deployment-on-vps.sh verify",
  );
  const externalNodeProbe = externalStep.indexOf(
    "HANDLEPLAN_MONITOR_BASE_URL=https://handle.reidar.tech/",
  );
  assert.ok(immediatePendingVerification > 0);
  assert.ok(externalNodeProbe > immediatePendingVerification);
  assert.ok(rollback > externalProbe);
  assert.ok(cleanup > rollback);
});

test("pending deployment acceptance is token-bound and deadline-bound", (t) => {
  const fixture = makePendingResolverFixture();
  t.after(() => rmSync(fixture.temp, { force: true, recursive: true }));

  const verified = fixture.run("verify");
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /pending-deployment=.* verified/u);

  const staleVerification = fixture.run("verify", "0".repeat(64));
  assert.notEqual(staleVerification.status, 0);

  const alteredDeadlineVerification = fixture.run(
    "verify",
    fixture.token,
    fixture.deadline + 1,
  );
  assert.notEqual(alteredDeadlineVerification.status, 0);

  const staleToken = fixture.run("accept", "0".repeat(64));
  assert.notEqual(staleToken.status, 0);
  assert.equal(existsSync(join(fixture.state, "pending-deployment")), true);

  const accepted = fixture.run("accept");
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /pending-deployment=.* accepted/u);
  assert.equal(existsSync(join(fixture.state, "pending-deployment")), false);
  assert.equal(
    readFileSync(join(fixture.state, "accepted-deployment"), "utf8"),
    `v1 ${revision} ${imageId} ${previousRevision} ${previousImageId} ${fixture.deadline} ${fixture.token}\n`,
  );
  assert.equal(
    readFileSync(join(fixture.state, "current-deployment"), "utf8"),
    `v1 ${revision} current\n`,
  );
  assert.equal(readFileSync(fixture.commandLog, "utf8"), "");

  const runnerLossAfterAcceptance = fixture.run("reject");
  assert.equal(runnerLossAfterAcceptance.status, 0, runnerLossAfterAcceptance.stderr);
  assert.match(runnerLossAfterAcceptance.stdout, /already-accepted/u);
  assert.equal(readFileSync(fixture.commandLog, "utf8"), "");
  assert.equal(
    readFileSync(join(fixture.state, "current-deployment"), "utf8"),
    `v1 ${revision} current\n`,
  );

  const interruptedAcceptance = makePendingResolverFixture();
  t.after(() => rmSync(interruptedAcceptance.temp, { force: true, recursive: true }));
  const firstAcceptance = interruptedAcceptance.run("accept");
  assert.equal(firstAcceptance.status, 0, firstAcceptance.stderr);
  writeFileSync(
    join(interruptedAcceptance.state, "pending-deployment"),
    `v1 ${revision} ${imageId} ${previousRevision} ${previousImageId} ${interruptedAcceptance.deadline} ${interruptedAcceptance.token}\n`,
    { mode: 0o600 },
  );
  writeFileSync(interruptedAcceptance.commandLog, "");
  const reconciledAcceptance = interruptedAcceptance.run("reject");
  assert.equal(reconciledAcceptance.status, 0, reconciledAcceptance.stderr);
  assert.match(reconciledAcceptance.stdout, /already-accepted/u);
  assert.equal(readFileSync(interruptedAcceptance.commandLog, "utf8"), "");
  assert.equal(
    existsSync(join(interruptedAcceptance.state, "pending-deployment")),
    false,
  );

  const expired = makePendingResolverFixture({
    deadline: Math.floor(Date.now() / 1000) - 1,
  });
  t.after(() => rmSync(expired.temp, { force: true, recursive: true }));
  const expiredAcceptance = expired.run("accept");
  assert.notEqual(expiredAcceptance.status, 0);
  assert.match(expiredAcceptance.stderr, /deadline elapsed/u);
  assert.equal(existsSync(join(expired.state, "pending-deployment")), true);

  const shortWindow = makePendingResolverFixture({
    deadline: Math.floor(Date.now() / 1000) + 30,
  });
  t.after(() => rmSync(shortWindow.temp, { force: true, recursive: true }));
  const shortVerification = shortWindow.run("verify");
  assert.notEqual(shortVerification.status, 0);
  assert.match(shortVerification.stderr, /bounded promotion window/u);

  const excessiveWindow = makePendingResolverFixture({
    deadline: Math.floor(Date.now() / 1000) + 3_600,
  });
  t.after(() => rmSync(excessiveWindow.temp, { force: true, recursive: true }));
  const excessiveVerification = excessiveWindow.run("verify");
  assert.notEqual(excessiveVerification.status, 0);
  assert.match(excessiveVerification.stderr, /bounded promotion window/u);

  const malformed = makePendingResolverFixture();
  t.after(() => rmSync(malformed.temp, { force: true, recursive: true }));
  writeFileSync(join(malformed.state, "pending-deployment"), "torn\n");
  const malformedVerification = malformed.run("verify");
  assert.notEqual(malformedVerification.status, 0);
  assert.match(malformedVerification.stderr, /does not match/u);
});

test("pending cleanup requires the exact image and deadline fields", (t) => {
  const fixture = makePendingResolverFixture();
  t.after(() => rmSync(fixture.temp, { force: true, recursive: true }));
  const stateScript = join(root, "deploy/deployment-state.sh");
  const clearPending = (candidateImageId, candidateDeadline) => spawnSync(
    "sh",
    [
      "-c",
      `. "$1"
clear_pending_deployment_state "$2" "$3" "$4" "$5" "$6" "$7" "$8"`,
      "pending-cleanup-fixture",
      stateScript,
      fixture.state,
      revision,
      candidateImageId,
      previousRevision,
      previousImageId,
      String(candidateDeadline),
      fixture.token,
    ],
    { encoding: "utf8" },
  );

  const alteredImageCleanup = clearPending(
    `sha256:${"9".repeat(64)}`,
    fixture.deadline,
  );
  assert.notEqual(alteredImageCleanup.status, 0);
  assert.equal(existsSync(join(fixture.state, "pending-deployment")), true);

  const alteredDeadlineCleanup = clearPending(imageId, fixture.deadline + 1);
  assert.notEqual(alteredDeadlineCleanup.status, 0);
  assert.equal(existsSync(join(fixture.state, "pending-deployment")), true);

  const exactCleanup = clearPending(imageId, fixture.deadline);
  assert.equal(exactCleanup.status, 0, exactCleanup.stderr);
  assert.equal(existsSync(join(fixture.state, "pending-deployment")), false);
});

test("pending rejection restores only the recorded predecessor and refuses newer state", (t) => {
  const fixture = makePendingResolverFixture();
  t.after(() => rmSync(fixture.temp, { force: true, recursive: true }));
  const rejected = fixture.run("reject");
  assert.equal(rejected.status, 0, rejected.stderr);
  assert.match(rejected.stdout, /pending-deployment=.* rejected/u);
  const rollbackCommands = readFileSync(fixture.commandLog, "utf8");
  assert.match(rollbackCommands, /docker compose .* config/u);
  assert.match(rollbackCommands, /docker compose .* up -d --wait/u);
  assert.doesNotMatch(rollbackCommands, /git /u);
  assert.equal(
    readFileSync(join(fixture.state, "current-deployment"), "utf8"),
    `v1 ${previousRevision} current\n`,
  );
  assert.equal(
    readFileSync(join(fixture.state, "deployment-high-water"), "utf8"),
    `${revision}\n`,
  );
  assert.equal(existsSync(join(fixture.state, "pending-deployment")), false);

  const predecessorStateWithCandidateRuntime = makePendingResolverFixture({
    currentImageId: previousImageId,
    currentRevision: previousRevision,
    highWaterRevision: previousRevision,
  });
  t.after(() => rmSync(predecessorStateWithCandidateRuntime.temp, {
    force: true,
    recursive: true,
  }));
  const recoveredPrecommit = predecessorStateWithCandidateRuntime.run("reject");
  assert.equal(recoveredPrecommit.status, 0, recoveredPrecommit.stderr);
  assert.match(
    readFileSync(predecessorStateWithCandidateRuntime.commandLog, "utf8"),
    /docker rm -f/u,
  );
  assert.equal(
    readFileSync(
      join(predecessorStateWithCandidateRuntime.state, "current-deployment"),
      "utf8",
    ),
    `v1 ${previousRevision} current\n`,
  );
  assert.equal(
    existsSync(join(predecessorStateWithCandidateRuntime.state, "pending-deployment")),
    false,
  );

  const newerRevision = "1".repeat(40);
  const newerImageId = `sha256:${"2".repeat(64)}`;
  const raced = makePendingResolverFixture({
    currentImageId: newerImageId,
    currentRevision: newerRevision,
  });
  t.after(() => rmSync(raced.temp, { force: true, recursive: true }));
  const refused = raced.run("reject");
  assert.notEqual(refused.status, 0);
  assert.equal(readFileSync(raced.commandLog, "utf8"), "");
  assert.equal(existsSync(join(raced.state, "pending-deployment")), true);
  assert.equal(
    readFileSync(join(raced.state, "current-deployment"), "utf8"),
    `v1 ${newerRevision} current\n`,
  );
});

test("pending rejection fails closed before preflight and serializes acceptance", async (t) => {
  const uncommitted = makePendingResolverFixture({
    currentImageId: previousImageId,
    currentRevision: previousRevision,
    highWaterRevision: previousRevision,
  });
  t.after(() => rmSync(uncommitted.temp, { force: true, recursive: true }));
  rmSync(join(uncommitted.state, "pending-deployment"));
  const uncommittedRejection = uncommitted.run("reject");
  assert.notEqual(uncommittedRejection.status, 0);
  assert.match(uncommittedRejection.stderr, /closed without rollback/u);
  assert.match(readFileSync(uncommitted.commandLog, "utf8"), /docker rm -f/u);
  for (const service of ["app", "review", "operations", "worker"]) {
    assert.equal(existsSync(join(uncommitted.runtime, service)), false);
  }
  assert.equal(
    readFileSync(join(uncommitted.state, "current-deployment"), "utf8"),
    `v1 ${previousRevision} current\n`,
  );

  for (const capabilityShape of ["missing", "malformed"]) {
    const lostCapability = makePendingResolverFixture();
    t.after(() => rmSync(lostCapability.temp, { force: true, recursive: true }));
    if (capabilityShape === "missing") {
      rmSync(join(lostCapability.state, "pending-deployment"));
    } else {
      writeFileSync(join(lostCapability.state, "pending-deployment"), "torn\n");
    }
    const lostCapabilityRejection = lostCapability.run("reject");
    assert.notEqual(lostCapabilityRejection.status, 0);
    assert.match(lostCapabilityRejection.stderr, /closed without rollback/u);
    assert.equal(
      readFileSync(join(lostCapability.state, "current-deployment"), "utf8"),
      `v1 ${revision} current\n`,
    );
    for (const service of ["app", "review", "operations", "worker"]) {
      assert.equal(existsSync(join(lostCapability.runtime, service)), false);
    }
    const closedCommands = readFileSync(lostCapability.commandLog, "utf8");
    assert.match(closedCommands, /docker rm -f/u);
    assert.doesNotMatch(closedCommands, /docker compose .* up -d --wait/u);
    assert.equal(
      existsSync(join(lostCapability.state, "pending-deployment")),
      capabilityShape === "malformed",
    );
  }

  const staleHighWater = makePendingResolverFixture({
    highWaterRevision: previousRevision,
  });
  t.after(() => rmSync(staleHighWater.temp, { force: true, recursive: true }));
  const refusedStaleAcceptance = staleHighWater.run("accept");
  assert.notEqual(refusedStaleAcceptance.status, 0);
  assert.match(refusedStaleAcceptance.stderr, /exact deployment high-water/u);
  assert.equal(existsSync(join(staleHighWater.state, "pending-deployment")), true);
  const refusedStaleHighWater = staleHighWater.run("reject");
  assert.notEqual(refusedStaleHighWater.status, 0);
  assert.match(refusedStaleHighWater.stderr, /exact deployment high-water/u);
  assert.equal(existsSync(join(staleHighWater.state, "pending-deployment")), true);
  for (const service of ["app", "review", "operations", "worker"]) {
    assert.equal(existsSync(join(staleHighWater.runtime, service)), false);
  }

  const unrelatedPredecessorHighWater = makePendingResolverFixture({
    currentImageId: previousImageId,
    currentRevision: previousRevision,
    highWaterRevision: "1".repeat(40),
  });
  t.after(() => rmSync(unrelatedPredecessorHighWater.temp, {
    force: true,
    recursive: true,
  }));
  const refusedUnrelatedPredecessor = unrelatedPredecessorHighWater.run("reject");
  assert.notEqual(refusedUnrelatedPredecessor.status, 0);
  assert.match(refusedUnrelatedPredecessor.stderr, /unrelated deployment high-water/u);
  assert.equal(
    existsSync(join(unrelatedPredecessorHighWater.state, "pending-deployment")),
    true,
  );
  for (const service of ["app", "review", "operations", "worker"]) {
    assert.equal(
      existsSync(join(unrelatedPredecessorHighWater.runtime, service)),
      false,
    );
  }

  const failed = makePendingResolverFixture({ configFails: true });
  t.after(() => rmSync(failed.temp, { force: true, recursive: true }));
  const failedRejection = failed.run("reject");
  assert.notEqual(failedRejection.status, 0);
  for (const service of ["app", "review", "operations", "worker"]) {
    assert.equal(
      existsSync(join(failed.runtime, service)),
      false,
      `${failedRejection.stderr}\n${readFileSync(failed.commandLog, "utf8")}`,
    );
  }
  assert.equal(
    readFileSync(join(failed.state, "current-deployment"), "utf8"),
    `v1 ${revision} current\n`,
  );
  assert.equal(existsSync(join(failed.state, "pending-deployment")), true);
  assert.match(readFileSync(failed.commandLog, "utf8"), /docker rm -f/u);

  const raced = makePendingResolverFixture({ blockReject: true });
  t.after(() => rmSync(raced.temp, { force: true, recursive: true }));
  const rejectChild = spawn(
    join(raced.controls, "resolve-pending-deployment-on-vps.sh"),
    [
      "reject",
      revision,
      imageId,
      pendingDeploymentToken,
      previousRevision,
      previousImageId,
      String(raced.deadline),
    ],
    { env: raced.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let rejectStdout = "";
  let rejectStderr = "";
  rejectChild.stdout.setEncoding("utf8");
  rejectChild.stderr.setEncoding("utf8");
  rejectChild.stdout.on("data", (chunk) => { rejectStdout += chunk; });
  rejectChild.stderr.on("data", (chunk) => { rejectStderr += chunk; });
  const rejectResult = new Promise((resolveResult) => {
    rejectChild.on("close", (status, signal) => resolveResult({ signal, status }));
  });
  const markerDeadline = Date.now() + 5_000;
  while (!existsSync(raced.rejectMarker) && Date.now() < markerDeadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  if (!existsSync(raced.rejectMarker)) rejectChild.kill("SIGKILL");
  assert.equal(existsSync(raced.rejectMarker), true);

  const racingAcceptance = raced.run("accept");
  assert.notEqual(racingAcceptance.status, 0);
  assert.equal(existsSync(join(raced.state, "pending-deployment")), true);
  writeFileSync(raced.rejectRelease, "continue\n");
  const completedReject = await rejectResult;
  assert.equal(completedReject.signal, null);
  assert.equal(completedReject.status, 0, rejectStderr);
  assert.match(rejectStdout, /pending-deployment=.* rejected/u);
  assert.equal(existsSync(join(raced.state, "pending-deployment")), false);
  assert.equal(
    readFileSync(join(raced.state, "current-deployment"), "utf8"),
    `v1 ${previousRevision} current\n`,
  );
});

test("the remote watchdog resolves rejected state and retires accepted state promptly", async (t) => {
  const fixture = makePendingResolverFixture({
    deadline: Math.floor(Date.now() / 1000) + 1,
  });
  t.after(() => rmSync(fixture.temp, { force: true, recursive: true }));
  const result = spawnSync(
    join(fixture.operations, "watch-pending-deployment-on-vps.sh"),
    [
      revision,
      imageId,
      pendingDeploymentToken,
      previousRevision,
      previousImageId,
      String(fixture.deadline),
    ],
    { encoding: "utf8", env: fixture.env, timeout: 10_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(fixture.state, "pending-deployment")), false);
  assert.equal(
    readFileSync(join(fixture.state, "current-deployment"), "utf8"),
    `v1 ${previousRevision} current\n`,
  );

  const runAfterWatcherSleep = async ({ accepted, acceptedDeadlineOffset = 0 }) => {
    const delayed = makePendingResolverFixture();
    t.after(() => rmSync(delayed.temp, { force: true, recursive: true }));
    const sleepMarker = join(delayed.temp, "watchdog.sleeping");
    const sleepRelease = join(delayed.temp, "watchdog.release");
    shell(join(delayed.bin, "sleep"), `#!/bin/sh
set -eu
: > "$MOCK_WATCHDOG_SLEEP_MARKER"
while [ ! -e "$MOCK_WATCHDOG_SLEEP_RELEASE" ]; do /bin/sleep 0.02; done
`);
    const env = {
      ...delayed.env,
      MOCK_WATCHDOG_SLEEP_MARKER: sleepMarker,
      MOCK_WATCHDOG_SLEEP_RELEASE: sleepRelease,
    };
    const child = spawn(
      join(delayed.operations, "watch-pending-deployment-on-vps.sh"),
      [
        revision,
        imageId,
        delayed.token,
        previousRevision,
        previousImageId,
        String(delayed.deadline),
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const completed = new Promise((resolveResult) => {
      child.on("close", (status, signal) => resolveResult({ signal, status }));
    });
    const startDeadline = Date.now() + 5_000;
    while (!existsSync(sleepMarker) && Date.now() < startDeadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    if (!existsSync(sleepMarker)) child.kill("SIGKILL");
    assert.equal(existsSync(sleepMarker), true, stderr);
    if (accepted) {
      writeFileSync(
        join(delayed.state, "accepted-deployment"),
        `v1 ${revision} ${imageId} ${previousRevision} ${previousImageId} ${delayed.deadline + acceptedDeadlineOffset} ${delayed.token}\n`,
        { mode: 0o600 },
      );
    }
    rmSync(join(delayed.state, "pending-deployment"));
    writeFileSync(delayed.commandLog, "");
    writeFileSync(sleepRelease, "continue\n");
    return { completed: await completed, delayed, stderr, stdout };
  };

  const missing = await runAfterWatcherSleep({ accepted: false });
  assert.equal(missing.completed.signal, null);
  assert.notEqual(missing.completed.status, 0);
  assert.match(missing.stderr, /closed without rollback/u);
  assert.equal(
    readFileSync(join(missing.delayed.state, "current-deployment"), "utf8"),
    `v1 ${revision} current\n`,
  );
  for (const service of ["app", "review", "operations", "worker"]) {
    assert.equal(existsSync(join(missing.delayed.runtime, service)), false);
  }

  const accepted = await runAfterWatcherSleep({ accepted: true });
  assert.equal(accepted.completed.signal, null);
  assert.equal(accepted.completed.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /pending-watchdog=.* retired/u);
  assert.equal(readFileSync(accepted.delayed.commandLog, "utf8"), "");
  assert.equal(
    existsSync(join(
      accepted.delayed.state,
      "pending-watchdogs",
      accepted.delayed.token,
    )),
    false,
  );
  assert.equal(
    readFileSync(join(accepted.delayed.state, "current-deployment"), "utf8"),
    `v1 ${revision} current\n`,
  );

  const alteredReceipt = await runAfterWatcherSleep({
    accepted: true,
    acceptedDeadlineOffset: 1,
  });
  assert.equal(alteredReceipt.completed.signal, null);
  assert.notEqual(alteredReceipt.completed.status, 0);
  assert.match(alteredReceipt.stderr, /closed without rollback/u);
  assert.doesNotMatch(alteredReceipt.stdout, /already-accepted/u);
  for (const service of ["app", "review", "operations", "worker"]) {
    assert.equal(existsSync(join(alteredReceipt.delayed.runtime, service)), false);
  }

  const rolledBack = makePendingResolverFixture();
  t.after(() => rmSync(rolledBack.temp, { force: true, recursive: true }));
  const acceptedBeforeRollback = rolledBack.run("accept");
  assert.equal(acceptedBeforeRollback.status, 0, acceptedBeforeRollback.stderr);
  const newerRevision = "1".repeat(40);
  const newerImageId = `sha256:${"2".repeat(64)}`;
  const newerToken = "3".repeat(64);
  writeFileSync(
    join(rolledBack.state, "accepted-deployment"),
    `v1 ${newerRevision} ${newerImageId} ${revision} ${imageId} ${rolledBack.deadline + 60} ${newerToken}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(rolledBack.state, "deployment-high-water"),
    `${newerRevision}\n`,
  );
  writeFileSync(rolledBack.commandLog, "");
  shell(join(rolledBack.bin, "sleep"), `#!/bin/sh
exit 0
`);
  const staleAcceptedWatchdog = spawnSync(
    join(rolledBack.operations, "watch-pending-deployment-on-vps.sh"),
    [
      revision,
      imageId,
      rolledBack.token,
      previousRevision,
      previousImageId,
      String(rolledBack.deadline),
    ],
    { encoding: "utf8", env: rolledBack.env, timeout: 10_000 },
  );
  assert.notEqual(staleAcceptedWatchdog.status, 0);
  assert.match(staleAcceptedWatchdog.stderr, /ceased owning.*high-water/u);
  assert.equal(readFileSync(rolledBack.commandLog, "utf8"), "");
  assert.equal(
    readFileSync(join(rolledBack.state, "current-deployment"), "utf8"),
    `v1 ${revision} current\n`,
  );
  assert.equal(
    readFileSync(join(rolledBack.state, "deployment-high-water"), "utf8"),
    `${newerRevision}\n`,
  );
  for (const service of ["app", "review", "operations", "worker"]) {
    assert.equal(existsSync(join(rolledBack.runtime, service)), true);
  }
});

test("candidate commit cannot precede its detached pending watchdog", () => {
  const pendingRecord = deployScript.indexOf("record_pending_deployment_state");
  const detachedWatchdog = deployScript.indexOf('nohup "$pending_watchdog"');
  const watchdogReadback = deployScript.indexOf('kill -0 "$pending_watchdog_pid"');
  const stateCommit = deployScript.lastIndexOf("record_immutable_deployment_state");
  assert.ok(pendingRecord > 0);
  assert.ok(detachedWatchdog > pendingRecord);
  assert.ok(watchdogReadback > detachedWatchdog);
  assert.ok(stateCommit > watchdogReadback);
  assert.match(deployScript, /<\/dev\/null >\/dev\/null 2>&1 &/u);
  assert.match(pendingWatchdogScript, /"\$resolver" retire/u);
  assert.match(pendingWatchdogScript, /exec "\$resolver" watchdog-reject/u);
  assert.match(deployScript, /record_pending_watchdog_lease/u);
  assert.match(pendingResolverScript, /acquire_deployment_operation_lock/u);
  assert.match(pendingResolverScript, /current_matches "\$candidate_revision"/u);
  assert.match(pendingResolverScript, /current_matches "\$expected_previous_revision"/u);
  assert.match(pendingResolverScript, /rejection_cleanup_armed=1/u);
  assert.match(pendingResolverScript, /timeout --foreground --kill-after=5s 60s/u);
  assert.match(pendingResolverScript, /close_application_runtimes/u);
  assert.doesNotMatch(pendingResolverScript, /git (?:fetch|clone|archive)/u);
});

test("pending-watchdog leases enforce hard admission and exact cleanup", (t) => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "handleplan-watchdog-cap-")));
  t.after(() => rmSync(temp, { force: true, recursive: true }));
  const state = join(temp, "state");
  mkdirSync(state);
  const stateScript = join(root, "deploy/deployment-state.sh");
  const invokeLedger = (action, candidateToken, candidateDeadline) => spawnSync(
    "sh",
    [
      "-c",
      `. "$1"
case "$2" in
  record)
    record_pending_watchdog_lease "$3" "$4" "$5" "$6" "$7" "$8" "$9"
    ;;
  clear)
    clear_pending_watchdog_lease "$3" "$4" "$5" "$6" "$7" "$8" "$9"
    ;;
  capacity)
    assert_pending_watchdog_capacity "$3"
    ;;
esac`,
      "watchdog-ledger-fixture",
      stateScript,
      action,
      state,
      revision,
      imageId,
      previousRevision,
      previousImageId,
      String(candidateDeadline),
      candidateToken,
    ],
    { encoding: "utf8" },
  );
  const staleDeadline = Math.floor(Date.now() / 1000) - 1;
  const leaseTokens = ["0", "1", "2", "3"].map((digit) => digit.repeat(64));
  for (const leaseToken of leaseTokens) {
    const recorded = invokeLedger("record", leaseToken, staleDeadline);
    assert.equal(recorded.status, 0, recorded.stderr);
  }

  const overflowToken = "4".repeat(64);
  const refusedOverflow = invokeLedger("record", overflowToken, staleDeadline);
  assert.notEqual(refusedOverflow.status, 0);
  assert.match(refusedOverflow.stderr, /capacity is exhausted/u);
  assert.equal(
    existsSync(join(state, "pending-watchdogs", overflowToken)),
    false,
  );

  const alteredCleanup = invokeLedger("clear", leaseTokens[0], staleDeadline + 1);
  assert.notEqual(alteredCleanup.status, 0);
  assert.equal(
    existsSync(join(state, "pending-watchdogs", leaseTokens[0])),
    true,
  );
  const exactCleanup = invokeLedger("clear", leaseTokens[0], staleDeadline);
  assert.equal(exactCleanup.status, 0, exactCleanup.stderr);
  const admittedAfterCleanup = invokeLedger("record", overflowToken, staleDeadline);
  assert.equal(admittedAfterCleanup.status, 0, admittedAfterCleanup.stderr);

  const malformedLease = join(state, "pending-watchdogs", leaseTokens[1]);
  writeFileSync(malformedLease, "torn\n");
  const malformedAdmission = invokeLedger("capacity", overflowToken, staleDeadline);
  assert.notEqual(malformedAdmission.status, 0);

  rmSync(malformedLease);
  symlinkSync(join(temp, "missing-watchdog-lease"), malformedLease);
  const symlinkAdmission = invokeLedger("capacity", overflowToken, staleDeadline);
  assert.notEqual(symlinkAdmission.status, 0);
});

test("explicit rollback refuses regular and symlink-shaped pending state under the shared lock", (t) => {
  assert.match(
    explicitRollbackScript,
    /\[ -e "\$pending_deployment_manifest" \][\s\\]*\|\| \[ -L "\$pending_deployment_manifest" \]/u,
  );
  const lockAcquisition = explicitRollbackScript.indexOf(
    'acquire_deployment_operation_lock "$state_dir"',
  );
  const pendingGuard = explicitRollbackScript.indexOf(
    'pending_deployment_manifest="$state_dir/pending-deployment"',
  );
  const stateLoad = explicitRollbackScript.indexOf('load_deployment_state "$state_dir"');
  assert.ok(lockAcquisition > 0);
  assert.ok(pendingGuard > lockAcquisition);
  assert.ok(stateLoad > pendingGuard);

  for (const brokenSymlink of [false, true]) {
    const fixture = makeExplicitRollbackPendingFixture({ brokenSymlink });
    t.after(() => rmSync(fixture.temp, { force: true, recursive: true }));
    const result = fixture.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refuses unresolved pending deployment state/u);
    assert.equal(readFileSync(fixture.log, "utf8"), "");
    assert.equal(existsSync(join(fixture.state, ".deployment-operation.lock")), false);
    assert.equal(
      existsSync(join(fixture.state, "pending-deployment"))
        || brokenSymlink,
      true,
    );
  }
});

test("deploy refuses first cutover without a verified immutable predecessor", () => {
  const capture = deployWorkflow.indexOf("name: Capture the exact immutable rollback guard");
  const transfer = deployWorkflow.indexOf("name: Transfer and deploy the exact CI image on the VPS");
  assert.ok(capture > 0);
  assert.ok(transfer > capture);
  const guardStep = deployWorkflow.slice(capture, transfer);
  assert.match(guardStep, /current-deployment/u);
  assert.match(guardStep, /test ! -e \/opt\/apps\/handleplan\/state\/pending-deployment/u);
  assert.match(guardStep, /test "\$3" = current/u);
  assert.match(guardStep, /current-image-id/u);
  assert.match(guardStep, /verified-images\/\$previous_revision/u);
  assert.match(guardStep, /docker image inspect/u);
  assert.doesNotMatch(guardStep, /\|\| true/u);

  const fixture = makeFixture();
  rmSync(join(fixture.appRoot, "state"), { force: true, recursive: true });
  mkdirSync(join(fixture.appRoot, "state"));
  const firstCutover = fixture.run();
  rmSync(fixture.temp, { force: true, recursive: true });
  assert.notEqual(firstCutover.status, 0);
  assert.match(firstCutover.stderr, /first deployment fails closed/u);
});

test("protected deploy leases transfer staging and cleans only its exact finished leaf", () => {
  assert.match(deployWorkflow, /REMOTE_BUNDLE_ROOT: \/opt\/apps\/handleplan\/deploy-bundles/u);
  assert.match(
    deployWorkflow,
    /remote_bundle="\$REMOTE_BUNDLE_ROOT\/\$DEPLOY_SHA\/\$CI_RUN_ID-\$CI_RUN_ATTEMPT\/\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT"/u,
  );
  assert.match(deployWorkflow, /\.lease\.v1/u);
  assert.match(deployWorkflow, /lease_expires=.*10800/u);
  assert.match(deployWorkflow, /wc -c < "\$provenance"[\s\S]*16777216/u);
  assert.match(deployWorkflow, /wc -c < "\$sbom"[\s\S]*67108864/u);
  assert.match(deployWorkflow, /lease_tmp='\$remote_bundle\/\.lease\.v1\.tmp'/u);
  assert.ok(
    deployWorkflow.includes(
      String.raw`mv -f \"\$lease_tmp\" '$remote_bundle/.lease.v1'`,
    ),
  );
  assert.doesNotMatch(
    deployWorkflow,
    /> '\$remote_bundle\/\.lease\.v1'/u,
  );
  assert.match(
    deployWorkflow,
    /deploy\/prepare-deployment-bundle-on-vps\.sh[\s\S]*deploy@198\.23\.137\.16:\$remote_prepare_incoming/u,
  );
  const stagedPrepare = deployWorkflow.indexOf(
    '"deploy@198.23.137.16:$remote_prepare_incoming"',
  );
  const verifiedPrepare = deployWorkflow.indexOf(
    "sha256sum '$remote_prepare_incoming'",
  );
  const executedPrepare = deployWorkflow.indexOf(
    "'$remote_prepare_ready' '$DEPLOY_SHA'",
  );
  assert.ok(stagedPrepare > 0);
  assert.ok(verifiedPrepare > stagedPrepare);
  assert.ok(executedPrepare > verifiedPrepare);
  const controlSweep = deployWorkflow.indexOf(
    "find '$REMOTE_CONTROL_ROOT' -mindepth 1 -maxdepth 1 -type f -delete",
  );
  const controlRootEmpty = deployWorkflow.indexOf(
    "find '$REMOTE_CONTROL_ROOT' -mindepth 1 -maxdepth 1 -printf x -quit",
  );
  assert.ok(controlSweep > 0);
  assert.ok(controlRootEmpty > controlSweep);
  assert.ok(stagedPrepare > controlRootEmpty);
  assert.match(
    deployWorkflow,
    /unsafe_control=.*find '\$REMOTE_CONTROL_ROOT' -mindepth 1 -maxdepth 1 ! -type f -printf x -quit/u,
  );
  assert.match(
    deployWorkflow,
    /find '\$REMOTE_CONTROL_ROOT' -mindepth 1 -maxdepth 1 -printf x \| wc -c\).*?-eq 1/u,
  );
  assert.doesNotMatch(deployWorkflow, /sh -s --[^\n]*DEPLOY_SHA/u);
  assert.match(deployWorkflow, /test "\$prepared_bundle" = "\$remote_bundle"/u);
  const transferStep = deployWorkflow.slice(
    deployWorkflow.indexOf("name: Transfer and deploy the exact CI image on the VPS"),
    deployWorkflow.indexOf("name: Verify container and exact local health"),
  );
  assert.match(transferStep, /cleanup-deployment-bundle-on-vps\.sh/u);
  const preallocationPrune = bundlePrepareScript.indexOf("prune_bundle_staging");
  const allocationCapacity = bundlePrepareScript.indexOf(
    "enforce_bundle_allocation_capacity",
  );
  const leafCreation = bundlePrepareScript.indexOf(
    'install -d -m 700 "$prepared_leaf" "$prepared_leaf/image"',
  );
  assert.ok(preallocationPrune > 0);
  assert.ok(allocationCapacity > preallocationPrune);
  assert.ok(leafCreation > allocationCapacity);
  assert.ok(leafCreation > preallocationPrune);
  assert.match(bundlePrepareScript, /maximum_active_bundle_leaves=1/u);
  assert.match(bundlePrepareScript, /minimum_host_free_kib=4194304/u);
  assert.match(bundlePrepareScript, /maximum_active_bundle_kib=2359296/u);
  assert.match(bundlePrepareScript, /df -Pk "\$deploy_bundle_root_physical"/u);
  assert.match(bundlePrepareScript, /trap '' HUP INT TERM[\s\S]*mkdir "\$operation_lock"/u);
  assert.ok(
    deployScript.indexOf('acquire_deployment_operation_lock "$state_dir"')
      < deployScript.lastIndexOf("prune_deploy_bundle_staging ||"),
  );
  assert.match(
    deployWorkflow,
    /always\(\) && steps\.transfer_deploy\.outcome != 'skipped'/u,
  );
  assert.match(deployWorkflow, /cleanup-deployment-bundle-on-vps\.sh';/u);
  assert.match(bundleCleanupScript, /acquire_deployment_operation_lock "\$state_dir"/u);
  assert.match(bundleCleanupScript, /test ! -e "\$bundle_leaf\/\.lease\.v1"/u);
  assert.match(bundleCleanupScript, /rm -rf -- "\$deploy_run_id-\$deploy_run_attempt"/u);
  assert.doesNotMatch(deployWorkflow, /rm -rf -- '\$remote_bundle'/u);
  assert.doesNotMatch(deployWorkflow, /rm -rf -- '\$REMOTE_BUNDLE_ROOT'/u);
});

test("pre-entry runner loss is swept before allocation and final cleanup is locked", (t) => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "handleplan-bundle-guard-")));
  t.after(() => rmSync(temp, { force: true, recursive: true }));
  const appRoot = join(temp, "app");
  const state = join(appRoot, "state");
  const bundleRoot = join(appRoot, "deploy-bundles");
  mkdirSync(state, { recursive: true });
  mkdirSync(bundleRoot, { recursive: true });
  const env = {
    ...process.env,
    HANDLEPLAN_APP_ROOT: appRoot,
    HANDLEPLAN_DEPLOY_BUNDLE_ROOT: bundleRoot,
  };
  const prepare = (deployRunId) => spawnSync(
    join(root, "deploy/prepare-deployment-bundle-on-vps.sh"),
    [revision, "12345", "2", String(deployRunId), "1"],
    { encoding: "utf8", env },
  );

  const first = prepare(70001);
  assert.equal(first.status, 0, first.stderr);
  const firstLeaf = first.stdout.trim();
  assert.equal(
    firstLeaf,
    join(bundleRoot, revision, "12345-2", "70001-1"),
  );
  writeFileSync(
    join(firstLeaf, ".lease.v1"),
    `v1 ${revision} 12345 2 70001 1 ${Math.floor(Date.now() / 1000) - 1}\n`,
  );
  writeFileSync(join(firstLeaf, "lost-runner-payload"), "bounded fixture\n");

  const second = prepare(70002);
  assert.equal(second.status, 0, second.stderr);
  const secondLeaf = second.stdout.trim();
  assert.equal(existsSync(firstLeaf), false);
  assert.equal(existsSync(secondLeaf), true);
  assert.equal(existsSync(join(temp, "$revision_dir")), false);

  cpSync(
    join(root, "deploy/deployment-state.sh"),
    join(secondLeaf, "deployment-state.sh"),
  );
  cpSync(
    join(root, "deploy/cleanup-deployment-bundle-on-vps.sh"),
    join(secondLeaf, "cleanup-deployment-bundle-on-vps.sh"),
  );
  chmodSync(join(secondLeaf, "cleanup-deployment-bundle-on-vps.sh"), 0o700);

  const leasedCleanup = spawnSync(
    join(secondLeaf, "cleanup-deployment-bundle-on-vps.sh"),
    [revision, "12345", "2", "70002", "1"],
    { encoding: "utf8", env },
  );
  assert.notEqual(leasedCleanup.status, 0);
  assert.match(leasedCleanup.stderr, /Refusing to clean a leased/u);
  assert.equal(existsSync(secondLeaf), true);

  rmSync(join(secondLeaf, ".lease.v1"));
  const finishedCleanup = spawnSync(
    join(secondLeaf, "cleanup-deployment-bundle-on-vps.sh"),
    [revision, "12345", "2", "70002", "1"],
    { encoding: "utf8", env },
  );
  assert.equal(finishedCleanup.status, 0, finishedCleanup.stderr);
  assert.equal(existsSync(secondLeaf), false);
  assert.equal(existsSync(join(state, ".deployment-operation.lock")), false);
});

test("transfer allocation enforces active-leaf, aggregate-byte, and host-reserve bounds", (t) => {
  const makeCapacityRoot = (label) => {
    const temp = realpathSync(mkdtempSync(join(tmpdir(), `handleplan-bundle-${label}-`)));
    t.after(() => rmSync(temp, { force: true, recursive: true }));
    const appRoot = join(temp, "app");
    const state = join(appRoot, "state");
    const bundleRoot = join(appRoot, "deploy-bundles");
    mkdirSync(state, { recursive: true });
    mkdirSync(bundleRoot, { recursive: true });
    return {
      appRoot,
      bundleRoot,
      state,
      temp,
      run: (deployRunId, extraEnv = {}) => spawnSync(
        join(root, "deploy/prepare-deployment-bundle-on-vps.sh"),
        [revision, "12345", "2", String(deployRunId), "1"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HANDLEPLAN_APP_ROOT: appRoot,
            HANDLEPLAN_DEPLOY_BUNDLE_ROOT: bundleRoot,
            ...extraEnv,
          },
        },
      ),
    };
  };

  const active = makeCapacityRoot("active-capacity");
  const first = active.run(81001);
  assert.equal(first.status, 0, first.stderr);
  const firstLeaf = first.stdout.trim();
  const second = active.run(81002);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /another lease is active/u);
  assert.equal(existsSync(firstLeaf), true);
  assert.equal(
    existsSync(join(active.bundleRoot, revision, "12345-2", "81002-1")),
    false,
  );
  assert.equal(existsSync(join(active.state, ".deployment-operation.lock")), false);

  const lowDisk = makeCapacityRoot("low-disk");
  const lowDiskBin = join(lowDisk.temp, "bin");
  mkdirSync(lowDiskBin);
  shell(join(lowDiskBin, "df"), `#!/bin/sh
printf '%s\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on'
printf '%s\n' '/dev/mock 10000000 9999999 1 100% /mock'
`);
  const lowDiskResult = lowDisk.run(82001, {
    PATH: `${lowDiskBin}:${process.env.PATH}`,
  });
  assert.notEqual(lowDiskResult.status, 0);
  assert.match(lowDiskResult.stderr, /host free-space reserve/u);
  assert.equal(
    existsSync(join(lowDisk.bundleRoot, revision, "12345-2", "82001-1")),
    false,
  );
  assert.equal(existsSync(join(lowDisk.state, ".deployment-operation.lock")), false);

  const oversized = makeCapacityRoot("oversized-active");
  const activeLeaf = join(
    oversized.bundleRoot,
    previousRevision,
    "222-1",
    "333-1",
  );
  mkdirSync(activeLeaf, { recursive: true });
  writeFileSync(
    join(activeLeaf, ".lease.v1"),
    `v1 ${previousRevision} 222 1 333 1 ${Math.floor(Date.now() / 1000) + 3_600}\n`,
  );
  const oversizedBin = join(oversized.temp, "bin");
  mkdirSync(oversizedBin);
  shell(join(oversizedBin, "du"), `#!/bin/sh
printf '%s %s\n' 2359297 "$2"
`);
  const oversizedResult = oversized.run(83001, {
    PATH: `${oversizedBin}:${process.env.PATH}`,
  });
  assert.notEqual(oversizedResult.status, 0);
  assert.match(oversizedResult.stderr, /exceeds its byte bound/u);
  assert.equal(existsSync(activeLeaf), true);
  assert.equal(existsSync(join(oversized.state, ".deployment-operation.lock")), false);
});

test("catchable allocation loss releases only its owned operation lock", async (t) => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "handleplan-bundle-signal-")));
  t.after(() => rmSync(temp, { force: true, recursive: true }));
  const appRoot = join(temp, "app");
  const state = join(appRoot, "state");
  const bundleRoot = join(appRoot, "deploy-bundles");
  const bin = join(temp, "bin");
  const marker = join(temp, "sweep.started");
  mkdirSync(state, { recursive: true });
  mkdirSync(bundleRoot, { recursive: true });
  mkdirSync(bin, { recursive: true });
  shell(join(bin, "find"), `#!/bin/sh
set -eu
: > "$MOCK_SWEEP_MARKER"
trap 'exit 143' TERM
while :; do sleep 1; done
`);
  const child = spawn(
    join(root, "deploy/prepare-deployment-bundle-on-vps.sh"),
    [revision, "12345", "2", "80001", "1"],
    {
      detached: true,
      env: {
        ...process.env,
        HANDLEPLAN_APP_ROOT: appRoot,
        HANDLEPLAN_DEPLOY_BUNDLE_ROOT: bundleRoot,
        MOCK_SWEEP_MARKER: marker,
        PATH: `${bin}:${process.env.PATH}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const childResult = new Promise((resolveResult) => {
    child.on("close", (status, signal) => resolveResult({ signal, status }));
  });
  const markerDeadline = Date.now() + 5_000;
  while (!existsSync(marker) && Date.now() < markerDeadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  if (!existsSync(marker)) {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
  assert.equal(existsSync(marker), true, stderr);
  process.kill(-child.pid, "SIGTERM");
  const completed = await childResult;
  assert.equal(completed.signal, null);
  assert.equal(completed.status, 143, stderr);
  assert.equal(existsSync(join(state, ".deployment-operation.lock")), false);

  mkdirSync(join(state, ".deployment-operation.lock"));
  const contended = spawnSync(
    join(root, "deploy/prepare-deployment-bundle-on-vps.sh"),
    [revision, "12345", "2", "80002", "1"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HANDLEPLAN_APP_ROOT: appRoot,
        HANDLEPLAN_DEPLOY_BUNDLE_ROOT: bundleRoot,
      },
    },
  );
  assert.notEqual(contended.status, 0);
  assert.equal(existsSync(join(state, ".deployment-operation.lock")), true);
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
  assert.match(deployScript, /format=handleplan-ci-image-bundle-v3/u);
  assert.match(deployScript, /platform=linux\/amd64/u);
  assert.match(deployScript, /loaded_image_platform/u);
  assert.match(deployScript, /runtime_source_digest_sha256/u);
  assert.match(deployScript, /runtime_shipment_digest_sha256/u);
  assert.match(
    deployScript,
    /CI source archive is not the exact fetched origin\/main commit/u,
  );
  assert.match(deployScript, /review_image_id.*loaded_image_id/su);
  assert.match(deployScript, /operations_image_id.*loaded_image_id/su);
  assert.match(deployScript, /worker_image_id.*loaded_image_id/su);
  assert.match(deployScript, /app_image_id.*loaded_image_id/su);
  assert.match(
    deployScript,
    /deploy "\$revision" "\$revision" current "\$loaded_image_id" "\$loaded_image_id"/u,
  );
  assert.match(deployScript, /app_image.*target_image/su);
  assert.match(deployScript, /worker_image.*target_image/su);
});

test("VPS rejects a conflicting immutable image for an already verified revision", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.temp, { force: true, recursive: true }));
  const verifiedDirectory = join(fixture.appRoot, "state", "verified-images");
  mkdirSync(verifiedDirectory, { recursive: true });
  writeFileSync(
    join(verifiedDirectory, revision),
    `v1 ${revision} sha256:${"f".repeat(64)}\n`,
    { mode: 0o600 },
  );

  const result = fixture.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already bound to a different immutable image/u);
  assert.equal(readFileSync(fixture.log, "utf8"), "");
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

test("VPS prunes only finished or expired sibling transfer bundles", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.temp, { force: true, recursive: true }));
  const siblingRevision = "c".repeat(40);
  const finishedLeaf = join(fixture.bundleRoot, siblingRevision, "222-1", "333-1");
  const activeLeaf = join(fixture.bundleRoot, siblingRevision, "222-1", "444-1");
  const expiredLeaf = join(fixture.bundleRoot, siblingRevision, "222-1", "555-1");
  const malformedExpiredLeaf = join(
    fixture.bundleRoot,
    siblingRevision,
    "222-1",
    "666-1",
  );
  const malformedRecentLeaf = join(
    fixture.bundleRoot,
    siblingRevision,
    "222-1",
    "777-1",
  );
  mkdirSync(finishedLeaf, { recursive: true });
  mkdirSync(activeLeaf, { recursive: true });
  mkdirSync(expiredLeaf, { recursive: true });
  mkdirSync(malformedExpiredLeaf, { recursive: true });
  mkdirSync(malformedRecentLeaf, { recursive: true });
  writeFileSync(join(finishedLeaf, "payload"), "finished\n");
  writeFileSync(
    join(activeLeaf, ".lease.v1"),
    `v1 ${siblingRevision} 222 1 444 1 ${Math.floor(Date.now() / 1000) + 3_600}\n`,
  );
  writeFileSync(
    join(expiredLeaf, ".lease.v1"),
    `v1 ${siblingRevision} 222 1 555 1 ${Math.floor(Date.now() / 1000) - 1}\n`,
  );
  const malformedExpiredLease = join(malformedExpiredLeaf, ".lease.v1");
  writeFileSync(malformedExpiredLease, "torn\n");
  const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1_000);
  utimesSync(malformedExpiredLease, fourHoursAgo, fourHoursAgo);
  writeFileSync(join(malformedRecentLeaf, ".lease.v1"), "torn\n");

  const result = fixture.run();
  assert.equal(result.status, 44, result.stderr);
  assert.equal(existsSync(finishedLeaf), false);
  assert.equal(existsSync(expiredLeaf), false);
  assert.equal(existsSync(malformedExpiredLeaf), false);
  assert.equal(existsSync(malformedRecentLeaf), true);
  assert.equal(existsSync(activeLeaf), true);
  assert.equal(existsSync(join(fixture.scriptDir, ".lease.v1")), false);
});

test("VPS refuses malformed transfer-bundle leaves without deleting them", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.temp, { force: true, recursive: true }));
  const malformedLeaf = join(fixture.bundleRoot, "not-a-revision", "222-1", "333-1");
  mkdirSync(malformedLeaf, { recursive: true });
  writeFileSync(join(malformedLeaf, "payload"), "keep\n");

  const result = fixture.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /transfer-bundle root contains an invalid revision directory/u);
  assert.equal(existsSync(malformedLeaf), true);
  assert.doesNotMatch(readFileSync(fixture.log, "utf8"), /docker image load/u);
});

test("VPS refuses transfer-bundle symlinks without traversing them", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.temp, { force: true, recursive: true }));
  const outside = join(fixture.temp, "outside-transfer-root");
  mkdirSync(outside);
  writeFileSync(join(outside, "payload"), "keep\n");
  symlinkSync(outside, join(fixture.bundleRoot, "unsafe-link"));

  const result = fixture.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /transfer-bundle root contains an unsafe symbolic link/u);
  assert.equal(readFileSync(join(outside, "payload"), "utf8"), "keep\n");
  assert.doesNotMatch(readFileSync(fixture.log, "utf8"), /docker image load/u);
});

test("VPS rejects overlong leases and newline-shaped staging paths without deleting them", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.temp, { force: true, recursive: true }));
  const siblingRevision = "c".repeat(40);
  const overlongLeaf = join(fixture.bundleRoot, siblingRevision, "222-1", "333-1");
  mkdirSync(overlongLeaf, { recursive: true });
  writeFileSync(
    join(overlongLeaf, ".lease.v1"),
    `v1 ${siblingRevision} 222 1 333 1 ${Math.floor(Date.now() / 1000) + 14_400}\n`,
  );
  const overlong = fixture.run();
  assert.notEqual(overlong.status, 0);
  assert.match(overlong.stderr, /lease exceeds the bounded horizon/u);
  assert.equal(existsSync(overlongLeaf), true);

  rmSync(overlongLeaf, { recursive: true });
  writeFileSync(
    join(fixture.scriptDir, ".lease.v1"),
    `v1 ${revision} 12345 2 98765 1 ${Math.floor(Date.now() / 1000) + 10_800}\n`,
    { mode: 0o600 },
  );
  const newlineRevision = `${"c".repeat(39)}\n`;
  const newlineLeaf = join(fixture.bundleRoot, newlineRevision, "222-1", "333-1");
  mkdirSync(newlineLeaf, { recursive: true });
  writeFileSync(join(newlineLeaf, "payload"), "keep\n");
  const newline = fixture.run();
  assert.notEqual(newline.status, 0);
  assert.match(newline.stderr, /invalid revision directory/u);
  assert.equal(readFileSync(join(newlineLeaf, "payload"), "utf8"), "keep\n");
  assert.doesNotMatch(readFileSync(fixture.log, "utf8"), /docker image load/u);
});
