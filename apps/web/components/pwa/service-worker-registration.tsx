"use client";

import { useEffect } from "react";

export async function registerHandleplanServiceWorker(): Promise<void> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  const serviceWorkerUrl = new URL("/sw.js", window.location.origin);
  if (serviceWorkerUrl.origin !== window.location.origin) return;
  try {
    await navigator.serviceWorker.register(serviceWorkerUrl.pathname, {
      scope: "/",
      updateViaCache: "none",
    });
  } catch {
    // Handlemodus still works online and IndexedDB remains the source of truth.
  }
}

export function ServiceWorkerRegistration() {
  useEffect(() => {
    void registerHandleplanServiceWorker();
  }, []);
  return null;
}
