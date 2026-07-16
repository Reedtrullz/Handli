import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const dockerfile = fileURLToPath(new URL("../../../Dockerfile", import.meta.url));
const compose = fileURLToPath(new URL("../../../deploy/compose.production.yml", import.meta.url));
const deploy = fileURLToPath(new URL("../../../deploy/deploy-on-vps.sh", import.meta.url));
const rollbackCompose = fileURLToPath(
  new URL("../../../deploy/compose.rollback-legacy.yml", import.meta.url),
);
const runbook = fileURLToPath(new URL("../../../docs/runbooks/worker.md", import.meta.url));
const workflow = fileURLToPath(
  new URL("../../../.github/workflows/deploy-preview.yml", import.meta.url),
);

describe("production worker deployment", () => {
  it("builds one immutable worker artifact into the application image", async () => {
    const source = await readFile(dockerfile, "utf8");

    expect(source).toContain("COPY apps/worker/package.json apps/worker/package.json");
    expect(source).toContain("pnpm --filter @handleplan/worker build");
    expect(source).toContain("/app/apps/worker/dist/main.mjs");
  });

  it("deploys a hardened worker after migrations with conditional access by default", async () => {
    const source = await readFile(compose, "utf8");

    expect(source).toMatch(/worker:[\s\S]*entrypoint:[\s\S]*apps\/worker\/dist\/main\.mjs/);
    expect(source).toMatch(/worker:[\s\S]*migrate:[\s\S]*condition: service_completed_successfully/);
    expect(source).toContain("KASSAL_SOURCE_ACCESS: ${KASSAL_SOURCE_ACCESS:-conditional}");
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
      /worker:[\s\S]*DATABASE_URL: postgresql:\/\/handleplan_app:\$\{APP_DATABASE_PASSWORD:/,
    );
    expect(source).toMatch(/migrate:[\s\S]*WEB_DATABASE_PASSWORD:/);
    const appBlock = source.match(/  app:\n([\s\S]*?)\n  worker:/)?.[1];
    expect(appBlock).toBeDefined();
    expect(appBlock).not.toContain("KASSAL_API_KEY");
    expect(appBlock).not.toContain("KASSAL_BASE_URL");
    expect(appBlock).not.toContain("KASSAL_MODE");
    expect(source).toMatch(/worker:[\s\S]*KASSAL_API_KEY:/);
    const workerBlock = source.match(/  worker:\n([\s\S]*?)\nnetworks:/)?.[1];
    expect(workerBlock).toBeDefined();
    expect(workerBlock).not.toMatch(/\n    ports:/);
  });

  it("requires exact internal worker readback before recording a deployment", async () => {
    const [script, rollback, documentation, deploymentWorkflow] = await Promise.all([
      readFile(deploy, "utf8"),
      readFile(rollbackCompose, "utf8"),
      readFile(runbook, "utf8"),
      readFile(workflow, "utf8"),
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
      script.indexOf('record_deployment_state "$state_dir" "$revision" current'),
    );
    expect(script).toContain(
      'deploy "$previous_revision" "$revision" "$previous_compatibility_mode"',
    );
    expect(script).toContain('if [ "$compatibility_mode" = "legacy" ]');
    expect(script).not.toContain(
      'deploy "$previous_revision" "$revision" legacy-rollback',
    );
    expect(script).toContain("rm -f worker");
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
    expect(deploymentWorkflow).toContain(
      "deploy/deploy-on-vps.sh deploy/deployment-state.sh",
    );
    expect(deploymentWorkflow).toContain(
      "'$remote_bundle/deploy-on-vps.sh' '$DEPLOY_SHA'",
    );
    expect(deploymentWorkflow).not.toContain("sh -s --");
    expect(deploymentWorkflow).toContain(
      "current-deployment)\\\" = 'v1 $DEPLOY_SHA current'",
    );
  });
});
