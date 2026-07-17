import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, relative } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { PrivateReviewCaptureLocator } from "@handleplan/db/review-queue";

import {
  FilesystemPrivateReviewEvidenceReader,
  PrivateReviewEvidenceReaderError,
} from "./review-evidence-reader";

const roots = new Set<string>();
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ...new TextEncoder().encode("rights-cleared synthetic image fixture"),
]);

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "handleplan-review-reader-"));
  roots.add(root);
  await chmod(root, 0o700);
  return root;
}

function locator(bytes = PNG): PrivateReviewCaptureLocator {
  const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    blobKey: `official-offers/private/v1/${"a".repeat(64)}/42/${checksumSha256}`,
    byteLength: bytes.byteLength,
    candidateId: "review-candidate:42",
    candidateVersion: 0,
    checksumSha256,
    cropReference: `review-crop:${"b".repeat(64)}`,
    evidenceLocator: "synthetic-full-capture-reference",
    mimeType: "image/png",
    rightsClassification: "private_review",
  };
}

async function writeCapture(
  root: string,
  capture: PrivateReviewCaptureLocator,
  bytes = PNG,
): Promise<string> {
  const segments = capture.blobKey.split("/");
  const directory = join(root, ...segments.slice(0, -1));
  await mkdir(directory, { mode: 0o700, recursive: true });
  for (let index = 1; index < segments.length; index += 1) {
    await chmod(join(root, ...segments.slice(0, index)), 0o700);
  }
  const path = join(root, ...segments);
  await writeFile(path, bytes, { mode: 0o400 });
  await chmod(path, 0o400);
  return path;
}

async function expectReaderError(
  promise: Promise<unknown>,
  code: PrivateReviewEvidenceReaderError["code"],
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    code,
    name: "PrivateReviewEvidenceReaderError",
  });
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all([...roots].map(async (root) => {
    await rm(root, { force: true, recursive: true });
    roots.delete(root);
  }));
});

describe("FilesystemPrivateReviewEvidenceReader", () => {
  it("requires Linux descriptor-relative traversal in production", async () => {
    const root = await temporaryRoot();
    vi.stubEnv("NODE_ENV", "production");
    const create = () => new FilesystemPrivateReviewEvidenceReader({ rootDirectory: root });

    if (process.platform === "linux") {
      expect(create).not.toThrow();
    } else {
      expect(create).toThrow(expect.objectContaining({
        code: "INVALID_CONFIGURATION",
        name: "PrivateReviewEvidenceReaderError",
      }));
    }
  });

  it("reads only a canonical owner-private content-addressed capture and verifies every byte", async () => {
    const root = await temporaryRoot();
    const capture = locator();
    await writeCapture(root, capture);

    const result = await new FilesystemPrivateReviewEvidenceReader({ rootDirectory: root })
      .read(capture, new AbortController().signal);

    expect(result).toEqual({
      byteLength: PNG.byteLength,
      bytes: PNG,
      checksumSha256: capture.checksumSha256,
      mimeType: "image/png",
    });
    expect(await readFile(join(root, ...capture.blobKey.split("/")))).toEqual(Buffer.from(PNG));
  });

  it("rejects a forged key, bad checksum, length, MIME, and extract-only rights before rendering", async () => {
    const root = await temporaryRoot();
    const reader = new FilesystemPrivateReviewEvidenceReader({ rootDirectory: root });
    const capture = locator();
    for (const forged of [
      { ...capture, blobKey: `../${capture.blobKey}` },
      { ...capture, checksumSha256: "f".repeat(64) },
      { ...capture, byteLength: capture.byteLength + 1 },
      { ...capture, mimeType: "text/html" },
      { ...capture, rightsClassification: "extract_only" },
    ] as PrivateReviewCaptureLocator[]) {
      await expectReaderError(
        reader.read(forged, new AbortController().signal),
        "EVIDENCE_UNAVAILABLE",
      );
    }
  });

  it("rejects checksum and declared-MIME mismatches in otherwise valid files", async () => {
    const root = await temporaryRoot();
    const capture = locator();
    const path = await writeCapture(root, capture);
    await chmod(path, 0o600);
    await writeFile(path, Uint8Array.from(PNG, (value, index) => index === 10 ? value ^ 0xff : value));
    await chmod(path, 0o400);
    const reader = new FilesystemPrivateReviewEvidenceReader({ rootDirectory: root });

    await expectReaderError(
      reader.read(capture, new AbortController().signal),
      "EVIDENCE_CORRUPT",
    );

    const pdfBytes = new TextEncoder().encode("not really a PDF");
    const pdfLocator = {
      ...locator(pdfBytes),
      mimeType: "application/pdf",
    } as PrivateReviewCaptureLocator;
    await writeCapture(root, pdfLocator, pdfBytes);
    await expectReaderError(
      reader.read(pdfLocator, new AbortController().signal),
      "EVIDENCE_CORRUPT",
    );
  });

  it("rejects symbolic-link and hard-link substitutions without following them", async () => {
    const root = await temporaryRoot();
    const capture = locator();
    const path = await writeCapture(root, capture);
    const replacement = join(root, "synthetic-replacement.png");
    await writeFile(replacement, PNG, { mode: 0o400 });
    await rm(path);
    await symlink(replacement, path);
    const reader = new FilesystemPrivateReviewEvidenceReader({ rootDirectory: root });
    await expectReaderError(
      reader.read(capture, new AbortController().signal),
      "UNSAFE_FILESYSTEM",
    );

    await rm(path);
    await link(replacement, path);
    await expectReaderError(
      reader.read(capture, new AbortController().signal),
      "UNSAFE_FILESYSTEM",
    );
  });

  it("rejects parent-directory substitution after the private directory chain is pinned", async () => {
    const root = await temporaryRoot();
    const capture = locator();
    const path = await writeCapture(root, capture);
    const keySegments = capture.blobKey.split("/");
    const parent = join(root, ...keySegments.slice(0, -1));
    const displacedParent = `${parent}-displaced`;
    const rootSegments = relative(parse(root).root, root).split(/[\\/]/u);
    const substitutionCheck = 1 + rootSegments.length + keySegments.length + 1;
    let cancellationChecks = 0;
    let substituted = false;
    const signal = {
      get aborted() {
        cancellationChecks += 1;
        if (cancellationChecks === substitutionCheck) {
          renameSync(parent, displacedParent);
          mkdirSync(parent, { mode: 0o700 });
          writeFileSync(path, PNG, { mode: 0o400 });
          chmodSync(parent, 0o700);
          chmodSync(path, 0o400);
          substituted = true;
        }
        return false;
      },
    } as AbortSignal;

    await expectReaderError(
      new FilesystemPrivateReviewEvidenceReader({ rootDirectory: root }).read(capture, signal),
      "UNSAFE_FILESYSTEM",
    );
    expect(substituted).toBe(true);
  });

  it("rejects unsafe modes, an over-limit locator, and cancellation", async () => {
    const root = await temporaryRoot();
    const capture = locator();
    const path = await writeCapture(root, capture);
    const reader = new FilesystemPrivateReviewEvidenceReader({
      maxBytes: PNG.byteLength,
      rootDirectory: root,
    });
    await chmod(path, 0o600);
    await expectReaderError(
      reader.read(capture, new AbortController().signal),
      "UNSAFE_FILESYSTEM",
    );
    await expectReaderError(
      reader.read({ ...capture, byteLength: capture.byteLength + 1 }, new AbortController().signal),
      "EVIDENCE_UNAVAILABLE",
    );
    const controller = new AbortController();
    controller.abort();
    await expectReaderError(reader.read(capture, controller.signal), "CANCELLED");
  });
});
