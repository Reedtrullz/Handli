import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

async function source(name: string): Promise<string> {
  return (await readFile(new URL(`./${name}`, import.meta.url), "utf8"))
    .replace(/\s+/gu, " ")
    .trim();
}

function expectLatestPersistedFirst(
  contents: string,
  permissionAlias: string,
  occurrenceCount = 1,
): void {
  const selections = [...contents.matchAll(new RegExp(
    `from (?:public\\.)?source_permissions ${permissionAlias} (.*?) limit 1`,
    "gu",
  ))];
  expect(selections).toHaveLength(occurrenceCount);
  for (const selection of selections) {
    expect(selection[1]).toContain(`${permissionAlias}.created_at <=`);
    expect(selection[1]).not.toContain(`${permissionAlias}.reviewed_at <=`);
    expect(selection[1]).toContain(
      `order by ${permissionAlias}.created_at desc, ${permissionAlias}.id desc`,
    );
  }
}

function expectRankedLatestPersistedFirst(contents: string): void {
  const selection = contents.match(
    /with ranked_permissions as \((.*?)\), latest_permissions/gu,
  );
  expect(selection).toHaveLength(1);
  expect(selection![0]).toContain("permission.created_at <=");
  expect(selection![0]).not.toContain("permission.reviewed_at <=");
  expect(selection![0]).toContain(
    "order by permission.created_at desc, permission.id desc",
  );
}

describe("serialized source permission selection boundary", () => {
  it.each([
    ["planning-evidence-reader.ts", "permission"],
    ["source-status-reader.ts", "permission"],
    ["catalog-reader.ts", "candidate"],
    ["reviewed-family-reader.ts", "candidate"],
    ["branch-directory.ts", "permission"],
  ] as const)("orders %s by persisted decision order", async (file, permissionAlias) => {
    const contents = await source(file);
    expect(contents).toContain(
      `order by ${permissionAlias}.created_at desc, ${permissionAlias}.id desc`,
    );
    expect(contents).not.toContain(`order by ${permissionAlias}.reviewed_at desc`);
    if (file === "source-status-reader.ts") {
      expectRankedLatestPersistedFirst(contents);
    } else {
      expectLatestPersistedFirst(contents, permissionAlias);
    }
    expect(contents).toContain("permission.reviewed_at <=");
    expect(contents).toContain("source.permission_reviewed_at = permission.reviewed_at".replace(
      "source.",
      file === "planning-evidence-reader.ts" ? "ds." : "source.",
    ));
    expect(contents).toContain(
      "source.permission_expires_at is not distinct from permission.valid_until".replace(
        "source.",
        file === "planning-evidence-reader.ts" ? "ds." : "source.",
      ),
    );
  });

  it("applies the same boundary to every public catalog-index query", async () => {
    const contents = await source("public-catalog-index-reader.ts");
    expect(contents.match(
      /order by candidate_permission\.created_at desc, candidate_permission\.id desc/gu,
    )).toHaveLength(3);
    expectLatestPersistedFirst(contents, "candidate_permission", 3);
    expect(contents).not.toContain("order by candidate_permission.reviewed_at desc");
    expect(contents.match(/permission\.reviewed_at <=/gu)).toHaveLength(3);
    expect(contents.match(
      /source\.permission_reviewed_at = permission\.reviewed_at/gu,
    )).toHaveLength(3);
    expect(contents.match(
      /source\.permission_expires_at is not distinct from permission\.valid_until/gu,
    )).toHaveLength(3);
  });

  it("keeps source access, price evidence, and rights-sensitive ingestion on the same boundary", async () => {
    const [access, prices, ingestion] = await Promise.all([
      source("source-access.ts"),
      source("price-read-model.ts"),
      source("ingestion.ts"),
    ]);

    expect(access).toContain("order by created_at desc, id desc");
    expect(access).not.toContain("order by reviewed_at desc");
    expect(access).toContain("permission.reviewed_at <= clock_timestamp()");
    expect(access).toContain("source.permission_reviewed_at = permission.reviewed_at");
    expect(access).toContain(
      "source.permission_expires_at is not distinct from permission.valid_until",
    );

    expect(prices).toContain(
      "eq(dataSources.permissionReviewedAt, sourcePermissions.reviewedAt)",
    );
    expect(prices).toContain(
      "`${dataSources.permissionExpiresAt} is not distinct from ${sourcePermissions.validUntil}`",
    );
    expect(prices).toContain(
      "gt( newerSourcePermissions.createdAt, sourcePermissions.createdAt",
    );
    expect(prices).not.toContain("lte(newerSourcePermissions.reviewedAt, now)");
    expect(prices).not.toContain(
      "gt( newerSourcePermissions.reviewedAt, sourcePermissions.reviewedAt",
    );

    expect(ingestion).toContain(
      "${dataSources.permissionReviewedAt} = ${sourcePermissions.reviewedAt}",
    );
    expect(ingestion).toContain(
      "${dataSources.permissionExpiresAt} is not distinct from ${sourcePermissions.validUntil}",
    );
    expect(ingestion).toContain(
      ".orderBy(desc(sourcePermissions.createdAt), desc(sourcePermissions.id))",
    );
    expect(ingestion).not.toContain(
      "sql`${sourcePermissions.reviewedAt} <= clock_timestamp()`",
    );
    expect(ingestion.match(/this\.sourceAllowsCapabilities\(/gu)).toHaveLength(3);
    expect(ingestion).toContain(
      "const identifierNeedsVerification = identifier.verifiedAt === null",
    );
    expect(ingestion).toContain(
      "if (!catalogSourceAccessApproved)",
    );
    const authorizationBoundary = ingestion.slice(
      ingestion.indexOf("private async sourceAllowsCapabilities"),
      ingestion.indexOf("private async lockSourceGovernance"),
    );
    expect(authorizationBoundary).toContain(
      "await this.lockSourceGovernance(transaction, sourceId)",
    );
    expect(authorizationBoundary.indexOf("await this.lockSourceGovernance"))
      .toBeLessThan(authorizationBoundary.indexOf("const [authorization]"));
    const fencedTransaction = ingestion.slice(
      ingestion.indexOf("private async fencedTransaction"),
      ingestion.indexOf("private async lockRun"),
    );
    expect(fencedTransaction).toContain("'lock_timeout'");
    expect(fencedTransaction).toContain("'statement_timeout'");
    expect(fencedTransaction.match(/pg_catalog\.set_config\(/gu)).toHaveLength(2);
    expect(fencedTransaction.match(/true \)/gu)).toHaveLength(2);
    expect(fencedTransaction.indexOf("pg_catalog.set_config"))
      .toBeLessThan(fencedTransaction.indexOf("await this.verifyFence"));
    const governanceLockBoundary = ingestion.slice(
      ingestion.indexOf("private async lockSourceGovernance"),
      ingestion.indexOf("private async lockProductGtins"),
    );
    expect(governanceLockBoundary).toContain(
      "pg_catalog.pg_advisory_xact_lock( pg_catalog.hashtextextended( ${sourceId}, ${SOURCE_GOVERNANCE_ADVISORY_LOCK_SEED}",
    );
    const catalogPersistence = ingestion.slice(
      ingestion.indexOf("async persistCatalogOutcomes"),
      ingestion.indexOf("async persistPriceOutcomes"),
    );
    expect(catalogPersistence).toContain("await this.lockSourceGovernance(transaction, handle.sourceId)");
    expect(catalogPersistence).toContain(
      "catalogSourceAccessApproved = await this.sourceAllowsCapabilities",
    );
    expect(catalogPersistence).toContain("await this.lockProductGtins(transaction, acceptedGtins)");
    expect(catalogPersistence).toContain(")].sort()");
    expect(catalogPersistence.indexOf("await this.lockSourceGovernance"))
      .toBeLessThan(catalogPersistence.indexOf("await this.sourceAllowsCapabilities"));
    expect(catalogPersistence.indexOf("await this.sourceAllowsCapabilities"))
      .toBeLessThan(catalogPersistence.indexOf("await this.lockProductGtins"));
    expect(catalogPersistence.indexOf("await this.lockProductGtins"))
      .toBeLessThan(catalogPersistence.indexOf("await this.resolveProductByGtin"));
    expect(catalogPersistence.indexOf("if (!catalogSourceAccessApproved)"))
      .toBeLessThan(catalogPersistence.indexOf("await this.resolveProductByGtin"));
    const pricePersistence = ingestion.slice(
      ingestion.indexOf("async persistPriceOutcomes"),
      ingestion.indexOf("async persistPhysicalStoreOutcomes"),
    );
    expect(pricePersistence).toContain("const capability = priceCapabilityForRunType(handle.runType)");
    expect(pricePersistence).toContain("await this.lockSourceGovernance(transaction, handle.sourceId)");
    expect(pricePersistence).toContain("await this.sourceAllowsCapabilities");
    expect(pricePersistence).toContain("await this.lockProductGtins(transaction, subjectGtins)");
    expect(pricePersistence.indexOf("await this.lockSourceGovernance"))
      .toBeLessThan(pricePersistence.indexOf("await this.sourceAllowsCapabilities"));
    expect(pricePersistence.indexOf("await this.sourceAllowsCapabilities"))
      .toBeLessThan(pricePersistence.indexOf("await this.lockProductGtins"));
    expect(pricePersistence.indexOf("await this.lockProductGtins"))
      .toBeLessThan(pricePersistence.indexOf("await this.resolveProductByGtin"));
    const storePersistence = ingestion.slice(
      ingestion.indexOf("async persistPhysicalStoreOutcomes"),
      ingestion.indexOf("async finalizeRun"),
    );
    expect(storePersistence).toContain("await this.lockSourceGovernance(transaction, handle.sourceId)");
    expect(storePersistence).toContain("await this.sourceAllowsCapabilities");
    expect(storePersistence).toContain('["physicalStore"]');
    expect(storePersistence.indexOf("await this.sourceAllowsCapabilities"))
      .toBeLessThan(storePersistence.indexOf(".insert(physicalStoreObservations)"));
    expect(ingestion).not.toContain(
      ".orderBy(desc(sourcePermissions.reviewedAt), desc(sourcePermissions.id))",
    );
  });

  it("does not change reviewed-family membership decision ordering", async () => {
    const contents = await source("reviewed-family-reader.ts");
    expect(contents).toContain("order by decision.reviewed_at desc, decision.id desc");
  });
});
