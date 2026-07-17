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
  vi.unstubAllGlobals();
});

function serviceWorkerWithResponse(response: unknown) {
  const postMessage = vi.fn((message: unknown, ports: FakePort[]) => {
    expect(message).toEqual({ kind: "handleplan:handle-mode-offline-ready:v1" });
    expect(JSON.stringify(message)).not.toMatch(/basket|planning|trip|origin|address|coordinate|gtin/i);
    ports[0]!.postMessage(response);
  });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      ready: Promise.resolve({ active: { postMessage } }),
    },
  });
  vi.stubGlobal("MessageChannel", FakeMessageChannel);
  return postMessage;
}

describe("Handlemodus offline readiness", () => {
  it("accepts only the exact positive shell proof from the active worker", async () => {
    const postMessage = serviceWorkerWithResponse({
      kind: "handleplan:handle-mode-offline-ready-result:v1",
      ready: true,
    });

    await expect(ensureHandleModeOfflineReady(1_000)).resolves.toBeUndefined();
    expect(postMessage).toHaveBeenCalledOnce();
  });

  it.each([
    { kind: "handleplan:handle-mode-offline-ready-result:v1", ready: false },
    { kind: "unexpected", ready: true },
    { ready: true },
  ])("fails closed on a non-ready or malformed worker response", async (response) => {
    serviceWorkerWithResponse(response);
    await expect(ensureHandleModeOfflineReady(1_000)).rejects.toBeInstanceOf(
      HandleModeOfflineReadinessError,
    );
  });
});
