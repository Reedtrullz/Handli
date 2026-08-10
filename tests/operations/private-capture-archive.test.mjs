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
import { afterEach, test } from "node:test";

import {
  PrivateCaptureArchiveError,
  assertPrivateCaptureStoreUnchanged,
  bindPrivateCaptureDatabaseLedger,
  runEncryptedPrivateCaptureArchive,
  runPrivateCaptureArchiveVerification,
  scanPrivateCaptureStore,
} from "../../deploy/backup/private-capture-archive.mjs";

const roots = new Set();
const SOURCE = "a".repeat(64);

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "handleplan-capture-archive-")));
  chmodSync(root, 0o700);
  roots.add(root);
  const captures = join(root, "captures");
  const work = join(root, "work");
  mkdirSync(captures, { mode: 0o700 });
  mkdirSync(work, { mode: 0o700 });
  return { captures, root, work };
}

function executable(values, name, contents) {
  const path = join(values.root, name);
  writeFileSync(path, contents, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function install(values, payload = "synthetic rights-cleared capture", publicationId = 42) {
  const bytes = Buffer.from(payload);
  const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
  const blobKey = `official-offers/private/v1/${SOURCE}/${publicationId}/${checksumSha256}`;
  const path = join(values.captures, ...blobKey.split("/"));
  let current = values.captures;
  for (const segment of blobKey.split("/").slice(0, -1)) {
    current = join(current, segment);
    mkdirSync(current, { mode: 0o700, recursive: true });
    chmodSync(current, 0o700);
  }
  writeFileSync(path, bytes, { flag: "wx", mode: 0o400 });
  chmodSync(path, 0o400);
  return { blobKey, byteLength: bytes.byteLength, checksumSha256, path, publicationId };
}

function scan(values) {
  return scanPrivateCaptureStore({
    deadlineMs: Date.now() + 10_000,
    expectedOwnerUid: process.getuid(),
    maxFiles: 10,
    maxPlaintextBytes: 1024 * 1024,
    rootDirectory: values.captures,
  });
}

function passthroughAge(values) {
  return executable(values, "age-fixture.mjs", [
    `#!${process.execPath}`,
    'import { readFileSync, writeFileSync } from "node:fs";',
    'if (process.argv.includes("--encrypt")) {',
    "  const chunks = [];",
    "  for await (const chunk of process.stdin) chunks.push(chunk);",
    '  const output = process.argv[process.argv.indexOf("--output") + 1];',
    "  writeFileSync(output, Buffer.concat(chunks), { flag: \"wx\", mode: 0o600 });",
    "} else {",
    "  process.stdout.write(readFileSync(process.argv.at(-1)));",
    "}",
    "",
  ].join("\n"));
}

afterEach(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
    roots.delete(root);
  }
});

test("a database-bound capture bundle streams to age and verifies without a plaintext archive", async () => {
  const values = fixture();
  const entry = install(values);
  const before = scan(values);
  const bound = bindPrivateCaptureDatabaseLedger(before, [entry]);
  const age = passthroughAge(values);
  const recipients = join(values.root, "recipients.txt");
  const identity = join(values.root, "identity.txt");
  writeFileSync(recipients, "age1fixture\n", { mode: 0o600 });
  writeFileSync(identity, "synthetic identity fixture\n", { mode: 0o600 });
  const encryptedPath = join(values.work, "private-captures.bundle.age");

  await runEncryptedPrivateCaptureArchive({
    ageBinary: age,
    ageRecipientsFile: recipients,
    commandTimeoutMs: 10_000,
    encryptedPath,
    maxArtifactBytes: 1024 * 1024,
    snapshot: bound,
  });
  assertPrivateCaptureStoreUnchanged(before, scan(values));
  const verified = await runPrivateCaptureArchiveVerification({
    ageBinary: age,
    ageIdentityFile: identity,
    commandTimeoutMs: 10_000,
    encryptedFile: encryptedPath,
    expected: {
      databaseLedgerSha256: bound.databaseLedgerSha256,
      databaseReferencedEntryCount: bound.databaseReferencedEntryCount,
      entryCount: bound.entryCount,
      inventorySha256: bound.inventorySha256,
      plaintextBytes: bound.plaintextBytes,
    },
  });

  assert.deepEqual(verified, {
    databaseLedgerSha256: bound.databaseLedgerSha256,
    databaseReferencedEntryCount: 1,
    entryCount: 1,
    inventorySha256: bound.inventorySha256,
    plaintextBytes: entry.byteLength,
  });
  assert.deepEqual(readFileSync(entry.path), Buffer.from("synthetic rights-cleared capture"));
  assert.deepEqual(readdirSync(values.work), ["private-captures.bundle.age"]);
});

test("an empty database capture ledger produces a bounded authenticated empty bundle", async () => {
  const values = fixture();
  const before = scan(values);
  const bound = bindPrivateCaptureDatabaseLedger(before, []);
  const age = passthroughAge(values);
  const recipients = join(values.root, "recipients.txt");
  const identity = join(values.root, "identity.txt");
  writeFileSync(recipients, "age1fixture\n", { mode: 0o600 });
  writeFileSync(identity, "synthetic identity fixture\n", { mode: 0o600 });
  const encryptedPath = join(values.work, "empty.age");
  await runEncryptedPrivateCaptureArchive({
    ageBinary: age,
    ageRecipientsFile: recipients,
    commandTimeoutMs: 10_000,
    encryptedPath,
    maxArtifactBytes: 1024 * 1024,
    snapshot: bound,
  });
  const verified = await runPrivateCaptureArchiveVerification({
    ageBinary: age,
    ageIdentityFile: identity,
    commandTimeoutMs: 10_000,
    encryptedFile: encryptedPath,
    expected: {
      databaseLedgerSha256: bound.databaseLedgerSha256,
      databaseReferencedEntryCount: 0,
      entryCount: 0,
      inventorySha256: bound.inventorySha256,
      plaintextBytes: 0,
    },
  });
  assert.equal(verified.entryCount, 0);
  assert.equal(verified.plaintextBytes, 0);
});

test("the capture scanner rejects symbolic paths, writable blobs, and hard links", () => {
  {
    const values = fixture();
    const physical = join(values.root, "physical");
    mkdirSync(physical, { mode: 0o700 });
    const linked = join(values.root, "linked");
    symlinkSync(physical, linked, "dir");
    assert.throws(() => scanPrivateCaptureStore({
      deadlineMs: Date.now() + 10_000,
      expectedOwnerUid: process.getuid(),
      maxFiles: 10,
      maxPlaintextBytes: 1024,
      rootDirectory: linked,
    }), PrivateCaptureArchiveError);
  }
  {
    const values = fixture();
    const entry = install(values, "writable");
    chmodSync(entry.path, 0o600);
    assert.throws(() => scan(values), /unsafe blob/u);
  }
  {
    const values = fixture();
    const entry = install(values, "linked");
    linkSync(entry.path, join(values.root, "second-link"));
    assert.throws(() => scan(values), /unsafe blob/u);
  }
  {
    const values = fixture();
    const entry = install(values, "bad directory mode");
    chmodSync(join(values.captures, "official-offers/private/v1", SOURCE), 0o755);
    assert.throws(() => scan(values), /unsafe directory/u);
    assert.equal(readFileSync(entry.path, "utf8"), "bad directory mode");
  }
  {
    const values = fixture();
    const entry = install(values, "original-content");
    chmodSync(entry.path, 0o600);
    writeFileSync(entry.path, "mutated-content!", { mode: 0o600 });
    chmodSync(entry.path, 0o400);
    assert.throws(() => scan(values), /content-addressed key/u);
  }
  {
    const values = fixture();
    const outside = join(values.root, "outside-source");
    mkdirSync(outside, { mode: 0o700 });
    const hierarchy = join(values.captures, "official-offers/private/v1");
    mkdirSync(hierarchy, { mode: 0o700, recursive: true });
    for (const path of [
      join(values.captures, "official-offers"),
      join(values.captures, "official-offers/private"),
      hierarchy,
    ]) chmodSync(path, 0o700);
    symlinkSync(outside, join(hierarchy, SOURCE), "dir");
    assert.throws(() => scan(values), /non-directory component/u);
  }
});

test("the database ledger fails closed on missing and mismatched immutable blobs", () => {
  const values = fixture();
  const entry = install(values);
  const snapshot = scan(values);
  assert.throws(
    () => bindPrivateCaptureDatabaseLedger(snapshot, [{ ...entry, byteLength: entry.byteLength + 1 }]),
    /database metadata conflicts/u,
  );
  assert.throws(
    () => bindPrivateCaptureDatabaseLedger(snapshot, [{ ...entry, publicationId: 43 }]),
    /database ledger contains an invalid row/u,
  );
  const missingChecksum = "f".repeat(64);
  assert.throws(
    () => bindPrivateCaptureDatabaseLedger(snapshot, [{
      blobKey: `official-offers/private/v1/${SOURCE}/99/${missingChecksum}`,
      byteLength: 1,
      checksumSha256: missingChecksum,
      publicationId: 99,
    }]),
    /references a missing immutable blob/u,
  );
});

test("bundle verification rejects trailing, truncated, and structurally altered plaintext", async () => {
  const values = fixture();
  const entry = install(values);
  const bound = bindPrivateCaptureDatabaseLedger(scan(values), [entry]);
  const age = passthroughAge(values);
  const recipients = join(values.root, "recipients.txt");
  const identity = join(values.root, "identity.txt");
  writeFileSync(recipients, "age1fixture\n", { mode: 0o600 });
  writeFileSync(identity, "synthetic identity fixture\n", { mode: 0o600 });
  const valid = join(values.work, "valid.age");
  await runEncryptedPrivateCaptureArchive({
    ageBinary: age,
    ageRecipientsFile: recipients,
    commandTimeoutMs: 10_000,
    encryptedPath: valid,
    maxArtifactBytes: 1024 * 1024,
    snapshot: bound,
  });
  const expected = {
    databaseLedgerSha256: bound.databaseLedgerSha256,
    databaseReferencedEntryCount: 1,
    entryCount: 1,
    inventorySha256: bound.inventorySha256,
    plaintextBytes: bound.plaintextBytes,
  };
  const original = readFileSync(valid);
  const cases = [
    Buffer.concat([original, Buffer.from("x")]),
    original.subarray(0, original.length - 1),
    Buffer.from(original.toString("utf8").replace(
      '"contractVersion":1',
      '"contractVersion":1,"unknown":true',
    )),
  ];
  for (const [index, bytes] of cases.entries()) {
    const path = join(values.work, `invalid-${index}.age`);
    writeFileSync(path, bytes, { mode: 0o600 });
    await assert.rejects(runPrivateCaptureArchiveVerification({
      ageBinary: age,
      ageIdentityFile: identity,
      commandTimeoutMs: 10_000,
      encryptedFile: path,
      expected,
    }), PrivateCaptureArchiveError);
  }
});

test("capture encryption timeout reaps the age process and leaves no ciphertext", async () => {
  const values = fixture();
  const bound = bindPrivateCaptureDatabaseLedger(scan(values), []);
  const pidFile = join(values.root, "stalled-age.pid");
  const age = executable(values, "stalled-age.mjs", [
    `#!${process.execPath}`,
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n"));
  const recipients = join(values.root, "recipients.txt");
  writeFileSync(recipients, "age1fixture\n", { mode: 0o600 });
  const encryptedPath = join(values.work, "must-not-survive.age");
  await assert.rejects(runEncryptedPrivateCaptureArchive({
    ageBinary: age,
    ageRecipientsFile: recipients,
    commandTimeoutMs: 1000,
    encryptedPath,
    maxArtifactBytes: 1024 * 1024,
    snapshot: bound,
  }), /exceeded its timeout/u);
  assert.equal(existsSync(encryptedPath), false);
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.throws(
    () => process.kill(pid, 0),
    (error) => error?.code === "ESRCH",
  );
});
