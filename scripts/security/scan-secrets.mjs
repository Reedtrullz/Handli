import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import { repositoryRoot } from "./dependency-inventory.mjs";

const tokenPatterns = Object.freeze([
  ["private-key", /-----BEGIN (?:(?:(?:DSA|EC|OPENSSH|RSA|ENCRYPTED) )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/gu],
  ["aws-access-key", /(?:^|[^A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?:[^A-Z0-9]|$)/gu],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{82,255})\b/gu],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/gu],
  ["npm-token", /\bnpm_[A-Za-z0-9]{36}\b/gu],
  ["openai-key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/gu],
  ["sendgrid-key", /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/gu],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/gu],
  ["stripe-live-key", /\b(?:pk|rk|sk)_live_[A-Za-z0-9]{20,}\b/gu],
]);

const sensitiveName = "(?:[A-Za-z][A-Za-z0-9]*[_-])*(?:api[_-]?key|auth[_-]?token|client[_-]?secret|password|private[_-]?key|secret|token)";
const sensitiveQuotedAssignment = new RegExp(
  `(?:^|[^A-Za-z0-9])${sensitiveName}[ \\t]*[:=][ \\t]*["']([^"']{20,})["']`,
  "gimu",
);
const sensitiveBareAssignment = new RegExp(
  `^[ \\t]*${sensitiveName}[ \\t]*[:=][ \\t]*([A-Za-z0-9+/_=:-]{20,})[ \\t]*(?:#.*)?$`,
  "gimu",
);
const credentialUri = /\b(?:amqps?|mariadb|mongodb(?:\+srv)?|mysql|postgres(?:ql)?|rediss?):\/\/[^:@/\s]+:(\$\{[^}@\r\n]{1,200}\}|[^@/\s]{1,200})@[^/\s]+/giu;
const approvedFixtureValues = new Set([
  "ci_admin_url_safe_0000000000000001",
  "ci_app_url_safe_0000000000000000001",
  "ci_operations_url_safe_000000000001",
  "ci_review_url_safe_00000000000000001",
  "ci_url_safe_0000000000000001",
  "ci_web_url_safe_0000000000000000001",
  "operations_url_safe_password_000000001",
  "legacy-rollback-network-disabled",
  "password",
  "placeholder",
  "private-password",
  "proof_admin_url_safe_000000000001",
  "proof_app_url_safe_000000000000000001",
  "proof_operations_url_safe_00000000001",
  "proof_review_url_safe_0000000000000001",
  "proof_web_url_safe_000000000000000001",
  "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI",
  "replace_with_distinct_url_safe_operations_secret",
  "replace_with_distinct_url_safe_web_secret",
  "replace_with_distinct_url_safe_review_secret",
  "replace_with_url_safe_admin_secret",
  "replace_with_url_safe_runtime_secret",
  "server-only-placeholder",
  "source-access-not-approved",
]);

function lineNumber(text, index) {
  return text.slice(0, index).split("\n").length;
}

export function findSecretMatches(text) {
  const matches = [];
  for (const [rule, pattern] of tokenPatterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      matches.push({ line: lineNumber(text, match.index ?? 0), rule });
    }
  }
  for (const pattern of [sensitiveQuotedAssignment, sensitiveBareAssignment]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const candidate = match[1] ?? "";
      if (!approvedFixtureValues.has(candidate)) {
        matches.push({ line: lineNumber(text, match.index ?? 0), rule: "sensitive-assignment" });
      }
    }
  }
  credentialUri.lastIndex = 0;
  for (const match of text.matchAll(credentialUri)) {
    const password = match[1] ?? "";
    const environmentReference = /^\$\{[A-Z][A-Z0-9_]*(?::[?+\-][^}]*)?\}$/u.test(password)
      || /^\$[A-Z][A-Z0-9_]*$/u.test(password);
    if (!environmentReference && !approvedFixtureValues.has(password)) {
      matches.push({ line: lineNumber(text, match.index ?? 0), rule: "credential-uri" });
    }
  }
  return matches.sort((left, right) => left.line - right.line || left.rule.localeCompare(right.rule));
}

function repositoryFiles(root) {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error("git file inventory failed");
  return result.stdout.split("\0").filter(Boolean).sort();
}

export function scanRepositoryForSecrets(root = repositoryRoot) {
  const findings = [];
  let scannedFiles = 0;
  for (const file of repositoryFiles(root)) {
    const absolutePath = `${root}/${file}`;
    let buffer;
    try {
      buffer = readFileSync(absolutePath);
    } catch {
      throw new Error(`cannot read repository file: ${file}`);
    }
    scannedFiles += 1;
    const text = buffer.toString("utf8");
    for (const match of findSecretMatches(text)) {
      findings.push({ file: relative(root, absolutePath), ...match });
    }
  }
  return { findings, scannedFiles };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = scanRepositoryForSecrets();
  if (result.findings.length > 0) {
    for (const finding of result.findings) {
      process.stderr.write(`${finding.file}:${finding.line} ${finding.rule}\n`);
    }
    process.stderr.write(`secret-scan-failed findings=${result.findings.length}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`secret-scan-ok files=${result.scannedFiles}\n`);
  }
}
