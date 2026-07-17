import { createHash } from "node:crypto";
import { watch } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  FilesystemOfficialOfferPrivateBlobStore,
  MAX_PRIVATE_OFFICIAL_OFFER_BLOB_BYTES,
  PrivateOfficialOfferBlobStoreError,
} from "./private-offer-blob-store";
import type { OfficialOfferPrivateBlobWrite } from "./official-offer-foundation";

const SOURCE_NAMESPACE = "a".repeat(64);
const SECOND_SOURCE_NAMESPACE = "b".repeat(64);
const roots = new Set<string>();

function currentUid(): number {
  if (typeof process.getuid !== "function") throw new Error("POSIX owner checks are required");
  return process.getuid();
}

async function privateTemporaryRoot(prefix = "handleplan-private-blobs-"): Promise<string> {
  const physicalTemporaryDirectory = await realpath(tmpdir());
  const root = await mkdtemp(join(physicalTemporaryDirectory, prefix));
  roots.add(root);
  return root;
}

function blobWrite(
  bytesInput: Uint8Array | string,
  options: {
    blobKey?: string;
    byteLength?: number;
    checksumSha256?: string;
    publicationId?: number;
    sourceNamespace?: string;
  } = {},
): OfficialOfferPrivateBlobWrite {
  const bytes = typeof bytesInput === "string"
    ? new TextEncoder().encode(bytesInput)
    : bytesInput;
  const checksumSha256 = options.checksumSha256
    ?? createHash("sha256").update(bytes).digest("hex");
  const publicationId = options.publicationId ?? 42;
  const sourceNamespace = options.sourceNamespace ?? SOURCE_NAMESPACE;
  return {
    contractVersion: 1,
    blobKey: options.blobKey
      ?? `official-offers/private/v1/${sourceNamespace}/${publicationId}/${checksumSha256}`,
    byteLength: options.byteLength ?? bytes.byteLength,
    bytes,
    checksumSha256,
    mimeType: "application/pdf",
    rightsClassification: "private_review",
  };
}

function destination(root: string, write: OfficialOfferPrivateBlobWrite): string {
  return join(root, ...write.blobKey.split("/"));
}

async function expectStoreError(
  promise: Promise<unknown>,
  code: PrivateOfficialOfferBlobStoreError["code"],
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "PrivateOfficialOfferBlobStoreError",
    code,
  });
}

afterEach(async () => {
  await Promise.all([...roots].map(async (root) => {
    await rm(root, { force: true, recursive: true });
    roots.delete(root);
  }));
});

describe("FilesystemOfficialOfferPrivateBlobStore", () => {
  it("requires a canonical absolute private root and a configured bound within 50 MiB", async () => {
    expect(() => new FilesystemOfficialOfferPrivateBlobStore({
      rootDirectory: "relative/private-blobs",
    })).toThrow(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
    expect(() => new FilesystemOfficialOfferPrivateBlobStore({
      rootDirectory: "/tmp/../tmp/private-blobs",
    })).toThrow(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
    expect(() => new FilesystemOfficialOfferPrivateBlobStore({
      rootDirectory: "/",
    })).toThrow(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));

    const root = await privateTemporaryRoot();
    expect(() => new FilesystemOfficialOfferPrivateBlobStore({
      rootDirectory: root,
      maxBlobBytes: 0,
    })).toThrow(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
    expect(() => new FilesystemOfficialOfferPrivateBlobStore({
      rootDirectory: root,
      maxBlobBytes: MAX_PRIVATE_OFFICIAL_OFFER_BLOB_BYTES + 1,
    })).toThrow(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
  });

  it("creates owner-private directories and a content-addressed read-only blob", async () => {
    const parent = await privateTemporaryRoot();
    const root = join(parent, "new-store");
    const store = new FilesystemOfficialOfferPrivateBlobStore({ rootDirectory: root });
    const write = blobWrite("rights-cleared synthetic official offer");

    await expect(store.putIfAbsent(write, new AbortController().signal)).resolves.toEqual({
      contractVersion: 1,
      state: "stored",
      checksumSha256: write.checksumSha256,
      byteLength: write.byteLength,
    });

    const components = [
      root,
      join(root, "official-offers"),
      join(root, "official-offers/private"),
      join(root, "official-offers/private/v1"),
      join(root, `official-offers/private/v1/${SOURCE_NAMESPACE}`),
      join(root, `official-offers/private/v1/${SOURCE_NAMESPACE}/42`),
    ];
    for (const component of components) {
      const status = await lstat(component);
      expect(status.isDirectory()).toBe(true);
      expect(status.isSymbolicLink()).toBe(false);
      expect(status.mode & 0o777).toBe(0o700);
      expect(status.uid).toBe(currentUid());
    }

    const blobPath = destination(root, write);
    const blobStatus = await lstat(blobPath);
    expect(blobStatus.isFile()).toBe(true);
    expect(blobStatus.isSymbolicLink()).toBe(false);
    expect(blobStatus.mode & 0o777).toBe(0o400);
    expect(blobStatus.nlink).toBe(1);
    expect(blobStatus.uid).toBe(currentUid());
    expect(await readFile(blobPath)).toEqual(Buffer.from(write.bytes));
    expect((await readdir(join(root, `official-offers/private/v1/${SOURCE_NAMESPACE}/42`)))
      .some((name) => name.includes(".tmp-"))).toBe(false);
  });

  it("returns already-present only after bounded checksum verification and never rewrites it", async () => {
    const root = await privateTemporaryRoot();
    const store = new FilesystemOfficialOfferPrivateBlobStore({ rootDirectory: root });
    const write = blobWrite("same immutable bytes");
    await store.putIfAbsent(write, new AbortController().signal);
    const before = await lstat(destination(root, write));

    await expect(store.putIfAbsent(write, new AbortController().signal)).resolves.toEqual({
      contractVersion: 1,
      state: "already-present",
      checksumSha256: write.checksumSha256,
      byteLength: write.byteLength,
    });
    const after = await lstat(destination(root, write));
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ctimeMs).toBe(before.ctimeMs);
  });

  // Each writer deliberately fsyncs the blob and every private parent directory.
  // APFS can serialize those durability barriers under concurrent load, so this
  // test needs a ceiling above Vitest's generic five-second unit-test default.
  it("gives concurrent writers atomic create-if-absent semantics", async () => {
    const root = await privateTemporaryRoot();
    const storeA = new FilesystemOfficialOfferPrivateBlobStore({ rootDirectory: root });
    const storeB = new FilesystemOfficialOfferPrivateBlobStore({ rootDirectory: root });
    const write = blobWrite(new Uint8Array(2 * 1024 * 1024).fill(0x5a));

    const results = await Promise.all([
      storeA.putIfAbsent(write, new AbortController().signal),
      storeB.putIfAbsent(write, new AbortController().signal),
    ]);

    expect(results.map(({ state }) => state).sort()).toEqual(["already-present", "stored"]);
    expect(await readFile(destination(root, write))).toEqual(Buffer.from(write.bytes));
    expect((await readdir(join(root, `official-offers/private/v1/${SOURCE_NAMESPACE}/42`)))
      .some((name) => name.includes(".tmp-"))).toBe(false);
  }, 20_000);

  it("binds the key, configured length, checksum, and bytes before filesystem writes", async () => {
    const parent = await privateTemporaryRoot();
    const root = join(parent, "not-created");
    const store = new FilesystemOfficialOfferPrivateBlobStore({
      rootDirectory: root,
      maxBlobBytes: 4,
    });
    const valid = blobWrite("four");
    const cases: OfficialOfferPrivateBlobWrite[] = [
      blobWrite("five!"),
      { ...valid, byteLength: 3 },
      { ...valid, checksumSha256: "f".repeat(64) },
      {
        ...valid,
        blobKey: `official-offers/private/v1/${SOURCE_NAMESPACE}/42/${"f".repeat(64)}`,
      },
      { ...valid, blobKey: `../private/v1/${SOURCE_NAMESPACE}/42/${valid.checksumSha256}` },
      { ...valid, blobKey: `official-offers/private/v1/${SOURCE_NAMESPACE}/042/${valid.checksumSha256}` },
      { ...valid, blobKey: `official-offers/private/v1/${SOURCE_NAMESPACE}/42/${valid.checksumSha256}/extra` },
    ];

    for (const invalid of cases) {
      await expectStoreError(
        store.putIfAbsent(invalid, new AbortController().signal),
        "INVALID_WRITE",
      );
    }
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("detects a same-length conflicting blob and leaves those existing bytes untouched", async () => {
    const root = await privateTemporaryRoot();
    const store = new FilesystemOfficialOfferPrivateBlobStore({ rootDirectory: root });
    const write = blobWrite("first payload");
    await store.putIfAbsent(write, new AbortController().signal);
    const blobPath = destination(root, write);
    const conflicting = Buffer.from("other payload");
    expect(conflicting.byteLength).toBe(write.byteLength);
    await chmod(blobPath, 0o600);
    await writeFile(blobPath, conflicting);
    await chmod(blobPath, 0o400);

    await expectStoreError(
      store.putIfAbsent(write, new AbortController().signal),
      "BLOB_CONFLICT",
    );
    expect(await readFile(blobPath)).toEqual(conflicting);
    expect((await readdir(join(root, `official-offers/private/v1/${SOURCE_NAMESPACE}/42`)))
      .some((name) => name.includes(".tmp-"))).toBe(false);
  });

  it("fails closed rather than blessing an existing writable blob", async () => {
    const root = await privateTemporaryRoot();
    const store = new FilesystemOfficialOfferPrivateBlobStore({ rootDirectory: root });
    const write = blobWrite("immutable expectation");
    await store.putIfAbsent(write, new AbortController().signal);
    await chmod(destination(root, write), 0o600);

    await expectStoreError(
      store.putIfAbsent(write, new AbortController().signal),
      "UNSAFE_FILESYSTEM",
    );
  });

  it("rejects insecure roots and symbolic links in the root or key path", async () => {
    const insecureRoot = await privateTemporaryRoot();
    await chmod(insecureRoot, 0o755);
    await expectStoreError(
      new FilesystemOfficialOfferPrivateBlobStore({ rootDirectory: insecureRoot })
        .putIfAbsent(blobWrite("root mode"), new AbortController().signal),
      "UNSAFE_FILESYSTEM",
    );

    const parent = await privateTemporaryRoot();
    const physicalRoot = join(parent, "physical");
    const linkedRoot = join(parent, "linked");
    await mkdir(physicalRoot, { mode: 0o700 });
    await symlink(physicalRoot, linkedRoot, "dir");
    await expectStoreError(
      new FilesystemOfficialOfferPrivateBlobStore({ rootDirectory: linkedRoot })
        .putIfAbsent(blobWrite("linked root"), new AbortController().signal),
      "UNSAFE_FILESYSTEM",
    );

    const root = await privateTemporaryRoot();
    const keyBase = join(root, "official-offers/private/v1");
    const outside = await privateTemporaryRoot();
    await mkdir(keyBase, { mode: 0o700, recursive: true });
    for (const path of [
      join(root, "official-offers"),
      join(root, "official-offers/private"),
      keyBase,
    ]) await chmod(path, 0o700);
    await symlink(outside, join(keyBase, SECOND_SOURCE_NAMESPACE), "dir");
    await expectStoreError(
      new FilesystemOfficialOfferPrivateBlobStore({ rootDirectory: root }).putIfAbsent(
        blobWrite("linked key directory", { sourceNamespace: SECOND_SOURCE_NAMESPACE }),
        new AbortController().signal,
      ),
      "UNSAFE_FILESYSTEM",
    );
  });

  it("rejects a symbolic-link destination without reading or changing its target", async () => {
    const root = await privateTemporaryRoot();
    const store = new FilesystemOfficialOfferPrivateBlobStore({ rootDirectory: root });
    const write = blobWrite("destination symlink");
    await store.putIfAbsent(write, new AbortController().signal);
    const blobPath = destination(root, write);
    await rm(blobPath);
    const target = join(root, "target");
    await writeFile(target, "private target");
    await symlink(target, blobPath);

    await expectStoreError(
      store.putIfAbsent(write, new AbortController().signal),
      "UNSAFE_FILESYSTEM",
    );
    expect(await readFile(target, "utf8")).toBe("private target");
  });

  it("honors a pre-aborted request without creating the configured root", async () => {
    const parent = await privateTemporaryRoot();
    const root = join(parent, "must-not-exist");
    const store = new FilesystemOfficialOfferPrivateBlobStore({ rootDirectory: root });
    const controller = new AbortController();
    controller.abort("private reason must not escape");

    await expectStoreError(store.putIfAbsent(blobWrite("cancelled"), controller.signal), "CANCELLED");
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans a private temporary file when cancellation arrives during publication", async () => {
    const root = await privateTemporaryRoot();
    const store = new FilesystemOfficialOfferPrivateBlobStore({ rootDirectory: root });
    const primer = blobWrite("primer");
    await store.putIfAbsent(primer, new AbortController().signal);
    const destinationDirectory = join(
      root,
      `official-offers/private/v1/${SOURCE_NAMESPACE}/42`,
    );
    const bytes = new Uint8Array(32 * 1024 * 1024).fill(0x37);
    const write = blobWrite(bytes);
    const controller = new AbortController();
    const watcher = watch(destinationDirectory, (_event, filename) => {
      if (filename?.includes(".tmp-")) controller.abort("private reason must not escape");
    });

    try {
      await expectStoreError(store.putIfAbsent(write, controller.signal), "CANCELLED");
    } finally {
      watcher.close();
    }
    expect((await readdir(destinationDirectory)).some((name) => name.includes(".tmp-"))).toBe(false);
    await expect(lstat(destination(root, write))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("snapshots mutable caller bytes before the first asynchronous filesystem step", async () => {
    const root = await privateTemporaryRoot();
    const store = new FilesystemOfficialOfferPrivateBlobStore({ rootDirectory: root });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const write = blobWrite(bytes);
    const promise = store.putIfAbsent(write, new AbortController().signal);
    bytes.fill(9);

    await expect(promise).resolves.toMatchObject({ state: "stored" });
    expect(await readFile(destination(root, write))).toEqual(Buffer.from([1, 2, 3, 4]));
  });
});
