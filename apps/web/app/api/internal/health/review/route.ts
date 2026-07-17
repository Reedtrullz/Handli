import { createPrivateRuntimeReadyHandler } from "../../../../../lib/server/private-runtime-readiness";

export const dynamic = "force-dynamic";

export const GET = createPrivateRuntimeReadyHandler("review", async () => {
  const [{ readReviewAccessConfig }, { getReviewServerContainer }] = await Promise.all([
    import("../../../../../lib/server/review-access"),
    import("../../../../../lib/server/review-container"),
  ]);
  readReviewAccessConfig();
  return getReviewServerContainer().readinessProbe;
});
