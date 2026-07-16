import { describe, expect, it } from "vitest";

import {
  canonicalProductSchema,
  packageMeasureSchema,
  productFamilySchema,
  productIdentifierSchema,
} from "./index";

describe("canonical catalog contracts", () => {
  it("accepts versioned canonical products with exact identifiers", () => {
    expect(
      canonicalProductSchema.safeParse({
        contractVersion: 1,
        id: "product:milk:whole-1l",
        displayName: "Helmelk 1 l",
        brand: "Tine",
        identifiers: [
          { kind: "gtin", value: "7038010000010" },
          { kind: "source", sourceId: "kassalapp", value: "12345" },
        ],
        familyId: "family:whole-milk",
        packageMeasure: { amount: 1_000, unit: "ml" },
        status: "active",
      }).success,
    ).toBe(true);
  });

  it("keeps GTIN and source identifiers structurally distinct", () => {
    expect(productIdentifierSchema.safeParse({ kind: "gtin", value: "7038010000010" }).success).toBe(
      true,
    );
    expect(
      productIdentifierSchema.safeParse({
        kind: "source",
        sourceId: "kassalapp",
        value: "12345",
      }).success,
    ).toBe(true);
    expect(
      productIdentifierSchema.safeParse({
        kind: "source",
        value: "7038010000010",
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate identifiers and an empty canonical identity", () => {
    const base = {
      contractVersion: 1,
      id: "product:milk",
      displayName: "Melk",
      identifiers: [{ kind: "gtin", value: "7038010000010" }],
      packageMeasure: { amount: 1_000, unit: "ml" },
      status: "active",
    };

    expect(canonicalProductSchema.safeParse({ ...base, identifiers: [] }).success).toBe(false);
    expect(
      canonicalProductSchema.safeParse({
        ...base,
        identifiers: [base.identifiers[0], base.identifiers[0]],
      }).success,
    ).toBe(false);
  });

  it("uses the same canonical-product lifecycle states as persistence", () => {
    const base = {
      contractVersion: 1,
      id: "product:milk",
      displayName: "Melk",
      identifiers: [{ kind: "gtin", value: "7038010000010" }],
      packageMeasure: { amount: 1_000, unit: "ml" },
    };

    expect(canonicalProductSchema.safeParse({ ...base, status: "quarantined" }).success).toBe(
      true,
    );
    expect(canonicalProductSchema.safeParse({ ...base, status: "retired" }).success).toBe(true);
    expect(canonicalProductSchema.safeParse({ ...base, status: "discontinued" }).success).toBe(
      false,
    );
  });

  it("uses positive safe integers for normalized package measures", () => {
    expect(packageMeasureSchema.safeParse({ amount: 1, unit: "piece" }).success).toBe(true);
    expect(packageMeasureSchema.safeParse({ amount: 0, unit: "piece" }).success).toBe(false);
    expect(
      packageMeasureSchema.safeParse({ amount: Number.MAX_SAFE_INTEGER + 1, unit: "g" }).success,
    ).toBe(false);
    expect(packageMeasureSchema.safeParse({ amount: 1.5, unit: "ml" }).success).toBe(false);
  });

  it("requires a versioned, non-self-referential product family", () => {
    expect(
      productFamilySchema.safeParse({
        contractVersion: 1,
        id: "family:milk",
        displayName: "Melk",
        parentId: "family:dairy",
      }).success,
    ).toBe(true);
    expect(
      productFamilySchema.safeParse({
        contractVersion: 1,
        id: "family:milk",
        displayName: "Melk",
        parentId: "family:milk",
      }).success,
    ).toBe(false);
    expect(
      productFamilySchema.safeParse({
        contractVersion: 2,
        id: "family:milk",
        displayName: "Melk",
      }).success,
    ).toBe(false);
  });
});
