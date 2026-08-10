import { createHash } from "node:crypto";

const MAXIMUM_STORES = 3;
const MAXIMUM_OPTIONS_PER_NEED = 12;
const MAXIMUM_FEASIBLE_PLANS = 7;
const MAXIMUM_MEMBERSHIP_PROGRAMS = 16;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value)
    .sort(compareText)
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(",")}}`;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(canonicalize(value), "utf8").digest("hex")}`;
}

function safeMultiply(left, right) {
  const result = left * right;
  return Number.isSafeInteger(result) ? result : undefined;
}

function safeAdd(left, right) {
  const result = left + right;
  return Number.isSafeInteger(result) ? result : undefined;
}

function optionFacts(need, option, evaluatedAt, enabledMembershipProgramIds) {
  const packageCount = need.requested.unit === "package"
    ? need.requested.value
    : Math.ceil(need.requested.value / option.packageBaseUnits);
  const purchasedBaseUnits = need.requested.unit === "package"
    ? packageCount
    : safeMultiply(packageCount, option.packageBaseUnits);
  const ordinaryMerchandiseOre = safeMultiply(packageCount, option.ordinaryAmountOre);
  const depositOre = safeMultiply(packageCount, option.depositPerPackageOre);
  if (
    purchasedBaseUnits === undefined
    || ordinaryMerchandiseOre === undefined
    || depositOre === undefined
  ) return undefined;

  let merchandiseOre = ordinaryMerchandiseOre;
  let appliedOfferEvidenceId = null;
  for (const offer of option.officialOffers) {
    const membershipEligible = offer.membershipRequirement === "none"
      || (offer.membershipProgramId !== undefined
        && enabledMembershipProgramIds.has(offer.membershipProgramId));
    const timeEligible = evaluatedAt >= offer.validFrom && evaluatedAt <= offer.validUntil;
    const quantityEligible = packageCount >= offer.minimumPackages
      && packageCount >= offer.bundleSize;
    if (!membershipEligible || !timeEligible || !quantityEligible) continue;
    const bundleCount = Math.floor(packageCount / offer.bundleSize);
    const remainderCount = packageCount % offer.bundleSize;
    const bundleTotal = safeMultiply(bundleCount, offer.amountOre);
    const remainderTotal = safeMultiply(remainderCount, option.ordinaryAmountOre);
    const offeredTotal = bundleTotal === undefined || remainderTotal === undefined
      ? undefined
      : safeAdd(bundleTotal, remainderTotal);
    if (
      offeredTotal !== undefined
      && (offeredTotal < merchandiseOre
        || (offeredTotal === merchandiseOre
          && compareText(offer.priceEvidenceId, appliedOfferEvidenceId ?? "") < 0))
    ) {
      merchandiseOre = offeredTotal;
      appliedOfferEvidenceId = offer.priceEvidenceId;
    }
  }
  const checkoutOre = safeAdd(merchandiseOre, depositOre);
  const ordinaryCostOre = safeAdd(ordinaryMerchandiseOre, depositOre);
  if (checkoutOre === undefined || ordinaryCostOre === undefined) return undefined;
  return {
    needId: need.needId,
    canonicalProductId: option.canonicalProductId,
    storeId: option.storeId,
    chainId: option.chainId,
    packageCount,
    packageBaseUnits: option.packageBaseUnits,
    purchasedBaseUnits,
    unit: need.requested.unit,
    ordinaryPriceEvidenceId: option.ordinaryPriceEvidenceId,
    matchEvidenceId: option.matchEvidenceId,
    appliedOfferEvidenceId,
    ordinaryCostOre,
    costOre: checkoutOre,
  };
}

function compareAssignments(left, right) {
  return left.costOre - right.costOre
    || left.ordinaryCostOre - right.ordinaryCostOre
    || compareText(left.canonicalProductId, right.canonicalProductId)
    || compareText(left.storeId, right.storeId)
    || compareText(left.ordinaryPriceEvidenceId, right.ordinaryPriceEvidenceId)
    || compareText(left.appliedOfferEvidenceId ?? "", right.appliedOfferEvidenceId ?? "")
    || compareText(left.matchEvidenceId, right.matchEvidenceId);
}

function combinations(values) {
  const result = [];
  function visit(start, selected) {
    if (selected.length > 0) result.push([...selected]);
    if (selected.length === MAXIMUM_STORES) return;
    for (let index = start; index < values.length; index += 1) {
      selected.push(values[index]);
      visit(index + 1, selected);
      selected.pop();
    }
  }
  visit(0, []);
  return result;
}

function planForStores(snapshot, selectedStoreIds) {
  const selected = new Set(selectedStoreIds);
  const enabledMembershipProgramIds = new Set(snapshot.enabledMembershipProgramIds);
  const assignments = [];
  for (const need of snapshot.needs) {
    const candidates = need.options
      .filter(({ storeId }) => selected.has(storeId))
      .map((option) => optionFacts(
        need,
        option,
        snapshot.evaluatedAt,
        enabledMembershipProgramIds,
      ))
      .filter((candidate) => candidate !== undefined)
      .sort(compareAssignments);
    const assignment = candidates[0];
    if (assignment === undefined) return undefined;
    assignments.push(assignment);
  }
  assignments.sort((left, right) => compareText(left.needId, right.needId));
  const storeIds = [...new Set(assignments.map(({ storeId }) => storeId))].sort(compareText);
  if (storeIds.length === 0 || storeIds.length > MAXIMUM_STORES) return undefined;
  const totalOre = assignments.reduce((sum, { costOre }) => safeAdd(sum, costOre), 0);
  if (totalOre === undefined) return undefined;
  const body = {
    storeIds,
    assignments,
    totalOre,
    substitutions: snapshot.needs.filter(({ identity }) =>
      identity.kind === "reviewed-family").length,
  };
  return { signature: digest(body), ...body };
}

function planIdentity(plan) {
  return canonicalize({
    storeIds: plan.storeIds,
    assignments: plan.assignments,
    totalOre: plan.totalOre,
    substitutions: plan.substitutions,
  });
}

function dominates(left, right) {
  const noWorse = left.totalOre <= right.totalOre
    && left.storeIds.length <= right.storeIds.length
    && left.substitutions <= right.substitutions;
  return noWorse && (
    left.totalOre < right.totalOre
    || left.storeIds.length < right.storeIds.length
    || left.substitutions < right.substitutions
  );
}

function comparePlans(left, right) {
  return left.storeIds.length - right.storeIds.length
    || left.substitutions - right.substitutions
    || left.totalOre - right.totalOre
    || compareText(left.signature, right.signature);
}

export function enumerateBoundedUniverseV2(snapshot) {
  const enabledMembershipProgramIds = snapshot.enabledMembershipProgramIds;
  if (
    snapshot.contractVersion !== 2
    || snapshot.maximumStores !== MAXIMUM_STORES
    || !Array.isArray(enabledMembershipProgramIds)
    || enabledMembershipProgramIds.length > MAXIMUM_MEMBERSHIP_PROGRAMS
    || new Set(enabledMembershipProgramIds).size !== enabledMembershipProgramIds.length
    || enabledMembershipProgramIds.some((programId, index) =>
      index > 0 && compareText(enabledMembershipProgramIds[index - 1], programId) >= 0)
    || snapshot.stores.length < 1
    || snapshot.stores.length > MAXIMUM_STORES
    || snapshot.needs.some(({ options }) =>
      options.length < 1 || options.length > MAXIMUM_OPTIONS_PER_NEED)
  ) {
    return { state: "invalid-bounds" };
  }
  const storeIds = snapshot.stores.map(({ storeId }) => storeId).sort(compareText);
  if (new Set(storeIds).size !== storeIds.length) return { state: "invalid-bounds" };
  const feasible = combinations(storeIds)
    .map((subset) => planForStores(snapshot, subset))
    .filter((plan) => plan !== undefined);
  const unique = new Map();
  for (const plan of feasible.sort(comparePlans)) unique.set(planIdentity(plan), plan);
  const feasiblePlans = [...unique.values()].sort(comparePlans);
  if (feasiblePlans.length < 1 || feasiblePlans.length > MAXIMUM_FEASIBLE_PLANS) {
    return { state: "invalid-bounds" };
  }
  const frontierPlans = feasiblePlans
    .filter((candidate) => !feasiblePlans.some((other) =>
      other.signature !== candidate.signature && dominates(other, candidate)))
    .sort(comparePlans);
  const discountedFeasiblePlanSignatures = feasiblePlans
    .filter(({ assignments }) => assignments.some((assignment) =>
      assignment.appliedOfferEvidenceId !== null
        && assignment.costOre < assignment.ordinaryCostOre))
    .map(({ signature }) => signature)
    .sort(compareText);
  const discountedFrontierPlanSignatures = frontierPlans
    .filter(({ assignments }) => assignments.some((assignment) =>
      assignment.appliedOfferEvidenceId !== null
        && assignment.costOre < assignment.ordinaryCostOre))
    .map(({ signature }) => signature)
    .sort(compareText);
  const convenience = [...frontierPlans].sort((left, right) =>
    left.storeIds.length - right.storeIds.length
      || left.totalOre - right.totalOre
      || left.substitutions - right.substitutions
      || compareText(left.signature, right.signature))[0];
  const savings = [...frontierPlans].sort((left, right) =>
    left.totalOre - right.totalOre
      || left.storeIds.length - right.storeIds.length
      || left.substitutions - right.substitutions
      || compareText(left.signature, right.signature))[0];
  return {
    state: "enumerated",
    feasiblePlans,
    frontierPlanSignatures: frontierPlans.map(({ signature }) => signature).sort(compareText),
    discountedFeasiblePlanSignatures,
    discountedFrontierPlanSignatures,
    convenienceEndpointSignature: convenience.signature,
    savingsEndpointSignature: savings.signature,
  };
}

export function boundedUniverseV2Constants() {
  return Object.freeze({
    maximumStores: MAXIMUM_STORES,
    maximumOptionsPerNeed: MAXIMUM_OPTIONS_PER_NEED,
    maximumFeasiblePlans: MAXIMUM_FEASIBLE_PLANS,
    maximumMembershipPrograms: MAXIMUM_MEMBERSHIP_PROGRAMS,
  });
}
