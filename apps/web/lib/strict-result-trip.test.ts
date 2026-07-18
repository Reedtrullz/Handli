import { describe, expect, it } from "vitest";
import {
  deriveExactProductPlanDeltaExplanationsV1,
  deriveReviewedFamilyPlanDeltaExplanationsV1,
  moneyOreSchema,
  travelPlanApiResponseSchemaFor,
  tripSnapshotV2Schema,
} from "@handleplan/domain";

import {
  reviewedStrictResultTripFixture,
  strictResultTripFixture,
} from "../test-support/strict-result-trip-fixture";
import {
  createLocalTripId,
  createStrictResultTripSnapshot,
  StrictResultTripError,
} from "./strict-result-trip";

function create(
  fixture = strictResultTripFixture(),
  now = new Date("2026-07-16T13:00:00.000Z"),
) {
  return createStrictResultTripSnapshot({
    ...fixture,
    now,
    tripId: "trip:strict-result-test",
  });
}

function expectCode(code: StrictResultTripError["code"]) {
  return expect.objectContaining({ code, name: "StrictResultTripError" });
}

function routeFor(fixture: ReturnType<typeof strictResultTripFixture>) {
  return {
    aggregate: {
      calculatedAt: fixture.exactResponse.generatedAt,
      distanceMeters: 4_200,
      durationSeconds: 720,
      mode: "bike" as const,
      providerSourceId: "valhalla-openstreetmap-self-hosted",
      routeFingerprint: "route:strict-result-test",
    },
    planId: fixture.plan.id,
    stops: fixture.plan.chains.map((chainId, index) => ({
      branchId: `branch:${chainId}:strict-result-test`,
      chainId,
      name: `${chainId} testbutikk`,
      sequence: index + 1,
    })),
  };
}

function exactTravelBinding(
  fixture: ReturnType<typeof strictResultTripFixture>,
  route = routeFor(fixture),
) {
  const planDeltaExplanations = deriveExactProductPlanDeltaExplanationsV1({
    evidence: fixture.exactResponse.evidence,
    generatedAt: fixture.exactResponse.generatedAt,
    marketContext: fixture.exactResponse.marketContext,
    plans: fixture.exactResponse.plans,
    travelRoutes: [route],
  });
  if (planDeltaExplanations === undefined) throw new Error("invalid route fixture");
  const planning = { ...fixture.exactResponse, planDeltaExplanations };
  return {
    exactResponse: planning,
    travelBinding: {
      request: {
        contractVersion: 1 as const,
        locationSelectionToken: `location-choice:${"A".repeat(43)}`,
        planning: fixture.exactRequest,
        travelMode: route.aggregate.mode,
      },
      response: {
        contractVersion: 1 as const,
        planning,
        travel: { contractVersion: 1 as const, kind: "calculated" as const, routes: [route] },
      },
    },
  };
}

function reviewedRouteFor(fixture: ReturnType<typeof reviewedStrictResultTripFixture>) {
  return {
    aggregate: {
      calculatedAt: fixture.reviewedResponse.generatedAt,
      distanceMeters: 3_100,
      durationSeconds: 600,
      mode: "bike" as const,
      providerSourceId: "valhalla-openstreetmap-self-hosted",
      routeFingerprint: "route:reviewed-result-test",
    },
    planId: fixture.plan.id,
    stops: fixture.plan.chains.map((chainId, index) => ({
      branchId: `branch:${chainId}:reviewed-result-test`,
      chainId,
      name: `${chainId} testbutikk`,
      sequence: index + 1,
    })),
  };
}

function reviewedTravelBinding(
  fixture: ReturnType<typeof reviewedStrictResultTripFixture>,
  route = reviewedRouteFor(fixture),
) {
  const planDeltaExplanations = deriveReviewedFamilyPlanDeltaExplanationsV1({
    evidence: fixture.reviewedResponse.evidence,
    generatedAt: fixture.reviewedResponse.generatedAt,
    marketContext: fixture.reviewedResponse.marketContext,
    plans: fixture.reviewedResponse.plans,
    travelRoutes: [route],
  });
  if (planDeltaExplanations === undefined) throw new Error("invalid reviewed route fixture");
  const planning = { ...fixture.reviewedResponse, planDeltaExplanations };
  return {
    reviewedResponse: planning,
    travelBinding: {
      request: {
        contractVersion: 1 as const,
        locationSelectionToken: `location-choice:${"B".repeat(43)}`,
        planning: fixture.reviewedRequest,
        travelMode: route.aggregate.mode,
      },
      response: {
        contractVersion: 1 as const,
        planning,
        travel: { contractVersion: 1 as const, kind: "calculated" as const, routes: [route] },
      },
    },
  };
}

describe("strict result trip derivation", () => {
  it("uses only selected canonical data and the earliest ordinary/catalog validity", () => {
    const snapshot = create();

    expect(snapshot).toMatchObject({
      checklistItems: [{
        purchase: {
          checkoutTotalOre: 2_490,
          freshness: "eligible",
          observedAt: "2026-07-16T11:00:00.000Z",
          ordinaryPrice: { id: "price:extra:milk" },
          ordinaryTotalOre: 2_490,
          packageCount: 1,
          purchased: { amount: 1, unit: "package" },
          requested: { amount: 1, unit: "package" },
          savedOre: 0,
          surplus: { amount: 0, unit: "package" },
        },
      }],
      contractVersion: 2,
      createdAt: "2026-07-16T13:00:00.000Z",
      evaluatedAt: "2026-07-16T12:00:00.000Z",
      expiresAt: "2026-07-18T10:00:00.000Z",
      id: "trip:strict-result-test",
      navigation: { kind: "price-only", stops: [{ chainId: "extra" }] },
      plan: { id: "plan:strict-result-fixture" },
      products: [{ displayName: "TINE Lettmelk 1 l" }],
    });
    expect(JSON.stringify(snapshot)).not.toMatch(
      /origin|address|latitude|longitude|coordinates|local query|matchingRules|travel/i,
    );
  });

  it("caps an offer trip at the applied offer end and honors an earlier ordinary validUntil", () => {
    const offerSnapshot = create(strictResultTripFixture({ offer: true }));
    expect(offerSnapshot.expiresAt).toBe("2026-07-17T12:00:00.000Z");
    expect(offerSnapshot.checklistItems[0]!.purchase).toMatchObject({
      appliedOffer: {
        applicability: {
          channels: ["in-store"],
          endsAt: "2026-07-17T12:00:00.000Z",
        },
        beforePriceOre: 2_490,
        conditions: [{ kind: "public" }],
        id: "offer:milk",
        pricing: { kind: "unit", unitPriceOre: 1_990 },
        sourceRecordId: "source-record:offer:milk",
      },
      checkoutTotalOre: 1_990,
      ordinaryTotalOre: 2_490,
      savedOre: 500,
    });
    expect(create(strictResultTripFixture({
      offer: true,
      ordinaryValidUntil: "2026-07-17T09:00:00.000Z",
    })).expiresAt).toBe("2026-07-17T09:00:00.000Z");
  });

  it("caps an offer trip at the offer evidence-age ceiling", () => {
    expect(create(strictResultTripFixture({
      offer: true,
      offerCapturedAt: "2026-07-03T13:00:00.000Z",
      offerEndsAt: "2026-07-20T12:00:00.000Z",
    })).expiresAt).toBe("2026-07-17T13:00:00.000Z");
  });

  it("persists and revalidates bounded postal-directory proof for an offline trip", () => {
    const generatedAt = "2026-07-16T12:00:00.000Z";
    const marketContext = {
      contractVersion: 1 as const,
      countryCode: "NO" as const,
      kind: "launch-region" as const,
      regionId: "no-0301-oslo",
    };
    const geographicDirectoryAttestation = {
      contractVersion: 1 as const,
      countryCode: "NO",
      directoryVersionId: "postal-directory-2026-07",
      evaluatedAt: generatedAt,
      evidenceReference: "manifest:postal-directory-2026-07",
      publishedAt: "2026-07-16T10:00:00.000Z",
      region: {
        coverageState: "complete" as const,
        evidenceReference: "manifest:oslo-postal-set",
        postalCodes: ["0152", "0452"],
        regionCode: marketContext.regionId,
      },
      reviewedAt: "2026-07-16T09:00:00.000Z",
      status: "approved" as const,
      validFrom: "2026-07-16T00:00:00.000Z",
      validUntil: "2026-07-17T08:00:00.000Z",
    };
    const fixture = strictResultTripFixture({
      generatedAt,
      geographicDirectoryAttestation,
      geographicScope: {
        countryCode: "NO",
        kind: "postal-set",
        postalCodes: ["0152", "0452"],
      },
      marketContext,
    });
    const snapshot = create(fixture);

    expect(snapshot.geographicDirectoryAttestation).toEqual(
      geographicDirectoryAttestation,
    );
    expect(snapshot.expiresAt).toBe(geographicDirectoryAttestation.validUntil);
    const { geographicDirectoryAttestation: _missing, ...withoutAttestation } = snapshot;
    expect(_missing).toBeDefined();
    expect(tripSnapshotV2Schema.safeParse(withoutAttestation).success).toBe(false);
    expect(tripSnapshotV2Schema.safeParse({
      ...snapshot,
      geographicDirectoryAttestation: {
        ...geographicDirectoryAttestation,
        region: {
          ...geographicDirectoryAttestation.region,
          regionCode: "no-4601-bergen",
        },
      },
    }).success).toBe(false);
  });

  it("copies only verified public route aggregates and branch stops into the immutable trip", () => {
    const fixture = strictResultTripFixture();
    const travelRoute = routeFor(fixture);
    const routed = exactTravelBinding(fixture, travelRoute);
    const snapshot = createStrictResultTripSnapshot({
      ...fixture,
      ...routed,
      now: new Date("2026-07-16T13:00:00.000Z"),
      tripId: "trip:routed-result-test",
    });

    expect(snapshot.navigation).toEqual({
      aggregate: {
        calculatedAt: fixture.exactResponse.generatedAt,
        distanceMeters: 4_200,
        durationSeconds: 720,
        mode: "bike",
        sourceId: "valhalla-openstreetmap-self-hosted",
        sourceRecordId: "route:strict-result-test",
      },
      kind: "route",
      stops: [{
        branchId: "branch:extra:strict-result-test",
        chainId: "extra",
        kind: "branch-stop",
        name: "extra testbutikk",
        sequence: 1,
      }],
    });
    expect(JSON.stringify(snapshot)).not.toMatch(
      /origin|address|latitude|longitude|coordinates|geometry/i,
    );
  });

  it("rejects stale, cross-plan, or wrong-chain route evidence inside the bound envelope", () => {
    const fixture = strictResultTripFixture();
    const route = routeFor(fixture);
    const routed = exactTravelBinding(fixture, route);
    const input = {
      ...fixture,
      exactResponse: routed.exactResponse,
      now: new Date("2026-07-16T13:00:00.000Z"),
      tripId: "trip:invalid-route-test",
    };

    for (const travelRoute of [
      { ...route, planId: "plan:other" },
      { ...route, aggregate: { ...route.aggregate, calculatedAt: "2026-07-16T11:59:59.000Z" } },
      { ...route, stops: [{ ...route.stops[0]!, chainId: "bunnpris" as const }] },
    ]) {
      expect(() => createStrictResultTripSnapshot({
        ...input,
        travelBinding: {
          ...routed.travelBinding,
          response: {
            ...routed.travelBinding.response,
            travel: { contractVersion: 1, kind: "calculated", routes: [travelRoute] },
          },
        },
      }))
        .toThrow(expectCode("INVALID_EVIDENCE"));
    }
  });

  it("keeps createdAt canonical and not before evaluatedAt when the client clock is behind", () => {
    const snapshot = create(
      strictResultTripFixture(),
      new Date("2026-07-16T10:00:00.000Z"),
    );
    expect(snapshot.createdAt).toBe("2026-07-16T12:00:00.000Z");
    expect(Date.parse(snapshot.createdAt)).toBeGreaterThanOrEqual(Date.parse(snapshot.evaluatedAt));
  });

  it("fails closed on missing selected evidence and evidence that is already expired", () => {
    const fixture = strictResultTripFixture();
    expect(() => create({
      ...fixture,
      exactResponse: {
        ...fixture.exactResponse,
        evidence: { ...fixture.exactResponse.evidence, assignmentEvidence: [] },
      },
    }))
      .toThrow(expectCode("INVALID_EVIDENCE"));

    expect(() => create(
      strictResultTripFixture({ catalogObservedAt: "2026-07-14T12:00:00.000Z" }),
      new Date("2026-07-16T12:00:00.000Z"),
    )).toThrow(expectCode("EXPIRED_EVIDENCE"));
    expect(() => create(
      strictResultTripFixture(),
      new Date("2026-07-20T12:00:00.000Z"),
    )).toThrow(expectCode("EXPIRED_EVIDENCE"));
  });

  it("rejects independently relabeling either side of the exact market binding", () => {
    const fixture = strictResultTripFixture();
    const oslo = {
      contractVersion: 1 as const,
      countryCode: "NO" as const,
      kind: "launch-region" as const,
      regionId: "no-0301-oslo",
    };

    expect(() => create({
      ...fixture,
      exactRequest: { ...fixture.exactRequest, marketContext: oslo },
    })).toThrow(expectCode("INVALID_EVIDENCE"));
    expect(() => create({
      ...fixture,
      exactResponse: { ...fixture.exactResponse, marketContext: oslo },
    })).toThrow(expectCode("INVALID_EVIDENCE"));
  });

  it("rejects member-only or online-only offers from a price-only shopping trip", () => {
    const fixture = strictResultTripFixture({ offer: true });
    const selectedOffer = fixture.exactResponse.evidence.needs[0]!.officialOffers[0]!;
    const withOffer = (offer: typeof selectedOffer) => ({
      ...fixture,
      exactResponse: {
        ...fixture.exactResponse,
        evidence: {
          ...fixture.exactResponse.evidence,
          needs: [{
            ...fixture.exactResponse.evidence.needs[0]!,
            officialOffers: [offer],
          }],
        },
      },
    });

    expect(() => create(withOffer({
      ...selectedOffer,
      conditions: [{ kind: "member", programId: "fixture-membership" }],
    }))).toThrow(expectCode("INVALID_EVIDENCE"));
    expect(() => create(withOffer({
      ...selectedOffer,
      applicability: { ...selectedOffer.applicability, channels: ["online"] },
    }))).toThrow(expectCode("INVALID_EVIDENCE"));
    expect(() => create(withOffer({
      ...selectedOffer,
      pricing: { kind: "unit", unitPriceOre: moneyOreSchema.parse(1_890) },
    }))).toThrow(expectCode("INVALID_EVIDENCE"));
  });

  it("carries an explicitly enabled member offer into the immutable trip snapshot", () => {
    const fixture = strictResultTripFixture({
      enabledMembershipProgramIds: ["fixture-membership"],
      membershipProgramId: "fixture-membership",
      offer: true,
    });

    const snapshot = create(fixture);
    expect(snapshot.enabledMembershipProgramIds).toEqual(["fixture-membership"]);
    expect(snapshot.plan.assignments[0]).toMatchObject({
      checkout: { appliedOfferId: "offer:milk", savingOre: 500, totalOre: 1_990 },
      officialOffer: { id: "offer:milk" },
    });
  });

  it("creates fresh opaque local identifiers", () => {
    const first = createLocalTripId();
    const second = createLocalTripId();
    expect(first).toMatch(/^trip:[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
  });

  it("projects a validated mixed exact and reviewed-family result into public-only offline evidence", () => {
    const fixture = reviewedStrictResultTripFixture();
    const snapshot = createStrictResultTripSnapshot({
      ...fixture,
      now: new Date("2026-07-16T13:00:00.000Z"),
      tripId: "trip:reviewed-result-test",
    });

    expect(snapshot).toMatchObject({
      checklistItems: [
        { canonicalProductId: "product:coffee", needId: "need:coffee" },
        { canonicalProductId: "product:milk", needId: "need:milk" },
      ],
      contractVersion: 2,
      reviewedFamilyEvidence: {
        assignmentEvidence: [
          { evidenceId: "price:coffee", needId: "need:coffee" },
          { evidenceId: "price:milk", needId: "need:milk" },
        ],
        memberships: [{
          canonicalProductId: "product:milk",
          familyId: "family:melk",
          reviewerAttested: true,
        }],
        needMatches: [
          { kind: "exact-product", needId: "need:coffee" },
          {
            candidateSetId: expect.stringMatching(/^candidate-set:/),
            kind: "reviewed-family",
            needId: "need:milk",
          },
        ],
        productClaims: [
          { canonicalProductId: "product:coffee" },
          { canonicalProductId: "product:milk" },
        ],
        request: { contractVersion: 2, maxStores: 3 },
        taxonomy: { versionId: "handleplan-reviewed-families@1.0.0" },
      },
    });
    expect(snapshot.reviewedFamilyEvidence?.productClaims).toHaveLength(2);
    expect(snapshot.reviewedFamilyEvidence?.memberships).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toMatch(
      /reviewerId|reviewerName|private|capture|query|browser|origin|address|latitude|longitude|coordinate/i,
    );
  });

  it("accepts a request-bound travel-aware reviewed response and persists only its public route", () => {
    const fixture = reviewedStrictResultTripFixture();
    const routed = reviewedTravelBinding(fixture);

    const snapshot = createStrictResultTripSnapshot({
      ...fixture,
      ...routed,
      now: new Date("2026-07-16T13:00:00.000Z"),
      tripId: "trip:reviewed-route-test",
    });

    expect(snapshot.navigation).toMatchObject({
      aggregate: { mode: "bike", sourceId: "valhalla-openstreetmap-self-hosted" },
      kind: "route",
      stops: [{ branchId: "branch:extra:reviewed-result-test" }],
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/origin|address|latitude|longitude|geometry/i);
  });

  it("rejects exact travel bindings detached from the primary market or response", () => {
    const fixture = strictResultTripFixture();
    const routed = exactTravelBinding(fixture);
    const common = {
      ...fixture,
      exactResponse: routed.exactResponse,
      now: new Date("2026-07-16T13:00:00.000Z"),
      tripId: "trip:exact-detached-travel-test",
    };
    const oslo = {
      contractVersion: 1 as const,
      countryCode: "NO" as const,
      kind: "launch-region" as const,
      regionId: "no-0301-oslo",
    };

    const detachedMarketExplanations = deriveExactProductPlanDeltaExplanationsV1({
      evidence: routed.exactResponse.evidence,
      generatedAt: routed.exactResponse.generatedAt,
      marketContext: oslo,
      plans: routed.exactResponse.plans,
      travelRoutes: routed.travelBinding.response.travel.kind === "calculated"
        ? routed.travelBinding.response.travel.routes
        : [],
    });
    if (detachedMarketExplanations === undefined) throw new Error("invalid market fixture");
    const detachedMarketBinding = {
      request: {
        ...routed.travelBinding.request,
        planning: { ...fixture.exactRequest, marketContext: oslo },
      },
      response: {
        ...routed.travelBinding.response,
        planning: {
          ...routed.exactResponse,
          marketContext: oslo,
          planDeltaExplanations: detachedMarketExplanations,
        },
      },
    };
    expect(travelPlanApiResponseSchemaFor(detachedMarketBinding.request)
      .safeParse(detachedMarketBinding.response).success).toBe(true);

    expect(() => createStrictResultTripSnapshot({
      ...common,
      travelBinding: detachedMarketBinding,
    })).toThrow(expectCode("INVALID_EVIDENCE"));
    const detachedResponseBinding = {
      ...routed.travelBinding,
      response: {
        ...routed.travelBinding.response,
        planning: {
          ...routed.exactResponse,
          caveats: [...routed.exactResponse.caveats, "Detached response fixture."],
        },
      },
    };
    expect(travelPlanApiResponseSchemaFor(detachedResponseBinding.request)
      .safeParse(detachedResponseBinding.response).success).toBe(true);
    expect(() => createStrictResultTripSnapshot({
      ...common,
      travelBinding: detachedResponseBinding,
    })).toThrow(expectCode("INVALID_EVIDENCE"));
  });

  it("rejects reviewed travel bindings detached from the primary market or response", () => {
    const fixture = reviewedStrictResultTripFixture();
    const routed = reviewedTravelBinding(fixture);
    const common = {
      ...fixture,
      reviewedResponse: routed.reviewedResponse,
      now: new Date("2026-07-16T13:00:00.000Z"),
      tripId: "trip:reviewed-detached-travel-test",
    };
    const oslo = {
      contractVersion: 1 as const,
      countryCode: "NO" as const,
      kind: "launch-region" as const,
      regionId: "no-0301-oslo",
    };

    const detachedMarketExplanations = deriveReviewedFamilyPlanDeltaExplanationsV1({
      evidence: routed.reviewedResponse.evidence,
      generatedAt: routed.reviewedResponse.generatedAt,
      marketContext: oslo,
      plans: routed.reviewedResponse.plans,
      travelRoutes: routed.travelBinding.response.travel.kind === "calculated"
        ? routed.travelBinding.response.travel.routes
        : [],
    });
    if (detachedMarketExplanations === undefined) throw new Error("invalid reviewed market fixture");
    const detachedMarketBinding = {
      request: {
        ...routed.travelBinding.request,
        planning: { ...fixture.reviewedRequest, marketContext: oslo },
      },
      response: {
        ...routed.travelBinding.response,
        planning: {
          ...routed.reviewedResponse,
          marketContext: oslo,
          planDeltaExplanations: detachedMarketExplanations,
        },
      },
    };
    expect(travelPlanApiResponseSchemaFor(detachedMarketBinding.request)
      .safeParse(detachedMarketBinding.response).success).toBe(true);

    expect(() => createStrictResultTripSnapshot({
      ...common,
      travelBinding: detachedMarketBinding,
    })).toThrow(expectCode("INVALID_EVIDENCE"));
    const detachedResponseBinding = {
      ...routed.travelBinding,
      response: {
        ...routed.travelBinding.response,
        planning: {
          ...routed.reviewedResponse,
          caveats: [...routed.reviewedResponse.caveats, "Detached response fixture."],
        },
      },
    };
    expect(travelPlanApiResponseSchemaFor(detachedResponseBinding.request)
      .safeParse(detachedResponseBinding.response).success).toBe(true);
    expect(() => createStrictResultTripSnapshot({
      ...common,
      travelBinding: detachedResponseBinding,
    })).toThrow(expectCode("INVALID_EVIDENCE"));
  });

  it("rejects a mixed trip when the selected plan or confirmed family evidence is altered", () => {
    const fixture = reviewedStrictResultTripFixture();
    const common = {
      ...fixture,
      now: new Date("2026-07-16T13:00:00.000Z"),
      tripId: "trip:reviewed-invalid-test",
    };
    expect(() => createStrictResultTripSnapshot({
      ...common,
      plan: { ...fixture.plan, id: "plan-v2:altered" },
    })).toThrow(expectCode("INVALID_EVIDENCE"));
    expect(() => createStrictResultTripSnapshot({
      ...common,
      reviewedRequest: {
        ...fixture.reviewedRequest,
        needs: fixture.reviewedRequest.needs.map((need) =>
          need.match.kind === "reviewed-family"
            ? {
                ...need,
                match: {
                  ...need.match,
                  confirmation: {
                    ...need.match.confirmation,
                    candidateSetId: `candidate-set:${"d".repeat(64)}`,
                  },
                },
              }
            : need),
      },
    })).toThrow(expectCode("INVALID_EVIDENCE"));
    expect(() => createStrictResultTripSnapshot({
      ...common,
      reviewedResponse: {
        ...fixture.reviewedResponse,
        evidence: {
          ...fixture.reviewedResponse.evidence,
          memberships: [],
        },
      },
    })).toThrow(expectCode("INVALID_EVIDENCE"));
  });

  it("rejects independently relabeling either side of the reviewed market binding", () => {
    const fixture = reviewedStrictResultTripFixture();
    const common = {
      ...fixture,
      now: new Date("2026-07-16T13:00:00.000Z"),
      tripId: "trip:reviewed-market-binding-test",
    };
    const oslo = {
      contractVersion: 1 as const,
      countryCode: "NO" as const,
      kind: "launch-region" as const,
      regionId: "no-0301-oslo",
    };

    expect(() => createStrictResultTripSnapshot({
      ...common,
      reviewedRequest: { ...fixture.reviewedRequest, marketContext: oslo },
    })).toThrow(expectCode("INVALID_EVIDENCE"));
    expect(() => createStrictResultTripSnapshot({
      ...common,
      reviewedResponse: { ...fixture.reviewedResponse, marketContext: oslo },
    })).toThrow(expectCode("INVALID_EVIDENCE"));
  });
});
