/**
 * THE single duration formatter, minute-rounded and compact: "4h 30m", "2h 5m",
 * "38m", "0m", "2h". Shared by the timeline (block labels / resize badge) and the
 * stats panel so the two never drift.
 */
export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
