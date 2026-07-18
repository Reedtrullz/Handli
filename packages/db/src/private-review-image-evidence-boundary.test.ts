import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const migrationsDirectory = path.join(repositoryRoot, "deploy", "migrations");
const historicalRendererPath = path.join(
  migrationsDirectory,
  "025_private_review_evidence_renderer.sql",
);
const imageBoundaryPath = path.join(
  migrationsDirectory,
  "028_private_review_image_evidence_only.sql",
);

describe("private review image-only evidence boundary", () => {
  it("is a forward-only migration that refuses to reinterpret historical PDF receipts", async () => {
    const [files, historicalRenderer, imageBoundary] = await Promise.all([
      readdir(migrationsDirectory),
      readFile(historicalRendererPath, "utf8"),
      readFile(imageBoundaryPath, "utf8"),
    ]);

    expect(files.filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/u.test(file)).sort().at(-1))
      .toBe("028_private_review_image_evidence_only.sql");
    expect(historicalRenderer).toContain(
      "mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')",
    );
    expect(imageBoundary).toContain(
      "lock table public.private_review_evidence_renders in access exclusive mode",
    );
    expect(imageBoundary).toMatch(
      /from public\.private_review_evidence_renders evidence\s+where evidence\.mime_type = 'application\/pdf'/iu,
    );
    expect(imageBoundary).toContain(
      "pre-existing PDF evidence renders require reviewed reconciliation",
    );
    expect(imageBoundary.indexOf("pre-existing PDF evidence renders"))
      .toBeLessThan(imageBoundary.indexOf("drop constraint private_review_evidence_renders_mime"));
    expect(imageBoundary).not.toMatch(/\b(?:update|delete from)\s+public\.private_review_evidence_renders\b/iu);
  });

  it("allows only JPEG, PNG and WebP at both the table and recorder boundaries", async () => {
    const imageBoundary = await readFile(imageBoundaryPath, "utf8");
    const recorder = imageBoundary.slice(
      imageBoundary.indexOf("do $private_review_record_image_evidence_only$"),
      imageBoundary.indexOf("do $private_review_decide_image_evidence_only$"),
    );

    expect(imageBoundary).toContain(
      "constraint private_review_evidence_renders_image_mime",
    );
    expect(imageBoundary).toContain(
      "check (mime_type in ('image/jpeg', 'image/png', 'image/webp'))",
    );
    expect(recorder).toContain("private_review_record_evidence_render_v1 MIME boundary drifted");
    expect(recorder).toContain("v_candidate.mime_type is null");
    expect(recorder).toContain("'image/jpeg', 'image/png', 'image/webp'");
    expect(recorder).toContain("create or replace function public.private_review_record_evidence_render_v1(");
    expect(recorder.match(/'application\/pdf'/gu)).toHaveLength(1);
  });

  it("independently refuses any non-image receipt in the v2 decision transaction", async () => {
    const imageBoundary = await readFile(imageBoundaryPath, "utf8");
    const decision = imageBoundary.slice(
      imageBoundary.indexOf("do $private_review_decide_image_evidence_only$"),
    );

    expect(decision).toContain("private_review_decide_v2 MIME boundary drifted");
    expect(decision).toContain(
      "v_render.mime_type not in ('image/jpeg', 'image/png', 'image/webp')",
    );
    expect(decision).toContain("v_render.mime_type is null");
    expect(decision).toContain("create or replace function public.private_review_decide_v2(");
    expect(decision).toContain(
      "revoke all on function public.private_review_decide_v2(",
    );
    expect(decision).not.toMatch(/\b(?:update|delete from)\s+public\.private_review_evidence/iu);
  });
});
