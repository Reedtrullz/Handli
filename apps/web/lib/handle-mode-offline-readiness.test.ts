// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ensureHandleModeOfflineReady,
  HandleModeOfflineReadinessError,
} from "./handle-mode-offline-readiness";

class FakePort {
  peer?: FakePort;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  close(): void {}
  start(): void {}
  postMessage(data: unknown): void {
    queueMicrotask(() => this.peer?.onmessage?.({ data }));
  }
}

class FakeMessageChannel {
  readonly port1 = new FakePort();
  readonly port2 = new FakePort();

  constructor() {
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const BUILD_ID = `hpv2-${"a".repeat(64)}`;

function serviceWorkerWithResponse(
  response: unknown,
  workerScriptUrl = `${window.location.origin}/sw.js?build=${BUILD_ID}`,
) {
  vi.stubEnv("NEXT_PUBLIC_HANDLEPLAN_BUILD_ID", BUILD_ID);
  const postMessage = vi.fn((message: unknown, ports: FakePort[]) => {
    expect(message).toEqual({
      buildId: BUILD_ID,
      kind: "handleplan:handle-mode-offline-ready:v1",
    });
    expect(JSON.stringify(message)).not.toMatch(/basket|planning|trip|origin|address|coordinate|gtin/i);
    ports[0]!.postMessage(response);
  });
  const worker = { postMessage, scriptURL: workerScriptUrl };
  const register = vi.fn(async () => ({ active: worker }));
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      controller: worker,
      register,
      ready: Promise.resolve({ active: worker }),
    },
  });
  vi.stubGlobal("MessageChannel", FakeMessageChannel);
  return { postMessage, register };
}

describe("Handlemodus offline readiness", () => {
  it("accepts only the exact positive shell proof from the active worker", async () => {
    const { postMessage, register } = serviceWorkerWithResponse({
      buildId: BUILD_ID,
      kind: "handleplan:handle-mode-offline-ready-result:v1",
      ready: true,
    });

    await expect(ensureHandleModeOfflineReady(1_000)).resolves.toBeUndefined();
    expect(postMessage).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledOnce();
  });

  it.each([
    {
      buildId: BUILD_ID,
      kind: "handleplan:handle-mode-offline-ready-result:v1",
      ready: false,
    },
    { buildId: BUILD_ID, kind: "unexpected", ready: true },
    { kind: "handleplan:handle-mode-offline-ready-result:v1", ready: true },
    {
      buildId: `hpv2-${"b".repeat(64)}`,
      kind: "handleplan:handle-mode-offline-ready-result:v1",
      ready: true,
    },
  ])("fails closed on a non-ready or malformed worker response", async (response) => {
    serviceWorkerWithResponse(response);
    await expect(ensureHandleModeOfflineReady(1_000)).rejects.toBeInstanceOf(
      HandleModeOfflineReadinessError,
    );
  });

  it.each([
    `${window.location.origin}/sw.js`,
    `${window.location.origin}/sw.js?build=${`hpv2-${"b".repeat(64)}`}`,
    `https://other.test/sw.js?build=${BUILD_ID}`,
  ])("fails closed before messaging an old or foreign worker: %s", async (scriptUrl) => {
    const { postMessage } = serviceWorkerWithResponse({
      buildId: BUILD_ID,
      kind: "handleplan:handle-mode-offline-ready-result:v1",
      ready: true,
    }, scriptUrl);

    await expect(ensureHandleModeOfflineReady(100)).rejects.toBeInstanceOf(
      HandleModeOfflineReadinessError,
    );
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("waits within the bound for the newly registered build to activate and claim", async () => {
    vi.stubEnv("NEXT_PUBLIC_HANDLEPLAN_BUILD_ID", BUILD_ID);
    vi.stubGlobal("MessageChannel", FakeMessageChannel);
    const oldPostMessage = vi.fn();
    const oldWorker = {
      postMessage: oldPostMessage,
      scriptURL: `${window.location.origin}/sw.js?build=${`hpv2-${"b".repeat(64)}`}`,
    };
    const newPostMessage = vi.fn((message: unknown, ports: FakePort[]) => {
      expect(message).toEqual({
        buildId: BUILD_ID,
        kind: "handleplan:handle-mode-offline-ready:v1",
      });
      ports[0]!.postMessage({
        buildId: BUILD_ID,
        kind: "handleplan:handle-mode-offline-ready-result:v1",
        ready: true,
      });
    });
    const newWorker = {
      postMessage: newPostMessage,
      scriptURL: `${window.location.origin}/sw.js?build=${BUILD_ID}`,
    };
    const registration: { active: typeof oldWorker | typeof newWorker } = {
      active: oldWorker,
    };
    const serviceWorker = {
      controller: oldWorker as typeof oldWorker | typeof newWorker,
      register: vi.fn(async () => registration),
      ready: Promise.resolve(registration),
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: serviceWorker,
    });
    globalThis.setTimeout(() => {
      registration.active = newWorker;
      serviceWorker.controller = newWorker;
    }, 20);

    await expect(ensureHandleModeOfflineReady(500)).resolves.toBeUndefined();
    expect(oldPostMessage).not.toHaveBeenCalled();
    expect(newPostMessage).toHaveBeenCalledOnce();
  });

  it("fails within the bound when service-worker registration never settles", async () => {
    vi.stubEnv("NEXT_PUBLIC_HANDLEPLAN_BUILD_ID", BUILD_ID);
    vi.stubGlobal("MessageChannel", FakeMessageChannel);
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        controller: null,
        ready: new Promise(() => undefined),
        register: vi.fn(() => new Promise(() => undefined)),
      },
    });

    await expect(ensureHandleModeOfflineReady(100)).rejects.toBeInstanceOf(
      HandleModeOfflineReadinessError,
    );
  });
});
