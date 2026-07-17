import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createCryptographicRouteFingerprint } from "./travel-plan-service";
import {
  isValhallaTravelRuntimeEnabled,
  VALHALLA_SOURCE_KILL_SWITCH_ENV,
} from "./travel-runtime-gate";

describe("travel runtime gate", () => {
  it("is default-off and accepts only the explicit server-owned true value", () => {
    expect(isValhallaTravelRuntimeEnabled({})).toBe(false);
    for (const value of ["false", "TRUE", "1", "yes", " true "]) {
      expect(isValhallaTravelRuntimeEnabled({
        [VALHALLA_SOURCE_KILL_SWITCH_ENV]: value,
      })).toBe(false);
    }
    expect(isValhallaTravelRuntimeEnabled({
      [VALHALLA_SOURCE_KILL_SWITCH_ENV]: "true",
    })).toBe(true);
  });

  it("uses fresh cryptographic randomness for opaque route fingerprints", () => {
    const fingerprints = Array.from(
      { length: 128 },
      () => createCryptographicRouteFingerprint(),
    );

    expect(new Set(fingerprints)).toHaveLength(fingerprints.length);
    expect(fingerprints.every((value) => /^route:[A-Za-z0-9_-]{43}$/u.test(value)))
      .toBe(true);
  });
});
