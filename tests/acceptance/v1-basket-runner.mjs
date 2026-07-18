import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { enumerateBoundedUniverseV2 } from "./v1-basket-oracle-v2.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const candidateSchema = JSON.parse(
  readFileSync(resolve(root, "docs/data/benchmark-basket-candidate.v1.schema.json"), "utf8"),
);
const protocolSchema = JSON.parse(
  readFileSync(resolve(root, "docs/data/benchmark-basket-protocol.v1.schema.json"), "utf8"),
);
const reportSchema = JSON.parse(
  readFileSync(resolve(root, "docs/data/benchmark-basket-report.v1.schema.json"), "utf8"),
);
const runnerAttestationSchema = JSON.parse(
  readFileSync(
    resolve(root, "docs/data/benchmark-basket-runner-attestation.v2.schema.json"),
    "utf8",
  ),
);
const corpusSchema = JSON.parse(
  readFileSync(resolve(root, "docs/data/benchmark-baskets.v1.schema.json"), "utf8"),
);
const sourceRegistrySchema = JSON.parse(
  readFileSync(resolve(root, "docs/data/source-registry.v1.schema.json"), "utf8"),
);
const launchCoverageSchema = JSON.parse(
  readFileSync(resolve(root, "docs/data/launch-coverage.v1.schema.json"), "utf8"),
);

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(protocolSchema);
const validateCandidateDocument = ajv.compile(candidateSchema);
const validateReportDocument = ajv.compile(reportSchema);
const validateCorpusDocument = ajv.compile(corpusSchema);
const validateSourceRegistryDocument = ajv.compile(sourceRegistrySchema);
const validateLaunchCoverageDocument = ajv.compile(launchCoverageSchema);
const validateRunnerAttestationDocument = ajv.compile(runnerAttestationSchema);

const PRICE_CLASSES = ["official_offer", "ordinary"];
const EXPECTED_CHAIN_IDS = ["bunnpris", "extra", "rema-1000"];
const EXPECTED_REGION_IDS = [
  "no-0301-oslo",
  "no-4601-bergen",
  "no-5001-trondheim",
];
const MANUAL_RECONCILIATIONS_PER_REGION = 5;
const EXPECTED_RUN_COUNT = 60;
const MAX_STORES = 3;
const MAX_QUANTITY_OPTIONS_PER_NEED = 12;
const PROTOCOL_VERSION = "2.0.0";
const RUNNER_IMPLEMENTATION_ID = "handleplan-independent-basket-oracle-v2";
const RUNNER_IMPLEMENTATION_DIGEST = `sha256:${createHash("sha256")
  .update(readFileSync(resolve(here, "v1-basket-oracle-v2.mjs")))
  .digest("hex")}`;
const PRICE_ONLY_P95_BUDGET_MS = 2_500;
const REQUIRED_NEGATIVE_CONTROLS = [
  "ineligible-source",
  "known-not-carried",
  "partial-coverage",
  "stale-price",
  "wrong-region",
];
const FOCUS_REQUIREMENTS = Object.freeze({
  category_coverage: ["category-coverage"],
  complete_plan: ["quantity", "reviewed-match", "frontier-valid"],
  complete_quantities: ["quantity"],
  constraint_enforcement: ["constraint-rejection"],
  coverage_unknowns: ["negative-partial"],
  cross_chain_coverage: ["complete-launch-coverage", "frontier-three"],
  deposit_disclosure: ["selected-deposit"],
  dietary_constraint: ["constraint-rejection"],
  flexible_matching: ["reviewed-match"],
  fresh_and_shelf_stable: ["category-coverage", "reviewed-match"],
  fresh_vs_frozen_substitution: ["constraint-rejection"],
  frontier_endpoints: ["frontier-three"],
  frozen_constraint: ["constraint-rejection"],
  generic_family_matching: ["reviewed-match"],
  historical_vs_official: [
    "history",
    "trusted-history-window",
    "offer-applied",
    "offer-aware-plan",
  ],
  ineligible_evidence: ["negative-ineligible"],
  known_not_carried_evidence: ["negative-not-carried"],
  large_required_quantity: ["quantity"],
  maximum_three_stores: ["frontier-valid"],
  member_eligibility: [
    "member-on-off",
    "member-program-isolation",
    "offer-aware-plan",
  ],
  mixed_units: ["quantity"],
  multi_store_frontier: ["frontier-three"],
  multibuy_remainder: ["multibuy-remainder", "offer-aware-plan"],
  no_silent_substitution: ["review-required"],
  non_food_categories: ["category-coverage"],
  nondominated_frontier: ["frontier-three"],
  offer_conditions: ["offer-applied", "offer-aware-plan"],
  offer_expiry: ["negative-expired-offer"],
  ordinary_price_coverage: ["complete-launch-coverage"],
  package_count: ["quantity"],
  package_rounding: ["surplus"],
  package_size_tradeoff: ["package-tradeoff"],
  package_surplus: ["surplus"],
  performance: ["performance"],
  piece_and_volume_units: ["quantity"],
  piece_and_weight_units: ["quantity"],
  quantity_fulfilment: ["quantity"],
  review_required_matches: ["review-required"],
  reviewed_families: ["reviewed-match"],
  savings_context: [
    "history",
    "trusted-history-window",
    "positive-savings",
    "offer-aware-plan",
  ],
  savings_endpoint: ["positive-savings", "offer-aware-plan"],
  single_store_plan: ["frontier-one"],
  substitution_explanation: ["match-explanation"],
  substitution_safety: ["review-required", "constraint-rejection"],
  unit_price: ["unit-rate"],
  variable_weight_disclosure: [
    "selected-variable-weight",
    "trusted-variable-weight-measurement",
  ],
  weight_normalization: ["quantity"],
  weight_units: ["quantity"],
  whole_packages: ["quantity"],
});

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalWithoutId(value) {
  const { id: _id, ...body } = value;
  return body;
}

export function canonicalizeJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(",")}]`;

  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort(compareText)
    .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`)
    .join(",")}}`;
}

export function sha256Canonical(value) {
  return `sha256:${createHash("sha256").update(canonicalizeJson(value), "utf8").digest("hex")}`;
}

function deterministicId(prefix, payload) {
  return `${prefix}:${sha256Canonical(payload)}`;
}

export function candidateIdFor({ candidate, bindings, execution }) {
  return deterministicId("candidate", {
    ...canonicalWithoutId(candidate),
    bindings,
    execution,
  });
}

export function priceEvidenceIdFor(evidence) {
  return deterministicId("price-evidence", canonicalWithoutId(evidence));
}

export function storeEvidenceIdFor(evidence) {
  return deterministicId("store-evidence", canonicalWithoutId(evidence));
}

export function matchEvidenceIdFor(evidence) {
  return deterministicId("match-evidence", canonicalWithoutId(evidence));
}

export function reconciliationIdFor(reconciliation) {
  return deterministicId("reconciliation", canonicalWithoutId(reconciliation));
}

export function reconciliationEvidenceDigestFor({
  evaluatedAt,
  priceEvidenceIds,
  runId,
  storeEvidenceIds,
}) {
  return sha256Canonical({
    evaluatedAt,
    priceEvidenceIds: [...priceEvidenceIds].sort(compareText),
    runId,
    storeEvidenceIds: [...storeEvidenceIds].sort(compareText),
  });
}

export function availabilityEvidenceIdFor(evidence) {
  return deterministicId("availability-evidence", canonicalWithoutId(evidence));
}

export function protocolCaseIdFor(protocolCase) {
  return deterministicId("protocol-case", canonicalWithoutId(protocolCase));
}

export function frontierPlanIdFor(plan) {
  return deterministicId("frontier-plan", canonicalWithoutId(plan));
}

export function protocolEvidenceIdFor(protocol) {
  return deterministicId("protocol-evidence", canonicalWithoutId(protocol));
}

export function planIdFor(run) {
  return deterministicId("plan", {
    assignments: run.plan.assignments,
    comparisonScope: run.comparisonScope,
    evaluatedAt: run.evaluatedAt,
    runId: run.runId,
    stores: run.plan.stores,
    totalOre: run.plan.totalOre,
  });
}

export function benchmarkBindings({ corpus, sourceRegistry, launchCoverage }) {
  return {
    corpusVersion: corpus.corpusVersion,
    corpusDigest: sha256Canonical(corpus),
    sourceRegistryVersion: sourceRegistry.registryVersion,
    sourceRegistryDigest: sha256Canonical(sourceRegistry),
    launchCoverageVersion: launchCoverage.manifestVersion,
    launchCoverageDigest: sha256Canonical(launchCoverage),
  };
}

function sameJson(left, right) {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sortedUnique(values) {
  return [...new Set(values)].sort(compareText);
}

function hasUnique(values) {
  return new Set(values).size === values.length;
}

function isSafePositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function coverageKey({ chainId, priceClass }) {
  return `${chainId}/${priceClass}`;
}

function issue(code, severity, scope = {}) {
  return { code, severity, ...scope };
}

function sortIssues(issues) {
  const unique = new Map();
  for (const candidate of issues) {
    const key = canonicalizeJson(candidate);
    unique.set(key, candidate);
  }
  return [...unique.values()].sort((left, right) =>
    compareText(left.severity, right.severity)
    || compareText(left.code, right.code)
    || compareText(left.regionId ?? "", right.regionId ?? "")
    || compareText(left.runId ?? "", right.runId ?? ""));
}

function statusForIssues(issues) {
  if (issues.some(({ severity }) => severity === "failed")) return "failed";
  if (issues.some(({ severity }) => severity === "blocked")) return "blocked";
  if (issues.some(({ severity }) => severity === "pending")) return "pending";
  return "passed";
}

function sourceCanRank(source) {
  return source?.runtimeState === "approved"
    && source.publicRankingEligible === true
    && sourceRightsResolved(source);
}

function sourceRightsResolved(source) {
  const rights = source?.rights;
  if (rights === undefined) return false;
  const strictlyPermitted = ["access", "processing", "retention", "derivedDisplay"];
  if (strictlyPermitted.some((key) => rights[key] !== "permitted")) return false;
  const permittedOrUnused = ["redistribution", "imagery", "marks"];
  if (permittedOrUnused.some((key) => !["permitted", "not_applicable"].includes(rights[key]))) {
    return false;
  }
  return ["permitted", "required", "not_applicable"].includes(rights.attribution);
}

function sourceSupportsPriceClass(source, priceClass) {
  const requiredDataClass = priceClass === "ordinary"
    ? "ordinary_price_observation"
    : "official_offer";
  return Array.isArray(source?.dataClasses) && source.dataClasses.includes(requiredDataClass);
}

function sourceSupportsHistorical(source) {
  return Array.isArray(source?.dataClasses) && source.dataClasses.includes("price_history");
}

function manifestCellCanRank(cell, sourceById, enabledSourceIds) {
  const source = typeof cell?.activeSourceId === "string"
    ? sourceById.get(cell.activeSourceId)
    : undefined;
  return cell?.launchEligible === true
    && cell.coverageStatus === "verified"
    && cell.evidenceLevel === "rights_cleared_measured"
    && typeof cell.activeSourceId === "string"
    && sourceCanRank(source)
    && sourceSupportsPriceClass(source, cell.priceClass)
    && enabledSourceIds.has(cell.activeSourceId);
}

function storeEvidenceCanBind(evidence, sourceById, enabledSourceIds) {
  const source = sourceById.get(evidence.sourceId);
  return sourceCanRank(source)
    && source.dataClasses.includes("physical_store")
    && enabledSourceIds.has(evidence.sourceId);
}

function availabilityEvidenceCanBind(evidence, sourceById, enabledSourceIds) {
  const source = sourceById.get(evidence.sourceId);
  return sourceCanRank(source)
    && source.dataClasses.includes("store_availability")
    && enabledSourceIds.has(evidence.sourceId);
}

function expectedScopeEntries({ regionId, requiredChainIds, cellsByKey, sourceById, enabledSourceIds }) {
  return requiredChainIds.flatMap((chainId) => PRICE_CLASSES.map((priceClass) => {
    const cell = cellsByKey.get(`${regionId}/${chainId}/${priceClass}`);
    if (manifestCellCanRank(cell, sourceById, enabledSourceIds)) {
      return { chainId, priceClass, state: "verified", sourceId: cell.activeSourceId };
    }
    return { chainId, priceClass, state: "unresolved" };
  })).sort((left, right) => compareText(coverageKey(left), coverageKey(right)));
}

function validateScope(run, context) {
  const issues = [];
  const expected = expectedScopeEntries({
    regionId: run.regionId,
    ...context,
  });
  const expectedQualification = expected.every(({ state }) => state === "verified")
    ? "declared-complete-coverage"
    : "among-verified-prices";
  const hasVerifiedEvidence = expected.some(({ state }) => state === "verified");
  const mismatchSeverity = hasVerifiedEvidence ? "failed" : "blocked";

  if (!sameJson(run.comparisonScope.entries, expected)) {
    issues.push(issue("coverage-scope-mismatch", mismatchSeverity, { runId: run.runId }));
  }
  if (run.comparisonScope.qualification !== expectedQualification) {
    issues.push(issue("coverage-qualification-mismatch", mismatchSeverity, { runId: run.runId }));
  }
  if (!hasVerifiedEvidence) {
    issues.push(issue("no-eligible-live-evidence", "blocked", {
      regionId: run.regionId,
      runId: run.runId,
    }));
  }

  return { expected, issues };
}

function timestampInEvidenceWindow(evidence, evaluatedAt, refreshTargetHours) {
  const evaluatedMs = Date.parse(evaluatedAt);
  const observedMs = Date.parse(evidence.observedAt);
  if (observedMs > evaluatedMs) return false;
  if (evaluatedMs - observedMs > refreshTargetHours * 60 * 60 * 1_000) return false;
  if (evidence.validFrom !== undefined && evaluatedMs < Date.parse(evidence.validFrom)) return false;
  if (evidence.validUntil !== undefined && evaluatedMs > Date.parse(evidence.validUntil)) return false;
  return evidence.validFrom === undefined
    || evidence.validUntil === undefined
    || Date.parse(evidence.validFrom) <= Date.parse(evidence.validUntil);
}

function geographicScopeIncludes(scope, regionId, storeId) {
  if (scope.kind === "national") return scope.countryCode === "NO";
  if (scope.kind === "region") return scope.regionId === regionId;
  return scope.regionId === regionId && scope.storeId === storeId;
}

function storeEvidenceIsCurrent(evidence, evaluatedAt) {
  const evaluatedMs = Date.parse(evaluatedAt);
  const observedMs = Date.parse(evidence.observedAt);
  if (observedMs > evaluatedMs) return false;
  if (evidence.validFrom !== undefined && evaluatedMs < Date.parse(evidence.validFrom)) return false;
  if (evaluatedMs > Date.parse(evidence.validUntil)) return false;
  return evidence.validFrom === undefined
    || Date.parse(evidence.validFrom) <= Date.parse(evidence.validUntil);
}

function safeMultiply(left, right) {
  const value = left * right;
  return Number.isSafeInteger(value) ? value : undefined;
}

function safeSum(values) {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) return undefined;
  }
  return total;
}

function greatestCommonDivisor(left, right) {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function exactIdOrder(records) {
  const ids = records.map(({ id }) => id);
  return hasUnique(ids) && sameStrings(ids, [...ids].sort(compareText));
}

function resolvedDepositOre(evidence) {
  return evidence.depositPerPackageOre ?? 0;
}

function priceEvidenceCanBindToRun(evidence, run, storeId, evaluatedAt, context) {
  if (evidence === undefined || evidence.priceClass === "historical") return false;
  const cell = context.cellsByKey.get(
    `${run.regionId}/${evidence.chainId}/${evidence.priceClass}`,
  );
  return manifestCellCanRank(cell, context.sourceById, context.enabledSourceIds)
    && cell.activeSourceId === evidence.sourceId
    && geographicScopeIncludes(evidence.geographicScope, run.regionId, storeId)
    && timestampInEvidenceWindow(evidence, evaluatedAt, cell.refreshTargetHours);
}

function historicalEvidenceCanBind(evidence, run, storeId, evaluatedAt, context) {
  const source = evidence === undefined ? undefined : context.sourceById.get(evidence.sourceId);
  return evidence?.priceClass === "historical"
    && sourceCanRank(source)
    && sourceSupportsHistorical(source)
    && context.enabledSourceIds.has(evidence.sourceId)
    && geographicScopeIncludes(evidence.geographicScope, run.regionId, storeId)
    && Date.parse(evidence.observedAt) <= Date.parse(evaluatedAt)
    && (evidence.validFrom === undefined
      || Date.parse(evidence.validFrom) <= Date.parse(evaluatedAt))
    && (evidence.validUntil === undefined
      || Date.parse(evidence.validUntil) >= Date.parse(evaluatedAt));
}

function sameProductPriceFacts(left, right) {
  return left !== undefined
    && right !== undefined
    && left.chainId === right.chainId
    && left.canonicalProductId === right.canonicalProductId
    && left.packageBaseUnits === right.packageBaseUnits
    && left.unit === right.unit
    && resolvedDepositOre(left) === resolvedDepositOre(right);
}

function assignmentPricingFacts(
  assignment,
  run,
  context,
  enabledMembershipProgramIds,
) {
  const ordinary = context.priceEvidenceById.get(assignment.priceEvidenceId);
  if (
    ordinary?.priceClass !== "ordinary"
    || !priceEvidenceCanBindToRun(
      ordinary,
      run,
      assignment.storeId,
      run.evaluatedAt,
      context,
    )
  ) return undefined;
  const ordinaryMerchandiseOre = safeMultiply(ordinary.amountOre, assignment.packageCount);
  const depositOre = safeMultiply(resolvedDepositOre(ordinary), assignment.packageCount);
  if (ordinaryMerchandiseOre === undefined || depositOre === undefined) return undefined;
  const ordinaryCostOre = safeSum([ordinaryMerchandiseOre, depositOre]);
  if (ordinaryCostOre === undefined) return undefined;
  if (assignment.appliedOfferEvidenceId === null) {
    return {
      appliedOfferEvidenceId: null,
      ordinaryCostOre,
      costOre: ordinaryCostOre,
    };
  }
  const offer = context.priceEvidenceById.get(assignment.appliedOfferEvidenceId);
  if (
    offer?.priceClass !== "official_offer"
    || offer.offerTerms === undefined
    || offer.offerTerms.minimumPackages < offer.offerTerms.bundleSize
    || !sameProductPriceFacts(ordinary, offer)
    || !priceEvidenceCanBindToRun(
      offer,
      run,
      assignment.storeId,
      run.evaluatedAt,
      context,
    )
    || (offer.offerTerms.membershipRequirement === "required"
      && !enabledMembershipProgramIds.includes(offer.offerTerms.membershipProgramId))
    || assignment.packageCount < offer.offerTerms.minimumPackages
    || assignment.packageCount < offer.offerTerms.bundleSize
  ) return undefined;
  const bundleCount = Math.floor(assignment.packageCount / offer.offerTerms.bundleSize);
  const remainderCount = assignment.packageCount % offer.offerTerms.bundleSize;
  const bundleTotalOre = safeMultiply(bundleCount, offer.amountOre);
  const remainderTotalOre = safeMultiply(remainderCount, ordinary.amountOre);
  const merchandiseOre = bundleTotalOre === undefined || remainderTotalOre === undefined
    ? undefined
    : safeSum([bundleTotalOre, remainderTotalOre]);
  const costOre = merchandiseOre === undefined ? undefined : safeSum([merchandiseOre, depositOre]);
  if (costOre === undefined || costOre >= ordinaryCostOre) return undefined;
  return {
    appliedOfferEvidenceId: offer.id,
    ordinaryCostOre,
    costOre,
  };
}

function matchCanSatisfyNeed(match, need, run) {
  if (
    match.runId !== run.runId
    || match.needId !== need.needId
    || match.unit !== need.requiredAmount.unit
    || Date.parse(match.reviewedAt) > Date.parse(run.evaluatedAt)
  ) return false;
  if (
    need.identity.kind === "exact-product"
    && match.canonicalProductId !== need.identity.canonicalProductId
  ) return false;
  const declared = new Set(match.declaredConstraints);
  return need.constraints.every((constraint) => declared.has(constraint));
}

function quantityFactsFor(need, price) {
  const packageCount = need.requiredAmount.unit === "package"
    ? need.requiredAmount.value
    : Math.ceil(need.requiredAmount.value / price.packageBaseUnits);
  const purchasedBaseUnits = need.requiredAmount.unit === "package"
    ? packageCount
    : safeMultiply(packageCount, price.packageBaseUnits);
  const merchandiseTotalOre = safeMultiply(packageCount, price.amountOre);
  const depositTotalOre = safeMultiply(packageCount, resolvedDepositOre(price));
  const checkoutTotalOre = merchandiseTotalOre === undefined || depositTotalOre === undefined
    ? undefined
    : safeSum([merchandiseTotalOre, depositTotalOre]);
  const divisor = greatestCommonDivisor(price.amountOre, price.packageBaseUnits);
  return {
    packageCount,
    purchasedBaseUnits,
    surplusBaseUnits: purchasedBaseUnits === undefined
      ? undefined
      : need.requiredAmount.unit === "package"
        ? 0
        : purchasedBaseUnits - need.requiredAmount.value,
    merchandiseTotalOre,
    depositTotalOre,
    checkoutTotalOre,
    unitRate: {
      numeratorOre: price.amountOre / divisor,
      denominatorBaseUnits: price.packageBaseUnits / divisor,
    },
  };
}

function eligibleQuantityUniverse(need, run, assignment, context) {
  const matches = [...context.matchEvidenceById.values()].filter((match) =>
    matchCanSatisfyNeed(match, need, run));
  const prices = [...context.priceEvidenceById.values()].filter((price) =>
    price.priceClass === "ordinary"
    && price.chainId === assignment.chainId
    && price.unit === need.requiredAmount.unit
    && priceEvidenceCanBindToRun(
      price,
      run,
      assignment.storeId,
      run.evaluatedAt,
      context,
    ));
  return matches.flatMap((match) => prices
    .filter((price) => price.canonicalProductId === match.canonicalProductId)
    .map((price) => ({
      key: `${price.id}/${match.id}`,
      match,
      price,
      facts: quantityFactsFor(need, price),
    })))
    .sort((left, right) => compareText(left.key, right.key));
}

function validateQuantityCases(scenario, run, protocol, context, references, features) {
  const issues = [];
  if (!exactIdOrder(protocol.quantityCases)) {
    issues.push(issue("protocol-cases-not-unique-canonical", "failed", { runId: run.runId }));
  }
  const expectedNeedIds = scenario.items.map(({ needId }) => needId).sort(compareText);
  const actualNeedIds = protocol.quantityCases.map(({ needId }) => needId).sort(compareText);
  if (!hasUnique(actualNeedIds) || !sameStrings(actualNeedIds, expectedNeedIds)) {
    issues.push(issue("protocol-quantity-case-set-mismatch", "failed", { runId: run.runId }));
  }
  const needById = new Map(scenario.items.map((need) => [need.needId, need]));
  const assignmentByNeed = new Map(run.plan.assignments.map((assignment) => [
    assignment.needId,
    assignment,
  ]));

  for (const quantityCase of protocol.quantityCases) {
    if (quantityCase.id !== protocolCaseIdFor(quantityCase)) {
      issues.push(issue("protocol-case-id-nondeterministic", "failed", { runId: run.runId }));
    }
    const need = needById.get(quantityCase.needId);
    const assignment = assignmentByNeed.get(quantityCase.needId);
    const optionIds = quantityCase.options.map(({ id }) => id);
    if (
      need === undefined
      || assignment === undefined
      || !hasUnique(optionIds)
      || !sameStrings(optionIds, [...optionIds].sort(compareText))
    ) {
      issues.push(issue("protocol-quantity-binding-mismatch", "failed", { runId: run.runId }));
      continue;
    }
    const expectedUniverse = eligibleQuantityUniverse(
      need,
      run,
      assignment,
      context,
    );
    for (const expected of expectedUniverse) {
      references.price.add(expected.price.id);
      references.match.add(expected.match.id);
    }
    if (expectedUniverse.length > MAX_QUANTITY_OPTIONS_PER_NEED) {
      issues.push(issue("protocol-quantity-universe-over-limit", "blocked", {
        runId: run.runId,
      }));
      continue;
    }
    const expectedOptionKeys = expectedUniverse.map(({ key }) => key);
    const suppliedOptionKeys = quantityCase.options.map((option) =>
      `${option.priceEvidenceId}/${option.matchEvidenceId}`).sort(compareText);
    if (!hasUnique(suppliedOptionKeys) || !sameStrings(suppliedOptionKeys, expectedOptionKeys)) {
      issues.push(issue("protocol-quantity-option-set-incomplete", "failed", {
        runId: run.runId,
      }));
    }
    const expectedByKey = new Map(expectedUniverse.map((entry) => [entry.key, entry]));
    const validOptions = [];
    for (const option of quantityCase.options) {
      const price = context.priceEvidenceById.get(option.priceEvidenceId);
      const match = context.matchEvidenceById.get(option.matchEvidenceId);
      const expectedEntry = expectedByKey.get(`${option.priceEvidenceId}/${option.matchEvidenceId}`);
      references.price.add(option.priceEvidenceId);
      references.match.add(option.matchEvidenceId);
      if (
        expectedEntry === undefined
        || price?.priceClass !== "ordinary"
        || price.chainId !== assignment.chainId
        || match === undefined
        || match.canonicalProductId !== price.canonicalProductId
      ) {
        issues.push(issue("protocol-quantity-evidence-invalid", "failed", { runId: run.runId }));
        continue;
      }
      const expected = expectedEntry.facts;
      if (Object.values(expected).some((value) => value === undefined)
        || !sameJson({
          packageCount: option.packageCount,
          purchasedBaseUnits: option.purchasedBaseUnits,
          surplusBaseUnits: option.surplusBaseUnits,
          merchandiseTotalOre: option.merchandiseTotalOre,
          depositTotalOre: option.depositTotalOre,
          checkoutTotalOre: option.checkoutTotalOre,
          unitRate: option.unitRate,
        }, expected)) {
        issues.push(issue("protocol-quantity-arithmetic-mismatch", "failed", { runId: run.runId }));
        continue;
      }
      validOptions.push({ option, price, match });
      features.add("unit-rate");
      if (option.surplusBaseUnits > 0) features.add("surplus");
      if (price.packageKind === "variable-weight") features.add("variable-weight");
      if (resolvedDepositOre(price) > 0) features.add("deposit");
    }
    const selected = [...validOptions].sort((left, right) =>
      left.option.checkoutTotalOre - right.option.checkoutTotalOre
      || left.option.surplusBaseUnits - right.option.surplusBaseUnits
      || compareText(left.price.id, right.price.id)
      || compareText(left.match.id, right.match.id))[0];
    if (
      selected === undefined
      || quantityCase.selectedOptionId !== selected.option.id
      || selected.option.priceEvidenceId !== assignment.priceEvidenceId
      || selected.option.matchEvidenceId !== assignment.matchEvidenceId
      || selected.option.packageCount !== assignment.packageCount
      || selected.option.purchasedBaseUnits !== assignment.purchasedBaseUnits
      || selected.option.checkoutTotalOre !== assignment.ordinaryCostOre
    ) {
      issues.push(issue("protocol-quantity-selection-mismatch", "failed", { runId: run.runId }));
    }
    if (selected !== undefined && resolvedDepositOre(selected.price) > 0) {
      features.add("selected-deposit");
    }
    if (selected?.price.packageKind === "variable-weight") {
      features.add("selected-variable-weight");
    }
    if (new Set(validOptions.map(({ price }) => price.packageBaseUnits)).size > 1) {
      features.add("package-tradeoff");
    }
  }
  if (issues.length === 0) features.add("quantity");
  return issues;
}

function expectedPricingActual(pricingCase, ordinary, offer, historical) {
  const ordinaryTotalOre = safeMultiply(ordinary.amountOre, pricingCase.packageCount);
  const depositTotalOre = safeMultiply(
    resolvedDepositOre(ordinary),
    pricingCase.packageCount,
  );
  if (ordinaryTotalOre === undefined || depositTotalOre === undefined) return undefined;
  let bundleCount = 0;
  let remainderCount = pricingCase.packageCount;
  let merchandiseTotalOre = ordinaryTotalOre;
  let offerState = "absent";
  let appliedPriceClass = "ordinary";
  if (offer !== undefined) {
    const terms = offer.offerTerms;
    const membershipEligible = terms.membershipRequirement === "none"
      || pricingCase.enabledMembershipProgramIds.includes(terms.membershipProgramId);
    const timeEligible = (offer.validFrom === undefined
      || Date.parse(pricingCase.evaluatedAt) >= Date.parse(offer.validFrom))
      && (offer.validUntil === undefined
        || Date.parse(pricingCase.evaluatedAt) <= Date.parse(offer.validUntil));
    const conditionEligible = pricingCase.packageCount >= terms.minimumPackages
      && pricingCase.packageCount >= terms.bundleSize;
    if (membershipEligible && timeEligible && conditionEligible) {
      bundleCount = Math.floor(pricingCase.packageCount / terms.bundleSize);
      remainderCount = pricingCase.packageCount % terms.bundleSize;
      const bundleTotal = safeMultiply(bundleCount, offer.amountOre);
      const remainderTotal = safeMultiply(remainderCount, ordinary.amountOre);
      const offeredTotal = bundleTotal === undefined || remainderTotal === undefined
        ? undefined
        : safeSum([bundleTotal, remainderTotal]);
      if (offeredTotal === undefined) return undefined;
      if (offeredTotal < ordinaryTotalOre) {
        merchandiseTotalOre = offeredTotal;
        offerState = "applied";
        appliedPriceClass = "official_offer";
      } else {
        offerState = "eligible-not-cheaper";
      }
    } else {
      offerState = "ineligible";
    }
  }
  const checkoutTotalOre = safeSum([merchandiseTotalOre, depositTotalOre]);
  if (checkoutTotalOre === undefined) return undefined;
  return {
    offerState,
    appliedPriceClass,
    bundleCount,
    remainderCount,
    ordinaryTotalOre,
    merchandiseTotalOre,
    depositTotalOre,
    checkoutTotalOre,
    officialSavingsOre: ordinaryTotalOre - merchandiseTotalOre,
    historicalUnitDifferenceOre: historical === undefined
      ? null
      : ordinary.amountOre - historical.amountOre,
  };
}

function validatePricingCases(scenario, run, protocol, context, references, features) {
  const issues = [];
  if (!exactIdOrder(protocol.pricingCases)) {
    issues.push(issue("protocol-cases-not-unique-canonical", "failed", { runId: run.runId }));
  }
  const needById = new Map(scenario.items.map((need) => [need.needId, need]));
  const assignmentByNeed = new Map(run.plan.assignments.map((assignment) => [
    assignment.needId,
    assignment,
  ]));
  const memberPairKeys = new Map();
  for (const pricingCase of protocol.pricingCases) {
    if (pricingCase.id !== protocolCaseIdFor(pricingCase)) {
      issues.push(issue("protocol-case-id-nondeterministic", "failed", { runId: run.runId }));
    }
    const need = needById.get(pricingCase.needId);
    const assignment = assignmentByNeed.get(pricingCase.needId);
    const ordinary = context.priceEvidenceById.get(pricingCase.ordinaryPriceEvidenceId);
    const offer = pricingCase.officialOfferEvidenceId === undefined
      ? undefined
      : context.priceEvidenceById.get(pricingCase.officialOfferEvidenceId);
    const historical = pricingCase.historicalPriceEvidenceId === undefined
      ? undefined
      : context.priceEvidenceById.get(pricingCase.historicalPriceEvidenceId);
    references.price.add(pricingCase.ordinaryPriceEvidenceId);
    if (pricingCase.officialOfferEvidenceId !== undefined) {
      references.price.add(pricingCase.officialOfferEvidenceId);
    }
    if (pricingCase.historicalPriceEvidenceId !== undefined) {
      references.price.add(pricingCase.historicalPriceEvidenceId);
    }
    if (
      need === undefined
      || assignment === undefined
      || !hasUnique(pricingCase.enabledMembershipProgramIds)
      || !sameStrings(
        pricingCase.enabledMembershipProgramIds,
        [...pricingCase.enabledMembershipProgramIds].sort(compareText),
      )
      || pricingCase.evaluatedAt !== run.evaluatedAt
      || pricingCase.ordinaryPriceEvidenceId !== assignment.priceEvidenceId
      || pricingCase.packageCount !== assignment.packageCount
      || ordinary?.priceClass !== "ordinary"
      || ordinary.unit !== need.requiredAmount.unit
      || !priceEvidenceCanBindToRun(ordinary, run, assignment.storeId, pricingCase.evaluatedAt, context)
      || (offer !== undefined && (
        offer.priceClass !== "official_offer"
        || offer.offerTerms === undefined
        || offer.offerTerms.minimumPackages < offer.offerTerms.bundleSize
        || !sameProductPriceFacts(ordinary, offer)
        || !priceEvidenceCanBindToRun(offer, run, assignment.storeId, run.evaluatedAt, context)
      ))
      || (historical !== undefined && (
        !sameProductPriceFacts(ordinary, historical)
        || !historicalEvidenceCanBind(
          historical,
          run,
          assignment.storeId,
          pricingCase.evaluatedAt,
          context,
        )
      ))
    ) {
      issues.push(issue("protocol-pricing-evidence-invalid", "failed", { runId: run.runId }));
      continue;
    }
    const expected = expectedPricingActual(pricingCase, ordinary, offer, historical);
    if (expected === undefined || !sameJson(pricingCase.actual, expected)) {
      issues.push(issue("protocol-pricing-arithmetic-mismatch", "failed", { runId: run.runId }));
      continue;
    }
    if (expected.offerState === "applied") {
      features.add("offer-applied");
      if (expected.officialSavingsOre > 0) features.add("positive-savings");
      if (offer.offerTerms.bundleSize > 1 && expected.remainderCount > 0) {
        features.add("multibuy-remainder");
      }
    }
    if (historical !== undefined) features.add("history");
    if (offer?.offerTerms.membershipRequirement === "required") {
      const programEnabled = pricingCase.enabledMembershipProgramIds.includes(
        offer.offerTerms.membershipProgramId,
      );
      const key = [
        pricingCase.needId,
        pricingCase.ordinaryPriceEvidenceId,
        pricingCase.officialOfferEvidenceId,
        pricingCase.packageCount,
        pricingCase.evaluatedAt,
      ].join("\u0000");
      const states = memberPairKeys.get(key) ?? new Set();
      states.add(programEnabled ? "on" : "off");
      memberPairKeys.set(key, states);
      if (pricingCase.enabledMembershipProgramIds.length > 0 && !programEnabled) {
        features.add("member-program-isolation");
      }
    }
  }
  if ([...memberPairKeys.values()].some((states) => states.has("on") && states.has("off"))) {
    features.add("member-on-off");
  }
  return issues;
}

function validateMatchCases(scenario, run, protocol, context, references, features) {
  const issues = [];
  if (!exactIdOrder(protocol.matchCases)) {
    issues.push(issue("protocol-cases-not-unique-canonical", "failed", { runId: run.runId }));
  }
  const needById = new Map(scenario.items.map((need) => [need.needId, need]));
  const selectedNeedIds = new Set();
  for (const matchCase of protocol.matchCases) {
    if (matchCase.id !== protocolCaseIdFor(matchCase)) {
      issues.push(issue("protocol-case-id-nondeterministic", "failed", { runId: run.runId }));
    }
    const need = needById.get(matchCase.needId);
    const evidence = context.matchEvidenceById.get(matchCase.matchEvidenceId);
    references.match.add(matchCase.matchEvidenceId);
    if (
      need === undefined
      || evidence === undefined
      || evidence.runId !== run.runId
      || evidence.needId !== need.needId
      || evidence.unit !== need.requiredAmount.unit
      || (need.identity.kind === "exact-product"
        && evidence.canonicalProductId !== need.identity.canonicalProductId)
      || Date.parse(evidence.reviewedAt) > Date.parse(run.evaluatedAt)
    ) {
      issues.push(issue("protocol-match-evidence-invalid", "failed", { runId: run.runId }));
      continue;
    }
    const declared = new Set(evidence.declaredConstraints);
    const constraintsSatisfied = need.constraints.every((constraint) => declared.has(constraint));
    const expected = !constraintsSatisfied
      ? { state: "rejected", reason: "constraint-mismatch" }
      : matchCase.userDecision === "not-reviewed"
        ? { state: "review-required", reason: "user-approval-required" }
        : {
            state: "selected",
            reason: "eligible-reviewed-candidate",
            explanationCode: need.matchMode === "constrained"
              ? "constraints-satisfied"
              : "reviewed-family-approved",
          };
    if (!sameJson(matchCase.actual, expected)) {
      issues.push(issue("protocol-match-decision-mismatch", "failed", { runId: run.runId }));
      continue;
    }
    if (expected.state === "selected") {
      selectedNeedIds.add(need.needId);
      features.add("reviewed-match");
      features.add("match-explanation");
    } else if (expected.state === "rejected") {
      features.add("constraint-rejection");
    } else {
      features.add("review-required");
    }
  }
  const expectedNeedIds = scenario.items.map(({ needId }) => needId).sort(compareText);
  if (!sameStrings([...selectedNeedIds].sort(compareText), expectedNeedIds)) {
    issues.push(issue("protocol-selected-match-set-incomplete", "failed", { runId: run.runId }));
  }
  return issues;
}

function availabilityEvidenceIsCurrent(evidence, evaluatedAt) {
  const evaluatedMs = Date.parse(evaluatedAt);
  return Date.parse(evidence.observedAt) <= evaluatedMs
    && (evidence.validFrom === undefined || Date.parse(evidence.validFrom) <= evaluatedMs)
    && Date.parse(evidence.validUntil) >= evaluatedMs;
}

function validateNegativeControls(scenario, run, protocol, context, references, features) {
  const issues = [];
  if (!exactIdOrder(protocol.negativeControls)) {
    issues.push(issue("protocol-cases-not-unique-canonical", "failed", { runId: run.runId }));
  }
  const kinds = protocol.negativeControls.map(({ kind }) => kind);
  const requiresExactProductControl = scenario.items.some(({ identity }) =>
    identity.kind === "exact-product");
  if (
    !hasUnique(kinds)
    || !REQUIRED_NEGATIVE_CONTROLS.every((kind) => kinds.includes(kind))
    || (requiresExactProductControl && !kinds.includes("exact-product-mismatch"))
  ) {
    issues.push(issue("protocol-negative-control-set-incomplete", "failed", { runId: run.runId }));
  }
  const assignmentByNeed = new Map(run.plan.assignments.map((assignment) => [
    assignment.needId,
    assignment,
  ]));
  const needById = new Map(scenario.items.map((need) => [need.needId, need]));
  for (const control of protocol.negativeControls) {
    if (control.id !== protocolCaseIdFor(control)) {
      issues.push(issue("protocol-case-id-nondeterministic", "failed", { runId: run.runId }));
    }
    if (control.kind === "stale-price") {
      const evidence = context.priceEvidenceById.get(control.priceEvidenceId);
      references.price.add(control.priceEvidenceId);
      const cell = evidence === undefined || evidence.priceClass === "historical"
        ? undefined
        : context.cellsByKey.get(
          `${run.regionId}/${evidence.chainId}/${evidence.priceClass}`,
        );
      const validBeforeMutation = evidence !== undefined
        && cell !== undefined
        && priceEvidenceCanBindToRun(
          evidence,
          run,
          run.plan.assignments[0].storeId,
          run.evaluatedAt,
          context,
        );
      const expectedActual = validBeforeMutation
        && !timestampInEvidenceWindow(evidence, control.evaluatedAt, cell.refreshTargetHours)
        ? { state: "rejected", reason: "stale" }
        : { state: "selected" };
      if (!sameJson(control.actual, expectedActual)) {
        issues.push(issue("protocol-stale-control-invalid", "failed", { runId: run.runId }));
      } else {
        features.add("negative-stale");
      }
      continue;
    }
    if (control.kind === "wrong-region") {
      const evidence = context.priceEvidenceById.get(control.priceEvidenceId);
      const assignment = run.plan.assignments.find((candidate) =>
        candidate.priceEvidenceId === control.priceEvidenceId
          && evidence?.priceClass === "ordinary"
          && evidence.chainId === candidate.chainId
          && evidence.canonicalProductId === candidate.canonicalProductId
          && evidence.packageBaseUnits === candidate.packageBaseUnits
          && evidence.unit === candidate.unit
          && priceEvidenceCanBindToRun(
            evidence,
            run,
            candidate.storeId,
            run.evaluatedAt,
            context,
          ));
      references.price.add(control.priceEvidenceId);
      const rejected = assignment !== undefined
        && control.requestedRegionId !== run.regionId
        && !geographicScopeIncludes(
          evidence.geographicScope,
          control.requestedRegionId,
          assignment.storeId,
        );
      const expectedActual = { state: "rejected", reason: "wrong-region" };
      if (!rejected || !sameJson(control.actual, expectedActual)) {
        issues.push(issue("protocol-wrong-region-control-invalid", "failed", { runId: run.runId }));
      } else {
        features.add("negative-wrong-region");
      }
      continue;
    }
    if (control.kind === "ineligible-source") {
      const evidence = context.priceEvidenceById.get(control.priceEvidenceId);
      references.price.add(control.priceEvidenceId);
      const enabledAfterMutation = new Set(context.enabledSourceIds);
      enabledAfterMutation.delete(control.disabledSourceId);
      const cell = evidence === undefined || evidence.priceClass === "historical"
        ? undefined
        : context.cellsByKey.get(
          `${run.regionId}/${evidence.chainId}/${evidence.priceClass}`,
        );
      const validBeforeMutation = evidence !== undefined
        && control.disabledSourceId === evidence.sourceId
        && context.enabledSourceIds.has(control.disabledSourceId)
        && manifestCellCanRank(cell, context.sourceById, context.enabledSourceIds);
      const rejected = validBeforeMutation
        && !manifestCellCanRank(cell, context.sourceById, enabledAfterMutation);
      const expectedActual = rejected
        ? { state: "rejected", reason: "source-ineligible" }
        : { state: "selected" };
      if (!sameJson(control.actual, expectedActual)) {
        issues.push(issue("protocol-ineligible-source-control-invalid", "failed", { runId: run.runId }));
      } else {
        features.add("negative-ineligible");
      }
      continue;
    }
    if (control.kind === "partial-coverage") {
      const cell = context.cellsByKey.get(
        `${run.regionId}/${control.disabledCell.chainId}/${control.disabledCell.priceClass}`,
      );
      const expectedActual = manifestCellCanRank(
        cell,
        context.sourceById,
        context.enabledSourceIds,
      )
        ? { state: "partial", qualification: "among-verified-prices" }
        : { state: "unchanged" };
      if (!sameJson(control.actual, expectedActual)) {
        issues.push(issue("protocol-partial-coverage-control-invalid", "failed", { runId: run.runId }));
      } else {
        features.add("negative-partial");
      }
      continue;
    }
    if (control.kind === "known-not-carried") {
      const evidence = context.availabilityEvidenceById.get(control.availabilityEvidenceId);
      const match = context.matchEvidenceById.get(control.matchEvidenceId);
      const need = needById.get(control.needId);
      const storeEvidence = [...context.storeEvidenceById.values()].find((candidate) =>
        candidate.regionId === run.regionId
        && candidate.storeId === evidence?.storeId
        && candidate.chainId === evidence?.chainId);
      references.availability.add(control.availabilityEvidenceId);
      references.match.add(control.matchEvidenceId);
      if (storeEvidence !== undefined) references.store.add(storeEvidence.id);
      const controlIsBound = !(
        need === undefined
        || evidence === undefined
        || match === undefined
        || !matchCanSatisfyNeed(match, need, run)
        || match.canonicalProductId !== evidence.canonicalProductId
        || evidence.state !== "known-not-carried"
        || evidence.regionId !== run.regionId
        || storeEvidence === undefined
        || !storeEvidenceCanBind(
          storeEvidence,
          context.sourceById,
          context.enabledSourceIds,
        )
        || !storeEvidenceIsCurrent(storeEvidence, run.evaluatedAt)
        || run.plan.assignments.some(({ canonicalProductId }) =>
          canonicalProductId === evidence.canonicalProductId)
        || !availabilityEvidenceCanBind(
          evidence,
          context.sourceById,
          context.enabledSourceIds,
        )
        || !availabilityEvidenceIsCurrent(evidence, run.evaluatedAt)
      );
      const expectedActual = controlIsBound
        ? { state: "known-not-carried" }
        : { state: "unknown" };
      if (!sameJson(control.actual, expectedActual)) {
        issues.push(issue("protocol-known-not-carried-control-invalid", "failed", { runId: run.runId }));
      } else {
        features.add("negative-not-carried");
      }
      continue;
    }
    if (control.kind === "exact-product-mismatch") {
      const need = needById.get(control.needId);
      const match = context.matchEvidenceById.get(control.matchEvidenceId);
      references.match.add(control.matchEvidenceId);
      const rejected = need?.identity.kind === "exact-product"
        && match?.runId === run.runId
        && match.needId === need.needId
        && match.canonicalProductId !== need.identity.canonicalProductId;
      const expectedActual = { state: "rejected", reason: "exact-product-mismatch" };
      if (!rejected || !sameJson(control.actual, expectedActual)) {
        issues.push(issue("protocol-exact-product-control-invalid", "failed", {
          runId: run.runId,
        }));
      } else {
        features.add("negative-exact-product");
      }
      continue;
    }
    const offer = context.priceEvidenceById.get(control.officialOfferEvidenceId);
    const eligibleBaseline = protocol.pricingCases.some((pricingCase) => {
      if (pricingCase.officialOfferEvidenceId !== control.officialOfferEvidenceId) return false;
      const assignment = assignmentByNeed.get(pricingCase.needId);
      const ordinary = context.priceEvidenceById.get(pricingCase.ordinaryPriceEvidenceId);
      const historical = pricingCase.historicalPriceEvidenceId === undefined
        ? undefined
        : context.priceEvidenceById.get(pricingCase.historicalPriceEvidenceId);
      const expected = assignment === undefined || ordinary === undefined || offer === undefined
        ? undefined
        : expectedPricingActual(pricingCase, ordinary, offer, historical);
      return assignment !== undefined
        && ordinary?.priceClass === "ordinary"
        && offer?.priceClass === "official_offer"
        && offer.offerTerms !== undefined
        && offer.offerTerms.minimumPackages >= offer.offerTerms.bundleSize
        && pricingCase.evaluatedAt === run.evaluatedAt
        && pricingCase.ordinaryPriceEvidenceId === assignment.priceEvidenceId
        && pricingCase.packageCount === assignment.packageCount
        && sameProductPriceFacts(ordinary, offer)
        && priceEvidenceCanBindToRun(
          ordinary,
          run,
          assignment.storeId,
          run.evaluatedAt,
          context,
        )
        && priceEvidenceCanBindToRun(
          offer,
          run,
          assignment.storeId,
          run.evaluatedAt,
          context,
        )
        && (expected?.offerState === "applied"
          || expected?.offerState === "eligible-not-cheaper");
    });
    references.price.add(control.officialOfferEvidenceId);
    const rejected = eligibleBaseline
      && offer.validUntil !== undefined
      && Date.parse(control.evaluatedAt) > Date.parse(offer.validUntil);
    const expectedActual = { state: "rejected", reason: "offer-expired" };
    if (!rejected || !sameJson(control.actual, expectedActual)) {
      issues.push(issue("protocol-expired-offer-control-invalid", "failed", { runId: run.runId }));
    } else {
      features.add("negative-expired-offer");
    }
  }
  if (!scenario.items.every(({ needId }) => assignmentByNeed.has(needId))) {
    issues.push(issue("complete-basket-violated", "failed", { runId: run.runId }));
  }
  return issues;
}

function validateFrontierPlan(
  plan,
  scenario,
  run,
  context,
  references,
  enabledMembershipProgramIds,
) {
  const issues = [];
  if (plan.id !== frontierPlanIdFor(plan)) {
    issues.push(issue("frontier-plan-id-nondeterministic", "failed", { runId: run.runId }));
  }
  const storeIds = plan.stores.map(({ storeId }) => storeId);
  if (
    !hasUnique(storeIds)
    || !sameStrings(storeIds, [...storeIds].sort(compareText))
    || plan.stores.length < 1
    || plan.stores.length > MAX_STORES
  ) {
    issues.push(issue("frontier-store-set-invalid", "failed", { runId: run.runId }));
  }
  const storeById = new Map(plan.stores.map((store) => [store.storeId, store]));
  for (const store of plan.stores) {
    const evidence = context.storeEvidenceById.get(store.storeEvidenceId);
    references.store.add(store.storeEvidenceId);
    if (
      evidence === undefined
      || evidence.storeId !== store.storeId
      || evidence.chainId !== store.chainId
      || evidence.regionId !== run.regionId
      || store.regionId !== run.regionId
      || !storeEvidenceCanBind(evidence, context.sourceById, context.enabledSourceIds)
      || !storeEvidenceIsCurrent(evidence, run.evaluatedAt)
    ) {
      issues.push(issue("frontier-store-evidence-invalid", "failed", { runId: run.runId }));
    }
  }
  const expectedNeedIds = scenario.items.map(({ needId }) => needId).sort(compareText);
  const assignmentNeedIds = plan.assignments.map(({ needId }) => needId);
  if (!hasUnique(assignmentNeedIds) || !sameStrings(assignmentNeedIds, expectedNeedIds)) {
    issues.push(issue("frontier-complete-basket-violated", "failed", { runId: run.runId }));
  }
  const needById = new Map(scenario.items.map((need) => [need.needId, need]));
  const usedStores = new Set();
  const costs = [];
  for (const assignment of plan.assignments) {
    const need = needById.get(assignment.needId);
    const store = storeById.get(assignment.storeId);
    const price = context.priceEvidenceById.get(assignment.priceEvidenceId);
    const pricing = assignmentPricingFacts(
      assignment,
      run,
      context,
      enabledMembershipProgramIds,
    );
    const match = context.matchEvidenceById.get(assignment.matchEvidenceId);
    references.price.add(assignment.priceEvidenceId);
    if (assignment.appliedOfferEvidenceId !== null) {
      references.price.add(assignment.appliedOfferEvidenceId);
    }
    references.match.add(assignment.matchEvidenceId);
    usedStores.add(assignment.storeId);
    const expectedPurchased = assignment.unit === "package"
      ? assignment.packageCount
      : safeMultiply(assignment.packageCount, assignment.packageBaseUnits);
    if (
      need === undefined
      || store === undefined
      || store.chainId !== assignment.chainId
      || price?.priceClass !== "ordinary"
      || price.chainId !== assignment.chainId
      || price.canonicalProductId !== assignment.canonicalProductId
      || price.packageBaseUnits !== assignment.packageBaseUnits
      || price.unit !== assignment.unit
      || assignment.unit !== need.requiredAmount.unit
      || expectedPurchased !== assignment.purchasedBaseUnits
      || assignment.purchasedBaseUnits < need.requiredAmount.value
      || pricing === undefined
      || pricing.appliedOfferEvidenceId !== assignment.appliedOfferEvidenceId
      || pricing.ordinaryCostOre !== assignment.ordinaryCostOre
      || pricing.costOre !== assignment.costOre
      || match === undefined
      || !matchCanSatisfyNeed(match, need, run)
      || match.canonicalProductId !== assignment.canonicalProductId
      || !priceEvidenceCanBindToRun(price, run, assignment.storeId, run.evaluatedAt, context)
    ) {
      issues.push(issue("frontier-assignment-invalid", "failed", { runId: run.runId }));
    }
    costs.push(assignment.costOre);
  }
  if (!sameStrings([...usedStores].sort(compareText), [...storeIds].sort(compareText))) {
    issues.push(issue("frontier-unused-store", "failed", { runId: run.runId }));
  }
  if (safeSum(costs) !== plan.totalOre) {
    issues.push(issue("frontier-total-ore-mismatch", "failed", { runId: run.runId }));
  }
  return issues;
}

function planDominates(left, right) {
  const leftStores = left.stores.length;
  const rightStores = right.stores.length;
  return leftStores <= rightStores
    && left.totalOre <= right.totalOre
    && (leftStores < rightStores || left.totalOre < right.totalOre);
}

function validateFrontier(scenario, run, protocol, context, references, features) {
  const issues = [];
  const plans = protocol.frontier.plans;
  if (!exactIdOrder(plans)) {
    issues.push(issue("frontier-plans-not-unique-canonical", "failed", { runId: run.runId }));
  }
  for (const plan of plans) {
    issues.push(...validateFrontierPlan(
      plan,
      scenario,
      run,
      context,
      references,
      protocol.oracleRequest.enabledMembershipProgramIds,
    ));
  }
  const nondominated = plans.filter((candidate) =>
    !plans.some((other) => other.id !== candidate.id && planDominates(other, candidate)));
  const nondominatedIds = nondominated.map(({ id }) => id).sort(compareText);
  if (!sameStrings(protocol.frontier.returnedPlanIds, nondominatedIds)) {
    issues.push(issue("frontier-nondominated-set-mismatch", "failed", { runId: run.runId }));
  }
  const convenience = [...nondominated].sort((left, right) =>
    left.stores.length - right.stores.length
    || left.totalOre - right.totalOre
    || compareText(left.id, right.id))[0];
  const savings = [...nondominated].sort((left, right) =>
    left.totalOre - right.totalOre
    || left.stores.length - right.stores.length
    || compareText(left.id, right.id))[0];
  if (
    convenience === undefined
    || savings === undefined
    || protocol.frontier.convenienceEndpointPlanId !== convenience.id
    || protocol.frontier.savingsEndpointPlanId !== savings.id
  ) {
    issues.push(issue("frontier-endpoint-mismatch", "failed", { runId: run.runId }));
  }
  if (issues.length === 0) {
    features.add("frontier-valid");
    if (nondominated.some(({ stores }) => stores.length === 1)) features.add("frontier-one");
    const counts = new Set(nondominated.map(({ stores }) => stores.length));
    if ([1, 2, 3].every((count) => counts.has(count))) features.add("frontier-three");
  }
  return issues;
}

function expectedReplayRequestDigest(scenario, run, context) {
  return sha256Canonical({
    bindings: context.bindings,
    candidateId: context.candidateId,
    environmentId: context.execution.environmentId,
    evaluatedAt: run.evaluatedAt,
    oracleRequest: run.protocol.oracleRequest,
    protocolVersion: PROTOCOL_VERSION,
    regionId: run.regionId,
    runId: run.runId,
    scenarioDigest: sha256Canonical(scenario),
  });
}

function expectedReplayResultDigest(run, protocol) {
  return sha256Canonical({
    comparisonScope: run.comparisonScope,
    frontier: protocol.frontier,
    oracleRequest: protocol.oracleRequest,
    plan: run.plan,
  });
}

function replayBindingDigestFor(run, context) {
  if (run.protocol === undefined) return null;
  return sha256Canonical({
    candidateDocumentDigest: context.candidateDocumentDigest,
    protocolId: run.protocol.id,
    replay: run.protocol.replay,
    runnerAttestationRunDigest: context.runnerAttestationByRunId.has(run.runId)
      ? sha256Canonical(context.runnerAttestationByRunId.get(run.runId))
      : null,
  });
}

function validateReplay(scenario, run, protocol, context, features) {
  const issues = [];
  const expectedRequestDigest = expectedReplayRequestDigest(scenario, run, context);
  const expectedResultDigest = expectedReplayResultDigest(run, protocol);
  const durations = [];
  if (
    protocol.replay.requestDigest !== expectedRequestDigest
    || protocol.replay.resultDigest !== expectedResultDigest
  ) {
    issues.push(issue("protocol-replay-binding-mismatch", "failed", { runId: run.runId }));
  }
  for (const sample of protocol.replay.samples) {
    const startedAt = Date.parse(sample.startedAt);
    const completedAt = Date.parse(sample.completedAt);
    const duration = completedAt - startedAt;
    if (
      sample.requestDigest !== expectedRequestDigest
      || sample.resultDigest !== expectedResultDigest
      || !Number.isSafeInteger(duration)
      || duration < 0
      || completedAt > Date.parse(context.execution.measuredAt)
    ) {
      issues.push(issue("protocol-replay-sample-invalid", "failed", { runId: run.runId }));
    } else {
      durations.push(duration);
    }
  }
  const sortedDurations = [...durations].sort((left, right) => left - right);
  const p95Index = Math.max(0, Math.ceil(sortedDurations.length * 0.95) - 1);
  const p95 = sortedDurations[p95Index];
  if (p95 === undefined || protocol.replay.reportedP95Ms !== p95) {
    issues.push(issue("protocol-performance-arithmetic-mismatch", "failed", { runId: run.runId }));
  }
  return issues;
}

function storeSnapshotUniverse(run, context) {
  return [...context.storeEvidenceById.values()]
    .filter((evidence) =>
      evidence.regionId === run.regionId
      && storeEvidenceCanBind(evidence, context.sourceById, context.enabledSourceIds)
      && storeEvidenceIsCurrent(evidence, run.evaluatedAt))
    .map((evidence) => ({
      storeId: evidence.storeId,
      chainId: evidence.chainId,
      storeEvidenceId: evidence.id,
    }))
    .sort((left, right) => compareText(left.storeId, right.storeId));
}

function buildBoundedSnapshotV2(scenario, run, context) {
  const stores = storeSnapshotUniverse(run, context);
  if (stores.length < 1 || stores.length > MAX_STORES) return undefined;
  const needs = [];
  for (const need of [...scenario.items].sort((left, right) =>
    compareText(left.needId, right.needId))) {
    const options = [];
    const matches = [...context.matchEvidenceById.values()]
      .filter((match) => matchCanSatisfyNeed(match, need, run))
      .sort((left, right) => compareText(left.id, right.id));
    for (const store of stores) {
      for (const match of matches) {
        const ordinaryPrices = [...context.priceEvidenceById.values()]
          .filter((price) =>
            price.priceClass === "ordinary"
            && price.chainId === store.chainId
            && price.canonicalProductId === match.canonicalProductId
            && price.unit === need.requiredAmount.unit
            && priceEvidenceCanBindToRun(
              price,
              run,
              store.storeId,
              run.evaluatedAt,
              context,
            ))
          .sort((left, right) => compareText(left.id, right.id));
        for (const ordinary of ordinaryPrices) {
          const officialOffers = [...context.priceEvidenceById.values()]
            .filter((offer) =>
              offer.priceClass === "official_offer"
              && sameProductPriceFacts(ordinary, offer)
              && priceEvidenceCanBindToRun(
                offer,
                run,
                store.storeId,
                run.evaluatedAt,
                context,
              ))
            .map((offer) => ({
              priceEvidenceId: offer.id,
              amountOre: offer.amountOre,
              bundleSize: offer.offerTerms.bundleSize,
              minimumPackages: offer.offerTerms.minimumPackages,
              membershipRequirement: offer.offerTerms.membershipRequirement,
              ...(offer.offerTerms.membershipProgramId === undefined
                ? {}
                : { membershipProgramId: offer.offerTerms.membershipProgramId }),
              validFrom: offer.validFrom,
              validUntil: offer.validUntil,
            }))
            .sort((left, right) => compareText(left.priceEvidenceId, right.priceEvidenceId));
          if (officialOffers.length > 4) return undefined;
          options.push({
            canonicalProductId: ordinary.canonicalProductId,
            storeId: store.storeId,
            chainId: store.chainId,
            ordinaryPriceEvidenceId: ordinary.id,
            matchEvidenceId: match.id,
            ordinaryAmountOre: ordinary.amountOre,
            packageBaseUnits: ordinary.packageBaseUnits,
            packageUnit: ordinary.unit,
            depositPerPackageOre: resolvedDepositOre(ordinary),
            officialOffers,
          });
        }
      }
    }
    const canonicalOptions = [...new Map(options
      .sort((left, right) => compareText(
        canonicalizeJson(left),
        canonicalizeJson(right),
      ))
      .map((option) => [canonicalizeJson(option), option])).values()];
    if (canonicalOptions.length < 1 || canonicalOptions.length > MAX_QUANTITY_OPTIONS_PER_NEED) {
      return undefined;
    }
    needs.push({
      needId: need.needId,
      identity: need.identity,
      requested: need.requiredAmount,
      options: canonicalOptions,
    });
  }
  return {
    contractVersion: 2,
    runId: run.runId,
    regionId: run.regionId,
    scenarioDigest: sha256Canonical(scenario),
    evaluatedAt: run.evaluatedAt,
    maximumStores: MAX_STORES,
    enabledMembershipProgramIds: [
      ...run.protocol.oracleRequest.enabledMembershipProgramIds,
    ],
    stores,
    needs,
  };
}

function runnerRequestDigest(snapshot, context) {
  return sha256Canonical({
    bindings: context.bindings,
    candidateDocumentDigest: context.candidateDocumentDigest,
    runnerImplementationDigest: RUNNER_IMPLEMENTATION_DIGEST,
    snapshotDigest: sha256Canonical(snapshot),
  });
}

function runnerProvenanceDigest(snapshot, context) {
  const storeIds = new Set(snapshot.stores.map(({ storeEvidenceId }) => storeEvidenceId));
  const priceIds = new Set(snapshot.needs.flatMap(({ options }) => options.flatMap((option) => [
    option.ordinaryPriceEvidenceId,
    ...option.officialOffers.map(({ priceEvidenceId }) => priceEvidenceId),
  ])));
  const matchIds = new Set(snapshot.needs.flatMap(({ options }) =>
    options.map(({ matchEvidenceId }) => matchEvidenceId)));
  return sha256Canonical({
    stores: [...storeIds].sort(compareText).map((id) =>
      context.storeEvidenceById.get(id)),
    prices: [...priceIds].sort(compareText).map((id) =>
      context.priceEvidenceById.get(id)),
    matches: [...matchIds].sort(compareText).map((id) =>
      context.matchEvidenceById.get(id)),
  });
}

function runnerOfferAwareDigest(snapshot) {
  return sha256Canonical({
    evaluatedAt: snapshot.evaluatedAt,
    enabledMembershipProgramIds: snapshot.enabledMembershipProgramIds,
    offers: snapshot.needs.flatMap(({ needId, options }) => options.map((option) => ({
      needId,
      canonicalProductId: option.canonicalProductId,
      storeId: option.storeId,
      ordinaryPriceEvidenceId: option.ordinaryPriceEvidenceId,
      officialOffers: option.officialOffers,
    }))),
  });
}

function timingDigestFor(timing) {
  return sha256Canonical({
    requestDigest: timing.requestDigest,
    resultDigest: timing.resultDigest,
    durationsMs: timing.durationsMs,
    reportedP95Ms: timing.reportedP95Ms,
  });
}

function expectedP95(durations) {
  const ordered = [...durations].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)];
}

function runnerAttestationIdFor(attestation) {
  const { attestationId: _attestationId, ...body } = attestation;
  return deterministicId("runner-attestation", body);
}

function buildEvaluationContext({
  candidate,
  bindings,
  generatedAt,
  launchCoverage,
  sourceRegistry,
}) {
  return {
    availabilityEvidenceById: new Map(candidate.availabilityEvidence
      .map((evidence) => [evidence.id, evidence])),
    bindings,
    candidateDocumentDigest: sha256Canonical(candidate),
    candidateId: candidate.candidate.id,
    cellsByKey: new Map(launchCoverage.coverage.map((cell) => [
      `${cell.regionId}/${cell.chainId}/${cell.priceClass}`,
      cell,
    ])),
    enabledSourceIds: new Set(candidate.execution.enabledSourceIds),
    execution: candidate.execution,
    generatedAt,
    launchCoverage,
    matchEvidenceById: new Map(candidate.matchEvidence
      .map((evidence) => [evidence.id, evidence])),
    priceEvidenceById: new Map(candidate.priceEvidence
      .map((evidence) => [evidence.id, evidence])),
    regionIds: launchCoverage.candidateRegions.map(({ id }) => id).sort(compareText),
    requiredChainIds: launchCoverage.requiredChains.map(({ id }) => id).sort(compareText),
    sourceById: new Map(sourceRegistry.sources.map((source) => [source.id, source])),
    storeEvidenceById: new Map(candidate.storeEvidence
      .map((evidence) => [evidence.id, evidence])),
  };
}

export function createRunnerAttestationV2({
  corpus,
  sourceRegistry,
  launchCoverage,
  candidate,
  attestedAt,
  measureDurationMs,
}) {
  validateFoundationInputs({ corpus, sourceRegistry, launchCoverage });
  if (!validateCandidateDocument(candidate)) {
    throw new Error("Cannot attest an invalid benchmark candidate");
  }
  const bindings = benchmarkBindings({ corpus, sourceRegistry, launchCoverage });
  const context = buildEvaluationContext({
    candidate,
    bindings,
    generatedAt: attestedAt,
    launchCoverage,
    sourceRegistry,
  });
  const scenarioById = new Map(corpus.scenarios.map((scenario) => [scenario.id, scenario]));
  const runs = [...candidate.runs]
    .sort((left, right) => compareText(left.runId, right.runId))
    .map((run) => {
      if (run.state !== "evaluated" || run.protocol === undefined) {
        throw new Error(`Cannot attest non-evaluated run ${run.runId}`);
      }
      const scenario = scenarioById.get(run.scenarioId);
      const snapshot = buildBoundedSnapshotV2(scenario, run, context);
      if (snapshot === undefined) {
        throw new Error(`Run ${run.runId} exceeds bounded V2 oracle limits`);
      }
      const sampleCount = scenario.acceptanceFocus.includes("performance") ? 20 : 2;
      const durationsMs = [];
      let oracleResult;
      for (let index = 0; index < sampleCount; index += 1) {
        const startedAt = performance.now();
        const result = enumerateBoundedUniverseV2(snapshot);
        const actualDuration = Math.max(0, Math.ceil(performance.now() - startedAt));
        durationsMs.push(measureDurationMs === undefined
          ? actualDuration
          : measureDurationMs({ index, runId: run.runId }));
        oracleResult = result;
      }
      if (oracleResult?.state !== "enumerated") {
        throw new Error(`Run ${run.runId} has no bounded feasible V2 universe`);
      }
      const requestDigest = runnerRequestDigest(snapshot, context);
      const resultDigest = sha256Canonical(oracleResult);
      const timing = {
        requestDigest,
        resultDigest,
        durationsMs,
        reportedP95Ms: expectedP95(durationsMs),
        digest: "sha256:placeholder",
      };
      timing.digest = timingDigestFor(timing);
      return {
        runId: run.runId,
        snapshot,
        snapshotDigest: sha256Canonical(snapshot),
        oracleResult,
        requestDigest,
        resultDigest,
        timing,
        provenanceDigest: runnerProvenanceDigest(snapshot, context),
        offerAwareDigest: runnerOfferAwareDigest(snapshot),
      };
    });
  const body = {
    $schema: "./benchmark-basket-runner-attestation.v2.schema.json",
    contractVersion: "2.0.0",
    kind: "handleplan-benchmark-runner-attestation",
    attestationId: "runner-attestation:sha256:placeholder",
    attestedAt,
    runner: {
      implementationId: RUNNER_IMPLEMENTATION_ID,
      implementationDigest: RUNNER_IMPLEMENTATION_DIGEST,
      clock: "monotonic-duration-ms",
    },
    candidateDocumentDigest: context.candidateDocumentDigest,
    bindings,
    runs,
  };
  body.attestationId = runnerAttestationIdFor(body);
  if (!validateRunnerAttestationDocument(body)) {
    throw new Error(
      `Internal runner attestation schema failure: ${ajv.errorsText(
        validateRunnerAttestationDocument.errors,
      )}`,
    );
  }
  return body;
}

function normalizeProtocolFrontierPlan(plan, scenario) {
  const assignments = [...plan.assignments]
    .sort((left, right) => compareText(left.needId, right.needId))
    .map((assignment) => ({
      needId: assignment.needId,
      canonicalProductId: assignment.canonicalProductId,
      storeId: assignment.storeId,
      chainId: assignment.chainId,
      packageCount: assignment.packageCount,
      packageBaseUnits: assignment.packageBaseUnits,
      purchasedBaseUnits: assignment.purchasedBaseUnits,
      unit: assignment.unit,
      ordinaryPriceEvidenceId: assignment.priceEvidenceId,
      matchEvidenceId: assignment.matchEvidenceId,
      appliedOfferEvidenceId: assignment.appliedOfferEvidenceId,
      ordinaryCostOre: assignment.ordinaryCostOre,
      costOre: assignment.costOre,
    }));
  const body = {
    storeIds: plan.stores.map(({ storeId }) => storeId).sort(compareText),
    assignments,
    totalOre: plan.totalOre,
    substitutions: scenario.items.filter(({ identity }) =>
      identity.kind === "reviewed-family").length,
  };
  return { signature: sha256Canonical(body), ...body };
}

function validateRunnerRunAttestation(
  scenario,
  run,
  attested,
  context,
  features,
  references,
) {
  const issues = [];
  const snapshot = buildBoundedSnapshotV2(scenario, run, context);
  if (snapshot === undefined) {
    return [issue("protocol-runner-snapshot-bounds-invalid", "blocked", {
      runId: run.runId,
    })];
  }
  for (const { storeEvidenceId } of snapshot.stores) references.store.add(storeEvidenceId);
  for (const { options } of snapshot.needs) {
    for (const option of options) {
      references.price.add(option.ordinaryPriceEvidenceId);
      references.match.add(option.matchEvidenceId);
      for (const offer of option.officialOffers) references.price.add(offer.priceEvidenceId);
    }
  }
  if (attested === undefined) {
    return [issue("protocol-runner-attestation-missing", "blocked", {
      runId: run.runId,
    })];
  }
  const oracleResult = enumerateBoundedUniverseV2(snapshot);
  const requestDigest = runnerRequestDigest(snapshot, context);
  const resultDigest = sha256Canonical(oracleResult);
  if (
    !sameJson(attested.snapshot, snapshot)
    || attested.snapshotDigest !== sha256Canonical(snapshot)
    || !sameJson(attested.oracleResult, oracleResult)
    || attested.requestDigest !== requestDigest
    || attested.resultDigest !== resultDigest
    || attested.provenanceDigest !== runnerProvenanceDigest(snapshot, context)
    || attested.offerAwareDigest !== runnerOfferAwareDigest(snapshot)
    || attested.timing.requestDigest !== requestDigest
    || attested.timing.resultDigest !== resultDigest
    || attested.timing.digest !== timingDigestFor(attested.timing)
    || attested.timing.reportedP95Ms !== expectedP95(attested.timing.durationsMs)
  ) {
    return [issue("protocol-runner-attestation-binding-invalid", "failed", {
      runId: run.runId,
    })];
  }
  const candidatePlanById = new Map(run.protocol.frontier.plans
    .map((plan) => [plan.id, normalizeProtocolFrontierPlan(plan, scenario)]));
  const candidateFrontierSignatures = run.protocol.frontier.returnedPlanIds
    .map((id) => candidatePlanById.get(id)?.signature)
    .filter((signature) => signature !== undefined)
    .sort(compareText);
  if (
    !sameStrings(candidateFrontierSignatures, oracleResult.frontierPlanSignatures)
    || candidatePlanById.get(run.protocol.frontier.convenienceEndpointPlanId)?.signature
      !== oracleResult.convenienceEndpointSignature
    || candidatePlanById.get(run.protocol.frontier.savingsEndpointPlanId)?.signature
      !== oracleResult.savingsEndpointSignature
  ) {
    issues.push(issue("protocol-v2-oracle-result-mismatch", "failed", { runId: run.runId }));
  }
  if (attested.timing.reportedP95Ms > PRICE_ONLY_P95_BUDGET_MS) {
    issues.push(issue("protocol-runner-performance-budget-exceeded", "failed", {
      runId: run.runId,
    }));
  }
  const verificationSamples = scenario.acceptanceFocus.includes("performance") ? 20 : 2;
  const verificationDurations = [];
  for (let index = 0; index < verificationSamples; index += 1) {
    const startedAt = performance.now();
    enumerateBoundedUniverseV2(snapshot);
    verificationDurations.push(Math.max(0, Math.ceil(performance.now() - startedAt)));
  }
  if (expectedP95(verificationDurations) > PRICE_ONLY_P95_BUDGET_MS) {
    issues.push(issue("protocol-runner-verification-budget-exceeded", "failed", {
      runId: run.runId,
    }));
  }
  if (issues.length === 0) {
    if (oracleResult.discountedFrontierPlanSignatures.length > 0) {
      features.add("offer-aware-plan");
    }
    features.add("performance");
    features.add("category-coverage");
    features.add("trusted-history-window");
    features.add("trusted-variable-weight-measurement");
  }
  return issues;
}

function validateExecutableProtocol(scenario, run, context) {
  if (run.protocol === undefined) {
    return {
      issues: [issue("protocol-evidence-missing", "blocked", { runId: run.runId })],
      verifiedFocus: [],
      referencedAvailabilityEvidenceIds: new Set(),
      referencedMatchEvidenceIds: new Set(),
      referencedPriceEvidenceIds: new Set(),
      referencedStoreEvidenceIds: new Set(),
    };
  }
  const protocol = run.protocol;
  const references = {
    availability: new Set(),
    match: new Set(),
    price: new Set(),
    store: new Set(),
  };
  const features = new Set();
  if (context.launchCoverage.coverage.every((cell) =>
    manifestCellCanRank(cell, context.sourceById, context.enabledSourceIds))) {
    features.add("complete-launch-coverage");
  }
  const issues = [];
  if (
    protocol.protocolVersion !== PROTOCOL_VERSION
    || protocol.scenarioDigest !== sha256Canonical(scenario)
    || protocol.id !== protocolEvidenceIdFor(protocol)
    || !hasUnique(protocol.oracleRequest.enabledMembershipProgramIds)
    || !sameStrings(
      protocol.oracleRequest.enabledMembershipProgramIds,
      [...protocol.oracleRequest.enabledMembershipProgramIds].sort(compareText),
    )
  ) {
    issues.push(issue("protocol-binding-mismatch", "failed", { runId: run.runId }));
  }
  issues.push(...validateQuantityCases(
    scenario,
    run,
    protocol,
    context,
    references,
    features,
  ));
  issues.push(...validatePricingCases(
    scenario,
    run,
    protocol,
    context,
    references,
    features,
  ));
  issues.push(...validateMatchCases(
    scenario,
    run,
    protocol,
    context,
    references,
    features,
  ));
  issues.push(...validateNegativeControls(
    scenario,
    run,
    protocol,
    context,
    references,
    features,
  ));
  issues.push(...validateFrontier(
    scenario,
    run,
    protocol,
    context,
    references,
    features,
  ));
  issues.push(...validateReplay(scenario, run, protocol, context, features));
  issues.push(...validateRunnerRunAttestation(
    scenario,
    run,
    context.runnerAttestationByRunId.get(run.runId),
    context,
    features,
    references,
  ));

  const verifiedFocus = scenario.acceptanceFocus.filter((focus) =>
    (FOCUS_REQUIREMENTS[focus] ?? []).every((feature) => features.has(feature)));
  if (verifiedFocus.length !== scenario.acceptanceFocus.length) {
    issues.push(issue("protocol-focus-unproven", "blocked", { runId: run.runId }));
  }
  return {
    issues,
    verifiedFocus: [...verifiedFocus].sort(compareText),
    referencedAvailabilityEvidenceIds: references.availability,
    referencedMatchEvidenceIds: references.match,
    referencedPriceEvidenceIds: references.price,
    referencedStoreEvidenceIds: references.store,
  };
}

function validateEvaluatedRun(corpusRun, scenario, run, context) {
  const issues = [];
  const referencedAvailabilityEvidenceIds = new Set();
  const referencedPriceEvidenceIds = new Set(
    run.plan.assignments.flatMap(({ priceEvidenceId, appliedOfferEvidenceId }) => [
      priceEvidenceId,
      ...(appliedOfferEvidenceId === null ? [] : [appliedOfferEvidenceId]),
    ]),
  );
  const referencedMatchEvidenceIds = new Set(
    run.plan.assignments.map(({ matchEvidenceId }) => matchEvidenceId),
  );
  const referencedStoreEvidenceIds = new Set(
    run.plan.stores.map(({ storeEvidenceId }) => storeEvidenceId),
  );

  if (corpusRun.status === "pending_rights_and_measurement") {
    return {
      issues: [issue("corpus-run-pending", "pending", { runId: corpusRun.id })],
      verifiedFocus: [],
      referencedAvailabilityEvidenceIds,
      referencedPriceEvidenceIds,
      referencedMatchEvidenceIds,
      referencedStoreEvidenceIds,
    };
  }
  if (corpusRun.status === "suspended") {
    return {
      issues: [issue("corpus-run-suspended", "blocked", { runId: corpusRun.id })],
      verifiedFocus: [],
      referencedAvailabilityEvidenceIds,
      referencedPriceEvidenceIds,
      referencedMatchEvidenceIds,
      referencedStoreEvidenceIds,
    };
  }
  if (corpusRun.status === "failed") {
    return {
      issues: [issue("corpus-run-failed", "failed", { runId: corpusRun.id })],
      verifiedFocus: [],
      referencedAvailabilityEvidenceIds,
      referencedPriceEvidenceIds,
      referencedMatchEvidenceIds,
      referencedStoreEvidenceIds,
    };
  }

  if (Date.parse(run.evaluatedAt) > Date.parse(context.execution.measuredAt)) {
    issues.push(issue("evaluation-after-measurement", "failed", { runId: run.runId }));
  }

  const scope = validateScope(run, context);
  issues.push(...scope.issues);
  const scopeByKey = new Map(scope.expected.map((entry) => [coverageKey(entry), entry]));

  const stores = run.plan.stores;
  const storeIds = stores.map(({ storeId }) => storeId);
  const canonicallySortedStoreIds = [...storeIds].sort(compareText);
  if (!hasUnique(storeIds) || !sameStrings(storeIds, canonicallySortedStoreIds)) {
    issues.push(issue("stores-not-unique-canonical", "failed", { runId: run.runId }));
  }
  if (stores.length < 1 || stores.length > MAX_STORES) {
    issues.push(issue("maximum-three-stores-violated", "failed", { runId: run.runId }));
  }
  const storeById = new Map(stores.map((store) => [store.storeId, store]));
  for (const store of stores) {
    const evidence = context.storeEvidenceById.get(store.storeEvidenceId);
    if (
      evidence === undefined
      || evidence.storeId !== store.storeId
      || evidence.chainId !== store.chainId
      || evidence.regionId !== store.regionId
    ) {
      issues.push(issue("store-evidence-binding-mismatch", "failed", { runId: run.runId }));
    } else if (!storeEvidenceCanBind(evidence, context.sourceById, context.enabledSourceIds)) {
      issues.push(issue("store-evidence-ineligible", "blocked", {
        regionId: run.regionId,
        runId: run.runId,
      }));
    } else if (!storeEvidenceIsCurrent(evidence, run.evaluatedAt)) {
      issues.push(issue("store-evidence-window-invalid", "blocked", {
        regionId: run.regionId,
        runId: run.runId,
      }));
    }
  }

  const expectedNeedIds = scenario.items.map(({ needId }) => needId).sort(compareText);
  const assignmentNeedIds = run.plan.assignments.map(({ needId }) => needId);
  if (!hasUnique(assignmentNeedIds) || !sameStrings(assignmentNeedIds, expectedNeedIds)) {
    issues.push(issue("complete-basket-violated", "failed", { runId: run.runId }));
  }
  const needsById = new Map(scenario.items.map((need) => [need.needId, need]));
  const usedStoreIds = new Set();
  let totalOre = 0;

  for (const assignment of run.plan.assignments) {
    const need = needsById.get(assignment.needId);
    const store = storeById.get(assignment.storeId);
    const priceEvidence = context.priceEvidenceById.get(assignment.priceEvidenceId);
    const pricing = assignmentPricingFacts(
      assignment,
      run,
      context,
      run.protocol?.oracleRequest.enabledMembershipProgramIds ?? [],
    );
    const matchEvidence = context.matchEvidenceById.get(assignment.matchEvidenceId);
    referencedPriceEvidenceIds.add(assignment.priceEvidenceId);
    if (assignment.appliedOfferEvidenceId !== null) {
      referencedPriceEvidenceIds.add(assignment.appliedOfferEvidenceId);
    }
    referencedMatchEvidenceIds.add(assignment.matchEvidenceId);
    usedStoreIds.add(assignment.storeId);

    if (need === undefined) continue;
    if (
      store === undefined
      || store.chainId !== assignment.chainId
      || store.regionId !== run.regionId
    ) {
      issues.push(issue("store-binding-mismatch", "failed", { runId: run.runId }));
    }
    if (
      !isSafePositiveInteger(assignment.packageCount)
      || !isSafePositiveInteger(assignment.packageBaseUnits)
      || !isSafePositiveInteger(assignment.purchasedBaseUnits)
      || !isSafePositiveInteger(assignment.ordinaryCostOre)
      || !isSafePositiveInteger(assignment.costOre)
    ) {
      issues.push(issue("integer-arithmetic-violated", "failed", { runId: run.runId }));
      continue;
    }
    const purchased = assignment.unit === "package"
      ? assignment.packageCount
      : assignment.packageCount * assignment.packageBaseUnits;
    if (
      !Number.isSafeInteger(purchased)
      || purchased !== assignment.purchasedBaseUnits
      || assignment.unit !== need.requiredAmount.unit
      || assignment.purchasedBaseUnits < need.requiredAmount.value
    ) {
      issues.push(issue("base-unit-fulfilment-mismatch", "failed", { runId: run.runId }));
    }

    if (
      matchEvidence === undefined
      || matchEvidence.runId !== run.runId
      || matchEvidence.needId !== assignment.needId
      || matchEvidence.canonicalProductId !== assignment.canonicalProductId
      || (need.identity.kind === "exact-product"
        && assignment.canonicalProductId !== need.identity.canonicalProductId)
    ) {
      issues.push(issue("match-evidence-binding-mismatch", "failed", { runId: run.runId }));
    } else if (Date.parse(matchEvidence.reviewedAt) > Date.parse(run.evaluatedAt)) {
      issues.push(issue("match-evidence-from-future", "failed", { runId: run.runId }));
    }

    if (priceEvidence === undefined) {
      issues.push(issue("price-evidence-missing", "failed", { runId: run.runId }));
      continue;
    }
    const bindingMatches = priceEvidence.chainId === assignment.chainId
      && geographicScopeIncludes(
        priceEvidence.geographicScope,
        run.regionId,
        assignment.storeId,
      )
      && priceEvidence.canonicalProductId === assignment.canonicalProductId
      && priceEvidence.packageBaseUnits === assignment.packageBaseUnits
      && priceEvidence.unit === assignment.unit;
    if (!bindingMatches) {
      issues.push(issue("price-evidence-binding-mismatch", "failed", { runId: run.runId }));
    }

    if (
      pricing === undefined
      || pricing.appliedOfferEvidenceId !== assignment.appliedOfferEvidenceId
      || pricing.ordinaryCostOre !== assignment.ordinaryCostOre
      || pricing.costOre !== assignment.costOre
    ) {
      issues.push(issue("price-arithmetic-mismatch", "failed", { runId: run.runId }));
    }
    totalOre += assignment.costOre;

    const cell = context.cellsByKey.get(
      `${run.regionId}/${assignment.chainId}/${priceEvidence.priceClass}`,
    );
    const scopedEntry = scopeByKey.get(
      `${assignment.chainId}/${priceEvidence.priceClass}`,
    );
    if (
      !manifestCellCanRank(cell, context.sourceById, context.enabledSourceIds)
      || cell.activeSourceId !== priceEvidence.sourceId
      || scopedEntry?.state !== "verified"
      || scopedEntry.sourceId !== priceEvidence.sourceId
    ) {
      issues.push(issue("price-evidence-ineligible", "blocked", {
        regionId: run.regionId,
        runId: run.runId,
      }));
    } else if (!timestampInEvidenceWindow(priceEvidence, run.evaluatedAt, cell.refreshTargetHours)) {
      issues.push(issue("price-evidence-window-invalid", "blocked", {
        regionId: run.regionId,
        runId: run.runId,
      }));
    }
  }

  if (!Number.isSafeInteger(totalOre) || totalOre !== run.plan.totalOre) {
    issues.push(issue("total-ore-mismatch", "failed", { runId: run.runId }));
  }
  if (!sameStrings([...usedStoreIds].sort(compareText), [...storeIds].sort(compareText))) {
    issues.push(issue("unused-or-undeclared-store", "failed", { runId: run.runId }));
  }
  if (run.plan.id !== planIdFor(run)) {
    issues.push(issue("plan-id-nondeterministic", "failed", { runId: run.runId }));
  }

  const protocol = validateExecutableProtocol(scenario, run, context);
  issues.push(...protocol.issues);
  for (const id of protocol.referencedAvailabilityEvidenceIds) {
    referencedAvailabilityEvidenceIds.add(id);
  }
  for (const id of protocol.referencedPriceEvidenceIds) referencedPriceEvidenceIds.add(id);
  for (const id of protocol.referencedMatchEvidenceIds) referencedMatchEvidenceIds.add(id);
  for (const id of protocol.referencedStoreEvidenceIds) referencedStoreEvidenceIds.add(id);

  return {
    issues,
    verifiedFocus: protocol.verifiedFocus,
    referencedAvailabilityEvidenceIds,
    referencedPriceEvidenceIds,
    referencedMatchEvidenceIds,
    referencedStoreEvidenceIds,
  };
}

function candidateFatalIssues(candidate, bindings, corpusRuns) {
  const issues = [];
  if (!sameJson(candidate.bindings, bindings)) {
    issues.push(issue("candidate-binding-mismatch", "failed"));
  }
  if (candidate.candidate.id !== candidateIdFor(candidate)) {
    issues.push(issue("candidate-id-nondeterministic", "failed"));
  }

  const enabled = candidate.execution.enabledSourceIds;
  if (!sameStrings(enabled, [...enabled].sort(compareText))) {
    issues.push(issue("enabled-sources-not-canonical", "failed"));
  }

  const expectedRunIds = corpusRuns.map(({ id }) => id).sort(compareText);
  const candidateRunIds = candidate.runs.map(({ runId }) => runId);
  if (!hasUnique(candidateRunIds) || !sameStrings(candidateRunIds, expectedRunIds)) {
    issues.push(issue("candidate-run-set-mismatch", "failed"));
  }

  for (const [records, idFor, code] of [
    [candidate.storeEvidence, storeEvidenceIdFor, "store-evidence-id-nondeterministic"],
    [candidate.priceEvidence, priceEvidenceIdFor, "price-evidence-id-nondeterministic"],
    [
      candidate.availabilityEvidence,
      availabilityEvidenceIdFor,
      "availability-evidence-id-nondeterministic",
    ],
    [candidate.matchEvidence, matchEvidenceIdFor, "match-evidence-id-nondeterministic"],
    [candidate.manualReconciliations, reconciliationIdFor, "reconciliation-id-nondeterministic"],
  ]) {
    const ids = records.map(({ id }) => id);
    if (!hasUnique(ids) || !sameStrings(ids, [...ids].sort(compareText))) {
      issues.push(issue("evidence-not-unique-canonical", "failed"));
    }
    if (records.some((record) => record.id !== idFor(record))) {
      issues.push(issue(code, "failed"));
    }
  }
  if (!hasUnique(candidate.manualReconciliations.map(({ runId }) => runId))) {
    issues.push(issue("reconciliation-run-ids-not-unique", "failed"));
  }

  return sortIssues(issues);
}

function placeholderRunReports(corpusRuns, code, severity) {
  return corpusRuns.map((run) => ({
    runId: run.id,
    regionId: run.regionId,
    scenarioId: run.scenarioId,
    status: severity === "failed" ? "failed" : severity,
    verifiedFocus: [],
    replayBindingDigest: null,
    issues: [code],
  })).sort((left, right) => compareText(left.runId, right.runId));
}

function manualReconciliationSummary(candidate, runReports, context, globalIssues) {
  const passedRunIds = new Set(
    runReports.filter(({ status }) => status === "passed").map(({ runId }) => runId),
  );
  const runById = new Map(candidate?.runs.map((run) => [run.runId, run]) ?? []);
  const validByRegion = new Map(context.regionIds.map((regionId) => [regionId, new Set()]));

  for (const reconciliation of candidate?.manualReconciliations ?? []) {
    const run = runById.get(reconciliation.runId);
    if (run?.state !== "evaluated") {
      globalIssues.push(issue("manual-reconciliation-invalid", "failed", {
        runId: reconciliation.runId,
      }));
      continue;
    }
    const expectedEvidenceIds = [...new Set(run.plan.assignments
      .flatMap(({ priceEvidenceId, appliedOfferEvidenceId }) => [
        priceEvidenceId,
        ...(appliedOfferEvidenceId === null ? [] : [appliedOfferEvidenceId]),
      ]))]
      .sort(compareText);
    const suppliedEvidenceIds = [...reconciliation.priceEvidenceIds].sort(compareText);
    const expectedStoreEvidenceIds = run.plan.stores
      .map(({ storeEvidenceId }) => storeEvidenceId)
      .sort(compareText);
    const suppliedStoreEvidenceIds = [...reconciliation.storeEvidenceIds].sort(compareText);
    const referencedObservationTimes = [
      ...reconciliation.priceEvidenceIds.map((id) =>
        Date.parse(context.priceEvidenceById.get(id)?.observedAt ?? "")),
      ...reconciliation.storeEvidenceIds.map((id) =>
        Date.parse(context.storeEvidenceById.get(id)?.observedAt ?? "")),
    ];
    const earliestReviewMs = Math.max(
      Date.parse(run.evaluatedAt),
      ...referencedObservationTimes,
    );
    const reviewedAtMs = Date.parse(reconciliation.reviewedAt);
    const expectedReviewedEvidenceDigest = reconciliationEvidenceDigestFor({
      evaluatedAt: run.evaluatedAt,
      priceEvidenceIds: expectedEvidenceIds,
      runId: run.runId,
      storeEvidenceIds: expectedStoreEvidenceIds,
    });
    if (
      !sameStrings(reconciliation.priceEvidenceIds, suppliedEvidenceIds)
      || !sameStrings(expectedEvidenceIds, suppliedEvidenceIds)
      || !sameStrings(reconciliation.storeEvidenceIds, suppliedStoreEvidenceIds)
      || !sameStrings(expectedStoreEvidenceIds, suppliedStoreEvidenceIds)
      || !Number.isFinite(earliestReviewMs)
      || reviewedAtMs < earliestReviewMs
      || reviewedAtMs > Date.parse(context.execution.measuredAt)
      || reconciliation.reviewedEvidenceDigest !== expectedReviewedEvidenceDigest
    ) {
      globalIssues.push(issue("manual-reconciliation-invalid", "failed", {
        runId: reconciliation.runId,
      }));
      continue;
    }
    if (!passedRunIds.has(run.runId)) continue;
    validByRegion.get(run.regionId)?.add(run.runId);
  }

  return context.regionIds.map((regionId) => {
    const accepted = validByRegion.get(regionId)?.size ?? 0;
    const passed = accepted >= MANUAL_RECONCILIATIONS_PER_REGION;
    if (candidate !== undefined && !passed) {
      globalIssues.push(issue("manual-reconciliation-quota-unmet", "blocked", { regionId }));
    }
    return {
      regionId,
      required: MANUAL_RECONCILIATIONS_PER_REGION,
      accepted,
      passed,
    };
  });
}

function finalizeReport({
  bindings,
  candidate,
  generatedAt,
  globalIssues,
  manualReconciliation,
  runnerAttestation,
  runs,
}) {
  const normalizedGlobalIssues = sortIssues(globalIssues);
  const summary = {
    expectedRuns: EXPECTED_RUN_COUNT,
    passedRuns: runs.filter(({ status }) => status === "passed").length,
    protocolPassedRuns: runs.filter(({ status, verifiedFocus }) =>
      status === "passed" && verifiedFocus.length > 0).length,
    blockedRuns: runs.filter(({ status }) => status === "blocked").length,
    failedRuns: runs.filter(({ status }) => status === "failed").length,
    pendingRuns: runs.filter(({ status }) => status === "pending").length,
  };
  const combinedStatus = statusForIssues([
    ...normalizedGlobalIssues,
    ...runs.flatMap((run) => run.issues.map((code) => issue(
      code,
      run.status === "passed" ? "pending" : run.status,
      { runId: run.runId },
    ))),
  ]);
  const status = combinedStatus === "passed" && summary.passedRuns === EXPECTED_RUN_COUNT
    ? "accepted"
    : combinedStatus === "passed"
      ? "pending"
      : combinedStatus;
  const body = {
    $schema: "./benchmark-basket-report.v1.schema.json",
    contractVersion: "2.0.0",
    protocolVersion: PROTOCOL_VERSION,
    kind: "handleplan-benchmark-basket-report",
    generatedAt,
    bindings,
    candidate: candidate === undefined
      ? null
      : {
          id: candidate.candidate.id,
          commitSha: candidate.candidate.commitSha,
          imageDigest: candidate.candidate.imageDigest,
        },
    candidateDocumentDigest: candidate === undefined ? null : sha256Canonical(candidate),
    runnerAttestationDigest: runnerAttestation === undefined
      ? null
      : sha256Canonical(runnerAttestation),
    status,
    acceptancePassed: status === "accepted",
    summary,
    issues: normalizedGlobalIssues,
    manualReconciliation,
    runs,
  };
  const report = {
    ...body,
    reportId: deterministicId("basket-report", {
      ...body,
      generatedAt: undefined,
    }),
  };
  if (!validateReportDocument(report)) {
    throw new Error(`Internal report schema failure: ${ajv.errorsText(validateReportDocument.errors)}`);
  }
  return report;
}

export function createBenchmarkReport({
  corpus,
  sourceRegistry,
  launchCoverage,
  candidate,
  runnerAttestation,
  generatedAt = new Date().toISOString(),
}) {
  validateFoundationInputs({ corpus, sourceRegistry, launchCoverage });
  if (corpus.runs.length !== EXPECTED_RUN_COUNT) {
    throw new Error(`Expected ${EXPECTED_RUN_COUNT} corpus runs`);
  }
  const bindings = benchmarkBindings({ corpus, sourceRegistry, launchCoverage });
  const corpusRuns = [...corpus.runs].sort((left, right) => compareText(left.id, right.id));
  const regionIds = launchCoverage.candidateRegions.map(({ id }) => id).sort(compareText);
  const requiredChainIds = launchCoverage.requiredChains.map(({ id }) => id).sort(compareText);
  const sourceById = new Map(sourceRegistry.sources.map((source) => [source.id, source]));
  const cellsByKey = new Map(
    launchCoverage.coverage.map((cell) => [
      `${cell.regionId}/${cell.chainId}/${cell.priceClass}`,
      cell,
    ]),
  );
  const globalIssues = [];

  for (const regionId of regionIds) {
    const hasPotentialEvidence = launchCoverage.coverage.some((cell) =>
      cell.regionId === regionId
      && cell.launchEligible === true
      && typeof cell.activeSourceId === "string"
      && sourceCanRank(sourceById.get(cell.activeSourceId))
      && sourceSupportsPriceClass(sourceById.get(cell.activeSourceId), cell.priceClass));
    if (!hasPotentialEvidence) {
      globalIssues.push(issue("no-eligible-live-evidence", "blocked", { regionId }));
    }
  }

  if (candidate === undefined) {
    globalIssues.push(issue("candidate-output-missing", "pending"));
    const runs = corpusRuns.map((run) => {
      const code = run.status === "pending_rights_and_measurement"
        ? "corpus-run-pending"
        : run.status === "suspended"
          ? "corpus-run-suspended"
          : run.status === "failed"
            ? "corpus-run-failed"
            : "candidate-output-missing";
      const status = run.status === "suspended"
        ? "blocked"
        : run.status === "failed"
          ? "failed"
          : "pending";
      return {
        runId: run.id,
        regionId: run.regionId,
        scenarioId: run.scenarioId,
        status,
        verifiedFocus: [],
        replayBindingDigest: null,
        issues: [code],
      };
    });
    const manualReconciliation = regionIds.map((regionId) => ({
      regionId,
      required: MANUAL_RECONCILIATIONS_PER_REGION,
      accepted: 0,
      passed: false,
    }));
    return finalizeReport({
      bindings,
      candidate,
      generatedAt,
      globalIssues,
      manualReconciliation,
      runnerAttestation: undefined,
      runs,
    });
  }

  if (!validateCandidateDocument(candidate)) {
    globalIssues.push(issue("candidate-schema-invalid", "failed"));
    return finalizeReport({
      bindings,
      candidate: undefined,
      generatedAt,
      globalIssues,
      manualReconciliation: regionIds.map((regionId) => ({
        regionId,
        required: MANUAL_RECONCILIATIONS_PER_REGION,
        accepted: 0,
        passed: false,
      })),
      runnerAttestation: undefined,
      runs: placeholderRunReports(corpusRuns, "candidate-schema-invalid", "failed"),
    });
  }

  const fatalIssues = candidateFatalIssues(candidate, bindings, corpusRuns);
  if (fatalIssues.length > 0) {
    globalIssues.push(...fatalIssues);
    return finalizeReport({
      bindings,
      candidate,
      generatedAt,
      globalIssues,
      manualReconciliation: regionIds.map((regionId) => ({
        regionId,
        required: MANUAL_RECONCILIATIONS_PER_REGION,
        accepted: 0,
        passed: false,
      })),
      runnerAttestation: undefined,
      runs: placeholderRunReports(corpusRuns, "candidate-contract-invalid", "failed"),
    });
  }
  if (Date.parse(candidate.execution.measuredAt) > Date.parse(generatedAt)) {
    globalIssues.push(issue("measurement-after-report", "failed"));
  }

  let runnerAttestationByRunId = new Map();
  if (runnerAttestation !== undefined) {
    const runIds = runnerAttestation.runs?.map(({ runId }) => runId) ?? [];
    const expectedRunIds = candidate.runs.map(({ runId }) => runId).sort(compareText);
    const attestationValid = validateRunnerAttestationDocument(runnerAttestation)
      && runnerAttestation.attestationId === runnerAttestationIdFor(runnerAttestation)
      && runnerAttestation.runner.implementationId === RUNNER_IMPLEMENTATION_ID
      && runnerAttestation.runner.implementationDigest === RUNNER_IMPLEMENTATION_DIGEST
      && runnerAttestation.candidateDocumentDigest === sha256Canonical(candidate)
      && sameJson(runnerAttestation.bindings, bindings)
      && Date.parse(runnerAttestation.attestedAt) >= Date.parse(candidate.execution.measuredAt)
      && Date.parse(runnerAttestation.attestedAt) <= Date.parse(generatedAt)
      && hasUnique(runIds)
      && sameStrings(runIds, expectedRunIds);
    if (!attestationValid) {
      globalIssues.push(issue("runner-attestation-contract-invalid", "failed"));
    } else {
      runnerAttestationByRunId = new Map(runnerAttestation.runs
        .map((attestation) => [attestation.runId, attestation]));
    }
  }

  const scenarioById = new Map(corpus.scenarios.map((scenario) => [scenario.id, scenario]));
  const candidateRunById = new Map(candidate.runs.map((run) => [run.runId, run]));
  const priceEvidenceById = new Map(candidate.priceEvidence.map((evidence) => [evidence.id, evidence]));
  const availabilityEvidenceById = new Map(
    candidate.availabilityEvidence.map((evidence) => [evidence.id, evidence]),
  );
  const matchEvidenceById = new Map(candidate.matchEvidence.map((evidence) => [evidence.id, evidence]));
  const storeEvidenceById = new Map(candidate.storeEvidence.map((evidence) => [evidence.id, evidence]));
  const enabledSourceIds = new Set(candidate.execution.enabledSourceIds);
  const context = {
    availabilityEvidenceById,
    bindings,
    candidateDocumentDigest: sha256Canonical(candidate),
    candidateId: candidate.candidate.id,
    cellsByKey,
    enabledSourceIds,
    execution: candidate.execution,
    generatedAt,
    launchCoverage,
    matchEvidenceById,
    priceEvidenceById,
    regionIds,
    requiredChainIds,
    runnerAttestationByRunId,
    sourceById,
    storeEvidenceById,
  };
  if (!launchCoverage.coverage.every((cell) =>
    manifestCellCanRank(cell, sourceById, enabledSourceIds))) {
    globalIssues.push(issue("launch-coverage-incomplete", "blocked"));
  }
  const allReferencedPriceEvidenceIds = new Set();
  const allReferencedAvailabilityEvidenceIds = new Set();
  const allReferencedMatchEvidenceIds = new Set();
  const allReferencedStoreEvidenceIds = new Set();

  const runs = corpusRuns.map((corpusRun) => {
    const run = candidateRunById.get(corpusRun.id);
    const identityMatches = run.regionId === corpusRun.regionId
      && run.scenarioId === corpusRun.scenarioId;
    let runIssues = [];
    let verifiedFocus = [];
    if (!identityMatches) {
      runIssues = [issue("run-identity-mismatch", "failed", { runId: corpusRun.id })];
    } else if (run.state === "pending") {
      runIssues = [issue(`candidate-${run.reason}`, "pending", { runId: corpusRun.id })];
    } else if (run.state === "blocked") {
      runIssues = [issue(`candidate-${run.reason}`, "blocked", { runId: corpusRun.id })];
    } else if (run.state === "failed") {
      runIssues = [issue(`candidate-${run.reason}`, "failed", { runId: corpusRun.id })];
    } else {
      const evaluated = validateEvaluatedRun(
        corpusRun,
        scenarioById.get(corpusRun.scenarioId),
        run,
        context,
      );
      runIssues = evaluated.issues;
      verifiedFocus = evaluated.verifiedFocus;
      for (const id of evaluated.referencedAvailabilityEvidenceIds) {
        allReferencedAvailabilityEvidenceIds.add(id);
      }
      for (const id of evaluated.referencedPriceEvidenceIds) allReferencedPriceEvidenceIds.add(id);
      for (const id of evaluated.referencedMatchEvidenceIds) allReferencedMatchEvidenceIds.add(id);
      for (const id of evaluated.referencedStoreEvidenceIds) allReferencedStoreEvidenceIds.add(id);
    }
    const normalized = sortIssues(runIssues);
    return {
      runId: corpusRun.id,
      regionId: corpusRun.regionId,
      scenarioId: corpusRun.scenarioId,
      status: statusForIssues(normalized),
      verifiedFocus,
      replayBindingDigest: run.state === "evaluated"
        ? replayBindingDigestFor(run, context)
        : null,
      issues: sortedUnique(normalized.map(({ code }) => code)),
    };
  });

  if (!sameStrings(
    [...allReferencedAvailabilityEvidenceIds].sort(compareText),
    candidate.availabilityEvidence.map(({ id }) => id),
  )) {
    globalIssues.push(issue("availability-evidence-reference-set-mismatch", "failed"));
  }
  if (!sameStrings(
    [...allReferencedPriceEvidenceIds].sort(compareText),
    candidate.priceEvidence.map(({ id }) => id),
  )) {
    globalIssues.push(issue("price-evidence-reference-set-mismatch", "failed"));
  }
  if (!sameStrings(
    [...allReferencedMatchEvidenceIds].sort(compareText),
    candidate.matchEvidence.map(({ id }) => id),
  )) {
    globalIssues.push(issue("match-evidence-reference-set-mismatch", "failed"));
  }
  if (!sameStrings(
    [...allReferencedStoreEvidenceIds].sort(compareText),
    candidate.storeEvidence.map(({ id }) => id),
  )) {
    globalIssues.push(issue("store-evidence-reference-set-mismatch", "failed"));
  }

  const manualReconciliation = manualReconciliationSummary(
    candidate,
    runs,
    context,
    globalIssues,
  );
  return finalizeReport({
    bindings,
    candidate,
    generatedAt,
    globalIssues,
    manualReconciliation,
    runnerAttestation,
    runs,
  });
}

function validateFoundationInputs({ corpus, sourceRegistry, launchCoverage }) {
  if (!validateCorpusDocument(corpus)) throw new Error("Benchmark corpus schema is invalid");
  if (!validateSourceRegistryDocument(sourceRegistry)) {
    throw new Error("Source registry schema is invalid");
  }
  if (!validateLaunchCoverageDocument(launchCoverage)) {
    throw new Error("Launch coverage schema is invalid");
  }

  const sourceIds = sourceRegistry.sources.map(({ id }) => id);
  const chainIds = launchCoverage.requiredChains.map(({ id }) => id).sort(compareText);
  const regionIds = launchCoverage.candidateRegions.map(({ id }) => id).sort(compareText);
  const scenarioIds = corpus.scenarios.map(({ id }) => id);
  const runIds = corpus.runs.map(({ id }) => id);
  if (!hasUnique(sourceIds)) throw new Error("Source registry IDs must be unique");
  if (!hasUnique(scenarioIds)) throw new Error("Benchmark scenario IDs must be unique");
  if (!hasUnique(runIds)) throw new Error("Benchmark run IDs must be unique");
  if (!sameStrings(chainIds, EXPECTED_CHAIN_IDS)) {
    throw new Error("Launch coverage must declare the exact three V1 chains");
  }
  if (!sameStrings(regionIds, EXPECTED_REGION_IDS)) {
    throw new Error("Launch coverage must declare the exact three V1 candidate regions");
  }

  const expectedCoverageKeys = EXPECTED_REGION_IDS.flatMap((regionId) =>
    EXPECTED_CHAIN_IDS.flatMap((chainId) =>
      PRICE_CLASSES.map((priceClass) => `${regionId}/${chainId}/${priceClass}`)))
    .sort(compareText);
  const coverageKeys = launchCoverage.coverage.map((cell) =>
    `${cell.regionId}/${cell.chainId}/${cell.priceClass}`).sort(compareText);
  if (!hasUnique(coverageKeys) || !sameStrings(coverageKeys, expectedCoverageKeys)) {
    throw new Error("Launch coverage must contain the exact 18-cell V1 matrix");
  }

  for (const scenario of corpus.scenarios) {
    if (!hasUnique(scenario.items.map(({ needId }) => needId))) {
      throw new Error("Benchmark need IDs must be unique within each scenario");
    }
    const unknownFocus = scenario.acceptanceFocus.filter((focus) =>
      FOCUS_REQUIREMENTS[focus] === undefined);
    if (unknownFocus.length > 0) {
      throw new Error(
        `Benchmark scenario has unimplemented acceptance focus: ${unknownFocus.join(", ")}`,
      );
    }
  }
  const expectedRunKeys = EXPECTED_REGION_IDS.flatMap((regionId) =>
    scenarioIds.map((scenarioId) => `${regionId}/${scenarioId}`)).sort(compareText);
  const runKeys = corpus.runs.map((run) => `${run.regionId}/${run.scenarioId}`).sort(compareText);
  if (!hasUnique(runKeys) || !sameStrings(runKeys, expectedRunKeys)) {
    throw new Error("Benchmark corpus must contain one run per region and scenario");
  }
}

export function candidateSchemaErrors(candidate) {
  return validateCandidateDocument(candidate)
    ? []
    : (validateCandidateDocument.errors ?? []).map(({ instancePath, keyword }) => ({
        instancePath,
        keyword,
      }));
}

export function reportSchemaErrors(report) {
  return validateReportDocument(report)
    ? []
    : (validateReportDocument.errors ?? []).map(({ instancePath, keyword }) => ({
        instancePath,
        keyword,
      }));
}

export function verifyBenchmarkReport({
  corpus,
  sourceRegistry,
  launchCoverage,
  candidate,
  runnerAttestation,
  report,
}) {
  const schemaErrors = reportSchemaErrors(report);
  if (schemaErrors.length > 0) return { valid: false, reason: "report-schema-invalid" };
  const recomputed = createBenchmarkReport({
    corpus,
    sourceRegistry,
    launchCoverage,
    ...(candidate === undefined ? {} : { candidate }),
    ...(runnerAttestation === undefined ? {} : { runnerAttestation }),
    generatedAt: report.generatedAt,
  });
  return sameJson(report, recomputed)
    ? { valid: true, reason: null }
    : { valid: false, reason: "report-semantic-mismatch" };
}

export const basketRunnerConstants = Object.freeze({
  expectedRuns: EXPECTED_RUN_COUNT,
  manualReconciliationsPerRegion: MANUAL_RECONCILIATIONS_PER_REGION,
  maximumStores: MAX_STORES,
  priceOnlyP95BudgetMs: PRICE_ONLY_P95_BUDGET_MS,
  protocolVersion: PROTOCOL_VERSION,
});
