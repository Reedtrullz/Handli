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

/**
 * Proves that the active same-origin service worker has cached the Handlemodus
 * document and every hashed static asset referenced by that exact document.
 * No basket, plan, location, or trip data crosses the message boundary.
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

  const registration = await withinTimeout(navigator.serviceWorker.ready, timeoutMs);
  const worker = registration.active;
  if (worker === null) unavailable();

  const channel = new MessageChannel();
  try {
    const response = withinTimeout(new Promise<unknown>((resolve) => {
      channel.port1.onmessage = (event: MessageEvent<unknown>) => resolve(event.data);
      channel.port1.start();
      worker.postMessage({ kind: READY_REQUEST_KIND }, [channel.port2]);
    }), timeoutMs);
    const result = await response;
    if (
      typeof result !== "object"
      || result === null
      || (result as { kind?: unknown }).kind !== READY_RESPONSE_KIND
      || (result as { ready?: unknown }).ready !== true
    ) unavailable();
  } catch {
    unavailable();
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
}
