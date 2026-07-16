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
  it("registers only the same-origin static worker with a root scope", async () => {
    const register = vi.fn(async () => ({}));
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register },
    });

    render(<ServiceWorkerRegistration />);
    await waitFor(() => expect(register).toHaveBeenCalledWith("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    }));
  });

  it("fails quietly when registration is unavailable or rejected", async () => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register: vi.fn(async () => { throw new Error("private provider detail"); }) },
    });
    await expect(registerHandleplanServiceWorker()).resolves.toBeUndefined();
  });
});
