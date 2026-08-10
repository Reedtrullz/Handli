export async function registerHandleplanServiceWorker(): Promise<
  ServiceWorkerRegistration | undefined
> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return undefined;
  const buildId = process.env.NEXT_PUBLIC_HANDLEPLAN_BUILD_ID;
  if (!/^hpv2-[0-9a-f]{64}$/u.test(buildId ?? "")) return undefined;
  const serviceWorkerUrl = new URL("/sw.js", window.location.origin);
  if (serviceWorkerUrl.origin !== window.location.origin) return undefined;
  serviceWorkerUrl.searchParams.set("build", buildId as string);
  try {
    return await navigator.serviceWorker.register(
      `${serviceWorkerUrl.pathname}${serviceWorkerUrl.search}`,
      {
        scope: "/",
        updateViaCache: "none",
      },
    );
  } catch {
    // Handlemodus stays online-only until a bounded retry succeeds.
    return undefined;
  }
}
