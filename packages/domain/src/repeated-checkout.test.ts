import { describe, expect, it } from "vitest";
import { calculatePlansV2 } from "./planner-v2";
import { planAssignmentV2Schema, planResultV2Schema, serverPlanningInputV2Schema, type ServerPlanningInputV2 } from "./planner-v2-contracts";
import { matchRuleSchema, moneyOreSchema } from "./contracts";
import { officialOfferSchema } from "./offers";

const NOW = new Date("2026-07-16T12:00:00.000Z");
const EAN = "7038010000010";

function basket(amounts: readonly number[], size: number, unit: "piece" | "package", price: number, quantity: number, deal: number): ServerPlanningInputV2 {
  return {
    contractVersion: 2, maxStores: 1,
    needs: amounts.map((amount, i) => ({id: `need:${i}`, query: "coffee", requested: {amount, unit}, matchRuleId: "rule:coffee", required: true})),
    matchingRules: [{id: "rule:coffee", mode: "exact", exactEan: EAN, userApproved: true, explanation: "Chosen product"}],
    products: [{canonicalProductId: "product:coffee", ean: EAN, name: "Coffee", packageMeasure: {amount: size, unit: "piece"}}],
    ordinaryPrices: [{ean: EAN, chain: "extra", amountOre: moneyOreSchema.parse(price), observedAt: "2026-07-16T11:00:00.000Z", source: "price-feed"}],
    officialOffers: [{contractVersion: 1, kind: "official-offer", id: "offer:coffee", sourceId: "offer-feed", sourceRecordId: "campaign:42", chainId: "extra", productMatch: {kind: "exact", canonicalProductId: "product:coffee"}, pricing: {kind: "multibuy", quantity, totalOre: moneyOreSchema.parse(deal)}, conditions: [{kind: "public"}], applicability: {contractVersion: 1, startsAt: "2026-07-14T00:00:00.000Z", endsAt: "2026-07-19T23:59:59.999Z", geographicScope: {kind: "national", countryCode: "NO"}, channels: ["in-store"]}, evidenceLevel: "reviewed", capturedAt: "2026-07-15T10:00:00.000Z"}],
    offerEligibility: {maxEvidenceAgeMs: 14 * 86400000, location: {countryCode: "NO", regionCode: "NO-03"}, channel: "in-store", enabledSourceIds: ["offer-feed"], enabledMembershipProgramIds: []},
  };
}

// Enumerate purchases and qualifying multibuy counts independently of production.
function oracle(amounts: readonly number[], size: number, unit: "piece" | "package", price: number, quantity: number, deal: number) {
  const requested = amounts.reduce((sum, amount) => sum + amount, 0);
  let packages = 0;
  while ((unit === "package" ? packages : packages * size) < requested) packages += 1;
  let total = packages * price;
  for (let groups = 0; groups * quantity <= packages; groups += 1) {
    total = Math.min(total, groups * deal + (packages - groups * quantity) * price);
  }
  return {packages, total, ordinary: packages * price, purchased: unit === "package" ? packages : packages * size, surplus: unit === "package" ? 0 : packages * size - requested};
}

describe("issue29 repeated exact checkout", () => {
  it("qualifies two repeated one-package needs for one multibuy", () => {
    const plans = calculatePlansV2(basket([1, 1], 1, "package", 6000, 2, 10000), NOW);
    expect(plans.map(p => p.totalOre)).toEqual([10000]);
  });

  it("matches an independent exhaustive small arithmetic oracle", () => {
    let cases = 0;
    for (const unit of ["piece", "package"] as const) for (const size of [1, 2, 3])
      for (const a of [1, 2, 3]) for (const b of [1, 2, 3])
        for (const quantity of [2, 3]) for (const price of [1, 7]) for (const deal of [1, 5, 20]) {
          const expected = oracle([a, b], size, unit, price, quantity, deal);
          const plans = calculatePlansV2(basket([a, b], size, unit, price, quantity, deal), NOW);
          expect(plans.length).toBe(1);
          const plan = plans[0];
          if (plan === undefined) throw new Error("Missing complete checkout");
          expect(plan.totalOre).toBe(expected.total);
          expect(plan.assignments.reduce((sum, x) => sum + x.fulfilment.packageCount, 0)).toBe(expected.packages);
          expect(plan.assignments.reduce((sum, x) => sum + x.fulfilment.purchased.amount, 0)).toBe(expected.purchased);
          expect(plan.assignments.reduce((sum, x) => sum + x.fulfilment.surplus.amount, 0)).toBe(expected.surplus);
          expect(plan.assignments.reduce((sum, x) => sum + x.checkout.ordinaryTotalOre, 0)).toBe(expected.ordinary);
          expect(plan.assignments.reduce((sum, x) => sum + x.checkout.totalOre, 0)).toBe(expected.total);
          cases += 1;
        }
    expect(cases).toBe(648);
  });

  it("allocates unequal three-member quantities, rounding, remainder and zero ordinary prices", () => {
    for (const [price, expected] of [
      [7, [[1, 1, 0, 2, 1, 1], [0, 2, 0, 6, 4, 2], [1, 3, 1, 6, 4, 2]]],
      [0, [[1, 1, 0, 0, 0, 0], [0, 2, 0, 0, 0, 0], [1, 3, 1, 0, 0, 0]]],
    ] as const) {
      const plan = calculatePlansV2(basket([1, 2, 2], 3, "piece", price, 2, 5), NOW)[0];
      expect(plan).toBeDefined();
      expect(plan?.assignments.map(row => [row.fulfilment.packageCount, row.fulfilment.purchased.amount,
        row.fulfilment.surplus.amount, row.checkout.ordinaryTotalOre, row.checkout.savingOre, row.checkout.totalOre])).toEqual(expected);
    }
  });

  it("selects a grouped chain and offer that lose independent per-need selection", () => {
    const input = basket([1, 1], 1, "package", 6000, 2, 10000);
    const offer = input.officialOffers[0];
    if (offer === undefined) throw new Error("Missing offer fixture");
    input.maxStores = 2;
    input.ordinaryPrices.push({...input.ordinaryPrices[0], ean: EAN, chain: "bunnpris", amountOre: moneyOreSchema.parse(5500), observedAt: "2026-07-16T11:00:00.000Z", source: "price-feed"});
    input.officialOffers.push({...offer, id: "offer:unit", pricing: {kind: "unit", unitPriceOre: moneyOreSchema.parse(5500)}});
    const plans = calculatePlansV2(input, NOW);
    expect(plans.map(plan => [plan.totalOre, plan.chains])).toEqual([[10000, ["extra"]]]);
    expect(plans[0]?.assignments.map(a => a.checkout.appliedOfferId)).toEqual(["offer:coffee", "offer:coffee"]);
  });

  it("keeps membership, expiry, evidence age, location and minimum quantity eligibility", () => {
    const initial = basket([1, 1], 1, "package", 6000, 2, 10000);
    const offer = initial.officialOffers[0];
    if (offer === undefined) throw new Error("Missing offer fixture");
    const excluded = [
      {...offer, conditions: [{kind: "member" as const, programId: "club"}]},
      {...offer, conditions: [{kind: "public" as const}, {kind: "minimum-quantity" as const, quantity: 3}]},
      {...offer, capturedAt: "2026-06-01T10:00:00.000Z"},
      {...offer, applicability: {...offer.applicability, endsAt: "2026-07-16T11:59:59.000Z"}},
      {...offer, applicability: {...offer.applicability, geographicScope: {kind: "regions" as const, countryCode: "NO", regionCodes: ["NO-11"]}}},
      {...offer, productMatch: {kind: "exact" as const, canonicalProductId: "product:other"}},
    ];
    for (const invalidOffer of excluded) {
      expect(officialOfferSchema.safeParse(invalidOffer).success).toBe(true);
      expect(calculatePlansV2({...initial, officialOffers: [invalidOffer]}, NOW).map(p => p.totalOre)).toEqual([12000]);
    }
    const member = excluded[0];
    if (member === undefined) throw new Error("Missing member fixture");
    expect(calculatePlansV2({...initial, officialOffers: [member], offerEligibility: {...initial.offerEligibility, enabledMembershipProgramIds: ["club"]}}, NOW).map(p => p.totalOre)).toEqual([10000]);
    expect(calculatePlansV2({...initial, ordinaryPrices: initial.ordinaryPrices.map(p => ({...p, observedAt: "2026-06-01T10:00:00.000Z"}))}, NOW)).toEqual([]);
  });

  it("keeps distinct units, family choices and products separate", () => {
    const input = basket([1, 1], 2, "piece", 6000, 2, 10000);
    const first = input.needs[0], second = input.needs[1];
    if (first === undefined || second === undefined) throw new Error("Missing needs");
    const mixed = calculatePlansV2({...input, needs: [first, {...second, requested: {amount: 1, unit: "package"}}]}, NOW);
    expect(mixed[0]?.assignments.map(a => a.fulfilment.contractVersion)).toEqual([2, 2]);
    expect(mixed[0]?.totalOre).toBe(12000);
    expect(calculatePlansV2({...input, needs: [first, {...second, requested: {amount: 1, unit: "ml"}}]}, NOW)).toEqual([]);
    const family = {...input, products: input.products.map(product => ({...product, productFamily: "coffee"})), matchingRules: [{id: "rule:coffee", mode: "flexible" as const, productFamily: "coffee", userApproved: true, explanation: "Family choice"}]};
    expect(serverPlanningInputV2Schema.safeParse(family).success).toBe(true);
    expect(calculatePlansV2(family, NOW)[0]?.assignments.map(a => a.fulfilment.contractVersion)).toEqual([2, 2]);
    const another = "7038010000027";
    const products = [{...input.products[0], canonicalProductId: "product:coffee", ean: EAN, name: "Coffee", packageMeasure: {amount: 2, unit: "piece" as const}}, {...input.products[0], canonicalProductId: "product:other", ean: another, name: "Other", packageMeasure: {amount: 2, unit: "piece" as const}}];
    const distinct = {...input, products, needs: [first, {...second, matchRuleId: "rule:other"}], matchingRules: [...input.matchingRules, {id: "rule:other", mode: "exact" as const, exactEan: another, userApproved: true, explanation: "Other product"}], ordinaryPrices: [...input.ordinaryPrices, {...input.ordinaryPrices[0], ean: another, chain: "extra" as const, amountOre: moneyOreSchema.parse(6000), observedAt: "2026-07-16T11:00:00.000Z", source: "price-feed"}]};
    expect(calculatePlansV2(distinct, NOW)[0]?.totalOre).toBe(12000);
  });

  it("rejects malformed requests and aggregate money, contents and quantity overflow", () => {
    for (const input of [
      basket([Number.MAX_SAFE_INTEGER, 1], 1, "package", 1, 2, 1),
      basket([Number.MAX_SAFE_INTEGER - 1, 1], 2, "package", 1, 2, 1),
      basket([1, 1], 1, "package", 2147483647, 2, 1),
      basket([0, 1], 1, "package", 1, 2, 1),
      basket([1.5, 1], 1, "package", 1, 2, 1),
    ]) expect(calculatePlansV2(input, NOW)).toEqual([]);
  });

  it("fails closed on missing offer eligibility and flexible product family", () => {
    const input = basket([1, 1], 1, "package", 6000, 2, 10000);
    const offer = input.officialOffers[0];
    if (offer === undefined) throw new Error("Missing offer fixture");
    const malformedOffer = {...offer, conditions: [{kind: "minimum-quantity" as const, quantity: 3}]};
    expect(officialOfferSchema.safeParse(malformedOffer).success).toBe(false);
    expect(calculatePlansV2({...input, officialOffers: [malformedOffer]}, NOW)).toEqual([]);
    const malformedRule = {id: "rule:coffee", mode: "flexible" as const, userApproved: true, explanation: "Family choice"};
    expect(matchRuleSchema.safeParse(malformedRule).success).toBe(false);
    expect(calculatePlansV2({...input, matchingRules: [malformedRule]}, NOW)).toEqual([]);
  });

  it("rejects a zero-share nonmember borrowing an otherwise valid checkout group", () => {
    const input = basket([1, 1], 1, "package", 6000, 2, 10000);
    const plan = calculatePlansV2({...input, needs: input.needs.map((need, i) => ({...need, id: i === 0 ? "need:b" : "need:c"}))}, NOW)[0];
    if (plan === undefined) throw new Error("Missing grouped plan");
    expect(planResultV2Schema.safeParse(plan).success).toBe(true);
    const member = plan.assignments[0];
    if (member?.fulfilment.contractVersion !== 3) throw new Error("Missing group allocation");
    const forged = {...member, needId: "need:a", costOre: 0,
      fulfilment: {...member.fulfilment, needId: "need:a", packageCount: 0},
      checkout: {...member.checkout, ordinaryTotalOre: 0, savingOre: 0, totalOre: 0}};
    expect(planAssignmentV2Schema.safeParse(forged).success).toBe(true);
    const result = planResultV2Schema.safeParse({...plan, assignments: [forged, ...plan.assignments], freshness: {...plan.freshness, "need:a": "eligible"}});
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({message: "Checkout group must exactly cover its sorted needs and requested quantity"}),
    ]));
  });

  it("rejects partial groups, forged shares and incompatible group evidence", () => {
    const plan = calculatePlansV2(basket([1, 1, 1], 2, "piece", 7, 2, 5), NOW)[0];
    if (plan === undefined) throw new Error("Missing grouped plan");
    const first = plan.assignments[0];
    if (first?.fulfilment.contractVersion !== 3) throw new Error("Missing group allocation");
    const changed = [
      {...first, fulfilment: {...first.fulfilment, packageCount: 2}},
      {...first, fulfilment: {...first.fulfilment, purchased: {amount: 2, unit: "piece"}}},
      {...first, fulfilment: {...first.fulfilment, group: {...first.fulfilment.group, needIds: [first.needId, first.needId]}}},
      {...first, source: "forged-source"},
      {...first, chain: "bunnpris"},
      {...first, checkout: {...first.checkout, savingOre: 0}},
    ];
    for (const assignment of changed) {
      expect(planResultV2Schema.safeParse({...plan, assignments: [assignment, ...plan.assignments.slice(1)]}).success).toBe(false);
    }
    expect(planResultV2Schema.safeParse({...plan, assignments: plan.assignments.slice(1)}).success).toBe(false);
    expect(calculatePlansV2({...basket([1, 1, 1], 2, "piece", 7, 2, 5), needs: [...basket([1, 1, 1], 2, "piece", 7, 2, 5).needs].reverse()}, NOW)).toEqual([plan]);
  });
});
