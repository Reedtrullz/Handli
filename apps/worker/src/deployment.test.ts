import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const dockerfile = fileURLToPath(new URL("../../../Dockerfile", import.meta.url));
const compose = fileURLToPath(new URL("../../../deploy/compose.production.yml", import.meta.url));
const caddyfile = fileURLToPath(new URL("../../../deploy/Caddyfile.handleplan", import.meta.url));
const deploy = fileURLToPath(new URL("../../../deploy/deploy-on-vps.sh", import.meta.url));
const deploymentState = fileURLToPath(
  new URL("../../../deploy/deployment-state.sh", import.meta.url),
);
const rollbackCompose = fileURLToPath(
  new URL("../../../deploy/compose.rollback-legacy.yml", import.meta.url),
);
const runbook = fileURLToPath(new URL("../../../docs/runbooks/worker.md", import.meta.url));
const workflow = fileURLToPath(
  new URL("../../../.github/workflows/deploy-preview.yml", import.meta.url),
);
const ciWorkflow = fileURLToPath(
  new URL("../../../.github/workflows/ci.yml", import.meta.url),
);

const candidateDockerfile = 'FROM scratch\nLABEL fixture="candidate-clean"\n';
const committedCompose = "# committed-compose\nservices: {}\n";

interface DeploymentFixture {
  appRoot: string;
  appState: string;
  artifactDir: string;
  bin: string;
  buildContextRecord: string;
  candidateRevision: string;
  deployScript: string;
  dockerLog: string;
  imageId: string;
  operationsState: string;
  previousImageId: string;
  previousRevision: string;
  remote: string;
  reviewState: string;
  root: string;
  source: string;
  workerState: string;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function runGit(argumentsList: string[], cwd?: string): string {
  const result = spawnSync("git", argumentsList, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${argumentsList.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function composeServiceBlock(source: string, service: string): string | undefined {
  return source.match(new RegExp(
    `^  ${service}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:\\n|^networks:\\n)`,
    "mu",
  ))?.[1];
}

function cloudflareHeaderRules(handle: string | undefined): string[] {
  return (handle?.match(/^\s*header_up .*Cf-[^\n]*$/gmu) ?? [])
    .map((line) => line.trim());
}

async function createDeploymentFixture(prefix: string): Promise<DeploymentFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const appRoot = join(root, "app");
  const source = join(appRoot, "source");
  const remote = join(root, "origin.git");
  const bin = join(root, "bin");
  const artifactDir = join(root, "ci-artifact");
  const imageTree = join(root, "image-tree");
  await Promise.all([
    mkdir(bin, { recursive: true }),
    mkdir(artifactDir, { recursive: true }),
    mkdir(imageTree, { recursive: true }),
    mkdir(join(appRoot, "shared"), { recursive: true }),
    mkdir(join(appRoot, "state"), { recursive: true }),
    mkdir(join(source, "deploy"), { recursive: true }),
    mkdir(join(source, "deploy", "backup"), { recursive: true }),
    mkdir(join(source, "deploy", "migrations"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(appRoot, "shared", "production.env"), [
      "REVIEW_ACCESS_AUDIENCE=review-audience-0123456789abcdef",
      "OPERATIONS_ACCESS_AUDIENCE=operations-audience-0123456789abcdef",
      "",
    ].join("\n")),
    writeFile(join(imageTree, "fixture"), "exact-ci-image-archive\n"),
    writeFile(join(source, ".gitignore"), "ignored-secret.txt\n"),
    writeFile(join(source, "Dockerfile"), "FROM scratch\nLABEL fixture=previous\n"),
    writeFile(join(source, "deploy", "compose.production.yml"), committedCompose),
    writeFile(join(source, "deploy", "compose.rollback-legacy.yml"), committedCompose),
    writeFile(join(source, "deploy", "deployment-state.sh"), "# fixture state controls\n"),
    writeFile(
      join(source, "deploy", "resolve-pending-deployment-on-vps.sh"),
      "#!/bin/sh\n# fixture pending resolver\n",
    ),
    writeFile(join(source, "deploy", "rollback-on-vps.sh"), "# fixture rollback controls\n"),
    writeFile(
      join(source, "deploy", "watch-pending-deployment-on-vps.sh"),
      "#!/bin/sh\n# fixture pending watchdog\n",
    ),
    writeFile(join(source, "deploy", "backup", "README.md"), "fixture backup controls\n"),
    writeFile(join(source, "deploy", "migrations", "001_fixture.sql"), "select 1;\n"),
  ]);
  runGit(["init", "--bare", remote]);
  runGit(["init", "--initial-branch=main"], source);
  runGit(["config", "user.email", "deploy-fixture@invalid.example"], source);
  runGit(["config", "user.name", "Deployment Fixture"], source);
  runGit(["add", "."], source);
  runGit(["-c", "commit.gpgsign=false", "commit", "-m", "previous"], source);
  const previousRevision = runGit(["rev-parse", "HEAD"], source);
  runGit(["remote", "add", "origin", remote], source);
  runGit(["push", "--set-upstream", "origin", "main"], source);
  await writeFile(join(source, "Dockerfile"), candidateDockerfile);
  runGit(["add", "Dockerfile"], source);
  runGit(["-c", "commit.gpgsign=false", "commit", "-m", "candidate"], source);
  const candidateRevision = runGit(["rev-parse", "HEAD"], source);
  runGit(["push", "origin", "main"], source);

  const imageArchive = join(artifactDir, "handleplan-image.docker.tar");
  const tarResult = spawnSync("tar", ["-cf", imageArchive, "-C", imageTree, "."], {
    encoding: "utf8",
  });
  if (tarResult.status !== 0) throw new Error(`fixture tar failed: ${tarResult.stderr}`);
  await Promise.all([
    writeFile(join(artifactDir, "handleplan.provenance.json"), "{}\n"),
    writeFile(join(artifactDir, "handleplan.spdx.json"), "{}\n"),
  ]);

  const fixture = {
    appRoot,
    appState: join(root, "app-present"),
    artifactDir,
    bin,
    buildContextRecord: join(root, "build-context"),
    candidateRevision,
    deployScript: deploy,
    dockerLog: join(root, "docker.log"),
    imageId: `sha256:${"b".repeat(64)}`,
    operationsState: join(root, "operations-present"),
    previousImageId: `sha256:${"e".repeat(64)}`,
    previousRevision,
    remote,
    reviewState: join(root, "review-present"),
    root,
    source,
    workerState: join(root, "worker-present"),
  };
  writeCommittedDeploymentState(
    fixture,
    fixture.previousRevision,
    fixture.previousImageId,
  );
  writeDeploymentBundle(fixture, candidateRevision);
  return fixture;
}

function writeCommittedDeploymentState(
  fixture: DeploymentFixture,
  revision: string,
  imageId: string,
  highWaterRevision: string = revision,
): void {
  const stateDir = join(fixture.appRoot, "state");
  const verifiedDir = join(stateDir, "verified-images");
  mkdirSync(verifiedDir, { recursive: true });
  writeFileSync(join(stateDir, "current-deployment"), `v1 ${revision} current\n`);
  writeFileSync(join(stateDir, "current-revision"), `${revision}\n`);
  writeFileSync(join(stateDir, "current-image-id"), `${imageId}\n`);
  writeFileSync(join(stateDir, "deployment-high-water"), `${highWaterRevision}\n`);
  writeFileSync(join(verifiedDir, revision), `v1 ${revision} ${imageId}\n`);
}

function writeDeploymentBundle(
  fixture: DeploymentFixture,
  revision: string,
  imageId: string = fixture.imageId,
): void {
  const imageArchive = join(fixture.artifactDir, "handleplan-image.docker.tar");
  const sourceArchive = join(fixture.artifactDir, "handleplan-source.tar");
  const provenance = join(fixture.artifactDir, "handleplan.provenance.json");
  const sbom = join(fixture.artifactDir, "handleplan.spdx.json");
  runGit([
    "archive",
    "--format=tar",
    `--output=${sourceArchive}`,
    revision,
  ], fixture.source);
  writeFileSync(join(fixture.artifactDir, "handleplan-image-bundle.v1"), [
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
    "ci_run_attempt=1",
    "",
  ].join("\n"));
}

function stageDeploymentBundle(fixture: DeploymentFixture, revision: string): string {
  const bundleLeaf = join(
    fixture.appRoot,
    "deploy-bundles",
    revision,
    "12345-1",
    "98765-1",
  );
  const bundleImage = join(bundleLeaf, "image");
  mkdirSync(bundleImage, { recursive: true });
  copyFileSync(deploy, join(bundleLeaf, "deploy-on-vps.sh"));
  copyFileSync(deploymentState, join(bundleLeaf, "deployment-state.sh"));
  chmodSync(join(bundleLeaf, "deploy-on-vps.sh"), 0o755);
  for (const artifact of [
    "handleplan-image-bundle.v1",
    "handleplan-image.docker.tar",
    "handleplan-source.tar",
    "handleplan.provenance.json",
    "handleplan.spdx.json",
  ]) {
    copyFileSync(join(fixture.artifactDir, artifact), join(bundleImage, artifact));
  }
  const leaseExpires = Math.floor(Date.now() / 1000) + 10_800;
  writeFileSync(
    join(bundleLeaf, ".lease.v1"),
    `v1 ${revision} 12345 1 98765 1 ${leaseExpires}\n`,
  );
  return join(bundleLeaf, "deploy-on-vps.sh");
}

async function installFakeDocker(fixture: DeploymentFixture): Promise<void> {
  const fakeDocker = join(fixture.bin, "docker");
  await writeFile(fakeDocker, `#!/bin/sh
set -eu
printf '%s|%s\\n' "\${APP_COMMIT_SHA:-none}" "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  "image load --input "*)
    exit 0
    ;;
  image*)
    inspected_reference=""
    for argument in "$@"; do inspected_reference=$argument; done
    case "$*" in
      *"handleplan:$FAKE_CANDIDATE_REVISION"*)
        case "$*" in
          *"{{.Id}}"*) printf '%s\\n' "$FAKE_IMAGE_ID" ;;
          *"{{.Os}}/{{.Architecture}}"*) printf '%s\\n' "$FAKE_CANDIDATE_PLATFORM" ;;
          *"org.opencontainers.image.revision"*) printf '%s\\n' "$FAKE_CANDIDATE_REVISION" ;;
          *) exit 94 ;;
        esac
        exit 0
        ;;
    esac
    if [ "$inspected_reference" = "$FAKE_PREVIOUS_IMAGE_ID" ]; then
      case "$FAKE_PREVIOUS_IMAGE" in
        verified)
          case "$*" in
            *"{{.Id}}"*) printf '%s\\n' "$FAKE_PREVIOUS_IMAGE_ID" ;;
            *"org.opencontainers.image.revision"*) printf '%s\\n' "$FAKE_PREVIOUS_REVISION" ;;
            *) exit 93 ;;
          esac
          exit 0
          ;;
        wrong-label)
          case "$*" in
            *"{{.Id}}"*) printf '%s\\n' "$FAKE_PREVIOUS_IMAGE_ID" ;;
            *"org.opencontainers.image.revision"*)
              printf '%s\\n' 0000000000000000000000000000000000000000
              ;;
            *) exit 92 ;;
          esac
          exit 0
          ;;
        missing) exit 1 ;;
      esac
    fi
    exit 98
    ;;
  *" config")
    compose_file=""
    previous_argument=""
    for argument in "$@"; do
      if [ "$previous_argument" = -f ]; then compose_file=$argument; fi
      previous_argument=$argument
    done
    test -n "$compose_file"
    test "$compose_file" != "$FAKE_SOURCE_DIR/deploy/compose.production.yml"
    grep -F 'committed-compose' "$compose_file" >/dev/null
    deployment_context=\${compose_file%/deploy/compose.production.yml}
    test ! -e "$deployment_context/untracked-secret.txt"
    test ! -e "$deployment_context/ignored-secret.txt"
    printf '%s\\n' "$deployment_context" > "$FAKE_BUILD_CONTEXT_RECORD"
    case "$FAKE_COMPOSE_CONFIG_MODE" in
      pass) exit 0 ;;
      fail) exit 1 ;;
      *) exit 95 ;;
    esac
    ;;
  *" stop review"|*" stop operations"|*" stop worker"|*" stop app") exit 0 ;;
  *" rm -f review") rm -f "$FAKE_REVIEW_STATE"; exit 0 ;;
  *" rm -f operations") rm -f "$FAKE_OPERATIONS_STATE"; exit 0 ;;
  *" rm -f worker") rm -f "$FAKE_WORKER_STATE"; exit 0 ;;
  *" rm -f app") rm -f "$FAKE_APP_STATE"; exit 0 ;;
  *" ps -aq review") test ! -f "$FAKE_REVIEW_STATE" || printf '%s\\n' review-container; exit 0 ;;
  *" ps -aq operations") test ! -f "$FAKE_OPERATIONS_STATE" || printf '%s\\n' operations-container; exit 0 ;;
  *" ps -aq worker") test ! -f "$FAKE_WORKER_STATE" || printf '%s\\n' worker-container; exit 0 ;;
  *" ps -aq app") test ! -f "$FAKE_APP_STATE" || printf '%s\\n' app-container; exit 0 ;;
  *" run --rm migrate") exit 0 ;;
  *" up -d --wait --remove-orphans --no-deps app review operations worker")
    printf '%s\\n' "$APP_COMMIT_SHA" > "$FAKE_APP_STATE"
    printf '%s\\n' "$APP_COMMIT_SHA" > "$FAKE_REVIEW_STATE"
    printf '%s\\n' "$APP_COMMIT_SHA" > "$FAKE_OPERATIONS_STATE"
    printf '%s\\n' "$APP_COMMIT_SHA" > "$FAKE_WORKER_STATE"
    case "$FAKE_CANDIDATE_UP_MODE" in
      signal) kill -TERM "$PPID"; exit 0 ;;
      fail) exit 1 ;;
      *) exit 96 ;;
    esac
    ;;
  *" up -d --wait --remove-orphans app")
    printf '%s\\n' "$APP_COMMIT_SHA" > "$FAKE_APP_STATE"
    exit 0
    ;;
esac
printf '%s\\n' "Unexpected docker call: $*" >&2
exit 97
`);
  await chmod(fakeDocker, 0o755);
  const fakeMv = join(fixture.bin, "mv");
  await writeFile(fakeMv, `#!/bin/sh
set -eu
if [ "$#" -eq 3 ] && [ "$1" = -Tf ]; then
  exec /bin/mv -f "$2" "$3"
fi
exec /bin/mv "$@"
`);
  await chmod(fakeMv, 0o755);
}

function runDeployment(
  fixture: DeploymentFixture,
  revision: string,
  previousImage: "missing" | "verified" | "wrong-label" = "verified",
  candidateUpMode: "fail" | "signal" = "fail",
  composeConfigMode: "fail" | "pass" = "pass",
  candidatePlatform: "linux/amd64" | "linux/arm64" = "linux/amd64",
) {
  const deploymentImageId = revision === fixture.previousRevision
    ? fixture.previousImageId
    : fixture.imageId;
  writeDeploymentBundle(fixture, revision, deploymentImageId);
  const deployScript = stageDeploymentBundle(fixture, revision);
  const manifestSha256 = sha256(
    join(fixture.artifactDir, "handleplan-image-bundle.v1"),
  );
  const stateDir = join(fixture.appRoot, "state");
  const previousRevision = readFileSync(join(stateDir, "current-revision"), "utf8").trim();
  const previousImageId = readFileSync(join(stateDir, "current-image-id"), "utf8").trim();
  const pendingToken = "f".repeat(64);
  return spawnSync(deployScript, [
    revision,
    "12345",
    "1",
    manifestSha256,
    pendingToken,
    previousRevision,
    previousImageId,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_APP_STATE: fixture.appState,
      FAKE_BUILD_CONTEXT_RECORD: fixture.buildContextRecord,
      FAKE_CANDIDATE_UP_MODE: candidateUpMode,
      FAKE_CANDIDATE_PLATFORM: candidatePlatform,
      FAKE_COMPOSE_CONFIG_MODE: composeConfigMode,
      FAKE_CANDIDATE_REVISION: revision,
      FAKE_DOCKER_LOG: fixture.dockerLog,
      FAKE_IMAGE_ID: deploymentImageId,
      FAKE_OPERATIONS_STATE: fixture.operationsState,
      FAKE_PREVIOUS_IMAGE: previousImage,
      FAKE_PREVIOUS_IMAGE_ID: previousImageId,
      FAKE_PREVIOUS_REVISION: previousRevision,
      FAKE_REVIEW_STATE: fixture.reviewState,
      FAKE_SOURCE_DIR: fixture.source,
      FAKE_WORKER_STATE: fixture.workerState,
      HANDLEPLAN_APP_ROOT: fixture.appRoot,
      HANDLEPLAN_REPOSITORY_URL: fixture.remote,
      PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
    },
  });
}

describe("production runtime deployment", () => {
  it("builds one immutable worker artifact into the application image", async () => {
    const source = await readFile(dockerfile, "utf8");

    expect(source).toContain("COPY apps/worker/package.json apps/worker/package.json");
    expect(source).toContain("pnpm --filter @handleplan/worker build");
    expect(source).toContain("/app/apps/worker/dist/main.mjs");
    expect(source).not.toContain("/app/apps/web/public ./apps/web/public");
    expect(source).toContain(
      "/app/apps/web/.next/standalone ./",
    );
    expect(source).toContain(
      "/app/apps/web/.next/handleplan-public-build-binding.json ./apps/web/.next/handleplan-public-build-binding.json",
    );
    expect(source).toContain('org.opencontainers.image.revision="$APP_COMMIT_SHA"');
    expect(source).toContain(
      "install -d -o nextjs -g nodejs -m 0700 /var/lib/handleplan/private-captures",
    );
  });

  it("deploys a hardened worker after migrations with conditional access by default", async () => {
    const source = await readFile(compose, "utf8");

    expect(source).toMatch(/worker:[\s\S]*entrypoint:[\s\S]*apps\/worker\/dist\/main\.mjs/);
    expect(source).toMatch(/worker:[\s\S]*migrate:[\s\S]*condition: service_completed_successfully/);
    expect(source).toContain("KASSAL_SOURCE_ACCESS: ${KASSAL_SOURCE_ACCESS:-conditional}");
    expect(source).toContain('OFFICIAL_OFFER_FOUNDATION_ENABLED: "false"');
    expect(source).toContain(
      "OFFICIAL_OFFER_PRIVATE_CAPTURE_ROOT: /var/lib/handleplan/private-captures",
    );
    expect(source).toMatch(/worker:[\s\S]*read_only: true/);
    expect(source).toMatch(/worker:[\s\S]*cap_drop:[\s\S]*- ALL/);
    expect(source).toMatch(/worker:[\s\S]*stop_grace_period: 45s/);
    expect(source).toMatch(/worker:[\s\S]*APP_COMMIT_SHA: \$\{APP_COMMIT_SHA:/);
    expect(source).toMatch(
      /worker:[\s\S]*healthcheck:[\s\S]*127\.0\.0\.1:3005\/health[\s\S]*ready/,
    );
    expect(source).toMatch(
      /app:[\s\S]*DATABASE_URL: postgresql:\/\/handleplan_web:\$\{WEB_DATABASE_PASSWORD:/,
    );
    expect(source).toMatch(
      /review:[\s\S]*REVIEW_DATABASE_URL: postgresql:\/\/handleplan_review:\$\{REVIEW_DATABASE_PASSWORD:/,
    );
    expect(source).toMatch(
      /worker:[\s\S]*DATABASE_URL: postgresql:\/\/handleplan_app:\$\{APP_DATABASE_PASSWORD:/,
    );
    expect(source).toMatch(/migrate:[\s\S]*WEB_DATABASE_PASSWORD:/);
    expect(source).toMatch(/migrate:[\s\S]*REVIEW_DATABASE_PASSWORD:/);
    expect(source).toMatch(/migrate:[\s\S]*OPERATIONS_DATABASE_PASSWORD:/);
    const appBlock = composeServiceBlock(source, "app");
    const reviewBlock = composeServiceBlock(source, "review");
    const operationsBlock = composeServiceBlock(source, "operations");
    expect(appBlock).toBeDefined();
    expect(reviewBlock).toBeDefined();
    expect(operationsBlock).toBeDefined();
    for (const variable of [
      "REVIEW_ACCESS_AUDIENCE",
      "REVIEW_ACCESS_ISSUER",
      "REVIEW_ACCESS_TEAM_DOMAIN",
      "REVIEW_BASE_URL",
      "REVIEW_EVIDENCE_PROOF_SECRET",
    ]) {
      expect(reviewBlock).toContain(`${variable}: \${${variable}:?${variable} is required}`);
    }
    expect(appBlock).not.toMatch(/^\s+REVIEW_[A-Z0-9_]+:/mu);
    expect(reviewBlock).not.toMatch(/^\s+DATABASE_URL:/mu);
    expect(reviewBlock).toContain(
      "REVIEW_PRIVATE_CAPTURE_ROOT: /var/lib/handleplan/private-captures",
    );
    expect(appBlock).not.toContain("KASSAL_API_KEY");
    expect(appBlock).not.toContain("KASSAL_BASE_URL");
    expect(appBlock).not.toContain("KASSAL_MODE");
    expect(source).toMatch(/worker:[\s\S]*KASSAL_API_KEY:/);
    const workerBlock = composeServiceBlock(source, "worker");
    expect(workerBlock).toBeDefined();
    expect(workerBlock).not.toMatch(/\n    ports:/);
    expect(workerBlock).toMatch(
      /source: private-captures[\s\S]*target: \/var\/lib\/handleplan\/private-captures[\s\S]*read_only: false/u,
    );
    expect(reviewBlock).toMatch(
      /source: private-captures[\s\S]*target: \/var\/lib\/handleplan\/private-captures[\s\S]*read_only: true/u,
    );
    expect(workerBlock).not.toContain("REVIEW_EVIDENCE_PROOF_SECRET");
    expect(workerBlock).not.toContain("REVIEW_PRIVATE_CAPTURE_ROOT");
    expect(appBlock).not.toContain("private-captures");
    expect(appBlock).not.toContain("REVIEW_EVIDENCE_PROOF_SECRET");
    expect(appBlock).not.toContain("REVIEW_PRIVATE_CAPTURE_ROOT");
    for (const variable of [
      "OPERATIONS_ACCESS_AUDIENCE",
      "OPERATIONS_ACCESS_ISSUER",
      "OPERATIONS_ACCESS_TEAM_DOMAIN",
      "OPERATIONS_BASE_URL",
      "OPERATIONS_SOURCE_ROSTER_JSON",
    ]) {
      expect(operationsBlock).toContain(
        `${variable}: \${${variable}:?${variable} is required}`,
      );
    }
    expect(operationsBlock).toContain(
      "OPERATIONS_DATABASE_URL: postgresql://handleplan_operations:${OPERATIONS_DATABASE_PASSWORD:?OPERATIONS_DATABASE_PASSWORD is required}@postgres:5432/handleplan",
    );
    expect(operationsBlock).toContain('OPERATIONS_ALERT_EVALUATION_ENABLED: "false"');
    expect(operationsBlock).toContain("api/internal/health/operations");
    expect(operationsBlock).toContain("handleplan-operations-health-v1");
    expect(operationsBlock).toContain("response.status!==200");
    expect(operationsBlock).toContain("body.database?.role!=='handleplan_operations'");
    expect(operationsBlock).not.toContain("api/internal/operations/snapshot");
    expect(operationsBlock).toContain(
      "'028_private_review_image_evidence_only.sql'",
    );
    expect(operationsBlock).toContain('"127.0.0.1:3007:3000"');
    expect(operationsBlock).not.toContain("private-captures");
    expect(operationsBlock).not.toMatch(/^\s+REVIEW_[A-Z0-9_]+:/mu);
    expect(appBlock).not.toMatch(/^\s+OPERATIONS_[A-Z0-9_]+:/mu);
    expect(reviewBlock).not.toMatch(/^\s+OPERATIONS_[A-Z0-9_]+:/mu);
    expect(workerBlock).not.toMatch(/^\s+OPERATIONS_[A-Z0-9_]+:/mu);
    expect(source).toMatch(/volumes:\n  private-captures:\n  postgres-data:/u);
  });

  it("requires exact internal worker readback before recording a deployment", async () => {
    const [script, rollback, documentation, deploymentWorkflow, continuousIntegration] =
      await Promise.all([
        readFile(deploy, "utf8"),
        readFile(rollbackCompose, "utf8"),
        readFile(runbook, "utf8"),
        readFile(workflow, "utf8"),
        readFile(ciWorkflow, "utf8"),
      ]);

    expect(script).toContain("exec -T worker wget -qO- http://127.0.0.1:3005/health");
    expect(script).toContain('\\"revision\\":\\"$target_revision\\"');
    expect(script).toContain("\"ready\":true");
    expect(script).toContain("\"completedCycles\":[1-9][0-9]*");
    expect(script).toContain("\"lastCycle\":{");
    expect(script).toContain("\"leaseAcquired\":true");
    expect(script).toContain("{{.RestartCount}}");
    expect(script).toContain('load_deployment_state "$state_dir"');
    expect(script.indexOf("verify_current_deployment \"$revision\"")).toBeLessThan(
      script.indexOf("record_immutable_deployment_state"),
    );
    expect(script).toContain("+refs/heads/main:refs/remotes/origin/main");
    expect(script).toContain('rev-parse --verify "$revision^{commit}"');
    expect(script).toContain('"$revision" refs/remotes/origin/main');
    expect(script).toContain('"$previous_revision" refs/remotes/origin/main');
    expect(script).toContain('"$deployment_high_water_revision" "$revision"');
    expect(script).toContain("refusing out-of-order CI");
    expect(script).toContain("max_source_archive_bytes=134217728");
    expect(script).toContain("max_image_archive_bytes=2147483648");
    expect(script).toContain('source_archive="$bundle_dir/handleplan-source.tar"');
    expect(script).toContain('tar -xf "$source_archive" -C "$deployment_source_dir"');
    expect(script).toContain('docker image load --input "$image_archive"');
    expect(script).toContain('test "$loaded_image_id" = "$expected_image_id"');
    expect(script).toContain(
      'deploy "$revision" "$revision" current "$loaded_image_id" "$loaded_image_id"',
    );
    expect(script).toContain("Revision is already bound to a different immutable image");
    expect(script).toContain('test "$app_image" = "$target_image"');
    expect(script).toContain('test "$worker_image" = "$target_image"');
    expect(script).toContain('"$deployment_source_dir"');
    expect(continuousIntegration).toContain(
      "Prove the packaged migrator and worker from the exact image",
    );
    expect(continuousIntegration).toContain(
      '"$EXPECTED_IMAGE_ID" /app/deploy/migrate.mjs',
    );
    expect(continuousIntegration).toContain(
      '"$EXPECTED_IMAGE_ID" /app/apps/worker/dist/main.mjs',
    );
    expect(continuousIntegration).toContain("KASSAL_SOURCE_ACCESS=blocked");
    expect(continuousIntegration).toContain(
      "KASSAL_BASE_URL=https://127.0.0.1:1",
    );
    expect(continuousIntegration).toContain(".scheduler.completedCycles >= 1");
    expect(continuousIntegration).toContain(".scheduler.failedCycles == 0");
    expect(continuousIntegration).toContain(
      ".scheduler.lastCycle.leaseAcquired == true",
    );
    expect(
      continuousIntegration.indexOf(
        "Prove the packaged migrator and worker from the exact image",
      ),
    ).toBeGreaterThan(
      continuousIntegration.indexOf("Validate deployment assets"),
    );
    expect(
      continuousIntegration.indexOf("run: corepack pnpm e2e:image"),
    ).toBeGreaterThan(
      continuousIntegration.indexOf(
        "Prove the packaged migrator and worker from the exact image",
      ),
    );
    const composePreflightIndex = script.indexOf("config >/dev/null");
    expect(composePreflightIndex).toBeGreaterThanOrEqual(0);
    expect(composePreflightIndex).toBeLessThan(
      script.indexOf('docker image load --input "$image_archive"'),
    );
    expect(script).not.toContain('checkout --detach "$revision"');
    expect(script).not.toContain("docker build");
    expect(script).not.toContain('$source_dir/deploy/compose');
    expect(script).toContain('if [ "$compatibility_mode" = "legacy" ]');
    expect(script).not.toContain(
      'deploy "$previous_revision" "$revision" legacy-rollback',
    );
    expect(script).toContain('stop "$runtime_service"');
    expect(script).toContain('rm -f "$runtime_service"');
    expect(script).toContain('ps -aq "$runtime_service"');
    expect(script).toContain(
      "Legacy rollback could not prove private runtimes and worker absent",
    );
    expect(script).toContain(
      "Deployment refused to migrate without proof that review, operations, and worker are absent",
    );
    expect(script).toContain('verify_review_runtime "$target_revision"');
    expect(script).toContain('verify_operations_runtime "$target_revision"');
    expect(script).toContain("ps -q review");
    expect(script).toContain("review_restarts");
    expect(script).toContain("review_health");
    expect(script).toContain("review_image");
    expect(script).toContain("review_revision");
    expect(script).toContain("org.opencontainers.image.revision");
    expect(script).toContain('test "$review_state" = "running"');
    expect(script).toContain('test "$review_restarts" = "0"');
    expect(script).toContain('test "$review_health" = "healthy"');
    expect(script).toContain('test "$review_image" = "$target_image"');
    expect(script).toContain('test "$review_revision" = "$target_revision"');
    expect(script.match(/verify_review_runtime "\$target_revision"/gu)).toHaveLength(2);
    expect(script.match(/verify_operations_runtime "\$target_revision"/gu)).toHaveLength(2);
    expect(script.lastIndexOf('verify_review_runtime "$target_revision"')).toBeGreaterThan(
      script.indexOf('"leaseAcquired":true'),
    );
    expect(script.lastIndexOf('verify_review_runtime "$target_revision"')).toBeLessThan(
      script.indexOf("record_immutable_deployment_state"),
    );
    const legacyBlock = script.match(
      /if \[ "\$compatibility_mode" = "legacy" \]; then([\s\S]*?)\n  fi/u,
    )?.[1];
    expect(legacyBlock).toBeDefined();
    expect(legacyBlock).toContain('remove_runtime_services "$target_revision" "$migration_revision"');
    expect(legacyBlock).toContain("review operations worker || return 1");
    const currentModeIndex = script.indexOf(
      'test "$compatibility_mode" = "current"',
    );
    const currentMigrationStartIndex = script.indexOf(
      "run --rm migrate",
      currentModeIndex,
    );
    const currentRuntimeStartIndex = script.indexOf(
      "up -d --wait --remove-orphans --no-deps app review operations worker",
      currentMigrationStartIndex,
    );
    expect(currentModeIndex).toBeGreaterThanOrEqual(0);
    expect(currentMigrationStartIndex).toBeGreaterThan(currentModeIndex);
    expect(currentRuntimeStartIndex).toBeGreaterThan(currentMigrationStartIndex);
    const operationsActivationIndex = script.indexOf(
      "activate_operations_release ||",
      currentMigrationStartIndex,
    );
    expect(operationsActivationIndex).toBeGreaterThan(currentMigrationStartIndex);
    expect(operationsActivationIndex).toBeLessThan(currentRuntimeStartIndex);
    const preMigrationCleanupIndex = script.indexOf(
      'remove_runtime_services "$target_revision" "$migration_revision"',
      currentModeIndex,
    );
    expect(preMigrationCleanupIndex).toBeGreaterThan(currentModeIndex);
    expect(preMigrationCleanupIndex).toBeLessThan(currentMigrationStartIndex);
    const preMigrationCleanupBlock = script.slice(
      preMigrationCleanupIndex,
      currentMigrationStartIndex,
    );
    expect(preMigrationCleanupBlock).toContain("review operations worker || return 1");
    expect(script.indexOf("private_migration_gate_failed=1", currentModeIndex))
      .toBeLessThan(currentMigrationStartIndex);
    expect(script.indexOf("private_runtimes_quiesced_for_deploy=1", currentModeIndex))
      .toBeLessThan(currentMigrationStartIndex);
    expect(script.indexOf("private_migration_gate_failed=0", currentMigrationStartIndex))
      .toBeLessThan(currentRuntimeStartIndex);
    expect(script.indexOf("private_runtimes_absent=1", currentModeIndex))
      .toBeLessThan(currentMigrationStartIndex);
    const migrationFailureGuardIndex = script.indexOf(
      'if [ "$private_migration_gate_failed" -eq 1 ]',
    );
    expect(migrationFailureGuardIndex).toBeGreaterThan(currentRuntimeStartIndex);
    expect(script).toContain(
      "Private runtime migration gate failed; leaving review, operations, and worker down and preserving the running public app",
    );
    const quiescedFailureGuardIndex = script.indexOf(
      'if [ "$private_runtimes_quiesced_for_deploy" -eq 1 ]',
      migrationFailureGuardIndex,
    );
    expect(quiescedFailureGuardIndex).toBeGreaterThan(migrationFailureGuardIndex);
    const quiescedFailureBlock = script.slice(
      quiescedFailureGuardIndex,
      script.indexOf("record_immutable_deployment_state", quiescedFailureGuardIndex),
    );
    expect(quiescedFailureBlock).toContain("cleanup_failed_candidate_runtime || exit 1");
    const failedCandidateCleanupBlock = script.match(
      /cleanup_failed_candidate_runtime\(\) \{([\s\S]*?)\n\}/u,
    )?.[1];
    expect(failedCandidateCleanupBlock).toBeDefined();
    const cleanupIndex = failedCandidateCleanupBlock?.indexOf(
      'remove_runtime_services "$revision" "$revision"',
    ) ?? -1;
    const publicOnlyRollbackIndex = failedCandidateCleanupBlock?.indexOf(
      'deploy "$previous_revision" "$revision" legacy',
    ) ?? -1;
    expect(cleanupIndex).toBeGreaterThanOrEqual(0);
    expect(failedCandidateCleanupBlock).toContain(
      "review operations worker app || return 1",
    );
    expect(publicOnlyRollbackIndex).toBeGreaterThan(cleanupIndex);
    expect(failedCandidateCleanupBlock).toContain(
      "Failed deployment could not prove private runtimes, worker, and app absent; fallback refused",
    );
    expect(failedCandidateCleanupBlock).toContain("org.opencontainers.image.revision");
    expect(failedCandidateCleanupBlock).toContain(
      "Deployment failed; restoring only the public app from $previous_revision",
    );
    expect(failedCandidateCleanupBlock).toContain(
      "Deployment failed; no verified prior image, leaving all candidate runtimes down",
    );
    expect(script).not.toContain(
      'deploy "$previous_revision" "$revision" "$previous_compatibility_mode"',
    );
    expect(rollback).not.toContain("worker:");
    expect(rollback).toContain("postgresql://handleplan_web:");
    expect(rollback).toContain("KASSAL_API_KEY: legacy-rollback-network-disabled");
    expect(rollback).toContain("KASSAL_BASE_URL: https://127.0.0.1:1");
    expect(rollback).toContain("KASSAL_MODE: real");
    expect(rollback).not.toContain("${KASSAL_API_KEY");
    expect(rollback).not.toContain("postgresql://handleplan_app:");
    expect(rollback).not.toContain("https://kassal.app/");
    expect(rollback).toContain(
      "PRICE_EVIDENCE_READ_MODEL: ${PRICE_EVIDENCE_READ_MODEL:-legacy}",
    );
    expect(documentation).toContain("127.0.0.1:3005/health");
    expect(documentation).toContain("Source degradation");
    expect(deploymentWorkflow).toContain("timeout-minutes: 120");
    expect(deploymentWorkflow).not.toContain("workflow_dispatch");
    expect(deploymentWorkflow).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(deploymentWorkflow).toContain("github.event.workflow_run.event == 'push'");
    expect(deploymentWorkflow).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(deploymentWorkflow).toContain(
      "github.event.workflow_run.head_repository.full_name == github.repository",
    );
    expect(deploymentWorkflow).toContain(
      "DEPLOY_SHA: ${{ github.event.workflow_run.head_sha }}",
    );
    expect(deploymentWorkflow).not.toContain("github.sha");
    expect(continuousIntegration).toContain(
      "caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d",
    );
    expect(continuousIntegration).toContain(
      "caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile",
    );
    expect(script).not.toContain("REVIEW_EVIDENCE_PROOF_SECRET");
    for (const transferredControl of [
      "deploy/cleanup-deployment-bundle-on-vps.sh",
      "deploy/deploy-on-vps.sh",
      "deploy/deployment-state.sh",
      "deploy/resolve-pending-deployment-on-vps.sh",
      "deploy/watch-pending-deployment-on-vps.sh",
    ]) {
      expect(deploymentWorkflow).toContain(transferredControl);
    }
    expect(deploymentWorkflow).toContain(
      "'$remote_bundle/deploy-on-vps.sh' '$DEPLOY_SHA' '$CI_RUN_ID' '$CI_RUN_ATTEMPT' '$EXPECTED_BUNDLE_MANIFEST_SHA256' '$PENDING_DEPLOYMENT_TOKEN' '$PREVIOUS_REVISION' '$PREVIOUS_IMAGE_ID'",
    );
    expect(deploymentWorkflow).toContain(
      "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
    );
    expect(continuousIntegration).toContain(
      "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    );
    expect(deploymentWorkflow).not.toContain("sh -s --");
    expect(deploymentWorkflow).toContain(
      "current-deployment)\\\" = 'v1 $DEPLOY_SHA current'",
    );
  });

  // This is a real shell/Git/archive deployment integration fixture. It is
  // quick in isolation, but shares CPU and filesystem bandwidth with the
  // rollback fixtures during the full Vitest run.
  it("loads only bounded exact CI artifacts and preserves the immutable predecessor", async () => {
    const fixture = await createDeploymentFixture("handleplan-exact-archive-");
    try {
      await Promise.all([
        writeFile(join(fixture.source, "Dockerfile"), "DIRTY WORKTREE\n"),
        writeFile(
          join(fixture.source, "deploy", "compose.production.yml"),
          "# DIRTY COMPOSE\n",
        ),
        writeFile(join(fixture.source, "untracked-secret.txt"), "untracked\n"),
        writeFile(join(fixture.source, "ignored-secret.txt"), "ignored\n"),
        installFakeDocker(fixture),
      ]);

      const result = runDeployment(fixture, fixture.candidateRevision);
      const calls = (await readFile(fixture.dockerLog, "utf8")).trim().split("\n");
      const buildContext = (await readFile(fixture.buildContextRecord, "utf8")).trim();
      const bundleManifest = await readFile(
        join(fixture.artifactDir, "handleplan-image-bundle.v1"),
        "utf8",
      );
      const sourceArchiveSha256 = bundleManifest.match(
        /^source_archive_sha256=([0-9a-f]{64})$/mu,
      )?.[1];
      const migrationIndex = calls.findIndex((call) => call.endsWith(" run --rm migrate"));
      const candidateStartIndex = calls.findIndex((call) => call.endsWith(
        " up -d --wait --remove-orphans --no-deps app review operations worker",
      ));

      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(
        `Deployment failed; restoring only the public app from ${fixture.previousRevision}`,
      );
      expect(buildContext).not.toBe(fixture.source);
      expect(sourceArchiveSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(await readFile(
        join(fixture.appRoot, "operations", "current", "release.v1"),
        "utf8",
      )).toBe(`v1 ${fixture.candidateRevision} ${sourceArchiveSha256}\n`);
      expect(await readFile(
        join(fixture.appRoot, "state", "current-deployment"),
        "utf8",
      )).toBe(`v1 ${fixture.previousRevision} current\n`);
      expect(await readFile(
        join(fixture.appRoot, "state", "deployment-high-water"),
        "utf8",
      )).toBe(`${fixture.previousRevision}\n`);
      expect(migrationIndex).toBeGreaterThanOrEqual(0);
      expect(candidateStartIndex).toBeGreaterThan(migrationIndex);
      expect(calls.some((call) => call.includes(`${fixture.source}/deploy/compose`))).toBe(false);
      expect(calls).toContainEqual(expect.stringMatching(
        new RegExp(`^${fixture.candidateRevision}\\|.* up -d --wait --remove-orphans --no-deps app review operations worker$`, "u"),
      ));
      for (const runtimeState of [
        fixture.reviewState,
        fixture.operationsState,
        fixture.workerState,
      ]) {
        await expect(readFile(runtimeState, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(await readFile(fixture.appState, "utf8"))
        .toBe(`${fixture.previousRevision}\n`);
      await expect(readFile(join(buildContext, "Dockerfile"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  }, 20_000);

  it("rejects a loaded arm64 candidate before migrations or runtime mutation", async () => {
    const fixture = await createDeploymentFixture("handleplan-arm64-candidate-");
    try {
      await installFakeDocker(fixture);
      const stateDir = join(fixture.appRoot, "state");
      const stateFiles = [
        "current-deployment",
        "current-revision",
        "current-image-id",
        "deployment-high-water",
      ];
      const stateBefore = await Promise.all(
        stateFiles.map((stateFile) => readFile(join(stateDir, stateFile), "utf8")),
      );

      const result = runDeployment(
        fixture,
        fixture.candidateRevision,
        "verified",
        "fail",
        "pass",
        "linux/arm64",
      );
      const calls = (await readFile(fixture.dockerLog, "utf8")).trim().split("\n");

      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(
        "Loaded image platform is not the supported linux/amd64 target",
      );
      expect(calls.some((call) => call.includes("image load --input"))).toBe(true);
      expect(calls.some((call) => call.includes("{{.Os}}/{{.Architecture}}"))).toBe(true);
      expect(calls.some((call) => call.endsWith(" run --rm migrate"))).toBe(false);
      expect(calls.some((call) => / (?:stop|rm -f) /u.test(call))).toBe(false);
      expect(calls.some((call) => call.includes(" up -d "))).toBe(false);
      await expect(Promise.all(
        stateFiles.map((stateFile) => readFile(join(stateDir, stateFile), "utf8")),
      )).resolves.toEqual(stateBefore);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("refuses an invalid candidate Compose model before image load or runtime quiesce", async () => {
    const fixture = await createDeploymentFixture("handleplan-compose-preflight-");
    try {
      await installFakeDocker(fixture);

      const result = runDeployment(
        fixture,
        fixture.candidateRevision,
        "missing",
        "fail",
        "fail",
      );
      const calls = (await readFile(fixture.dockerLog, "utf8")).trim().split("\n");

      expect(result.status, result.stderr).toBe(1);
      expect(calls.some((call) => call.endsWith(" config"))).toBe(true);
      expect(calls.some((call) => /\|build /u.test(call))).toBe(false);
      expect(calls.some((call) => / (?:stop|rm -f) /u.test(call))).toBe(false);
      for (const runtimeState of [
        fixture.reviewState,
        fixture.operationsState,
        fixture.workerState,
        fixture.appState,
      ]) {
        await expect(readFile(runtimeState, "utf8"))
          .rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("refuses a reused review/operations Access audience before any Docker action", async () => {
    const fixture = await createDeploymentFixture("handleplan-access-audience-preflight-");
    try {
      await Promise.all([
        writeFile(join(fixture.appRoot, "shared", "production.env"), [
          "REVIEW_ACCESS_AUDIENCE=shared-audience-0123456789abcdef",
          "OPERATIONS_ACCESS_AUDIENCE=shared-audience-0123456789abcdef",
          "",
        ].join("\n")),
        installFakeDocker(fixture),
      ]);

      const result = runDeployment(fixture, fixture.candidateRevision);

      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(
        "Review and operations Cloudflare Access audiences must be distinct",
      );
      await expect(readFile(fixture.dockerLog, "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("restores only a label-verified previous public app after candidate cleanup", async () => {
    const fixture = await createDeploymentFixture("handleplan-public-rollback-");
    try {
      await Promise.all([
        writeFile(
          join(fixture.appRoot, "state", "current-deployment"),
          `v1 ${fixture.previousRevision} current\n`,
        ),
        writeFile(
          join(fixture.appRoot, "state", "current-revision"),
          `${fixture.previousRevision}\n`,
        ),
        writeFile(fixture.appState, `${fixture.previousRevision}\n`),
        writeFile(fixture.reviewState, `${fixture.previousRevision}\n`),
        writeFile(fixture.operationsState, `${fixture.previousRevision}\n`),
        writeFile(fixture.workerState, `${fixture.previousRevision}\n`),
        installFakeDocker(fixture),
      ]);

      const result = runDeployment(fixture, fixture.candidateRevision, "verified");
      const calls = (await readFile(fixture.dockerLog, "utf8")).trim().split("\n");
      const candidateCleanupIndex = calls.findIndex((call) =>
        call.startsWith(`${fixture.candidateRevision}|`) && call.endsWith(" rm -f app"));
      const previousStartIndex = calls.findIndex((call) =>
        call.startsWith(`${fixture.previousRevision}|`) && call.endsWith(" up -d --wait --remove-orphans app"));

      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(
        `Deployment failed; restoring only the public app from ${fixture.previousRevision}`,
      );
      expect(candidateCleanupIndex).toBeGreaterThanOrEqual(0);
      expect(previousStartIndex).toBeGreaterThan(candidateCleanupIndex);
      expect(await readFile(fixture.appState, "utf8")).toBe(`${fixture.previousRevision}\n`);
      await expect(readFile(fixture.reviewState, "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(fixture.operationsState, "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(fixture.workerState, "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      expect(calls.filter((call) =>
        call.startsWith(`${fixture.previousRevision}|`)
        && / up .* (?:review|worker)(?: |$)/u.test(call))).toEqual([]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  }, 15_000);

  it("cleans an interrupted candidate and restores only the verified prior public app", async () => {
    const fixture = await createDeploymentFixture("handleplan-interrupted-deploy-");
    try {
      await Promise.all([
        writeFile(
          join(fixture.appRoot, "state", "current-deployment"),
          `v1 ${fixture.previousRevision} current\n`,
        ),
        writeFile(
          join(fixture.appRoot, "state", "current-revision"),
          `${fixture.previousRevision}\n`,
        ),
        writeFile(fixture.appState, `${fixture.previousRevision}\n`),
        writeFile(fixture.reviewState, `${fixture.previousRevision}\n`),
        writeFile(fixture.operationsState, `${fixture.previousRevision}\n`),
        writeFile(fixture.workerState, `${fixture.previousRevision}\n`),
        installFakeDocker(fixture),
      ]);

      const result = runDeployment(
        fixture,
        fixture.candidateRevision,
        "verified",
        "signal",
      );
      const calls = (await readFile(fixture.dockerLog, "utf8")).trim().split("\n");
      const buildContext = (await readFile(fixture.buildContextRecord, "utf8")).trim();
      const candidateStartIndex = calls.findIndex((call) =>
        call.startsWith(`${fixture.candidateRevision}|`)
        && call.endsWith(
          " up -d --wait --remove-orphans --no-deps app review operations worker",
        ));
      const candidateCleanupIndex = calls.findIndex((call) =>
        call.startsWith(`${fixture.candidateRevision}|`) && call.endsWith(" rm -f app"));
      const previousStartIndex = calls.findIndex((call) =>
        call.startsWith(`${fixture.previousRevision}|`)
        && call.endsWith(" up -d --wait --remove-orphans app"));

      expect(result.status, result.stderr).toBe(143);
      expect(result.stderr).toContain(
        "Deployment interrupted after candidate startup; removing every candidate runtime",
      );
      expect(result.stderr).toContain(
        `Deployment failed; restoring only the public app from ${fixture.previousRevision}`,
      );
      expect(candidateStartIndex).toBeGreaterThanOrEqual(0);
      expect(candidateCleanupIndex).toBeGreaterThan(candidateStartIndex);
      expect(previousStartIndex).toBeGreaterThan(candidateCleanupIndex);
      expect(await readFile(fixture.appState, "utf8")).toBe(`${fixture.previousRevision}\n`);
      await expect(readFile(fixture.reviewState, "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(fixture.operationsState, "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(fixture.workerState, "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(buildContext, "Dockerfile"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  }, 15_000);

  it.each(["missing", "wrong-label"] as const)(
    "keeps a failed candidate fully down when the recorded prior image is %s",
    async (priorImageState) => {
      const fixture = await createDeploymentFixture("handleplan-unverified-rollback-");
      try {
        await Promise.all([
          writeFile(
            join(fixture.appRoot, "state", "current-deployment"),
            `v1 ${fixture.previousRevision} current\n`,
          ),
          writeFile(
            join(fixture.appRoot, "state", "current-revision"),
            `${fixture.previousRevision}\n`,
          ),
          installFakeDocker(fixture),
        ]);

        const result = runDeployment(fixture, fixture.candidateRevision, priorImageState);
        const calls = (await readFile(fixture.dockerLog, "utf8")).trim().split("\n");

        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain(
          "Verified predecessor image is missing or differs from immutable deployment state",
        );
        expect(calls.some((call) =>
          / up -d --wait --remove-orphans app$/u.test(call))).toBe(false);
        for (const runtimeState of [
          fixture.reviewState,
          fixture.operationsState,
          fixture.workerState,
          fixture.appState,
        ]) {
          await expect(readFile(runtimeState, "utf8"))
            .rejects.toMatchObject({ code: "ENOENT" });
        }
      } finally {
        await rm(fixture.root, { force: true, recursive: true });
      }
    },
  );

  it("rejects a commit that is not reachable from origin/main before image load", async () => {
    const fixture = await createDeploymentFixture("handleplan-unreachable-revision-");
    try {
      runGit(["checkout", "-b", "side"], fixture.source);
      await writeFile(join(fixture.source, "Dockerfile"), "FROM scratch\nLABEL fixture=side\n");
      runGit(["add", "Dockerfile"], fixture.source);
      runGit(["-c", "commit.gpgsign=false", "commit", "-m", "side"], fixture.source);
      const sideRevision = runGit(["rev-parse", "HEAD"], fixture.source);
      runGit(["checkout", "main"], fixture.source);
      await installFakeDocker(fixture);

      const result = runDeployment(fixture, sideRevision);

      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(
        "Requested revision is not reachable from the fetched origin/main",
      );
      await expect(readFile(fixture.dockerLog, "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("rejects an out-of-order older CI completion before image load", async () => {
    const fixture = await createDeploymentFixture("handleplan-stale-ci-");
    try {
      writeCommittedDeploymentState(
        fixture,
        fixture.candidateRevision,
        fixture.imageId,
      );
      await installFakeDocker(fixture);

      const result = runDeployment(fixture, fixture.previousRevision);

      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(
        "Requested revision is older than the deployment high-water mark; refusing out-of-order CI",
      );
      await expect(readFile(fixture.dockerLog, "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("isolates private credentials and exact routes in distinct loopback processes", async () => {
    const [deployment, proxy] = await Promise.all([
      readFile(compose, "utf8"),
      readFile(caddyfile, "utf8"),
    ]);
    const appBlock = composeServiceBlock(deployment, "app");
    const reviewBlock = composeServiceBlock(deployment, "review");
    const operationsBlock = composeServiceBlock(deployment, "operations");

    expect(appBlock).toBeDefined();
    expect(reviewBlock).toBeDefined();
    expect(operationsBlock).toBeDefined();
    expect(appBlock).toContain("image: ${HANDLEPLAN_IMAGE:?HANDLEPLAN_IMAGE is required}");
    expect(reviewBlock).toContain("image: ${HANDLEPLAN_IMAGE:?HANDLEPLAN_IMAGE is required}");
    expect(appBlock).toContain('"127.0.0.1:3004:3000"');
    expect(reviewBlock).toContain('"127.0.0.1:3006:3000"');
    expect(appBlock).not.toMatch(/^\s+REVIEW_[A-Z0-9_]+:/mu);
    expect(reviewBlock).toMatch(/^\s+REVIEW_DATABASE_URL:/mu);
    expect(reviewBlock).toMatch(/^\s+REVIEW_ACCESS_AUDIENCE:/mu);
    expect(reviewBlock).toMatch(/^\s+REVIEW_ACCESS_ISSUER:/mu);
    expect(reviewBlock).toMatch(/^\s+REVIEW_ACCESS_TEAM_DOMAIN:/mu);
    expect(reviewBlock).toMatch(/^\s+REVIEW_BASE_URL:/mu);
    expect(reviewBlock).not.toMatch(/^\s+DATABASE_URL:/mu);
    expect(reviewBlock).not.toMatch(/^\s+KASSAL_[A-Z0-9_]+:/mu);
    expect(reviewBlock).toContain("api/internal/health/review");
    expect(reviewBlock).toContain("handleplan-review-health-v1");
    expect(reviewBlock).toContain("response.status!==200");
    expect(reviewBlock).toContain("body.database?.role!=='handleplan_review'");
    expect(reviewBlock).not.toContain("api/review/candidates");
    expect(reviewBlock).toContain(
      "'028_private_review_image_evidence_only.sql'",
    );
    expect(operationsBlock).toContain('"127.0.0.1:3007:3000"');
    expect(operationsBlock).toMatch(/^\s+OPERATIONS_DATABASE_URL:/mu);
    expect(operationsBlock).not.toMatch(/^\s+REVIEW_[A-Z0-9_]+:/mu);
    expect(operationsBlock).not.toMatch(/^\s+DATABASE_URL:/mu);
    expect(operationsBlock).not.toMatch(/^\s+KASSAL_[A-Z0-9_]+:/mu);
    expect(operationsBlock).toContain("api/internal/health/operations");
    expect(operationsBlock).toContain("handleplan-operations-health-v1");
    expect(operationsBlock).toContain("response.status!==200");
    expect(operationsBlock).toContain("body.database?.role!=='handleplan_operations'");
    expect(operationsBlock).not.toContain("api/internal/operations/snapshot");

    expect(proxy).toContain(
      "@operations_paths path /internal/operations /internal/operations/ /api/internal/operations/snapshot /api/internal/operations/snapshot/",
    );
    expect(proxy).toContain(
      "@private_health_paths path /api/internal/health/review /api/internal/health/review/ /api/internal/health/operations /api/internal/health/operations/",
    );
    expect(proxy).toContain('respond @private_health_paths "Not Found" 404');
    expect(proxy).not.toContain("/internal/operations/*");
    expect(proxy).not.toContain("/api/internal/operations/*");
    expect(proxy).toContain(
      "@review_paths path /review /review/* /api/review /api/review/*",
    );
    expect(proxy).not.toContain("@review_paths path /review*");
    expect(proxy).toContain("@missing_access not header Cf-Access-Jwt-Assertion *");
    expect(proxy).toMatch(/@not_cloudflare not remote_ip [^\n]+/u);
    const reviewHandle = proxy.match(/handle @review_paths \{([\s\S]*?)\n\t\t\}/u)?.[1];
    const operationsHandle = proxy.match(
      /handle @operations_paths \{([\s\S]*?)\n\t\t\}/u,
    )?.[1];
    const publicHandle = proxy.match(/\n\t\thandle \{([\s\S]*?)\n\t\t\}/u)?.[1];
    expect(reviewHandle).toBeDefined();
    expect(operationsHandle).toBeDefined();
    expect(publicHandle).toBeDefined();
    expect(reviewHandle).toContain("reverse_proxy 127.0.0.1:3006");
    expect(reviewHandle).not.toContain("127.0.0.1:3004");
    const reviewAccessDeleteIndex = reviewHandle?.indexOf("header_up -Cf-*") ?? -1;
    const reviewAssertionRestoreIndex = reviewHandle?.indexOf(
      "header_up Cf-Access-Jwt-Assertion {http.request.header.Cf-Access-Jwt-Assertion}",
    ) ?? -1;
    expect(reviewAccessDeleteIndex).toBeGreaterThanOrEqual(0);
    expect(reviewAssertionRestoreIndex).toBeGreaterThan(reviewAccessDeleteIndex);
    expect(cloudflareHeaderRules(reviewHandle)).toEqual([
      "header_up -Cf-*",
      "header_up Cf-Access-Jwt-Assertion {http.request.header.Cf-Access-Jwt-Assertion}",
    ]);
    for (const privateRequestHeader of [
      "Cookie",
      "Authorization",
      "Proxy-Authorization",
      "True-Client-Ip",
      "Forwarded",
      "X-Forwarded-For",
      "Remote-User",
      "X-Forwarded-Email",
      "X-Forwarded-User",
      "X-Real-Ip",
    ]) {
      expect(reviewHandle).toContain(`header_up -${privateRequestHeader}`);
    }
    expect(operationsHandle).toContain("reverse_proxy 127.0.0.1:3007");
    expect(cloudflareHeaderRules(operationsHandle)).toEqual([
      "header_up -Cf-*",
      "header_up Cf-Access-Jwt-Assertion {http.request.header.Cf-Access-Jwt-Assertion}",
    ]);
    for (const privateRequestHeader of [
      "Cookie",
      "Authorization",
      "Proxy-Authorization",
      "True-Client-Ip",
      "Forwarded",
      "X-Forwarded-For",
      "Remote-User",
      "X-Forwarded-Email",
      "X-Forwarded-User",
      "X-Real-Ip",
    ]) {
      expect(operationsHandle).toContain(`header_up -${privateRequestHeader}`);
    }
    expect(publicHandle).toContain("reverse_proxy 127.0.0.1:3004");
    expect(publicHandle).not.toContain("127.0.0.1:3006");
    expect(cloudflareHeaderRules(publicHandle)).toEqual(["header_up -Cf-*"]);
    for (const privateRequestHeader of [
      "Cookie",
      "Authorization",
      "Proxy-Authorization",
      "True-Client-Ip",
      "Forwarded",
      "X-Forwarded-For",
      "Remote-User",
      "X-Forwarded-Email",
      "X-Forwarded-User",
      "X-Real-Ip",
    ]) {
      expect(publicHandle).toContain(`header_up -${privateRequestHeader}`);
    }
    const reviewHandleIndex = proxy.indexOf("handle @review_paths");
    const operationsHandleIndex = proxy.indexOf("handle @operations_paths");
    const publicHandleIndex = proxy.indexOf("\n\t\thandle {");
    const privateHealthDenyIndex = proxy.indexOf(
      'respond @private_health_paths "Not Found" 404',
    );
    expect(privateHealthDenyIndex).toBeGreaterThanOrEqual(0);
    expect(privateHealthDenyIndex).toBeLessThan(reviewHandleIndex);
    expect(privateHealthDenyIndex).toBeLessThan(operationsHandleIndex);
    expect(privateHealthDenyIndex).toBeLessThan(publicHandleIndex);
    for (const globalGate of [
      'respond @not_cloudflare "Forbidden" 403',
      'respond @missing_access "Forbidden" 403',
    ]) {
      expect(proxy.indexOf(globalGate)).toBeGreaterThanOrEqual(0);
      expect(proxy.indexOf(globalGate)).toBeLessThan(reviewHandleIndex);
      expect(proxy.indexOf(globalGate)).toBeLessThan(operationsHandleIndex);
      expect(proxy.indexOf(globalGate)).toBeLessThan(publicHandleIndex);
    }
  });
});
