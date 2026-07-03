import { anchor, BASE_PPH, MS_PER_HOUR } from './timeline-scale';

/**
 * THE single live source for the TIME axis scale. `timeScale` is reactive
 * state; `pixelsPerHour`/`pxPerMs`/`xOf` are functions that READ it, so any
 * template/derived that calls them re-renders when the zoom changes, and the
 * rAF loop reading them imperatively always gets the current value. There must
 * be NO captured copies of `k` anywhere else.
 */

/** Time-zoom clamp — effective px/hour ≈ [30, 960]. */
export const MIN_TIME_SCALE = 30 / BASE_PPH;
export const MAX_TIME_SCALE = 960 / BASE_PPH;
const TIME_SCALE_KEY = 'timeline.time-scale.v1';

export function clampTimeScale(s: number): number {
  return Math.min(MAX_TIME_SCALE, Math.max(MIN_TIME_SCALE, s));
}

function loadTimeScale(): number {
  try {
    const v = Number(localStorage.getItem(TIME_SCALE_KEY));
    if (Number.isFinite(v) && v >= MIN_TIME_SCALE && v <= MAX_TIME_SCALE) return v;
  } catch {
    // storage unavailable — default
  }
  return 1;
}

export const view = $state({ timeScale: loadTimeScale() });

export function persistTimeScale(): void {
  try {
    localStorage.setItem(TIME_SCALE_KEY, String(view.timeScale));
  } catch {
    // storage unavailable — density just won't survive restart
  }
}

/** Live pixels-per-hour (BASE_PPH * timeScale). */
export function pixelsPerHour(): number {
  return BASE_PPH * view.timeScale;
}

/** Live k: pixels per millisecond. */
export function pxPerMs(): number {
  return pixelsPerHour() / MS_PER_HOUR;
}

/** x-position on the track of an absolute epoch-ms time (live scale). */
export function xOf(time: number): number {
  return (time - anchor) * pxPerMs();
}
