import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CHAINS,
  buildWorkloads,
  offerTruth,
  priceTruth,
} from "./planner-workload-fixtures.mjs";
import { enumerateComposedUniverse } from "./planner-workload-oracle.mjs";

const cases = buildWorkloads();
const byId = Object.fromEntries(cases.map((c) => [c.id, c]));

function isValidGtin(value) {
  const digits = [...value].map(Number);
  const check = digits.pop();
  const sum = digits.reduce((t, d, i) => t + d * ((digits.length - i) % 2 === 1 ? 3 : 1), 0);
  return value.length === 13 && (10 - (sum % 10)) % 10 === check;
}

// Effective option cost by plain arithmetic, used only to prove the fixtures have no cost ties.
function effectiveCosts(snapshot) {
  return snapshot.needs.map((need) => need.options.map((option) => {
    const count = need.requested.unit === "package"
      ? need.requested.value
      : Math.ceil(need.requested.value / option.packageBaseUnits);
    let best = count * option.ordinaryAmountOre;
    for (const o of option.officialOffers) {
      if (count < o.minimumPackages || count < o.bundleSize) continue;
      best = Math.min(best, Math.floor(count / o.bundleSize) * o.amountOre
        + (count % o.bundleSize) * option.ordinaryAmountOre);
    }
    return best;
  }));
}

test("raw records are bounded, unique, well-formed and labels match independent truth", () => {
  for (const c of cases) {
    const { raw, productionInput: input } = c;
    assert.ok(input.needs.length <= 50 && input.products.length <= 500);
    assert.ok(input.ordinaryPrices.length <= 5000 && input.officialOffers.length <= 5000);
    assert.equal(new Set(raw.needs.map((n) => n.id)).size, raw.needs.length);
    assert.equal(new Set(raw.offers.map((o) => o.id)).size, raw.offers.length);
    assert.equal(new Set(raw.prices.map((p) => p.source)).size, raw.prices.length);
    assert.equal(new Set(raw.prices.map((p) => p.id)).size, raw.prices.length);
    assert.equal(new Set(input.ordinaryPrices.map((p) => p.ean + p.chain)).size, raw.prices.length);
    assert.ok(raw.products.every((p) => isValidGtin(p.ean)));
    assert.equal(new Set(raw.products.map((p) => p.ean)).size, raw.products.length);
    for (const p of raw.prices) assert.equal(priceTruth(raw, p), p.expected, p.id);
    for (const o of raw.offers) assert.equal(offerTruth(raw, o), o.expected, o.id);
  }
});

test("case shapes match the grant", () => {
  const dense = byId["dense-13-chains"];
  assert.equal(dense.raw.needs.length, 50);
  assert.equal(dense.raw.products.length, 50);
  assert.equal(new Set(dense.raw.prices.map((p) => p.chain)).size, 13);
  assert.ok(dense.raw.offers.length >= 2000 && dense.raw.offers.length <= 5000);
  const family = byId["family-plus-30-exact"];
  assert.equal(family.raw.needs.length, 31);
  assert.equal(family.raw.products.length, 50);
  assert.equal(family.raw.products.filter((p) => p.productFamily === "family:pasta").length, 20);
  assert.equal(new Set(family.raw.prices.map((p) => p.chain)).size, 13);
  assert.equal(new Set(byId["sparse-3-chains"].raw.prices.map((p) => p.chain)).size, 3);
  assert.equal(CHAINS.length, 13);
});

test("every priced option has a distinct effective cost within its need", () => {
  for (const c of cases.filter((x) => x.oracleSnapshot !== undefined)) {
    for (const costs of effectiveCosts(c.oracleSnapshot)) {
      assert.equal(new Set(costs).size, costs.length, c.id);
    }
  }
});

test("oracle universes: bounds, hand-computed totals and sparse completeness", () => {
  const results = Object.fromEntries(cases
    .filter((c) => c.oracleSnapshot !== undefined)
    .map((c) => [c.id, enumerateComposedUniverse(c.oracleSnapshot)]));
  for (const [id, r] of Object.entries(results)) assert.equal(r.state, "enumerated", id);
  assert.equal(results["sparse-3-chains"].feasiblePlans.length, 1);
  assert.deepEqual(results["sparse-3-chains"].feasiblePlans[0].storeIds, ["extra", "meny", "oda"]);
  assert.ok(results["family-plus-30-exact"].feasiblePlans.every((p) => p.substitutions === 1));
  const hand = results["hand-computed"];
  const expected = byId["hand-computed"].handExpected;
  assert.deepEqual(hand.feasiblePlans.map((p) => p.totalOre).sort((a, b) => a - b), expected.feasibleTotals);
  const frontier = hand.feasiblePlans.filter((p) => hand.frontierPlanSignatures.includes(p.signature));
  assert.deepEqual(frontier.map((p) => p.totalOre).sort((a, b) => a - b), expected.frontierTotals);
  assert.equal(hand.feasiblePlans.find((p) => p.signature === hand.convenienceEndpointSignature).totalOre, expected.convenience.total);
  assert.equal(hand.feasiblePlans.find((p) => p.signature === hand.savingsEndpointSignature).totalOre, expected.savings.total);
  assert.equal(byId["missing-family"].oracleSnapshot, undefined);
  assert.equal(byId["stale-and-future-only"].oracleSnapshot, undefined);
});
