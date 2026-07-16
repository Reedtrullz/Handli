import { describe, expect, it } from "vitest";

import {
  canonicalizeFamilyTaxonomyContent,
  familyTaxonomySchema,
  parseFamilyTaxonomy,
} from "./index";

const validTaxonomy = {
  $schema: "./product-family-taxonomy.v1.schema.json",
  contractVersion: 1,
  taxonomyId: "handleplan-reviewed-families",
  taxonomyVersion: "1.0.0",
  versionId: "handleplan-reviewed-families@1.0.0",
  publishedAt: "2026-07-16T00:00:00.000Z",
  contentSha256: "a".repeat(64),
  families: [
    {
      id: "family:brod",
      slug: "brod",
      labelNo: "Brød",
      aliases: ["brød"],
      status: "active",
    },
    {
      id: "family:kaffe",
      slug: "kaffe",
      labelNo: "Kaffe",
      aliases: [],
      status: "active",
    },
    {
      id: "family:melk",
      slug: "melk",
      labelNo: "Melk",
      aliases: ["mjølk"],
      status: "retired",
    },
  ],
} as const;

describe("reviewed family taxonomy contract", () => {
  it("parses bounded, versioned Norwegian family descriptors", () => {
    const parsed = parseFamilyTaxonomy(validTaxonomy);

    expect(parsed.versionId).toBe("handleplan-reviewed-families@1.0.0");
    expect(parsed.families.map(({ id }) => id)).toEqual([
      "family:brod",
      "family:kaffe",
      "family:melk",
    ]);
    expect(parsed.families[0]?.labelNo).toBe("Brød");
    expect(parsed.families[2]?.status).toBe("retired");
  });

  it("rejects version IDs that do not bind the taxonomy ID and version", () => {
    expect(
      familyTaxonomySchema.safeParse({
        ...validTaxonomy,
        versionId: "some-other-taxonomy@1.0.0",
      }).success,
    ).toBe(false);
  });

  it("requires globally unique family IDs, slugs, and normalized alias keys", () => {
    const duplicateId = {
      ...validTaxonomy,
      families: [validTaxonomy.families[0], validTaxonomy.families[0]],
    };
    const aliasCollision = {
      ...validTaxonomy,
      families: [
        validTaxonomy.families[0],
        {
          ...validTaxonomy.families[1],
          aliases: ["brød"],
        },
      ],
    };
    const slugCollision = {
      ...validTaxonomy,
      families: [
        validTaxonomy.families[0],
        {
          ...validTaxonomy.families[1],
          aliases: ["brod"],
        },
      ],
    };

    expect(familyTaxonomySchema.safeParse(duplicateId).success).toBe(false);
    expect(familyTaxonomySchema.safeParse(aliasCollision).success).toBe(false);
    expect(familyTaxonomySchema.safeParse(slugCollision).success).toBe(false);
  });

  it("requires every parent to exist and rejects direct or indirect cycles", () => {
    const unknownParent = {
      ...validTaxonomy,
      families: [
        {
          ...validTaxonomy.families[0],
          parentId: "family:unknown",
        },
      ],
    };
    const cycle = {
      ...validTaxonomy,
      families: [
        {
          ...validTaxonomy.families[0],
          parentId: "family:kaffe",
        },
        {
          ...validTaxonomy.families[1],
          parentId: "family:melk",
        },
        {
          ...validTaxonomy.families[2],
          parentId: "family:brod",
        },
      ],
    };

    expect(familyTaxonomySchema.safeParse(unknownParent).success).toBe(false);
    expect(familyTaxonomySchema.safeParse(cycle).success).toBe(false);
  });

  it("is strict and cannot carry product memberships or unbounded values", () => {
    expect(
      familyTaxonomySchema.safeParse({
        ...validTaxonomy,
        memberships: [{ productId: "forbidden", familyId: "family:melk" }],
      }).success,
    ).toBe(false);
    expect(
      familyTaxonomySchema.safeParse({
        ...validTaxonomy,
        families: [
          {
            ...validTaxonomy.families[0],
            productIds: ["forbidden"],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      familyTaxonomySchema.safeParse({
        ...validTaxonomy,
        families: Array.from({ length: 501 }, (_, index) => ({
          id: `family:f${index}`,
          slug: `f${index}`,
          labelNo: `Familie ${index}`,
          aliases: [],
          status: "active",
        })),
      }).success,
    ).toBe(false);
  });

  it("canonicalizes content independently of object key insertion order", () => {
    const reordered = validTaxonomy.families.map(({ aliases, id, labelNo, slug, status }) => ({
      status,
      aliases,
      labelNo,
      slug,
      id,
    }));

    expect(canonicalizeFamilyTaxonomyContent(reordered)).toBe(
      canonicalizeFamilyTaxonomyContent(validTaxonomy.families),
    );
    expect(canonicalizeFamilyTaxonomyContent(validTaxonomy.families)).toBe(
      '[{"aliases":["brød"],"id":"family:brod","labelNo":"Brød","slug":"brod","status":"active"},{"aliases":[],"id":"family:kaffe","labelNo":"Kaffe","slug":"kaffe","status":"active"},{"aliases":["mjølk"],"id":"family:melk","labelNo":"Melk","slug":"melk","status":"retired"}]',
    );
  });
});
