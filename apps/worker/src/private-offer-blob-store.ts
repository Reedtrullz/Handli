import { createHash, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import type {
  OfficialOfferPrivateBlobStore,
  OfficialOfferPrivateBlobWrite,
} from "./official-offer-foundation";

export const MAX_PRIVATE_OFFICIAL_OFFER_BLOB_BYTES = 50 * 1024 * 1024;

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o400;
const TEMP_FILE_MODE = 0o600;
const VERIFY_CHUNK_BYTES = 64 * 1024;
const WRITE_CHUNK_BYTES = 1024 * 1024;
const CONTENT_KEY_PATTERN =
  /^official-offers\/private\/v1\/([0-9a-f]{64})\/([1-9][0-9]{0,15})\/([0-9a-f]{64})$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ALLOWED_WRITE_KEYS = new Set([
  "blobKey",
  "byteLength",
  "bytes",
  "checksumSha256",
  "contractVersion",
  "mimeType",
  "rightsClassification",
]);

export type PrivateOfficialOfferBlobStoreErrorCode =
  | "BLOB_CONFLICT"
  | "CANCELLED"
  | "INVALID_CONFIGURATION"
  | "INVALID_WRITE"
  | "IO_FAILURE"
  | "UNSAFE_FILESYSTEM";

export class PrivateOfficialOfferBlobStoreError extends Error {
  constructor(readonly code: PrivateOfficialOfferBlobStoreErrorCode) {
    super(`Private official-offer blob store failed: ${code}`);
    this.name = "PrivateOfficialOfferBlobStoreError";
  }
}

export interface FilesystemOfficialOfferPrivateBlobStoreOptions {
  /** A canonical absolute path whose components must not be symbolic links. */
  rootDirectory: string;
  /** Per-blob limit. It may narrow, but never exceed, the 50 MiB contract ceiling. */
  maxBlobBytes?: number;
}

export interface PrivateOfficialOfferBlobWriteReceipt {
  readonly contractVersion: 1;
  readonly state: "already-present" | "stored";
  readonly checksumSha256: string;
  readonly byteLength: number;
}

interface ValidatedWrite {
  readonly blobKey: string;
  readonly byteLength: number;
  readonly bytes: Uint8Array;
  readonly checksumSha256: string;
  readonly keySegments: readonly [string, string, string, string, string, string];
}

function fail(code: PrivateOfficialOfferBlobStoreErrorCode): never {
  throw new PrivateOfficialOfferBlobStoreError(code);
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) fail("CANCELLED");
}

function fileMode(mode: number): number {
  return mode & 0o777;
}

function isPathInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function assertCurrentOwner(uid: number, ownerUid: number): void {
  if (uid !== ownerUid) fail("UNSAFE_FILESYSTEM");
}

function assertUnchangedStat(before: Stats, after: Stats): void {
  if (
    before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mode !== after.mode
    || before.nlink !== after.nlink
    || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs
  ) {
    fail("BLOB_CONFLICT");
  }
}

/**
 * Owner-private, content-addressed storage for official-offer captures.
 *
 * There is deliberately no mutation or deletion API. A completed temporary file
 * is published by hard-linking it in the same directory, giving create-if-absent
 * semantics without ever replacing an existing destination.
 */
export class FilesystemOfficialOfferPrivateBlobStore
implements OfficialOfferPrivateBlobStore {
  readonly rootDirectory: string;
  readonly maxBlobBytes: number;
  private readonly ownerUid: number;

  constructor(options: Readonly<FilesystemOfficialOfferPrivateBlobStoreOptions>) {
    const rootDirectory = options?.rootDirectory;
    if (
      typeof rootDirectory !== "string"
      || rootDirectory.length < 2
      || rootDirectory.includes("\0")
      || !isAbsolute(rootDirectory)
      || resolve(rootDirectory) !== rootDirectory
      || rootDirectory === parse(rootDirectory).root
    ) {
      fail("INVALID_CONFIGURATION");
    }
    const maxBlobBytes = options.maxBlobBytes ?? MAX_PRIVATE_OFFICIAL_OFFER_BLOB_BYTES;
    if (
      !Number.isSafeInteger(maxBlobBytes)
      || maxBlobBytes < 1
      || maxBlobBytes > MAX_PRIVATE_OFFICIAL_OFFER_BLOB_BYTES
    ) {
      fail("INVALID_CONFIGURATION");
    }
    if (typeof process.getuid !== "function") fail("INVALID_CONFIGURATION");

    this.rootDirectory = rootDirectory;
    this.maxBlobBytes = maxBlobBytes;
    this.ownerUid = process.getuid();
  }

  async putIfAbsent(
    input: Readonly<OfficialOfferPrivateBlobWrite>,
    signal: AbortSignal,
  ): Promise<PrivateOfficialOfferBlobWriteReceipt> {
    throwIfCancelled(signal);
    const write = this.validateWrite(input, signal);
    throwIfCancelled(signal);

    try {
      await this.ensureSafeRoot(signal);
      const destinationDirectory = await this.ensureKeyDirectories(write, signal);
      const destinationPath = join(destinationDirectory, write.checksumSha256);
      if (!isPathInside(this.rootDirectory, destinationPath)) fail("INVALID_WRITE");

      const existing = await this.verifyExisting(destinationPath, write, signal);
      if (existing !== undefined) return existing;

      return await this.publish(destinationDirectory, destinationPath, write, signal);
    } catch (error) {
      if (error instanceof PrivateOfficialOfferBlobStoreError) throw error;
      if (["ELOOP", "ENOTDIR"].includes(errorCode(error) ?? "")) {
        fail("UNSAFE_FILESYSTEM");
      }
      fail("IO_FAILURE");
    }
  }

  private validateWrite(
    input: Readonly<OfficialOfferPrivateBlobWrite>,
    signal: AbortSignal,
  ): ValidatedWrite {
    if (
      input === null
      || typeof input !== "object"
      || Object.keys(input).some((key) => !ALLOWED_WRITE_KEYS.has(key))
      || input.contractVersion !== 1
      || !(input.bytes instanceof Uint8Array)
      || !Number.isSafeInteger(input.byteLength)
      || input.byteLength < 1
      || input.byteLength > this.maxBlobBytes
      || input.bytes.byteLength !== input.byteLength
      || typeof input.checksumSha256 !== "string"
      || !SHA256_PATTERN.test(input.checksumSha256)
      || typeof input.mimeType !== "string"
      || input.mimeType.length < 1
      || input.mimeType.length > 255
      || input.mimeType.trim() !== input.mimeType
      || !["extract_only", "private_review", "public_display"].includes(
        input.rightsClassification,
      )
      || typeof input.blobKey !== "string"
    ) {
      fail("INVALID_WRITE");
    }

    const keyMatch = CONTENT_KEY_PATTERN.exec(input.blobKey);
    if (keyMatch === null || keyMatch[3] !== input.checksumSha256) {
      fail("INVALID_WRITE");
    }
    const publicationId = Number(keyMatch[2]);
    if (!Number.isSafeInteger(publicationId) || publicationId < 1) fail("INVALID_WRITE");

    throwIfCancelled(signal);
    const bytes = Uint8Array.from(input.bytes);
    throwIfCancelled(signal);
    const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
    throwIfCancelled(signal);
    if (checksumSha256 !== input.checksumSha256 || bytes.byteLength !== input.byteLength) {
      fail("INVALID_WRITE");
    }

    return Object.freeze({
      blobKey: input.blobKey,
      byteLength: input.byteLength,
      bytes,
      checksumSha256,
      keySegments: Object.freeze([
        "official-offers",
        "private",
        "v1",
        keyMatch[1]!,
        keyMatch[2]!,
        keyMatch[3]!,
      ]) as ValidatedWrite["keySegments"],
    });
  }

  private async ensureSafeRoot(signal: AbortSignal): Promise<void> {
    throwIfCancelled(signal);
    const filesystemRoot = parse(this.rootDirectory).root;
    const segments = relative(filesystemRoot, this.rootDirectory).split(/[\\/]/u);
    let current = filesystemRoot;

    for (const [index, segment] of segments.entries()) {
      throwIfCancelled(signal);
      current = join(current, segment);
      let created = false;
      try {
        await lstat(current);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        try {
          await mkdir(current, { mode: DIRECTORY_MODE });
          created = true;
        } catch (mkdirError) {
          if (errorCode(mkdirError) !== "EEXIST") throw mkdirError;
        }
      }
      if (created) await chmod(current, DIRECTORY_MODE);

      const status = await lstat(current);
      if (status.isSymbolicLink() || !status.isDirectory()) fail("UNSAFE_FILESYSTEM");
      if (created || index === segments.length - 1) {
        assertCurrentOwner(status.uid, this.ownerUid);
        if (fileMode(status.mode) !== DIRECTORY_MODE) fail("UNSAFE_FILESYSTEM");
      }
    }

    if (await realpath(this.rootDirectory) !== this.rootDirectory) {
      fail("UNSAFE_FILESYSTEM");
    }
    throwIfCancelled(signal);
  }

  private async ensureKeyDirectories(
    write: ValidatedWrite,
    signal: AbortSignal,
  ): Promise<string> {
    let current = this.rootDirectory;
    for (const segment of write.keySegments.slice(0, -1)) {
      throwIfCancelled(signal);
      const next = join(current, segment);
      if (!isPathInside(this.rootDirectory, next)) fail("INVALID_WRITE");
      let created = false;
      try {
        await mkdir(next, { mode: DIRECTORY_MODE });
        created = true;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
      if (created) await chmod(next, DIRECTORY_MODE);
      const status = await lstat(next);
      if (status.isSymbolicLink() || !status.isDirectory()) fail("UNSAFE_FILESYSTEM");
      assertCurrentOwner(status.uid, this.ownerUid);
      if (fileMode(status.mode) !== DIRECTORY_MODE) fail("UNSAFE_FILESYSTEM");
      if (await realpath(next) !== next) fail("UNSAFE_FILESYSTEM");
      current = next;
    }
    throwIfCancelled(signal);
    return current;
  }

  private receipt(
    state: PrivateOfficialOfferBlobWriteReceipt["state"],
    write: ValidatedWrite,
  ): PrivateOfficialOfferBlobWriteReceipt {
    return Object.freeze({
      contractVersion: 1,
      state,
      checksumSha256: write.checksumSha256,
      byteLength: write.byteLength,
    });
  }

  private async verifyExisting(
    path: string,
    write: ValidatedWrite,
    signal: AbortSignal,
  ): Promise<PrivateOfficialOfferBlobWriteReceipt | undefined> {
    throwIfCancelled(signal);
    let pathStatus: Stats;
    try {
      pathStatus = await lstat(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
    if (pathStatus.isSymbolicLink() || !pathStatus.isFile()) fail("UNSAFE_FILESYSTEM");
    assertCurrentOwner(pathStatus.uid, this.ownerUid);
    if (fileMode(pathStatus.mode) !== FILE_MODE || pathStatus.nlink !== 1) {
      fail("UNSAFE_FILESYSTEM");
    }
    if (pathStatus.size !== write.byteLength || pathStatus.size > this.maxBlobBytes) {
      fail("BLOB_CONFLICT");
    }

    let handle: FileHandle | undefined;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await handle.stat();
      if (!before.isFile()) fail("UNSAFE_FILESYSTEM");
      assertCurrentOwner(before.uid, this.ownerUid);
      if (
        before.dev !== pathStatus.dev
        || before.ino !== pathStatus.ino
        || fileMode(before.mode) !== FILE_MODE
        || before.nlink !== 1
        || before.size !== write.byteLength
      ) {
        fail("BLOB_CONFLICT");
      }

      const digest = createHash("sha256");
      const buffer = Buffer.allocUnsafe(Math.min(VERIFY_CHUNK_BYTES, this.maxBlobBytes));
      let total = 0;
      for (;;) {
        throwIfCancelled(signal);
        const remainingWithSentinel = write.byteLength + 1 - total;
        if (remainingWithSentinel < 1) fail("BLOB_CONFLICT");
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.byteLength, remainingWithSentinel),
          null,
        );
        throwIfCancelled(signal);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > write.byteLength || total > this.maxBlobBytes) fail("BLOB_CONFLICT");
        digest.update(buffer.subarray(0, bytesRead));
      }
      const after = await handle.stat();
      assertUnchangedStat(before, after);
      if (total !== write.byteLength || digest.digest("hex") !== write.checksumSha256) {
        fail("BLOB_CONFLICT");
      }
    } finally {
      await handle?.close();
    }

    const afterPathStatus = await lstat(path);
    if (
      afterPathStatus.isSymbolicLink()
      || !afterPathStatus.isFile()
      || afterPathStatus.dev !== pathStatus.dev
      || afterPathStatus.ino !== pathStatus.ino
      || afterPathStatus.size !== pathStatus.size
      || afterPathStatus.mtimeMs !== pathStatus.mtimeMs
      || afterPathStatus.ctimeMs !== pathStatus.ctimeMs
      || fileMode(afterPathStatus.mode) !== FILE_MODE
      || afterPathStatus.nlink !== 1
    ) {
      fail("BLOB_CONFLICT");
    }
    await this.syncPrivateHierarchy(dirname(path), signal);
    throwIfCancelled(signal);
    return this.receipt("already-present", write);
  }

  private async publish(
    destinationDirectory: string,
    destinationPath: string,
    write: ValidatedWrite,
    signal: AbortSignal,
  ): Promise<PrivateOfficialOfferBlobWriteReceipt> {
    const temporaryPath = join(
      destinationDirectory,
      `.${write.checksumSha256}.tmp-${process.pid}-${randomBytes(16).toString("hex")}`,
    );
    let handle: FileHandle | undefined;
    let temporaryExists = false;
    let result: PrivateOfficialOfferBlobWriteReceipt | undefined;
    let operationError: unknown;

    try {
      throwIfCancelled(signal);
      handle = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        TEMP_FILE_MODE,
      );
      temporaryExists = true;
      const initialStatus = await handle.stat();
      if (!initialStatus.isFile() || initialStatus.size !== 0 || initialStatus.nlink !== 1) {
        fail("UNSAFE_FILESYSTEM");
      }
      assertCurrentOwner(initialStatus.uid, this.ownerUid);

      let offset = 0;
      while (offset < write.bytes.byteLength) {
        throwIfCancelled(signal);
        const length = Math.min(WRITE_CHUNK_BYTES, write.bytes.byteLength - offset);
        const { bytesWritten } = await handle.write(write.bytes, offset, length, offset);
        if (bytesWritten < 1 || bytesWritten > length) fail("IO_FAILURE");
        offset += bytesWritten;
      }
      throwIfCancelled(signal);
      await handle.sync();
      throwIfCancelled(signal);
      await handle.chmod(FILE_MODE);
      await handle.sync();
      throwIfCancelled(signal);
      const completedStatus = await handle.stat();
      if (
        !completedStatus.isFile()
        || completedStatus.size !== write.byteLength
        || completedStatus.nlink !== 1
        || fileMode(completedStatus.mode) !== FILE_MODE
      ) {
        fail("IO_FAILURE");
      }
      assertCurrentOwner(completedStatus.uid, this.ownerUid);
      await handle.close();
      handle = undefined;

      await this.ensureSafeRoot(signal);
      await this.assertPrivateDirectoryChain(destinationDirectory, signal);
      try {
        await link(temporaryPath, destinationPath);
        await unlink(temporaryPath);
        temporaryExists = false;
        await this.syncPrivateHierarchy(destinationDirectory, undefined);
        throwIfCancelled(signal);
        const stored = await this.verifyExisting(destinationPath, write, signal);
        if (stored === undefined) fail("IO_FAILURE");
        result = this.receipt("stored", write);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        result = await this.verifyCompetingPublish(destinationPath, write, signal);
        if (result === undefined) fail("IO_FAILURE");
      }
    } catch (error) {
      operationError = error;
    } finally {
      try {
        await handle?.close();
      } catch (closeError) {
        operationError ??= closeError;
      }
      if (temporaryExists) {
        let removed = false;
        try {
          await unlink(temporaryPath);
          temporaryExists = false;
          removed = true;
        } catch (cleanupError) {
          if (errorCode(cleanupError) === "ENOENT") {
            temporaryExists = false;
            removed = true;
          } else {
            operationError = cleanupError;
          }
        }
        if (removed) {
          try {
            await this.syncDirectory(destinationDirectory, undefined, true);
          } catch (syncError) {
            operationError = syncError;
          }
        }
      }
    }

    if (operationError !== undefined) throw operationError;
    if (result === undefined) fail("IO_FAILURE");
    return result;
  }

  private async verifyCompetingPublish(
    destinationPath: string,
    write: ValidatedWrite,
    signal: AbortSignal,
  ): Promise<PrivateOfficialOfferBlobWriteReceipt | undefined> {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      try {
        return await this.verifyExisting(destinationPath, write, signal);
      } catch (error) {
        if (!(error instanceof PrivateOfficialOfferBlobStoreError)
          || error.code !== "UNSAFE_FILESYSTEM") throw error;
        const status = await lstat(destinationPath);
        if (
          !status.isFile()
          || status.isSymbolicLink()
          || status.uid !== this.ownerUid
          || fileMode(status.mode) !== FILE_MODE
          || status.size !== write.byteLength
        ) {
          throw error;
        }
        // The competing writer can remove its temporary link between the
        // failed verification and this lstat. Re-enter full verification when
        // that publication has already reached the stable one-link state.
        if (status.nlink === 1) continue;
        if (status.nlink !== 2) throw error;
        // A competing hard-link publisher briefly has the final name and its
        // private temporary name. Yield only a bounded number of turns for it
        // to remove that temporary link; a persistent second link fails closed.
        await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
        throwIfCancelled(signal);
      }
    }
    fail("UNSAFE_FILESYSTEM");
  }

  private async syncPrivateHierarchy(
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const child = relative(this.rootDirectory, path);
    if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
      fail("UNSAFE_FILESYSTEM");
    }
    const directories = [this.rootDirectory];
    let current = this.rootDirectory;
    if (child !== "") {
      for (const segment of child.split(/[\\/]/u)) {
        current = join(current, segment);
        directories.push(current);
      }
    }
    for (const directory of directories.reverse()) {
      await this.syncDirectory(directory, signal, true);
    }
    await this.syncDirectory(dirname(this.rootDirectory), signal, false);
  }

  private async syncDirectory(
    path: string,
    signal: AbortSignal | undefined,
    requirePrivate: boolean,
  ): Promise<void> {
    if (signal !== undefined) throwIfCancelled(signal);
    let handle: FileHandle | undefined;
    let handleStatus: Stats;
    try {
      handle = await open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      handleStatus = await handle.stat();
      if (!handleStatus.isDirectory()) fail("UNSAFE_FILESYSTEM");
      if (requirePrivate) {
        assertCurrentOwner(handleStatus.uid, this.ownerUid);
        if (fileMode(handleStatus.mode) !== DIRECTORY_MODE) fail("UNSAFE_FILESYSTEM");
      }
      await handle.sync();
    } finally {
      await handle?.close();
    }
    const pathStatus = await lstat(path);
    if (
      pathStatus.isSymbolicLink()
      || !pathStatus.isDirectory()
      || pathStatus.dev !== handleStatus.dev
      || pathStatus.ino !== handleStatus.ino
      || (requirePrivate && pathStatus.uid !== this.ownerUid)
      || (requirePrivate && fileMode(pathStatus.mode) !== DIRECTORY_MODE)
    ) {
      fail("UNSAFE_FILESYSTEM");
    }
    if (signal !== undefined) throwIfCancelled(signal);
  }

  private async assertPrivateDirectoryChain(
    destinationDirectory: string,
    signal: AbortSignal,
  ): Promise<void> {
    const child = relative(this.rootDirectory, destinationDirectory);
    if (child === "" || child.startsWith("..") || isAbsolute(child)) fail("UNSAFE_FILESYSTEM");
    let current = this.rootDirectory;
    for (const segment of child.split(/[\\/]/u)) {
      throwIfCancelled(signal);
      current = join(current, segment);
      const status = await lstat(current);
      if (status.isSymbolicLink() || !status.isDirectory()) fail("UNSAFE_FILESYSTEM");
      assertCurrentOwner(status.uid, this.ownerUid);
      if (fileMode(status.mode) !== DIRECTORY_MODE) fail("UNSAFE_FILESYSTEM");
      if (await realpath(current) !== current) fail("UNSAFE_FILESYSTEM");
    }
  }
}
