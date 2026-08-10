import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdtempSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, sep } from "node:path";
import { Transform } from "node:stream";

import {
  PrivateCaptureArchiveError,
  assertPrivateCaptureStoreUnchanged,
  bindPrivateCaptureDatabaseLedger,
  canonicalPrivateCaptureDatabaseLedger,
  privateCaptureArchiveContract,
  runEncryptedPrivateCaptureArchive,
  runPrivateCaptureArchiveVerification,
  scanPrivateCaptureStore,
} from "./private-capture-archive.mjs";

export class BackupSafetyError extends Error {}

const SAFE_ID = /^[a-z][a-z0-9_-]{0,62}$/u;
const SAFE_BACKUP_ID = /^\d{8}T\d{6}Z-[a-f0-9]{16}$/u;
const SAFE_RESTORE_DATABASE = /^handleplan_restore_drill_[a-z0-9_]{6,38}$/u;
const SAFE_SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_MIGRATION_ID = /^\d{3}_[a-z0-9_]+\.sql$/u;
const SAFE_EXPORTED_SNAPSHOT = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}-[0-9A-Fa-f]{1,8}$/u;

function fail(message) {
  throw new BackupSafetyError(message);
}

function envValue(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    fail(`${name} is required`);
  }
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    fail(`${name} has an invalid value`);
  }
  return value;
}

function exactFlag(environment, name, expected) {
  if (environment[name] !== expected) {
    fail(`${name} must be exactly ${expected}`);
  }
}

function integerEnvironment(environment, name, minimum, maximum) {
  const raw = envValue(environment, name);
  if (!/^\d+$/u.test(raw)) {
    fail(`${name} must be a decimal integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${name} is outside its allowed range`);
  }
  return value;
}

function safeObjectKey(value) {
  return (
    typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && !value.startsWith("/")
    && !value.endsWith("/")
    && !value.includes("//")
    && value.split("/").every((segment) => (
      segment !== "."
      && segment !== ".."
      && /^[A-Za-z0-9._-]+$/u.test(segment)
    ))
  );
}

function absolutePath(environment, name) {
  const value = envValue(environment, name);
  if (!isAbsolute(value) || value === sep) {
    fail(`${name} must be an absolute non-root path`);
  }
  return value;
}

function requirePrivateOwnedDirectory(environment, name) {
  const configured = absolutePath(environment, name);
  let canonical;
  let details;
  try {
    canonical = realpathSync(configured);
    details = statSync(canonical);
  } catch {
    fail(`${name} must identify an existing directory`);
  }
  if (!details.isDirectory()) {
    fail(`${name} must identify an existing directory`);
  }
  if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
    fail(`${name} must be owned by the executing account`);
  }
  if ((details.mode & 0o077) !== 0) {
    fail(`${name} must not grant group or other permissions`);
  }
  return canonical;
}

function requireReadOnlyDirectory(environment, name) {
  const configured = absolutePath(environment, name);
  let canonical;
  let details;
  try {
    canonical = realpathSync(configured);
    details = statSync(canonical);
  } catch {
    fail(`${name} must identify an existing directory`);
  }
  if (!details.isDirectory() || (details.mode & 0o022) !== 0) {
    fail(`${name} must identify a directory that is not group- or other-writable`);
  }
  return canonical;
}

function requireRegularFile(
  environment,
  name,
  { privateFile = false, trustedFile = false } = {},
) {
  const configured = absolutePath(environment, name);
  let canonical;
  let details;
  try {
    canonical = realpathSync(configured);
    details = lstatSync(canonical);
  } catch {
    fail(`${name} must identify an existing regular file`);
  }
  if (!details.isFile()) {
    fail(`${name} must identify an existing regular file`);
  }
  if (privateFile && (details.mode & 0o077) !== 0) {
    fail(`${name} must not grant group or other permissions`);
  }
  if (
    trustedFile
    && (
      (details.mode & 0o022) !== 0
      || (typeof process.getuid === "function" && ![0, process.getuid()].includes(details.uid))
    )
  ) {
    fail(`${name} must be root- or self-owned and not group- or other-writable`);
  }
  try {
    accessSync(canonical, constants.R_OK);
  } catch {
    fail(`${name} must be readable by the executing account`);
  }
  return canonical;
}

function requireExecutable(environment, name) {
  const configured = absolutePath(environment, name);
  let canonical;
  try {
    canonical = realpathSync(configured);
    const details = lstatSync(canonical);
    if (
      !details.isFile()
      || (details.mode & 0o022) !== 0
      || (typeof process.getuid === "function" && ![0, process.getuid()].includes(details.uid))
    ) {
      fail(`${name} must identify an executable file`);
    }
    accessSync(canonical, constants.X_OK);
  } catch {
    fail(`${name} must identify an executable file`);
  }
  return canonical;
}

function ensureSeparateDirectories(left, right) {
  if (left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`)) {
    fail("work and evidence directories must be separate and non-nested");
  }
}

function requirePrivateCaptureRoot(environment, name, expectedOwnerUid) {
  const configured = absolutePath(environment, name);
  let canonical;
  let details;
  try {
    canonical = realpathSync(configured);
    details = lstatSync(configured);
  } catch {
    fail(`${name} must identify an existing private-capture directory`);
  }
  if (
    canonical !== configured
    || details.isSymbolicLink()
    || !details.isDirectory()
    || details.uid !== expectedOwnerUid
    || (details.mode & 0o777) !== 0o700
  ) {
    fail(`${name} must be canonical, owner-matching, non-symbolic, and mode 0700`);
  }
  return configured;
}

function captureFailure(error) {
  if (error instanceof PrivateCaptureArchiveError) fail(error.message);
  throw error;
}

function captureCall(action) {
  try {
    return action();
  } catch (error) {
    return captureFailure(error);
  }
}

async function captureCallAsync(action) {
  try {
    return await action();
  } catch (error) {
    return captureFailure(error);
  }
}

function requirePinnedLocalService(config) {
  let contents;
  try {
    if (statSync(config.pgServiceFile).size > 64 * 1024) {
      fail("libpq service file exceeds its bounded size");
    }
    contents = readFileSync(config.pgServiceFile, "utf8");
  } catch (error) {
    if (error instanceof BackupSafetyError) throw error;
    fail("could not read the pinned libpq service file");
  }
  let selectedSectionCount = 0;
  let currentSection = "";
  const parameters = new Map();
  for (const rawLine of contents.replaceAll("\r\n", "\n").split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;
    const section = /^\[([A-Za-z0-9_.-]+)\]$/u.exec(line);
    if (section) {
      currentSection = section[1];
      if (currentSection === config.pgService) selectedSectionCount += 1;
      continue;
    }
    const parameter = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!parameter) fail("libpq service file contains an unsupported directive");
    if (currentSection !== config.pgService) continue;
    const name = parameter[1].toLowerCase();
    const value = parameter[2].trim();
    if (parameters.has(name) || value.length === 0) {
      fail("selected libpq service contains a duplicate or empty parameter");
    }
    parameters.set(name, value);
  }
  const host = parameters.get("host") ?? "";
  const hostSegments = host.split("/");
  if (
    selectedSectionCount !== 1
    || parameters.get("dbname") !== config.expectedDatabase
    || parameters.get("user") !== config.expectedRole
    || !isAbsolute(host)
    || !/^\/[A-Za-z0-9._/-]+$/u.test(host)
    || hostSegments.some((segment) => segment === "..")
    || parameters.has("hostaddr")
    || parameters.has("service")
  ) {
    fail("selected libpq service must pin one local Unix-socket database and role");
  }
  if (parameters.has("port")) {
    const port = parameters.get("port");
    if (!/^\d{1,5}$/u.test(port) || Number(port) < 1 || Number(port) > 65_535) {
      fail("selected libpq service has an invalid single local port");
    }
  }
}

function databaseEnvironment(config) {
  return {
    HOME: process.env.HOME ?? "/nonexistent",
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
    PGAPPNAME: config.applicationName,
    PGCONNECT_TIMEOUT: "15",
    PGPASSFILE: config.pgpassFile,
    PGSERVICE: config.pgService,
    PGSERVICEFILE: config.pgServiceFile,
  };
}

function adapterEnvironment(environment, fields) {
  const selected = {
    HOME: process.env.HOME ?? "/nonexistent",
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
    ...fields,
  };
  for (const [name, value] of Object.entries(environment)) {
    if (
      name.startsWith("HANDLEPLAN_BACKUP_UPLOAD_")
      && !Object.hasOwn(selected, name)
      && typeof value === "string"
    ) {
      selected[name] = value;
    }
  }
  return selected;
}

function restoreAdapterEnvironment(environment, fields) {
  const selected = {
    HOME: process.env.HOME ?? "/nonexistent",
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
    ...fields,
  };
  for (const [name, value] of Object.entries(environment)) {
    if (
      name.startsWith("HANDLEPLAN_RESTORE_DOWNLOAD_")
      && !Object.hasOwn(selected, name)
      && typeof value === "string"
    ) {
      selected[name] = value;
    }
  }
  return selected;
}

function signalProcessTree(child, signal) {
  if (process.platform !== "win32" && Number.isSafeInteger(child.pid) && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
    }
  }
  if (child.exitCode === null && child.signalCode === null) return child.kill(signal);
  return false;
}

function processTreeExists(child) {
  if (process.platform !== "win32" && Number.isSafeInteger(child.pid) && child.pid > 0) {
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
    }
  }
  return child.exitCode === null && child.signalCode === null;
}

export async function runCommand(executable, argumentsList, options = {}) {
  const child = spawn(executable, argumentsList, {
    detached: process.platform !== "win32",
    env: options.env,
    stdio: options.captureStdout ? ["ignore", "pipe", "ignore"] : ["ignore", "ignore", "ignore"],
  });
  const children = [child];
  let stopped = false;
  let forceKillTimer;
  let forceKillFinished = Promise.resolve();
  const stopAll = () => {
    if (stopped) return;
    stopped = true;
    const signaled = children.some((runningChild) => signalProcessTree(runningChild, "SIGTERM"));
    if (!signaled) return;
    forceKillFinished = new Promise((resolve) => {
      forceKillTimer = setTimeout(() => {
        for (const runningChild of children) signalProcessTree(runningChild, "SIGKILL");
        resolve();
      }, 2_000);
    });
  };
  const completion = childCompletion(child, stopAll);
  const output = options.captureStdout
    ? collectBounded(child.stdout, options.maxBuffer ?? 64 * 1024, stopAll)
    : Promise.resolve("");
  let timedOut = false;
  let boundedOutputUnsafe = false;
  let boundedOutputOversized = false;
  const outputGuard = options.boundedOutputPath === undefined ? undefined : setInterval(() => {
    try {
      if (!existsSync(options.boundedOutputPath)) return;
      const details = lstatSync(options.boundedOutputPath);
      if (details.isSymbolicLink() || !details.isFile()) {
        boundedOutputUnsafe = true;
        stopAll();
        return;
      }
      if (details.size > options.maxOutputFileBytes) {
        boundedOutputOversized = true;
        stopAll();
      }
    } catch {
      boundedOutputUnsafe = true;
      stopAll();
    }
  }, 100);
  outputGuard?.unref();
  const timeout = setTimeout(() => {
    timedOut = true;
    stopAll();
  }, options.timeoutMs ?? 60_000);
  timeout.unref();
  let completedSuccessfully = false;
  try {
    const [completionResult, outputResult] = await Promise.allSettled([completion, output]);
    if (timedOut) fail(`${options.failureMessage ?? "a required command failed"}: timeout exceeded`);
    if (boundedOutputUnsafe) fail(`${options.failureMessage ?? "a required command failed"}: unsafe output file`);
    if (boundedOutputOversized) fail(`${options.failureMessage ?? "a required command failed"}: output file exceeded its bound`);
    const success = fulfilledValue(completionResult);
    const stdout = fulfilledValue(outputResult);
    if (!success) fail(options.failureMessage ?? "a required command failed");
    completedSuccessfully = true;
    return stdout;
  } finally {
    clearInterval(outputGuard);
    clearTimeout(timeout);
    const leftDescendants = completedSuccessfully && children.some((runningChild) => (
      processTreeExists(runningChild)
    ));
    stopAll();
    await Promise.allSettled([completion]);
    if (children.some((runningChild) => processTreeExists(runningChild))) {
      await forceKillFinished;
    }
    clearTimeout(forceKillTimer);
    if (leftDescendants) {
      fail(`${options.failureMessage ?? "a required command failed"}: left a descendant process`);
    }
  }
}

function collectBounded(stream, maximumBytes, onOverflow) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const rejectAndStop = (message, { destroy = false } = {}) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      stream.pause();
      if (destroy && !stream.destroyed) stream.destroy();
      onOverflow();
      reject(new BackupSafetyError(message));
    };
    stream.on("data", (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maximumBytes) {
        rejectAndStop("archive validation output exceeded its bounded size", { destroy: true });
        return;
      }
      chunks.push(chunk);
    });
    stream.once("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    stream.once("error", () => rejectAndStop("archive validation output could not be read"));
    stream.once("close", () => rejectAndStop("archive validation output closed before completion"));
  });
}

function childCompletion(child, stopAll) {
  return new Promise((resolve) => {
    let spawnFailed = false;
    child.once("error", () => {
      spawnFailed = true;
      stopAll();
    });
    child.once("close", (code, signal) => {
      const success = !spawnFailed && code === 0 && signal === null;
      if (!success) stopAll();
      resolve(success);
    });
  });
}

function fulfilledValue(result) {
  if (result.status === "rejected") throw result.reason;
  return result.value;
}

function parseBackupSnapshotSessionOutput(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 256 * 1024) {
    fail("backup snapshot session output exceeded its bound");
  }
  const identities = [];
  const snapshots = [];
  const relations = [];
  const ledgerRows = [];
  let readyCount = 0;
  for (const line of text.replaceAll("\r\n", "\n").split("\n")) {
    if (line.length === 0) continue;
    if (line === "HP_READY") {
      readyCount += 1;
    } else if (line.startsWith("HP_IDENTITY\t")) {
      identities.push(line.slice("HP_IDENTITY\t".length));
    } else if (line.startsWith("HP_SNAPSHOT\t")) {
      snapshots.push(line.slice("HP_SNAPSHOT\t".length));
    } else if (line.startsWith("HP_RELATIONS\t")) {
      relations.push(line.slice("HP_RELATIONS\t".length));
    } else if (line.startsWith("HP_LEDGER\t")) {
      ledgerRows.push(line.slice("HP_LEDGER\t".length));
    } else {
      fail("backup snapshot session returned an unexpected response");
    }
  }
  if (
    identities.length !== 1
    || snapshots.length !== 1
    || relations.length !== 1
    || readyCount !== 1
    || !SAFE_EXPORTED_SNAPSHOT.test(snapshots[0] ?? "")
  ) {
    fail("backup snapshot session response is incomplete or invalid");
  }
  return {
    identity: parseBackupDatabaseIdentity(identities[0]),
    migrationLedger: parseLedger(ledgerRows.join("\n"), "backup source"),
    requiredRelations: relations[0],
    snapshotId: snapshots[0],
  };
}

export async function openBackupSnapshotSession(config) {
  const child = spawn(config.psqlBinary, [
    "--no-psqlrc",
    "--quiet",
    "--no-align",
    "--tuples-only",
    `--dbname=service=${config.pgService}`,
  ], {
    detached: process.platform !== "win32",
    env: databaseEnvironment(config),
    stdio: ["pipe", "pipe", "ignore"],
  });
  const completion = new Promise((resolve) => {
    let spawnFailed = false;
    child.once("error", () => {
      spawnFailed = true;
    });
    child.once("close", (code, signal) => {
      resolve(!spawnFailed && code === 0 && signal === null);
    });
  });
  const terminateSession = async () => {
    signalProcessTree(child, "SIGTERM");
    const closedAfterTerm = await Promise.race([
      completion.then(() => true),
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 2_000);
        timer.unref();
      }),
    ]);
    if (!closedAfterTerm) signalProcessTree(child, "SIGKILL");
    return completion;
  };
  let output = "";
  let outputBytes = 0;
  let ready = false;
  let startupError;
  let settleStartup;
  const startup = new Promise((resolve) => {
    settleStartup = resolve;
  });
  const finishStartup = (error) => {
    if (ready || startupError !== undefined) return;
    if (error === undefined) ready = true;
    else startupError = error;
    settleStartup();
  };
  child.stdout.on("data", (chunk) => {
    if (startupError !== undefined) return;
    outputBytes += chunk.length;
    if (outputBytes > 256 * 1024) {
      finishStartup(new BackupSafetyError("backup snapshot session output exceeded its bound"));
      void terminateSession();
      return;
    }
    output += chunk.toString("utf8");
    if (output.replaceAll("\r\n", "\n").split("\n").includes("HP_READY")) {
      finishStartup();
    }
  });
  child.stdout.once("error", () => {
    finishStartup(new BackupSafetyError("backup snapshot session output could not be read"));
  });
  completion.then((success) => {
    if (!ready) {
      finishStartup(new BackupSafetyError(
        success
          ? "backup snapshot session ended before exporting a snapshot"
          : "backup snapshot session failed before exporting a snapshot",
      ));
    }
  });

  const sql = [
    "\\set ON_ERROR_STOP on",
    "begin transaction isolation level repeatable read read only;",
    "select 'HP_IDENTITY' || E'\\t' || concat_ws(E'\\t', current_database(), current_user, encode(sha256(convert_to(system_identifier::text, 'UTF8')), 'hex'), (select rolsuper from pg_roles where rolname = current_user), (select rolcreaterole from pg_roles where rolname = current_user), (select rolcreatedb from pg_roles where rolname = current_user), (select rolreplication from pg_roles where rolname = current_user), (select rolbypassrls from pg_roles where rolname = current_user), (select count(*) = 0 from pg_auth_members where member = (select oid from pg_roles where rolname = current_user)), (select count(*) = 0 from pg_database where datdba = (select oid from pg_roles where rolname = current_user))) from pg_control_system();",
    "select 'HP_SNAPSHOT' || E'\\t' || pg_export_snapshot();",
    "select 'HP_LEDGER' || E'\\t' || id || E'\\t' || checksum from handleplan_schema_migrations order by id;",
    "select 'HP_RELATIONS' || E'\\t' || concat_ws(E'\\t', to_regclass('public.ingestion_runs') is not null, to_regclass('public.price_observations') is not null, to_regclass('public.source_permissions') is not null, to_regclass('public.publication_captures') is not null);",
    "select 'HP_READY';",
    "",
  ].join("\n");
  child.stdin.on("error", () => {
    finishStartup(new BackupSafetyError("backup snapshot session input failed"));
  });
  child.stdin.write(sql);

  const startupTimeoutMs = Math.min(config.commandTimeoutMs, 60_000);
  let startupTimedOut = false;
  const timeout = setTimeout(() => {
    startupTimedOut = true;
    finishStartup(new BackupSafetyError("backup snapshot session startup exceeded its timeout"));
    void terminateSession();
  }, startupTimeoutMs);
  timeout.unref();
  await startup;
  clearTimeout(timeout);
  if (startupTimedOut || startupError !== undefined) {
    await terminateSession();
    throw startupError ?? new BackupSafetyError("backup snapshot session startup failed");
  }

  let parsed;
  try {
    parsed = parseBackupSnapshotSessionOutput(output);
  } catch (error) {
    await terminateSession();
    throw error;
  }
  // Continue draining any command-status bytes until the session is closed.
  child.stdout.resume();
  let closed = false;
  return {
    ...parsed,
    close: async () => {
      if (closed) return;
      closed = true;
      child.stdin.end("rollback;\n\\q\n");
      let closeTimedOut = false;
      const closeTimeout = setTimeout(() => {
        closeTimedOut = true;
        void terminateSession();
      }, 5_000);
      closeTimeout.unref();
      const success = await completion;
      clearTimeout(closeTimeout);
      if (closeTimedOut || !success) {
        await terminateSession();
        fail("backup snapshot session did not close cleanly");
      }
    },
  };
}

export async function runEncryptedDumpPipeline(config) {
  if (!SAFE_EXPORTED_SNAPSHOT.test(config.snapshotId ?? "")) {
    fail("streaming backup pipeline requires a valid exported PostgreSQL snapshot");
  }
  const children = [];
  let stopped = false;
  let forceKillTimer;
  const stopAll = () => {
    if (stopped) return;
    stopped = true;
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
    forceKillTimer = setTimeout(() => {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    }, 2_000);
    forceKillTimer.unref();
  };
  const pgDump = spawn(config.pgDumpBinary, [
    "--format=custom",
    "--compress=6",
    "--no-owner",
    "--no-privileges",
    "--exclude-table-data=public.public_api_request_budget_events",
    `--snapshot=${config.snapshotId}`,
  ], {
    env: databaseEnvironment(config),
    stdio: ["ignore", "pipe", "ignore"],
  });
  const age = spawn(config.ageBinary, [
    "--encrypt",
    "--recipients-file",
    config.ageRecipientsFile,
    "--output",
    config.encryptedPath,
  ], {
    env: { HOME: process.env.HOME ?? "/nonexistent", LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    stdio: ["pipe", "ignore", "ignore"],
  });
  const archiveList = spawn(config.pgRestoreBinary, ["--list"], {
    env: { HOME: process.env.HOME ?? "/nonexistent", LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const ledgerExtract = spawn(config.pgRestoreBinary, [
    "--data-only",
    "--table=handleplan_schema_migrations",
  ], {
    env: { HOME: process.env.HOME ?? "/nonexistent", LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const captureExtract = spawn(config.pgRestoreBinary, [
    "--data-only",
    "--table=publication_captures",
  ], {
    env: { HOME: process.env.HOME ?? "/nonexistent", LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  children.push(pgDump, age, archiveList, ledgerExtract, captureExtract);
  for (const stream of [
    pgDump.stdout,
    age.stdin,
    archiveList.stdin,
    ledgerExtract.stdin,
    captureExtract.stdin,
  ]) {
    stream.on("error", () => stopAll());
  }

  const archiveListOutput = collectBounded(archiveList.stdout, 2 * 1024 * 1024, stopAll);
  const ledgerOutput = collectBounded(ledgerExtract.stdout, 256 * 1024, stopAll);
  const captureLedgerOutput = collectBounded(
    captureExtract.stdout,
    config.maxCaptureLedgerBytes,
    stopAll,
  );
  const completions = children.map((child) => childCompletion(child, stopAll));
  pgDump.stdout.pipe(age.stdin);
  pgDump.stdout.pipe(archiveList.stdin);
  pgDump.stdout.pipe(ledgerExtract.stdin);
  pgDump.stdout.pipe(captureExtract.stdin);

  let oversized = false;
  const sizeGuard = setInterval(() => {
    try {
      if (existsSync(config.encryptedPath) && statSync(config.encryptedPath).size > config.maxArtifactBytes) {
        oversized = true;
        stopAll();
      }
    } catch {
      stopAll();
    }
  }, 100);
  sizeGuard.unref();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    stopAll();
  }, config.commandTimeoutMs);
  timeout.unref();
  try {
    const [statusesResult, listResult, ledgerResult, captureLedgerResult] = await Promise.allSettled([
      Promise.all(completions),
      archiveListOutput,
      ledgerOutput,
      captureLedgerOutput,
    ]);
    if (timedOut) fail("streaming backup pipeline exceeded its timeout");
    if (oversized) fail("streaming backup pipeline exceeded its artifact limit");
    const statuses = fulfilledValue(statusesResult);
    const listText = fulfilledValue(listResult);
    const ledgerText = fulfilledValue(ledgerResult);
    const captureLedgerSql = fulfilledValue(captureLedgerResult);
    if (statuses.some((success) => !success)) {
      fail("streaming pg_dump encryption or archive validation failed");
    }
    return { archiveList: listText, captureLedgerSql, ledgerSql: ledgerText };
  } finally {
    clearInterval(sizeGuard);
    clearTimeout(timeout);
    stopAll();
    await Promise.allSettled(completions);
    clearTimeout(forceKillTimer);
  }
}

const RESTORE_EXECUTION_SESSION_BINDING = "pg-restore-sql-same-psql-transaction-v1";
const MAX_RESTORE_SQL_CONTROL_LINE_BYTES = 2 * 1024 * 1024;

function restoreIdentitiesEqual(left, right) {
  return (
    left !== null
    && right !== null
    && typeof left === "object"
    && typeof right === "object"
    && left.database === right.database
    && left.role === right.role
    && left.serverIdSha256 === right.serverIdSha256
    && left.owner === right.owner
    && left.privileged === right.privileged
    && left.hasNoMemberships === right.hasNoMemberships
    && left.ownsOnlyCurrentDatabase === right.ownsOnlyCurrentDatabase
  );
}

function requireExpectedRestoreExecutionIdentity(identity, config) {
  if (
    identity === null
    || typeof identity !== "object"
    || identity.database !== config.expectedDatabase
    || identity.role !== config.expectedRole
    || identity.serverIdSha256 !== config.expectedServerIdSha256
    || identity.owner !== true
    || identity.privileged !== false
    || identity.hasNoMemberships !== true
    || identity.ownsOnlyCurrentDatabase !== true
  ) {
    fail("restore pipeline requires the exact pinned unprivileged-owner execution identity");
  }
  return identity;
}

function createRestoreSqlGuard() {
  let buffered = Buffer.alloc(0);
  let copyInput = false;
  let restrictToken;
  let lexicalState = "normal";
  let blockCommentDepth = 0;
  let dollarQuoteDelimiter;
  let singleQuoteBackslashEscapes = false;
  let statementHasContent = false;
  let statementTokens = [];
  let previousStatementWord;
  let copyFromStdin = false;
  let word = "";
  let wordStartedAt = -1;

  const resetStatement = () => {
    statementHasContent = false;
    statementTokens = [];
    previousStatementWord = undefined;
    copyFromStdin = false;
  };

  const consumeWord = () => {
    if (word.length === 0) return;
    const normalized = word.toUpperCase();
    if (statementTokens.length < 2) statementTokens.push(normalized);
    if (
      statementTokens[0] === "COPY"
      && previousStatementWord === "FROM"
      && normalized === "STDIN"
    ) {
      copyFromStdin = true;
    }
    previousStatementWord = normalized;
    word = "";
    wordStartedAt = -1;
  };

  const finishStatement = () => {
    consumeWord();
    if (!statementHasContent) {
      resetStatement();
      return false;
    }
    const [first, second] = statementTokens;
    if (
      ["ABORT", "BEGIN", "COMMIT", "END", "ROLLBACK"].includes(first)
      || (first === "PREPARE" && second === "TRANSACTION")
      || (first === "SET" && second === "TRANSACTION")
      || (first === "START" && second === "TRANSACTION")
    ) {
      fail("pg_restore SQL contains forbidden transaction control");
    }
    const entersCopyInput = first === "COPY" && copyFromStdin;
    resetStatement();
    return entersCopyInput;
  };

  const dollarDelimiterAt = (text, offset) => {
    const match = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(text.slice(offset));
    return match?.[0];
  };

  const inspectSqlText = (text) => {
    for (let offset = 0; offset < text.length;) {
      const character = text[offset];
      const next = text[offset + 1];

      if (lexicalState === "block-comment") {
        if (character === "/" && next === "*") {
          blockCommentDepth += 1;
          offset += 2;
        } else if (character === "*" && next === "/") {
          blockCommentDepth -= 1;
          offset += 2;
          if (blockCommentDepth === 0) lexicalState = "normal";
        } else {
          offset += 1;
        }
        continue;
      }

      if (lexicalState === "single-quote") {
        if (singleQuoteBackslashEscapes && character === "\\") {
          offset += Math.min(2, text.length - offset);
        } else if (character === "'" && next === "'") {
          offset += 2;
        } else if (character === "'") {
          lexicalState = "normal";
          singleQuoteBackslashEscapes = false;
          offset += 1;
        } else {
          offset += 1;
        }
        continue;
      }

      if (lexicalState === "double-quote") {
        if (character === '"' && next === '"') {
          offset += 2;
        } else if (character === '"') {
          lexicalState = "normal";
          offset += 1;
        } else {
          offset += 1;
        }
        continue;
      }

      if (lexicalState === "dollar-quote") {
        if (text.startsWith(dollarQuoteDelimiter, offset)) {
          offset += dollarQuoteDelimiter.length;
          dollarQuoteDelimiter = undefined;
          lexicalState = "normal";
        } else {
          offset += 1;
        }
        continue;
      }

      if (character === "-" && next === "-") {
        consumeWord();
        lexicalState = "line-comment";
        break;
      }
      if (character === "/" && next === "*") {
        consumeWord();
        lexicalState = "block-comment";
        blockCommentDepth = 1;
        offset += 2;
        continue;
      }
      if (character === "'") {
        const isEscapeString = word === "E" || word === "e";
        const isAdjacentEscapePrefix = isEscapeString && wordStartedAt === offset - 1;
        consumeWord();
        statementHasContent = true;
        singleQuoteBackslashEscapes = isAdjacentEscapePrefix;
        lexicalState = "single-quote";
        offset += 1;
        continue;
      }
      if (character === '"') {
        consumeWord();
        statementHasContent = true;
        lexicalState = "double-quote";
        offset += 1;
        continue;
      }
      if (character === "$" && word.length === 0) {
        const delimiter = dollarDelimiterAt(text, offset);
        if (delimiter !== undefined) {
          statementHasContent = true;
          dollarQuoteDelimiter = delimiter;
          lexicalState = "dollar-quote";
          offset += delimiter.length;
          continue;
        }
      }
      if (/^[A-Za-z_]$/u.test(character)) {
        if (word.length === 0) wordStartedAt = offset;
        word += character;
        statementHasContent = true;
        offset += 1;
        continue;
      }
      if (word.length > 0 && /^[A-Za-z0-9_$]$/u.test(character)) {
        word += character;
        offset += 1;
        continue;
      }

      consumeWord();
      if (character === "\\") {
        fail("pg_restore SQL contains a forbidden psql meta-command");
      }
      if (character === ";") {
        const entersCopyInput = finishStatement();
        if (entersCopyInput) {
          if (text.slice(offset + 1).trim().length > 0) {
            fail("pg_restore COPY command contains trailing control data");
          }
          copyInput = true;
          return;
        }
      } else if (!/^\s$/u.test(character)) {
        statementHasContent = true;
      }
      offset += 1;
    }

    if (lexicalState === "line-comment") lexicalState = "normal";
    if (lexicalState === "normal") consumeWord();
  };

  const inspectLine = (lineBuffer) => {
    const hasLineFeed = lineBuffer.at(-1) === 0x0a;
    const contentEnd = hasLineFeed ? lineBuffer.length - 1 : lineBuffer.length;
    const hasCarriageReturn = contentEnd > 0 && lineBuffer[contentEnd - 1] === 0x0d;
    const text = lineBuffer.subarray(0, hasCarriageReturn ? contentEnd - 1 : contentEnd)
      .toString("utf8");
    if (copyInput) {
      if (text === "\\.") copyInput = false;
      return;
    }

    const trimmed = text.trim();
    const restrict = /^\\restrict ([A-Za-z0-9]{1,128})$/u.exec(trimmed);
    const unrestrict = /^\\unrestrict ([A-Za-z0-9]{1,128})$/u.exec(trimmed);
    if (lexicalState === "normal" && !statementHasContent && restrict !== null) {
      if (restrictToken !== undefined) {
        fail("pg_restore SQL contains a nested psql restrict guard");
      }
      restrictToken = restrict[1];
      return;
    }
    if (lexicalState === "normal" && !statementHasContent && unrestrict !== null) {
      if (restrictToken === undefined || unrestrict[1] !== restrictToken) {
        fail("pg_restore SQL contains a mismatched psql unrestrict guard");
      }
      restrictToken = undefined;
      return;
    }
    inspectSqlText(text);
  };

  return new Transform({
    flush(callback) {
      try {
        if (buffered.length > 0) {
          inspectLine(buffered);
          this.push(buffered);
          buffered = Buffer.alloc(0);
        }
        if (copyInput) fail("pg_restore SQL ended inside COPY data");
        if (restrictToken !== undefined) fail("pg_restore SQL left a psql restrict guard open");
        if (
          lexicalState !== "normal"
          || blockCommentDepth !== 0
          || dollarQuoteDelimiter !== undefined
          || statementHasContent
          || word.length > 0
        ) {
          fail("pg_restore SQL ended in an incomplete lexical or statement state");
        }
        callback();
      } catch (error) {
        callback(error);
      }
    },
    transform(chunk, _encoding, callback) {
      try {
        buffered = Buffer.concat([buffered, chunk]);
        for (;;) {
          const lineFeed = buffered.indexOf(0x0a);
          if (lineFeed < 0) break;
          const line = buffered.subarray(0, lineFeed + 1);
          inspectLine(line);
          this.push(line);
          buffered = buffered.subarray(lineFeed + 1);
        }
        if (buffered.length > MAX_RESTORE_SQL_CONTROL_LINE_BYTES) {
          fail("pg_restore SQL control line exceeded its bounded size");
        }
        callback();
      } catch (error) {
        callback(error);
      }
    },
  });
}

async function terminateRestoreSession(child, completion) {
  signalProcessTree(child, "SIGTERM");
  const closedAfterTerm = await Promise.race([
    completion.then(() => true),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 2_000);
      timer.unref();
    }),
  ]);
  if (!closedAfterTerm) signalProcessTree(child, "SIGKILL");
  await completion;
}

async function openRestoreExecutionSession(config) {
  const nonce = randomBytes(24).toString("hex");
  const marker = `HP_RESTORE_${nonce}`;
  const child = spawn(config.psqlBinary, [
    "--no-psqlrc",
    "--quiet",
    "--no-align",
    "--tuples-only",
    "--set=ON_ERROR_STOP=1",
    `--dbname=service=${config.pgService}`,
  ], {
    detached: process.platform !== "win32",
    env: databaseEnvironment(config),
    stdio: ["pipe", "pipe", "ignore"],
  });
  let spawnFailed = false;
  const completion = new Promise((resolve) => {
    child.once("error", () => {
      spawnFailed = true;
    });
    child.once("close", (code, signal) => {
      resolve(!spawnFailed && code === 0 && signal === null);
    });
  });

  let outputBytes = 0;
  let pendingOutput = Buffer.alloc(0);
  let identityBeforeText;
  let identityAfterText;
  let cleanRoomCatalog;
  let readyCount = 0;
  let doneCount = 0;
  let finishStarted = false;
  let sessionError;
  let settleReady;
  const ready = new Promise((resolve) => {
    settleReady = resolve;
  });
  let readySettled = false;
  const failSession = (message) => {
    if (sessionError === undefined) {
      sessionError = message instanceof Error ? message : new BackupSafetyError(message);
    }
    if (!readySettled) {
      readySettled = true;
      settleReady();
    }
    void terminateRestoreSession(child, completion);
  };
  const inspectOutputLine = (lineBuffer) => {
    const line = lineBuffer.toString("utf8").replace(/\r$/u, "");
    if (line === `${marker}_READY`) {
      readyCount += 1;
      if (
        readyCount !== 1
        || identityBeforeText === undefined
        || cleanRoomCatalog === undefined
        || finishStarted
      ) {
        failSession("restore execution session returned an invalid startup proof");
        return;
      }
      if (!readySettled) {
        readySettled = true;
        settleReady();
      }
      return;
    }
    if (line === `${marker}_DONE`) {
      doneCount += 1;
      if (!finishStarted || doneCount !== 1 || identityAfterText === undefined) {
        failSession("restore execution session returned an invalid completion proof");
      }
      return;
    }
    for (const [suffix, assign] of [
      ["_IDENTITY_BEFORE\t", (value) => { identityBeforeText = value; }],
      ["_CLEAN_ROOM\t", (value) => { cleanRoomCatalog = value; }],
      ["_IDENTITY_AFTER\t", (value) => { identityAfterText = value; }],
    ]) {
      const prefix = `${marker}${suffix}`;
      if (!line.startsWith(prefix)) continue;
      if (
        (suffix === "_IDENTITY_BEFORE\t" && (identityBeforeText !== undefined || finishStarted))
        || (suffix === "_CLEAN_ROOM\t" && (cleanRoomCatalog !== undefined || finishStarted))
        || (suffix === "_IDENTITY_AFTER\t" && (identityAfterText !== undefined || !finishStarted))
      ) {
        failSession("restore execution session returned a duplicate or out-of-order proof");
        return;
      }
      assign(line.slice(prefix.length));
      return;
    }
    if (line.startsWith(`${marker}_`)) {
      failSession("restore execution session returned an unknown proof marker");
    }
  };
  child.stdout.on("data", (chunk) => {
    if (sessionError !== undefined) return;
    outputBytes += chunk.length;
    if (outputBytes > 256 * 1024) {
      failSession("restore execution session output exceeded its bound");
      return;
    }
    pendingOutput = Buffer.concat([pendingOutput, chunk]);
    for (;;) {
      const lineFeed = pendingOutput.indexOf(0x0a);
      if (lineFeed < 0) break;
      inspectOutputLine(pendingOutput.subarray(0, lineFeed));
      pendingOutput = pendingOutput.subarray(lineFeed + 1);
    }
  });
  child.stdout.once("error", () => {
    failSession("restore execution session output could not be read");
  });
  child.stdin.once("error", () => {
    failSession("restore execution session input failed");
  });
  completion.then((success) => {
    if (pendingOutput.length > 0) {
      inspectOutputLine(pendingOutput);
      pendingOutput = Buffer.alloc(0);
    }
    if (!readySettled) {
      failSession(success
        ? "restore execution session ended before proving its startup identity"
        : "restore execution session failed before proving its startup identity");
    } else if (!finishStarted && sessionError === undefined) {
      failSession("restore execution session ended before archive execution");
    }
  });

  const identitySubquery = RESTORE_IDENTITY_QUERY.replace(/;\s*$/u, "");
  const cleanRoomSubquery = CLEAN_ROOM_CATALOG_QUERY.replace(/;\s*$/u, "");
  const startupSql = [
    "\\set ON_ERROR_STOP on",
    `select '${marker}_IDENTITY_BEFORE' || E'\\t' || value from (${identitySubquery}) as restore_identity(value);`,
    `select '${marker}_CLEAN_ROOM' || E'\\t' || value from (${cleanRoomSubquery}) as restore_catalog(value);`,
    `select '${marker}_READY';`,
    "",
  ].join("\n");
  child.stdin.write(startupSql);
  let startupTimedOut = false;
  const startupTimeout = setTimeout(() => {
    startupTimedOut = true;
    failSession("restore execution session startup exceeded its timeout");
  }, Math.min(config.commandTimeoutMs, 60_000));
  startupTimeout.unref();
  await ready;
  clearTimeout(startupTimeout);
  if (startupTimedOut || sessionError !== undefined) {
    await terminateRestoreSession(child, completion);
    throw sessionError ?? new BackupSafetyError("restore execution session startup failed");
  }

  let identityBefore;
  try {
    identityBefore = parseDatabaseIdentity(identityBeforeText, {
      label: "archive execution session",
      requireOwner: true,
    });
  } catch (error) {
    await terminateRestoreSession(child, completion);
    throw error;
  }
  let transactionStarted = false;
  let closed = false;
  return {
    cleanRoomCatalog,
    completion,
    identityBefore,
    input: child.stdin,
    abort: async () => {
      if (closed) return;
      closed = true;
      await terminateRestoreSession(child, completion);
    },
    begin: async () => {
      if (closed || transactionStarted) fail("restore execution session cannot begin twice");
      transactionStarted = true;
      await new Promise((resolve, reject) => {
        child.stdin.write("begin;\n", (error) => {
          if (error) reject(new BackupSafetyError("restore execution transaction could not begin"));
          else resolve();
        });
      });
    },
    finish: async () => {
      if (closed || !transactionStarted || finishStarted) {
        fail("restore execution session cannot finish in its current state");
      }
      finishStarted = true;
      const completionSql = [
        "",
        "commit;",
        `select '${marker}_IDENTITY_AFTER' || E'\\t' || value from (${identitySubquery}) as restore_identity(value);`,
        `select '${marker}_DONE';`,
        "\\q",
        "",
      ].join("\n");
      child.stdin.end(completionSql);
      let closeTimedOut = false;
      const closeTimeout = setTimeout(() => {
        closeTimedOut = true;
        failSession("restore execution session completion exceeded its timeout");
      }, Math.min(config.commandTimeoutMs, 60_000));
      closeTimeout.unref();
      const success = await completion;
      clearTimeout(closeTimeout);
      closed = true;
      if (closeTimedOut || sessionError !== undefined || !success || doneCount !== 1) {
        await terminateRestoreSession(child, completion);
        throw sessionError ?? new BackupSafetyError(
          "restore execution session failed before its post-commit identity proof",
        );
      }
      const identityAfter = parseDatabaseIdentity(identityAfterText, {
        label: "post-commit archive execution session",
        requireOwner: true,
      });
      return { identityAfter };
    },
  };
}

export async function runRestorePipeline(config) {
  const decryptPass = async ({ captureList, consumerArguments, consumerEnvironment }) => {
    const children = [];
    let stopped = false;
    let forceKillTimer;
    const stopAll = () => {
      if (stopped) return;
      stopped = true;
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      }
      forceKillTimer = setTimeout(() => {
        for (const child of children) {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }
      }, 2_000);
      forceKillTimer.unref();
    };
    const age = spawn(config.ageBinary, [
      "--decrypt",
      "--identity",
      config.ageIdentityFile,
      config.encryptedFile,
    ], {
      env: { HOME: process.env.HOME ?? "/nonexistent", LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const consumer = spawn(config.pgRestoreBinary, consumerArguments, {
      env: consumerEnvironment,
      stdio: ["pipe", captureList ? "pipe" : "ignore", "ignore"],
    });
    children.push(age, consumer);
    for (const stream of [age.stdout, consumer.stdin]) stream.on("error", () => stopAll());
    const completion = children.map((child) => childCompletion(child, stopAll));
    const output = captureList
      ? collectBounded(consumer.stdout, 2 * 1024 * 1024, stopAll)
      : Promise.resolve("");
    age.stdout.pipe(consumer.stdin);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      stopAll();
    }, config.commandTimeoutMs);
    timeout.unref();
    try {
      const [statusesResult, outputResult] = await Promise.allSettled([
        Promise.all(completion),
        output,
      ]);
      if (timedOut) fail("streaming restore pipeline exceeded its timeout");
      const statuses = fulfilledValue(statusesResult);
      const text = fulfilledValue(outputResult);
      if (statuses.some((success) => !success)) {
        fail("streaming authenticated decryption or isolated pg_restore failed");
      }
      return text;
    } finally {
      clearTimeout(timeout);
      stopAll();
      await Promise.allSettled(completion);
      clearTimeout(forceKillTimer);
    }
  };

  const safeEnvironment = { HOME: process.env.HOME ?? "/nonexistent", LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" };
  const archiveList = await decryptPass({
    captureList: true,
    consumerArguments: ["--list"],
    consumerEnvironment: safeEnvironment,
  });
  validateArchiveList(archiveList);
  const expectedIdentity = requireExpectedRestoreExecutionIdentity(
    config.expectedExecutionIdentity,
    config,
  );
  const session = await openRestoreExecutionSession(config);
  let sessionClosed = false;
  try {
    if (
      !restoreIdentitiesEqual(session.identityBefore, expectedIdentity)
      || session.cleanRoomCatalog !== CLEAN_ROOM_CATALOG_VECTOR
    ) {
      fail("archive execution session does not match the pinned identity and clean-room probe");
    }
    await session.begin();

    const children = [];
    let stopped = false;
    let forceKillTimer;
    const stopAll = () => {
      if (stopped) return;
      stopped = true;
      for (const child of children) signalProcessTree(child, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        for (const child of children) signalProcessTree(child, "SIGKILL");
      }, 2_000);
      forceKillTimer.unref();
    };
    const safeEnvironment = {
      HOME: process.env.HOME ?? "/nonexistent",
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
    };
    const age = spawn(config.ageBinary, [
      "--decrypt",
      "--identity",
      config.ageIdentityFile,
      config.encryptedFile,
    ], {
      detached: process.platform !== "win32",
      env: safeEnvironment,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pgRestore = spawn(config.pgRestoreBinary, [
      "--exit-on-error",
      "--no-owner",
      "--no-privileges",
      "--file=-",
    ], {
      detached: process.platform !== "win32",
      env: safeEnvironment,
      stdio: ["pipe", "pipe", "ignore"],
    });
    children.push(age, pgRestore);
    const sqlGuard = createRestoreSqlGuard();
    for (const stream of [age.stdout, pgRestore.stdin, pgRestore.stdout, sqlGuard, session.input]) {
      stream.on("error", () => stopAll());
    }
    const completions = children.map((child) => childCompletion(child, stopAll));
    const guardedSql = new Promise((resolve, reject) => {
      sqlGuard.once("end", resolve);
      sqlGuard.once("error", reject);
    });
    session.completion.then(() => {
      if (!sessionClosed) stopAll();
    });
    age.stdout.pipe(pgRestore.stdin);
    pgRestore.stdout.pipe(sqlGuard).pipe(session.input, { end: false });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      stopAll();
    }, config.commandTimeoutMs);
    timeout.unref();
    try {
      const [statusesResult, sqlResult] = await Promise.allSettled([
        Promise.all(completions),
        guardedSql,
      ]);
      if (timedOut) fail("streaming restore pipeline exceeded its timeout");
      const statuses = fulfilledValue(statusesResult);
      fulfilledValue(sqlResult);
      if (statuses.some((success) => !success)) {
        fail("streaming authenticated decryption or offline pg_restore failed");
      }
      sessionClosed = true;
      const { identityAfter } = await session.finish();
      if (!restoreIdentitiesEqual(identityAfter, expectedIdentity)) {
        fail("archive execution session identity changed before its post-commit proof");
      }
      return {
        archiveList,
        executionCleanRoomCatalog: session.cleanRoomCatalog,
        executionIdentityAfter: identityAfter,
        executionIdentityBefore: session.identityBefore,
        executionSessionBinding: RESTORE_EXECUTION_SESSION_BINDING,
      };
    } finally {
      clearTimeout(timeout);
      stopAll();
      await Promise.allSettled(completions);
      clearTimeout(forceKillTimer);
    }
  } finally {
    if (!sessionClosed) await session.abort();
  }
}

function timestampForId(date) {
  return date.toISOString().replaceAll("-", "").replaceAll(":", "").replace(/\.\d{3}Z$/u, "Z");
}

export function sha256File(path) {
  const hash = createHash("sha256");
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) {
        return hash.digest("hex");
      }
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(descriptor);
  }
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.uid === right.uid
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
  );
}

function serializeLedger(entries) {
  return entries.map(({ checksum, id }) => `${id}\t${checksum}`).join("\n");
}

function parseLedger(text, label) {
  const normalized = text.trim();
  if (normalized.length === 0 || Buffer.byteLength(normalized) > 128 * 1024) {
    fail(`${label} migration ledger is missing or exceeds its bound`);
  }
  const entries = normalized.split("\n").map((line) => {
    const fields = line.split("\t");
    if (fields.length !== 2 || !SAFE_MIGRATION_ID.test(fields[0]) || !SAFE_SHA256.test(fields[1])) {
      fail(`${label} migration ledger has an invalid row`);
    }
    return { checksum: fields[1], id: fields[0] };
  });
  if (entries.length > 1_000) fail(`${label} migration ledger exceeds its row bound`);
  const ids = entries.map(({ id }) => id);
  if (new Set(ids).size !== ids.length || [...ids].sort().join("\n") !== ids.join("\n")) {
    fail(`${label} migration ledger is not unique and ordered`);
  }
  return entries;
}

function repositoryMigrationLedger(migrationsDirectory) {
  const files = readdirSync(migrationsDirectory).filter((name) => SAFE_MIGRATION_ID.test(name)).sort();
  if (files.length === 0 || files.length > 1_000) {
    fail("migrations directory has an invalid migration-file count");
  }
  return files.map((id) => {
    const path = join(migrationsDirectory, id);
    const details = lstatSync(path);
    if (!details.isFile() || (details.mode & 0o022) !== 0) {
      fail("migrations directory contains an unsafe migration file");
    }
    return { checksum: sha256File(path), id };
  });
}

function requireLedgerPrefix(actual, current, { exact, label }) {
  if (actual.length === 0 || actual.length > current.length) {
    fail(`${label} migration ledger is not a valid prefix of this source revision`);
  }
  for (let index = 0; index < actual.length; index += 1) {
    if (
      actual[index].id !== current[index].id
      || actual[index].checksum !== current[index].checksum
    ) {
      fail(`${label} migration ledger is not a valid prefix of this source revision`);
    }
  }
  if (exact && actual.length !== current.length) {
    fail(`${label} migration ledger is not current for this source revision`);
  }
}

function parseExtractedLedger(sqlText) {
  if (Buffer.byteLength(sqlText) > 256 * 1024) {
    fail("dump migration ledger exceeds its extraction bound");
  }
  const lines = sqlText.replaceAll("\r\n", "\n").split("\n");
  const copyIndex = lines.findIndex((line) => (
    /^COPY (?:public\.)?handleplan_schema_migrations \(id, checksum, applied_at\) FROM stdin;$/u.test(line)
  ));
  if (copyIndex < 0) fail("custom archive is missing the migration-ledger COPY block");
  const rows = [];
  let ended = false;
  for (const line of lines.slice(copyIndex + 1)) {
    if (line === "\\.") {
      ended = true;
      break;
    }
    const fields = line.split("\t");
    if (
      fields.length !== 3
      || !SAFE_MIGRATION_ID.test(fields[0])
      || !SAFE_SHA256.test(fields[1])
      || fields[2].length === 0
    ) {
      fail("custom archive contains an invalid migration-ledger row");
    }
    rows.push(`${fields[0]}\t${fields[1]}`);
  }
  if (!ended) fail("custom archive migration-ledger COPY block is unterminated");
  return parseLedger(rows.join("\n"), "custom archive");
}

function parseExtractedCaptureLedger(sqlText, maximumBytes) {
  if (typeof sqlText !== "string" || Buffer.byteLength(sqlText) > maximumBytes) {
    fail("dump private-capture ledger exceeds its extraction bound");
  }
  const lines = sqlText.replaceAll("\r\n", "\n").split("\n");
  const copyPattern = /^COPY (?:public\.)?publication_captures \(([^)]+)\) FROM stdin;$/u;
  const copyIndex = lines.findIndex((line) => copyPattern.test(line));
  if (copyIndex < 0) fail("custom archive is missing the private-capture COPY block");
  const header = copyPattern.exec(lines[copyIndex]);
  const columns = header[1].split(", ");
  if (
    columns.length === 0
    || new Set(columns).size !== columns.length
    || !["blob_key", "byte_length", "checksum", "publication_id"].every((name) => columns.includes(name))
  ) {
    fail("custom archive private-capture COPY columns are invalid");
  }
  const blobKeyIndex = columns.indexOf("blob_key");
  const byteLengthIndex = columns.indexOf("byte_length");
  const checksumIndex = columns.indexOf("checksum");
  const publicationIdIndex = columns.indexOf("publication_id");
  const entries = [];
  let ended = false;
  for (const line of lines.slice(copyIndex + 1)) {
    if (line === "\\.") {
      ended = true;
      break;
    }
    const fields = line.split("\t");
    const byteLength = Number(fields[byteLengthIndex]);
    const publicationId = Number(fields[publicationIdIndex]);
    if (
      fields.length !== columns.length
      || !Number.isSafeInteger(byteLength)
      || !/^\d+$/u.test(fields[byteLengthIndex] ?? "")
      || !Number.isSafeInteger(publicationId)
      || !/^\d+$/u.test(fields[publicationIdIndex] ?? "")
    ) {
      fail("custom archive private-capture COPY row is invalid");
    }
    entries.push({
      blobKey: fields[blobKeyIndex],
      byteLength,
      checksumSha256: fields[checksumIndex],
      publicationId,
    });
  }
  if (!ended) fail("custom archive private-capture COPY block is unterminated");
  return captureCall(() => canonicalPrivateCaptureDatabaseLedger(entries));
}

function parseCaptureQueryLedger(text) {
  const normalized = text.trim();
  if (normalized.length === 0) {
    return captureCall(() => canonicalPrivateCaptureDatabaseLedger([]));
  }
  const entries = normalized.split("\n").map((line) => {
    const fields = line.split("\t");
    const publicationId = Number(fields[1]);
    const byteLength = Number(fields[2]);
    if (
      fields.length !== 4
      || !/^\d+$/u.test(fields[1] ?? "")
      || !/^\d+$/u.test(fields[2] ?? "")
    ) {
      fail("restored private-capture ledger has an invalid row");
    }
    return {
      blobKey: fields[0],
      byteLength,
      checksumSha256: fields[3],
      publicationId,
    };
  });
  return captureCall(() => canonicalPrivateCaptureDatabaseLedger(entries));
}

function validateArchiveList(archiveList) {
  if (Buffer.byteLength(archiveList) > 2 * 1024 * 1024) {
    fail("custom archive list exceeds its bound");
  }
  for (const required of [
    "TABLE DATA public handleplan_schema_migrations",
    "TABLE public ingestion_runs",
    "TABLE public price_observations",
    "TABLE public publication_captures",
    "TABLE public source_permissions",
  ]) {
    if (!archiveList.includes(required)) {
      fail("custom archive is missing a required evidence relation");
    }
  }
}

function requireRestoreExecutionProof(pipeline, expectedIdentity) {
  if (
    pipeline === null
    || typeof pipeline !== "object"
    || pipeline.executionSessionBinding !== RESTORE_EXECUTION_SESSION_BINDING
    || pipeline.executionCleanRoomCatalog !== CLEAN_ROOM_CATALOG_VECTOR
    || !restoreIdentitiesEqual(pipeline.executionIdentityBefore, expectedIdentity)
    || !restoreIdentitiesEqual(pipeline.executionIdentityAfter, expectedIdentity)
  ) {
    fail("restore pipeline did not prove same-session archive execution and identity readback");
  }
}

function writePrivate(path, contents) {
  writeFileSync(path, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  chmodSync(path, 0o600);
}

function atomicCopy(source, destination) {
  const temporary = `${destination}.partial-${process.pid}`;
  try {
    if (existsSync(destination)) {
      fail("local evidence already exists; refusing to overwrite it");
    }
    copyFileSync(source, temporary, constants.COPYFILE_EXCL);
    chmodSync(temporary, 0o600);
    linkSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function atomicWrite(destination, contents) {
  const temporary = `${destination}.partial-${process.pid}`;
  let descriptor;
  try {
    if (existsSync(destination)) {
      fail("local evidence already exists; refusing to overwrite it");
    }
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(descriptor, contents, { encoding: "utf8" });
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, destination);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    rmSync(temporary, { force: true });
  }
}

function copyBoundedPrivate(source, destination, maximumBytes, label = "encrypted backup") {
  const sourceDescriptor = openSync(source, constants.O_RDONLY);
  let destinationDescriptor;
  let completed = false;
  try {
    destinationDescriptor = openSync(
      destination,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let total = 0;
    for (;;) {
      const count = readSync(sourceDescriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      total += count;
      if (total > maximumBytes) fail(`${label} exceeds its bounded size limit`);
      let offset = 0;
      while (offset < count) {
        const written = writeSync(destinationDescriptor, buffer, offset, count - offset);
        if (written <= 0) fail("could not create the pinned encrypted restore copy");
        offset += written;
      }
    }
    if (total === 0) fail(`${label} is empty`);
    chmodSync(destination, 0o600);
    completed = true;
    return total;
  } finally {
    closeSync(sourceDescriptor);
    if (destinationDescriptor !== undefined) closeSync(destinationDescriptor);
    if (!completed) rmSync(destination, { force: true });
  }
}

function acquireRunLock(workDirectory, name) {
  const lockPath = join(workDirectory, name);
  let descriptor;
  try {
    descriptor = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(descriptor, `${process.pid}\n`, { encoding: "utf8" });
    closeSync(descriptor);
    descriptor = undefined;
  } catch {
    if (descriptor !== undefined) closeSync(descriptor);
    fail("another run may be active; refusing concurrent backup tooling");
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      unlinkSync(lockPath);
    } catch {
      // A stale lock is safer than deleting an unexpected path.
    }
  };
  process.once("exit", release);
  return () => {
    process.off("exit", release);
    release();
  };
}

export function readBackupConfig(environment = process.env) {
  exactFlag(environment, "HANDLEPLAN_BACKUP_ENABLED", "true");
  if (environment.HANDLEPLAN_BACKUP_CAPTURE_PATH !== undefined) {
    fail("HANDLEPLAN_BACKUP_CAPTURE_PATH is obsolete; use HANDLEPLAN_BACKUP_CAPTURE_ROOT");
  }

  const datasetId = environment.HANDLEPLAN_BACKUP_DATASET_ID ?? "handleplan-database";
  if (!/^[a-z][a-z0-9-]{2,62}$/u.test(datasetId)) {
    fail("HANDLEPLAN_BACKUP_DATASET_ID has an invalid value");
  }
  const pgService = envValue(environment, "HANDLEPLAN_BACKUP_PGSERVICE");
  if (!SAFE_ID.test(pgService)) {
    fail("HANDLEPLAN_BACKUP_PGSERVICE has an invalid value");
  }
  const expectedDatabase = envValue(environment, "HANDLEPLAN_BACKUP_EXPECTED_DATABASE");
  if (!SAFE_ID.test(expectedDatabase)) {
    fail("HANDLEPLAN_BACKUP_EXPECTED_DATABASE has an invalid value");
  }
  const expectedRole = envValue(environment, "HANDLEPLAN_BACKUP_EXPECTED_ROLE");
  if (!SAFE_ID.test(expectedRole)) {
    fail("HANDLEPLAN_BACKUP_EXPECTED_ROLE has an invalid value");
  }
  const expectedServerIdSha256 = envValue(environment, "HANDLEPLAN_BACKUP_EXPECTED_SERVER_ID_SHA256");
  if (!SAFE_SHA256.test(expectedServerIdSha256)) {
    fail("HANDLEPLAN_BACKUP_EXPECTED_SERVER_ID_SHA256 has an invalid value");
  }
  const workDirectory = requirePrivateOwnedDirectory(environment, "HANDLEPLAN_BACKUP_WORK_DIR");
  const evidenceDirectory = requirePrivateOwnedDirectory(environment, "HANDLEPLAN_BACKUP_EVIDENCE_DIR");
  const expectedCaptureOwnerUid = integerEnvironment(
    environment,
    "HANDLEPLAN_BACKUP_EXPECTED_CAPTURE_OWNER_UID",
    0,
    2_147_483_647,
  );
  const captureRoot = requirePrivateCaptureRoot(
    environment,
    "HANDLEPLAN_BACKUP_CAPTURE_ROOT",
    expectedCaptureOwnerUid,
  );
  ensureSeparateDirectories(workDirectory, evidenceDirectory);
  ensureSeparateDirectories(workDirectory, captureRoot);
  ensureSeparateDirectories(evidenceDirectory, captureRoot);

  return {
    ageBinary: requireExecutable(environment, "HANDLEPLAN_BACKUP_AGE_BIN"),
    ageRecipientsFile: requireRegularFile(
      environment,
      "HANDLEPLAN_BACKUP_AGE_RECIPIENTS_FILE",
      { trustedFile: true },
    ),
    applicationName: "handleplan_offhost_backup_v1",
    commandTimeoutMs: integerEnvironment(
      environment,
      "HANDLEPLAN_BACKUP_COMMAND_TIMEOUT_MS",
      5_000,
      2 * 60 * 60 * 1000,
    ),
    captureRoot,
    datasetId,
    evidenceDirectory,
    expectedDatabase,
    expectedCaptureOwnerUid,
    expectedRole,
    expectedServerIdSha256,
    migrationsDirectory: requireReadOnlyDirectory(environment, "HANDLEPLAN_BACKUP_MIGRATIONS_DIR"),
    pgDumpBinary: requireExecutable(environment, "HANDLEPLAN_BACKUP_PGDUMP_BIN"),
    pgRestoreBinary: requireExecutable(environment, "HANDLEPLAN_BACKUP_PGRESTORE_BIN"),
    pgService,
    pgServiceFile: requireRegularFile(environment, "HANDLEPLAN_BACKUP_PGSERVICE_FILE", { privateFile: true }),
    pgpassFile: requireRegularFile(environment, "HANDLEPLAN_BACKUP_PGPASS_FILE", { privateFile: true }),
    psqlBinary: requireExecutable(environment, "HANDLEPLAN_BACKUP_PSQL_BIN"),
    maxArtifactBytes: integerEnvironment(
      environment,
      "HANDLEPLAN_BACKUP_MAX_ARTIFACT_BYTES",
      1024 * 1024,
      1024 * 1024 * 1024 * 1024,
    ),
    maxCaptureArtifactBytes: integerEnvironment(
      environment,
      "HANDLEPLAN_BACKUP_MAX_CAPTURE_ARTIFACT_BYTES",
      1,
      1024 * 1024 * 1024 * 1024,
    ),
    maxCaptureFiles: integerEnvironment(
      environment,
      "HANDLEPLAN_BACKUP_MAX_CAPTURE_FILES",
      1,
      1_000_000,
    ),
    maxCaptureLedgerBytes: integerEnvironment(
      environment,
      "HANDLEPLAN_BACKUP_MAX_CAPTURE_LEDGER_BYTES",
      1024,
      256 * 1024 * 1024,
    ),
    maxCapturePlaintextBytes: integerEnvironment(
      environment,
      "HANDLEPLAN_BACKUP_MAX_CAPTURE_PLAINTEXT_BYTES",
      1,
      1024 * 1024 * 1024 * 1024,
    ),
    retentionDays: integerEnvironment(environment, "HANDLEPLAN_BACKUP_RETENTION_DAYS", 1, 3650),
    uploadAdapter: requireExecutable(environment, "HANDLEPLAN_BACKUP_UPLOAD_ADAPTER"),
    workDirectory,
  };
}

function parseDatabaseIdentity(text, { requireOwner, label }) {
  const fields = text.split("\t");
  const expectedFieldCount = requireOwner ? 11 : 3;
  if (
    fields.length !== expectedFieldCount
    || !SAFE_ID.test(fields[0] ?? "")
    || !SAFE_ID.test(fields[1] ?? "")
    || !SAFE_SHA256.test(fields[2] ?? "")
    || (requireOwner && fields.slice(3).some((field) => !["true", "false"].includes(field)))
  ) {
    fail(`${label} database identity response is invalid`);
  }
  return {
    database: fields[0],
    hasNoMemberships: requireOwner ? fields[9] === "true" : undefined,
    owner: requireOwner ? fields[3] === "true" : undefined,
    ownsOnlyCurrentDatabase: requireOwner ? fields[10] === "true" : undefined,
    privileged: requireOwner ? fields.slice(4, 9).some((field) => field === "true") : undefined,
    role: fields[1],
    serverIdSha256: fields[2],
  };
}

function parseBackupDatabaseIdentity(text) {
  const fields = text.split("\t");
  if (
    fields.length !== 10
    || !SAFE_ID.test(fields[0] ?? "")
    || !SAFE_ID.test(fields[1] ?? "")
    || !SAFE_SHA256.test(fields[2] ?? "")
    || fields.slice(3).some((field) => !["true", "false"].includes(field))
  ) {
    fail("backup source database identity response is invalid");
  }
  return {
    database: fields[0],
    hasNoMemberships: fields[8] === "true",
    ownsNoDatabases: fields[9] === "true",
    privileged: fields.slice(3, 8).some((field) => field === "true"),
    role: fields[1],
    serverIdSha256: fields[2],
  };
}

function validateBackupSnapshotSession(session, config) {
  if (
    session === null
    || typeof session !== "object"
    || typeof session.close !== "function"
    || !SAFE_EXPORTED_SNAPSHOT.test(session.snapshotId ?? "")
  ) {
    fail("backup source did not provide a valid live exported-snapshot session");
  }
  const identity = session.identity;
  if (
    identity === null
    || typeof identity !== "object"
    || identity.database !== config.expectedDatabase
    || identity.role !== config.expectedRole
    || identity.serverIdSha256 !== config.expectedServerIdSha256
    || identity.privileged !== false
    || identity.hasNoMemberships !== true
    || identity.ownsNoDatabases !== true
  ) {
    fail("configured backup source does not match its pinned unprivileged role and server identity");
  }
  if (session.requiredRelations !== "true\ttrue\ttrue\ttrue") {
    fail("backup source is missing required evidence relations");
  }
  const migrationLedger = parseLedger(
    serializeLedger(session.migrationLedger ?? []),
    "backup source",
  );
  requireLedgerPrefix(migrationLedger, repositoryMigrationLedger(config.migrationsDirectory), {
    exact: true,
    label: "backup source",
  });
  return { identity, migrationLedger, snapshotId: session.snapshotId };
}

export async function createBackup({
  capturePipelineRunner = runEncryptedPrivateCaptureArchive,
  environment = process.env,
  now = () => new Date(),
  pipelineRunner = runEncryptedDumpPipeline,
  randomSuffix = () => randomBytes(8).toString("hex"),
  runner = runCommand,
  sourceSessionRunner = openBackupSnapshotSession,
} = {}) {
  const config = readBackupConfig(environment);
  const createdAt = now();
  if (!(createdAt instanceof Date) || Number.isNaN(createdAt.valueOf())) {
    fail("backup clock is invalid");
  }
  const backupId = `${timestampForId(createdAt)}-${randomSuffix()}`;
  if (!SAFE_BACKUP_ID.test(backupId)) {
    fail("generated backup identifier is invalid");
  }
  const dateParts = createdAt.toISOString().slice(0, 10).split("-");
  const objectBase = [config.datasetId, ...dateParts, backupId].join("/");
  const retainUntil = new Date(createdAt.valueOf() + config.retentionDays * 86_400_000).toISOString();
  const releaseLock = acquireRunLock(config.workDirectory, ".backup.lock");
  let scratch;
  try {
    scratch = mkdtempSync(join(config.workDirectory, ".run-"));
  } catch {
    releaseLock();
    fail("could not create the private backup run directory");
  }
  chmodSync(scratch, 0o700);
  const cleanupScratch = () => rmSync(scratch, { force: true, recursive: true });
  process.once("exit", cleanupScratch);

  const encryptedPath = join(scratch, "database.dump.age");
  const encryptedCapturesPath = join(scratch, "private-captures.bundle.age");
  const checksumPath = join(scratch, "SHA256SUMS");
  const manifestPath = join(scratch, "manifest.json");
  try {
    const pinnedServiceFile = join(scratch, "pg_service.conf");
    copyBoundedPrivate(config.pgServiceFile, pinnedServiceFile, 64 * 1024, "libpq service file");
    const operationConfig = { ...config, pgServiceFile: pinnedServiceFile };
    requirePinnedLocalService(operationConfig);
    const sourceSession = await sourceSessionRunner(operationConfig);
    let sourceBefore;
    let archivedCaptureLedger;
    try {
      sourceBefore = validateBackupSnapshotSession(sourceSession, operationConfig);
      const pipeline = await pipelineRunner({
        ...operationConfig,
        encryptedPath,
        snapshotId: sourceBefore.snapshotId,
      });
      validateArchiveList(pipeline.archiveList);
      const archivedLedger = parseExtractedLedger(pipeline.ledgerSql);
      archivedCaptureLedger = parseExtractedCaptureLedger(
        pipeline.captureLedgerSql,
        config.maxCaptureLedgerBytes,
      );
      if (serializeLedger(archivedLedger) !== serializeLedger(sourceBefore.migrationLedger)) {
        fail("exported-snapshot archive migration ledger does not match its source session");
      }
    } finally {
      if (typeof sourceSession?.close === "function") {
        await sourceSession.close();
      }
    }
    if (
      !existsSync(encryptedPath)
      || statSync(encryptedPath).size <= 0
      || statSync(encryptedPath).size > config.maxArtifactBytes
    ) {
      fail("age did not create a non-empty encrypted artifact");
    }
    chmodSync(encryptedPath, 0o600);

    const encryptedSha256 = sha256File(encryptedPath);
    const encryptedBytes = statSync(encryptedPath).size;
    const captureDeadlineMs = Date.now() + config.commandTimeoutMs;
    const captureStoreBefore = captureCall(() => scanPrivateCaptureStore({
      deadlineMs: captureDeadlineMs,
      expectedOwnerUid: config.expectedCaptureOwnerUid,
      maxFiles: config.maxCaptureFiles,
      maxPlaintextBytes: config.maxCapturePlaintextBytes,
      rootDirectory: config.captureRoot,
    }));
    const captureSnapshot = captureCall(() => bindPrivateCaptureDatabaseLedger(
      captureStoreBefore,
      archivedCaptureLedger.entries,
    ));
    await captureCallAsync(() => capturePipelineRunner({
      ageBinary: config.ageBinary,
      ageRecipientsFile: config.ageRecipientsFile,
      commandTimeoutMs: Math.max(1, captureDeadlineMs - Date.now()),
      encryptedPath: encryptedCapturesPath,
      maxArtifactBytes: config.maxCaptureArtifactBytes,
      snapshot: captureSnapshot,
    }));
    const captureStoreAfter = captureCall(() => scanPrivateCaptureStore({
      deadlineMs: captureDeadlineMs,
      expectedOwnerUid: config.expectedCaptureOwnerUid,
      maxFiles: config.maxCaptureFiles,
      maxPlaintextBytes: config.maxCapturePlaintextBytes,
      rootDirectory: config.captureRoot,
    }));
    captureCall(() => assertPrivateCaptureStoreUnchanged(captureStoreBefore, captureStoreAfter));
    if (
      !existsSync(encryptedCapturesPath)
      || statSync(encryptedCapturesPath).size <= 0
      || statSync(encryptedCapturesPath).size > config.maxCaptureArtifactBytes
    ) {
      fail("age did not create a bounded private-capture ciphertext artifact");
    }
    chmodSync(encryptedCapturesPath, 0o600);
    const captureCiphertextSha256 = sha256File(encryptedCapturesPath);
    const captureCiphertextBytes = statSync(encryptedCapturesPath).size;

    const manifest = {
      backupId,
      captures: {
        bytes: captureCiphertextBytes,
        databaseLedgerSha256: captureSnapshot.databaseLedgerSha256,
        databaseReferencedEntryCount: captureSnapshot.databaseReferencedEntryCount,
        encryption: "age-authenticated-encryption",
        entryCount: captureSnapshot.entryCount,
        fileName: "private-captures.bundle.age",
        format: privateCaptureArchiveContract.format,
        inventorySha256: captureSnapshot.inventorySha256,
        objectKey: `${objectBase}/private-captures.bundle.age`,
        plaintextBytes: captureSnapshot.plaintextBytes,
        selection: "database-archive-publication-captures-v1",
        sha256: captureCiphertextSha256,
        status: "included",
      },
      createdAt: createdAt.toISOString(),
      datasetId: config.datasetId,
      database: {
        bytes: encryptedBytes,
        encryption: "age-authenticated-encryption",
        fileName: "database.dump.age",
        format: "postgresql-custom-v1",
        objectKey: `${objectBase}/database.dump.age`,
        sha256: encryptedSha256,
      },
      kind: "handleplan-offhost-backup-manifest",
      limits: {
        maxArtifactBytes: config.maxArtifactBytes,
        maxCaptureArtifactBytes: config.maxCaptureArtifactBytes,
        maxCaptureBlobBytes: privateCaptureArchiveContract.maxBlobBytes,
        maxCaptureFiles: config.maxCaptureFiles,
        maxCapturePlaintextBytes: config.maxCapturePlaintextBytes,
      },
      retention: {
        days: config.retentionDays,
        enforcement: "off-host-object-lifecycle-required",
        retainUntil,
      },
      schemaVersion: 2,
      source: {
        archiveSessionBinding: "postgresql-exported-snapshot-v1",
        database: sourceBefore.identity.database,
        migrationLedger: sourceBefore.migrationLedger,
        role: sourceBefore.identity.role,
        roleHasNoMemberships: sourceBefore.identity.hasNoMemberships,
        roleOwnsNoDatabases: sourceBefore.identity.ownsNoDatabases,
        roleUnprivileged: !sourceBefore.identity.privileged,
        schemaContract: "handleplan-evidence-relations-v1",
        probedServerIdSha256: sourceBefore.identity.serverIdSha256,
      },
    };
    writePrivate(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const manifestSha256 = sha256File(manifestPath);
    writePrivate(
      checksumPath,
      `${encryptedSha256}  database.dump.age\n${captureCiphertextSha256}  private-captures.bundle.age\n${manifestSha256}  manifest.json\n`,
    );

    const upload = (sourceFile, objectKey, mediaType) => runner(config.uploadAdapter, [], {
      env: adapterEnvironment(environment, {
        HANDLEPLAN_BACKUP_UPLOAD_MEDIA_TYPE: mediaType,
        HANDLEPLAN_BACKUP_UPLOAD_OBJECT_KEY: objectKey,
        HANDLEPLAN_BACKUP_UPLOAD_OPERATION: "put-create-only",
        HANDLEPLAN_BACKUP_UPLOAD_RETENTION_UNTIL: retainUntil,
        HANDLEPLAN_BACKUP_UPLOAD_SOURCE_FILE: sourceFile,
        HANDLEPLAN_BACKUP_UPLOAD_TIMEOUT_MS: String(config.commandTimeoutMs),
      }),
      failureMessage: "off-host upload failed without publishing a completion manifest",
      timeoutMs: config.commandTimeoutMs,
    });

    await upload(encryptedPath, `${objectBase}/database.dump.age`, "application/octet-stream");
    await upload(
      encryptedCapturesPath,
      `${objectBase}/private-captures.bundle.age`,
      "application/octet-stream",
    );
    await upload(checksumPath, `${objectBase}/SHA256SUMS`, "text/plain");
    // The manifest is deliberately last. Its presence is the completion marker.
    await upload(manifestPath, `${objectBase}/manifest.json`, "application/json");

    const evidenceManifest = join(config.evidenceDirectory, `${backupId}.manifest.json`);
    const evidenceChecksums = join(config.evidenceDirectory, `${backupId}.SHA256SUMS`);
    atomicCopy(checksumPath, evidenceChecksums);
    // The local manifest is also the completion marker and is published last.
    atomicCopy(manifestPath, evidenceManifest);

    return { backupId, evidenceChecksums, evidenceManifest, manifest, manifestSha256 };
  } finally {
    process.off("exit", cleanupScratch);
    cleanupScratch();
    releaseLock();
  }
}

export function readRestoreConfig(environment = process.env) {
  exactFlag(environment, "HANDLEPLAN_RESTORE_DRILL_ENABLED", "true");
  exactFlag(
    environment,
    "HANDLEPLAN_RESTORE_ISOLATION_ACK",
    "isolated-disposable-nonproduction-database",
  );
  exactFlag(
    environment,
    "HANDLEPLAN_RESTORE_CLUSTER_ACK",
    "server-identity-reviewed-nonproduction",
  );
  exactFlag(
    environment,
    "HANDLEPLAN_RESTORE_TEMPLATE_ACK",
    "created-from-template0-for-this-drill",
  );
  const expectedDatabase = envValue(environment, "HANDLEPLAN_RESTORE_EXPECTED_DATABASE");
  if (!SAFE_RESTORE_DATABASE.test(expectedDatabase) || /prod(?:uction)?/u.test(expectedDatabase)) {
    fail("HANDLEPLAN_RESTORE_EXPECTED_DATABASE must use the dedicated restore-drill naming contract");
  }
  const pgService = envValue(environment, "HANDLEPLAN_RESTORE_PGSERVICE");
  if (!SAFE_RESTORE_DATABASE.test(pgService) || /prod(?:uction)?/u.test(pgService)) {
    fail("HANDLEPLAN_RESTORE_PGSERVICE must use the dedicated restore-drill naming contract");
  }
  const expectedRole = envValue(environment, "HANDLEPLAN_RESTORE_EXPECTED_ROLE");
  if (!SAFE_RESTORE_DATABASE.test(expectedRole) || /prod(?:uction)?/u.test(expectedRole)) {
    fail("HANDLEPLAN_RESTORE_EXPECTED_ROLE must use the dedicated restore-drill naming contract");
  }
  const expectedServerIdSha256 = envValue(environment, "HANDLEPLAN_RESTORE_EXPECTED_SERVER_ID_SHA256");
  if (!SAFE_SHA256.test(expectedServerIdSha256)) {
    fail("HANDLEPLAN_RESTORE_EXPECTED_SERVER_ID_SHA256 has an invalid value");
  }
  const expectedBackupId = envValue(environment, "HANDLEPLAN_RESTORE_EXPECTED_BACKUP_ID");
  if (!SAFE_BACKUP_ID.test(expectedBackupId)) {
    fail("HANDLEPLAN_RESTORE_EXPECTED_BACKUP_ID has an invalid value");
  }
  const expectedObjectKey = envValue(environment, "HANDLEPLAN_RESTORE_EXPECTED_OBJECT_KEY");
  if (!safeObjectKey(expectedObjectKey)) {
    fail("HANDLEPLAN_RESTORE_EXPECTED_OBJECT_KEY has an invalid value");
  }
  const expectedCaptureObjectKey = envValue(
    environment,
    "HANDLEPLAN_RESTORE_EXPECTED_CAPTURE_OBJECT_KEY",
  );
  if (!safeObjectKey(expectedCaptureObjectKey)) {
    fail("HANDLEPLAN_RESTORE_EXPECTED_CAPTURE_OBJECT_KEY has an invalid value");
  }
  const expectedCiphertextSha256 = envValue(
    environment,
    "HANDLEPLAN_RESTORE_EXPECTED_CIPHERTEXT_SHA256",
  );
  if (!SAFE_SHA256.test(expectedCiphertextSha256)) {
    fail("HANDLEPLAN_RESTORE_EXPECTED_CIPHERTEXT_SHA256 has an invalid value");
  }
  const expectedCaptureCiphertextSha256 = envValue(
    environment,
    "HANDLEPLAN_RESTORE_EXPECTED_CAPTURE_CIPHERTEXT_SHA256",
  );
  if (!SAFE_SHA256.test(expectedCaptureCiphertextSha256)) {
    fail("HANDLEPLAN_RESTORE_EXPECTED_CAPTURE_CIPHERTEXT_SHA256 has an invalid value");
  }
  const expectedManifestSha256 = envValue(
    environment,
    "HANDLEPLAN_RESTORE_EXPECTED_MANIFEST_SHA256",
  );
  if (!SAFE_SHA256.test(expectedManifestSha256)) {
    fail("HANDLEPLAN_RESTORE_EXPECTED_MANIFEST_SHA256 has an invalid value");
  }
  const workDirectory = requirePrivateOwnedDirectory(environment, "HANDLEPLAN_RESTORE_WORK_DIR");
  const evidenceDirectory = requirePrivateOwnedDirectory(environment, "HANDLEPLAN_RESTORE_EVIDENCE_DIR");
  ensureSeparateDirectories(workDirectory, evidenceDirectory);

  return {
    ageBinary: requireExecutable(environment, "HANDLEPLAN_RESTORE_AGE_BIN"),
    ageIdentityFile: requireRegularFile(environment, "HANDLEPLAN_RESTORE_AGE_IDENTITY_FILE", { privateFile: true }),
    applicationName: "handleplan_isolated_restore_drill_v1",
    commandTimeoutMs: integerEnvironment(
      environment,
      "HANDLEPLAN_RESTORE_COMMAND_TIMEOUT_MS",
      5_000,
      2 * 60 * 60 * 1000,
    ),
    downloadAdapter: requireExecutable(environment, "HANDLEPLAN_RESTORE_DOWNLOAD_ADAPTER"),
    encryptedFile: requireRegularFile(environment, "HANDLEPLAN_RESTORE_ENCRYPTED_FILE", { privateFile: true }),
    evidenceDirectory,
    expectedDatabase,
    expectedBackupId,
    expectedCaptureCiphertextSha256,
    expectedCaptureObjectKey,
    expectedCiphertextSha256,
    expectedManifestSha256,
    expectedObjectKey,
    expectedRole,
    expectedServerIdSha256,
    manifestFile: requireRegularFile(environment, "HANDLEPLAN_RESTORE_MANIFEST_FILE", { privateFile: true }),
    maxArtifactBytes: integerEnvironment(
      environment,
      "HANDLEPLAN_RESTORE_MAX_ARTIFACT_BYTES",
      1024 * 1024,
      1024 * 1024 * 1024 * 1024,
    ),
    maxCaptureArtifactBytes: integerEnvironment(
      environment,
      "HANDLEPLAN_RESTORE_MAX_CAPTURE_ARTIFACT_BYTES",
      1,
      1024 * 1024 * 1024 * 1024,
    ),
    maxCaptureFiles: integerEnvironment(
      environment,
      "HANDLEPLAN_RESTORE_MAX_CAPTURE_FILES",
      1,
      1_000_000,
    ),
    maxCapturePlaintextBytes: integerEnvironment(
      environment,
      "HANDLEPLAN_RESTORE_MAX_CAPTURE_PLAINTEXT_BYTES",
      1,
      1024 * 1024 * 1024 * 1024,
    ),
    migrationsDirectory: requireReadOnlyDirectory(environment, "HANDLEPLAN_RESTORE_MIGRATIONS_DIR"),
    pgRestoreBinary: requireExecutable(environment, "HANDLEPLAN_RESTORE_PGRESTORE_BIN"),
    pgService,
    pgServiceFile: requireRegularFile(environment, "HANDLEPLAN_RESTORE_PGSERVICE_FILE", { privateFile: true }),
    pgpassFile: requireRegularFile(environment, "HANDLEPLAN_RESTORE_PGPASS_FILE", { privateFile: true }),
    psqlBinary: requireExecutable(environment, "HANDLEPLAN_RESTORE_PSQL_BIN"),
    workDirectory,
  };
}

function parseManifest(path) {
  let value;
  try {
    if (statSync(path).size > 128 * 1024) {
      fail("restore manifest exceeds the bounded size limit");
    }
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof BackupSafetyError) throw error;
    fail("restore manifest is not valid JSON");
  }
  const createdAt = new Date(value?.createdAt ?? "");
  const datasetId = value?.datasetId;
  const retentionDays = value?.retention?.days;
  const expectedRetainUntil = Number.isInteger(retentionDays) && !Number.isNaN(createdAt.valueOf())
    ? new Date(createdAt.valueOf() + retentionDays * 86_400_000).toISOString()
    : "";
  const expectedObjectKey = (
    typeof datasetId === "string"
    && !Number.isNaN(createdAt.valueOf())
    && typeof value?.backupId === "string"
  )
    ? [
      datasetId,
      ...createdAt.toISOString().slice(0, 10).split("-"),
      value.backupId,
      "database.dump.age",
    ].join("/")
    : "";
  const expectedCaptureObjectKey = (
    typeof datasetId === "string"
    && !Number.isNaN(createdAt.valueOf())
    && typeof value?.backupId === "string"
  )
    ? [
      datasetId,
      ...createdAt.toISOString().slice(0, 10).split("-"),
      value.backupId,
      "private-captures.bundle.age",
    ].join("/")
    : "";
  if (
    value?.schemaVersion !== 2
    || value?.kind !== "handleplan-offhost-backup-manifest"
    || !SAFE_BACKUP_ID.test(value?.backupId ?? "")
    || !/^[a-z][a-z0-9-]{2,62}$/u.test(datasetId ?? "")
    || Number.isNaN(createdAt.valueOf())
    || createdAt.toISOString() !== value.createdAt
    || timestampForId(createdAt) !== value.backupId.slice(0, 16)
    || value?.database?.fileName !== "database.dump.age"
    || !SAFE_SHA256.test(value?.database?.sha256 ?? "")
    || !Number.isSafeInteger(value?.database?.bytes)
    || value.database.bytes <= 0
    || !safeObjectKey(value?.database?.objectKey)
    || value.database.objectKey !== expectedObjectKey
    || value?.database?.encryption !== "age-authenticated-encryption"
    || value?.database?.format !== "postgresql-custom-v1"
    || !Number.isSafeInteger(value?.limits?.maxArtifactBytes)
    || value.limits.maxArtifactBytes < 1024 * 1024
    || value.database.bytes > value.limits.maxArtifactBytes
    || value?.captures?.status !== "included"
    || value?.captures?.fileName !== "private-captures.bundle.age"
    || value?.captures?.format !== privateCaptureArchiveContract.format
    || value?.captures?.encryption !== "age-authenticated-encryption"
    || value?.captures?.selection !== "database-archive-publication-captures-v1"
    || !safeObjectKey(value?.captures?.objectKey)
    || value.captures.objectKey !== expectedCaptureObjectKey
    || !SAFE_SHA256.test(value?.captures?.sha256 ?? "")
    || !SAFE_SHA256.test(value?.captures?.inventorySha256 ?? "")
    || !SAFE_SHA256.test(value?.captures?.databaseLedgerSha256 ?? "")
    || !Number.isSafeInteger(value?.captures?.bytes)
    || value.captures.bytes < 1
    || !Number.isSafeInteger(value?.captures?.entryCount)
    || value.captures.entryCount < 0
    || !Number.isSafeInteger(value?.captures?.databaseReferencedEntryCount)
    || value.captures.databaseReferencedEntryCount !== value.captures.entryCount
    || !Number.isSafeInteger(value?.captures?.plaintextBytes)
    || value.captures.plaintextBytes < 0
    || !Number.isSafeInteger(value?.limits?.maxCaptureArtifactBytes)
    || value.limits.maxCaptureArtifactBytes < 1
    || value.limits.maxCaptureArtifactBytes > 1024 * 1024 * 1024 * 1024
    || value.captures.bytes > value.limits.maxCaptureArtifactBytes
    || !Number.isSafeInteger(value?.limits?.maxCaptureBlobBytes)
    || value.limits.maxCaptureBlobBytes !== privateCaptureArchiveContract.maxBlobBytes
    || !Number.isSafeInteger(value?.limits?.maxCaptureFiles)
    || value.limits.maxCaptureFiles < 1
    || value.limits.maxCaptureFiles > 1_000_000
    || value.captures.entryCount > value.limits.maxCaptureFiles
    || !Number.isSafeInteger(value?.limits?.maxCapturePlaintextBytes)
    || value.limits.maxCapturePlaintextBytes < 1
    || value.limits.maxCapturePlaintextBytes > 1024 * 1024 * 1024 * 1024
    || value.captures.plaintextBytes > value.limits.maxCapturePlaintextBytes
    || !Number.isSafeInteger(retentionDays)
    || retentionDays < 1
    || retentionDays > 3650
    || value?.retention?.enforcement !== "off-host-object-lifecycle-required"
    || value?.retention?.retainUntil !== expectedRetainUntil
    || !SAFE_ID.test(value?.source?.database ?? "")
    || !SAFE_ID.test(value?.source?.role ?? "")
    || value?.source?.roleHasNoMemberships !== true
    || value?.source?.roleOwnsNoDatabases !== true
    || value?.source?.roleUnprivileged !== true
    || !SAFE_SHA256.test(value?.source?.probedServerIdSha256 ?? "")
    || value?.source?.archiveSessionBinding !== "postgresql-exported-snapshot-v1"
    || value?.source?.schemaContract !== "handleplan-evidence-relations-v1"
    || !Array.isArray(value?.source?.migrationLedger)
  ) {
    fail("restore manifest does not satisfy the v2 backup contract");
  }
  const migrationLedger = parseLedger(
    value.source.migrationLedger.map((entry) => `${entry?.id ?? ""}\t${entry?.checksum ?? ""}`).join("\n"),
    "manifest source",
  );
  return { ...value, source: { ...value.source, migrationLedger } };
}

async function query(runner, config, sql, failureMessage, { maxBuffer = 64 * 1024 } = {}) {
  return (await runner(config.psqlBinary, [
    "--no-psqlrc",
    "--quiet",
    "--tuples-only",
    "--no-align",
    "--set=ON_ERROR_STOP=1",
    `--command=${sql}`,
  ], {
    captureStdout: true,
    env: databaseEnvironment(config),
    failureMessage,
    maxBuffer,
    timeoutMs: Math.min(config.commandTimeoutMs, 60_000),
  })).trim();
}

async function retrievePrivateCaptureCiphertext({
  config,
  destination,
  environment,
  manifest,
  runner,
}) {
  if (existsSync(destination)) {
    fail("private-capture restore destination already exists before retrieval");
  }
  await runner(config.downloadAdapter, [], {
    boundedOutputPath: destination,
    env: restoreAdapterEnvironment(environment, {
      HANDLEPLAN_RESTORE_DOWNLOAD_DESTINATION_FILE: destination,
      HANDLEPLAN_RESTORE_DOWNLOAD_EXPECTED_BYTES: String(manifest.captures.bytes),
      HANDLEPLAN_RESTORE_DOWNLOAD_EXPECTED_SHA256: manifest.captures.sha256,
      HANDLEPLAN_RESTORE_DOWNLOAD_OBJECT_KEY: manifest.captures.objectKey,
      HANDLEPLAN_RESTORE_DOWNLOAD_OPERATION: "get-create-only",
      HANDLEPLAN_RESTORE_DOWNLOAD_TIMEOUT_MS: String(config.commandTimeoutMs),
    }),
    failureMessage: "private-capture off-host retrieval failed",
    maxOutputFileBytes: manifest.captures.bytes,
    timeoutMs: config.commandTimeoutMs,
  });
  let before;
  try {
    before = lstatSync(destination);
  } catch {
    fail("private-capture retrieval produced no ciphertext");
  }
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || before.nlink !== 1
    || (before.mode & 0o777) !== 0o600
    || (typeof process.getuid === "function" && before.uid !== process.getuid())
    || before.size !== manifest.captures.bytes
    || before.size > config.maxCaptureArtifactBytes
  ) {
    fail("private-capture retrieval produced an unsafe ciphertext file");
  }
  const digest = sha256File(destination);
  const after = lstatSync(destination);
  if (!sameFileIdentity(before, after) || digest !== manifest.captures.sha256) {
    fail("private-capture retrieved ciphertext does not match its manifest");
  }
  return { bytes: after.size, sha256: digest };
}

const CLEAN_ROOM_CATALOG_QUERY = [
  "select concat_ws(E'\\t',",
  "(select count(*) from pg_catalog.pg_namespace n where n.nspname not in ('pg_catalog', 'information_schema', 'public') and n.nspname !~ '^pg_(toast|temp)'),",
  "(select count(*) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast|temp)'),",
  "(select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast|temp)'),",
  "(select count(*) from pg_catalog.pg_type t join pg_catalog.pg_namespace n on n.oid = t.typnamespace where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast|temp)'),",
  "(select count(*) from pg_catalog.pg_extension e join pg_catalog.pg_namespace n on n.oid = e.extnamespace where not (e.extname = 'plpgsql' and n.nspname = 'pg_catalog')),",
  "(select count(*) from pg_catalog.pg_event_trigger))",
].join(" ");

const CLEAN_ROOM_CATALOG_VECTOR = "0\t0\t0\t0\t0\t0";

const RESTORE_IDENTITY_QUERY = "select concat_ws(E'\\t', current_database(), current_user, encode(sha256(convert_to(system_identifier::text, 'UTF8')), 'hex'), (select pg_get_userbyid(datdba) = current_user from pg_database where datname = current_database()), (select rolsuper from pg_roles where rolname = current_user), (select rolcreaterole from pg_roles where rolname = current_user), (select rolcreatedb from pg_roles where rolname = current_user), (select rolreplication from pg_roles where rolname = current_user), (select rolbypassrls from pg_roles where rolname = current_user), (select count(*) = 0 from pg_auth_members where member = (select oid from pg_roles where rolname = current_user)), (select count(*) = 0 from pg_database where datdba = (select oid from pg_roles where rolname = current_user) and datname <> current_database())) from pg_control_system()";

export async function verifyRestore({
  capturePipelineRunner = runPrivateCaptureArchiveVerification,
  environment = process.env,
  now = () => new Date(),
  pipelineRunner = runRestorePipeline,
  runner = runCommand,
} = {}) {
  const config = readRestoreConfig(environment);
  const startedAt = now();
  if (!(startedAt instanceof Date) || Number.isNaN(startedAt.valueOf())) {
    fail("restore clock is invalid");
  }
  const releaseLock = acquireRunLock(config.workDirectory, ".restore.lock");
  let scratch;
  try {
    scratch = mkdtempSync(join(config.workDirectory, ".restore-"));
  } catch {
    releaseLock();
    fail("could not create the private restore run directory");
  }
  chmodSync(scratch, 0o700);
  const cleanupScratch = () => rmSync(scratch, { force: true, recursive: true });
  process.once("exit", cleanupScratch);
  try {
    const pinnedManifestFile = join(scratch, "selected-manifest.json");
    copyBoundedPrivate(config.manifestFile, pinnedManifestFile, 128 * 1024, "restore manifest");
    const manifestSha256 = sha256File(pinnedManifestFile);
    if (manifestSha256 !== config.expectedManifestSha256) {
      fail("restore manifest does not match its independently pinned SHA-256");
    }
    const manifest = parseManifest(pinnedManifestFile);
    if (
      manifest.backupId !== config.expectedBackupId
      || manifest.database.objectKey !== config.expectedObjectKey
      || manifest.database.sha256 !== config.expectedCiphertextSha256
      || manifest.captures.objectKey !== config.expectedCaptureObjectKey
      || manifest.captures.sha256 !== config.expectedCaptureCiphertextSha256
    ) {
      fail("restore manifest does not match the operator-pinned backup selection");
    }
    if (
      manifest.database.bytes > config.maxArtifactBytes
      || manifest.captures.bytes > config.maxCaptureArtifactBytes
      || manifest.captures.entryCount > config.maxCaptureFiles
      || manifest.captures.plaintextBytes > config.maxCapturePlaintextBytes
    ) {
      fail("encrypted backup exceeds the bounded restore size limit");
    }
    const currentLedger = repositoryMigrationLedger(config.migrationsDirectory);
    requireLedgerPrefix(manifest.source.migrationLedger, currentLedger, {
      exact: false,
      label: "selected backup",
    });

    const pinnedServiceFile = join(scratch, "pg_service.conf");
    copyBoundedPrivate(config.pgServiceFile, pinnedServiceFile, 64 * 1024, "libpq service file");
    const operationConfig = { ...config, pgServiceFile: pinnedServiceFile };
    requirePinnedLocalService(operationConfig);
    const identityBefore = parseDatabaseIdentity(await query(
      runner,
      operationConfig,
      RESTORE_IDENTITY_QUERY,
      "could not verify the configured restore destination identity",
    ), { label: "restore destination", requireOwner: true });
    if (
      identityBefore.database !== config.expectedDatabase
      || identityBefore.role !== config.expectedRole
      || identityBefore.serverIdSha256 !== config.expectedServerIdSha256
      || !identityBefore.owner
      || identityBefore.privileged
      || !identityBefore.hasNoMemberships
      || !identityBefore.ownsOnlyCurrentDatabase
      || identityBefore.serverIdSha256 === manifest.source.probedServerIdSha256
    ) {
      fail("restore destination does not match the pinned isolated unprivileged-owner contract");
    }
    const cleanRoomCatalog = await query(
      runner,
      operationConfig,
      CLEAN_ROOM_CATALOG_QUERY,
      "could not prove the restore destination catalog clean-room contract",
    );
    if (cleanRoomCatalog !== CLEAN_ROOM_CATALOG_VECTOR) {
      fail("restore destination is not a template0 catalog clean room; refusing to execute archive DDL");
    }

    const retrievedCaptureFile = join(scratch, "selected-private-captures.age");
    const retrievedCapture = await retrievePrivateCaptureCiphertext({
      config,
      destination: retrievedCaptureFile,
      environment,
      manifest,
      runner,
    });
    const captureVerification = await captureCallAsync(() => capturePipelineRunner({
      ageBinary: config.ageBinary,
      ageIdentityFile: config.ageIdentityFile,
      commandTimeoutMs: config.commandTimeoutMs,
      encryptedFile: retrievedCaptureFile,
      expected: {
        databaseLedgerSha256: manifest.captures.databaseLedgerSha256,
        databaseReferencedEntryCount: manifest.captures.databaseReferencedEntryCount,
        entryCount: manifest.captures.entryCount,
        inventorySha256: manifest.captures.inventorySha256,
        plaintextBytes: manifest.captures.plaintextBytes,
      },
    }));

    const pinnedEncryptedFile = join(scratch, "selected-backup.age");
    const actualBytes = copyBoundedPrivate(
      config.encryptedFile,
      pinnedEncryptedFile,
      config.maxArtifactBytes,
    );
    const actualSha256 = sha256File(pinnedEncryptedFile);
    if (actualSha256 !== manifest.database.sha256 || actualBytes !== manifest.database.bytes) {
      fail("encrypted backup does not match its manifest and operator pin");
    }
    const restorePipeline = await pipelineRunner({
      ...operationConfig,
      encryptedFile: pinnedEncryptedFile,
      expectedExecutionIdentity: identityBefore,
    });
    validateArchiveList(restorePipeline.archiveList);
    requireRestoreExecutionProof(restorePipeline, identityBefore);
    const identityAfter = parseDatabaseIdentity(await query(
      runner,
      operationConfig,
      RESTORE_IDENTITY_QUERY,
      "could not read back the restored database identity",
    ), { label: "restored destination", requireOwner: true });
    if (JSON.stringify(identityAfter) !== JSON.stringify(identityBefore)) {
      fail("restored database identity changed unexpectedly");
    }
    const restoredLedger = parseLedger(await query(
      runner,
      operationConfig,
      "select id || E'\\t' || checksum from handleplan_schema_migrations order by id",
      "could not read back the restored migration ledger",
    ), "restored database");
    if (serializeLedger(restoredLedger) !== serializeLedger(manifest.source.migrationLedger)) {
      fail("restored migration ledger does not match the selected backup manifest");
    }

    const requiredRelations = await query(
      runner,
      operationConfig,
      "select concat_ws(E'\\t', to_regclass('public.ingestion_runs') is not null, to_regclass('public.price_observations') is not null, to_regclass('public.source_permissions') is not null, to_regclass('public.publication_captures') is not null)",
      "could not verify required restored relations",
    );
    if (requiredRelations !== "true\ttrue\ttrue\ttrue") {
      fail("restored database is missing required evidence relations");
    }
    const restoredCaptureLedger = parseCaptureQueryLedger(await query(
      runner,
      operationConfig,
      "select blob_key || E'\\t' || publication_id::text || E'\\t' || byte_length::text || E'\\t' || checksum::text from publication_captures order by blob_key",
      "could not verify the restored private-capture ledger",
      { maxBuffer: Math.min(256 * 1024 * 1024, config.maxCaptureFiles * 256 + 1024) },
    ));
    if (
      restoredCaptureLedger.entryCount !== manifest.captures.databaseReferencedEntryCount
      || restoredCaptureLedger.sha256 !== manifest.captures.databaseLedgerSha256
    ) {
      fail("restored private-capture metadata does not match the encrypted bundle");
    }

    const completedAt = now();
    if (!(completedAt instanceof Date) || Number.isNaN(completedAt.valueOf()) || completedAt < startedAt) {
      fail("restore completion clock is invalid");
    }
    const pendingMigrationCount = currentLedger.length - restoredLedger.length;
    const evidence = {
      archiveContract: manifest.source.schemaContract,
      archiveExecutionSessionBinding: RESTORE_EXECUTION_SESSION_BINDING,
      archiveListValidated: true,
      archiveSessionServerBindingVerified: true,
      backupId: manifest.backupId,
      cleanRoom: {
        catalogVectorVerified: true,
        template0Acknowledged: true,
      },
      completedAt: completedAt.toISOString(),
      ciphertextSha256: actualSha256,
      kind: "handleplan-isolated-restore-evidence",
      manifestSha256,
      migrationCount: restoredLedger.length,
      pendingMigrationCount,
      privateCaptureBlobs: {
        ciphertextBytes: retrievedCapture.bytes,
        ciphertextSha256: retrievedCapture.sha256,
        databaseReferencedEntryCount: captureVerification.databaseReferencedEntryCount,
        entryCount: captureVerification.entryCount,
        inventorySha256: captureVerification.inventorySha256,
        plaintextBytes: captureVerification.plaintextBytes,
        restoredDatabaseLedgerVerified: true,
        status: "encrypted-archive-stream-verified",
      },
      schemaVersion: 2,
      schemaState: pendingMigrationCount === 0 ? "current" : "forward-migration-required",
      semanticDataVerified: false,
      sourceProbeServerIdSha256: manifest.source.probedServerIdSha256,
      startedAt: startedAt.toISOString(),
      status: "archive-restored-schema-verified",
      target: {
        database: identityAfter.database,
        probeDiffersFromSourceProbe: identityAfter.serverIdSha256
          !== manifest.source.probedServerIdSha256,
        hasNoMemberships: identityAfter.hasNoMemberships,
        ownsOnlyCurrentDatabase: identityAfter.ownsOnlyCurrentDatabase,
        role: identityAfter.role,
        probedServerIdSha256: identityAfter.serverIdSha256,
        unprivilegedOwner: identityAfter.owner
          && !identityAfter.privileged
          && identityAfter.hasNoMemberships
          && identityAfter.ownsOnlyCurrentDatabase,
      },
    };
    const evidenceName = `${manifest.backupId}.restore-${timestampForId(completedAt)}.json`;
    const evidencePath = join(config.evidenceDirectory, evidenceName);
    atomicWrite(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    return { evidence, evidencePath };
  } finally {
    process.off("exit", cleanupScratch);
    cleanupScratch();
    releaseLock();
  }
}

export async function safeMain(action) {
  if (process.argv.length !== 2) {
    process.stderr.write("This command accepts configuration through named environment variables only.\n");
    process.exitCode = 2;
    return;
  }
  try {
    const result = await action();
    process.stdout.write(`${JSON.stringify({ evidence: basename(result.evidenceManifest ?? result.evidencePath), id: result.backupId ?? result.evidence.backupId, status: "ok" })}\n`);
  } catch (error) {
    const message = error instanceof BackupSafetyError ? error.message : "unexpected local failure";
    process.stderr.write(`Backup tooling stopped safely: ${message}.\n`);
    process.exitCode = 1;
  }
}
