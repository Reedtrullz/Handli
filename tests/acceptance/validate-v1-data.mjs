import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(root, relativePath), "utf8"));
}

function readText(relativePath) {
  return readFileSync(resolve(root, relativePath), "utf8");
}

function unique(values, label) {
  assert.equal(new Set(values).size, values.length, `${label} must be unique`);
}

function sorted(values) {
  return [...values].sort();
}

function collectKeys(value, keys = []) {
  if (Array.isArray(value)) {
    for (const child of value) collectKeys(child, keys);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

function canonicalizeJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(",")}]`;

  const entries = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`);
  return `{${entries.join(",")}}`;
}

function assertSchemaValid(label, schema, instance) {
  const validate = ajv.compile(schema);
  assert.equal(
    validate(instance),
    true,
    `${label} violates its Draft 2020-12 schema:\n${ajv.errorsText(validate.errors, { separator: "\n" })}`,
  );
}

const registry = readJson("docs/data/source-registry.v1.json");
const registrySchema = readJson("docs/data/source-registry.v1.schema.json");
const coverage = readJson("docs/data/launch-coverage.v1.json");
const coverageSchema = readJson("docs/data/launch-coverage.v1.schema.json");
const corpus = readJson("docs/data/benchmark-baskets.v1.json");
const corpusSchema = readJson("docs/data/benchmark-baskets.v1.schema.json");
const basketProtocolSchema = readJson("docs/data/benchmark-basket-protocol.v1.schema.json");
const basketCandidateSchema = readJson("docs/data/benchmark-basket-candidate.v1.schema.json");
const basketReportSchema = readJson("docs/data/benchmark-basket-report.v1.schema.json");
const basketRunnerAttestationSchema = readJson(
  "docs/data/benchmark-basket-runner-attestation.v2.schema.json",
);
const familyTaxonomy = readJson("docs/data/product-family-taxonomy.v1.json");
const familyTaxonomySchema = readJson("docs/data/product-family-taxonomy.v1.schema.json");

assert.equal(registry.$schema, "./source-registry.v1.schema.json");
assert.equal(coverage.$schema, "./launch-coverage.v1.schema.json");
assert.equal(corpus.$schema, "./benchmark-baskets.v1.schema.json");
assert.equal(familyTaxonomy.$schema, "./product-family-taxonomy.v1.schema.json");
assert.match(registrySchema.$id, /source-registry\.v1\.schema\.json$/);
assert.match(coverageSchema.$id, /launch-coverage\.v1\.schema\.json$/);
assert.match(corpusSchema.$id, /benchmark-baskets\.v1\.schema\.json$/);
assert.match(
  basketProtocolSchema.$id,
  /benchmark-basket-protocol\.v1\.schema\.json$/,
);
assert.match(
  basketCandidateSchema.$id,
  /benchmark-basket-candidate\.v1\.schema\.json$/,
);
assert.match(basketReportSchema.$id, /benchmark-basket-report\.v1\.schema\.json$/);
assert.match(
  basketRunnerAttestationSchema.$id,
  /benchmark-basket-runner-attestation\.v2\.schema\.json$/,
);
assert.equal(basketProtocolSchema.properties.protocolVersion.const, "2.0.0");
assert.equal(basketProtocolSchema.$defs.quantityCase.properties.options.maxItems, 12);
assert.ok(
  basketProtocolSchema.$defs.knownNotCarriedControl.required.includes("matchEvidenceId"),
);
assert.ok(
  basketCandidateSchema.$defs.manualReconciliation.required.includes(
    "reviewedEvidenceDigest",
  ),
);
assert.equal(
  basketCandidateSchema.$defs.manualReconciliation.properties.priceEvidenceIds.maxItems,
  24,
);
for (const schema of [basketCandidateSchema, basketProtocolSchema]) {
  assert.ok(schema.$defs.assignment.required.includes("ordinaryCostOre"));
  assert.ok(schema.$defs.assignment.required.includes("appliedOfferEvidenceId"));
  assert.equal(schema.$defs.assignment.properties.appliedOfferEvidenceId.oneOf[0].type, "null");
}
assert.ok(
  basketCandidateSchema.$defs.offerTerms.allOf[0].then.required.includes(
    "membershipProgramId",
  ),
);
assert.ok(
  basketProtocolSchema.$defs.oracleRequest.required.includes(
    "enabledMembershipProgramIds",
  ),
);
assert.ok(
  basketRunnerAttestationSchema.$defs.snapshot.required.includes(
    "enabledMembershipProgramIds",
  ),
);
assert.ok(
  basketRunnerAttestationSchema.$defs.oracleResult.required.includes(
    "discountedFrontierPlanSignatures",
  ),
);
assert.equal(
  basketCandidateSchema.$defs.manualReconciliation.properties.assertions,
  undefined,
);
assert.equal(basketCandidateSchema.properties.contractVersion.const, "2.0.0");
assert.equal(basketReportSchema.properties.contractVersion.const, "2.0.0");
assert.equal(basketReportSchema.properties.protocolVersion.const, "2.0.0");
assert.match(familyTaxonomySchema.$id, /product-family-taxonomy\.v1\.schema\.json$/);
assertSchemaValid("source registry", registrySchema, registry);
assertSchemaValid("launch coverage", coverageSchema, coverage);
assertSchemaValid("benchmark baskets", corpusSchema, corpus);
assert.doesNotThrow(
  () => ajv.addSchema(basketProtocolSchema),
  "benchmark protocol schema must compile as Draft 2020-12",
);
assert.doesNotThrow(
  () => ajv.compile(basketCandidateSchema),
  "benchmark candidate schema must compile as Draft 2020-12",
);
assert.doesNotThrow(
  () => ajv.compile(basketReportSchema),
  "benchmark report schema must compile as Draft 2020-12",
);
assert.doesNotThrow(
  () => ajv.compile(basketRunnerAttestationSchema),
  "benchmark runner attestation schema must compile as Draft 2020-12",
);
assertSchemaValid("product-family taxonomy", familyTaxonomySchema, familyTaxonomy);

// Reviewed-family vocabulary is versioned, immutable, bounded, and membership-free.
assert.equal(familyTaxonomy.taxonomyId, "handleplan-reviewed-families");
assert.equal(familyTaxonomy.taxonomyVersion, "1.0.0");
assert.equal(
  familyTaxonomy.versionId,
  `${familyTaxonomy.taxonomyId}@${familyTaxonomy.taxonomyVersion}`,
);
const canonicalFamilies = canonicalizeJson(familyTaxonomy.families);
assert.equal(
  familyTaxonomy.contentSha256,
  createHash("sha256").update(canonicalFamilies, "utf8").digest("hex"),
  "family taxonomy checksum must cover the canonical family descriptors",
);

const familyIds = familyTaxonomy.families.map((family) => family.id);
const familySlugs = familyTaxonomy.families.map((family) => family.slug);
const familyAliases = familyTaxonomy.families.flatMap((family) => family.aliases);
unique(familyIds, "family taxonomy ids");
unique(familySlugs, "family taxonomy slugs");
unique(familyAliases, "family taxonomy aliases");
unique([...familySlugs, ...familyAliases], "family taxonomy lookup keys");
assert.deepEqual(familyIds, sorted(familyIds), "family descriptors must have stable ID ordering");
for (const family of familyTaxonomy.families) {
  assert.deepEqual(family.aliases, sorted(family.aliases), `${family.id} aliases have stable ordering`);
  for (const alias of family.aliases) {
    assert.equal(alias.normalize("NFC"), alias, `${family.id} aliases use Unicode NFC`);
  }
  if (family.parentId !== undefined) {
    assert.ok(familyIds.includes(family.parentId), `${family.id} parent exists in this version`);
  }
}

const parentByFamilyId = new Map(
  familyTaxonomy.families.map((family) => [family.id, family.parentId]),
);
for (const familyId of familyIds) {
  const ancestors = new Set();
  let candidate = familyId;
  while (candidate !== undefined) {
    assert.equal(ancestors.has(candidate), false, `${familyId} parent graph must be acyclic`);
    ancestors.add(candidate);
    candidate = parentByFamilyId.get(candidate);
  }
}

assert.deepEqual(
  familyTaxonomy.families.map(({ id, labelNo }) => ({ id, labelNo })),
  [
    { id: "family:brod", labelNo: "Brød" },
    { id: "family:kaffe", labelNo: "Kaffe" },
    { id: "family:melk", labelNo: "Melk" },
  ],
);
for (const forbiddenKey of ["membership", "memberships", "productId", "productIds"]) {
  assert.equal(
    collectKeys(familyTaxonomy).includes(forbiddenKey),
    false,
    `family taxonomy vocabulary must not contain ${forbiddenKey}`,
  );
}

// Source governance must be fail-closed and expose all four runtime states.
const sourceStates = ["approved", "blocked", "conditional", "revoked"];
assert.deepEqual(sorted(Object.keys(registry.states)), sourceStates);
assert.equal(registry.policy.defaultState, "blocked");
assert.equal(registry.policy.defaultRuntimeEnabled, false);
assert.equal(registry.policy.publicRankingRequires, "approved");
assert.equal(registry.policy.unknownPermissionBehavior, "blocked");

unique(registry.sources.map((source) => source.id), "source ids");
unique(registry.sources.map((source) => source.killSwitchKey), "source kill switches");

const sourcesById = new Map(registry.sources.map((source) => [source.id, source]));
const grocerySourceIds = [
  "kassalapp",
  "tjek-api",
  "bunnpris-public-web",
  "rema-public-web",
  "coop-extra-public-web",
];

for (const source of registry.sources) {
  assert.ok(sourceStates.includes(source.runtimeState), `${source.id} has a valid state`);
  assert.equal(source.runtimeDefaultEnabled, false, `${source.id} must default off`);
  assert.match(source.killSwitchKey, /^source\.[a-z0-9.-]+\.enabled$/);
  assert.ok(source.dataClasses.length > 0, `${source.id} lists data classes`);
  assert.ok(source.requiredActions.length > 0, `${source.id} lists required actions`);
  assert.ok(source.evidence.length > 0, `${source.id} has primary evidence`);
  assert.ok(source.revocationDisposition.length > 0, `${source.id} has a revocation disposition`);
  if (source.runtimeState !== "approved") {
    assert.equal(source.publicRankingEligible, false, `${source.id} cannot rank while ${source.runtimeState}`);
    assert.ok(source.knownUnknowns.length > 0, `${source.id} must disclose unresolved facts`);
  }
  for (const evidence of source.evidence) {
    assert.match(evidence.url, /^https:\/\//, `${source.id} evidence must use HTTPS`);
    assert.match(evidence.accessedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(evidence.finding.length >= 20, `${source.id} evidence finding is meaningful`);
  }
}

for (const sourceId of grocerySourceIds) {
  const source = sourcesById.get(sourceId);
  assert.ok(source, `registry contains ${sourceId}`);
  assert.notEqual(source.runtimeState, "approved", `${sourceId} rights must not be invented`);
  assert.equal(source.publicRankingEligible, false);
}

assert.equal(sourcesById.get("kartverket-address-api")?.runtimeState, "approved");
assert.equal(
  sourcesById.get("valhalla-openstreetmap-self-hosted")?.runtimeState,
  "approved",
);
assert.equal(
  sourcesById.get("valhalla-openstreetmap-self-hosted")?.runtimeDefaultEnabled,
  false,
);
assert.equal(
  sourcesById.get("valhalla-openstreetmap-self-hosted")?.publicRankingEligible,
  false,
);
assert.equal(sourcesById.get("kassalapp")?.runtimeState, "conditional");
assert.equal(sourcesById.get("kassalapp")?.runtimeDefaultEnabled, false);
assert.equal(sourcesById.get("kassalapp")?.publicRankingEligible, false);
assert.equal(sourcesById.get("kassalapp")?.killSwitchKey, "source.kassalapp.enabled");
assert.equal(sourcesById.get("tjek-api")?.runtimeState, "conditional");
assert.equal(sourcesById.get("bunnpris-public-web")?.runtimeState, "blocked");
assert.equal(sourcesById.get("rema-public-web")?.runtimeState, "blocked");
assert.equal(sourcesById.get("coop-extra-public-web")?.runtimeState, "blocked");

// Candidate coverage is a complete 3 regions x 3 chains x 2 price classes matrix.
const expectedChains = ["bunnpris", "extra", "rema-1000"];
const expectedRegions = ["no-0301-oslo", "no-4601-bergen", "no-5001-trondheim"];
const expectedPriceClasses = ["official_offer", "ordinary"];

assert.equal(coverage.launchDecision, "candidate_only");
assert.equal(coverage.selectionGate.passed, false);
assert.deepEqual(sorted(coverage.requiredChains.map((chain) => chain.id)), expectedChains);
assert.deepEqual(sorted(coverage.candidateRegions.map((region) => region.id)), expectedRegions);
unique(coverage.requiredChains.map((chain) => chain.id), "required chain ids");
unique(coverage.candidateRegions.map((region) => region.id), "candidate region ids");

for (const region of coverage.candidateRegions) {
  assert.equal(region.selectionStatus, "candidate_unverified");
  assert.equal(region.selected, false);
  assert.deepEqual(sorted(region.chainPresenceEvidence.map((entry) => entry.chainId)), expectedChains);
  assert.ok(region.knownGaps.length > 0, `${region.id} discloses gaps`);
}

const coverageKeys = coverage.coverage.map(
  (entry) => `${entry.regionId}/${entry.chainId}/${entry.priceClass}`,
);
unique(coverageKeys, "coverage matrix keys");
assert.equal(coverageKeys.length, expectedRegions.length * expectedChains.length * expectedPriceClasses.length);

for (const regionId of expectedRegions) {
  for (const chainId of expectedChains) {
    for (const priceClass of expectedPriceClasses) {
      assert.ok(
        coverageKeys.includes(`${regionId}/${chainId}/${priceClass}`),
        `coverage has ${regionId}/${chainId}/${priceClass}`,
      );
    }
  }
}

for (const entry of coverage.coverage) {
  assert.ok(expectedRegions.includes(entry.regionId));
  assert.ok(expectedChains.includes(entry.chainId));
  assert.ok(expectedPriceClasses.includes(entry.priceClass));
  assert.ok(entry.knownGaps.length > 0, `${entry.regionId}/${entry.chainId}/${entry.priceClass} discloses gaps`);
  for (const sourceId of entry.candidateSourceIds) {
    assert.ok(sourcesById.has(sourceId), `coverage source ${sourceId} exists in registry`);
  }
  if (entry.activeSourceId !== null) {
    const source = sourcesById.get(entry.activeSourceId);
    assert.ok(source, `active source ${entry.activeSourceId} exists`);
    assert.equal(source.runtimeState, "approved", `active source ${entry.activeSourceId} is approved`);
  }
  if (entry.launchEligible) {
    assert.equal(entry.coverageStatus, "verified");
    assert.equal(entry.evidenceLevel, "rights_cleared_measured");
    assert.notEqual(entry.activeSourceId, null);
  } else {
    assert.equal(entry.activeSourceId, null, "candidate-only cells cannot have an active source");
  }
}

// The corpus defines exactly 20 reusable scenarios and one pending run per region/scenario pair.
assert.deepEqual(corpus.privacy, {
  synthetic: true,
  containsPersonalData: false,
  containsOrigin: false,
  containsLiveProviderData: false,
});
assert.equal(corpus.defaultAssertions.completeBasketRequired, true);
assert.equal(corpus.defaultAssertions.maximumStores, 3);
assert.equal(corpus.defaultAssertions.integerOreRequired, true);
assert.equal(corpus.defaultAssertions.integerBaseUnitsRequired, true);
assert.equal(corpus.scenarios.length, 20);
assert.equal(corpus.runs.length, 60);
unique(corpus.scenarios.map((scenario) => scenario.id), "scenario ids");
unique(corpus.runs.map((run) => run.id), "benchmark run ids");

const scenarioIds = new Set(corpus.scenarios.map((scenario) => scenario.id));
for (const scenario of corpus.scenarios) {
  assert.ok(scenario.items.length >= 4, `${scenario.id} has at least four needs`);
  unique(scenario.items.map((item) => item.needId), `${scenario.id} need ids`);
  for (const item of scenario.items) {
    assert.ok(["flexible", "constrained"].includes(item.matchMode));
    assert.ok(Number.isInteger(item.requiredAmount.value) && item.requiredAmount.value > 0);
    assert.ok(["g", "ml", "piece", "package"].includes(item.requiredAmount.unit));
    assert.ok(["exact-product", "reviewed-family"].includes(item.identity.kind));
    if (item.identity.kind === "exact-product") {
      assert.equal(item.matchMode, "constrained");
      assert.match(item.identity.canonicalProductId, /^product:benchmark:/);
    }
    if (item.matchMode === "constrained" && item.identity.kind !== "exact-product") {
      assert.ok(item.constraints.length > 0, `${scenario.id}/${item.needId} has explicit constraints`);
    }
  }
}

const forbiddenCorpusKeys = new Set([
  "address",
  "coordinates",
  "email",
  "lat",
  "latitude",
  "lng",
  "longitude",
  "origin",
  "phone",
  "userId",
]);
for (const key of collectKeys({ scenarios: corpus.scenarios, runs: corpus.runs })) {
  assert.equal(forbiddenCorpusKeys.has(key), false, `benchmark data must not contain ${key}`);
}

for (const regionId of expectedRegions) {
  const regionalRuns = corpus.runs.filter((run) => run.regionId === regionId);
  assert.equal(regionalRuns.length, 20, `${regionId} has 20 benchmark baskets`);
  assert.deepEqual(sorted(regionalRuns.map((run) => run.scenarioId)), sorted(scenarioIds));
}

for (const run of corpus.runs) {
  assert.ok(expectedRegions.includes(run.regionId));
  assert.ok(scenarioIds.has(run.scenarioId));
  assert.equal(run.status, "pending_rights_and_measurement");
}

// Normative prose artifacts must exist and retain the central truth boundaries.
const registryDoc = readText("docs/data/source-registry.md");
const killSwitchDoc = readText("docs/data/source-kill-switch.md");
const classificationAdr = readText("docs/adr/0001-official-offer-vs-historical-price.md");
const scopeAdr = readText("docs/adr/0002-launch-scope-policy.md");
const familyTaxonomyDoc = readText("docs/data/product-family-taxonomy.md");
const basketAcceptanceDoc = readText("docs/data/benchmark-basket-acceptance.md");
const rootPackage = readJson("package.json");
const ciWorkflow = readText(".github/workflows/ci.yml");

assert.match(registryDoc, /technical accessibility and reuse permission as separate facts/i);
assert.match(killSwitchDoc, /disable first and investigate second/i);
assert.match(killSwitchDoc, /source\.kassalapp\.enabled/);
assert.match(classificationAdr, /Historical comparison.*not a promotion/is);
assert.match(classificationAdr, /at least seven distinct days/i);
assert.match(scopeAdr, /candidate_unverified/);
assert.match(scopeAdr, /among verified prices/i);
assert.match(familyTaxonomyDoc, /defines vocabulary only/i);
assert.match(familyTaxonomyDoc, /does not contain product memberships/i);
assert.match(familyTaxonomyDoc, /does not enable flexible matching/i);
assert.match(basketAcceptanceDoc, /Exit codes are fail-closed/i);
assert.match(basketAcceptanceDoc, /exit code `2` is never a soft pass/i);
assert.match(basketAcceptanceDoc, /at most three stores/i);
assert.match(basketAcceptanceDoc, /There are no candidate-supplied `passed` booleans/i);
assert.match(basketAcceptanceDoc, /runner-owned bounded V2 snapshot/i);
assert.match(basketAcceptanceDoc, /independent V2 enumeration/i);
assert.match(basketAcceptanceDoc, /appliedOfferEvidenceId/);
assert.match(basketAcceptanceDoc, /cheaper program-B offer remains ineligible/i);
assert.match(basketAcceptanceDoc, /noncanonical program set fail/i);
assert.match(basketAcceptanceDoc, /--runner-attestation/);
assert.match(basketAcceptanceDoc, /launch-coverage-incomplete/);
assert.match(basketAcceptanceDoc, /--verify-report/);
assert.match(basketAcceptanceDoc, /current pending corpus still returns `2`/i);
assert.equal(
  rootPackage.scripts["validate:v1-data"],
  "node tests/acceptance/validate-v1-data.mjs",
);
assert.equal(
  rootPackage.scripts["acceptance:v1-baskets:check"],
  "node tests/acceptance/check-v1-baskets.mjs",
);
assert.equal(
  rootPackage.scripts["acceptance:v1-baskets:test"],
  "node --test tests/acceptance/v1-basket-runner.test.mjs",
);
assert.match(
  ciWorkflow,
  /- name: Validate V1 data\s+run: corepack pnpm validate:v1-data/,
);

console.log("V1 data acceptance validation passed", {
  sources: registry.sources.length,
  sourceStates,
  regions: coverage.candidateRegions.length,
  coverageCells: coverage.coverage.length,
  scenarios: corpus.scenarios.length,
  benchmarkRuns: corpus.runs.length,
  reviewedFamilies: familyTaxonomy.families.length,
  familyTaxonomyVersion: familyTaxonomy.versionId,
});
