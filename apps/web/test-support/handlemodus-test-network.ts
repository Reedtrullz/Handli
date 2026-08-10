import type { APIRequestContext, APIResponse, Page } from "@playwright/test";

const CONTROL_BASE_URL = "http://127.0.0.1:3117";
const CONTROL_HEADERS = { "x-handleplan-test-control": "v1" } as const;

export type HandlemodusTestFixturePath =
  | "/api/locations/search"
  | "/api/plans"
  | "/api/plans/travel";

export interface HandlemodusTestFixture {
  body: string;
  path: HandlemodusTestFixturePath;
  status?: number;
}

async function expectNoContent(response: APIResponse, operation: string): Promise<void> {
  const status = response.status();
  const detail = status === 204 ? "" : await response.text();
  await response.dispose();
  if (status !== 204) {
    throw new Error(`${operation} failed with ${status}${detail === "" ? "" : `: ${detail}`}`);
  }
}

/**
 * Restores the loopback harness to an online, fixture-free state. The harness
 * intentionally keeps mutable fixture state only because this Playwright
 * project is single-worker and resets around every test.
 */
export async function resetHandlemodusTestHarness(
  request: APIRequestContext,
): Promise<void> {
  await expectNoContent(
    await request.post(`${CONTROL_BASE_URL}/reset`, { headers: CONTROL_HEADERS }),
    "Handlemodus test harness reset",
  );
}

export async function installHandlemodusTestFixtures(
  request: APIRequestContext,
  fixtures: readonly HandlemodusTestFixture[],
): Promise<void> {
  await expectNoContent(
    await request.post(`${CONTROL_BASE_URL}/fixtures`, {
      data: { fixtures },
      headers: CONTROL_HEADERS,
    }),
    "Handlemodus test fixture installation",
  );
}

export async function readHandlemodusTestRequestBodies(
  request: APIRequestContext,
  path: HandlemodusTestFixturePath,
): Promise<string[]> {
  const response = await request.get(
    `${CONTROL_BASE_URL}/requests?path=${encodeURIComponent(path)}`,
    { headers: CONTROL_HEADERS },
  );
  const status = response.status();
  const value: unknown = await response.json().catch(() => undefined);
  await response.dispose();
  if (
    status !== 200
    || typeof value !== "object"
    || value === null
    || !("bodies" in value)
    || !("path" in value)
    || value.path !== path
    || !Array.isArray(value.bodies)
    || !value.bodies.every((body) => typeof body === "string")
  ) {
    throw new Error(`Handlemodus test request capture failed with ${status}`);
  }
  return value.bodies;
}

/**
 * Proves from the browser that a unique, uncached, service-worker-bypassed
 * request cannot reach the application origin. A timeout is a harness failure,
 * not outage evidence: the proxy must reject promptly by destroying its
 * application socket.
 */
export async function assertHandlemodusTestApplicationOriginUnavailable(
  page: Page,
): Promise<void> {
  const outcome = await page.evaluate(async () => {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 5_000);
    try {
      const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const response = await fetch(`/api/health?handlemodus-outage-proof=${nonce}`, {
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
      });
      return { kind: "resolved" as const, status: response.status };
    } catch {
      return { kind: timedOut ? "timed-out" as const : "rejected" as const };
    } finally {
      clearTimeout(timeout);
    }
  });
  if (outcome.kind !== "rejected") {
    throw new Error(`Handlemodus application origin did not reject promptly: ${JSON.stringify(outcome)}`);
  }
}

/**
 * Drops every application-origin request at the test-only TLS proxy. Its
 * loopback-only control server is outside the application origin, so a
 * successful Handlemodus navigation has to come from the service worker cache
 * without relying on a browser engine's incompatible offline-emulation UI.
 */
export async function setHandlemodusTestNetworkOffline(
  request: APIRequestContext,
  offline: boolean,
): Promise<void> {
  await expectNoContent(
    await request.post(
      `${CONTROL_BASE_URL}/network?offline=${offline ? "1" : "0"}`,
      { headers: CONTROL_HEADERS },
    ),
    "Handlemodus test network control",
  );
}

/** Returns a normal upstream 503 while leaving the application socket alive. */
export async function setHandlemodusTestNetworkUnavailable(
  request: APIRequestContext,
  unavailable: boolean,
): Promise<void> {
  await expectNoContent(
    await request.post(
      `${CONTROL_BASE_URL}/unavailable?enabled=${unavailable ? "1" : "0"}`,
      { headers: CONTROL_HEADERS },
    ),
    "Handlemodus test upstream-unavailable control",
  );
}
