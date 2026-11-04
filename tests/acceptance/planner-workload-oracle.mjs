import { enumerateBoundedUniverseV2 } from "./v1-basket-oracle-v2.mjs";

// Composes the untouched bounded oracle: it never sees more than 3 stores or 12 options per need.
const MAXIMUM_STORES = 13;
const MAXIMUM_NEEDS = 50;
const MAXIMUM_OPTIONS_PER_NEED = 5000;
const MAXIMUM_SELECTED_STORES = 3;
const MAXIMUM_PLANS = 377;
const OLD_BATCH = 12;
const MAXIMUM_MEMBERSHIP_PROGRAMS = 16;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function oneNeedOneStore(snapshot, need, storeId, options) {
  return {
    contractVersion: 2,
    maximumStores: MAXIMUM_SELECTED_STORES,
    enabledMembershipProgramIds: snapshot.enabledMembershipProgramIds,
    evaluatedAt: snapshot.evaluatedAt,
    stores: [{ storeId }],
    needs: [{ ...need, options }],
  };
}

// Returns the raw cheapest option of one store, or undefined when no option is priceable.
function cheapestOption(snapshot, need, storeId, options) {
  let candidates = options;
  while (candidates.length > 0) {
    const winners = [];
    for (let start = 0; start < candidates.length; start += OLD_BATCH) {
      const batch = candidates.slice(start, start + OLD_BATCH);
      const result = enumerateBoundedUniverseV2(oneNeedOneStore(snapshot, need, storeId, batch));
      if (result.state !== "enumerated") continue;
      const facts = result.feasiblePlans[0].assignments[0];
      const winner = batch.find((option) =>
        option.canonicalProductId === facts.canonicalProductId
        && option.ordinaryPriceEvidenceId === facts.ordinaryPriceEvidenceId
        && option.matchEvidenceId === facts.matchEvidenceId
        && option.packageBaseUnits === facts.packageBaseUnits
        && option.chainId === facts.chainId
        && (facts.appliedOfferEvidenceId === null
          || option.officialOffers.some(({ priceEvidenceId }) =>
            priceEvidenceId === facts.appliedOfferEvidenceId)));
      if (winner === undefined) throw new Error("oracle winner has no raw option");
      winners.push(winner);
    }
    if (winners.length <= 1) return winners[0];
    candidates = winners;
  }
  return undefined;
}

function subsets(storeIds) {
  const result = [];
  function visit(start, selected) {
    if (selected.length > 0) result.push([...selected]);
    if (selected.length === MAXIMUM_SELECTED_STORES) return;
    for (let index = start; index < storeIds.length; index += 1) {
      selected.push(storeIds[index]);
      visit(index + 1, selected);
      selected.pop();
    }
  }
  visit(0, []);
  return result;
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

function validBounds(snapshot) {
  const programs = snapshot?.enabledMembershipProgramIds;
  if (
    snapshot?.contractVersion !== 2
    || snapshot.maximumStores !== MAXIMUM_SELECTED_STORES
    || !Array.isArray(programs)
    || programs.length > MAXIMUM_MEMBERSHIP_PROGRAMS
    || programs.some((id, index) => index > 0 && compareText(programs[index - 1], id) >= 0)
    || !Array.isArray(snapshot.stores)
    || snapshot.stores.length < 1
    || snapshot.stores.length > MAXIMUM_STORES
    || !Array.isArray(snapshot.needs)
    || snapshot.needs.length < 1
    || snapshot.needs.length > MAXIMUM_NEEDS
    || snapshot.needs.some(({ options }) => !Array.isArray(options)
      || options.length < 1 || options.length > MAXIMUM_OPTIONS_PER_NEED)
  ) return false;
  const storeIds = snapshot.stores.map(({ storeId }) => storeId);
  const needIds = snapshot.needs.map(({ needId }) => needId);
  return new Set(storeIds).size === storeIds.length && new Set(needIds).size === needIds.length;
}

export function enumerateComposedUniverse(snapshot) {
  if (!validBounds(snapshot)) return { state: "invalid-bounds" };
  const storeIds = snapshot.stores.map(({ storeId }) => storeId).sort(compareText);
  const winners = new Map(); // needId -> storeId -> raw cheapest option
  for (const need of snapshot.needs) {
    const byStore = new Map();
    for (const storeId of storeIds) {
      const options = need.options.filter((option) => option.storeId === storeId);
      const winner = cheapestOption(snapshot, need, storeId, options);
      if (winner !== undefined) byStore.set(storeId, winner);
    }
    winners.set(need.needId, byStore);
  }
  const unique = new Map();
  for (const subset of subsets(storeIds)) {
    const needs = snapshot.needs.map((need) => ({
      ...need,
      options: subset.filter((id) => winners.get(need.needId).has(id))
        .map((id) => winners.get(need.needId).get(id)),
    }));
    if (needs.some(({ options }) => options.length === 0)) continue;
    const result = enumerateBoundedUniverseV2({
      ...snapshot,
      stores: subset.map((storeId) => ({ storeId })),
      needs,
    });
    if (result.state !== "enumerated") continue;
    for (const plan of result.feasiblePlans) unique.set(plan.signature, plan);
  }
  const feasiblePlans = [...unique.values()].sort(comparePlans);
  if (feasiblePlans.length < 1) return { state: "no-feasible-plan" };
  if (feasiblePlans.length > MAXIMUM_PLANS) return { state: "invalid-bounds" };
  const frontierPlans = feasiblePlans
    .filter((candidate) => !feasiblePlans.some((other) =>
      other.signature !== candidate.signature && dominates(other, candidate)))
    .sort(comparePlans);
  const discounted = (plans) => plans
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
    discountedFeasiblePlanSignatures: discounted(feasiblePlans),
    discountedFrontierPlanSignatures: discounted(frontierPlans),
    convenienceEndpointSignature: convenience.signature,
    savingsEndpointSignature: savings.signature,
  };
}

export function composedUniverseConstants() {
  return Object.freeze({
    maximumStores: MAXIMUM_STORES,
    maximumNeeds: MAXIMUM_NEEDS,
    maximumOptionsPerNeed: MAXIMUM_OPTIONS_PER_NEED,
    maximumSelectedStores: MAXIMUM_SELECTED_STORES,
    maximumPlans: MAXIMUM_PLANS,
  });
}
