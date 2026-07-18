import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export const MAX_PRIVATE_CAPTURE_BLOB_BYTES = 50 * 1024 * 1024;

const ARCHIVE_MAGIC = "HANDLEPLAN_PRIVATE_CAPTURES_V1\n";
const ARCHIVE_FORMAT = "handleplan-private-captures-v1";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o400;
const READ_CHUNK_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 2048;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const BLOB_KEY_PATTERN =
  /^official-offers\/private\/v1\/([a-f0-9]{64})\/([1-9][0-9]{0,15})\/([a-f0-9]{64})$/u;

export class PrivateCaptureArchiveError extends Error {}

function fail(message) {
  throw new PrivateCaptureArchiveError(message);
}

function errorCode(error) {
  return error !== null && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

function mode(value) {
  return typeof value === "bigint" ? Number(value & 0o777n) : value & 0o777;
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function assertDeadline(deadlineMs) {
  if (Date.now() > deadlineMs) fail("private-capture operation exceeded its timeout");
}

function stableStat(status) {
  return {
    ctimeNs: String(status.ctimeNs),
    dev: String(status.dev),
    ino: String(status.ino),
    mode: Number(status.mode),
    mtimeNs: String(status.mtimeNs),
    nlink: Number(status.nlink),
    size: Number(status.size),
    uid: Number(status.uid),
  };
}

function privateLstat(path) {
  return lstatSync(path, { bigint: true });
}

function privateFstat(descriptor) {
  return fstatSync(descriptor, { bigint: true });
}

function sameStableStat(left, right) {
  return JSON.stringify(stableStat(left)) === JSON.stringify(stableStat(right));
}

function assertPrivateDirectory(path, ownerUid) {
  const status = privateLstat(path);
  if (
    status.isSymbolicLink()
    || !status.isDirectory()
    || Number(status.uid) !== ownerUid
    || mode(status.mode) !== DIRECTORY_MODE
  ) {
    fail("private-capture store contains an unsafe directory");
  }
  return status;
}

function assertPrivateFile(path, ownerUid, expectedChecksum) {
  const status = privateLstat(path);
  if (
    status.isSymbolicLink()
    || !status.isFile()
    || Number(status.uid) !== ownerUid
    || mode(status.mode) !== FILE_MODE
    || status.nlink !== 1n
    || status.size < 1n
    || status.size > BigInt(MAX_PRIVATE_CAPTURE_BLOB_BYTES)
    || !SHA256_PATTERN.test(expectedChecksum)
  ) {
    fail("private-capture store contains an unsafe blob");
  }
  return status;
}

function readDirectoryNames(path, maximumNodes, state, deadlineMs) {
  const names = [];
  const directory = opendirSync(path);
  try {
    for (;;) {
      assertDeadline(deadlineMs);
      const entry = directory.readSync();
      if (entry === null) break;
      state.nodes += 1;
      if (state.nodes > maximumNodes) {
        fail("private-capture store exceeds its bounded node count");
      }
      names.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  return names.sort();
}

function allowedChild(depth, name) {
  if (depth === 0) return name === "official-offers" ? "directory" : undefined;
  if (depth === 1) return name === "private" ? "directory" : undefined;
  if (depth === 2) return name === "v1" ? "directory" : undefined;
  if (depth === 3) return SHA256_PATTERN.test(name) ? "directory" : undefined;
  if (depth === 4) return /^[1-9][0-9]{0,15}$/u.test(name) ? "directory" : undefined;
  if (depth === 5) return SHA256_PATTERN.test(name) ? "file" : undefined;
  return undefined;
}

function readAndHashBlob(path, pathStatus, expectedChecksum, deadlineMs) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = privateFstat(descriptor);
    if (!sameStableStat(pathStatus, before)) {
      fail("private-capture blob changed before it could be read");
    }
    const digest = createHash("sha256");
    const declaredBytes = Number(before.size);
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, declaredBytes));
    let bytes = 0;
    for (;;) {
      assertDeadline(deadlineMs);
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      bytes += count;
      if (bytes > declaredBytes || bytes > MAX_PRIVATE_CAPTURE_BLOB_BYTES) {
        fail("private-capture blob exceeded its declared bound while reading");
      }
      const chunk = buffer.subarray(0, count);
      digest.update(chunk);
    }
    const after = privateFstat(descriptor);
    if (!sameStableStat(before, after) || bytes !== declaredBytes) {
      fail("private-capture blob changed while it was read");
    }
    const checksumSha256 = digest.digest("hex");
    if (checksumSha256 !== expectedChecksum) {
      fail("private-capture blob does not match its content-addressed key");
    }
    return { byteLength: bytes, checksumSha256 };
  } catch (error) {
    if (error instanceof PrivateCaptureArchiveError) throw error;
    if (["ELOOP", "ENOTDIR"].includes(errorCode(error))) {
      fail("private-capture store contains a symbolic-link path");
    }
    fail("private-capture blob could not be read safely");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function snapshotDigest(snapshot) {
  return createHash("sha256").update(JSON.stringify({
    directories: snapshot.directories,
    entries: snapshot.entries.map((entry) => ({
      blobKey: entry.blobKey,
      byteLength: entry.byteLength,
      checksumSha256: entry.checksumSha256,
      status: entry.status,
    })),
  })).digest("hex");
}

function inventoryLine(entry) {
  return `${entry.blobKey}\t${entry.byteLength}\t${entry.checksumSha256}\t${entry.databaseReferenced ? "1" : "0"}\n`;
}

function databaseLedgerLine(entry) {
  const publicationId = entry.publicationId ?? Number(entry.blobKey.split("/")[4]);
  return `${entry.blobKey}\t${publicationId}\t${entry.byteLength}\t${entry.checksumSha256}\n`;
}

function inventoryMetadata(entries) {
  const inventory = createHash("sha256");
  const databaseLedger = createHash("sha256");
  let databaseReferencedEntryCount = 0;
  for (const entry of entries) {
    inventory.update(inventoryLine(entry));
    if (entry.databaseReferenced) {
      databaseLedger.update(databaseLedgerLine(entry));
      databaseReferencedEntryCount += 1;
    }
  }
  return {
    databaseLedgerSha256: databaseLedger.digest("hex"),
    databaseReferencedEntryCount,
    inventorySha256: inventory.digest("hex"),
  };
}

export function canonicalPrivateCaptureDatabaseLedger(entries) {
  if (!Array.isArray(entries)) fail("private-capture database ledger is invalid");
  const normalized = entries.map((entry) => {
    const keyMatch = BLOB_KEY_PATTERN.exec(entry?.blobKey ?? "");
    if (
      entry === null
      || typeof entry !== "object"
      || keyMatch === null
      || !Number.isSafeInteger(entry.publicationId)
      || entry.publicationId < 1
      || Number(keyMatch[2]) !== entry.publicationId
      || !Number.isSafeInteger(entry.byteLength)
      || entry.byteLength < 1
      || entry.byteLength > MAX_PRIVATE_CAPTURE_BLOB_BYTES
      || !SHA256_PATTERN.test(entry.checksumSha256 ?? "")
      || entry.blobKey.split("/").at(-1) !== entry.checksumSha256
    ) {
      fail("private-capture database ledger contains an invalid row");
    }
    return {
      blobKey: entry.blobKey,
      byteLength: entry.byteLength,
      checksumSha256: entry.checksumSha256,
      publicationId: entry.publicationId,
    };
  }).sort((left, right) => compareText(left.blobKey, right.blobKey));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1].blobKey === normalized[index].blobKey) {
      fail("private-capture database ledger contains a duplicate blob key");
    }
  }
  const digest = createHash("sha256");
  for (const entry of normalized) digest.update(databaseLedgerLine(entry));
  return {
    entries: normalized,
    entryCount: normalized.length,
    sha256: digest.digest("hex"),
  };
}

export function scanPrivateCaptureStore({
  deadlineMs,
  expectedOwnerUid,
  maxFiles,
  maxPlaintextBytes,
  rootDirectory,
}) {
  if (
    typeof rootDirectory !== "string"
    || rootDirectory.length < 2
    || rootDirectory.includes("\0")
    || !isAbsolute(rootDirectory)
    || resolve(rootDirectory) !== rootDirectory
    || rootDirectory === parse(rootDirectory).root
    || !Number.isSafeInteger(expectedOwnerUid)
    || expectedOwnerUid < 0
    || !Number.isSafeInteger(maxFiles)
    || maxFiles < 1
    || !Number.isSafeInteger(maxPlaintextBytes)
    || maxPlaintextBytes < 1
    || !Number.isFinite(deadlineMs)
  ) {
    fail("private-capture scan configuration is invalid");
  }
  assertDeadline(deadlineMs);
  let canonical;
  try {
    canonical = realpathSync(rootDirectory);
  } catch {
    fail("private-capture root must be an existing canonical directory");
  }
  if (canonical !== rootDirectory) {
    fail("private-capture root or one of its ancestors is a symbolic link");
  }
  const maximumNodes = Math.min(4_000_000, maxFiles * 3 + 64);
  const state = { nodes: 0 };
  const directories = [];
  const entries = [];
  let plaintextBytes = 0;

  const visit = (path, segments) => {
    assertDeadline(deadlineMs);
    const before = assertPrivateDirectory(path, expectedOwnerUid);
    const names = readDirectoryNames(path, maximumNodes, state, deadlineMs);
    for (const name of names) {
      const expectedKind = allowedChild(segments.length, name);
      if (expectedKind === undefined) {
        fail("private-capture store does not match the official-offer v1 layout");
      }
      const childPath = join(path, name);
      const relativePath = [...segments, name].join("/");
      const childStatus = privateLstat(childPath);
      if (expectedKind === "directory") {
        if (childStatus.isSymbolicLink() || !childStatus.isDirectory()) {
          fail("private-capture layout contains a non-directory component");
        }
        visit(childPath, [...segments, name]);
        continue;
      }
      if (childStatus.isSymbolicLink() || !childStatus.isFile()) {
        fail("private-capture layout contains a non-file blob");
      }
      if (!BLOB_KEY_PATTERN.test(relativePath)) {
        fail("private-capture blob key is invalid");
      }
      if (entries.length >= maxFiles) fail("private-capture store exceeds its file-count bound");
      const checksumSha256 = relativePath.split("/").at(-1);
      const safeStatus = assertPrivateFile(childPath, expectedOwnerUid, checksumSha256);
      if (plaintextBytes + Number(safeStatus.size) > maxPlaintextBytes) {
        fail("private-capture store exceeds its plaintext-byte bound");
      }
      const verified = readAndHashBlob(
        childPath,
        safeStatus,
        checksumSha256,
        deadlineMs,
      );
      const afterPath = privateLstat(childPath);
      if (!sameStableStat(safeStatus, afterPath)) {
        fail("private-capture blob changed while the store was scanned");
      }
      plaintextBytes += verified.byteLength;
      entries.push({
        absolutePath: childPath,
        blobKey: relativePath,
        byteLength: verified.byteLength,
        checksumSha256: verified.checksumSha256,
        status: stableStat(afterPath),
      });
    }
    const after = privateLstat(path);
    if (!sameStableStat(before, after)) {
      fail("private-capture directory changed while the store was scanned");
    }
    directories.push({ path: segments.join("/"), status: stableStat(after) });
  };

  visit(rootDirectory, []);
  entries.sort((left, right) => compareText(left.blobKey, right.blobKey));
  directories.sort((left, right) => compareText(left.path, right.path));
  const snapshot = { directories, entries, plaintextBytes };
  return {
    ...snapshot,
    entryCount: entries.length,
    snapshotSha256: snapshotDigest(snapshot),
  };
}

export function bindPrivateCaptureDatabaseLedger(snapshot, databaseEntries) {
  const ledger = canonicalPrivateCaptureDatabaseLedger(databaseEntries);
  const storeByKey = new Map(snapshot.entries.map((entry) => [entry.blobKey, entry]));
  const entries = ledger.entries.map((databaseEntry) => {
    const entry = storeByKey.get(databaseEntry.blobKey);
    if (entry === undefined) {
      fail("private-capture database metadata references a missing immutable blob");
    }
    if (
      databaseEntry.byteLength !== entry.byteLength
      || databaseEntry.checksumSha256 !== entry.checksumSha256
    ) {
      fail("private-capture database metadata conflicts with its immutable blob");
    }
    return { ...entry, databaseReferenced: true };
  });
  const metadata = inventoryMetadata(entries);
  if (
    metadata.databaseReferencedEntryCount !== ledger.entryCount
    || metadata.databaseLedgerSha256 !== ledger.sha256
  ) {
    fail("private-capture database ledger did not bind to the blob inventory");
  }
  return {
    ...metadata,
    directories: snapshot.directories,
    entries,
    entryCount: entries.length,
    plaintextBytes: entries.reduce((total, entry) => total + entry.byteLength, 0),
    snapshotSha256: snapshot.snapshotSha256,
    storeEntryCount: snapshot.entryCount,
    storePlaintextBytes: snapshot.plaintextBytes,
  };
}

export function assertPrivateCaptureStoreUnchanged(before, after) {
  if (
    before.snapshotSha256 !== after.snapshotSha256
    || before.entryCount !== after.entryCount
    || before.plaintextBytes !== after.plaintextBytes
  ) {
    fail("private-capture store changed while the encrypted archive was produced");
  }
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

function childCompletion(child, stop) {
  return new Promise((resolve) => {
    let spawnFailed = false;
    child.once("error", () => {
      spawnFailed = true;
      stop();
    });
    child.once("close", (code, signal) => resolve(!spawnFailed && code === 0 && signal === null));
  });
}

function writeChunk(stream, chunk) {
  return new Promise((resolveWrite, rejectWrite) => {
    stream.write(chunk, (error) => {
      if (error) rejectWrite(error);
      else resolveWrite();
    });
  });
}

function endStream(stream) {
  return new Promise((resolveEnd, rejectEnd) => {
    stream.end((error) => {
      if (error) rejectEnd(error);
      else resolveEnd();
    });
  });
}

function headerFor(snapshot) {
  return {
    contractVersion: 1,
    databaseLedgerSha256: snapshot.databaseLedgerSha256,
    databaseReferencedEntryCount: snapshot.databaseReferencedEntryCount,
    entryCount: snapshot.entryCount,
    format: ARCHIVE_FORMAT,
    inventorySha256: snapshot.inventorySha256,
    plaintextBytes: snapshot.plaintextBytes,
  };
}

async function writePrivateCaptureArchive(stream, snapshot, deadlineMs) {
  await writeChunk(stream, Buffer.from(ARCHIVE_MAGIC));
  await writeChunk(stream, Buffer.from(`${JSON.stringify(headerFor(snapshot))}\n`));
  for (const entry of snapshot.entries) {
    assertDeadline(deadlineMs);
    await writeChunk(stream, Buffer.from(`${JSON.stringify({
      blobKey: entry.blobKey,
      byteLength: entry.byteLength,
      checksumSha256: entry.checksumSha256,
      databaseReferenced: entry.databaseReferenced,
    })}\n`));
    const currentPathStatus = assertPrivateFile(
      entry.absolutePath,
      entry.status.uid,
      entry.checksumSha256,
    );
    if (JSON.stringify(stableStat(currentPathStatus)) !== JSON.stringify(entry.status)) {
      fail("private-capture blob changed after inventory scan");
    }
    let descriptor;
    try {
      descriptor = openSync(entry.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = privateFstat(descriptor);
      if (!sameStableStat(currentPathStatus, before)) {
        fail("private-capture blob changed before archive streaming");
      }
      const digest = createHash("sha256");
      const declaredBytes = Number(before.size);
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, declaredBytes));
      let bytes = 0;
      for (;;) {
        assertDeadline(deadlineMs);
        const count = readSync(descriptor, buffer, 0, buffer.length, null);
        if (count === 0) break;
        bytes += count;
        if (bytes > entry.byteLength || bytes > MAX_PRIVATE_CAPTURE_BLOB_BYTES) {
          fail("private-capture blob exceeded its bound during archive streaming");
        }
        const chunk = buffer.subarray(0, count);
        digest.update(chunk);
        await writeChunk(stream, chunk);
      }
      const after = privateFstat(descriptor);
      if (
        !sameStableStat(before, after)
        || bytes !== entry.byteLength
        || digest.digest("hex") !== entry.checksumSha256
      ) {
        fail("private-capture blob changed during archive streaming");
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    const afterPathStatus = privateLstat(entry.absolutePath);
    if (!sameStableStat(currentPathStatus, afterPathStatus)) {
      fail("private-capture blob path changed during archive streaming");
    }
    await writeChunk(stream, Buffer.from("\n"));
  }
  await writeChunk(stream, Buffer.from(`${JSON.stringify({
    databaseLedgerSha256: snapshot.databaseLedgerSha256,
    databaseReferencedEntryCount: snapshot.databaseReferencedEntryCount,
    entryCount: snapshot.entryCount,
    inventorySha256: snapshot.inventorySha256,
    plaintextBytes: snapshot.plaintextBytes,
    status: "complete",
  })}\n`));
  await endStream(stream);
}

function safeProcessEnvironment() {
  return {
    HOME: process.env.HOME ?? "/nonexistent",
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
  };
}

function controllerFor(child) {
  let stopped = false;
  let forceKillTimer;
  let forceKillFinished = Promise.resolve();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (!signalProcessTree(child, "SIGTERM")) return;
    forceKillFinished = new Promise((resolveKill) => {
      forceKillTimer = setTimeout(() => {
        signalProcessTree(child, "SIGKILL");
        resolveKill();
      }, 2_000);
    });
  };
  return {
    clear: () => clearTimeout(forceKillTimer),
    finishKill: () => forceKillFinished,
    stop,
  };
}

export async function runEncryptedPrivateCaptureArchive({
  ageBinary,
  ageRecipientsFile,
  commandTimeoutMs,
  encryptedPath,
  maxArtifactBytes,
  snapshot,
}) {
  if (existsSync(encryptedPath)) fail("private-capture ciphertext destination already exists");
  const child = spawn(ageBinary, [
    "--encrypt",
    "--recipients-file",
    ageRecipientsFile,
    "--output",
    encryptedPath,
  ], {
    detached: process.platform !== "win32",
    env: safeProcessEnvironment(),
    stdio: ["pipe", "ignore", "ignore"],
  });
  const controller = controllerFor(child);
  const completion = childCompletion(child, controller.stop);
  let timedOut = false;
  let oversized = false;
  const deadlineMs = Date.now() + commandTimeoutMs;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.stop();
  }, commandTimeoutMs);
  timeout.unref();
  const sizeGuard = setInterval(() => {
    try {
      if (existsSync(encryptedPath) && statSync(encryptedPath).size > maxArtifactBytes) {
        oversized = true;
        controller.stop();
      }
    } catch {
      controller.stop();
    }
  }, 100);
  sizeGuard.unref();
  const writer = writePrivateCaptureArchive(child.stdin, snapshot, deadlineMs)
    .catch((error) => {
      controller.stop();
      throw error;
    });
  let successful = false;
  try {
    const [completionResult, writerResult] = await Promise.allSettled([completion, writer]);
    if (timedOut) fail("private-capture encryption exceeded its timeout");
    if (oversized) fail("private-capture ciphertext exceeded its artifact limit");
    if (writerResult.status === "rejected") {
      if (writerResult.reason instanceof PrivateCaptureArchiveError) throw writerResult.reason;
      fail("private-capture plaintext stream could not be encrypted");
    }
    if (completionResult.status !== "fulfilled" || !completionResult.value) {
      fail("private-capture authenticated encryption failed");
    }
    if (!existsSync(encryptedPath)) fail("private-capture encryption produced no ciphertext");
    const status = lstatSync(encryptedPath);
    if (
      status.isSymbolicLink()
      || !status.isFile()
      || status.nlink !== 1
      || (typeof process.getuid === "function" && status.uid !== process.getuid())
      || status.size < 1
      || status.size > maxArtifactBytes
    ) {
      fail("private-capture encryption produced an unsafe ciphertext artifact");
    }
    chmodSync(encryptedPath, 0o600);
    const privateStatus = lstatSync(encryptedPath);
    if (
      privateStatus.dev !== status.dev
      || privateStatus.ino !== status.ino
      || mode(privateStatus.mode) !== 0o600
      || privateStatus.nlink !== 1
      || privateStatus.uid !== status.uid
      || privateStatus.size !== status.size
    ) {
      fail("private-capture ciphertext could not be made owner-private");
    }
    successful = true;
    return { ciphertextBytes: privateStatus.size };
  } finally {
    clearInterval(sizeGuard);
    clearTimeout(timeout);
    controller.stop();
    await Promise.allSettled([completion, writer]);
    if (processTreeExists(child)) await controller.finishKill();
    controller.clear();
    if (!successful) rmSync(encryptedPath, { force: true });
  }
}

function exactJsonKeys(value, keys) {
  return (
    value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\n") === [...keys].sort().join("\n")
  );
}

function parseJsonLine(line, label) {
  try {
    return JSON.parse(line.toString("utf8"));
  } catch {
    fail(`private-capture archive has an invalid ${label}`);
  }
}

class PrivateCaptureArchiveParser {
  constructor(expected) {
    this.expected = expected;
    this.lineParts = [];
    this.lineBytes = 0;
    this.stage = "magic";
    this.bodyRemaining = 0;
    this.bodyDigest = undefined;
    this.currentEntry = undefined;
    this.entryCount = 0;
    this.plaintextBytes = 0;
    this.inventoryDigest = createHash("sha256");
    this.databaseDigest = createHash("sha256");
    this.databaseReferencedEntryCount = 0;
    this.previousBlobKey = undefined;
    this.totalStreamBytes = 0;
    this.maximumStreamBytes = expected.plaintextBytes + expected.entryCount * MAX_LINE_BYTES + 8_192;
  }

  consume(chunk) {
    this.totalStreamBytes += chunk.length;
    if (this.totalStreamBytes > this.maximumStreamBytes) {
      fail("private-capture decrypted stream exceeds its structural bound");
    }
    let offset = 0;
    while (offset < chunk.length) {
      if (this.stage === "body") {
        const count = Math.min(this.bodyRemaining, chunk.length - offset);
        const bodyChunk = chunk.subarray(offset, offset + count);
        this.bodyDigest.update(bodyChunk);
        this.bodyRemaining -= count;
        this.plaintextBytes += count;
        if (this.plaintextBytes > this.expected.plaintextBytes) {
          fail("private-capture archive exceeds its plaintext-byte declaration");
        }
        offset += count;
        if (this.bodyRemaining === 0) {
          if (this.bodyDigest.digest("hex") !== this.currentEntry.checksumSha256) {
            fail("private-capture archive blob checksum is invalid");
          }
          this.stage = "separator";
        }
        continue;
      }
      if (this.stage === "separator") {
        if (chunk[offset] !== 0x0a) fail("private-capture archive blob separator is invalid");
        offset += 1;
        this.entryCount += 1;
        this.currentEntry = undefined;
        this.bodyDigest = undefined;
        this.stage = this.entryCount === this.expected.entryCount ? "trailer" : "entry";
        continue;
      }
      if (this.stage === "done") {
        fail("private-capture archive contains trailing data");
      }
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      this.lineBytes += part.length;
      if (this.lineBytes > MAX_LINE_BYTES) fail("private-capture archive line exceeds its bound");
      if (part.length > 0) this.lineParts.push(part);
      offset = end;
      if (newline < 0) continue;
      offset += 1;
      const line = Buffer.concat(this.lineParts, this.lineBytes);
      this.lineParts = [];
      this.lineBytes = 0;
      this.consumeLine(line);
    }
  }

  consumeLine(line) {
    if (this.stage === "magic") {
      if (`${line.toString("utf8")}\n` !== ARCHIVE_MAGIC) {
        fail("private-capture archive magic is invalid");
      }
      this.stage = "header";
      return;
    }
    if (this.stage === "header") {
      const header = parseJsonLine(line, "header");
      const keys = [
        "contractVersion",
        "databaseLedgerSha256",
        "databaseReferencedEntryCount",
        "entryCount",
        "format",
        "inventorySha256",
        "plaintextBytes",
      ];
      if (
        !exactJsonKeys(header, keys)
        || header.contractVersion !== 1
        || header.format !== ARCHIVE_FORMAT
        || header.entryCount !== this.expected.entryCount
        || header.plaintextBytes !== this.expected.plaintextBytes
        || header.inventorySha256 !== this.expected.inventorySha256
        || header.databaseLedgerSha256 !== this.expected.databaseLedgerSha256
        || header.databaseReferencedEntryCount !== this.expected.databaseReferencedEntryCount
      ) {
        fail("private-capture archive header does not match its manifest");
      }
      this.stage = this.expected.entryCount === 0 ? "trailer" : "entry";
      return;
    }
    if (this.stage === "entry") {
      const entry = parseJsonLine(line, "entry header");
      if (
        !exactJsonKeys(entry, [
          "blobKey",
          "byteLength",
          "checksumSha256",
          "databaseReferenced",
        ])
        || !BLOB_KEY_PATTERN.test(entry.blobKey ?? "")
        || entry.blobKey.split("/").at(-1) !== entry.checksumSha256
        || !Number.isSafeInteger(entry.byteLength)
        || entry.byteLength < 1
        || entry.byteLength > MAX_PRIVATE_CAPTURE_BLOB_BYTES
        || typeof entry.databaseReferenced !== "boolean"
        || (this.previousBlobKey !== undefined && entry.blobKey <= this.previousBlobKey)
      ) {
        fail("private-capture archive entry header is invalid or unordered");
      }
      this.previousBlobKey = entry.blobKey;
      this.inventoryDigest.update(inventoryLine(entry));
      if (entry.databaseReferenced) {
        this.databaseDigest.update(databaseLedgerLine(entry));
        this.databaseReferencedEntryCount += 1;
      }
      this.currentEntry = entry;
      this.bodyRemaining = entry.byteLength;
      this.bodyDigest = createHash("sha256");
      this.stage = "body";
      return;
    }
    if (this.stage === "trailer") {
      const trailer = parseJsonLine(line, "trailer");
      if (
        !exactJsonKeys(trailer, [
          "databaseLedgerSha256",
          "databaseReferencedEntryCount",
          "entryCount",
          "inventorySha256",
          "plaintextBytes",
          "status",
        ])
        || trailer.status !== "complete"
        || trailer.entryCount !== this.entryCount
        || trailer.plaintextBytes !== this.plaintextBytes
        || trailer.inventorySha256 !== this.expected.inventorySha256
        || trailer.databaseLedgerSha256 !== this.expected.databaseLedgerSha256
        || trailer.databaseReferencedEntryCount !== this.expected.databaseReferencedEntryCount
      ) {
        fail("private-capture archive trailer is invalid");
      }
      this.stage = "done";
      return;
    }
    fail("private-capture archive has an invalid parser state");
  }

  finish() {
    if (
      this.stage !== "done"
      || this.lineBytes !== 0
      || this.entryCount !== this.expected.entryCount
      || this.plaintextBytes !== this.expected.plaintextBytes
      || this.inventoryDigest.digest("hex") !== this.expected.inventorySha256
      || this.databaseDigest.digest("hex") !== this.expected.databaseLedgerSha256
      || this.databaseReferencedEntryCount !== this.expected.databaseReferencedEntryCount
    ) {
      fail("private-capture decrypted archive is incomplete or inconsistent");
    }
    return {
      databaseLedgerSha256: this.expected.databaseLedgerSha256,
      databaseReferencedEntryCount: this.databaseReferencedEntryCount,
      entryCount: this.entryCount,
      inventorySha256: this.expected.inventorySha256,
      plaintextBytes: this.plaintextBytes,
    };
  }
}

export async function runPrivateCaptureArchiveVerification({
  ageBinary,
  ageIdentityFile,
  commandTimeoutMs,
  encryptedFile,
  expected,
}) {
  const child = spawn(ageBinary, [
    "--decrypt",
    "--identity",
    ageIdentityFile,
    encryptedFile,
  ], {
    detached: process.platform !== "win32",
    env: safeProcessEnvironment(),
    stdio: ["ignore", "pipe", "ignore"],
  });
  const controller = controllerFor(child);
  const completion = childCompletion(child, controller.stop);
  const parser = new PrivateCaptureArchiveParser(expected);
  const parsing = (async () => {
    for await (const chunk of child.stdout) parser.consume(chunk);
    return parser.finish();
  })().catch((error) => {
    controller.stop();
    throw error;
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.stop();
  }, commandTimeoutMs);
  timeout.unref();
  try {
    const [completionResult, parsingResult] = await Promise.allSettled([completion, parsing]);
    if (timedOut) fail("private-capture decryption exceeded its timeout");
    if (parsingResult.status === "rejected") {
      if (parsingResult.reason instanceof PrivateCaptureArchiveError) throw parsingResult.reason;
      fail("private-capture decrypted stream could not be validated");
    }
    if (completionResult.status !== "fulfilled" || !completionResult.value) {
      fail("private-capture authenticated decryption failed");
    }
    return parsingResult.value;
  } finally {
    clearTimeout(timeout);
    controller.stop();
    await Promise.allSettled([completion, parsing]);
    if (processTreeExists(child)) await controller.finishKill();
    controller.clear();
  }
}

export const privateCaptureArchiveContract = Object.freeze({
  format: ARCHIVE_FORMAT,
  layout: "official-offers/private/v1/<source-sha256>/<publication-id>/<content-sha256>",
  maxBlobBytes: MAX_PRIVATE_CAPTURE_BLOB_BYTES,
});
