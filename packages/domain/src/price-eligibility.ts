const ELIGIBLE_MAX_AGE_MS = 72 * 60 * 60 * 1_000;
const STALE_VISIBLE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1_000;

export type Freshness = "eligible" | "stale-visible" | "historical";

export function classifyFreshness(now: Date, observedAt: Date): Freshness {
  const elapsedMs = now.getTime() - observedAt.getTime();

  if (elapsedMs <= ELIGIBLE_MAX_AGE_MS) {
    return "eligible";
  }

  if (elapsedMs <= STALE_VISIBLE_MAX_AGE_MS) {
    return "stale-visible";
  }

  return "historical";
}
