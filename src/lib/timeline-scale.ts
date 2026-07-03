/**
 * The single source of truth for mapping absolute time <-> track pixels.
 * The timeline renders with x(t) and the drop handler inverts it; both must
 * use the same constants and the same anchor or placement drifts apart.
 */

/** Base (unzoomed) horizontal scale: px per hour at timeScale 1. The ACTUAL
 *  pixels-per-hour is reactive (`BASE_PPH * timeScale`, see view.svelte.ts);
 *  `xOf`/`pxPerMs` live there so every consumer reads one live value. */
export const BASE_PPH = 120;

/** The stationary now-line sits at this fraction of the timeline pane width. */
export const NOW_LINE_FRACTION = 0.25;

export const MS_PER_HOUR = 3_600_000;

/** Scheduling grid: block start times snap to the nearest 15 minutes. This is
 *  ZOOM-INDEPENDENT — snapping stays 15 min at every time-zoom level. */
export const SNAP_MS = 15 * 60_000;

export function snapTime(time: number): number {
  return Math.round(time / SNAP_MS) * SNAP_MS;
}

/**
 * Fixed reference epoch (app launch). Every x-coordinate on the track —
 * ticks and scheduled blocks alike — is absolute time relative to this,
 * so items never reposition as time passes; only the track's transform moves.
 */
export const anchor = Date.now();

/** Screen x of the now-line, relative to the timeline pane's left edge. */
export function nowLineXFor(paneWidth: number): number {
  return paneWidth * NOW_LINE_FRACTION;
}

/* ---- vertical lane layout (shared by the timeline and the pool's drop) ---- */

/** Height of the hour-label ruler band at the top of the scroll area. */
export const RULER_HEIGHT = 28;

/** Base (unzoomed) height of one main track lane. The ACTUAL lane height is
 *  reactive: `laneHeight = BASE_LANE_HEIGHT * laneScale` (see lane-geometry.ts /
 *  Timeline.svelte). Child sub-lanes are half of that. */
export const BASE_LANE_HEIGHT = 88;

/** Block vertical inset within its (main) lane, at scale 1. */
export const LANE_PAD = 8;

/* ---- overlap sub-lanes (DERIVED at render time; never stored) ------------- */

/** Minimal shape needed to assign sub-lanes — any block-like interval. */
export interface LaneInterval {
  id: number;
  start_time: number;
  duration_seconds: number;
}

/** A block that ended more than this long ago no longer holds a sub-lane. */
export const STALE_MS = 10 * 60_000;

const SORT = (a: LaneInterval, b: LaneInterval) =>
  a.start_time - b.start_time ||
  b.duration_seconds - a.duration_seconds ||
  a.id - b.id;

const endOf = (b: LaneInterval) => b.start_time + b.duration_seconds * 1000;

/**
 * Greedy first-fit sub-lane assignment for ONE track (touching endpoints do NOT
 * overlap). PURE — recomputed from block data; nothing persisted.
 *
 * Expiry collapse: blocks whose end_time < now - STALE_MS ("stale") create NO
 * demand — the sub-lane COUNT derives from non-stale blocks alone, so a track
 * never grows for history. Non-stale get the normal first-fit; stale blocks
 * then take the lowest EXISTING sub-lane they fit in, and CLAMP to the highest
 * remaining sub-lane if none fits (stale overlapping stale is fine — muted
 * history). `now` = a coarse ~1s clock, not per-frame.
 */
export function assignSubLanes(
  blocks: LaneInterval[],
  now: number,
): { laneOf: Map<number, number>; count: number } {
  const staleBefore = now - STALE_MS;
  const nonStale = blocks.filter((b) => endOf(b) >= staleBefore).sort(SORT);
  const stale = blocks.filter((b) => endOf(b) < staleBefore).sort(SORT);

  const laneEnds: number[] = []; // last end_time placed in each sub-lane
  const laneOf = new Map<number, number>();

  for (const b of nonStale) {
    let lane = -1;
    for (let i = 0; i < laneEnds.length; i++) {
      if (laneEnds[i] <= b.start_time) { lane = i; break; }
    }
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(endOf(b)); }
    else { laneEnds[lane] = endOf(b); }
    laneOf.set(b.id, lane);
  }

  // Count is from non-stale only — stale blocks may not grow the track.
  const count = Math.max(1, laneEnds.length);

  for (const b of stale) {
    let lane = -1;
    for (let i = 0; i < count; i++) {
      if ((laneEnds[i] ?? -Infinity) <= b.start_time) { lane = i; break; }
    }
    if (lane === -1) lane = count - 1; // no free existing lane -> clamp to last
    laneEnds[lane] = endOf(b);
    laneOf.set(b.id, lane);
  }

  return { laneOf, count };
}
