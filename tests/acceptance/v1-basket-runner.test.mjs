import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  availabilityEvidenceIdFor,
  benchmarkBindings,
  candidateIdFor,
  createBenchmarkReport,
  createRunnerAttestationV2,
  frontierPlanIdFor,
  matchEvidenceIdFor,
  planIdFor,
  priceEvidenceIdFor,
  protocolCaseIdFor,
  protocolEvidenceIdFor,
  reconciliationEvidenceDigestFor,
  reconciliationIdFor,
  reportSchemaErrors,
  sha256Canonical,
  storeEvidenceIdFor,
  verifyBenchmarkReport,
} from "./v1-basket-runner.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const GENERATED_AT = "2026-07-17T06:00:00.000Z";
const MEASURED_AT = "2026-07-17T05:00:00.000Z";
const OBSERVED_AT = "2026-07-17T04:00:00.000Z";
const MEMBERSHIP_PROGRAM_A = "membership:bunnpris:program-a";
const MEMBERSHIP_PROGRAM_B = "membership:bunnpris:program-b";

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(root, relativePath), "utf8"));
}

function clone(value) {
  return structuredClone(value);
}

function fixtures() {
  return {
    corpus: readJson("docs/data/benchmark-baskets.v1.json"),
    sourceRegistry: readJson("docs/data/source-registry.v1.json"),
    launchCoverage: readJson("docs/data/launch-coverage.v1.json"),
  };
}

function eligibleFixtures() {
  const result = fixtures();
  result.corpus.runs = result.corpus.runs.map((run) => ({ ...run, status: "measured" }));
  result.sourceRegistry.sources = result.sourceRegistry.sources.map((source) =>
    source.id === "kassalapp"
      ? {
          ...source,
          runtimeState: "approved",
          publicRankingEligible: true,
          dataClasses: [
            ...new Set([
              ...source.dataClasses,
              "official_offer",
              "store_availability",
            ]),
          ],
          rights: {
            access: "permitted",
            processing: "permitted",
            retention: "permitted",
            derivedDisplay: "permitted",
            redistribution: "permitted",
            imagery: "not_applicable",
            marks: "not_applicable",
            attribution: "required",
          },
        }
      : source);
  result.launchCoverage.coverage = result.launchCoverage.coverage.map((cell) => ({
    ...cell,
    activeSourceId: "kassalapp",
    coverageStatus: "verified",
    evidenceLevel: "rights_cleared_measured",
    launchEligible: true,
  }));
  return result;
}

function expectedScope(launchCoverage, regionId) {
  const entries = launchCoverage.coverage
    .filter((cell) => cell.regionId === regionId)
    .map((cell) => cell.launchEligible
      ? {
          chainId: cell.chainId,
          priceClass: cell.priceClass,
          state: "verified",
          sourceId: cell.activeSourceId,
        }
      : {
          chainId: cell.chainId,
          priceClass: cell.priceClass,
          state: "unresolved",
        })
    .sort((left, right) =>
      `${left.chainId}/${left.priceClass}`.localeCompare(`${right.chainId}/${right.priceClass}`));
  return {
    qualification: entries.every(({ state }) => state === "verified")
      ? "declared-complete-coverage"
      : "among-verified-prices",
    entries,
  };
}

function buildCandidate({ corpus, sourceRegistry, launchCoverage }) {
  const bindings = benchmarkBindings({ corpus, sourceRegistry, launchCoverage });
  const execution = {
    environmentId: "acceptance:v1",
    measuredAt: MEASURED_AT,
    enabledSourceIds: ["kassalapp"],
  };
  const scenarioById = new Map(corpus.scenarios.map((scenario) => [scenario.id, scenario]));
  const storeEvidence = launchCoverage.candidateRegions.map((region) => {
    const evidence = {
      sourceId: "kassalapp",
      sourceRecordId: `store-record:bunnpris:${region.id}`,
      sourceRecordDigest: sha256Canonical({ regionId: region.id, chainId: "bunnpris" }),
      regionId: region.id,
      chainId: "bunnpris",
      storeId: `store:bunnpris:${region.id}`,
      observedAt: OBSERVED_AT,
      validUntil: "2026-07-18T04:00:00.000Z",
    };
    evidence.id = storeEvidenceIdFor(evidence);
    return evidence;
  }).sort((left, right) => left.id.localeCompare(right.id));
  const storeEvidenceByRegion = new Map(storeEvidence.map((evidence) => [evidence.regionId, evidence]));
  const priceEvidence = [];
  const matchEvidence = [];
  const runs = [];

  for (const corpusRun of [...corpus.runs].sort((left, right) => left.id.localeCompare(right.id))) {
    const scenario = scenarioById.get(corpusRun.scenarioId);
    const focus = new Set(scenario.acceptanceFocus);
    const branchEvidence = storeEvidenceByRegion.get(corpusRun.regionId);
    const store = {
      storeId: branchEvidence.storeId,
      chainId: "bunnpris",
      regionId: corpusRun.regionId,
      storeEvidenceId: branchEvidence.id,
    };
    const assignments = [];
    for (const [index, need] of [...scenario.items]
      .sort((left, right) => left.needId.localeCompare(right.needId))
      .entries()) {
      const canonicalProductId = need.identity.kind === "exact-product"
        ? need.identity.canonicalProductId
        : `product:${corpusRun.scenarioId}:${need.needId}`;
      const packageBaseUnits = need.requiredAmount.unit === "package"
        ? 1
        : index === 0 && focus.has("multibuy_remainder")
          ? Math.ceil(need.requiredAmount.value / 3)
          : need.requiredAmount.value;
      const packageCount = need.requiredAmount.unit === "package"
        ? need.requiredAmount.value
        : Math.ceil(need.requiredAmount.value / packageBaseUnits);
      const purchasedBaseUnits = need.requiredAmount.unit === "package"
        ? packageCount
        : packageCount * packageBaseUnits;
      const price = {
        sourceId: "kassalapp",
        sourceRecordId: `record:${corpusRun.id}:${need.needId}`,
        sourceRecordDigest: sha256Canonical({ runId: corpusRun.id, needId: need.needId }),
        chainId: "bunnpris",
        geographicScope: { kind: "region", regionId: corpusRun.regionId },
        canonicalProductId,
        priceClass: "ordinary",
        amountOre: 1_000 + index,
        packageBaseUnits,
        unit: need.requiredAmount.unit,
        ...(index === 0 && focus.has("variable_weight_disclosure")
          ? { packageKind: "variable-weight" }
          : {}),
        ...(index === 0 && focus.has("deposit_disclosure")
          ? { depositPerPackageOre: 200 }
          : {}),
        observedAt: OBSERVED_AT,
      };
      price.id = priceEvidenceIdFor(price);
      priceEvidence.push(price);

      const match = {
        runId: corpusRun.id,
        needId: need.needId,
        canonicalProductId,
        method: "reviewed-candidate",
        reviewedAt: OBSERVED_AT,
        reviewerId: "reviewer:acceptance",
        familyId: `family:${corpusRun.scenarioId}:${need.needId}`,
        candidateSetDigest: sha256Canonical({
          runId: corpusRun.id,
          needId: need.needId,
          canonicalProductId,
        }),
        declaredConstraints: [...need.constraints].sort((left, right) =>
          left.localeCompare(right)),
        unit: need.requiredAmount.unit,
      };
      match.id = matchEvidenceIdFor(match);
      matchEvidence.push(match);

      const ordinaryCostOre = (
        price.amountOre + (price.depositPerPackageOre ?? 0)
      ) * packageCount;
      assignments.push({
        needId: need.needId,
        canonicalProductId,
        storeId: store.storeId,
        chainId: store.chainId,
        packageCount,
        packageBaseUnits,
        purchasedBaseUnits,
        unit: need.requiredAmount.unit,
        ordinaryCostOre,
        costOre: ordinaryCostOre,
        priceEvidenceId: price.id,
        appliedOfferEvidenceId: null,
        matchEvidenceId: match.id,
      });
    }
    const run = {
      runId: corpusRun.id,
      regionId: corpusRun.regionId,
      scenarioId: corpusRun.scenarioId,
      state: "evaluated",
      evaluatedAt: MEASURED_AT,
      comparisonScope: expectedScope(launchCoverage, corpusRun.regionId),
      plan: {
        id: "plan:sha256:placeholder",
        stores: [store],
        assignments,
        totalOre: assignments.reduce((total, assignment) => total + assignment.costOre, 0),
      },
    };
    run.plan.id = planIdFor(run);
    runs.push(run);
  }

  priceEvidence.sort((left, right) => left.id.localeCompare(right.id));
  matchEvidence.sort((left, right) => left.id.localeCompare(right.id));
  const manualReconciliations = [];
  for (const region of launchCoverage.candidateRegions) {
    for (const run of runs.filter(({ regionId }) => regionId === region.id).slice(0, 5)) {
      const reconciliation = {
        runId: run.runId,
        reviewedAt: MEASURED_AT,
        reviewerId: "reviewer:manual",
        storeEvidenceIds: run.plan.stores
          .map(({ storeEvidenceId }) => storeEvidenceId)
          .sort((left, right) => left.localeCompare(right)),
        priceEvidenceIds: [...new Set(run.plan.assignments
          .flatMap(({ priceEvidenceId, appliedOfferEvidenceId }) => [
            priceEvidenceId,
            ...(appliedOfferEvidenceId === null ? [] : [appliedOfferEvidenceId]),
          ]))]
          .sort((left, right) => left.localeCompare(right)),
      };
      reconciliation.reviewedEvidenceDigest = reconciliationEvidenceDigestFor({
        evaluatedAt: run.evaluatedAt,
        priceEvidenceIds: reconciliation.priceEvidenceIds,
        runId: run.runId,
        storeEvidenceIds: reconciliation.storeEvidenceIds,
      });
      reconciliation.id = reconciliationIdFor(reconciliation);
      manualReconciliations.push(reconciliation);
    }
  }
  manualReconciliations.sort((left, right) => left.id.localeCompare(right.id));

  const candidate = {
    $schema: "./benchmark-basket-candidate.v1.schema.json",
    contractVersion: "2.0.0",
    kind: "handleplan-benchmark-basket-candidate",
    candidate: {
      id: "candidate:sha256:placeholder",
      commitSha: "a".repeat(40),
      imageDigest: `sha256:${"b".repeat(64)}`,
    },
    bindings,
    execution,
    storeEvidence,
    priceEvidence,
    availabilityEvidence: [],
    matchEvidence,
    manualReconciliations,
    runs,
  };
  candidate.candidate.id = candidateIdFor(candidate);
  return candidate;
}

function greatestCommonDivisor(left, right) {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function withProtocolCaseId(body) {
  const result = { id: "protocol-case:sha256:placeholder", ...body };
  result.id = protocolCaseIdFor(result);
  return result;
}

function addPriceEvidence(candidate, body) {
  const evidence = { id: "price-evidence:sha256:placeholder", ...body };
  evidence.id = priceEvidenceIdFor(evidence);
  candidate.priceEvidence.push(evidence);
  return evidence;
}

function addMatchEvidence(candidate, body) {
  const evidence = { id: "match-evidence:sha256:placeholder", ...body };
  evidence.id = matchEvidenceIdFor(evidence);
  candidate.matchEvidence.push(evidence);
  return evidence;
}

function quantityOption({ id, need, price, match }) {
  const packageCount = need.requiredAmount.unit === "package"
    ? need.requiredAmount.value
    : Math.ceil(need.requiredAmount.value / price.packageBaseUnits);
  const purchasedBaseUnits = need.requiredAmount.unit === "package"
    ? packageCount
    : packageCount * price.packageBaseUnits;
  const merchandiseTotalOre = packageCount * price.amountOre;
  const depositTotalOre = packageCount * (price.depositPerPackageOre ?? 0);
  const divisor = greatestCommonDivisor(price.amountOre, price.packageBaseUnits);
  return {
    id,
    priceEvidenceId: price.id,
    matchEvidenceId: match.id,
    packageCount,
    purchasedBaseUnits,
    surplusBaseUnits: need.requiredAmount.unit === "package"
      ? 0
      : purchasedBaseUnits - need.requiredAmount.value,
    merchandiseTotalOre,
    depositTotalOre,
    checkoutTotalOre: merchandiseTotalOre + depositTotalOre,
    unitRate: {
      numeratorOre: price.amountOre / divisor,
      denominatorBaseUnits: price.packageBaseUnits / divisor,
    },
  };
}

function rebuildCompleteQuantityCases(candidate, run, scenario) {
  const needById = new Map(scenario.items.map((need) => [need.needId, need]));
  return run.plan.assignments.map((assignment) => {
    const need = needById.get(assignment.needId);
    const matches = candidate.matchEvidence.filter((match) => {
      const declared = new Set(match.declaredConstraints);
      return match.runId === run.runId
        && match.needId === need.needId
        && match.unit === need.requiredAmount.unit
        && (need.identity.kind !== "exact-product"
          || match.canonicalProductId === need.identity.canonicalProductId)
        && need.constraints.every((constraint) => declared.has(constraint));
    });
    const options = matches.flatMap((match) => candidate.priceEvidence
      .filter((price) => price.priceClass === "ordinary"
        && price.chainId === assignment.chainId
        && price.unit === need.requiredAmount.unit
        && price.canonicalProductId === match.canonicalProductId
        && (price.geographicScope.kind === "national"
          || price.geographicScope.regionId === run.regionId)
        && (price.geographicScope.kind !== "store"
          || price.geographicScope.storeId === assignment.storeId))
      .map((price) => quantityOption({
        id: `option:${sha256Canonical({ priceEvidenceId: price.id, matchEvidenceId: match.id })}`,
        need,
        price,
        match,
      })))
      .sort((left, right) => left.id.localeCompare(right.id));
    const selected = [...options].sort((left, right) =>
      left.checkoutTotalOre - right.checkoutTotalOre
      || left.surplusBaseUnits - right.surplusBaseUnits
      || left.priceEvidenceId.localeCompare(right.priceEvidenceId)
      || left.matchEvidenceId.localeCompare(right.matchEvidenceId))[0];
    return withProtocolCaseId({
      needId: need.needId,
      selectedOptionId: selected.id,
      options,
    });
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function pricingActual({ pricingCase, ordinary, offer, historical }) {
  const ordinaryTotalOre = ordinary.amountOre * pricingCase.packageCount;
  const depositTotalOre = (ordinary.depositPerPackageOre ?? 0) * pricingCase.packageCount;
  let bundleCount = 0;
  let remainderCount = pricingCase.packageCount;
  let merchandiseTotalOre = ordinaryTotalOre;
  let offerState = "absent";
  let appliedPriceClass = "ordinary";
  if (offer !== undefined) {
    const membershipEligible = offer.offerTerms.membershipRequirement === "none"
      || pricingCase.enabledMembershipProgramIds.includes(
        offer.offerTerms.membershipProgramId,
      );
    const timeEligible = pricingCase.evaluatedAt >= offer.validFrom
      && pricingCase.evaluatedAt <= offer.validUntil;
    const conditionEligible = pricingCase.packageCount >= offer.offerTerms.minimumPackages
      && pricingCase.packageCount >= offer.offerTerms.bundleSize;
    if (membershipEligible && timeEligible && conditionEligible) {
      bundleCount = Math.floor(pricingCase.packageCount / offer.offerTerms.bundleSize);
      remainderCount = pricingCase.packageCount % offer.offerTerms.bundleSize;
      const offeredTotal = bundleCount * offer.amountOre
        + remainderCount * ordinary.amountOre;
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
  return {
    offerState,
    appliedPriceClass,
    bundleCount,
    remainderCount,
    ordinaryTotalOre,
    merchandiseTotalOre,
    depositTotalOre,
    checkoutTotalOre: merchandiseTotalOre + depositTotalOre,
    officialSavingsOre: ordinaryTotalOre - merchandiseTotalOre,
    historicalUnitDifferenceOre: historical === undefined
      ? null
      : ordinary.amountOre - historical.amountOre,
  };
}

function ensureStoreEvidence(candidate, regionId, chainId) {
  const existing = candidate.storeEvidence.find((evidence) =>
    evidence.regionId === regionId && evidence.chainId === chainId);
  if (existing !== undefined) return existing;
  const evidence = {
    sourceId: "kassalapp",
    sourceRecordId: `store-record:${chainId}:${regionId}`,
    sourceRecordDigest: sha256Canonical({ regionId, chainId }),
    regionId,
    chainId,
    storeId: `store:${chainId}:${regionId}`,
    observedAt: OBSERVED_AT,
    validUntil: "2026-07-18T04:00:00.000Z",
  };
  evidence.id = storeEvidenceIdFor(evidence);
  candidate.storeEvidence.push(evidence);
  return evidence;
}

function frontierPlan(body) {
  const result = { id: "frontier-plan:sha256:placeholder", ...body };
  result.id = frontierPlanIdFor(result);
  return result;
}

function planDominates(left, right) {
  return left.stores.length <= right.stores.length
    && left.totalOre <= right.totalOre
    && (left.stores.length < right.stores.length || left.totalOre < right.totalOre);
}

function addFrontierPrice(candidate, base, run, chainId, storeCount) {
  return addPriceEvidence(candidate, {
    ...base,
    sourceRecordId: `frontier:${run.runId}:${storeCount}:${chainId}:${base.canonicalProductId}`,
    sourceRecordDigest: sha256Canonical({
      runId: run.runId,
      storeCount,
      chainId,
      canonicalProductId: base.canonicalProductId,
    }),
    chainId,
    amountOre: chainId === base.chainId
      ? base.amountOre + storeCount * 1_000
      : Math.max(1, base.amountOre - (storeCount - 1) * 100),
  });
}

function attachExecutableProtocols(input, candidate) {
  const scenarioById = new Map(input.corpus.scenarios.map((scenario) => [scenario.id, scenario]));
  const basePriceById = new Map(candidate.priceEvidence.map((evidence) => [evidence.id, evidence]));
  const baseMatchById = new Map(candidate.matchEvidence.map((evidence) => [evidence.id, evidence]));
  const otherRegion = new Map([
    ["no-0301-oslo", "no-4601-bergen"],
    ["no-4601-bergen", "no-5001-trondheim"],
    ["no-5001-trondheim", "no-0301-oslo"],
  ]);

  for (const run of candidate.runs) {
    const scenario = scenarioById.get(run.scenarioId);
    const focus = new Set(scenario.acceptanceFocus);
    const needById = new Map(scenario.items.map((need) => [need.needId, need]));
    const assignmentByNeed = new Map(run.plan.assignments.map((assignment) => [
      assignment.needId,
      assignment,
    ]));
    let quantityCases = [];
    for (const assignment of run.plan.assignments) {
      const need = needById.get(assignment.needId);
      const basePrice = basePriceById.get(assignment.priceEvidenceId);
      const baseMatch = baseMatchById.get(assignment.matchEvidenceId);
      const options = [quantityOption({
        id: `option:base:${need.needId}`,
        need,
        price: basePrice,
        match: baseMatch,
      })];
      const needsAlternative = quantityCases.length === 0 && [
        "deposit_disclosure",
        "package_rounding",
        "package_size_tradeoff",
        "package_surplus",
        "variable_weight_disclosure",
      ].some((name) => focus.has(name));
      if (needsAlternative) {
        const canonicalProductId = `${basePrice.canonicalProductId}:alternate`;
        const alternatePrice = addPriceEvidence(candidate, {
          ...basePrice,
          sourceRecordId: `quantity-option:${run.runId}:${need.needId}`,
          sourceRecordDigest: sha256Canonical({ runId: run.runId, needId: need.needId }),
          canonicalProductId,
          amountOre: basePrice.amountOre * 5,
          packageBaseUnits: need.requiredAmount.unit === "package"
            ? 1
            : need.requiredAmount.value + 1,
          ...(focus.has("variable_weight_disclosure")
            ? { packageKind: "variable-weight" }
            : { packageKind: "fixed" }),
          ...(focus.has("deposit_disclosure")
            ? { depositPerPackageOre: 200 }
            : {}),
        });
        const alternateMatch = addMatchEvidence(candidate, {
          ...baseMatch,
          canonicalProductId,
          candidateSetDigest: sha256Canonical({
            runId: run.runId,
            needId: need.needId,
            canonicalProductId,
          }),
        });
        options.push(quantityOption({
          id: `option:alternate:${need.needId}`,
          need,
          price: alternatePrice,
          match: alternateMatch,
        }));
      }
      options.sort((left, right) => left.id.localeCompare(right.id));
      const selected = [...options].sort((left, right) =>
        left.checkoutTotalOre - right.checkoutTotalOre
        || left.surplusBaseUnits - right.surplusBaseUnits
        || left.id.localeCompare(right.id))[0];
      quantityCases.push(withProtocolCaseId({
        needId: need.needId,
        selectedOptionId: selected.id,
        options,
      }));
    }
    quantityCases.sort((left, right) => left.id.localeCompare(right.id));

    const matchCases = [];
    for (const assignment of run.plan.assignments) {
      const need = needById.get(assignment.needId);
      matchCases.push(withProtocolCaseId({
        needId: need.needId,
        matchEvidenceId: assignment.matchEvidenceId,
        userDecision: "approved",
        actual: {
          state: "selected",
          reason: "eligible-reviewed-candidate",
          explanationCode: need.matchMode === "constrained"
            ? "constraints-satisfied"
            : "reviewed-family-approved",
        },
      }));
    }
    if ([
      "no_silent_substitution",
      "review_required_matches",
      "substitution_safety",
    ].some((name) => focus.has(name))) {
      const assignment = run.plan.assignments[0];
      matchCases.push(withProtocolCaseId({
        needId: assignment.needId,
        matchEvidenceId: assignment.matchEvidenceId,
        userDecision: "not-reviewed",
        actual: { state: "review-required", reason: "user-approval-required" },
      }));
    }
    if ([
      "constraint_enforcement",
      "dietary_constraint",
      "fresh_vs_frozen_substitution",
      "frozen_constraint",
      "substitution_safety",
    ].some((name) => focus.has(name))) {
      const need = scenario.items.find(({ constraints }) => constraints.length > 0);
      const assignment = assignmentByNeed.get(need.needId);
      const baseMatch = baseMatchById.get(assignment.matchEvidenceId);
      const rejectedMatch = addMatchEvidence(candidate, {
        ...baseMatch,
        canonicalProductId: `${baseMatch.canonicalProductId}:constraint-mismatch`,
        candidateSetDigest: sha256Canonical({ runId: run.runId, rejected: need.needId }),
        declaredConstraints: [],
      });
      matchCases.push(withProtocolCaseId({
        needId: need.needId,
        matchEvidenceId: rejectedMatch.id,
        userDecision: "approved",
        actual: { state: "rejected", reason: "constraint-mismatch" },
      }));
    }
    matchCases.sort((left, right) => left.id.localeCompare(right.id));

    const pricingCases = [];
    let officialOffer;
    let memberBOffer;
    const needsPricing = [
      "historical_vs_official",
      "member_eligibility",
      "multibuy_remainder",
      "offer_conditions",
      "offer_expiry",
      "savings_context",
      "savings_endpoint",
    ].some((name) => focus.has(name));
    if (needsPricing) {
      const assignment = run.plan.assignments[0];
      const ordinary = basePriceById.get(assignment.priceEvidenceId);
      const membershipRequired = focus.has("member_eligibility");
      const packageCount = assignment.packageCount;
      const bundleSize = packageCount >= 2 ? 2 : 1;
      officialOffer = addPriceEvidence(candidate, {
        ...ordinary,
        sourceRecordId: `official-offer:${run.runId}:${assignment.needId}`,
        sourceRecordDigest: sha256Canonical({ runId: run.runId, official: assignment.needId }),
        priceClass: "official_offer",
        amountOre: Math.max(1, ordinary.amountOre * bundleSize - 100),
        offerTerms: {
          bundleSize,
          minimumPackages: bundleSize,
          membershipRequirement: membershipRequired ? "required" : "none",
          ...(membershipRequired ? { membershipProgramId: MEMBERSHIP_PROGRAM_A } : {}),
        },
        validFrom: "2026-07-17T04:00:00.000Z",
        validUntil: "2026-07-17T05:30:00.000Z",
      });
      if (membershipRequired) {
        memberBOffer = addPriceEvidence(candidate, {
          ...ordinary,
          sourceRecordId: `official-offer-member-b:${run.runId}:${assignment.needId}`,
          sourceRecordDigest: sha256Canonical({
            runId: run.runId,
            official: assignment.needId,
            membershipProgramId: MEMBERSHIP_PROGRAM_B,
          }),
          priceClass: "official_offer",
          amountOre: Math.max(1, ordinary.amountOre * bundleSize - 200),
          offerTerms: {
            bundleSize,
            minimumPackages: bundleSize,
            membershipRequirement: "required",
            membershipProgramId: MEMBERSHIP_PROGRAM_B,
          },
          validFrom: "2026-07-17T04:00:00.000Z",
          validUntil: "2026-07-17T05:30:00.000Z",
        });
      }
      let historical;
      if (focus.has("historical_vs_official") || focus.has("savings_context")) {
        historical = addPriceEvidence(candidate, {
          ...ordinary,
          sourceRecordId: `historical:${run.runId}:${assignment.needId}`,
          sourceRecordDigest: sha256Canonical({ runId: run.runId, historical: assignment.needId }),
          priceClass: "historical",
          amountOre: ordinary.amountOre + 200,
        });
      }
      const membershipCases = membershipRequired
        ? [
            { offer: officialOffer, enabledMembershipProgramIds: [] },
            {
              offer: officialOffer,
              enabledMembershipProgramIds: [MEMBERSHIP_PROGRAM_A],
            },
            {
              offer: memberBOffer,
              enabledMembershipProgramIds: [MEMBERSHIP_PROGRAM_A],
            },
          ]
        : [{ offer: officialOffer, enabledMembershipProgramIds: [] }];
      for (const membershipCase of membershipCases) {
        const body = {
          needId: assignment.needId,
          ordinaryPriceEvidenceId: ordinary.id,
          officialOfferEvidenceId: membershipCase.offer.id,
          ...(historical === undefined ? {} : { historicalPriceEvidenceId: historical.id }),
          packageCount,
          enabledMembershipProgramIds: membershipCase.enabledMembershipProgramIds,
          evaluatedAt: run.evaluatedAt,
        };
        pricingCases.push(withProtocolCaseId({
          ...body,
          actual: pricingActual({
            pricingCase: body,
            ordinary,
            offer: membershipCase.offer,
            historical,
          }),
        }));
      }
    }
    pricingCases.sort((left, right) => left.id.localeCompare(right.id));

    const firstAssignment = run.plan.assignments.find((assignment) =>
      needById.get(assignment.needId).identity.kind !== "exact-product")
      ?? run.plan.assignments[0];
    const firstPrice = basePriceById.get(firstAssignment.priceEvidenceId);
    const unavailableProductId = `${firstAssignment.canonicalProductId}:not-carried`;
    const unavailableMatch = addMatchEvidence(candidate, {
      ...baseMatchById.get(firstAssignment.matchEvidenceId),
      canonicalProductId: unavailableProductId,
      candidateSetDigest: sha256Canonical({
        runId: run.runId,
        needId: firstAssignment.needId,
        canonicalProductId: unavailableProductId,
      }),
    });
    const availability = {
      sourceId: "kassalapp",
      sourceRecordId: `availability:${run.runId}:${firstAssignment.needId}`,
      sourceRecordDigest: sha256Canonical({ runId: run.runId, unavailable: firstAssignment.needId }),
      regionId: run.regionId,
      chainId: firstAssignment.chainId,
      storeId: firstAssignment.storeId,
      canonicalProductId: unavailableProductId,
      state: "known-not-carried",
      observedAt: OBSERVED_AT,
      validUntil: "2026-07-18T04:00:00.000Z",
    };
    availability.id = availabilityEvidenceIdFor(availability);
    candidate.availabilityEvidence.push(availability);
    const negativeControls = [
      withProtocolCaseId({
        kind: "stale-price",
        priceEvidenceId: firstPrice.id,
        evaluatedAt: "2026-08-01T05:00:00.000Z",
        actual: { state: "rejected", reason: "stale" },
      }),
      withProtocolCaseId({
        kind: "wrong-region",
        priceEvidenceId: firstPrice.id,
        requestedRegionId: otherRegion.get(run.regionId),
        actual: { state: "rejected", reason: "wrong-region" },
      }),
      withProtocolCaseId({
        kind: "ineligible-source",
        priceEvidenceId: firstPrice.id,
        disabledSourceId: firstPrice.sourceId,
        actual: { state: "rejected", reason: "source-ineligible" },
      }),
      withProtocolCaseId({
        kind: "known-not-carried",
        needId: firstAssignment.needId,
        matchEvidenceId: unavailableMatch.id,
        availabilityEvidenceId: availability.id,
        actual: { state: "known-not-carried" },
      }),
      withProtocolCaseId({
        kind: "partial-coverage",
        disabledCell: { chainId: "bunnpris", priceClass: "ordinary" },
        actual: { state: "partial", qualification: "among-verified-prices" },
      }),
    ];
    const exactNeed = scenario.items.find(({ identity }) => identity.kind === "exact-product");
    if (exactNeed !== undefined) {
      const exactAssignment = assignmentByNeed.get(exactNeed.needId);
      const exactMatch = baseMatchById.get(exactAssignment.matchEvidenceId);
      const mismatch = addMatchEvidence(candidate, {
        ...exactMatch,
        canonicalProductId: `${exactNeed.identity.canonicalProductId}:mismatch`,
        candidateSetDigest: sha256Canonical({
          runId: run.runId,
          exactProductMismatch: exactNeed.needId,
        }),
      });
      negativeControls.push(withProtocolCaseId({
        kind: "exact-product-mismatch",
        needId: exactNeed.needId,
        matchEvidenceId: mismatch.id,
        actual: { state: "rejected", reason: "exact-product-mismatch" },
      }));
    }
    if (focus.has("offer_expiry")) {
      negativeControls.push(withProtocolCaseId({
        kind: "expired-offer",
        officialOfferEvidenceId: officialOffer.id,
        evaluatedAt: "2026-07-17T06:00:00.000Z",
        actual: { state: "rejected", reason: "offer-expired" },
      }));
    }
    negativeControls.sort((left, right) => left.id.localeCompare(right.id));

    const baseFrontierPlan = frontierPlan({
      stores: structuredClone(run.plan.stores),
      assignments: structuredClone(run.plan.assignments),
      totalOre: run.plan.totalOre,
    });
    const frontierPlans = [baseFrontierPlan];
    const needsThreeStoreFrontier = [
      "frontier_endpoints",
      "multi_store_frontier",
      "nondominated_frontier",
      "cross_chain_coverage",
    ].some((name) => focus.has(name));
    if (needsThreeStoreFrontier) {
      const storeEvidence = [
        ensureStoreEvidence(candidate, run.regionId, "bunnpris"),
        ensureStoreEvidence(candidate, run.regionId, "extra"),
        ensureStoreEvidence(candidate, run.regionId, "rema-1000"),
      ];
      for (const storeCount of [2, 3]) {
        const stores = storeEvidence.slice(0, storeCount).map((evidence) => ({
          storeId: evidence.storeId,
          chainId: evidence.chainId,
          regionId: evidence.regionId,
          storeEvidenceId: evidence.id,
        })).sort((left, right) => left.storeId.localeCompare(right.storeId));
        const assignments = run.plan.assignments.map((assignment, index) => {
          const store = stores[index % storeCount];
          const base = basePriceById.get(assignment.priceEvidenceId);
          const price = addFrontierPrice(candidate, base, run, store.chainId, storeCount);
          return {
            ...assignment,
            storeId: store.storeId,
            chainId: store.chainId,
            ordinaryCostOre: (
              price.amountOre + (price.depositPerPackageOre ?? 0)
            ) * assignment.packageCount,
            costOre: (
              price.amountOre + (price.depositPerPackageOre ?? 0)
            ) * assignment.packageCount,
            priceEvidenceId: price.id,
            appliedOfferEvidenceId: null,
          };
        });
        frontierPlans.push(frontierPlan({
          stores,
          assignments,
          totalOre: assignments.reduce((total, assignment) => total + assignment.costOre, 0),
        }));
      }
    }
    frontierPlans.sort((left, right) => left.id.localeCompare(right.id));
    const nondominatedPlans = frontierPlans.filter((candidatePlan) =>
      !frontierPlans.some((otherPlan) =>
        otherPlan.id !== candidatePlan.id && planDominates(otherPlan, candidatePlan)));
    const returnedPlanIds = nondominatedPlans.map(({ id }) => id).sort((left, right) =>
      left.localeCompare(right));
    const convenience = [...nondominatedPlans].sort((left, right) =>
      left.stores.length - right.stores.length
      || left.totalOre - right.totalOre
      || left.id.localeCompare(right.id))[0];
    const savings = [...nondominatedPlans].sort((left, right) =>
      left.totalOre - right.totalOre
      || left.stores.length - right.stores.length
      || left.id.localeCompare(right.id))[0];
    const frontier = {
      plans: frontierPlans,
      returnedPlanIds,
      convenienceEndpointPlanId: convenience.id,
      savingsEndpointPlanId: savings.id,
    };
    quantityCases = rebuildCompleteQuantityCases(candidate, run, scenario);
    const enabledMembershipProgramIds = focus.has("member_eligibility")
      ? [MEMBERSHIP_PROGRAM_A]
      : [];
    const oracleRequest = { contractVersion: 2, enabledMembershipProgramIds };
    const requestDigest = sha256Canonical({
      bindings: candidate.bindings,
      candidateId: candidate.candidate.id,
      environmentId: candidate.execution.environmentId,
      evaluatedAt: run.evaluatedAt,
      oracleRequest,
      protocolVersion: "2.0.0",
      regionId: run.regionId,
      runId: run.runId,
      scenarioDigest: sha256Canonical(scenario),
    });
    const resultDigest = sha256Canonical({
      comparisonScope: run.comparisonScope,
      oracleRequest,
      frontier,
      plan: run.plan,
    });
    const sampleCount = focus.has("performance") ? 20 : 2;
    const samples = Array.from({ length: sampleCount }, () => ({
      startedAt: "2026-07-17T04:30:00.000Z",
      completedAt: "2026-07-17T04:30:00.100Z",
      requestDigest,
      resultDigest,
    }));
    const protocol = {
      id: "protocol-evidence:sha256:placeholder",
      oracleRequest,
      protocolVersion: "2.0.0",
      scenarioDigest: sha256Canonical(scenario),
      quantityCases,
      pricingCases,
      matchCases,
      negativeControls,
      frontier,
      replay: {
        requestDigest,
        resultDigest,
        reportedP95Ms: 100,
        samples,
      },
    };
    protocol.id = protocolEvidenceIdFor(protocol);
    run.protocol = protocol;
  }

  candidate.storeEvidence.sort((left, right) => left.id.localeCompare(right.id));
  candidate.priceEvidence.sort((left, right) => left.id.localeCompare(right.id));
  candidate.matchEvidence.sort((left, right) => left.id.localeCompare(right.id));
  candidate.availabilityEvidence.sort((left, right) => left.id.localeCompare(right.id));
  candidate.candidate.id = candidateIdFor(candidate);
  return candidate;
}

function alignProtocolFrontiersToV2Oracle(input, candidate) {
  const provisional = createRunnerAttestationV2({
    ...input,
    candidate,
    attestedAt: MEASURED_AT,
    measureDurationMs: () => 100,
  });
  const attestedByRun = new Map(provisional.runs.map((run) => [run.runId, run]));
  for (const run of candidate.runs) {
    const attested = attestedByRun.get(run.runId);
    const planBySignature = new Map();
    const plans = attested.oracleResult.feasiblePlans.map((oraclePlan) => {
      const stores = oraclePlan.storeIds.map((storeId) => {
        const evidence = candidate.storeEvidence.find((entry) =>
          entry.regionId === run.regionId && entry.storeId === storeId);
        return {
          storeId,
          chainId: evidence.chainId,
          regionId: run.regionId,
          storeEvidenceId: evidence.id,
        };
      }).sort((left, right) => left.storeId.localeCompare(right.storeId));
      const assignments = oraclePlan.assignments.map((assignment) => ({
        needId: assignment.needId,
        canonicalProductId: assignment.canonicalProductId,
        storeId: assignment.storeId,
        chainId: assignment.chainId,
        packageCount: assignment.packageCount,
        packageBaseUnits: assignment.packageBaseUnits,
        purchasedBaseUnits: assignment.purchasedBaseUnits,
        unit: assignment.unit,
        ordinaryCostOre: assignment.ordinaryCostOre,
        costOre: assignment.costOre,
        priceEvidenceId: assignment.ordinaryPriceEvidenceId,
        appliedOfferEvidenceId: assignment.appliedOfferEvidenceId,
        matchEvidenceId: assignment.matchEvidenceId,
      }));
      const plan = frontierPlan({ stores, assignments, totalOre: oraclePlan.totalOre });
      planBySignature.set(oraclePlan.signature, plan);
      return plan;
    }).sort((left, right) => left.id.localeCompare(right.id));
    run.protocol.frontier = {
      plans,
      returnedPlanIds: attested.oracleResult.frontierPlanSignatures
        .map((signature) => planBySignature.get(signature).id)
        .sort((left, right) => left.localeCompare(right)),
      convenienceEndpointPlanId: planBySignature
        .get(attested.oracleResult.convenienceEndpointSignature).id,
      savingsEndpointPlanId: planBySignature
        .get(attested.oracleResult.savingsEndpointSignature).id,
    };
    const resultDigest = sha256Canonical({
      comparisonScope: run.comparisonScope,
      frontier: run.protocol.frontier,
      oracleRequest: run.protocol.oracleRequest,
      plan: run.plan,
    });
    run.protocol.replay.resultDigest = resultDigest;
    run.protocol.replay.samples = run.protocol.replay.samples.map((sample) => ({
      ...sample,
      resultDigest,
    }));
    run.protocol.id = protocolEvidenceIdFor(run.protocol);
  }
  candidate.storeEvidence.sort((left, right) => left.id.localeCompare(right.id));
  candidate.priceEvidence.sort((left, right) => left.id.localeCompare(right.id));
  candidate.matchEvidence.sort((left, right) => left.id.localeCompare(right.id));
  return candidate;
}

function report(input, candidate, runnerAttestation) {
  return createBenchmarkReport({
    ...input,
    candidate,
    runnerAttestation,
    generatedAt: GENERATED_AT,
  });
}

function findNonReconciledRun(candidate) {
  const reconciled = new Set(candidate.manualReconciliations.map(({ runId }) => runId));
  return candidate.runs.find(({ runId }) => !reconciled.has(runId));
}

test("current source-neutral corpus produces a blocked report with 60 explicit pending runs", () => {
  const input = fixtures();
  const first = report(input);
  const second = createBenchmarkReport({
    ...input,
    generatedAt: "2026-07-17T07:00:00.000Z",
  });

  assert.equal(first.status, "blocked");
  assert.equal(first.acceptancePassed, false);
  assert.deepEqual(first.summary, {
    expectedRuns: 60,
    passedRuns: 0,
    protocolPassedRuns: 0,
    blockedRuns: 0,
    failedRuns: 0,
    pendingRuns: 60,
  });
  assert.equal(first.issues.filter(({ code }) => code === "no-eligible-live-evidence").length, 3);
  assert.ok(first.runs.every(({ status, issues }) =>
    status === "pending" && issues.includes("corpus-run-pending")));
  assert.equal(first.reportId, second.reportId, "wall-clock time is not part of report identity");
});

test("blocks a modeled-only candidate until every executable protocol is supplied", () => {
  const input = eligibleFixtures();
  const candidate = buildCandidate(input);
  const result = report(input, candidate);

  assert.equal(result.status, "blocked");
  assert.equal(result.acceptancePassed, false);
  assert.equal(result.summary.blockedRuns, 60);
  assert.equal(result.summary.protocolPassedRuns, 0);
  assert.ok(result.runs.every(({ status, issues, verifiedFocus }) =>
    status === "blocked"
      && issues.includes("protocol-evidence-missing")
      && verifiedFocus.length === 0));
  assert.ok(result.issues.every(({ code }) => code !== "real-basket-protocols-not-implemented"));
});

test("accepts a fully supplied synthetic V2 candidate through the independent oracle", () => {
  const input = eligibleFixtures();
  const candidate = alignProtocolFrontiersToV2Oracle(
    input,
    attachExecutableProtocols(input, buildCandidate(input)),
  );
  const runnerAttestation = createRunnerAttestationV2({
    ...input,
    candidate,
    attestedAt: MEASURED_AT,
    measureDurationMs: () => 100,
  });
  const result = report(input, candidate, runnerAttestation);

  assert.equal(result.status, "accepted", JSON.stringify({
    issues: result.issues,
    failed: result.runs.filter(({ status }) => status !== "passed"),
  }, null, 2));
  assert.equal(result.acceptancePassed, true);
  assert.equal(result.summary.passedRuns, 60);
  assert.equal(result.summary.protocolPassedRuns, 60);
  assert.equal(result.summary.blockedRuns, 0);
  assert.ok(result.runs.every(({ status, issues }) =>
    status === "passed" && issues.length === 0));
  const discountedRuns = runnerAttestation.runs.filter(({ oracleResult }) =>
    oracleResult.discountedFrontierPlanSignatures.length > 0);
  assert.ok(discountedRuns.length > 0, "the accepted fixture must exercise a changed frontier");
  assert.ok(discountedRuns.every(({ oracleResult }) =>
    oracleResult.discountedFrontierPlanSignatures.every((signature) =>
      oracleResult.frontierPlanSignatures.includes(signature)
        && oracleResult.feasiblePlans.some((plan) =>
          plan.signature === signature
            && plan.assignments.some((assignment) =>
              assignment.appliedOfferEvidenceId !== null
                && assignment.costOre < assignment.ordinaryCostOre)))));
  const offerAwareScenarioIds = new Set(input.corpus.scenarios
    .filter(({ acceptanceFocus }) => acceptanceFocus.some((focus) => [
      "historical_vs_official",
      "member_eligibility",
      "multibuy_remainder",
      "offer_conditions",
      "savings_context",
      "savings_endpoint",
    ].includes(focus)))
    .map(({ id }) => id));
  assert.ok(candidate.runs
    .filter(({ scenarioId }) => offerAwareScenarioIds.has(scenarioId))
    .every(({ runId }) => runnerAttestation.runs
      .find((attested) => attested.runId === runId)
      .oracleResult.discountedFrontierPlanSignatures.length > 0));
  const memberRun = runnerAttestation.runs.find(({ runId }) =>
    candidate.runs.find((candidateRun) => candidateRun.runId === runId)?.scenarioId
      === "s09-personal-care");
  assert.deepEqual(memberRun.snapshot.enabledMembershipProgramIds, [MEMBERSHIP_PROGRAM_A]);
  assert.ok(memberRun.oracleResult.discountedFrontierPlanSignatures.length > 0);
  assert.ok(memberRun.oracleResult.feasiblePlans.some(({ assignments }) =>
    assignments.some(({ appliedOfferEvidenceId }) => {
      const offer = candidate.priceEvidence.find(({ id }) => id === appliedOfferEvidenceId);
      return offer?.offerTerms?.membershipProgramId === MEMBERSHIP_PROGRAM_A;
    })));
  assert.ok(memberRun.oracleResult.feasiblePlans.every(({ assignments }) =>
    assignments.every(({ appliedOfferEvidenceId }) => {
      const offer = candidate.priceEvidence.find(({ id }) => id === appliedOfferEvidenceId);
      return offer?.offerTerms?.membershipProgramId !== MEMBERSHIP_PROGRAM_B;
    })));
  const multibuyRun = runnerAttestation.runs.find(({ runId }) =>
    candidate.runs.find((candidateRun) => candidateRun.runId === runId)?.scenarioId
      === "s04-taco-night");
  assert.ok(multibuyRun.oracleResult.feasiblePlans.some(({ assignments }) =>
    assignments.some((assignment) => {
      const offer = candidate.priceEvidence.find(({ id }) =>
        id === assignment.appliedOfferEvidenceId);
      return offer !== undefined
        && offer.offerTerms.bundleSize > 1
        && assignment.packageCount % offer.offerTerms.bundleSize > 0;
    })));
  const depositRun = runnerAttestation.runs.find(({ runId }) =>
    candidate.runs.find((candidateRun) => candidateRun.runId === runId)?.scenarioId
      === "s17-picnic-snacks");
  assert.ok(depositRun.oracleResult.feasiblePlans.some(({ assignments }) =>
    assignments.some((assignment) => {
      const ordinary = candidate.priceEvidence.find(({ id }) =>
        id === assignment.ordinaryPriceEvidenceId);
      return (ordinary?.depositPerPackageOre ?? 0) > 0
        && assignment.ordinaryCostOre
          === (ordinary.amountOre + ordinary.depositPerPackageOre) * assignment.packageCount;
    })));
  const candidateRunById = new Map(candidate.runs.map((run) => [run.runId, run]));
  for (const run of result.runs) {
    const candidateRun = candidateRunById.get(run.runId);
    assert.equal(run.replayBindingDigest, sha256Canonical({
      candidateDocumentDigest: result.candidateDocumentDigest,
      protocolId: candidateRun.protocol.id,
      replay: candidateRun.protocol.replay,
      runnerAttestationRunDigest: sha256Canonical(
        runnerAttestation.runs.find(({ runId }) => runId === run.runId),
      ),
    }));
  }
  for (const focus of [
    "deposit_disclosure",
    "variable_weight_disclosure",
    "savings_endpoint",
  ]) {
    const scenario = input.corpus.scenarios.find(({ acceptanceFocus }) =>
      acceptanceFocus.includes(focus));
    const run = result.runs.find(({ scenarioId }) => scenarioId === scenario.id);
    assert.equal(run.verifiedFocus.includes(focus), true);
  }
  const variableScenario = input.corpus.scenarios.find(({ acceptanceFocus }) =>
    acceptanceFocus.includes("variable_weight_disclosure"));
  assert.equal(result.runs.find(({ scenarioId }) => scenarioId === variableScenario.id).status,
    "passed");
});

test("rejects tampered, omitted, unauthorized, wrong-program, and noncanonical offers", () => {
  {
    const { input, candidate } = protocolCandidate();
    const run = candidate.runs.find(({ scenarioId }) => scenarioId === "s04-taco-night");
    const plan = run.protocol.frontier.plans.find(({ assignments }) =>
      assignments.some(({ appliedOfferEvidenceId }) => appliedOfferEvidenceId !== null));
    const assignment = plan.assignments.find(({ appliedOfferEvidenceId }) =>
      appliedOfferEvidenceId !== null);
    assignment.costOre += 1;
    plan.totalOre += 1;
    plan.id = frontierPlanIdFor(plan);
    run.protocol.id = protocolEvidenceIdFor(run.protocol);
    const result = report(input, candidate);
    assert.ok(result.runs.find(({ runId }) => runId === run.runId).issues
      .includes("frontier-assignment-invalid"));
  }

  {
    const { input, candidate } = protocolCandidate();
    const run = candidate.runs.find(({ scenarioId }) => scenarioId === "s04-taco-night");
    const assignment = run.protocol.frontier.plans
      .flatMap(({ assignments }) => assignments)
      .find(({ appliedOfferEvidenceId }) => appliedOfferEvidenceId !== null);
    delete assignment.appliedOfferEvidenceId;
    const result = report(input, candidate);
    assert.equal(result.status, "failed");
    assert.ok(result.issues.some(({ code }) => code === "candidate-schema-invalid"));
  }

  {
    const { input, candidate } = protocolCandidate();
    const run = candidate.runs.find(({ scenarioId }) => scenarioId === "s09-personal-care");
    assert.ok(run.protocol.frontier.plans.some(({ assignments }) =>
      assignments.some(({ appliedOfferEvidenceId }) => appliedOfferEvidenceId !== null)));
    run.protocol.oracleRequest.enabledMembershipProgramIds = [];
    run.protocol.id = protocolEvidenceIdFor(run.protocol);
    const result = report(input, candidate);
    assert.ok(result.runs.find(({ runId }) => runId === run.runId).issues
      .includes("frontier-assignment-invalid"));
  }

  {
    const { input, candidate } = protocolCandidate();
    const run = candidate.runs.find(({ scenarioId }) => scenarioId === "s09-personal-care");
    const plan = run.protocol.frontier.plans.find(({ assignments }) =>
      assignments.some(({ appliedOfferEvidenceId }) => appliedOfferEvidenceId !== null));
    const assignment = plan.assignments.find(({ appliedOfferEvidenceId }) =>
      appliedOfferEvidenceId !== null);
    const ordinary = candidate.priceEvidence.find(({ id }) =>
      id === assignment.priceEvidenceId);
    const memberBOffer = candidate.priceEvidence.find((evidence) =>
      evidence.priceClass === "official_offer"
        && evidence.canonicalProductId === assignment.canonicalProductId
        && evidence.chainId === assignment.chainId
        && evidence.offerTerms.membershipProgramId === MEMBERSHIP_PROGRAM_B);
    const bundleCount = Math.floor(
      assignment.packageCount / memberBOffer.offerTerms.bundleSize,
    );
    const remainderCount = assignment.packageCount % memberBOffer.offerTerms.bundleSize;
    const memberBCostOre = bundleCount * memberBOffer.amountOre
      + remainderCount * ordinary.amountOre
      + assignment.packageCount * (ordinary.depositPerPackageOre ?? 0);
    plan.totalOre += memberBCostOre - assignment.costOre;
    assignment.costOre = memberBCostOre;
    assignment.appliedOfferEvidenceId = memberBOffer.id;
    plan.id = frontierPlanIdFor(plan);
    run.protocol.id = protocolEvidenceIdFor(run.protocol);
    const result = report(input, candidate);
    assert.ok(result.runs.find(({ runId }) => runId === run.runId).issues
      .includes("frontier-assignment-invalid"));
  }

  {
    const { input, candidate } = protocolCandidate();
    const run = candidate.runs.find(({ scenarioId }) => scenarioId === "s09-personal-care");
    run.protocol.oracleRequest.enabledMembershipProgramIds = [
      MEMBERSHIP_PROGRAM_B,
      MEMBERSHIP_PROGRAM_A,
    ];
    run.protocol.id = protocolEvidenceIdFor(run.protocol);
    const result = report(input, candidate);
    assert.ok(result.runs.find(({ runId }) => runId === run.runId).issues
      .includes("protocol-binding-mismatch"));
  }

  {
    const { input, candidate } = protocolCandidate();
    const run = candidate.runs.find(({ scenarioId }) => scenarioId === "s09-personal-care");
    const pricingCase = run.protocol.pricingCases.find(({ officialOfferEvidenceId }) => {
      const offer = candidate.priceEvidence.find(({ id }) => id === officialOfferEvidenceId);
      return offer?.offerTerms?.membershipProgramId === MEMBERSHIP_PROGRAM_A;
    });
    pricingCase.enabledMembershipProgramIds = [
      MEMBERSHIP_PROGRAM_B,
      MEMBERSHIP_PROGRAM_A,
    ];
    rebindProtocolCase(run, pricingCase);
    const result = report(input, candidate);
    assert.ok(result.runs.find(({ runId }) => runId === run.runId).issues
      .includes("protocol-pricing-evidence-invalid"));
  }

  {
    const { input, candidate } = protocolCandidate();
    const offer = candidate.priceEvidence.find((evidence) =>
      evidence.priceClass === "official_offer"
        && evidence.offerTerms.membershipRequirement === "required");
    delete offer.offerTerms.membershipProgramId;
    const result = report(input, candidate);
    assert.equal(result.status, "failed");
    assert.ok(result.issues.some(({ code }) => code === "candidate-schema-invalid"));
  }

  {
    const { input, candidate } = protocolCandidate();
    const offer = candidate.priceEvidence.find((evidence) =>
      evidence.priceClass === "official_offer"
        && evidence.offerTerms.membershipRequirement === "none");
    offer.offerTerms.membershipProgramId = MEMBERSHIP_PROGRAM_A;
    const result = report(input, candidate);
    assert.equal(result.status, "failed");
    assert.ok(result.issues.some(({ code }) => code === "candidate-schema-invalid"));
  }
});

test("keeps an executable candidate blocked until separate V2 runner evidence is supplied", () => {
  const input = eligibleFixtures();
  const candidate = alignProtocolFrontiersToV2Oracle(
    input,
    attachExecutableProtocols(input, buildCandidate(input)),
  );
  const result = report(input, candidate);

  assert.equal(result.status, "blocked");
  assert.equal(result.summary.blockedRuns, 60);
  assert.ok(result.runs.every(({ issues }) =>
    issues.includes("protocol-runner-attestation-missing")));
});

function protocolCandidate() {
  const input = eligibleFixtures();
  const candidate = alignProtocolFrontiersToV2Oracle(
    input,
    attachExecutableProtocols(input, buildCandidate(input)),
  );
  return {
    input,
    candidate,
    runnerAttestation: createRunnerAttestationV2({
      ...input,
      candidate,
      attestedAt: MEASURED_AT,
      measureDurationMs: () => 100,
    }),
  };
}

function rebindProtocolCase(run, protocolCase) {
  protocolCase.id = protocolCaseIdFor(protocolCase);
  run.protocol.id = protocolEvidenceIdFor(run.protocol);
}

test("rejects tampered request, result, timing, provenance, and offer attestations", () => {
  for (const mutate of [
    (run) => { run.requestDigest = `sha256:${"f".repeat(64)}`; },
    (run) => { run.resultDigest = `sha256:${"f".repeat(64)}`; },
    (run) => { run.timing.reportedP95Ms += 1; },
    (run) => { run.provenanceDigest = `sha256:${"f".repeat(64)}`; },
    (run) => { run.offerAwareDigest = `sha256:${"f".repeat(64)}`; },
  ]) {
    const { input, candidate, runnerAttestation } = protocolCandidate();
    mutate(runnerAttestation.runs[0]);
    const result = report(input, candidate, runnerAttestation);
    assert.equal(result.status, "failed");
    assert.ok(result.issues.some(({ code }) =>
      code === "runner-attestation-contract-invalid"));
  }
});

test("rejects a reviewed match for the wrong exact product", () => {
  const { input, candidate } = protocolCandidate();
  const run = candidate.runs.find(({ scenarioId }) => scenarioId === "s01-everyday-basics");
  const control = run.protocol.negativeControls.find(({ kind }) =>
    kind === "exact-product-mismatch");
  const exactAssignment = run.plan.assignments.find(({ needId }) => needId === control.needId);
  control.matchEvidenceId = exactAssignment.matchEvidenceId;
  rebindProtocolCase(run, control);

  const result = report(input, candidate);
  assert.ok(result.runs.find(({ runId }) => runId === run.runId).issues
    .includes("protocol-exact-product-control-invalid"));
});

test("recomputes quantity sets, offers, history, membership programs, and timing", () => {
  for (const mutate of [
    (candidate) => {
      const run = candidate.runs[0];
      const quantityCase = run.protocol.quantityCases[0];
      quantityCase.options[0].surplusBaseUnits += 1;
      rebindProtocolCase(run, quantityCase);
      return "protocol-quantity-arithmetic-mismatch";
    },
    (candidate) => {
      const run = candidate.runs.find(({ protocol }) =>
        protocol.quantityCases.some(({ options }) => options.length > 1));
      const quantityCase = run.protocol.quantityCases.find(({ options }) => options.length > 1);
      const omittedIndex = quantityCase.options.findIndex(({ id }) =>
        id !== quantityCase.selectedOptionId);
      quantityCase.options.splice(omittedIndex, 1);
      rebindProtocolCase(run, quantityCase);
      return "protocol-quantity-option-set-incomplete";
    },
    (candidate) => {
      const run = candidate.runs.find(({ scenarioId }) => scenarioId === "s18-weekend-dinner");
      const pricingCase = run.protocol.pricingCases[0];
      pricingCase.actual.officialSavingsOre += 1;
      rebindProtocolCase(run, pricingCase);
      return "protocol-pricing-arithmetic-mismatch";
    },
    (candidate) => {
      const run = candidate.runs.find(({ protocol }) => protocol.pricingCases.length > 0);
      const pricingCase = run.protocol.pricingCases[0];
      pricingCase.ordinaryPriceEvidenceId = run.plan.assignments[1]?.priceEvidenceId
        ?? run.plan.assignments[0].priceEvidenceId;
      rebindProtocolCase(run, pricingCase);
      return "protocol-pricing-evidence-invalid";
    },
    (candidate) => {
      const run = candidate.runs.find(({ scenarioId }) => scenarioId === "s09-personal-care");
      run.protocol.pricingCases = run.protocol.pricingCases.filter(
        ({ enabledMembershipProgramIds }) => enabledMembershipProgramIds.length > 0,
      );
      run.protocol.id = protocolEvidenceIdFor(run.protocol);
      return "protocol-focus-unproven";
    },
    (candidate) => {
      const run = candidate.runs.find(({ scenarioId }) => scenarioId === "s20-large-weekly");
      run.protocol.replay.reportedP95Ms += 1;
      run.protocol.id = protocolEvidenceIdFor(run.protocol);
      return "protocol-performance-arithmetic-mismatch";
    },
  ]) {
    const { input, candidate } = protocolCandidate();
    const expectedIssue = mutate(candidate);
    const result = report(input, candidate);
    assert.equal(result.acceptancePassed, false);
    assert.ok(result.runs.some(({ issues }) => issues.includes(expectedIssue)));
  }
});

test("executes every negative control instead of trusting its declared state", () => {
  for (const mutate of [
    (candidate) => {
      const run = candidate.runs[0];
      const control = run.protocol.negativeControls.find(({ kind }) => kind === "stale-price");
      control.evaluatedAt = run.evaluatedAt;
      rebindProtocolCase(run, control);
      return "protocol-stale-control-invalid";
    },
    (candidate) => {
      const run = candidate.runs[0];
      const control = run.protocol.negativeControls.find(({ kind }) => kind === "wrong-region");
      control.requestedRegionId = run.regionId;
      rebindProtocolCase(run, control);
      return "protocol-wrong-region-control-invalid";
    },
    (candidate) => {
      const run = candidate.runs[0];
      const control = run.protocol.negativeControls.find(({ kind }) =>
        kind === "ineligible-source");
      control.disabledSourceId = "source:not-enabled";
      rebindProtocolCase(run, control);
      return "protocol-ineligible-source-control-invalid";
    },
    (candidate) => {
      const run = candidate.runs[0];
      const other = candidate.availabilityEvidence.find(({ regionId }) =>
        regionId !== run.regionId);
      const control = run.protocol.negativeControls.find(({ kind }) =>
        kind === "known-not-carried");
      control.availabilityEvidenceId = other.id;
      rebindProtocolCase(run, control);
      return "protocol-known-not-carried-control-invalid";
    },
    (candidate) => {
      const run = candidate.runs[0];
      const control = run.protocol.negativeControls.find(({ kind }) =>
        kind === "known-not-carried");
      control.matchEvidenceId = run.plan.assignments[0].matchEvidenceId;
      rebindProtocolCase(run, control);
      return "protocol-known-not-carried-control-invalid";
    },
    (candidate) => {
      const run = candidate.runs[0];
      const partialIndex = run.protocol.negativeControls.findIndex(({ kind }) =>
        kind === "partial-coverage");
      const stale = structuredClone(run.protocol.negativeControls.find(({ kind }) =>
        kind === "stale-price"));
      stale.id = protocolCaseIdFor(stale);
      run.protocol.negativeControls[partialIndex] = stale;
      run.protocol.negativeControls.sort((left, right) => left.id.localeCompare(right.id));
      run.protocol.id = protocolEvidenceIdFor(run.protocol);
      return "protocol-negative-control-set-incomplete";
    },
    (candidate) => {
      const run = candidate.runs.find(({ scenarioId }) => scenarioId === "s14-freezer-restock");
      const control = run.protocol.negativeControls.find(({ kind }) => kind === "expired-offer");
      control.evaluatedAt = run.evaluatedAt;
      rebindProtocolCase(run, control);
      return "protocol-expired-offer-control-invalid";
    },
  ]) {
    const { input, candidate } = protocolCandidate();
    const expectedIssue = mutate(candidate);
    const result = report(input, candidate);
    assert.equal(result.acceptancePassed, false);
    assert.ok(result.runs.some(({ issues }) => issues.includes(expectedIssue)));
  }
});

test("negative controls reject unselected, unrelated, and already-ineligible baselines", () => {
  for (const mutate of [
    (candidate) => {
      const run = candidate.runs.find(({ protocol }) =>
        protocol.quantityCases.some(({ options }) => options.length > 1));
      const quantityCase = run.protocol.quantityCases.find(({ options }) => options.length > 1);
      const control = run.protocol.negativeControls.find(({ kind }) => kind === "wrong-region");
      const unselected = quantityCase.options.find(({ id }) => id !== quantityCase.selectedOptionId);
      control.priceEvidenceId = unselected.priceEvidenceId;
      rebindProtocolCase(run, control);
      return { runId: run.runId, issue: "protocol-wrong-region-control-invalid" };
    },
    (candidate) => {
      const run = candidate.runs.find(({ scenarioId }) => scenarioId === "s14-freezer-restock");
      const control = run.protocol.negativeControls.find(({ kind }) => kind === "expired-offer");
      const unrelatedOffer = candidate.priceEvidence.find((evidence) =>
        evidence.priceClass === "official_offer"
          && evidence.id !== control.officialOfferEvidenceId);
      control.officialOfferEvidenceId = unrelatedOffer.id;
      rebindProtocolCase(run, control);
      return { runId: run.runId, issue: "protocol-expired-offer-control-invalid" };
    },
    (candidate) => {
      const run = candidate.runs.find(({ scenarioId }) => scenarioId === "s14-freezer-restock");
      const control = run.protocol.negativeControls.find(({ kind }) => kind === "expired-offer");
      const pricingCase = run.protocol.pricingCases.find(({ officialOfferEvidenceId }) =>
        officialOfferEvidenceId === control.officialOfferEvidenceId);
      const ordinary = candidate.priceEvidence.find(({ id }) =>
        id === pricingCase.ordinaryPriceEvidenceId);
      const offer = candidate.priceEvidence.find(({ id }) =>
        id === pricingCase.officialOfferEvidenceId);
      pricingCase.evaluatedAt = control.evaluatedAt;
      pricingCase.actual = pricingActual({ pricingCase, ordinary, offer });
      rebindProtocolCase(run, pricingCase);
      return { runId: run.runId, issue: "protocol-expired-offer-control-invalid" };
    },
  ]) {
    const { input, candidate } = protocolCandidate();
    const expected = mutate(candidate);
    const result = report(input, candidate);
    const runResult = result.runs.find(({ runId }) => runId === expected.runId);
    assert.ok(runResult.issues.includes(expected.issue));
  }
});

test("rejects silent substitution, dominated frontier output, and replay drift", () => {
  for (const mutate of [
    (candidate) => {
      const run = candidate.runs.find(({ scenarioId }) => scenarioId === "s15-dairy-free");
      const matchCase = run.protocol.matchCases.find(({ userDecision }) =>
        userDecision === "not-reviewed");
      matchCase.actual = {
        state: "selected",
        reason: "eligible-reviewed-candidate",
        explanationCode: "reviewed-family-approved",
      };
      rebindProtocolCase(run, matchCase);
      return "protocol-match-decision-mismatch";
    },
    (candidate) => {
      const run = candidate.runs.find(({ scenarioId }) => scenarioId === "s20-large-weekly");
      const omitted = run.protocol.frontier.plans.find(({ id }) =>
        !run.protocol.frontier.returnedPlanIds.includes(id));
      run.protocol.frontier.returnedPlanIds = [omitted.id];
      run.protocol.id = protocolEvidenceIdFor(run.protocol);
      return "frontier-nondominated-set-mismatch";
    },
    (candidate) => {
      const run = candidate.runs[0];
      run.protocol.replay.samples[0].resultDigest = `sha256:${"f".repeat(64)}`;
      run.protocol.id = protocolEvidenceIdFor(run.protocol);
      return "protocol-replay-sample-invalid";
    },
  ]) {
    const { input, candidate } = protocolCandidate();
    const expectedIssue = mutate(candidate);
    const result = report(input, candidate);
    assert.equal(result.acceptancePassed, false);
    assert.ok(result.runs.some(({ issues }) => issues.includes(expectedIssue)));
  }
});

test("fails closed across candidate and nested protocol versions", () => {
  const { input, candidate } = protocolCandidate();
  candidate.contractVersion = "1.0.0";
  let result = report(input, candidate);
  assert.equal(result.status, "failed");
  assert.ok(result.issues.some(({ code }) => code === "candidate-schema-invalid"));

  const rebuilt = protocolCandidate();
  rebuilt.candidate.runs[0].protocol.protocolVersion = "1.1.0";
  result = report(rebuilt.input, rebuilt.candidate);
  assert.equal(result.status, "failed");
  assert.ok(result.issues.some(({ code }) => code === "candidate-schema-invalid"));
});

test("report schema rejects forged accepted reports with duplicate runs or regions", () => {
  const { input, candidate } = protocolCandidate();
  const forged = report(input, candidate);
  forged.status = "accepted";
  forged.acceptancePassed = true;
  forged.summary = {
    expectedRuns: 60,
    passedRuns: 60,
    protocolPassedRuns: 60,
    blockedRuns: 0,
    failedRuns: 0,
    pendingRuns: 0,
  };
  forged.issues = [];
  forged.runnerAttestationDigest = `sha256:${"a".repeat(64)}`;
  forged.manualReconciliation = forged.manualReconciliation.map((entry) => ({
    ...entry,
    accepted: 5,
    passed: true,
  }));
  const focusByScenarioId = new Map(input.corpus.scenarios.map((scenario) => [
    scenario.id,
    [...scenario.acceptanceFocus].sort((left, right) => left.localeCompare(right)),
  ]));
  forged.runs = forged.runs.map((run) => ({
    ...run,
    status: "passed",
    verifiedFocus: focusByScenarioId.get(run.scenarioId),
    issues: [],
  }));
  assert.equal(reportSchemaErrors(forged).length, 0);

  const duplicateRuns = structuredClone(forged);
  duplicateRuns.runs = Array.from({ length: 60 }, () => structuredClone(forged.runs[0]));
  assert.ok(reportSchemaErrors(duplicateRuns).length > 0);

  const duplicateRegions = structuredClone(forged);
  duplicateRegions.manualReconciliation = duplicateRegions.manualReconciliation.map((entry) => ({
    ...entry,
    regionId: "no-0301-oslo",
  }));
  assert.ok(reportSchemaErrors(duplicateRegions).length > 0);

  const emptyFocus = structuredClone(forged);
  emptyFocus.runs[0].verifiedFocus = [];
  assert.ok(reportSchemaErrors(emptyFocus).length > 0);
  assert.deepEqual(
    verifyBenchmarkReport({ ...input, candidate, report: forged }),
    { valid: false, reason: "report-semantic-mismatch" },
  );
});

test("cannot make an unresolved source eligible by flipping only runtime labels", () => {
  const input = eligibleFixtures();
  input.sourceRegistry.sources = input.sourceRegistry.sources.map((source) =>
    source.id === "kassalapp"
      ? { ...source, rights: { ...source.rights, processing: "unknown" } }
      : source);
  const candidate = buildCandidate(input);
  const result = report(input, candidate);

  assert.equal(result.acceptancePassed, false);
  assert.equal(result.summary.passedRuns, 0);
  assert.ok(result.runs.every(({ issues }) =>
    issues.includes("coverage-scope-mismatch")
      || issues.includes("no-eligible-live-evidence")));
});

test("never promotes corpus runs still pending rights and measurement", () => {
  const input = eligibleFixtures();
  input.corpus.runs = input.corpus.runs.map((run) => ({
    ...run,
    status: "pending_rights_and_measurement",
  }));
  const candidate = buildCandidate(input);
  candidate.manualReconciliations = [];
  const result = report(input, candidate);

  assert.notEqual(result.status, "accepted");
  assert.equal(result.acceptancePassed, false);
  assert.equal(result.summary.pendingRuns, 60);
  assert.ok(result.runs.every(({ issues }) => issues.includes("corpus-run-pending")));
});

test("rejects an incomplete basket even when totals and deterministic IDs are recomputed", () => {
  const input = eligibleFixtures();
  const candidate = buildCandidate(input);
  const run = findNonReconciledRun(candidate);
  const removed = run.plan.assignments.pop();
  run.plan.totalOre = run.plan.assignments.reduce((sum, assignment) => sum + assignment.costOre, 0);
  run.plan.id = planIdFor(run);
  candidate.priceEvidence = candidate.priceEvidence.filter(({ id }) => id !== removed.priceEvidenceId);
  candidate.matchEvidence = candidate.matchEvidence.filter(({ id }) => id !== removed.matchEvidenceId);

  const result = report(input, candidate);
  const runResult = result.runs.find(({ runId }) => runId === run.runId);
  assert.equal(result.status, "failed");
  assert.equal(runResult.status, "failed");
  assert.ok(runResult.issues.includes("complete-basket-violated"));
});

test("rejects more than three stores and fractional ore/base-unit values at the input boundary", () => {
  const input = eligibleFixtures();
  for (const mutate of [
    (candidate) => {
      candidate.runs[0].plan.stores.push(
        { storeId: "store:extra:test", chainId: "extra", regionId: candidate.runs[0].regionId },
        { storeId: "store:rema:test", chainId: "rema-1000", regionId: candidate.runs[0].regionId },
        { storeId: "store:bunnpris:test", chainId: "bunnpris", regionId: candidate.runs[0].regionId },
      );
    },
    (candidate) => {
      candidate.runs[0].plan.assignments[0].costOre += 0.5;
    },
    (candidate) => {
      candidate.runs[0].plan.assignments[0].packageBaseUnits += 0.5;
    },
  ]) {
    const candidate = buildCandidate(input);
    mutate(candidate);
    const result = report(input, candidate);
    assert.equal(result.status, "failed");
    assert.ok(result.issues.some(({ code }) => code === "candidate-schema-invalid"));
  }
});

test("permits qualified partial comparison but rejects an unqualified complete-coverage claim", () => {
  const input = eligibleFixtures();
  input.launchCoverage.coverage = input.launchCoverage.coverage.map((cell) =>
    cell.regionId === "no-0301-oslo"
      && cell.chainId === "extra"
      && cell.priceClass === "official_offer"
      ? {
          ...cell,
          activeSourceId: null,
          coverageStatus: "unknown",
          evidenceLevel: "public_presence_only",
          launchEligible: false,
        }
      : cell);
  const candidate = buildCandidate(input);
  let result = report(input, candidate);
  assert.equal(result.status, "blocked");
  assert.equal(result.summary.blockedRuns, 60);
  assert.ok(result.issues.some(({ code }) => code === "launch-coverage-incomplete"));
  assert.equal(
    candidate.runs.find(({ regionId }) => regionId === "no-0301-oslo").comparisonScope.qualification,
    "among-verified-prices",
  );

  const run = candidate.runs.find(({ regionId }) => regionId === "no-0301-oslo");
  run.comparisonScope.qualification = "declared-complete-coverage";
  run.plan.id = planIdFor(run);
  result = report(input, candidate);
  assert.equal(result.status, "failed");
  assert.ok(result.runs.find(({ runId }) => runId === run.runId).issues
    .includes("coverage-qualification-mismatch"));
});

test("checks deterministic evidence IDs and geographic scope inclusion", () => {
  const input = eligibleFixtures();
  let candidate = buildCandidate(input);
  candidate.priceEvidence[0].amountOre += 1;
  let result = report(input, candidate);
  assert.equal(result.status, "failed");
  assert.ok(result.issues.some(({ code }) => code === "price-evidence-id-nondeterministic"));

  candidate = buildCandidate(input);
  const run = findNonReconciledRun(candidate);
  const assignment = run.plan.assignments[0];
  const evidence = candidate.priceEvidence.find(({ id }) => id === assignment.priceEvidenceId);
  const oldEvidenceId = evidence.id;
  evidence.geographicScope = {
    kind: "store",
    regionId: run.regionId,
    storeId: "store:bunnpris:different",
  };
  evidence.id = priceEvidenceIdFor(evidence);
  assignment.priceEvidenceId = evidence.id;
  run.plan.id = planIdFor(run);
  candidate.priceEvidence.sort((left, right) => left.id.localeCompare(right.id));
  assert.notEqual(oldEvidenceId, evidence.id);
  result = report(input, candidate);
  assert.equal(result.status, "failed");
  assert.ok(result.runs.find(({ runId }) => runId === run.runId).issues
    .includes("price-evidence-binding-mismatch"));
});

test("requires every selected store to bind an eligible branch-directory observation", () => {
  const input = eligibleFixtures();
  const candidate = buildCandidate(input);
  const removed = candidate.storeEvidence.shift();
  const result = report(input, candidate);

  assert.equal(result.status, "failed");
  assert.ok(result.issues.some(({ code }) => code === "store-evidence-reference-set-mismatch"));
  assert.ok(result.runs
    .filter(({ regionId }) => regionId === removed.regionId)
    .every(({ issues }) => issues.includes("store-evidence-binding-mismatch")));
});

test("rejects duplicate or incomplete governance matrices inside the standalone runner", () => {
  const input = fixtures();
  input.launchCoverage.candidateRegions = [
    input.launchCoverage.candidateRegions[0],
    input.launchCoverage.candidateRegions[0],
    input.launchCoverage.candidateRegions[0],
  ];
  assert.throws(
    () => report(input),
    /exact three V1 candidate regions/,
  );
});

test("blocks acceptance when a region lacks five distinct manual reconciliations", () => {
  const input = eligibleFixtures();
  const candidate = buildCandidate(input);
  const index = candidate.manualReconciliations.findIndex(({ runId }) =>
    runId.startsWith("no-0301-oslo-"));
  candidate.manualReconciliations.splice(index, 1);
  const result = report(input, candidate);

  assert.equal(result.status, "blocked");
  assert.equal(result.acceptancePassed, false);
  assert.ok(result.issues.some(({ code, regionId }) =>
    code === "manual-reconciliation-quota-unmet" && regionId === "no-0301-oslo"));
});

test("rejects temporally impossible reconciliation and report ordering", () => {
  const input = eligibleFixtures();
  let candidate = buildCandidate(input);
  const reconciliation = candidate.manualReconciliations[0];
  reconciliation.reviewedAt = "2026-07-17T04:30:00.000Z";
  reconciliation.id = reconciliationIdFor(reconciliation);
  candidate.manualReconciliations.sort((left, right) => left.id.localeCompare(right.id));
  let result = report(input, candidate);
  assert.equal(result.status, "failed");
  assert.ok(result.issues.some(({ code }) => code === "manual-reconciliation-invalid"));

  candidate = buildCandidate(input);
  candidate.manualReconciliations[0].reviewedEvidenceDigest = `sha256:${"f".repeat(64)}`;
  candidate.manualReconciliations[0].id = reconciliationIdFor(
    candidate.manualReconciliations[0],
  );
  candidate.manualReconciliations.sort((left, right) => left.id.localeCompare(right.id));
  result = report(input, candidate);
  assert.equal(result.status, "failed");
  assert.ok(result.issues.some(({ code }) => code === "manual-reconciliation-invalid"));

  candidate = buildCandidate(input);
  result = createBenchmarkReport({
    ...input,
    candidate,
    generatedAt: "2026-07-17T04:59:59.999Z",
  });
  assert.equal(result.status, "failed");
  assert.ok(result.issues.some(({ code }) => code === "measurement-after-report"));
});

test("report identity changes when a substantive candidate result changes", () => {
  const input = eligibleFixtures();
  const candidate = buildCandidate(input);
  const original = report(input, candidate);
  const changed = clone(candidate);
  const run = findNonReconciledRun(changed);
  const assignment = run.plan.assignments[0];
  const evidence = changed.priceEvidence.find(({ id }) => id === assignment.priceEvidenceId);
  evidence.amountOre += 1;
  evidence.id = priceEvidenceIdFor(evidence);
  assignment.priceEvidenceId = evidence.id;
  assignment.ordinaryCostOre += 1;
  assignment.costOre += 1;
  run.plan.totalOre += 1;
  run.plan.id = planIdFor(run);
  changed.priceEvidence.sort((left, right) => left.id.localeCompare(right.id));
  const changedReport = report(input, changed);

  assert.equal(original.status, "blocked");
  assert.equal(changedReport.status, "blocked");
  assert.equal(original.summary.blockedRuns, 60);
  assert.equal(changedReport.summary.blockedRuns, 60);
  assert.notEqual(original.candidateDocumentDigest, changedReport.candidateDocumentDigest);
  assert.notEqual(original.reportId, changedReport.reportId);
});

test("CLI exits 2 for the current blocked state and refuses to overwrite an evidence report", () => {
  const scratch = mkdtempSync(join(tmpdir(), "handleplan-v1-baskets-"));
  try {
    const output = join(scratch, "report.json");
    const argumentsList = [
      resolve(root, "tests/acceptance/check-v1-baskets.mjs"),
      "--at",
      GENERATED_AT,
      "--output",
      output,
    ];
    const first = spawnSync(process.execPath, argumentsList, {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(first.status, 2);
    assert.equal(first.stderr, "");
    assert.equal(JSON.parse(first.stdout).status, "blocked");
    assert.equal(readJsonFromAbsolutePath(output).acceptancePassed, false);
    assert.equal(statSync(output).mode & 0o777, 0o600);

    const verified = spawnSync(process.execPath, [
      resolve(root, "tests/acceptance/check-v1-baskets.mjs"),
      "--verify-report",
      output,
    ], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(verified.status, 2);
    assert.equal(verified.stderr, "");
    assert.deepEqual(JSON.parse(verified.stdout), JSON.parse(first.stdout));

    const second = spawnSync(process.execPath, argumentsList, {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(second.status, 1);
    assert.match(second.stderr, /V1 basket checker failed/);
    assert.equal(second.stdout, "");

    const oversized = join(scratch, "oversized-candidate.json");
    closeSync(openSync(oversized, "w"));
    truncateSync(oversized, 8 * 1024 * 1024 + 1);
    const oversizedResult = spawnSync(process.execPath, [
      resolve(root, "tests/acceptance/check-v1-baskets.mjs"),
      "--candidate",
      oversized,
      "--at",
      GENERATED_AT,
    ], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(oversizedResult.status, 1);
    assert.match(oversizedResult.stderr, /exceeds the 8388608-byte limit/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

function readJsonFromAbsolutePath(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
