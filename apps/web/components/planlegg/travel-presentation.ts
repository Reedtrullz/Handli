export function formatTravelDuration(durationSeconds: number): string {
  const minutes = durationSeconds === 0 ? 0 : Math.max(1, Math.round(durationSeconds / 60));
  return `${minutes} min`;
}

export function formatTravelDistance(distanceMeters: number): string {
  if (distanceMeters < 1_000) return `${distanceMeters} m`;
  return `${new Intl.NumberFormat("nb-NO", {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
  }).format(distanceMeters / 1_000)} km`;
}
