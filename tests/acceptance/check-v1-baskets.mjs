#!/usr/bin/env node

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { createBenchmarkReport, verifyBenchmarkReport } from "./v1-basket-runner.mjs";

const root = resolve(import.meta.dirname, "../..");
const MAX_CANDIDATE_BYTES = 8 * 1024 * 1024;
const MAX_REPORT_BYTES = 8 * 1024 * 1024;
const MAX_RUNNER_ATTESTATION_BYTES = 16 * 1024 * 1024;
const MAX_GOVERNANCE_DOCUMENT_BYTES = 2 * 1024 * 1024;

function usage() {
  return [
    "Usage: node tests/acceptance/check-v1-baskets.mjs [options]",
    "",
    "Options:",
    "  --candidate <path>  Validate a candidate evidence document.",
    "  --runner-attestation <path>  Validate separate V2 oracle/timing evidence.",
    "  --verify-report <path>  Semantically recompute and verify an existing report.",
    "  --at <timestamp>    Canonical report timestamp (defaults to now).",
    "  --output <path>     Create a new report file; refuses to overwrite.",
    "  --help              Show this help.",
    "",
    "Exit codes: 0 accepted, 1 failed/invalid invocation, 2 blocked or pending.",
  ].join("\n");
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--help") return { help: true };
    if (![
      "--candidate",
      "--runner-attestation",
      "--verify-report",
      "--at",
      "--output",
    ].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}`);
    }
    const key = argument.slice(2);
    if (options[key] !== undefined) throw new Error(`Duplicate argument: ${argument}`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function readJson(path, maximumBytes) {
  const size = statSync(path).size;
  if (size > maximumBytes) {
    throw new Error(`JSON input exceeds the ${maximumBytes}-byte limit`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function exitCodeFor(status) {
  if (status === "accepted") return 0;
  if (status === "failed") return 1;
  return 2;
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    process.exitCode = 0;
  } else {
    if (options["verify-report"] !== undefined
      && (options.at !== undefined || options.output !== undefined)) {
      throw new Error("--verify-report cannot be combined with --at or --output");
    }
    const corpus = readJson(
        resolve(root, "docs/data/benchmark-baskets.v1.json"),
        MAX_GOVERNANCE_DOCUMENT_BYTES,
      );
    const sourceRegistry = readJson(
        resolve(root, "docs/data/source-registry.v1.json"),
        MAX_GOVERNANCE_DOCUMENT_BYTES,
      );
    const launchCoverage = readJson(
        resolve(root, "docs/data/launch-coverage.v1.json"),
        MAX_GOVERNANCE_DOCUMENT_BYTES,
      );
    const candidate = options.candidate === undefined
      ? undefined
      : readJson(resolve(process.cwd(), options.candidate), MAX_CANDIDATE_BYTES);
    const runnerAttestation = options["runner-attestation"] === undefined
      ? undefined
      : readJson(
        resolve(process.cwd(), options["runner-attestation"]),
        MAX_RUNNER_ATTESTATION_BYTES,
      );
    if (runnerAttestation !== undefined && candidate === undefined) {
      throw new Error("--candidate is required with --runner-attestation");
    }
    let report;
    if (options["verify-report"] !== undefined) {
      report = readJson(
        resolve(process.cwd(), options["verify-report"]),
        MAX_REPORT_BYTES,
      );
      if (report.candidate !== null && candidate === undefined) {
        throw new Error("--candidate is required for a candidate-backed report");
      }
      if (report.runnerAttestationDigest !== null && runnerAttestation === undefined) {
        throw new Error(
          "--runner-attestation is required for a runner-attested report",
        );
      }
      const verification = verifyBenchmarkReport({
        corpus,
        sourceRegistry,
        launchCoverage,
        ...(candidate === undefined ? {} : { candidate }),
        ...(runnerAttestation === undefined ? {} : { runnerAttestation }),
        report,
      });
      if (!verification.valid) {
        throw new Error(`Semantic report verification failed: ${verification.reason}`);
      }
    } else {
      const generatedAt = options.at ?? new Date().toISOString();
      if (new Date(generatedAt).toISOString() !== generatedAt) {
        throw new Error("--at must be a canonical UTC timestamp with milliseconds");
      }
      report = createBenchmarkReport({
        corpus,
        sourceRegistry,
        launchCoverage,
        ...(candidate === undefined ? {} : { candidate }),
        ...(runnerAttestation === undefined ? {} : { runnerAttestation }),
        generatedAt,
      });
    }
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output !== undefined) {
      writeFileSync(resolve(process.cwd(), options.output), serialized, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    }
    process.stdout.write(serialized);
    process.exitCode = exitCodeFor(report.status);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown runner failure";
  process.stderr.write(`V1 basket checker failed: ${message}\n${usage()}\n`);
  process.exitCode = 1;
}
