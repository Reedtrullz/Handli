import { describe, expect, it, vi } from "vitest";

import type { HandleplanDatabase } from "./client";
import {
  GeographicDirectoryReaderError,
  PostgresGeographicDirectoryReader,
} from "./geographic-directory";

const AT = new Date("2026-07-17T12:00:00.000Z");
type TestQuery = Promise<unknown[]> & { cancel: ReturnType<typeof vi.fn> };

function query(rows: unknown[]): TestQuery {
  const result = Promise.resolve(rows) as TestQuery;
  result.cancel = vi.fn();
  return result;
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    country_code: "NO",
    directory_created_at: "2026-07-16T12:30:00.000Z",
    directory_evidence_reference: "manifest:directory",
    directory_sealed_at: "2026-07-16T12:45:00.000Z",
    directory_status: "approved",
    postal_code: "0152",
    postal_count: 2,
    region_code: "no-0301-oslo",
    region_coverage_state: "complete",
    region_created_at: "2026-07-16T12:30:00.000Z",
    region_evidence_reference: "manifest:oslo",
    reviewed_at: "2026-07-16T12:00:00.000Z",
    valid_from: "2026-07-17T00:00:00.000Z",
    valid_until: null,
    version_id: "postal-directory-2026-07",
    ...overrides,
  };
}

function database(rows: unknown[]) {
  const captures: Array<{ parameters: unknown[]; sql: string }> = [];
  const client = (strings: TemplateStringsArray, ...parameters: unknown[]) => {
    captures.push({ parameters, sql: strings.join("?") });
    return query(rows);
  };
  return { captures, db: { $client: client } as unknown as HandleplanDatabase };
}

describe("PostgresGeographicDirectoryReader", () => {
  it("returns one canonical approved directory bound to the evaluation clock", async () => {
    const { captures, db } = database([
      row({ postal_code: "0452" }),
      row(),
    ]);

    await expect(new PostgresGeographicDirectoryReader(db).read("NO", AT)).resolves.toEqual({
      state: "available",
      evaluatedAt: AT.toISOString(),
      directory: {
        contractVersion: 1,
        countryCode: "NO",
        directoryVersionId: "postal-directory-2026-07",
        evidenceReference: "manifest:directory",
        publishedAt: "2026-07-16T12:45:00.000Z",
        regions: [{
          coverageState: "complete",
          evidenceReference: "manifest:oslo",
          postalCodes: ["0152", "0452"],
          regionCode: "no-0301-oslo",
        }],
        reviewedAt: "2026-07-16T12:00:00.000Z",
        status: "approved",
        validFrom: "2026-07-17T00:00:00.000Z",
      },
    });
    expect(captures[0]?.sql).toContain("from public.geographic_postal_directory_versions");
    expect(captures[0]?.sql).toContain("version.reviewed_at <=");
    expect(captures[0]?.sql).toContain("version.sealed_at <=");
    expect(captures[0]?.sql).not.toContain("version.valid_from <=");
    expect(captures[0]?.sql).not.toContain("version.valid_until >");
    expect(captures[0]?.parameters).toContain(AT.toISOString());
  });

  it("uses the database seal clock instead of retroactively authorizing a built row", async () => {
    const { captures, db } = database([]);

    await expect(new PostgresGeographicDirectoryReader(db).read("NO", AT)).resolves.toEqual({
      state: "unknown",
      reason: "postal-directory-unavailable",
    });
    expect(captures[0]?.sql).toContain("version.sealed_at <=");
    expect(captures[0]?.sql).not.toContain("version.created_at <=");
  });

  it("keeps the newest future or expired terminal version non-authorizing", async () => {
    await expect(new PostgresGeographicDirectoryReader(database([
      row({ valid_from: "2026-07-18T00:00:00.000Z" }),
    ]).db).read("NO", AT)).resolves.toEqual({
      state: "unknown",
      reason: "postal-directory-not-current",
    });

    await expect(new PostgresGeographicDirectoryReader(database([
      row({ valid_until: AT.toISOString() }),
    ]).db).read("NO", AT)).resolves.toEqual({
      state: "unknown",
      reason: "postal-directory-not-current",
    });
  });

  it.each(["blocked", "retired"] as const)(
    "lets the newest %s terminal version shadow every older approval",
    async (directoryStatus) => {
      await expect(new PostgresGeographicDirectoryReader(database([
        row({ directory_status: directoryStatus }),
      ]).db).read("NO", AT)).resolves.toEqual({
        state: "unknown",
        reason: `postal-directory-${directoryStatus}`,
      });
    },
  );

  it("preserves blocked, overlapping, and incomplete evidence as non-authorizing", async () => {
    await expect(new PostgresGeographicDirectoryReader(
      database([row({ directory_status: "blocked" })]).db,
    ).read("NO", AT)).resolves.toEqual({
      state: "unknown",
      reason: "postal-directory-blocked",
    });

    await expect(new PostgresGeographicDirectoryReader(database([
      row(),
      row({ version_id: "postal-directory-conflict" }),
    ]).db).read("NO", AT)).resolves.toEqual({
      state: "ambiguous",
      reason: "overlapping-directory-versions",
    });

    await expect(new PostgresGeographicDirectoryReader(
      database([row({ postal_count: 2 })]).db,
    ).read("NO", AT)).resolves.toEqual({
      state: "unknown",
      reason: "invalid-postal-directory",
    });
  });

  it("fails invalid requests before SQL", async () => {
    const { captures, db } = database([]);
    const reader = new PostgresGeographicDirectoryReader(db);
    await expect(reader.read("no", AT)).rejects.toEqual(
      new GeographicDirectoryReaderError("INVALID_REQUEST"),
    );
    await expect(reader.read("NO", new Date(Number.NaN))).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(captures).toEqual([]);
  });
});
