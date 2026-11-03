import { describe, expect, it } from "vitest";

import { enumerateComposedUniverse } from "../../../tests/acceptance/planner-workload-oracle.mjs";
import {
  FIXED_CLOCK,
  buildWorkloads,
  packageCount,
  reverseProductionInput,
} from "../../../tests/acceptance/planner-workload-fixtures.mjs";
import { calculatePlansV2, enumerateCompletePlanCandidatesV2 } from "./planner-v2.ts";

// The current planner is the subject; expected facts come only from raw authored records
// and the accepted independent oracle. Raw source admission is not qualified here.
const NOW = new Date(FIXED_CLOCK);
const text = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function lookups(raw) {
  const prod = new Map(raw.products.map((p) => [p.canonicalProductId, p]));
  return {
    prod,
    need: new Map(raw.needs.map((n) => [n.id, n])),
    priceById: new Map(raw.prices.map((r) => [r.id, r])),
    priceBySource: new Map(raw.prices.map((r) => [r.source, r])),
    offerById: new Map(raw.offers.map((o) => [o.id, o])),
  };
}

function normalized(raw, index, assignments, chains, substitutions, totalOre) {
  const sorted = [...assignments].sort((a, b) => text(a.needId, b.needId));
  return {
    key: JSON.stringify(sorted),
    assignments: sorted,
    chains: [...chains].sort(text),
    substitutions,
    totalOre,
  };
}

function fromOracle(raw, index, plan) {
  const assignments = plan.assignments.map((a) => {
    const need = index.need.get(a.needId);
    const prod = index.prod.get(a.canonicalProductId);
    const price = index.priceById.get(a.ordinaryPriceEvidenceId);
    const offer = a.appliedOfferEvidenceId === null ? null : index.offerById.get(a.appliedOfferEvidenceId);
    const purchased = a.purchasedBaseUnits;
    return {
      needId: a.needId,
      productId: a.canonicalProductId,
      ean: prod.ean,
      chain: a.storeId,
      packageCount: a.packageCount,
      packageAmount: a.packageBaseUnits,
      purchased,
      surplus: need.requested.unit === "package" ? 0 : purchased - need.requested.amount,
      priceEvidenceId: price.id,
      observedAt: price.observedAt,
      offerEvidenceId: offer === null ? null : offer.id,
      offerRef: offer === null ? null : [offer.sourceId, offer.sourceRecordId, offer.capturedAt],
      ordinaryCostOre: a.ordinaryCostOre,
      costOre: a.costOre,
      savingOre: a.ordinaryCostOre - a.costOre,
    };
  });
  return normalized(raw, index, assignments, plan.storeIds, plan.substitutions, plan.totalOre);
}

function fromProduction(raw, index, plan) {
  const assignments = plan.assignments.map((a) => {
    const price = index.priceBySource.get(a.source);
    expect([price.productId, price.chain, price.observedAt]).toEqual([a.canonicalProductId, a.chain, a.observedAt]);
    expect(index.prod.get(a.canonicalProductId).ean).toBe(a.ean);
    const offer = a.officialOffer === undefined ? null : index.offerById.get(a.officialOffer.id);
    return {
      needId: a.needId,
      productId: a.canonicalProductId,
      ean: a.ean,
      chain: a.chain,
      packageCount: a.fulfilment.packageCount,
      packageAmount: a.fulfilment.packageMeasure.amount,
      purchased: a.fulfilment.purchased.amount,
      surplus: a.fulfilment.surplus.amount,
      priceEvidenceId: price.id,
      observedAt: a.observedAt,
      offerEvidenceId: a.checkout.appliedOfferId ?? null,
      offerRef: offer === null ? null
        : [a.officialOffer.sourceId, a.officialOffer.sourceRecordId, a.officialOffer.capturedAt],
      ordinaryCostOre: a.checkout.ordinaryTotalOre,
      costOre: a.costOre,
      savingOre: a.checkout.savingOre,
    };
  });
  return normalized(raw, index, assignments, plan.chains, plan.substitutions.length, plan.totalOre);
}

function dominates(l, r) {
  const noWorse = l.totalOre <= r.totalOre && l.chains.length <= r.chains.length && l.substitutions <= r.substitutions;
  return noWorse && (l.totalOre < r.totalOre || l.chains.length < r.chains.length || l.substitutions < r.substitutions);
}
const endpoint = (plans, order) => [...plans].sort((a, b) => order(a) - order(b) || text(a.key, b.key))[0];

describe("authored planner workloads against the independent oracle", () => {
  for (const workload of buildWorkloads()) {
    it(workload.id, { timeout: 120_000 }, () => {
      const { raw, productionInput } = workload;
      const index = lookups(raw);
      const candidates = enumerateCompletePlanCandidatesV2(productionInput, NOW);
      const frontier = calculatePlansV2(productionInput, NOW);

      if (workload.expectNoPlan !== undefined) {
        expect(candidates, workload.expectNoPlan).toEqual([]);
        expect(frontier).toEqual([]);
        return;
      }

      const oracle = enumerateComposedUniverse(workload.oracleSnapshot);
      expect(oracle.state).toBe("enumerated");
      const oraclePlans = oracle.feasiblePlans.map((p) => fromOracle(raw, index, p));
      const prodPlans = candidates.map((p) => fromProduction(raw, index, p));

      // Every assignment, evidence reference, monetary and surplus fact of every complete plan.
      expect(prodPlans.map((p) => p.key).sort(text)).toEqual(oraclePlans.map((p) => p.key).sort(text));
      const oracleByKey = new Map(oraclePlans.map((p) => [p.key, p]));
      for (const plan of prodPlans) {
        const expected = oracleByKey.get(plan.key);
        expect(plan.chains).toEqual(expected.chains);
        expect(plan.substitutions).toBe(expected.substitutions);
        expect(plan.totalOre).toBe(expected.totalOre);
        expect(plan.totalOre).toBe(plan.assignments.reduce((s, a) => s + a.costOre, 0));
        for (const a of plan.assignments) {
          const need = index.need.get(a.needId);
          const prod = index.prod.get(a.productId);
          expect(a.packageCount).toBe(packageCount(need, prod));
          expect(a.savingOre).toBe(a.ordinaryCostOre - a.costOre);
        }
      }
      expect(candidates.length).toBe(oracle.feasiblePlans.length);

      // Frontier set and both endpoints.
      const prodFrontierKeys = frontier.map((p) => fromProduction(raw, index, p).key).sort(text);
      const oracleFrontier = oraclePlans.filter((p, i) =>
        oracle.frontierPlanSignatures.includes(oracle.feasiblePlans[i].signature));
      expect(prodFrontierKeys).toEqual(oracleFrontier.map((p) => p.key).sort(text));
      const prodFrontier = frontier.map((p) => fromProduction(raw, index, p));
      const byOracleSig = (sig) => oraclePlans[oracle.feasiblePlans.findIndex((p) => p.signature === sig)];
      expect(endpoint(prodFrontier, (p) => p.chains.length * 1e12 + p.totalOre).key)
        .toBe(byOracleSig(oracle.convenienceEndpointSignature).key);
      expect(endpoint(prodFrontier, (p) => p.totalOre).key)
        .toBe(byOracleSig(oracle.savingsEndpointSignature).key);
      for (const l of prodPlans) {
        expect(prodFrontier.some((f) => f.key === l.key)).toBe(!prodPlans.some((o) => dominates(o, l)));
      }

      // Input order must not change any result.
      const reversed = reverseProductionInput(productionInput);
      expect(enumerateCompletePlanCandidatesV2(reversed, NOW)).toEqual(candidates);
      if (candidates.length < 50) expect(calculatePlansV2(reversed, NOW)).toEqual(frontier);

      // Excluded distractors never appear as evidence in any plan.
      const excludedOffers = new Set(raw.offers.filter((o) => o.expected !== "eligible").map((o) => o.id));
      const excludedPrices = new Set(raw.prices.filter((r) => r.expected !== "eligible").map((r) => r.id));
      for (const plan of prodPlans) {
        for (const a of plan.assignments) {
          expect(excludedOffers.has(a.offerEvidenceId)).toBe(false);
          expect(excludedPrices.has(a.priceEvidenceId)).toBe(false);
        }
      }

      if (workload.handExpected !== undefined) {
        const hand = workload.handExpected;
        expect(prodPlans.map((p) => p.totalOre).sort((a, b) => a - b)).toEqual(hand.feasibleTotals);
        expect(frontier.map((p) => p.totalOre).sort((a, b) => a - b)).toEqual(hand.frontierTotals);
        const savings = endpoint(prodFrontier, (p) => p.totalOre);
        expect([savings.totalOre, savings.chains]).toEqual([hand.savings.total, hand.savings.chains]);
        const conv = endpoint(prodFrontier, (p) => p.chains.length * 1e12 + p.totalOre);
        expect([conv.totalOre, conv.chains]).toEqual([hand.convenience.total, hand.convenience.chains]);
        const a = Object.fromEntries(savings.assignments.map((x) => [x.needId, x]));
        expect(a["need:h1"]).toMatchObject({ chain: "extra", packageCount: 5, costOre: 1800, ordinaryCostOre: 2000, offerEvidenceId: hand.h1.offer });
        expect(a["need:h2"]).toMatchObject({ chain: "meny", packageCount: 2, costOre: 1200, ordinaryCostOre: 1300, surplus: 250, offerEvidenceId: hand.h2.offer });
        expect(a["need:h3"]).toMatchObject({ chain: "extra", productId: "prod:hand:4", packageCount: 5, costOre: 450_000 });
      }
    });
  }
});
