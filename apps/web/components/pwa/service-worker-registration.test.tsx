// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  registerHandleplanServiceWorker,
  ServiceWorkerRegistration,
} from "./service-worker-registration";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("service worker registration", () => {
  it("registers only the same-origin source-bound worker with a root scope", async () => {
    const buildId = `hpv2-${"a".repeat(64)}`;
    vi.stubEnv("NEXT_PUBLIC_HANDLEPLAN_BUILD_ID", buildId);
    const register = vi.fn(async () => ({}));
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register },
    });

    render(<ServiceWorkerRegistration />);
    await waitFor(() => expect(register).toHaveBeenCalledWith(`/sw.js?build=${buildId}`, {
      scope: "/",
      updateViaCache: "none",
    }));
  });

  it("fails quietly when registration is unavailable or rejected", async () => {
    vi.stubEnv("NEXT_PUBLIC_HANDLEPLAN_BUILD_ID", `hpv2-${"b".repeat(64)}`);
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register: vi.fn(async () => { throw new Error("private provider detail"); }) },
    });
    await expect(registerHandleplanServiceWorker()).resolves.toBeUndefined();
  });

  it("refuses an unbound or malformed public build identity", async () => {
    const register = vi.fn(async () => ({}));
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register },
    });
    vi.stubEnv("NEXT_PUBLIC_HANDLEPLAN_BUILD_ID", "development");

    await expect(registerHandleplanServiceWorker()).resolves.toBeUndefined();
    expect(register).not.toHaveBeenCalled();
  });
});
