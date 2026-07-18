"use client";

import { useEffect } from "react";

import { registerHandleplanServiceWorker } from "../../lib/service-worker-registration";

export { registerHandleplanServiceWorker } from "../../lib/service-worker-registration";

export function ServiceWorkerRegistration() {
  useEffect(() => {
    void registerHandleplanServiceWorker();
  }, []);
  return null;
}
