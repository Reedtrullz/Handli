import "server-only";

import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import type { PrivateReviewCaptureLocator } from "@handleplan/db/review-queue";

export const MAX_PRIVATE_REVIEW_EVIDENCE_BYTES = 50 * 1024 * 1024;

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o400;
const READ_CHUNK_BYTES = 64 * 1024;
const CONTENT_KEY_PATTERN =
  /^official-offers\/private\/v1\/([0-9a-f]{64})\/([1-9][0-9]{0,15})\/([0-9a-f]{64})$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export type PrivateReviewEvidenceReaderErrorCode =
  | "CANCELLED"
  | "EVIDENCE_CORRUPT"
  | "EVIDENCE_UNAVAILABLE"
  | "INVALID_CONFIGURATION"
  | "UNSAFE_FILESYSTEM";

export class PrivateReviewEvidenceReaderError extends Error {
  constructor(readonly code: PrivateReviewEvidenceReaderErrorCode) {
    super(`Private review evidence reader failed: ${code}`);
    this.name = "PrivateReviewEvidenceReaderError";
  }
}

export interface VerifiedPrivateReviewEvidence {
  readonly byteLength: number;
  readonly bytes: Uint8Array;
  readonly checksumSha256: string;
  readonly mimeType: "application/pdf" | "image/jpeg" | "image/png" | "image/webp";
}

export interface PrivateReviewEvidenceReader {
  read(
    locator: Readonly<PrivateReviewCaptureLocator>,
    signal: AbortSignal,
  ): Promise<VerifiedPrivateReviewEvidence>;
}

function fail(code: PrivateReviewEvidenceReaderErrorCode): never {
  throw new PrivateReviewEvidenceReaderError(code);
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

function inside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function assertOwner(status: Stats, ownerUid: number): void {
  if (status.uid !== ownerUid) fail("UNSAFE_FILESYSTEM");
}

function assertStable(
  before: Stats,
  after: Stats,
  code: PrivateReviewEvidenceReaderErrorCode = "EVIDENCE_CORRUPT",
): void {
  if (
    before.dev !== after.dev
    || before.ino !== after.ino
    || before.uid !== after.uid
    || before.gid !== after.gid
    || before.size !== after.size
    || before.mode !== after.mode
    || before.nlink !== after.nlink
    || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs
  ) {
    fail(code);
  }
}

interface PinnedDirectory {
  readonly handle: FileHandle;
  readonly path: string;
  readonly status: Stats;
}

function hasExpectedMagic(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === "application/pdf") {
    return bytes.byteLength >= 5
      && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44
      && bytes[3] === 0x46 && bytes[4] === 0x2d;
  }
  if (mimeType === "image/jpeg") {
    return bytes.byteLength >= 3
      && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === "image/png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return bytes.byteLength >= signature.length
      && signature.every((value, index) => bytes[index] === value);
  }
  if (mimeType === "image/webp") {
    return bytes.byteLength >= 12
      && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF"
      && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP";
  }
  return false;
}

function validateLocator(
  locator: Readonly<PrivateReviewCaptureLocator>,
  maximumBytes: number,
): readonly string[] {
  const match = typeof locator.blobKey === "string"
    ? CONTENT_KEY_PATTERN.exec(locator.blobKey)
    : null;
  if (
    match === null
    || match[3] !== locator.checksumSha256
    || !SHA256_PATTERN.test(locator.checksumSha256)
    || !Number.isSafeInteger(locator.byteLength)
    || locator.byteLength < 1
    || locator.byteLength > maximumBytes
    || !ALLOWED_MIME_TYPES.has(locator.mimeType)
    || !["private_review", "public_display"].includes(locator.rightsClassification)
  ) {
    fail("EVIDENCE_UNAVAILABLE");
  }
  return Object.freeze(locator.blobKey.split("/"));
}

export class FilesystemPrivateReviewEvidenceReader implements PrivateReviewEvidenceReader {
  readonly rootDirectory: string;
  readonly maxBytes: number;
  private readonly ownerUid: number;

  constructor(options: { rootDirectory: string; maxBytes?: number }) {
    if (
      options === null
      || typeof options.rootDirectory !== "string"
      || options.rootDirectory.length < 2
      || options.rootDirectory.includes("\0")
      || !isAbsolute(options.rootDirectory)
      || resolve(options.rootDirectory) !== options.rootDirectory
      || options.rootDirectory === parse(options.rootDirectory).root
    ) {
      fail("INVALID_CONFIGURATION");
    }
    const maxBytes = options.maxBytes ?? MAX_PRIVATE_REVIEW_EVIDENCE_BYTES;
    if (
      !Number.isSafeInteger(maxBytes)
      || maxBytes < 1
      || maxBytes > MAX_PRIVATE_REVIEW_EVIDENCE_BYTES
      || typeof process.getuid !== "function"
      || (process.env.NODE_ENV === "production" && process.platform !== "linux")
    ) {
      fail("INVALID_CONFIGURATION");
    }
    this.rootDirectory = options.rootDirectory;
    this.maxBytes = maxBytes;
    this.ownerUid = process.getuid();
  }

  async read(
    locator: Readonly<PrivateReviewCaptureLocator>,
    signal: AbortSignal,
  ): Promise<VerifiedPrivateReviewEvidence> {
    throwIfCancelled(signal);
    const keySegments = validateLocator(locator, this.maxBytes);
    let directoryChain: readonly PinnedDirectory[] = [];
    try {
      directoryChain = await this.pinCanonicalTree(keySegments.slice(0, -1), signal);
      const path = join(this.rootDirectory, ...keySegments);
      if (!inside(this.rootDirectory, path)) fail("UNSAFE_FILESYSTEM");
      throwIfCancelled(signal);
      const result = await this.readVerified(
        path,
        keySegments.at(-1) ?? fail("UNSAFE_FILESYSTEM"),
        directoryChain.at(-1) ?? fail("UNSAFE_FILESYSTEM"),
        locator,
        signal,
      );
      await this.assertPinnedTreeStable(directoryChain, signal);
      return result;
    } catch (error) {
      if (error instanceof PrivateReviewEvidenceReaderError) throw error;
      if (["EACCES", "ENOENT"].includes(errorCode(error) ?? "")) {
        fail("EVIDENCE_UNAVAILABLE");
      }
      if (["ELOOP", "ENOTDIR"].includes(errorCode(error) ?? "")) {
        fail("UNSAFE_FILESYSTEM");
      }
      fail("EVIDENCE_CORRUPT");
    } finally {
      await this.closePinnedTree(directoryChain);
    }
  }

  private async assertCanonicalRootAncestors(signal: AbortSignal): Promise<void> {
    const filesystemRoot = parse(this.rootDirectory).root;
    const rootSegments = relative(filesystemRoot, this.rootDirectory).split(/[\\/]/u);
    let current = filesystemRoot;
    for (const segment of rootSegments) {
      throwIfCancelled(signal);
      current = join(current, segment);
      const status = await lstat(current);
      if (status.isSymbolicLink() || !status.isDirectory()) fail("UNSAFE_FILESYSTEM");
    }
  }

  private async pinCanonicalTree(
    keyDirectories: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly PinnedDirectory[]> {
    await this.assertCanonicalRootAncestors(signal);
    const chain: PinnedDirectory[] = [];
    const directories = [undefined, ...keyDirectories] as const;
    let current = this.rootDirectory;
    try {
      for (const segment of directories) {
        throwIfCancelled(signal);
        const parent = chain.at(-1);
        if (segment !== undefined) current = join(current, segment);
        if (current !== this.rootDirectory && !inside(this.rootDirectory, current)) {
          fail("UNSAFE_FILESYSTEM");
        }
        const status = await lstat(current);
        if (status.isSymbolicLink() || !status.isDirectory()) fail("UNSAFE_FILESYSTEM");
        assertOwner(status, this.ownerUid);
        if (fileMode(status.mode) !== DIRECTORY_MODE) fail("UNSAFE_FILESYSTEM");
        if (await realpath(current) !== current) fail("UNSAFE_FILESYSTEM");

        // Node does not expose openat(2). On production Linux, traversing the
        // procfs descriptor pins this lookup to the already-validated parent
        // inode instead of resolving the mutable absolute parent path again.
        // Other platforms retain the absolute lookup, guarded by the exact
        // pre/post inode-and-metadata snapshots below.
        const openPath = parent !== undefined && process.platform === "linux"
          ? this.pinnedChildPath(parent.handle, segment ?? fail("UNSAFE_FILESYSTEM"))
          : current;
        let handle: FileHandle | undefined;
        try {
          handle = await open(
            openPath,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          const handleStatus = await handle.stat();
          if (!handleStatus.isDirectory()) fail("UNSAFE_FILESYSTEM");
          assertOwner(handleStatus, this.ownerUid);
          if (fileMode(handleStatus.mode) !== DIRECTORY_MODE) fail("UNSAFE_FILESYSTEM");
          assertStable(status, handleStatus, "UNSAFE_FILESYSTEM");
          chain.push(Object.freeze({ handle, path: current, status }));
          handle = undefined;
        } finally {
          await handle?.close().catch(() => undefined);
        }
      }
      return Object.freeze(chain);
    } catch (error) {
      await this.closePinnedTree(chain);
      throw error;
    }
  }

  private pinnedChildPath(parent: FileHandle, segment: string): string {
    if (
      segment.length < 1
      || segment.includes("\0")
      || segment.includes("/")
      || segment.includes("\\")
      || segment === "."
      || segment === ".."
    ) {
      fail("UNSAFE_FILESYSTEM");
    }
    return `/proc/self/fd/${parent.fd}/${segment}`;
  }

  private async assertPinnedTreeStable(
    chain: readonly PinnedDirectory[],
    signal: AbortSignal,
  ): Promise<void> {
    for (const directory of chain) {
      throwIfCancelled(signal);
      const handleStatus = await directory.handle.stat();
      if (!handleStatus.isDirectory()) fail("UNSAFE_FILESYSTEM");
      assertOwner(handleStatus, this.ownerUid);
      if (fileMode(handleStatus.mode) !== DIRECTORY_MODE) fail("UNSAFE_FILESYSTEM");
      assertStable(directory.status, handleStatus, "UNSAFE_FILESYSTEM");

      const pathStatus = await lstat(directory.path);
      if (pathStatus.isSymbolicLink() || !pathStatus.isDirectory()) fail("UNSAFE_FILESYSTEM");
      assertOwner(pathStatus, this.ownerUid);
      if (fileMode(pathStatus.mode) !== DIRECTORY_MODE) fail("UNSAFE_FILESYSTEM");
      assertStable(directory.status, pathStatus, "UNSAFE_FILESYSTEM");
      if (await realpath(directory.path) !== directory.path) fail("UNSAFE_FILESYSTEM");
    }
  }

  private async closePinnedTree(chain: readonly PinnedDirectory[]): Promise<void> {
    for (const directory of [...chain].reverse()) {
      await directory.handle.close().catch(() => undefined);
    }
  }

  private async readVerified(
    path: string,
    fileName: string,
    parentDirectory: PinnedDirectory,
    locator: Readonly<PrivateReviewCaptureLocator>,
    signal: AbortSignal,
  ): Promise<VerifiedPrivateReviewEvidence> {
    const pathStatus = await lstat(path);
    if (pathStatus.isSymbolicLink() || !pathStatus.isFile()) fail("UNSAFE_FILESYSTEM");
    assertOwner(pathStatus, this.ownerUid);
    if (
      fileMode(pathStatus.mode) !== FILE_MODE
      || pathStatus.nlink !== 1
      || pathStatus.size !== locator.byteLength
      || pathStatus.size > this.maxBytes
    ) {
      fail("UNSAFE_FILESYSTEM");
    }

    let handle: FileHandle | undefined;
    try {
      // Keep the final lookup relative to the pinned leaf directory on Linux;
      // the non-Linux path is covered by the same pre/post tree snapshots.
      const openPath = process.platform === "linux"
        ? this.pinnedChildPath(parentDirectory.handle, fileName)
        : path;
      handle = await open(openPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await handle.stat();
      if (!before.isFile()) fail("UNSAFE_FILESYSTEM");
      assertOwner(before, this.ownerUid);
      if (
        before.dev !== pathStatus.dev
        || before.ino !== pathStatus.ino
        || fileMode(before.mode) !== FILE_MODE
        || before.nlink !== 1
        || before.size !== locator.byteLength
      ) {
        fail("UNSAFE_FILESYSTEM");
      }

      const bytes = new Uint8Array(locator.byteLength);
      const digest = createHash("sha256");
      let offset = 0;
      while (offset < bytes.byteLength) {
        throwIfCancelled(signal);
        const length = Math.min(READ_CHUNK_BYTES, bytes.byteLength - offset);
        const result = await handle.read(bytes, offset, length, offset);
        if (result.bytesRead < 1) fail("EVIDENCE_CORRUPT");
        digest.update(bytes.subarray(offset, offset + result.bytesRead));
        offset += result.bytesRead;
      }
      const endProbe = new Uint8Array(1);
      if ((await handle.read(endProbe, 0, 1, offset)).bytesRead !== 0) {
        fail("EVIDENCE_CORRUPT");
      }
      throwIfCancelled(signal);
      const after = await handle.stat();
      assertStable(before, after);
      const latestPathStatus = await lstat(path);
      assertStable(pathStatus, latestPathStatus);
      if (
        digest.digest("hex") !== locator.checksumSha256
        || !hasExpectedMagic(bytes, locator.mimeType)
      ) {
        fail("EVIDENCE_CORRUPT");
      }
      return Object.freeze({
        byteLength: bytes.byteLength,
        bytes,
        checksumSha256: locator.checksumSha256,
        mimeType: locator.mimeType as VerifiedPrivateReviewEvidence["mimeType"],
      });
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}
