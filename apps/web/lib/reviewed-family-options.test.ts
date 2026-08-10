import { describe, expect, it } from "vitest";

import publishedTaxonomy from "../../../docs/data/product-family-taxonomy.v1.json";

import {
  REVIEWED_FAMILY_OPTIONS,
  reviewedFamilyOptionForQuery,
} from "./reviewed-family-options";

describe("published reviewed-family browser options", () => {
  it("offers only the three active v1 families in canonical order", () => {
    expect(REVIEWED_FAMILY_OPTIONS).toEqual(
      publishedTaxonomy.families.filter(({ status }) => status === "active"),
    );
  });

  it("resolves Norwegian labels and declared aliases without fuzzy authority", () => {
    expect(reviewedFamilyOptionForQuery(" Melk ")?.id).toBe("family:melk");
    expect(reviewedFamilyOptionForQuery("mjølk")?.id).toBe("family:melk");
    expect(reviewedFamilyOptionForQuery("lettmelk")).toBeUndefined();
  });
});
