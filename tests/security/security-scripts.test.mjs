import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { buildLicenseInventory } from "../../scripts/security/check-licenses.mjs";
import { createUnsignedProvenance } from "../../scripts/security/generate-build-provenance.mjs";
import { createSpdxDocument } from "../../scripts/security/generate-sbom.mjs";
import {
  findSecretMatches,
  scanRepositoryForSecrets,
} from "../../scripts/security/scan-secrets.mjs";

test("license policy rejects undeclared or unexpected expressions", () => {
  assert.throws(() => buildLicenseInventory([
    { license: "NOASSERTION", name: "unknown", platformRestricted: false, version: "1.0.0" },
  ], {
    approvedLicenseExpressions: ["MIT"],
    contractVersion: 1,
    platformPackageRules: [],
  }, "a".repeat(64)), /unapproved/u);
});

test("license inventory excludes platform variants only after a narrow rule matches", () => {
  const dependency = {
    license: "MIT",
    name: "@example/native-linux-x64",
    platformRestricted: true,
    version: "1.2.3",
  };
  const basePolicy = {
    approvedLicenseExpressions: ["MIT"],
    contractVersion: 1,
    platformPackageRules: [],
  };
  assert.throws(
    () => buildLicenseInventory([dependency], basePolicy, "a".repeat(64)),
    /unapproved platform/u,
  );

  const inventory = buildLicenseInventory([dependency], {
    ...basePolicy,
    platformPackageRules: [{
      approvedLicenseExpressions: ["MIT"],
      names: ["@example/native-linux-x64"],
      versions: ["1.2.3"],
    }],
  }, "a".repeat(64));
  assert.equal(inventory.packageCount, 0);
  assert.deepEqual(inventory.packages, []);
  assert.throws(() => buildLicenseInventory([{
    ...dependency,
    name: "@example/native-linux-x64-malicious",
  }], {
    ...basePolicy,
    platformPackageRules: [{
      approvedLicenseExpressions: ["MIT"],
      names: ["@example/native-linux-x64"],
      versions: ["1.2.3"],
    }],
  }, "a".repeat(64)), /unapproved platform/u);
});

test("secret scanner recognizes high-confidence values without printing them", () => {
  const githubToken = `gh${"p_"}${"a".repeat(36)}`;
  const privateKey = `-----BEGIN ${"PRIVATE KEY"}-----`;
  const assignment = `client_secret = "${"z".repeat(32)}"`;
  const matches = findSecretMatches([githubToken, privateKey, assignment].join("\n"));
  assert.deepEqual(matches.map((match) => match.rule), [
    "github-token",
    "private-key",
    "sensitive-assignment",
  ]);
  assert.deepEqual(findSecretMatches('password: "ci_url_safe_0000000000000001"'), []);
  assert.deepEqual(
    findSecretMatches(
      "REVIEW_DATABASE_URL=postgresql://handleplan_review:ci_review_url_safe_00000000000000001@127.0.0.1:5432/handleplan",
    ),
    [],
  );
  assert.deepEqual(findSecretMatches([
    "REVIEW_EVIDENCE_PROOF_SECRET=",
    "REVIEW_PRIVATE_CAPTURE_ROOT=/var/lib/handleplan/private-captures",
  ].join("\n")), []);
});

test("secret scanner covers prefixed environment names, encrypted keys, and deceptive fixture substrings", () => {
  const realValueContainingExample = `real${"example"}${"x".repeat(28)}`;
  const kassalKeyName = `KASSAL_API_${"KEY"}`;
  const databasePasswordName = `DATABASE_${"PASSWORD"}`;
  const valhallaTokenName = `VALHALLA_AUTH_${"TOKEN"}`;
  const text = [
    `${kassalKeyName}=${"k".repeat(32)}`,
    `${databasePasswordName}="${realValueContainingExample}"`,
    `${valhallaTokenName}: ${"v".repeat(32)}`,
    `-----BEGIN ENCRYPTED ${"PRIVATE KEY"}-----`,
    `-----BEGIN PGP ${"PRIVATE KEY BLOCK"}-----`,
  ].join("\n");
  assert.deepEqual(findSecretMatches(text).map((match) => match.rule), [
    "sensitive-assignment",
    "sensitive-assignment",
    "sensitive-assignment",
    "private-key",
    "private-key",
  ]);
  assert.deepEqual(
    findSecretMatches(`KASSAL_API_${"KEY"}=test_${"q".repeat(32)}`).map((match) => match.rule),
    ["sensitive-assignment"],
  );
});

test("repository scan does not trust a media filename for plaintext", () => {
  const root = mkdtempSync(join(tmpdir(), "handleplan-secret-scan-"));
  try {
    assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: root }).status, 0);
    const keyName = `KASSAL_API_${"KEY"}`;
    writeFileSync(join(root, "credentials.png"), `${keyName}=${"r".repeat(32)}\n`);
    const result = scanRepositoryForSecrets(root);
    assert.deepEqual(result.findings, [{
      file: "credentials.png",
      line: 1,
      rule: "sensitive-assignment",
    }]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("secret scanner catches credential-bearing database and broker URLs", () => {
  const databaseUrl = `${"postgresql"}://prod_user:${"p".repeat(32)}@db.internal/handleplan`;
  const brokerUrl = `${"amqps"}://worker:${"b".repeat(32)}@queue.internal/jobs`;
  assert.deepEqual(findSecretMatches(`${databaseUrl}\n${brokerUrl}`), [
    { line: 1, rule: "credential-uri" },
    { line: 2, rule: "credential-uri" },
  ]);
  assert.deepEqual(findSecretMatches(
    "postgresql://handleplan:replace_with_url_safe_admin_secret@localhost/handleplan",
  ), []);
  assert.deepEqual(
    findSecretMatches(`${"postgresql"}://prod_user:correct-horse@db.internal/handleplan`),
    [{ line: 1, rule: "credential-uri" }],
  );
});

test("SPDX document is revision-bound and enumerates dependencies", () => {
  const revision = "a".repeat(40);
  const document = createSpdxDocument([
    { license: "MIT", name: "fixture", platformRestricted: false, version: "1.2.3" },
  ], { created: "2026-07-17T00:00:00.000Z", revision });
  assert.equal(document.spdxVersion, "SPDX-2.3");
  assert.equal(document.packages.length, 2);
  assert.match(document.documentNamespace, new RegExp(revision, "u"));
  assert.deepEqual(document.relationships, [{
    relatedSpdxElement: "SPDXRef-Package-0001",
    relationshipType: "DEPENDS_ON",
    spdxElementId: "SPDXRef-Package-Handleplan",
  }]);
});

test("unsigned provenance binds only the commit, base, and built Docker archive digests", () => {
  const statement = createUnsignedProvenance({
    baseDigest: "b".repeat(64),
    imageArchiveDigest: "c".repeat(64),
    revision: "d".repeat(40),
    runId: "12345",
  });
  assert.equal(statement._type, "https://in-toto.io/Statement/v1");
  assert.equal(statement.predicateType, "https://slsa.dev/provenance/v1");
  assert.deepEqual(statement.subject, [{
    digest: { sha256: "c".repeat(64) },
    name: "handleplan-image.docker.tar",
  }]);
  assert.doesNotMatch(JSON.stringify(statement), /environment|secret|token|password/iu);
});
