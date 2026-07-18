import { registerHandleplanServiceWorker } from "./service-worker-registration";

const READY_REQUEST_KIND = "handleplan:handle-mode-offline-ready:v1";
const READY_RESPONSE_KIND = "handleplan:handle-mode-offline-ready-result:v1";
const DEFAULT_TIMEOUT_MS = 8_000;

export class HandleModeOfflineReadinessError extends Error {
  constructor() {
    super("Handlemodus offline shell is unavailable");
    this.name = "HandleModeOfflineReadinessError";
  }
}
function unavailable(): never {
  throw new HandleModeOfflineReadinessError();
}

function withinTimeout<T>(promise: PromiseLike<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = globalThis.setTimeout(
      () => reject(new HandleModeOfflineReadinessError()),
      timeoutMs,
    );
    Promise.resolve(promise).then(
      (value) => {
        globalThis.clearTimeout(timeout);
        resolve(value);
      },
      () => {
        globalThis.clearTimeout(timeout);
        reject(new HandleModeOfflineReadinessError());
      },
    );
  });
}

function workerMatchesBuild(
  worker: ServiceWorker | null,
  buildId: string,
  origin: string,
): worker is ServiceWorker {
  if (worker === null) return false;
  try {
    const workerUrl = new URL(worker.scriptURL);
    return workerUrl.origin === origin
      && workerUrl.pathname === "/sw.js"
      && workerUrl.hash === ""
      && workerUrl.searchParams.size === 1
      && workerUrl.searchParams.get("build") === buildId;
  } catch {
    return false;
  }
}

function waitForMatchingActiveWorker(
  registration: ServiceWorkerRegistration,
  buildId: string,
  origin: string,
  timeoutMs: number,
): Promise<ServiceWorker> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const finish = (worker?: ServiceWorker) => {
      if (timer !== undefined) globalThis.clearTimeout(timer);
      if (worker === undefined) reject(new HandleModeOfflineReadinessError());
      else resolve(worker);
    };
    const check = () => {
      const active = registration.active;
      const controller = navigator.serviceWorker.controller;
      if (
        workerMatchesBuild(active, buildId, origin)
        && workerMatchesBuild(controller, buildId, origin)
        && active.scriptURL === controller.scriptURL
      ) {
        finish(active);
        return;
      }
      if (Date.now() >= deadline) {
        finish();
        return;
      }
      timer = globalThis.setTimeout(check, 50);
    };
    check();
  });
}

/**
 * Proves that the active same-origin service worker has cached the Handlemodus
 * document, every hashed static asset referenced by that exact document, and
 * the explicitly required CSP bootstrap. No basket, plan, location, or trip
 * data crosses the message boundary.
 */
export async function ensureHandleModeOfflineReady(
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 100
    || timeoutMs > 30_000
    || typeof window === "undefined"
    || !("serviceWorker" in navigator)
    || typeof MessageChannel === "undefined"
  ) unavailable();

  const startedAt = Date.now();
  await withinTimeout(registerHandleplanServiceWorker(), timeoutMs);
  const readyWaitMs = timeoutMs - (Date.now() - startedAt);
  if (readyWaitMs < 1) unavailable();
  const registration = await withinTimeout(navigator.serviceWorker.ready, readyWaitMs);
  const buildId = process.env.NEXT_PUBLIC_HANDLEPLAN_BUILD_ID;
  if (!/^hpv2-[0-9a-f]{64}$/u.test(buildId ?? "")) unavailable();
  const activationWaitMs = timeoutMs - (Date.now() - startedAt);
  if (activationWaitMs < 1) unavailable();
  const worker = await waitForMatchingActiveWorker(
    registration,
    buildId as string,
    window.location.origin,
    activationWaitMs,
  );

  const responseWaitMs = timeoutMs - (Date.now() - startedAt);
  if (responseWaitMs < 1) unavailable();

  const channel = new MessageChannel();
  try {
    const response = withinTimeout(new Promise<unknown>((resolve) => {
      channel.port1.onmessage = (event: MessageEvent<unknown>) => resolve(event.data);
      channel.port1.start();
      worker.postMessage({ buildId, kind: READY_REQUEST_KIND }, [channel.port2]);
    }), responseWaitMs);
    const result = await response;
    if (
      typeof result !== "object"
      || result === null
      || (result as { kind?: unknown }).kind !== READY_RESPONSE_KIND
      || (result as { buildId?: unknown }).buildId !== buildId
      || (result as { ready?: unknown }).ready !== true
    ) unavailable();
  } catch {
    unavailable();
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
}
