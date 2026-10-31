import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  boundedUniverseV2Constants,
  enumerateBoundedUniverseV2,
} from "./v1-basket-oracle-v2.mjs";
import {
  composedUniverseConstants,
  enumerateComposedUniverse,
} from "./planner-workload-oracle.mjs";

const AT = "2026-07-17T06:00:00.000Z";

function option(product, store, ore, extra = {}) {
  return {
    canonicalProductId: product,
    storeId: store,
    chainId: `chain-${store}`,
    packageBaseUnits: 500,
    ordinaryAmountOre: ore,
    depositPerPackageOre: 0,
    officialOffers: [],
    ordinaryPriceEvidenceId: `ord:${product}:${store}`,
    matchEvidenceId: `match:${product}:${store}`,
    ...extra,
  };
}

function need(needId, options, value = 500, kind = "exact") {
  return { needId, identity: { kind }, requested: { unit: "g", value }, options };
}

function snapshot(storeIds, needs, programs = []) {
  return {
    contractVersion: 2,
    maximumStores: 3,
    enabledMembershipProgramIds: programs,
    evaluatedAt: AT,
    stores: storeIds.map((storeId) => ({ storeId })),
    needs,
  };
}

const offer = (id, amountOre, extra = {}) => ({
  priceEvidenceId: id,
  membershipRequirement: "none",
  validFrom: "2026-07-01T00:00:00.000Z",
  validUntil: "2026-07-31T00:00:00.000Z",
  minimumPackages: 1,
  bundleSize: 2,
  amountOre,
  ...extra,
});

test("old oracle constants and file identity are unchanged", () => {
  assert.deepEqual({ ...boundedUniverseV2Constants() }, {
    maximumStores: 3,
    maximumOptionsPerNeed: 12,
    maximumFeasiblePlans: 7,
    maximumMembershipPrograms: 16,
  });
  assert.deepEqual({ ...composedUniverseConstants() }, {
    maximumStores: 13,
    maximumNeeds: 50,
    maximumOptionsPerNeed: 5000,
    maximumSelectedStores: 3,
    maximumPlans: 377,
  });
  const bytes = readFileSync(new URL("./v1-basket-oracle-v2.mjs", import.meta.url));
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "37a43462423bc61e4263c6b8fc0600f75de65b91f85953032bad0839d7f37172",
  );
});

test("multibuy and deposit totals with hand-calculated evidence", () => {
  // 1500 g / 500 g = 3 packages: bundle of 2 at 1500 + 1 at 1000 = 2500, deposit 3 * 200.
  const o = option("p1", "sA", 1000, {
    depositPerPackageOre: 200,
    officialOffers: [offer("offer:z", 1500)],
  });
  const result = enumerateComposedUniverse(snapshot(["sA"], [need("n1", [o], 1500)]));
  assert.equal(result.state, "enumerated");
  const [plan] = result.feasiblePlans;
  assert.equal(plan.totalOre, 3100);
  assert.deepEqual(
    [plan.assignments[0].ordinaryCostOre, plan.assignments[0].packageCount,
      plan.assignments[0].appliedOfferEvidenceId, plan.assignments[0].ordinaryPriceEvidenceId,
      plan.assignments[0].matchEvidenceId],
    [3600, 3, "offer:z", "ord:p1:sA", "match:p1:sA"],
  );
  assert.deepEqual(result.discountedFrontierPlanSignatures, [plan.signature]);
});

test("membership and expired offers apply only when eligible", () => {
  const member = offer("offer:m", 1200, { membershipRequirement: "member", membershipProgramId: "m:a" });
  const expired = offer("offer:old", 100, { validUntil: "2026-07-01T00:00:00.000Z" });
  const mk = (programs) => enumerateComposedUniverse(snapshot(
    ["sA"], [need("n1", [option("p1", "sA", 1000, { officialOffers: [member, expired] })], 1000)], programs));
  const without = mk([]).feasiblePlans[0];
  const withMember = mk(["m:a"]).feasiblePlans[0];
  assert.equal(without.totalOre, 2000);
  assert.equal(without.assignments[0].appliedOfferEvidenceId, null);
  assert.equal(withMember.totalOre, 1200);
  assert.equal(withMember.assignments[0].appliedOfferEvidenceId, "offer:m");
});

test("ties keep ordinary, match and offer evidence of the oracle winner", () => {
  const tied = [
    option("p1", "sA", 1000, { matchEvidenceId: "match:b" }),
    option("p1", "sA", 1000, { matchEvidenceId: "match:a" }),
  ];
  const a = enumerateComposedUniverse(snapshot(["sA"], [need("n1", tied)])).feasiblePlans[0].assignments[0];
  assert.equal(a.matchEvidenceId, "match:a");
  assert.equal(a.ordinaryPriceEvidenceId, "ord:p1:sA");
  const offers = [offer("o-b", 800), offer("o-a", 800)];
  const b = enumerateComposedUniverse(snapshot(["sA"], [
    need("n1", [option("p1", "sA", 1000, { officialOffers: offers })], 1000)])).feasiblePlans[0];
  assert.equal(b.assignments[0].appliedOfferEvidenceId, "o-a");
  assert.equal(b.totalOre, 800); // 1000 g = 2 packages = one bundle at 800
});

test("30 options in one store reduce across batches to the cheapest", () => {
  const options = Array.from({ length: 30 }, (_, i) =>
    option(`p${String(i).padStart(2, "0")}`, "sA", 2000 + i * 10));
  options[17] = option("p17", "sA", 1500);
  options[29] = option("p29", "sA", 1500, { matchEvidenceId: "match:p29:b" });
  const [plan] = enumerateComposedUniverse(snapshot(["sA"], [need("n1", options)])).feasiblePlans;
  assert.equal(plan.totalOre, 1500);
  assert.equal(plan.assignments[0].canonicalProductId, "p17");
});

test("fifty exact needs across thirteen chains with dense duplicate options", () => {
  const ids = Array.from({ length: 13 }, (_, i) => `s${String(i).padStart(2, "0")}`);
  const needs = Array.from({ length: 50 }, (_, n) => need(`n${String(n).padStart(2, "0")}`,
    ids.flatMap((storeId, s) => {
      const base = s === n % 13 ? 100 : 500 + 10 * s;
      return [
        option(`p${n}`, storeId, base + 50, { ordinaryPriceEvidenceId: `ord:${n}:${s}:dup` }),
        option(`p${n}`, storeId, base, { ordinaryPriceEvidenceId: `ord:${n}:${s}:best` }),
      ];
    })));
  const result = enumerateComposedUniverse(snapshot(ids, needs));
  assert.equal(result.state, "enumerated");
  assert.equal(result.feasiblePlans.length, 377);
  const best = (count) => Math.min(...result.feasiblePlans
    .filter((plan) => plan.storeIds.length === count).map((plan) => plan.totalOre));
  // Stores 0..10 each own 4 needs; uncovered needs pay 500 at s00.
  assert.deepEqual([best(1), best(2), best(3)], [23400, 21800, 20200]);
  const bySig = new Map(result.feasiblePlans.map((plan) => [plan.signature, plan]));
  const savings = bySig.get(result.savingsEndpointSignature);
  const convenience = bySig.get(result.convenienceEndpointSignature);
  assert.equal(savings.totalOre, 20200);
  assert.deepEqual([convenience.totalOre, convenience.storeIds], [23400, ["s00"]]);
  assert.ok(savings.assignments.every((a) => a.ordinaryPriceEvidenceId.endsWith(":best")
    || a.costOre === 500));
  const n03 = savings.assignments.find((a) => a.needId === "n03");
  assert.equal(n03.costOre, savings.storeIds.includes("s03") ? 100 : 500);
});

test("sparse coverage yields no partial plan", () => {
  const sparse = snapshot(["sA", "sB"], [
    need("n1", [option("p1", "sA", 100)]),
    need("n2", [option("p2", "sB", 200)]),
  ]);
  const result = enumerateComposedUniverse(sparse);
  assert.equal(result.feasiblePlans.length, 1);
  assert.deepEqual([result.feasiblePlans[0].storeIds, result.feasiblePlans[0].totalOre], [["sA", "sB"], 300]);
  const missing = snapshot(["sA"], [need("n1", [option("p1", "sA", 100)]),
    need("n2", [option("p2", "sB", 200)])]);
  assert.deepEqual(enumerateComposedUniverse(missing), { state: "no-feasible-plan" });
});

test("a need with no priceable option makes every plan infeasible", () => {
  const overflow = option("p1", "sA", Number.MAX_SAFE_INTEGER);
  const result = enumerateComposedUniverse(snapshot(["sA"], [
    need("n1", [option("p0", "sA", 100)]), need("n2", [overflow], 1000)]));
  assert.deepEqual(result, { state: "no-feasible-plan" });
  const mixed = enumerateComposedUniverse(snapshot(["sA"], [
    need("n2", [overflow, option("p3", "sA", 700)], 1000)]));
  assert.equal(mixed.feasiblePlans[0].totalOre, 1400);
});

test("twenty reviewed-family candidates count one substitution", () => {
  const options = Array.from({ length: 20 }, (_, i) =>
    option(`f${String(i).padStart(2, "0")}`, i < 10 ? "sA" : "sB", 900 - i * 10));
  const result = enumerateComposedUniverse(snapshot(["sA", "sB"],
    [need("n1", options, 500, "reviewed-family")]));
  const totals = result.feasiblePlans.map((p) => [p.storeIds, p.totalOre, p.substitutions,
    p.assignments[0].canonicalProductId]);
  assert.deepEqual(totals, [[["sB"], 710, 1, "f19"], [["sA"], 810, 1, "f09"]]);
});

test("matches the untouched oracle within its own bounds", () => {
  const cases = [
    snapshot(["sA", "sB", "sC"], [
      need("n1", [option("p1", "sA", 300), option("p1b", "sB", 250), option("p1", "sC", 250)]),
      need("n2", [option("p2", "sA", 400, { depositPerPackageOre: 30,
        officialOffers: [offer("o1", 700)] }), option("p2", "sB", 450)], 1500),
      need("n3", [option("p3", "sC", 90), option("p3", "sB", 95)], 500, "reviewed-family"),
    ]),
    snapshot(["sA"], [need("n1", [option("p1", "sA", 1000, { officialOffers: [offer("o-b", 1), offer("o-a", 1)] })], 1000)]),
  ];
  for (const input of cases) {
    assert.deepEqual(enumerateComposedUniverse(input), enumerateBoundedUniverseV2(input));
  }
});

test("structural bounds and malformed snapshots are rejected", () => {
  const one = (id) => need(id, [option("p", "s00", 1)]);
  const stores = (n) => Array.from({ length: n }, (_, i) => `s${String(i).padStart(2, "0")}`);
  const base = () => snapshot(stores(2), [one("n1")]);
  const rejected = [
    snapshot(stores(14), [one("n1")]),
    snapshot(stores(2), Array.from({ length: 51 }, (_, i) => one(`n${i}`))),
    snapshot(stores(2), [need("n1", Array.from({ length: 5001 }, () => option("p", "s00", 1)))]),
    snapshot(stores(2), [need("n1", [])]),
    snapshot(["s00", "s00"], [one("n1")]),
    snapshot(stores(2), [one("n1"), one("n1")]),
    { ...base(), maximumStores: 13 },
    { ...base(), contractVersion: 1 },
    { ...base(), stores: [] },
    { ...base(), enabledMembershipProgramIds: ["b", "a"] },
    { ...base(), enabledMembershipProgramIds: undefined },
    { ...base(), needs: [] },
    null,
  ];
  for (const input of rejected) assert.deepEqual(enumerateComposedUniverse(input), { state: "invalid-bounds" });
  const at5000 = snapshot(stores(2), [need("n1", Array.from({ length: 5000 }, (_, i) =>
    option("p", "s00", 10 + (i === 4321 ? 0 : 1), { ordinaryPriceEvidenceId: `ord:${i}` })))]);
  assert.equal(enumerateComposedUniverse(at5000).feasiblePlans[0].assignments[0].ordinaryPriceEvidenceId, "ord:4321");
});
