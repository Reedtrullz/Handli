import { describe, expect, it, vi } from "vitest";

import { strictResultTripFixture } from "../../../test-support/strict-result-trip-fixture";

const mocks = vi.hoisted(() => ({ getServerContainer: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("../container", () => ({ getServerContainer: mocks.getServerContainer }));

import {
  getProductionTravelPlanCoordinator,
} from "./travel-plan-service";
import { VALHALLA_SOURCE_KILL_SWITCH_ENV } from "./travel-runtime-gate";

describe("production travel coordinator cache", () => {
  it("re-evaluates an enabled-to-disabled source switch before returning a cached runtime", async () => {
    const fixture = strictResultTripFixture();
    const exactResult = {
      completeCandidateSet: {
        evidence: fixture.exactResponse.evidence,
        plans: fixture.exactResponse.plans,
      },
      evidence: fixture.exactResponse.evidence,
      generatedAt: fixture.exactResponse.generatedAt,
      planDeltaExplanations: fixture.exactResponse.planDeltaExplanations,
      plans: fixture.exactResponse.plans,
      priceDataSource: "cache" as const,
      products: fixture.exactResponse.products,
    };
    mocks.getServerContainer.mockReturnValue({
      branchDirectory: {},
      planService: {
        calculateExact: async () => exactResult,
        calculateReviewed: vi.fn(),
      },
    });

    const enabled = await getProductionTravelPlanCoordinator({
      [VALHALLA_SOURCE_KILL_SWITCH_ENV]: "true",
    });
    const disabled = await getProductionTravelPlanCoordinator({
      [VALHALLA_SOURCE_KILL_SWITCH_ENV]: "false",
    });

    expect(disabled).not.toBe(enabled);
    await expect(disabled.calculate({
      contractVersion: 1,
      locationSelectionToken: `location-choice:${"c".repeat(43)}`,
      planning: fixture.exactRequest,
      travelMode: "car",
    })).resolves.toMatchObject({
      travel: {
        contractVersion: 1,
        kind: "unavailable",
        reason: "provider-unavailable",
      },
    });
    expect(mocks.getServerContainer).toHaveBeenCalledTimes(2);
  });
});
