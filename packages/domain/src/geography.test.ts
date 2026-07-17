import { describe, expect, it } from "vitest";

import {
  MAX_GEOGRAPHIC_REGION_CODES,
  MAX_GEOGRAPHIC_STORE_IDS,
  MAX_GEOGRAPHIC_POSTAL_CODES,
  attestGeographicDirectoryRegionV1,
  geographicDirectoryEvidenceSchema,
  geographicDirectoryEvidenceFromRegionAttestationV1,
  geographicDirectoryRegionAttestationV1Schema,
  geographicScopeSchema,
  geographicScopeSpecificity,
  resolveGeographicApplicability,
  type GeographicDirectoryEvidence,
} from "./geography";

const DIRECTORY: GeographicDirectoryEvidence = {
  state: "available",
  evaluatedAt: "2026-07-17T12:00:00.000Z",
  directory: {
    contractVersion: 1,
    countryCode: "NO",
    directoryVersionId: "postal-directory-2026-07",
    evidenceReference: "manifest:postal-directory-2026-07",
    publishedAt: "2026-07-16T12:30:00.000Z",
    regions: [
      {
        coverageState: "complete",
        evidenceReference: "manifest:oslo-postal-set",
        postalCodes: ["0152", "0452"],
        regionCode: "no-0301-oslo",
      },
      {
        coverageState: "ambiguous",
        evidenceReference: "review:bergen-pending",
        postalCodes: [],
        regionCode: "no-4601-bergen",
      },
    ],
    reviewedAt: "2026-07-16T12:00:00.000Z",
    status: "approved",
    validFrom: "2026-07-17T00:00:00.000Z",
  },
};

describe("geographic postal applicability", () => {
  it("hard-bounds region and store scope cardinality", () => {
    expect(geographicScopeSchema.safeParse({
      kind: "regions",
      countryCode: "NO",
      regionCodes: Array.from(
        { length: MAX_GEOGRAPHIC_REGION_CODES },
        (_, index) => `region-${index}`,
      ),
    }).success).toBe(true);
    expect(geographicScopeSchema.safeParse({
      kind: "regions",
      countryCode: "NO",
      regionCodes: Array.from(
        { length: MAX_GEOGRAPHIC_REGION_CODES + 1 },
        (_, index) => `region-${index}`,
      ),
    }).success).toBe(false);
    expect(geographicScopeSchema.safeParse({
      kind: "stores",
      storeIds: Array.from(
        { length: MAX_GEOGRAPHIC_STORE_IDS + 1 },
        (_, index) => `store-${index}`,
      ),
    }).success).toBe(false);
  });

  it("requires complete versioned directory proof for a region-level postal match", () => {
    const scope = {
      countryCode: "NO" as const,
      kind: "postal-set" as const,
      postalCodes: ["0152", "0452", "9999"],
    };
    const location = { countryCode: "NO" as const, regionCode: "no-0301-oslo" };

    expect(resolveGeographicApplicability(scope, location)).toEqual({
      state: "unknown",
      reason: "postal-directory-unavailable",
    });
    expect(resolveGeographicApplicability(scope, location, DIRECTORY)).toEqual({
      state: "applicable",
      specificity: 2,
    });
    expect(geographicScopeSpecificity(scope, location, DIRECTORY)).toBe(2);
  });

  it("projects and rebinds only one complete versioned region", () => {
    const attestation = attestGeographicDirectoryRegionV1(
      DIRECTORY,
      "no-0301-oslo",
    );
    expect(geographicDirectoryRegionAttestationV1Schema.safeParse(attestation).success)
      .toBe(true);
    expect(attestation).toMatchObject({
      contractVersion: 1,
      directoryVersionId: "postal-directory-2026-07",
      evaluatedAt: DIRECTORY.state === "available" ? DIRECTORY.evaluatedAt : undefined,
      region: {
        postalCodes: ["0152", "0452"],
        regionCode: "no-0301-oslo",
      },
    });
    expect(JSON.stringify(attestation)).not.toContain("no-4601-bergen");

    const rebound = geographicDirectoryEvidenceFromRegionAttestationV1(
      attestation!,
      { countryCode: "NO", regionCode: "no-0301-oslo" },
      "2026-07-17T12:00:00.000Z",
    );
    expect(resolveGeographicApplicability({
      countryCode: "NO",
      kind: "postal-set",
      postalCodes: ["0152", "0452"],
    }, {
      countryCode: "NO",
      regionCode: "no-0301-oslo",
    }, rebound)).toEqual({ state: "applicable", specificity: 2 });
    expect(geographicDirectoryEvidenceFromRegionAttestationV1(
      attestation!,
      { countryCode: "NO", regionCode: "no-4601-bergen" },
      "2026-07-17T12:00:00.000Z",
    )).toBeUndefined();
    expect(geographicDirectoryEvidenceFromRegionAttestationV1(
      attestation!,
      { countryCode: "NO", regionCode: "no-0301-oslo" },
      "2026-07-17T12:00:00.001Z",
    )).toBeUndefined();
    expect(attestGeographicDirectoryRegionV1(
      DIRECTORY,
      "no-4601-bergen",
    )).toBeUndefined();
    expect(geographicDirectoryRegionAttestationV1Schema.safeParse({
      ...attestation,
      region: {
        ...attestation!.region,
        postalCodes: Array.from(
          { length: MAX_GEOGRAPHIC_POSTAL_CODES + 1 },
          (_, index) => String(index % MAX_GEOGRAPHIC_POSTAL_CODES).padStart(4, "0"),
        ),
      },
    }).success).toBe(false);
  });

  it("keeps partial overlap and directory conflicts ambiguous instead of authorizing them", () => {
    const location = { countryCode: "NO" as const, regionCode: "no-0301-oslo" };
    expect(resolveGeographicApplicability({
      countryCode: "NO",
      kind: "postal-set",
      postalCodes: ["0152"],
    }, location, DIRECTORY)).toEqual({
      state: "ambiguous",
      reason: "partial-postal-region-overlap",
    });
    expect(resolveGeographicApplicability({
      countryCode: "NO",
      kind: "postal-set",
      postalCodes: ["0152", "0452"],
    }, location, {
      state: "ambiguous",
      reason: "overlapping-directory-versions",
    })).toEqual({
      state: "ambiguous",
      reason: "overlapping-directory-versions",
    });
  });

  it("rejects stale, future, and explicitly blocked directory states", () => {
    const scope = {
      countryCode: "NO" as const,
      kind: "postal-set" as const,
      postalCodes: ["0152", "0452"],
    };
    const location = { countryCode: "NO" as const, regionCode: "no-0301-oslo" };
    const available = DIRECTORY.state === "available" ? DIRECTORY : undefined;
    expect(available).toBeDefined();

    expect(resolveGeographicApplicability(scope, location, {
      ...available!,
      evaluatedAt: "2026-07-18T00:00:00.000Z",
      directory: {
        ...available!.directory,
        validUntil: "2026-07-18T00:00:00.000Z",
      },
    })).toEqual({ state: "unknown", reason: "postal-directory-not-current" });

    expect(resolveGeographicApplicability(scope, location, {
      ...available!,
      evaluatedAt: "2026-07-16T00:00:00.000Z",
    })).toEqual({ state: "unknown", reason: "postal-directory-not-current" });

    expect(resolveGeographicApplicability(scope, location, {
      state: "unknown",
      reason: "postal-directory-blocked",
    })).toEqual({ state: "unknown", reason: "postal-directory-blocked" });
    expect(resolveGeographicApplicability(scope, location, {
      state: "unknown",
      reason: "postal-directory-revoked",
    })).toEqual({ state: "unknown", reason: "postal-directory-revoked" });
  });

  it("distinguishes disjoint postal scopes and explicit postal choices", () => {
    expect(resolveGeographicApplicability({
      countryCode: "NO",
      kind: "postal-set",
      postalCodes: ["5003"],
    }, {
      countryCode: "NO",
      regionCode: "no-0301-oslo",
    }, DIRECTORY)).toEqual({ state: "not-applicable" });

    expect(resolveGeographicApplicability({
      countryCode: "NO",
      kind: "postal-set",
      postalCodes: ["0152"],
    }, {
      countryCode: "NO",
      postalCode: "0152",
    })).toEqual({ state: "applicable", specificity: 2 });
  });

  it("validates the manifest evidence shape and preserves ambiguous regions", () => {
    expect(geographicDirectoryEvidenceSchema.safeParse(DIRECTORY).success).toBe(true);
    expect(resolveGeographicApplicability({
      countryCode: "NO",
      kind: "postal-set",
      postalCodes: ["5003"],
    }, {
      countryCode: "NO",
      regionCode: "no-4601-bergen",
    }, DIRECTORY)).toEqual({
      state: "ambiguous",
      reason: "postal-directory-region-ambiguous",
    });
  });
});
