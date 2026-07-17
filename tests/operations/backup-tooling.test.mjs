import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  BackupSafetyError,
  createBackup,
  openBackupSnapshotSession,
  runCommand,
  runEncryptedDumpPipeline,
  runRestorePipeline,
  sha256File,
  verifyRestore,
} from "../../deploy/backup/toolkit.mjs";

const SOURCE_SERVER_SHA = "a".repeat(64);
const RESTORE_SERVER_SHA = "b".repeat(64);
const BACKUP_ID = "20260717T100000Z-0123456789abcdef";
const CREATED_AT = "2026-07-17T10:00:00.000Z";
const CAPTURE_SOURCE_NAMESPACE = "c".repeat(64);
const CAPTURE_BYTES = Buffer.from("private capture fixture");
const CAPTURE_SHA = createHash("sha256").update(CAPTURE_BYTES).digest("hex");
const CAPTURE_ENTRY = {
  blobKey: `official-offers/private/v1/${CAPTURE_SOURCE_NAMESPACE}/42/${CAPTURE_SHA}`,
  byteLength: CAPTURE_BYTES.byteLength,
  checksumSha256: CAPTURE_SHA,
  publicationId: 42,
};
const EXPORTED_SNAPSHOT_ID = "00000003-0000001B-1";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "handleplan-backup-tooling-")));
  chmodSync(root, 0o700);
  const directories = {};
  for (const name of [
    "backup-work",
    "backup-evidence",
    "captures",
    "restore-work",
    "restore-evidence",
    "migrations",
  ]) {
    const path = join(root, name);
    mkdirSync(path, { mode: name === "migrations" ? 0o755 : 0o700 });
    directories[name] = path;
  }
  const file = (name, contents = "fixture\n", mode = 0o600) => {
    const path = join(root, name);
    writeFileSync(path, contents, { mode });
    chmodSync(path, mode);
    return path;
  };
  const executable = (name, contents = "#!/bin/sh\nexit 0\n") => file(name, contents, 0o700);
  writeFileSync(join(directories.migrations, "001_first.sql"), "select 1;\n", { mode: 0o644 });
  writeFileSync(join(directories.migrations, "002_second.sql"), "select 2;\n", { mode: 0o644 });
  return { directories, executable, file, root };
}

function installCapture(values, entry = CAPTURE_ENTRY, bytes = CAPTURE_BYTES) {
  const path = join(values.directories.captures, ...entry.blobKey.split("/"));
  mkdirSync(join(path, ".."), { mode: 0o700, recursive: true });
  let current = values.directories.captures;
  for (const segment of entry.blobKey.split("/").slice(0, -1)) {
    current = join(current, segment);
    chmodSync(current, 0o700);
  }
  writeFileSync(path, bytes, { mode: 0o400 });
  chmodSync(path, 0o400);
  return path;
}

function migrationLedger(values) {
  return readdirSync(values.directories.migrations).sort().map((id) => ({
    checksum: createHash("sha256")
      .update(readFileSync(join(values.directories.migrations, id)))
      .digest("hex"),
    id,
  }));
}

function sourceSnapshotSession(values, overrides = {}) {
  const state = { closed: false };
  return {
    state,
    runner: async () => ({
      close: async () => {
        state.closed = true;
      },
      identity: {
        database: "handleplan",
        hasNoMemberships: true,
        ownsNoDatabases: true,
        privileged: false,
        role: "handleplan_backup",
        serverIdSha256: SOURCE_SERVER_SHA,
      },
      migrationLedger: migrationLedger(values),
      requiredRelations: "true\ttrue\ttrue\ttrue",
      snapshotId: EXPORTED_SNAPSHOT_ID,
      ...overrides,
    }),
  };
}

function ledgerText(entries) {
  return entries.map(({ checksum, id }) => `${id}\t${checksum}`).join("\n");
}

function ledgerSql(entries) {
  const rows = entries.map(({ checksum, id }) => `${id}\t${checksum}\t2026-07-17 10:00:00+00`);
  return [
    "COPY public.handleplan_schema_migrations (id, checksum, applied_at) FROM stdin;",
    ...rows,
    "\\.",
    "",
  ].join("\n");
}

function captureLedgerSql(entries = [CAPTURE_ENTRY]) {
  return [
    "COPY public.publication_captures (publication_id, blob_key, checksum, byte_length) FROM stdin;",
    ...entries.map((entry) => (
      `${entry.publicationId}\t${entry.blobKey}\t${entry.checksumSha256}\t${entry.byteLength}`
    )),
    "\\.",
    "",
  ].join("\n");
}

function captureDatabaseSha(entries = [CAPTURE_ENTRY]) {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((left, right) => (
    left.blobKey < right.blobKey ? -1 : left.blobKey > right.blobKey ? 1 : 0
  ))) {
    hash.update(`${entry.blobKey}\t${entry.publicationId}\t${entry.byteLength}\t${entry.checksumSha256}\n`);
  }
  return hash.digest("hex");
}

function captureInventorySha(entries = [CAPTURE_ENTRY]) {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((left, right) => (
    left.blobKey < right.blobKey ? -1 : left.blobKey > right.blobKey ? 1 : 0
  ))) {
    hash.update(`${entry.blobKey}\t${entry.byteLength}\t${entry.checksumSha256}\t1\n`);
  }
  return hash.digest("hex");
}

function captureQueryText(entries = [CAPTURE_ENTRY]) {
  return entries.map((entry) => (
    `${entry.blobKey}\t${entry.publicationId}\t${entry.byteLength}\t${entry.checksumSha256}`
  )).join("\n");
}

function archiveList() {
  return [
    "1; 0 0 TABLE public ingestion_runs owner",
    "2; 0 0 TABLE public price_observations owner",
    "3; 0 0 TABLE public publication_captures owner",
    "4; 0 0 TABLE public source_permissions owner",
    "5; 0 0 TABLE DATA public handleplan_schema_migrations owner",
    "",
  ].join("\n");
}

function restoreSqlGuardPipeline(values, name, generatedSql) {
  const executedSql = join(values.root, `${name}-executed.sql`);
  const encrypted = values.file(`${name}-selected.age`, "PGDMP encrypted fixture");
  const database = "handleplan_restore_drill_20260717";
  const identity = restoreIdentity(database);
  const identityText = `${database}\t${database}\t${RESTORE_SERVER_SHA}\ttrue\tfalse\tfalse\tfalse\tfalse\tfalse\ttrue\ttrue`;
  const age = values.executable(`${name}-age.mjs`, [
    `#!${process.execPath}`,
    'import { readFileSync } from "node:fs";',
    "process.stdout.write(readFileSync(process.argv.at(-1)));",
    "",
  ].join("\n"));
  const pgRestore = values.executable(`${name}-restore.mjs`, [
    `#!${process.execPath}`,
    "for await (const _chunk of process.stdin) {}",
    'if (process.argv.includes("--list")) {',
    `  process.stdout.write(${JSON.stringify(archiveList())});`,
    "} else {",
    `  process.stdout.write(${JSON.stringify(generatedSql)});`,
    "}",
    "",
  ].join("\n"));
  const psql = values.executable(`${name}-psql.mjs`, [
    `#!${process.execPath}`,
    'import { appendFileSync } from "node:fs";',
    "let marker;",
    "let started = false;",
    "let finished = false;",
    "for await (const chunk of process.stdin) {",
    `  appendFileSync(${JSON.stringify(executedSql)}, chunk);`,
    '  const text = chunk.toString("utf8");',
    "  marker ??= /HP_RESTORE_[a-f0-9]{48}/u.exec(text)?.[0];",
    '  if (marker !== undefined && !started && text.includes(marker + "_READY")) {',
    "    started = true;",
    `    process.stdout.write(marker + "_IDENTITY_BEFORE\\t" + ${JSON.stringify(identityText)} + "\\n" + marker + "_CLEAN_ROOM\\t0\\t0\\t0\\t0\\t0\\t0\\n" + marker + "_READY\\n");`,
    "  }",
    '  if (marker !== undefined && !finished && text.includes(marker + "_IDENTITY_AFTER")) {',
    "    finished = true;",
    `    process.stdout.write(marker + "_IDENTITY_AFTER\\t" + ${JSON.stringify(identityText)} + "\\n" + marker + "_DONE\\n");`,
    "  }",
    "}",
    "process.exit(started && finished ? 0 : 23);",
    "",
  ].join("\n"));
  return {
    executedSql,
    run: runRestorePipeline({
      ageBinary: age,
      ageIdentityFile: values.file(`${name}-identity.txt`),
      applicationName: "test",
      commandTimeoutMs: 30000,
      encryptedFile: encrypted,
      expectedDatabase: database,
      expectedExecutionIdentity: identity,
      expectedRole: database,
      expectedServerIdSha256: RESTORE_SERVER_SHA,
      pgRestoreBinary: pgRestore,
      pgService: database,
      pgServiceFile: values.file(`${name}.pg_service.conf`),
      pgpassFile: values.file(`${name}.pgpass`),
      psqlBinary: psql,
    }),
  };
}

function assertFixtureProcessStopped(pidFile) {
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.equal(Number.isSafeInteger(pid) && pid > 0, true);
  assert.throws(
    () => process.kill(pid, 0),
    (error) => error?.code === "ESRCH",
  );
}

function forceStopFixtureProcess(pidFile) {
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8"));
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function assertFixtureProcessEventuallyStopped(pidFile) {
  const pid = Number(readFileSync(pidFile, "utf8"));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assertFixtureProcessStopped(pidFile);
}

function backupEnvironment(values) {
  return {
    HANDLEPLAN_BACKUP_AGE_BIN: values.executable("age"),
    HANDLEPLAN_BACKUP_AGE_RECIPIENTS_FILE: values.file("recipients.txt", "age1fixture\n"),
    HANDLEPLAN_BACKUP_COMMAND_TIMEOUT_MS: "30000",
    HANDLEPLAN_BACKUP_CAPTURE_ROOT: values.directories.captures,
    HANDLEPLAN_BACKUP_ENABLED: "true",
    HANDLEPLAN_BACKUP_EVIDENCE_DIR: values.directories["backup-evidence"],
    HANDLEPLAN_BACKUP_EXPECTED_DATABASE: "handleplan",
    HANDLEPLAN_BACKUP_EXPECTED_CAPTURE_OWNER_UID: String(process.getuid()),
    HANDLEPLAN_BACKUP_EXPECTED_ROLE: "handleplan_backup",
    HANDLEPLAN_BACKUP_EXPECTED_SERVER_ID_SHA256: SOURCE_SERVER_SHA,
    HANDLEPLAN_BACKUP_MAX_ARTIFACT_BYTES: "1048576",
    HANDLEPLAN_BACKUP_MAX_CAPTURE_ARTIFACT_BYTES: "1048576",
    HANDLEPLAN_BACKUP_MAX_CAPTURE_FILES: "100",
    HANDLEPLAN_BACKUP_MAX_CAPTURE_LEDGER_BYTES: "1048576",
    HANDLEPLAN_BACKUP_MAX_CAPTURE_PLAINTEXT_BYTES: "1048576",
    HANDLEPLAN_BACKUP_MIGRATIONS_DIR: values.directories.migrations,
    HANDLEPLAN_BACKUP_PGDUMP_BIN: values.executable("pg_dump"),
    HANDLEPLAN_BACKUP_PGPASS_FILE: values.file("backup.pgpass"),
    HANDLEPLAN_BACKUP_PGRESTORE_BIN: values.executable("backup-pg_restore"),
    HANDLEPLAN_BACKUP_PGSERVICE: "handleplan_backup",
    HANDLEPLAN_BACKUP_PGSERVICE_FILE: values.file("backup.pg_service.conf", [
      "[handleplan_backup]",
      "host=/var/run/postgresql",
      "dbname=handleplan",
      "user=handleplan_backup",
      "",
    ].join("\n")),
    HANDLEPLAN_BACKUP_PSQL_BIN: values.executable("backup-psql"),
    HANDLEPLAN_BACKUP_RETENTION_DAYS: "35",
    HANDLEPLAN_BACKUP_UPLOAD_ADAPTER: values.executable("upload-adapter"),
    HANDLEPLAN_BACKUP_WORK_DIR: values.directories["backup-work"],
  };
}

function validManifest(values, { ledger = migrationLedger(values) } = {}) {
  const encrypted = values.file("database.dump.age", "age authenticated fixture");
  const sha256 = sha256File(encrypted);
  const objectKey = `handleplan-database/2026/07/17/${BACKUP_ID}/database.dump.age`;
  const captureCiphertext = Buffer.from("age authenticated capture fixture");
  const captureSha256 = createHash("sha256").update(captureCiphertext).digest("hex");
  const captureObjectKey = `handleplan-database/2026/07/17/${BACKUP_ID}/private-captures.bundle.age`;
  const manifest = {
    backupId: BACKUP_ID,
    captures: {
      bytes: captureCiphertext.byteLength,
      databaseLedgerSha256: captureDatabaseSha(),
      databaseReferencedEntryCount: 1,
      encryption: "age-authenticated-encryption",
      entryCount: 1,
      fileName: "private-captures.bundle.age",
      format: "handleplan-private-captures-v1",
      inventorySha256: captureInventorySha(),
      objectKey: captureObjectKey,
      plaintextBytes: CAPTURE_ENTRY.byteLength,
      selection: "database-archive-publication-captures-v1",
      sha256: captureSha256,
      status: "included",
    },
    createdAt: CREATED_AT,
    database: {
      bytes: Buffer.byteLength("age authenticated fixture"),
      encryption: "age-authenticated-encryption",
      fileName: "database.dump.age",
      format: "postgresql-custom-v1",
      objectKey,
      sha256,
    },
    datasetId: "handleplan-database",
    kind: "handleplan-offhost-backup-manifest",
    limits: {
      maxArtifactBytes: 1048576,
      maxCaptureArtifactBytes: 1048576,
      maxCaptureBlobBytes: 50 * 1024 * 1024,
      maxCaptureFiles: 100,
      maxCapturePlaintextBytes: 1048576,
    },
    retention: {
      days: 35,
      enforcement: "off-host-object-lifecycle-required",
      retainUntil: "2026-08-21T10:00:00.000Z",
    },
    schemaVersion: 2,
    source: {
      archiveSessionBinding: "postgresql-exported-snapshot-v1",
      database: "handleplan",
      migrationLedger: ledger,
      role: "handleplan_backup",
      roleHasNoMemberships: true,
      roleOwnsNoDatabases: true,
      roleUnprivileged: true,
      schemaContract: "handleplan-evidence-relations-v1",
      probedServerIdSha256: SOURCE_SERVER_SHA,
    },
  };
  const manifestPath = values.file("manifest.json", `${JSON.stringify(manifest)}\n`);
  return {
    captureCiphertext,
    captureObjectKey,
    captureSha256,
    encrypted,
    manifest: manifestPath,
    manifestSha256: sha256File(manifestPath),
    objectKey,
    sha256,
  };
}

function restoreEnvironment(values, selected) {
  const database = "handleplan_restore_drill_20260717";
  return {
    HANDLEPLAN_RESTORE_AGE_BIN: values.executable("restore-age"),
    HANDLEPLAN_RESTORE_AGE_IDENTITY_FILE: values.file("identity.txt"),
    HANDLEPLAN_RESTORE_CLUSTER_ACK: "server-identity-reviewed-nonproduction",
    HANDLEPLAN_RESTORE_COMMAND_TIMEOUT_MS: "30000",
    HANDLEPLAN_RESTORE_DOWNLOAD_ADAPTER: values.executable("download-adapter"),
    HANDLEPLAN_RESTORE_DRILL_ENABLED: "true",
    HANDLEPLAN_RESTORE_ENCRYPTED_FILE: selected.encrypted,
    HANDLEPLAN_RESTORE_EVIDENCE_DIR: values.directories["restore-evidence"],
    HANDLEPLAN_RESTORE_EXPECTED_BACKUP_ID: BACKUP_ID,
    HANDLEPLAN_RESTORE_EXPECTED_CAPTURE_CIPHERTEXT_SHA256: selected.captureSha256,
    HANDLEPLAN_RESTORE_EXPECTED_CAPTURE_OBJECT_KEY: selected.captureObjectKey,
    HANDLEPLAN_RESTORE_EXPECTED_CIPHERTEXT_SHA256: selected.sha256,
    HANDLEPLAN_RESTORE_EXPECTED_DATABASE: database,
    HANDLEPLAN_RESTORE_EXPECTED_MANIFEST_SHA256: selected.manifestSha256,
    HANDLEPLAN_RESTORE_EXPECTED_OBJECT_KEY: selected.objectKey,
    HANDLEPLAN_RESTORE_EXPECTED_ROLE: database,
    HANDLEPLAN_RESTORE_EXPECTED_SERVER_ID_SHA256: RESTORE_SERVER_SHA,
    HANDLEPLAN_RESTORE_ISOLATION_ACK: "isolated-disposable-nonproduction-database",
    HANDLEPLAN_RESTORE_MANIFEST_FILE: selected.manifest,
    HANDLEPLAN_RESTORE_MAX_ARTIFACT_BYTES: "1048576",
    HANDLEPLAN_RESTORE_MAX_CAPTURE_ARTIFACT_BYTES: "1048576",
    HANDLEPLAN_RESTORE_MAX_CAPTURE_FILES: "100",
    HANDLEPLAN_RESTORE_MAX_CAPTURE_PLAINTEXT_BYTES: "1048576",
    HANDLEPLAN_RESTORE_MIGRATIONS_DIR: values.directories.migrations,
    HANDLEPLAN_RESTORE_PGPASS_FILE: values.file("restore.pgpass"),
    HANDLEPLAN_RESTORE_PGRESTORE_BIN: values.executable("restore-pg_restore"),
    HANDLEPLAN_RESTORE_PGSERVICE: database,
    HANDLEPLAN_RESTORE_PGSERVICE_FILE: values.file("restore.pg_service.conf", [
      `[${database}]`,
      "host=/var/run/postgresql",
      `dbname=${database}`,
      `user=${database}`,
      "",
    ].join("\n")),
    HANDLEPLAN_RESTORE_PSQL_BIN: values.executable("restore-psql"),
    HANDLEPLAN_RESTORE_TEMPLATE_ACK: "created-from-template0-for-this-drill",
    HANDLEPLAN_RESTORE_WORK_DIR: values.directories["restore-work"],
  };
}

function fulfillCaptureDownload(executable, options, environment, selected) {
  if (executable !== realpathSync(environment.HANDLEPLAN_RESTORE_DOWNLOAD_ADAPTER)) return false;
  assert.deepEqual(options.env.HANDLEPLAN_RESTORE_DOWNLOAD_OPERATION, "get-create-only");
  assert.equal(options.env.HANDLEPLAN_RESTORE_DOWNLOAD_OBJECT_KEY, selected.captureObjectKey);
  assert.equal(options.env.HANDLEPLAN_RESTORE_DOWNLOAD_EXPECTED_SHA256, selected.captureSha256);
  writeFileSync(
    options.env.HANDLEPLAN_RESTORE_DOWNLOAD_DESTINATION_FILE,
    selected.captureCiphertext,
    { flag: "wx", mode: 0o600 },
  );
  chmodSync(options.env.HANDLEPLAN_RESTORE_DOWNLOAD_DESTINATION_FILE, 0o600);
  return true;
}

async function verifiedCapturePipeline({ expected }) {
  return { ...expected };
}

function restoreIdentity(database, serverIdSha256 = RESTORE_SERVER_SHA) {
  return {
    database,
    hasNoMemberships: true,
    owner: true,
    ownsOnlyCurrentDatabase: true,
    privileged: false,
    role: database,
    serverIdSha256,
  };
}

function boundRestorePipelineResult(identity) {
  return {
    archiveList: archiveList(),
    executionCleanRoomCatalog: "0\t0\t0\t0\t0\t0",
    executionIdentityAfter: identity,
    executionIdentityBefore: identity,
    executionSessionBinding: "pg-restore-sql-same-psql-transaction-v1",
  };
}

test("backup is disabled unless the exact opt-in is present", async () => {
  await assert.rejects(
    createBackup({ environment: {} }),
    (error) => error instanceof BackupSafetyError && /HANDLEPLAN_BACKUP_ENABLED/u.test(error.message),
  );
});

test("backup refuses the obsolete ambiguous capture-path setting", async () => {
  await assert.rejects(
    createBackup({
      environment: {
        HANDLEPLAN_BACKUP_CAPTURE_PATH: "/private/captures",
        HANDLEPLAN_BACKUP_ENABLED: "true",
      },
    }),
    /CAPTURE_PATH is obsolete/u,
  );
});

test("backup refuses a group-writable age recipients file", async () => {
  const values = fixture();
  try {
    const environment = backupEnvironment(values);
    chmodSync(environment.HANDLEPLAN_BACKUP_AGE_RECIPIENTS_FILE, 0o660);
    await assert.rejects(
      createBackup({ environment }),
      /AGE_RECIPIENTS_FILE must be root- or self-owned and not group- or other-writable/u,
    );
  } finally {
    rmSync(values.root, { force: true, recursive: true });
  }
});

test("backup refuses a group-writable upload adapter before reading the database", async () => {
  const values = fixture();
  try {
    const environment = backupEnvironment(values);
    chmodSync(environment.HANDLEPLAN_BACKUP_UPLOAD_ADAPTER, 0o770);
    let externalCall = false;
    await assert.rejects(createBackup({
      environment,
      pipelineRunner: async () => {
        externalCall = true;
        return { archiveList: archiveList(), ledgerSql: "" };
      },
      runner: () => {
        externalCall = true;
        return "";
      },
    }), /UPLOAD_ADAPTER must identify an executable file/u);
    assert.equal(externalCall, false);
  } finally {
    rmSync(values.root, { force: true, recursive: true });
  }
});

test("backup refuses a concurrent or unreviewed stale lock without deleting it", async () => {
  const values = fixture();
  try {
    const environment = backupEnvironment(values);
    const lock = join(values.directories["backup-work"], ".backup.lock");
    writeFileSync(lock, "existing\n", { mode: 0o600 });
    await assert.rejects(createBackup({ environment }), /another run may be active/u);
    assert.equal(readFileSync(lock, "utf8"), "existing\n");
  } finally {
    rmSync(values.root, { force: true, recursive: true });
  }
});

test("backup rejects remote or multi-host libpq routing before querying or dumping", async () => {
  const values = fixture();
  try {
    const environment = backupEnvironment(values);
    writeFileSync(environment.HANDLEPLAN_BACKUP_PGSERVICE_FILE, [
      "[handleplan_backup]",
      "host=db-a.example,db-b.example",
      "dbname=handleplan",
      "user=handleplan_backup",
      "",
    ].join("\n"), { mode: 0o600 });
    let externalCall = false;
    await assert.rejects(createBackup({
      environment,
      pipelineRunner: async () => {
        externalCall = true;
        return { archiveList: archiveList(), ledgerSql: "" };
      },
      runner: () => {
        externalCall = true;
        return "";
      },
    }), /one local Unix-socket database and role/u);
    assert.equal(externalCall, false);
  } finally {
    rmSync(values.root, { force: true, recursive: true });
  }
});

test("backup refuses a source role that owns any database", async () => {
  const values = fixture();
  try {
    const environment = backupEnvironment(values);
    let pipelineCalled = false;
    const session = sourceSnapshotSession(values, {
      identity: {
        database: "handleplan",
        hasNoMemberships: true,
        ownsNoDatabases: false,
        privileged: false,
        role: "handleplan_backup",
        serverIdSha256: SOURCE_SERVER_SHA,
      },
    });
    await assert.rejects(createBackup({
      environment,
      pipelineRunner: async () => {
        pipelineCalled = true;
        return { archiveList: archiveList(), ledgerSql: "" };
      },
      sourceSessionRunner: session.runner,
    }), /pinned unprivileged role and server identity/u);
    assert.equal(pipelineCalled, false);
    assert.equal(session.state.closed, true);
  } finally {
    rmSync(values.root, { force: true, recursive: true });
  }
});

test("backup pins source identity, validates the streamed archive, and uploads manifest last", async () => {
  const values = fixture();
  const calls = [];
  try {
    const environment = backupEnvironment(values);
    installCapture(values);
    const ledger = migrationLedger(values);
    const adapter = realpathSync(environment.HANDLEPLAN_BACKUP_UPLOAD_ADAPTER);
    const runner = (executable, argumentsList, options) => {
      calls.push({ argumentsList: [...argumentsList], env: { ...options.env }, executable });
      if (executable === adapter) return "";
      assert.fail("unexpected non-upload command");
    };
    const sourceSession = sourceSnapshotSession(values);
    let pipelineConfig;
    const pipelineRunner = async (config) => {
      pipelineConfig = config;
      assert.notEqual(config.pgServiceFile, realpathSync(environment.HANDLEPLAN_BACKUP_PGSERVICE_FILE));
      assert.match(readFileSync(config.pgServiceFile, "utf8"), /host=\/var\/run\/postgresql/u);
      writeFileSync(config.encryptedPath, "age authenticated fixture", { mode: 0o600 });
      return {
        archiveList: archiveList(),
        captureLedgerSql: captureLedgerSql(),
        ledgerSql: ledgerSql(ledger),
      };
    };
    let capturePipelineConfig;
    const capturePipelineRunner = async (config) => {
      capturePipelineConfig = config;
      assert.equal(config.snapshot.entryCount, 1);
      assert.equal(config.snapshot.databaseReferencedEntryCount, 1);
      assert.equal(config.snapshot.entries[0].blobKey, CAPTURE_ENTRY.blobKey);
      writeFileSync(config.encryptedPath, "age authenticated capture fixture", { mode: 0o600 });
      return { ciphertextBytes: Buffer.byteLength("age authenticated capture fixture") };
    };
    const result = await createBackup({
      capturePipelineRunner,
      environment,
      now: () => new Date(CREATED_AT),
      pipelineRunner,
      randomSuffix: () => "0123456789abcdef",
      runner,
      sourceSessionRunner: sourceSession.runner,
    });

    assert.equal(result.backupId, BACKUP_ID);
    assert.equal(pipelineConfig.pgDumpBinary, realpathSync(environment.HANDLEPLAN_BACKUP_PGDUMP_BIN));
    assert.equal(pipelineConfig.encryptedPath.endsWith("database.dump.age"), true);
    assert.equal(pipelineConfig.snapshotId, EXPORTED_SNAPSHOT_ID);
    assert.equal(sourceSession.state.closed, true);
    assert.equal(result.manifest.source.probedServerIdSha256, SOURCE_SERVER_SHA);
    assert.equal(result.manifest.source.roleHasNoMemberships, true);
    assert.equal(result.manifest.source.roleOwnsNoDatabases, true);
    assert.equal(result.manifest.source.roleUnprivileged, true);
    assert.deepEqual(result.manifest.source.migrationLedger, ledger);
    assert.equal(capturePipelineConfig.encryptedPath.endsWith("private-captures.bundle.age"), true);
    assert.equal(result.manifest.schemaVersion, 2);
    assert.equal(result.manifest.captures.status, "included");
    assert.equal(result.manifest.captures.entryCount, 1);
    assert.equal(result.manifest.captures.databaseReferencedEntryCount, 1);
    assert.equal(result.manifest.captures.databaseLedgerSha256, captureDatabaseSha());
    assert.doesNotMatch(JSON.stringify(result.manifest), new RegExp(CAPTURE_SOURCE_NAMESPACE, "u"));
    assert.equal(result.manifest.retention.enforcement, "off-host-object-lifecycle-required");
    assert.equal(result.manifestSha256, sha256File(result.evidenceManifest));
    assert.match(
      readFileSync(result.evidenceChecksums, "utf8"),
      new RegExp(`${result.manifestSha256}  manifest\\.json`, "u"),
    );

    assert.equal(result.manifest.source.archiveSessionBinding, "postgresql-exported-snapshot-v1");
    const uploads = calls.filter((call) => call.executable === adapter);
    assert.deepEqual(uploads.map((call) => call.env.HANDLEPLAN_BACKUP_UPLOAD_OBJECT_KEY.split("/").at(-1)), [
      "database.dump.age",
      "private-captures.bundle.age",
      "SHA256SUMS",
      "manifest.json",
    ]);
    for (const upload of uploads) {
      assert.deepEqual(upload.argumentsList, []);
      assert.equal(upload.env.HANDLEPLAN_BACKUP_UPLOAD_OPERATION, "put-create-only");
    }
    assert.deepEqual(readdirSync(values.directories["backup-work"]), []);
    assert.equal(JSON.parse(readFileSync(result.evidenceManifest, "utf8")).backupId, BACKUP_ID);
  } finally {
    rmSync(values.root, { force: true, recursive: true });
  }
});

test("private-capture mutation during archive creation prevents every completion upload", async () => {
  const values = fixture();
  try {
    const capturePath = installCapture(values);
    const environment = backupEnvironment(values);
    const ledger = migrationLedger(values);
    const adapter = realpathSync(environment.HANDLEPLAN_BACKUP_UPLOAD_ADAPTER);
    let uploadCalls = 0;
    const runner = (executable) => {
      if (executable === adapter) {
        uploadCalls += 1;
        return "";
      }
      assert.fail("unexpected non-upload command");
    };
    const sourceSession = sourceSnapshotSession(values);
    await assert.rejects(createBackup({
      capturePipelineRunner: async (config) => {
        writeFileSync(config.encryptedPath, "capture ciphertext", { mode: 0o600 });
        chmodSync(capturePath, 0o600);
        return { ciphertextBytes: Buffer.byteLength("capture ciphertext") };
      },
      environment,
      now: () => new Date(CREATED_AT),
      pipelineRunner: async (config) => {
        writeFileSync(config.encryptedPath, "age authenticated fixture", { mode: 0o600 });
        return {
          archiveList: archiveList(),
          captureLedgerSql: captureLedgerSql(),
          ledgerSql: ledgerSql(ledger),
        };
      },
      randomSuffix: () => "0123456789abcdef",
      runner,
      sourceSessionRunner: sourceSession.runner,
    }), /private-capture.*unsafe blob|private-capture.*changed/iu);
    assert.equal(sourceSession.state.closed, true);
    assert.equal(uploadCalls, 0);
    assert.deepEqual(readdirSync(values.directories["backup-evidence"]), []);
    assert.deepEqual(readdirSync(values.directories["backup-work"]), []);
  } finally {
    rmSync(values.root, { force: true, recursive: true });
  }
});

test("real backup pipeline streams one archive to age and three validators without a plaintext dump", async () => {
  const values = fixture();
  try {
    const ledger = migrationLedger(values);
    const archive = "PGDMP streamed custom archive fixture";
    const pgDumpArguments = join(values.root, "pg-dump-arguments.json");
    const pgDump = values.executable("stream-pg_dump.mjs", [
      `#!${process.execPath}`,
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(pgDumpArguments)}, JSON.stringify(process.argv.slice(2)));`,
      `process.stdout.write(${JSON.stringify(archive)});`,
      "",
    ].join("\n"));
    const age = values.executable("stream-age.mjs", [
      `#!${process.execPath}`,
      'import { writeFileSync } from "node:fs";',
      "const chunks = [];",
      'for await (const chunk of process.stdin) chunks.push(chunk);',
      'const index = process.argv.indexOf("--output");',
      "writeFileSync(process.argv[index + 1], Buffer.concat(chunks), { mode: 0o600 });",
      "",
    ].join("\n"));
    const pgRestore = values.executable("stream-pg_restore.mjs", [
      `#!${process.execPath}`,
      "const chunks = [];",
      'for await (const chunk of process.stdin) chunks.push(chunk);',
      `if (process.argv.includes("--list")) process.stdout.write(${JSON.stringify(archiveList())});`,
      `else if (process.argv.includes("--table=publication_captures")) process.stdout.write(${JSON.stringify(captureLedgerSql())});`,
      `else process.stdout.write(${JSON.stringify(ledgerSql(ledger))});`,
      "",
    ].join("\n"));
    const encryptedPath = join(values.directories["backup-work"], "stream.age");
    const result = await runEncryptedDumpPipeline({
      ageBinary: age,
      ageRecipientsFile: values.file("stream-recipients.txt"),
      applicationName: "test",
      commandTimeoutMs: 30000,
      encryptedPath,
      maxArtifactBytes: 1048576,
      maxCaptureLedgerBytes: 1048576,
      pgDumpBinary: pgDump,
      pgRestoreBinary: pgRestore,
      pgService: "fixture",
      pgServiceFile: values.file("stream.pg_service.conf"),
      pgpassFile: values.file("stream.pgpass"),
      snapshotId: EXPORTED_SNAPSHOT_ID,
    });
    assert.equal(readFileSync(encryptedPath, "utf8"), archive);
    assert.equal(result.archiveList, archiveList());
    assert.equal(result.ledgerSql, ledgerSql(ledger));
    assert.equal(result.captureLedgerSql, captureLedgerSql());
    assert.deepEqual(JSON.parse(readFileSync(pgDumpArguments, "utf8")), [
      "--format=custom",
      "--compress=6",
      "--no-owner",
      "--no-privileges",
      "--exclude-table-data=public.public_api_request_budget_events",
      `--snapshot=${EXPORTED_SNAPSHOT_ID}`,
    ]);
    const source = readFileSync(new URL("../../deploy/backup/toolkit.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(source, /const dumpPath|--file=\$\{dumpPath\}/u);
  } finally {
    rmSync(values.root, { force: true, recursive: true });
  }
});

test("backup identity and pg_dump share one live exported-snapshot session", async () => {
  const values = fixture();
  try {
    const ledger = migrationLedger(values);
    const inputPath = join(values.root, "snapshot-session-input.sql");
    const psql = values.executable("snapshot-session-psql.mjs", [
      `#!${process.execPath}`,
      'import { appendFileSync } from "node:fs";',
      "let input = '';",
      "let announced = false;",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => {",
      "  input += chunk;",
      `  appendFileSync(${JSON.stringify(inputPath)}, chunk);`,
      "  if (!announced && input.includes(\"select 'HP_READY';\")) {",
      "    announced = true;",
      `    process.stdout.write(${JSON.stringify([
        `HP_IDENTITY\thandleplan\thandleplan_backup\t${SOURCE_SERVER_SHA}\tfalse\tfalse\tfalse\tfalse\tfalse\ttrue\ttrue`,
        `HP_SNAPSHOT\t${EXPORTED_SNAPSHOT_ID}`,
        ...ledger.map(({ checksum, id }) => `HP_LEDGER\t${id}\t${checksum}`),
        "HP_RELATIONS\ttrue\ttrue\ttrue\ttrue",
        "HP_READY",
        "",
      ].join("\n"))});`,
      "  }",
      "  if (input.includes('rollback;') && input.includes('\\\\q')) process.exit(0);",
      "});",
      "",
    ].join("\n"));
    const environment = backupEnvironment(values);
    const session = await openBackupSnapshotSession({
      applicationName: "test",
      commandTimeoutMs: 30_000,
      pgService: "handleplan_backup",
      pgServiceFile: realpathSync(environment.HANDLEPLAN_BACKUP_PGSERVICE_FILE),
      pgpassFile: realpathSync(environment.HANDLEPLAN_BACKUP_PGPASS_FILE),
      psqlBinary: psql,
    });
    assert.equal(session.snapshotId, EXPORTED_SNAPSHOT_ID);
    assert.equal(session.identity.serverIdSha256, SOURCE_SERVER_SHA);
    assert.deepEqual(session.migrationLedger, ledger);
    await session.close();
    const input = readFileSync(inputPath, "utf8");
    assert.match(input, /begin transaction isolation level repeatable read read only;/u);
    assert.match(input, /pg_export_snapshot\(\)/u);
    assert.match(input, /rollback;/u);
  } finally {
    rmSync(values.root, { force: true, recursive: true });
  }
});

test("streaming dump fails before spawn without the exact exported snapshot", async () => {
  await assert.rejects(
    runEncryptedDumpPipeline({ snapshotId: "not-a-postgresql-snapshot" }),
    /requires a valid exported PostgreSQL snapshot/u,
  );
});

test("restore refuses production-looking destinations before reading artifacts", async () => {
  await assert.rejects(
    verifyRestore({
      environment: {
        HANDLEPLAN_RESTORE_CLUSTER_ACK: "server-identity-reviewed-nonproduction",
        HANDLEPLAN_RESTORE_DRILL_ENABLED: "true",
        HANDLEPLAN_RESTORE_EXPECTED_DATABASE: "handleplan",
        HANDLEPLAN_RESTORE_ISOLATION_ACK: "isolated-disposable-nonproduction-database",
        HANDLEPLAN_RESTORE_TEMPLATE_ACK: "created-from-template0-for-this-drill",
      },
    }),
    /dedicated restore-drill naming contract/u,
  );
});

test("restore requires a per-drill template0 provisioning acknowledgement", async () => {
  await assert.rejects(
    verifyRestore({
      environment: {
        HANDLEPLAN_RESTORE_CLUSTER_ACK: "server-identity-reviewed-nonproduction",
        HANDLEPLAN_RESTORE_DRILL_ENABLED: "true",
        HANDLEPLAN_RESTORE_ISOLATION_ACK: "isolated-disposable-nonproduction-database",
      },
    }),
    /HANDLEPLAN_RESTORE_TEMPLATE_ACK/u,
  );
});

test("real restore pipeline executes offline pg_restore SQL in the identity-probed psql session", async () => {
  const values = fixture();
  try {
    const events = join(values.root, "restore-events.txt");
    const executedSql = join(values.root, "restore-executed.sql");
    const encrypted = values.file("pipeline-selected.age", "PGDMP encrypted fixture");
    const database = "handleplan_restore_drill_20260717";
    const identity = restoreIdentity(database);
    const identityText = `${database}\t${database}\t${RESTORE_SERVER_SHA}\ttrue\tfalse\tfalse\tfalse\tfalse\tfalse\ttrue\ttrue`;
    const age = values.executable("pipeline-age.mjs", [
      `#!${process.execPath}`,
      'import { appendFileSync, readFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(events)}, "decrypt\\n");`,
      "process.stdout.write(readFileSync(process.argv.at(-1)));",
      "",
    ].join("\n"));
    const pgRestore = values.executable("pipeline-restore.mjs", [
      `#!${process.execPath}`,
      'import { appendFileSync } from "node:fs";',
      "for await (const _chunk of process.stdin) {}",
      'if (process.argv.includes("--list")) {',
      `  appendFileSync(${JSON.stringify(events)}, "list\\n");`,
      `  process.stdout.write(${JSON.stringify(archiveList())});`,
      "} else {",
      '  if (process.argv.some((argument) => argument.startsWith("--dbname"))) process.exit(21);',
      '  if (!process.argv.includes("--file=-") || process.env.PGSERVICE !== undefined) process.exit(22);',
      `  appendFileSync(${JSON.stringify(events)}, "apply\\n");`,
      '  process.stdout.write([',
      '    "\\\\restrict GuardToken123",',
      '    "select \'COMMIT; BEGIN; ROLLBACK;\';",',
      '    "/* START TRANSACTION; */",',
      '    "CREATE FUNCTION public.enforce_official_offer_lifecycle_job_boundary_v1()",',
      '    "RETURNS trigger",',
      '    "LANGUAGE plpgsql",',
      '    "AS $function$",',
      '    "begin",',
      '    "  if new.job_kind = \'official-offer-lifecycle-reconcile\' then",',
      '    "    raise exception \'HP_OFFER_LIFECYCLE_DEDICATED_BOUNDARY_REQUIRED\';",',
      '    "  end if;",',
      '    "  return new;",',
      '    "end;",',
      '    "$function$;",',
      '    "create table public.restore_fixture (value text);",',
      '    "COPY public.restore_fixture (value) FROM stdin;",',
      '    "fixture",',
      '    "\\\\.",',
      '    "\\\\unrestrict GuardToken123",',
      '    "",',
      '  ].join("\\n"));',
      "}",
      "",
    ].join("\n"));
    const psql = values.executable("pipeline-psql.mjs", [
      `#!${process.execPath}`,
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(events)}, "session\\n");`,
      'let marker;',
      'let started = false;',
      'let finished = false;',
      'for await (const chunk of process.stdin) {',
      `  appendFileSync(${JSON.stringify(executedSql)}, chunk);`,
      '  const text = chunk.toString("utf8");',
      '  marker ??= /HP_RESTORE_[a-f0-9]{48}/u.exec(text)?.[0];',
      '  if (marker !== undefined && !started && text.includes(marker + "_READY")) {',
      '    started = true;',
      `    process.stdout.write(marker + "_IDENTITY_BEFORE\\t" + ${JSON.stringify(identityText)} + "\\n" + marker + "_CLEAN_ROOM\\t0\\t0\\t0\\t0\\t0\\t0\\n" + marker + "_READY\\n");`,
      '  }',
      '  if (marker !== undefined && !finished && text.includes(marker + "_IDENTITY_AFTER")) {',
      '    finished = true;',
      `    process.stdout.write(marker + "_IDENTITY_AFTER\\t" + ${JSON.stringify(identityText)} + "\\n" + marker + "_DONE\\n");`,
      '  }',
      '}',
      'process.exit(started && finished ? 0 : 23);',
      "",
    ].join("\n"));
    const result = await runRestorePipeline({
      ageBinary: age,
      ageIdentityFile: values.file("pipeline-identity.txt"),
      applicationName: "test",
      commandTimeoutMs: 30000,
      encryptedFile: encrypted,
      expectedDatabase: database,
      expectedExecutionIdentity: identity,
      expectedRole: database,
      expectedServerIdSha256: RESTORE_SERVER_SHA,
      pgRestoreBinary: pgRestore,
      pgService: database,
      pgServiceFile: values.file("pipeline.pg_service.conf"),
      pgpassFile: values.file("pipeline.pgpass"),
      psqlBinary: psql,
    });
    assert.equal(result.archiveList, archiveList());
    assert.deepEqual(result.executionIdentityBefore, identity);
    assert.deepEqual(result.executionIdentityAfter, identity);
    assert.equal(result.executionCleanRoomCatalog, "0\t0\t0\t0\t0\t0");
    assert.equal(result.executionSessionBinding, "pg-restore-sql-same-psql-transaction-v1");
    assert.deepEqual(readFileSync(events, "utf8").trim().split("\n"), [
      "decrypt",
      "list",
      "session",
      "decrypt",
      "apply",
    ]);
    const sql = readFileSync(executedSql, "utf8");
    assert.match(sql, /begin;\n/u);
    assert.match(sql, /LANGUAGE plpgsql\nAS \$function\$\nbegin\n/u);
    assert.match(sql, /HP_OFFER_LIFECYCLE_DEDICATED_BOUNDARY_REQUIRED/u);
    assert.match(sql, /create table public\.restore_fixture/u);
    assert.match(sql, /commit;\n/u);
    assert.doesNotMatch(sql, /\\connect/u);
  } finally {
    rmSync(values.root, { force: true, recursive: true });
  }
});

test("restore SQL guard rejects top-level transaction control outside quoted bodies", async () => {
  const cases = [
    ["guard-begin", "select 'guard-begin-prefix';\nBEGIN;\n", "BEGIN;"],
    [
      "guard-dollar-then-commit",
      [
        "DO $body$",
        "begin",
        "  perform 'COMMIT inside a string';",
        "end;",
        "$body$;",
        "/* the next command is top-level */",
        "COMMIT;",
        "",
      ].join("\n"),
      "COMMIT;",
    ],
    [
      "guard-prepare",
      "select 'guard-prepare-prefix';\nPREPARE /* lexical gap */ TRANSACTION 'guard';\n",
      "PREPARE /* lexical gap */ TRANSACTION 'guard';",
    ],
    [
      "guard-set",
      "select 'guard-set-prefix';\nSET\nTRANSACTION ISOLATION LEVEL SERIALIZABLE;\n",
      "TRANSACTION ISOLATION LEVEL SERIALIZABLE;",
    ],
    [
      "guard-start",
      "select 'guard-start-prefix';\nSTART /* nested /* comment */ gap */ TRANSACTION;\n",
      "START /* nested /* comment */ gap */ TRANSACTION;",
    ],
  ];

  for (const [name, generatedSql, forbiddenText] of cases) {
    const values = fixture();
    try {
      const pipeline = restoreSqlGuardPipeline(values, name, generatedSql);
      await assert.rejects(pipeline.run, /forbidden transaction control/u, name);
      const executedSql = readFileSync(pipeline.executedSql, "utf8");
      assert.match(executedSql, /begin;\n/u, name);
      assert.equal(executedSql.includes(forbiddenText), false, name);
    } finally {
      rmSync(values.root, { force: true, recursive: true });
    }
  }
});

test("restore pipeline rejects a destination redirect between list preflight and archive execution", async () => {
  const values = fixture();
  try {
    const events = join(values.root, "redirect-events.txt");
    const database = "handleplan_restore_drill_20260717";
    const expectedIdentity = restoreIdentity(database);
    const redirectedIdentityText = `${database}\t${database}\t${SOURCE_SERVER_SHA}\ttrue\tfalse\tfalse\tfalse\tfalse\tfalse\ttrue\ttrue`;
    const encrypted = values.file("redirect-selected.age", "PGDMP encrypted fixture");
    const age = values.executable("redirect-age.mjs", [
      `#!${process.execPath}`,
      'import { appendFileSync, readFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(events)}, "decrypt\\n");`,
      "process.stdout.write(readFileSync(process.argv.at(-1)));",
      "",
    ].join("\n"));
    const pgRestore = values.executable("redirect-restore.mjs", [
      `#!${process.execPath}`,
      'import { appendFileSync } from "node:fs";',
      "for await (const _chunk of process.stdin) {}",
      'if (process.argv.includes("--list")) {',
      `  appendFileSync(${JSON.stringify(events)}, "list\\n");`,
      `  process.stdout.write(${JSON.stringify(archiveList())});`,
      "} else {",
      `  appendFileSync(${JSON.stringify(events)}, "apply\\n");`,
      '  process.stdout.write("select 1;\\n");',
      "}",
      "",
    ].join("\n"));
    const psql = values.executable("redirect-psql.mjs", [
      `#!${process.execPath}`,
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(events)}, "session\\n");`,
      'let received = "";',
      'let sent = false;',
      'for await (const chunk of process.stdin) {',
      '  received += chunk.toString("utf8");',
      '  const marker = /HP_RESTORE_[a-f0-9]{48}/u.exec(received)?.[0];',
      '  if (marker !== undefined && !sent && received.includes(marker + "_READY")) {',
      '    sent = true;',
      `    process.stdout.write(marker + "_IDENTITY_BEFORE\\t" + ${JSON.stringify(redirectedIdentityText)} + "\\n" + marker + "_CLEAN_ROOM\\t0\\t0\\t0\\t0\\t0\\t0\\n" + marker + "_READY\\n");`,
      '  }',
      '}',
      "",
    ].join("\n"));
    await assert.rejects(runRestorePipeline({
      ageBinary: age,
      ageIdentityFile: values.file("redirect-identity.txt"),
      applicationName: "test",
      commandTimeoutMs: 30000,
      encryptedFile: encrypted,
      expectedDatabase: database,
      expectedExecutionIdentity: expectedIdentity,
      expectedRole: database,
      expectedServerIdSha256: RESTORE_SERVER_SHA,
      pgRestoreBinary: pgRestore,
      pgService: database,
      pgServiceFile: values.file("redirect.pg_service.conf"),
      pgpassFile: values.file("redirect.pgpass"),
      psqlBinary: psql,
    }), /archive execution session does not match the pinned identity/u);
    assert.deepEqual(readFileSync(events, "utf8").trim().split("\n"), [
      "decrypt",
      "list",
      "session",
    ]);
    assert.deepEqual(readdirSync(values.directories["restore-evidence"]), []);
  } finally {
    rmSync(values.root, { force: true, recursive: true });
  }
});

test("restore pipeline blocks pg_restore reconnect commands before psql can execute them", async () => {
  const values = fixture();
  try {
    const executedSql = join(values.root, "reconnect-executed.sql");
    const database = "handleplan_restore_drill_20260717";
    const identity = restoreIdentity(database);
    const identityText = `${database}\t${database}\t${RESTORE_SERVER_SHA}\ttrue\tfalse\tfalse\tfalse\tfalse\tfalse\ttrue\ttrue`;
    const encrypted = values.file("reconnect-selected.age", "PGDMP encrypted fixture");
    const age = values.executable("reconnect-age.mjs", [
      `#!${process.execPath}`,
      'import { readFileSync } from "node:fs";',
      "process.stdout.write(readFileSync(process.argv.at(-1)));",
      "",
    ].join("\n"));
    const pgRestore = values.executable("reconnect-restore.mjs", [
      `#!${process.execPath}`,
      "for await (const _chunk of process.stdin) {}",
      'if (process.argv.includes("--list")) {',
      `  process.stdout.write(${JSON.stringify(archiveList())});`,
      "} else {",
      '  process.stdout.write("create table public.safe_prefix (value text);\\n\\\\connect redirected_database\\n");',
      "}",
      "",
    ].join("\n"));
    const psql = values.executable("reconnect-psql.mjs", [
      `#!${process.execPath}`,
      'import { appendFileSync } from "node:fs";',
      'let received = "";',
      'let sent = false;',
      'for await (const chunk of process.stdin) {',
      `  appendFileSync(${JSON.stringify(executedSql)}, chunk);`,
      '  received += chunk.toString("utf8");',
      '  const marker = /HP_RESTORE_[a-f0-9]{48}/u.exec(received)?.[0];',
      '  if (marker !== undefined && !sent && received.includes(marker + "_READY")) {',
      '    sent = true;',
      `    process.stdout.write(marker + "_IDENTITY_BEFORE\\t" + ${JSON.stringify(identityText)} + "\\n" + marker + "_CLEAN_ROOM\\t0\\t0\\t0\\t0\\t0\\t0\\n" + marker + "_READY\\n");`,
      '  }',
      '}',
      "",
    ].join("\n"));
    await assert.rejects(runRestorePipeline({
      ageBinary: age,
      ageIdentityFile: values.file("reconnect-identity.txt"),
      applicationName: "test",
      commandTimeoutMs: 30000,
      encryptedFile: encrypted,
      expectedDatabase: database,
      expectedExecutionIdentity: identity,
      expectedRole: database,
      expectedServerIdSha256: RESTORE_SERVER_SHA,
      pgRestoreBinary: pgRestore,
      pgService: database,
      pgServiceFile: values.file("reconnect.pg_service.conf"),
      pgpassFile: values.file("reconnect.pgpass"),
      psqlBinary: psql,
    }), /forbidden psql meta-command/u);
    const sql = readFileSync(executedSql, "utf8");
    assert.match(sql, /begin;\n/u);
    assert.match(sql, /create table public\.safe_prefix/u);
    assert.doesNotMatch(sql, /\\connect redirected_database/u);
    assert.deepEqual(readdirSync(values.directories["restore-evidence"]), []);
  } finally {
    rmSync(values.root, { force: true, recursive: true });
  }
});

test("invalid restore archive preflight never starts the mutating restore pass", async () => {
  const values = fixture();
  try {
    const events = join(values.root, "restore-events-invalid.txt");
    const encrypted = values.file("pipeline-invalid.age", "not a valid archive");
    const age = values.executable("pipeline-invalid-age.mjs", [
      `#!${process.execPath}`,
      'import { readFileSync } from "node:fs";',
      "process.stdout.write(readFileSync(process.argv.at(-1)));",
      "",
    ].join("\n"));
    const pgRestore = values.executable("pipeline-invalid-restore.mjs", [
      `#!${process.execPath}`,
      'import { appendFileSync } from "node:fs";',
      "for await (const _chunk of process.stdin) {}",
      'if (process.argv.includes("--list")) process.stdout.write("invalid archive list\\n");',
      `else appendFileSync(${JSON.stringify(events)}, "apply\\n");`,
      "",
    ].join("\n"));
    await assert.rejects(runRestorePipeline({
      ageBinary: age,
      ageIdentityFile: values.file("pipeline-invalid-identity.txt"),
      applicationName: "test",
      commandTimeoutMs: 30000,
      encryptedFile: encrypted,
      pgRestoreBinary: pgRestore,
      pgService: "handleplan_restore_drill_20260717",
      pgServiceFile: values.file("pipeline-invalid.pg_service.conf"),
      pgpassFile: values.file("pipeline-invalid.pgpass"),
    }), /missing a required evidence relation/u);
    assert.equal(readdirSync(values.root).includes("restore-events-invalid.txt"), false);
  } finally {
    rmSync(values.root, { force: true, recursive: true });
  }
});

test("bounded restore output waits for stubborn children to be force-killed before rejecting", async () => {
  const values = fixture();
  const agePid = join(values.root, "overflow-age.pid");
  const restorePid = join(values.root, "overflow-restore.pid");
  const ageTerm = join(values.root, "overflow-age.term");
  const restoreTerm = join(values.root, "overflow-restore.term");
  try {
    const encrypted = values.file("overflow-selected.age", "encrypted fixture");
    const age = values.executable("overflow-age.mjs", [
      `#!${process.execPath}`,
      'import { appendFileSync, writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(agePid)}, String(process.pid));`,
      `process.on("SIGTERM", () => appendFileSync(${JSON.stringify(ageTerm)}, "term\\n"));`,
      'process.stdout.on("error", () => {});',
      'process.stdout.write("archive");',
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"));
    const pgRestore = values.executable("overflow-restore.mjs", [
      `#!${process.execPath}`,
      'import { appendFileSync, existsSync, writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(restorePid)}, String(process.pid));`,
      `process.on("SIGTERM", () => appendFileSync(${JSON.stringify(restoreTerm)}, "term\\n"));`,
      `while (!existsSync(${JSON.stringify(agePid)})) await new Promise((resolve) => setTimeout(resolve, 10));`,
      'process.stdout.on("error", () => {});',
      "process.stdout.write(Buffer.alloc(2 * 1024 * 1024 + 65536, 65));",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"));
    await assert.rejects(runRestorePipeline({
      ageBinary: age,
      ageIdentityFile: values.file("overflow-identity.txt"),
      applicationName: "test",
      commandTimeoutMs: 30000,
      encryptedFile: encrypted,
      pgRestoreBinary: pgRestore,
      pgService: "handleplan_restore_drill_20260717",
      pgServiceFile: values.file("overflow.pg_service.conf"),
      pgpassFile: values.file("overflow.pgpass"),
    }), /bounded size/u);
    assert.equal(readFileSync(ageTerm, "utf8"), "term\n");
    assert.equal(readFileSync(restoreTerm, "utf8"), "term\n");
    assertFixtureProcessStopped(agePid);
    assertFixtureProcessStopped(restorePid);
  } finally {
    forceStopFixtureProcess(agePid);
    forceStopFixtureProcess(restorePid);
    rmSync(values.root, { force: true, recursive: true });
  }
});

test("restore timeout escalates and waits for every stubborn child to close", async () => {
  const values = fixture();
  const agePid = join(values.root, "timeout-age.pid");
  const restorePid = join(values.root, "timeout-restore.pid");
  const ageTerm = join(values.root, "timeout-age.term");
  const restoreTerm = join(values.root, "timeout-restore.term");
  try {
    const encrypted = values.file("timeout-selected.age", "encrypted fixture");
    const age = values.executable("timeout-age.mjs", [
      `#!${process.execPath}`,
      'import { appendFileSync, writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(agePid)}, String(process.pid));`,
      `process.on("SIGTERM", () => appendFileSync(${JSON.stringify(ageTerm)}, "term\\n"));`,
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"));
    const pgRestore = values.executable("timeout-restore.mjs", [
      `#!${process.execPath}`,
      'import { appendFileSync, writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(restorePid)}, String(process.pid));`,
      `process.on("SIGTERM", () => appendFileSync(${JSON.stringify(restoreTerm)}, "term\\n"));`,
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"));
    await assert.rejects(runRestorePipeline({
      ageBinary: age,
      ageIdentityFile: values.file("timeout-identity.txt"),
      applicationName: "test",
      commandTimeoutMs: 1000,
      encryptedFile: encrypted,
      pgRestoreBinary: pgRestore,
      pgService: "handleplan_restore_drill_20260717",
      pgServiceFile: values.file("timeout.pg_service.conf"),
      pgpassFile: values.file("timeout.pgpass"),
    }), /exceeded its timeout/u);
    assert.equal(readFileSync(ageTerm, "utf8"), "term\n");
    assert.equal(readFileSync(restoreTerm, "utf8"), "term\n");
    assertFixtureProcessStopped(agePid);
    assertFixtureProcessStopped(restorePid);
  } finally {
    forceStopFixtureProcess(agePid);
    forceStopFixtureProcess(restorePid);
    rmSync(values.root, { force: true, recursive: true });
  }
});

test("ordinary command timeout force-kills a stubborn process group before rejecting", async () => {
  const values = fixture();
  const parentPid = join(values.root, "command-parent.pid");
  const childPid = join(values.root, "command-child.pid");
  const childReady = join(values.root, "command-child.ready");
  const parentTerm = join(values.root, "command-parent.term");
  const childTerm = join(values.root, "command-child.term");
  try {
    const descendantCode = [
      'const { appendFileSync, writeFileSync } = require("node:fs");',
      `writeFileSync(${JSON.stringify(childPid)}, String(process.pid));`,
      `writeFileSync(${JSON.stringify(childReady)}, "ready\\n");`,
      `process.on("SIGTERM", () => appendFileSync(${JSON.stringify(childTerm)}, "term\\n"));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const command = values.executable("stubborn-command.mjs", [
      `#!${process.execPath}`,
      'import { spawn } from "node:child_process";',
      'import { appendFileSync, existsSync, writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(parentPid)}, String(process.pid));`,
      `process.on("SIGTERM", () => appendFileSync(${JSON.stringify(parentTerm)}, "term\\n"));`,
      `spawn(process.execPath, ["-e", ${JSON.stringify(descendantCode)}], { detached: false, stdio: "ignore" }).unref();`,
      `while (!existsSync(${JSON.stringify(childReady)})) await new Promise((resolve) => setTimeout(resolve, 10));`,
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"));
    await assert.rejects(runCommand(command, [], {
      env: { HOME: values.root, LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      failureMessage: "stubborn command failed",
      timeoutMs: 1000,
    }), /timeout exceeded/u);
    assert.equal(readFileSync(parentTerm, "utf8"), "term\n");
    assert.equal(readFileSync(childTerm, "utf8"), "term\n");
    await assertFixtureProcessEventuallyStopped(parentPid);
    await assertFixtureProcessEventuallyStopped(childPid);
  } finally {
    forceStopFixtureProcess(parentPid);
    forceStopFixtureProcess(childPid);
    rmSync(values.root, { force: true, recursive: true });
  }
});

test("ordinary command success is rejected after reaping a stubborn descendant", async () => {
  const values = fixture();
  const childPid = join(values.root, "orphan-child.pid");
  const childReady = join(values.root, "orphan-child.ready");
  const childTerm = join(values.root, "orphan-child.term");
  try {
    const descendantCode = [
      'const { appendFileSync, writeFileSync } = require("node:fs");',
      `writeFileSync(${JSON.stringify(childPid)}, String(process.pid));`,
      `writeFileSync(${JSON.stringify(childReady)}, "ready\\n");`,
      `process.on("SIGTERM", () => appendFileSync(${JSON.stringify(childTerm)}, "term\\n"));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const command = values.executable("orphaning-command.mjs", [
      `#!${process.execPath}`,
      'import { spawn } from "node:child_process";',
      'import { existsSync } from "node:fs";',
      `spawn(process.execPath, ["-e", ${JSON.stringify(descendantCode)}], { detached: false, stdio: "ignore" }).unref();`,
      `while (!existsSync(${JSON.stringify(childReady)})) await new Promise((resolve) => setTimeout(resolve, 10));`,
      "",
    ].join("\n"));
    await assert.rejects(runCommand(command, [], {
      env: { HOME: values.root, LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      failureMessage: "orphaning command failed",
      timeoutMs: 10000,
    }), /left a descendant process/u);
    assert.equal(readFileSync(childTerm, "utf8"), "term\n");
    await assertFixtureProcessEventuallyStopped(childPid);
  } finally {
    forceStopFixtureProcess(childPid);
    rmSync(values.root, { force: true, recursive: true });
  }
});

test("ordinary command file guard stops an oversized create-only download", async () => {
  const values = fixture();
  try {
    const destination = join(values.directories["restore-work"], "oversized-download.age");
    const command = values.executable("oversized-download.mjs", [
      `#!${process.execPath}`,
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(destination)}, Buffer.alloc(4096), { flag: "wx", mode: 0o600 });`,
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"));
    await assert.rejects(runCommand(command, [], {
      boundedOutputPath: destination,
      env: { HOME: values.root, LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      failureMessage: "bounded download failed",
      maxOutputFileBytes: 1024,
      timeoutMs: 10_000,
    }), /output file exceeded its bound/u);
  } finally {
    rmSync(values.root, { force: true, recursive: true });
  }
});

test("restore rejects a manifest whose key is not cross-bound to its ID and date", async () => {
  const values = fixture();
  try {
    const selected = validManifest(values);
    const manifest = JSON.parse(readFileSync(selected.manifest, "utf8"));
    manifest.database.objectKey = "handleplan-database/2026/07/17/fixture/database.dump.age";
    writeFileSync(selected.manifest, JSON.stringify(manifest), { mode: 0o600 });
    selected.manifestSha256 = sha256File(selected.manifest);
    await assert.rejects(
      verifyRestore({ environment: restoreEnvironment(values, selected) }),
      /v2 backup contract/u,
    );
  } finally {
    rmSync(values.root, { force: true, recursive: true });
  }
});

test("restore rejects changes to source isolation fields when the full manifest digest is pinned", async () => {
  const values = fixture();
  try {
    const selected = validManifest(values);
    const manifest = JSON.parse(readFileSync(selected.manifest, "utf8"));
    manifest.source.probedServerIdSha256 = RESTORE_SERVER_SHA;
    writeFileSync(selected.manifest, JSON.stringify(manifest), { mode: 0o600 });
    await assert.rejects(
      verifyRestore({ environment: restoreEnvironment(values, selected) }),
      /independently pinned SHA-256/u,
    );
  } finally {
    rmSync(values.root, { force: true, recursive: true });
  }
});

test("restore pins nonproduction server and owner role, accepts an older ledger prefix, and emits pending migration evidence", async () => {
  const values = fixture();
  try {
    const oldLedger = migrationLedger(values).slice(0, 1);
    const selected = validManifest(values, { ledger: oldLedger });
    const environment = restoreEnvironment(values, selected);
    const psql = realpathSync(environment.HANDLEPLAN_RESTORE_PSQL_BIN);
    const database = environment.HANDLEPLAN_RESTORE_EXPECTED_DATABASE;
    const calls = [];
    const runner = (executable, argumentsList, options) => {
      calls.push({ argumentsList: [...argumentsList], env: { ...options.env }, executable });
      if (fulfillCaptureDownload(executable, options, environment, selected)) return "";
      assert.equal(executable, psql);
      const command = argumentsList.find((argument) => argument.startsWith("--command="));
      if (command.includes("pg_control_system")) {
        return `${database}\t${database}\t${RESTORE_SERVER_SHA}\ttrue\tfalse\tfalse\tfalse\tfalse\tfalse\ttrue\ttrue\n`;
      }
      if (command.includes("pg_catalog.pg_event_trigger")) return "0\t0\t0\t0\t0\t0\n";
      if (command.includes("handleplan_schema_migrations")) return `${ledgerText(oldLedger)}\n`;
      if (command.includes("from publication_captures")) return `${captureQueryText()}\n`;
      if (command.includes("to_regclass")) return "true\ttrue\ttrue\ttrue\n";
      assert.fail("unexpected restore SQL");
    };
    let pipelineCalls = 0;
    let pinnedServiceFile;
    const pipelineRunner = async (config) => {
      pipelineCalls += 1;
      pinnedServiceFile = config.pgServiceFile;
      assert.notEqual(config.pgServiceFile, realpathSync(environment.HANDLEPLAN_RESTORE_PGSERVICE_FILE));
      assert.match(readFileSync(config.pgServiceFile, "utf8"), /host=\/var\/run\/postgresql/u);
      assert.notEqual(config.encryptedFile, environment.HANDLEPLAN_RESTORE_ENCRYPTED_FILE);
      writeFileSync(environment.HANDLEPLAN_RESTORE_ENCRYPTED_FILE, "replacement after pin", { mode: 0o600 });
      assert.equal(readFileSync(config.encryptedFile, "utf8"), "age authenticated fixture");
      return boundRestorePipelineResult(config.expectedExecutionIdentity);
    };
    const times = [new Date("2026-07-17T11:00:00.000Z"), new Date("2026-07-17T11:01:00.000Z")];
    const result = await verifyRestore({
      capturePipelineRunner: verifiedCapturePipeline,
      environment,
      now: () => times.shift(),
      pipelineRunner,
      runner,
    });
    assert.equal(pipelineCalls, 1);
    assert.equal(result.evidence.status, "archive-restored-schema-verified");
    assert.equal(result.evidence.semanticDataVerified, false);
    assert.equal(result.evidence.sourceProbeServerIdSha256, SOURCE_SERVER_SHA);
    assert.equal(
      result.evidence.archiveExecutionSessionBinding,
      "pg-restore-sql-same-psql-transaction-v1",
    );
    assert.equal(result.evidence.archiveSessionServerBindingVerified, true);
    assert.equal(result.evidence.ciphertextSha256, selected.sha256);
    assert.equal(result.evidence.manifestSha256, selected.manifestSha256);
    assert.equal(Object.hasOwn(result.evidence, "databaseSha256"), false);
    assert.deepEqual(result.evidence.cleanRoom, {
      catalogVectorVerified: true,
      template0Acknowledged: true,
    });
    assert.deepEqual(result.evidence.target, {
      database,
      hasNoMemberships: true,
      ownsOnlyCurrentDatabase: true,
      probeDiffersFromSourceProbe: true,
      role: database,
      probedServerIdSha256: RESTORE_SERVER_SHA,
      unprivilegedOwner: true,
    });
    assert.equal(result.evidence.schemaState, "forward-migration-required");
    assert.equal(result.evidence.pendingMigrationCount, 1);
    assert.equal(result.evidence.schemaVersion, 2);
    assert.equal(result.evidence.privateCaptureBlobs.status, "encrypted-archive-stream-verified");
    assert.equal(result.evidence.privateCaptureBlobs.restoredDatabaseLedgerVerified, true);
    assert.equal(result.evidence.privateCaptureBlobs.entryCount, 1);
    assert.doesNotMatch(JSON.stringify(result.evidence), new RegExp(CAPTURE_SOURCE_NAMESPACE, "u"));
    for (const call of calls.filter((call) => call.executable === psql)) {
      assert.equal(call.argumentsList.some((argument) => /password|postgres(?:ql)?:\/\//iu.test(argument)), false);
      assert.equal(call.env.PGPASSFILE, realpathSync(environment.HANDLEPLAN_RESTORE_PGPASS_FILE));
      assert.equal(call.env.PGSERVICEFILE, pinnedServiceFile);
    }
    assert.deepEqual(readdirSync(values.directories["restore-work"]), []);
    assert.equal(JSON.parse(readFileSync(result.evidencePath, "utf8")).backupId, BACKUP_ID);
  } finally {
    rmSync(values.root, { force: true, recursive: true });
  }
});

test("restore rejects a symbolic-link capture download before either archive can mutate the database", async () => {
  const values = fixture();
  try {
    const selected = validManifest(values);
    const environment = restoreEnvironment(values, selected);
    const psql = realpathSync(environment.HANDLEPLAN_RESTORE_PSQL_BIN);
    const adapter = realpathSync(environment.HANDLEPLAN_RESTORE_DOWNLOAD_ADAPTER);
    const database = environment.HANDLEPLAN_RESTORE_EXPECTED_DATABASE;
    let databasePipelineCalled = false;
    let capturePipelineCalled = false;
    const runner = (executable, argumentsList, options) => {
      if (executable === adapter) {
        symlinkSync(selected.encrypted, options.env.HANDLEPLAN_RESTORE_DOWNLOAD_DESTINATION_FILE);
        return "";
      }
      assert.equal(executable, psql);
      const command = argumentsList.find((argument) => argument.startsWith("--command="));
      if (command.includes("pg_control_system")) {
        return `${database}\t${database}\t${RESTORE_SERVER_SHA}\ttrue\tfalse\tfalse\tfalse\tfalse\tfalse\ttrue\ttrue\n`;
      }
      if (command.includes("pg_catalog.pg_event_trigger")) return "0\t0\t0\t0\t0\t0\n";
      assert.fail("restore should stop after the unsafe capture download");
    };
    await assert.rejects(verifyRestore({
      capturePipelineRunner: async () => {
        capturePipelineCalled = true;
        return {};
      },
      environment,
      pipelineRunner: async () => {
        databasePipelineCalled = true;
        return { archiveList: archiveList() };
      },
      runner,
    }), /unsafe ciphertext file/u);
    assert.equal(capturePipelineCalled, false);
    assert.equal(databasePipelineCalled, false);
    assert.deepEqual(readdirSync(values.directories["restore-evidence"]), []);
  } finally {
    rmSync(values.root, { force: true, recursive: true });
  }
});

test("restore with a database capture-ledger mismatch emits no green evidence", async () => {
  const values = fixture();
  try {
    const selected = validManifest(values);
    const environment = restoreEnvironment(values, selected);
    const psql = realpathSync(environment.HANDLEPLAN_RESTORE_PSQL_BIN);
    const database = environment.HANDLEPLAN_RESTORE_EXPECTED_DATABASE;
    const ledger = migrationLedger(values);
    const runner = (executable, argumentsList, options) => {
      if (fulfillCaptureDownload(executable, options, environment, selected)) return "";
      assert.equal(executable, psql);
      const command = argumentsList.find((argument) => argument.startsWith("--command="));
      if (command.includes("pg_control_system")) {
        return `${database}\t${database}\t${RESTORE_SERVER_SHA}\ttrue\tfalse\tfalse\tfalse\tfalse\tfalse\ttrue\ttrue\n`;
      }
      if (command.includes("pg_catalog.pg_event_trigger")) return "0\t0\t0\t0\t0\t0\n";
      if (command.includes("handleplan_schema_migrations")) return `${ledgerText(ledger)}\n`;
      if (command.includes("to_regclass")) return "true\ttrue\ttrue\ttrue\n";
      if (command.includes("from publication_captures")) return "";
      assert.fail("unexpected restore SQL");
    };
    await assert.rejects(verifyRestore({
      capturePipelineRunner: verifiedCapturePipeline,
      environment,
      pipelineRunner: async (config) => boundRestorePipelineResult(config.expectedExecutionIdentity),
      runner,
    }), /metadata does not match the encrypted bundle/u);
    assert.deepEqual(readdirSync(values.directories["restore-evidence"]), []);
    assert.deepEqual(readdirSync(values.directories["restore-work"]), []);
  } finally {
    rmSync(values.root, { force: true, recursive: true });
  }
});

test("restore refuses the source server identity even when drill-shaped names match", async () => {
  const values = fixture();
  try {
    const selected = validManifest(values);
    const environment = restoreEnvironment(values, selected);
    const database = environment.HANDLEPLAN_RESTORE_EXPECTED_DATABASE;
    environment.HANDLEPLAN_RESTORE_EXPECTED_SERVER_ID_SHA256 = SOURCE_SERVER_SHA;
    const runner = (_executable, argumentsList) => {
      const command = argumentsList.find((argument) => argument.startsWith("--command="));
      if (command.includes("pg_control_system")) {
        return `${database}\t${database}\t${SOURCE_SERVER_SHA}\ttrue\tfalse\tfalse\tfalse\tfalse\tfalse\ttrue\ttrue\n`;
      }
      assert.fail("restore should stop after identity verification");
    };
    await assert.rejects(
      verifyRestore({ environment, runner }),
      /isolated unprivileged-owner contract/u,
    );
  } finally {
    rmSync(values.root, { force: true, recursive: true });
  }
});

test("restore refuses a privileged database owner before executing archive content", async () => {
  const values = fixture();
  try {
    const selected = validManifest(values);
    const environment = restoreEnvironment(values, selected);
    const database = environment.HANDLEPLAN_RESTORE_EXPECTED_DATABASE;
    const runner = (_executable, argumentsList) => {
      const command = argumentsList.find((argument) => argument.startsWith("--command="));
      if (command.includes("pg_control_system")) {
        return `${database}\t${database}\t${RESTORE_SERVER_SHA}\ttrue\ttrue\tfalse\tfalse\tfalse\tfalse\ttrue\ttrue\n`;
      }
      assert.fail("restore should stop after privileged-role verification");
    };
    await assert.rejects(
      verifyRestore({ environment, runner }),
      /isolated unprivileged-owner contract/u,
    );
  } finally {
    rmSync(values.root, { force: true, recursive: true });
  }
});

test("restore refuses an owner with any explicit role membership", async () => {
  const values = fixture();
  try {
    const selected = validManifest(values);
    const environment = restoreEnvironment(values, selected);
    const database = environment.HANDLEPLAN_RESTORE_EXPECTED_DATABASE;
    const runner = (_executable, argumentsList) => {
      const command = argumentsList.find((argument) => argument.startsWith("--command="));
      if (command.includes("pg_control_system")) {
        return `${database}\t${database}\t${RESTORE_SERVER_SHA}\ttrue\tfalse\tfalse\tfalse\tfalse\tfalse\tfalse\ttrue\n`;
      }
      assert.fail("restore should stop after role-membership verification");
    };
    await assert.rejects(
      verifyRestore({ environment, runner }),
      /isolated unprivileged-owner contract/u,
    );
  } finally {
    rmSync(values.root, { force: true, recursive: true });
  }
});

test("restore refuses an owner that owns any other database", async () => {
  const values = fixture();
  try {
    const selected = validManifest(values);
    const environment = restoreEnvironment(values, selected);
    const database = environment.HANDLEPLAN_RESTORE_EXPECTED_DATABASE;
    const runner = (_executable, argumentsList) => {
      const command = argumentsList.find((argument) => argument.startsWith("--command="));
      if (command.includes("pg_control_system")) {
        return `${database}\t${database}\t${RESTORE_SERVER_SHA}\ttrue\tfalse\tfalse\tfalse\tfalse\tfalse\ttrue\tfalse\n`;
      }
      assert.fail("restore should stop after database-ownership verification");
    };
    await assert.rejects(
      verifyRestore({ environment, runner }),
      /isolated unprivileged-owner contract/u,
    );
  } finally {
    rmSync(values.root, { force: true, recursive: true });
  }
});

test("restore rejects a remote libpq service before executing identity probes", async () => {
  const values = fixture();
  try {
    const selected = validManifest(values);
    const environment = restoreEnvironment(values, selected);
    const database = environment.HANDLEPLAN_RESTORE_EXPECTED_DATABASE;
    writeFileSync(environment.HANDLEPLAN_RESTORE_PGSERVICE_FILE, [
      `[${database}]`,
      "host=db.example",
      `dbname=${database}`,
      `user=${database}`,
      "",
    ].join("\n"), { mode: 0o600 });
    let externalCall = false;
    await assert.rejects(verifyRestore({
      environment,
      pipelineRunner: async () => {
        externalCall = true;
        return { archiveList: archiveList() };
      },
      runner: () => {
        externalCall = true;
        return "";
      },
    }), /one local Unix-socket database and role/u);
    assert.equal(externalCall, false);
  } finally {
    rmSync(values.root, { force: true, recursive: true });
  }
});

test("restore refuses pre-existing executable catalog objects before decrypting archive content", async () => {
  const values = fixture();
  try {
    const selected = validManifest(values);
    const environment = restoreEnvironment(values, selected);
    const database = environment.HANDLEPLAN_RESTORE_EXPECTED_DATABASE;
    let pipelineCalled = false;
    const runner = (_executable, argumentsList) => {
      const command = argumentsList.find((argument) => argument.startsWith("--command="));
      if (command.includes("pg_control_system")) {
        return `${database}\t${database}\t${RESTORE_SERVER_SHA}\ttrue\tfalse\tfalse\tfalse\tfalse\tfalse\ttrue\ttrue\n`;
      }
      if (command.includes("pg_catalog.pg_event_trigger")) return "0\t0\t0\t0\t0\t1\n";
      assert.fail("restore should stop after the catalog clean-room check");
    };
    await assert.rejects(
      verifyRestore({
        environment,
        pipelineRunner: async () => {
          pipelineCalled = true;
          return { archiveList: archiveList() };
        },
        runner,
      }),
      /template0 catalog clean room/u,
    );
    assert.equal(pipelineCalled, false);
  } finally {
    rmSync(values.root, { force: true, recursive: true });
  }
});

test("systemd examples are inert and keep routine backup separate from JIT restore custody", () => {
  const backupService = readFileSync(new URL(
    "../../deploy/backup/systemd/handleplan-backup.service.example",
    import.meta.url,
  ), "utf8");
  const restoreService = readFileSync(new URL(
    "../../deploy/backup/systemd/handleplan-restore-drill.service.example",
    import.meta.url,
  ), "utf8");
  const timer = readFileSync(new URL(
    "../../deploy/backup/systemd/handleplan-backup.timer.example",
    import.meta.url,
  ), "utf8");
  const backupEnvironmentExample = readFileSync(new URL(
    "../../deploy/backup/backup.env.example",
    import.meta.url,
  ), "utf8");
  const restoreEnvironmentExample = readFileSync(new URL(
    "../../deploy/backup/restore-drill.env.example",
    import.meta.url,
  ), "utf8");
  assert.match(backupService, /User=handleplan-backup/u);
  assert.match(backupService, /HANDLEPLAN_BACKUP_ENABLED=false/u);
  assert.match(backupService, /KillMode=control-group/u);
  assert.match(backupService, /LimitCORE=0/u);
  assert.match(backupService, /ReadOnlyPaths=.*private-captures/u);
  assert.match(
    backupService,
    /\/opt\/apps\/handleplan\/operations\/current\/deploy\/backup\/create-backup\.mjs/u,
  );
  assert.match(restoreService, /User=handleplan-restore/u);
  assert.match(restoreService, /HANDLEPLAN_RESTORE_DRILL_ENABLED=false/u);
  assert.match(restoreService, /KillMode=control-group/u);
  assert.match(restoreService, /LimitCORE=0/u);
  assert.match(
    restoreService,
    /\/opt\/apps\/handleplan\/operations\/current\/deploy\/backup\/verify-restore\.mjs/u,
  );
  assert.doesNotMatch(restoreService, /\[Install\]/u);
  assert.match(timer, /\.example unit is not loadable/u);
  assert.match(backupEnvironmentExample, /HANDLEPLAN_BACKUP_ENABLED=false/u);
  assert.match(backupEnvironmentExample, /HANDLEPLAN_BACKUP_CAPTURE_ROOT=/u);
  assert.match(
    backupEnvironmentExample,
    /HANDLEPLAN_BACKUP_MIGRATIONS_DIR=\/opt\/apps\/handleplan\/operations\/current\/deploy\/migrations/u,
  );
  assert.match(restoreEnvironmentExample, /HANDLEPLAN_RESTORE_DRILL_ENABLED=false/u);
  assert.match(restoreEnvironmentExample, /HANDLEPLAN_RESTORE_DOWNLOAD_ADAPTER=/u);
  assert.match(
    restoreEnvironmentExample,
    /HANDLEPLAN_RESTORE_MIGRATIONS_DIR=\/opt\/apps\/handleplan\/operations\/current\/deploy\/migrations/u,
  );
  for (const example of [
    backupService,
    restoreService,
    backupEnvironmentExample,
    restoreEnvironmentExample,
  ]) {
    assert.doesNotMatch(example, /\/opt\/apps\/handleplan\/current\//u);
  }
  assert.doesNotMatch(restoreEnvironmentExample, /AGE-SECRET-KEY-/u);
});

test("runbook retains live operation, origin authentication, capture blobs, RPO, and RTO as non-claims", () => {
  const runbook = readFileSync(new URL(
    "../../docs/runbooks/offhost-backup-restore.md",
    import.meta.url,
  ), "utf8");
  assert.match(runbook, /Only those\s+database-archive-referenced blobs enter the bundle/u);
  assert.match(runbook, /get-create-only/u);
  assert.match(runbook, /at-most-24-hour RPO/u);
  assert.match(runbook, /at-most-two-hour RTO/u);
  assert.match(runbook, /has not\s+executed a production backup/u);
  assert.match(runbook, /does not authenticate backup origin/u);
  assert.match(runbook, /no bundled provider adapter/u);
  assert.match(runbook, /provider-backed private-capture upload\/download or live recovery/u);
  assert.match(runbook, /read-only bind\/ACL/u);
  assert.match(runbook, /source\/right-specific authorization/u);
  assert.match(runbook, /swap is disabled\s+or encrypted/u);
  assert.match(runbook, /archiveSessionServerBindingVerified: true/u);
  assert.match(runbook, /pg-restore-sql-same-psql-transaction-v1/u);
  assert.match(runbook, /pg_dump --snapshot=<exported id>/u);
  assert.match(runbook, /same long-lived `psql` connection.*after commit/su);
  assert.match(runbook, /Live endpoint-redirection evidence remains an\s+activation gate/u);
});
