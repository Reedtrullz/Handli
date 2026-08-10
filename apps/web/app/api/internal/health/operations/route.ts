import { createPrivateRuntimeReadyHandler } from "../../../../../lib/server/private-runtime-readiness";

export const dynamic = "force-dynamic";

export const GET = createPrivateRuntimeReadyHandler("operations", async () => {
  const [{ readOperationsAccessConfig }, { getOperationsServerContainer }] = await Promise.all([
    import("../../../../../lib/server/operations-access"),
    import("../../../../../lib/server/operations-container"),
  ]);
  readOperationsAccessConfig();
  return getOperationsServerContainer().readinessProbe;
});
