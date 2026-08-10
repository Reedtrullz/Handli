import "server-only";

export const VALHALLA_SOURCE_KILL_SWITCH_ENV =
  "HANDLEPLAN_SOURCE_VALHALLA_OPENSTREETMAP_SELF_HOSTED_ENABLED";

export function isValhallaTravelRuntimeEnabled(
  values: Record<string, string | undefined> = process.env,
): boolean {
  return values[VALHALLA_SOURCE_KILL_SWITCH_ENV] === "true";
}
