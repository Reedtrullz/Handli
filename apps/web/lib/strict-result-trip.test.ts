import { describe, expect, it } from "vitest";

import { strictResultTripFixture } from "../test-support/strict-result-trip-fixture";
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

describe("strict result trip derivation", () => {
  it("uses only selected canonical data and the earliest ordinary/catalog validity", () => {
    const snapshot = create();

    expect(snapshot).toMatchObject({
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
    expect(create(strictResultTripFixture({ offer: true })).expiresAt)
      .toBe("2026-07-17T12:00:00.000Z");
    expect(create(strictResultTripFixture({
      offer: true,
      ordinaryValidUntil: "2026-07-17T09:00:00.000Z",
    })).expiresAt).toBe("2026-07-17T09:00:00.000Z");
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
    expect(() => create({ ...fixture, evidence: { ...fixture.evidence, assignmentEvidence: [] } }))
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

  it("rejects member-only or online-only offers from a price-only shopping trip", () => {
    const fixture = strictResultTripFixture({ offer: true });
    const selectedOffer = fixture.evidence.needs[0]!.officialOffers[0]!;
    const withOffer = (offer: typeof selectedOffer) => ({
      ...fixture,
      evidence: {
        ...fixture.evidence,
        needs: [{
          ...fixture.evidence.needs[0]!,
          officialOffers: [offer],
        }],
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
  });

  it("creates fresh opaque local identifiers", () => {
    const first = createLocalTripId();
    const second = createLocalTripId();
    expect(first).toMatch(/^trip:[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
  });
});
