// Raw authored planner workloads. Dependency-free: Node builtins and data only.
// Expected facts come from the raw records (explicit labels plus independent arithmetic),
// never from the production matcher, eligibility, fulfilment or planner.

export const FIXED_CLOCK = "2026-07-16T12:00:00.000Z";
export const MAX_PERSISTED_MONEY_ORE = 2_147_483_647;
const NOW_MS = Date.parse(FIXED_CLOCK);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PRICE_MAX_AGE_MS = 72 * HOUR;
const OFFER_MAX_AGE_MS = 14 * DAY;
const at = (deltaMs) => new Date(NOW_MS + deltaMs).toISOString();

export const CHAINS = ["bunnpris", "extra", "rema-1000", "fudi", "holdbart", "meny", "havaristen", "joker", "spar", "fastcandy", "europris", "engrossnett", "oda"];
const ENABLED_SOURCE = "offer-feed";
const MEMBER_ON = "member:klubb";
const MEMBER_OFF = "member:other";
const LOCATION = { countryCode: "NO", regionCode: "NO-03" };

// Exact contract limits found in the current source; recorded, not worked around.
export const CONTRACT_LIMITS = Object.freeze([
  "serverPlanningInputV2Schema rejects more than one ordinary price per GTIN and chain, so multiple fresh price observations per product-chain cannot be authored",
  "PlanningProductV2 has no deposit field and bestCheckout passes no deposit, so oracle deposit is 0 for production cross-checks",
  "ordinaryPrices are pre-admitted by contract; raw source/scope/permission admission is not qualified here; only classifyFreshness and offer evaluation run",
  "production caps money at 2147483647 ore while the oracle caps at safe integers, so over-cap options are excluded by authored truth",
  "production offers end exclusively at endsAt while the oracle validUntil is inclusive, so no authored instant sits on a boundary",
  "production assignments expose source and observedAt rather than ordinary price ids, so every raw price record has a unique source id",
  "shared-checkout29 grouped checkout is not covered and no duplicate exact needs are authored",
]);

function gtin13(serial) {
  const digits = [...String(703801000000 + serial)].map(Number);
  const sum = digits.reduce((total, digit, index) =>
    total + digit * ((digits.length - index) % 2 === 1 ? 3 : 1), 0);
  return digits.join("") + String((10 - (sum % 10)) % 10);
}

function product(tag, index, amount, unit, family) {
  return {
    canonicalProductId: `prod:${tag}:${index}`,
    ean: gtin13(tag.length * 1000 + tag.charCodeAt(0) * 10_000 + index),
    name: `Vare ${tag} ${index}`,
    packageMeasure: { amount, unit },
    ...(family === undefined ? {} : { productFamily: family }),
  };
}

function price(prod, chain, amountOre, deltaMs, expected = "eligible") {
  const id = `ord:${prod.canonicalProductId}:${chain}`;
  return { id, productId: prod.canonicalProductId, chain, amountOre, observedAt: at(deltaMs), source: `src:${id}`, expected };
}

const ADVERSE = {
  expired: { startsAt: at(-10 * DAY), endsAt: at(-DAY), expected: "excluded:expired" },
  "member-disabled": { condition: MEMBER_OFF, expected: "excluded:membership-disabled" },
  "wrong-region": { regions: ["NO-46"], expected: "excluded:wrong-geography" },
  "disabled-source": { sourceId: "offer-feed-disabled", expected: "excluded:source-disabled" },
  stale: { capturedAt: at(-20 * DAY), expected: "excluded:stale" },
  future: { capturedAt: at(DAY), expected: "excluded:future" },
};
const ADVERSE_KINDS = Object.keys(ADVERSE);

function offer(prod, chain, key, pricing, overrides = {}) {
  const id = `offer:${prod.canonicalProductId}:${chain}:${key}`;
  return {
    id,
    sourceId: ENABLED_SOURCE,
    sourceRecordId: `rec:${id}`,
    productId: prod.canonicalProductId,
    chain,
    pricing,
    condition: "public",
    minQuantity: 1,
    startsAt: at(-5 * DAY),
    endsAt: at(4 * DAY),
    capturedAt: at(-2 * DAY),
    regions: ["NO-03"],
    expected: "eligible",
    ...overrides,
  };
}
const adverseOffer = (prod, chain, kind) =>
  offer(prod, chain, kind, { kind: "unit", unitPriceOre: 1 }, ADVERSE[kind]);

function exactNeed(prod, requested, id = `need:${prod.canonicalProductId}`) {
  return { id, query: prod.name, requested, mode: "exact", productId: prod.canonicalProductId };
}

// Deterministic quantity pattern: whole, remainder, and explicit-package requests.
const UNITS = ["g", "ml", "piece"];
const PACKS = { g: [250, 500, 750, 1000], ml: [330, 500, 1000], piece: [6, 12, 4] };
function packOf(i) {
  const unit = UNITS[i % 3];
  return { unit, amount: PACKS[unit][i % PACKS[unit].length] };
}
function requestedOf(i, pack) {
  if (i % 10 === 9) return { amount: 1 + (i % 6), unit: "package" };
  const base = pack.amount * (1 + (i % 5));
  return { amount: i % 2 === 0 ? base : base - Math.floor(pack.amount / 5), unit: pack.unit };
}

function raw(extra) {
  return {
    clock: FIXED_CLOCK,
    channel: "in-store",
    location: LOCATION,
    maxEvidenceAgeMs: OFFER_MAX_AGE_MS,
    enabledSourceIds: [ENABLED_SOURCE],
    enabledMembershipProgramIds: [MEMBER_ON],
    products: [],
    needs: [],
    prices: [],
    offers: [],
    overflowExclusions: [],
    ...extra,
  };
}

function largeCase(id, title, chains, exactCount, withFamily) {
  const products = [];
  const needs = [];
  const prices = [];
  const offers = [];
  const addPairs = (prod, i, ci, c, amountOre) => {
    const stale = (i + 2 * ci) % 11 === 0;
    prices.push(stale
      ? price(prod, c, 1, (i + ci) % 2 === 0 ? -100 * HOUR : 2 * HOUR, (i + ci) % 2 === 0 ? "excluded:stale" : "excluded:future")
      : price(prod, c, amountOre, -(1 + ((i + ci) % 60)) * HOUR));
    offers.push(offer(prod, c, "unit", { kind: "unit", unitPriceOre: amountOre - 20 - ((i + ci) % 9) * 5 },
      i % 4 === 1 ? { minQuantity: 2 } : {}));
    const q = 2 + ((i + 2 * ci) % 2);
    offers.push(offer(prod, c, "multi", { kind: "multibuy", quantity: q, totalOre: q * amountOre - 40 - (ci % 4) * 13 }));
    offers.push(adverseOffer(prod, c, ADVERSE_KINDS[(i + ci) % 4]));
    offers.push((i + ci) % 3 === 0
      ? offer(prod, c, "member", { kind: "unit", unitPriceOre: amountOre - 60 - (i % 5) * 4 }, { condition: MEMBER_ON })
      : adverseOffer(prod, c, (i + ci) % 3 === 1 ? "stale" : "future"));
  };
  for (let i = 0; i < exactCount; i += 1) {
    const pack = packOf(i);
    const prod = product(id, i, pack.amount, pack.unit);
    products.push(prod);
    needs.push(exactNeed(prod, requestedOf(i, pack)));
    chains.forEach((c, ci) => {
      const rank = (CHAINS.indexOf(c) * 7 + i * 3) % 13;
      addPairs(prod, i, ci, c, 1500 + (i % 10) * 90 + rank * 97 + ci);
    });
  }
  if (withFamily) {
    for (let k = 0; k < 20; k += 1) {
      const prod = product(id, exactCount + k, 500, "g", "family:pasta");
      products.push(prod);
      chains.forEach((c, ci) => {
        const index = k * 13 + ci;
        prices.push(price(prod, c, 900 + ((index * 37) % 260) * 5, -(1 + (index % 48)) * HOUR));
        if (index % 5 === 0) offers.push(offer(prod, c, "unit", { kind: "unit", unitPriceOre: 900 + ((index * 37) % 260) * 5 - 2 }));
        if (index % 7 === 0) offers.push(adverseOffer(prod, c, ADVERSE_KINDS[index % 6]));
      });
    }
    needs.push({ id: "need:family-pasta", query: "pasta", requested: { amount: 1500, unit: "g" }, mode: "flexible", family: "family:pasta" });
  }
  return { id, title, raw: raw({ products, needs, prices, offers }) };
}

function sparseCase() {
  const chains = ["extra", "meny", "oda"];
  const products = [];
  const needs = [];
  const prices = [];
  const offers = [];
  for (let i = 0; i < 50; i += 1) {
    const pack = packOf(i);
    const prod = product("sparse", i, pack.amount, pack.unit);
    products.push(prod);
    needs.push(exactNeed(prod, requestedOf(i, pack)));
    const available = i % 7 === 0 ? [0] : i % 7 === 1 ? [1] : i % 7 === 2 ? [2]
      : i % 3 === 0 ? [0, 1] : i % 3 === 1 ? [1, 2] : [0, 2];
    for (const ci of available) {
      const amountOre = 1200 + (i % 10) * 70 + ((ci * 5 + i) % 3) * 31 + ci;
      prices.push(price(prod, chains[ci], amountOre, -(1 + ((i + ci) % 60)) * HOUR));
      if (i % 3 === 0) offers.push(offer(prod, chains[ci], "unit", { kind: "unit", unitPriceOre: amountOre - 35 - ci * 3 }));
      if (i % 5 === 0) offers.push(adverseOffer(prod, chains[ci], ADVERSE_KINDS[(i + ci) % 6]));
    }
  }
  return { id: "sparse-3-chains", title: "50 exact needs, sparse availability over 3 chains, one complete plan", raw: raw({ products, needs, prices, offers }) };
}

// Small case with hand-computed answers (see handExpected).
function handCase() {
  const h1 = product("hand", 1, 500, "g");
  const h2 = product("hand", 2, 500, "g");
  const r1 = product("hand", 3, 1, "g", "family:rice");
  const r2 = product("hand", 4, 1_000_000, "g", "family:rice");
  const prices = [
    price(h1, "extra", 400, -HOUR), price(h1, "meny", 390, -2 * HOUR),
    price(h2, "extra", 700, -HOUR), price(h2, "meny", 650, -HOUR),
    price(r1, "extra", 500, -HOUR), price(r1, "meny", 400, -HOUR),
    price(r2, "extra", 90_000, -HOUR), price(r2, "meny", 95_000, -HOUR),
  ];
  const offers = [
    offer(h1, "extra", "mb", { kind: "multibuy", quantity: 3, totalOre: 1000 }),
    offer(h2, "meny", "member", { kind: "unit", unitPriceOre: 600 }, { condition: MEMBER_ON }),
    ...ADVERSE_KINDS.map((kind) => adverseOffer(h1, "meny", kind)),
  ];
  return {
    id: "hand-computed",
    title: "Hand-computed bundle remainder, member offer, over-cap option and adverse offers",
    raw: raw({
      products: [h1, h2, r1, r2],
      needs: [
        exactNeed(h1, { amount: 5, unit: "package" }, "need:h1"),
        exactNeed(h2, { amount: 750, unit: "g" }, "need:h2"),
        { id: "need:h3", query: "ris", requested: { amount: 5_000_000, unit: "g" }, mode: "flexible", family: "family:rice" },
      ],
      prices,
      offers,
      overflowExclusions: [{ needId: "need:h3", priceId: "ord:prod:hand:3:extra" }],
    }),
    handExpected: {
      feasibleTotals: [453_000, 453_200, 478_150],
      frontierTotals: [453_000, 453_200],
      convenience: { total: 453_200, chains: ["extra"] },
      savings: { total: 453_000, chains: ["extra", "meny"] },
      h1: { chain: "extra", packageCount: 5, costOre: 1800, ordinaryCostOre: 2000, offer: "offer:prod:hand:1:extra:mb" },
      h2: { chain: "meny", packageCount: 2, costOre: 1200, ordinaryCostOre: 1300, surplus: 250, offer: "offer:prod:hand:2:meny:member" },
      h3: { chain: "extra", productId: "prod:hand:4", packageCount: 5, costOre: 450_000 },
      eligibleOfferIds: ["offer:prod:hand:1:extra:mb", "offer:prod:hand:2:meny:member"],
    },
  };
}

function noPlanCases() {
  const a = product("nomatch", 1, 500, "g", "family:other");
  const missing = {
    id: "missing-family",
    title: "Flexible need whose family has no product",
    raw: raw({
      products: [a],
      needs: [{ id: "need:absent", query: "ukjent", requested: { amount: 500, unit: "g" }, mode: "flexible", family: "family:absent" }],
      prices: [price(a, "extra", 500, -HOUR)],
    }),
    expectNoPlan: "no product matches the family",
  };
  const b = product("stale", 1, 500, "g");
  const staleOnly = {
    id: "stale-and-future-only",
    title: "Only stale and future ordinary prices exist",
    raw: raw({
      products: [b],
      needs: [exactNeed(b, { amount: 500, unit: "g" })],
      prices: [
        price(b, "extra", 1, -100 * HOUR, "excluded:stale"),
        price(b, "meny", 1, 2 * HOUR, "excluded:future"),
      ],
      offers: [offer(b, "extra", "unit", { kind: "unit", unitPriceOre: 1 })],
    }),
    expectNoPlan: "no price is fresh (72h) and not in the future",
  };
  return [missing, staleOnly];
}

// ---- independent truth from raw records ----

const productOf = (rawCase, id) => rawCase.products.find((p) => p.canonicalProductId === id);

export function priceTruth(rawCase, rec) {
  const age = NOW_MS - Date.parse(rec.observedAt);
  return age < 0 ? "excluded:future" : age > PRICE_MAX_AGE_MS ? "excluded:stale" : "eligible";
}

export function offerTruth(rawCase, rec) {
  const captured = Date.parse(rec.capturedAt);
  if (!rawCase.enabledSourceIds.includes(rec.sourceId)) return "excluded:source-disabled";
  if (captured > NOW_MS) return "excluded:future";
  if (NOW_MS - captured > rawCase.maxEvidenceAgeMs) return "excluded:stale";
  if (NOW_MS < Date.parse(rec.startsAt)) return "excluded:not-yet-active";
  if (NOW_MS >= Date.parse(rec.endsAt)) return "excluded:expired";
  if (!rec.regions.includes(rawCase.location.regionCode)) return "excluded:wrong-geography";
  if (rec.condition !== "public" && !rawCase.enabledMembershipProgramIds.includes(rec.condition)) {
    return "excluded:membership-disabled";
  }
  return "eligible";
}

export function packageCount(need, prod) {
  return need.requested.unit === "package"
    ? need.requested.amount
    : Math.ceil(need.requested.amount / prod.packageMeasure.amount);
}

function candidateProducts(rawCase, need) {
  const list = need.mode === "exact"
    ? rawCase.products.filter((p) => p.canonicalProductId === need.productId)
    : rawCase.products.filter((p) => p.productFamily === need.family);
  return list.filter((p) => need.requested.unit === "package" || p.packageMeasure.unit === need.requested.unit);
}

function overCap(rawCase, need, rec) {
  return packageCount(need, productOf(rawCase, rec.productId)) * rec.amountOre > MAX_PERSISTED_MONEY_ORE;
}

export function buildProductionInput(rawCase) {
  return {
    contractVersion: 2,
    needs: rawCase.needs.map((n) => ({ id: n.id, query: n.query, requested: n.requested, matchRuleId: `rule:${n.id}`, required: true })),
    matchingRules: rawCase.needs.map((n) => ({
      id: `rule:${n.id}`,
      mode: n.mode,
      ...(n.mode === "exact" ? { exactEan: productOf(rawCase, n.productId).ean } : { productFamily: n.family }),
      userApproved: true,
      explanation: "Bruk varen brukeren godkjente.",
    })),
    products: rawCase.products.map((p) => ({ ...p })),
    ordinaryPrices: rawCase.prices.map((r) => ({
      ean: productOf(rawCase, r.productId).ean, chain: r.chain, amountOre: r.amountOre, observedAt: r.observedAt, source: r.source,
    })),
    officialOffers: rawCase.offers.map((o) => ({
      contractVersion: 1,
      kind: "official-offer",
      id: o.id,
      sourceId: o.sourceId,
      sourceRecordId: o.sourceRecordId,
      chainId: o.chain,
      productMatch: { kind: "exact", canonicalProductId: o.productId },
      pricing: o.pricing,
      conditions: [
        o.condition === "public" ? { kind: "public" } : { kind: "member", programId: o.condition },
        ...(o.minQuantity > 1 ? [{ kind: "minimum-quantity", quantity: o.minQuantity }] : []),
      ],
      applicability: {
        contractVersion: 1,
        startsAt: o.startsAt,
        endsAt: o.endsAt,
        geographicScope: { kind: "regions", countryCode: "NO", regionCodes: o.regions },
        channels: ["in-store"],
      },
      evidenceLevel: "reviewed",
      capturedAt: o.capturedAt,
    })),
    offerEligibility: {
      maxEvidenceAgeMs: rawCase.maxEvidenceAgeMs,
      location: rawCase.location,
      channel: rawCase.channel,
      enabledSourceIds: rawCase.enabledSourceIds,
      enabledMembershipProgramIds: rawCase.enabledMembershipProgramIds,
    },
    maxStores: 3,
  };
}

// Returns undefined when some need has no admissible option (no complete plan exists).
export function buildOracleSnapshot(rawCase) {
  const needs = rawCase.needs.map((need) => {
    const options = [];
    for (const prod of candidateProducts(rawCase, need)) {
      for (const rec of rawCase.prices.filter((r) => r.productId === prod.canonicalProductId)) {
        if (priceTruth(rawCase, rec) !== "eligible" || overCap(rawCase, need, rec)) continue;
        options.push({
          canonicalProductId: prod.canonicalProductId,
          storeId: rec.chain,
          chainId: rec.chain,
          packageBaseUnits: prod.packageMeasure.amount,
          ordinaryAmountOre: rec.amountOre,
          depositPerPackageOre: 0,
          officialOffers: rawCase.offers
            .filter((o) => o.productId === prod.canonicalProductId && o.chain === rec.chain
              && offerTruth(rawCase, o) === "eligible")
            .map((o) => ({
              priceEvidenceId: o.id,
              membershipRequirement: o.condition === "public" ? "none" : "member",
              ...(o.condition === "public" ? {} : { membershipProgramId: o.condition }),
              validFrom: o.startsAt,
              validUntil: o.endsAt,
              minimumPackages: o.minQuantity,
              bundleSize: o.pricing.kind === "unit" ? 1 : o.pricing.quantity,
              amountOre: o.pricing.kind === "unit" ? o.pricing.unitPriceOre : o.pricing.totalOre,
            })),
          ordinaryPriceEvidenceId: rec.id,
          matchEvidenceId: `match:${need.id}:${prod.canonicalProductId}`,
        });
      }
    }
    return {
      needId: need.id,
      identity: { kind: need.mode === "exact" ? "exact" : "reviewed-family" },
      requested: { unit: need.requested.unit, value: need.requested.amount },
      options,
    };
  });
  if (needs.some(({ options }) => options.length === 0)) return undefined;
  return {
    contractVersion: 2,
    maximumStores: 3,
    enabledMembershipProgramIds: [...rawCase.enabledMembershipProgramIds].sort(),
    evaluatedAt: rawCase.clock,
    stores: [...new Set(rawCase.prices.map((r) => r.chain))].sort().map((storeId) => ({ storeId })),
    needs,
  };
}

export function reverseProductionInput(input) {
  return {
    ...input,
    needs: [...input.needs].reverse(),
    matchingRules: [...input.matchingRules].reverse(),
    products: [...input.products].reverse(),
    ordinaryPrices: [...input.ordinaryPrices].reverse(),
    officialOffers: [...input.officialOffers].reverse(),
  };
}

export function buildWorkloads() {
  const cases = [
    largeCase("dense-13-chains", "50 exact needs, 13 chains, 50 products, dense offers", CHAINS, 50, false),
    sparseCase(),
    largeCase("family-plus-30-exact", "1 flexible family (20 products) + 30 exact needs, 13 chains", CHAINS, 30, true),
    handCase(),
    ...noPlanCases(),
  ];
  return cases.map((c) => ({
    ...c,
    productionInput: buildProductionInput(c.raw),
    oracleSnapshot: c.expectNoPlan === undefined ? buildOracleSnapshot(c.raw) : undefined,
  }));
}
