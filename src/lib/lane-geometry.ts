import type { ScheduledBlock, Track } from './db';
import { assignSubLanes, BASE_LANE_HEIGHT, LANE_PAD, RULER_HEIGHT } from './timeline-scale';

/**
 * THE single source of truth for vertical lane geometry. Every consumer (block
 * rendering, gutter labels, drop/lane-drag Y-targeting, dissolve overlay,
 * particle emitter, gridline/needle height, vertical-scroll content height)
 * reads from the object returned by computeGeometry — no `* laneHeight` math
 * lives anywhere else.
 *
 * Sub-lanes: index 0 is the MAIN lane at full `laneHeight`; indices >= 1 are
 * CHILD lanes at half that. Block inset scales with its sub-lane height (so the
 * look is consistent across zoom). Everything is derived from block data +
 * the reactive `laneHeight` — nothing is persisted.
 */

/** Child sub-lanes (index >= 1) render at this fraction of the main lane. */
export const CHILD_SCALE = 0.5;
/** Block inset as a fraction of its sub-lane height (8/88 at scale 1 = LANE_PAD). */
const PAD_FRACTION = LANE_PAD / BASE_LANE_HEIGHT;

export interface BlockRect {
  sub: number;
  top: number; // content-space y (before vertical lane scroll)
  height: number;
}

export interface LaneGeometry {
  laneHeight: number;
  contentHeight: number; // RULER_HEIGHT + all track heights
  subLaneHeight(sub: number): number;
  subLaneOffsetY(sub: number): number; // running sum WITHIN a track
  subLaneCount(trackId: number): number;
  subLaneOf(blockId: number): number;
  trackHeight(trackId: number): number;
  trackOffsetY(trackId: number): number; // running sum of preceding tracks
  /** Rect for a hypothetical block placed at `sub` in `trackId` (drag commit). */
  bandRect(trackId: number, sub: number): BlockRect;
  blockRect(block: ScheduledBlock): BlockRect;
  /** Resolve a content-space y to a track id, clamped to first/last. */
  yToTrack(contentY: number): number | undefined;
}

export function computeGeometry(
  tracks: Track[],
  blocks: ScheduledBlock[],
  laneHeight: number,
  now: number,
): LaneGeometry {
  const childH = laneHeight * CHILD_SCALE;

  const subLaneHeight = (sub: number) => (sub <= 0 ? laneHeight : childH);
  // 0 -> 0 ; 1 -> H ; 2 -> H + childH ; 3 -> H + 2·childH ; ...
  const subLaneOffsetY = (sub: number) =>
    sub <= 0 ? 0 : laneHeight + (sub - 1) * childH;
  const pad = (sub: number) => subLaneHeight(sub) * PAD_FRACTION;

  // Per-track greedy assignment + running-sum track offsets.
  const byTrack = new Map<number, ScheduledBlock[]>();
  for (const b of blocks) {
    let arr = byTrack.get(b.track_id);
    if (!arr) byTrack.set(b.track_id, (arr = []));
    arr.push(b);
  }
  const subLaneOfMap = new Map<number, number>();
  const countByTrack = new Map<number, number>();
  const offsetByTrack = new Map<number, number>();
  let y = RULER_HEIGHT;
  for (const t of tracks) {
    const { laneOf, count } = assignSubLanes(byTrack.get(t.id) ?? [], now);
    for (const [id, s] of laneOf) subLaneOfMap.set(id, s);
    countByTrack.set(t.id, count);
    offsetByTrack.set(t.id, y);
    y += laneHeight + (count - 1) * childH; // = trackHeight
  }
  const contentHeight = y;

  const subLaneCount = (trackId: number) => countByTrack.get(trackId) ?? 1;
  const subLaneOf = (blockId: number) => subLaneOfMap.get(blockId) ?? 0;
  const trackHeight = (trackId: number) =>
    laneHeight + (subLaneCount(trackId) - 1) * childH;
  const trackOffsetY = (trackId: number) =>
    offsetByTrack.get(trackId) ?? RULER_HEIGHT;

  const bandRect = (trackId: number, sub: number): BlockRect => {
    const p = pad(sub);
    return {
      sub,
      top: trackOffsetY(trackId) + subLaneOffsetY(sub) + p,
      height: subLaneHeight(sub) - 2 * p,
    };
  };
  const blockRect = (block: ScheduledBlock) =>
    bandRect(block.track_id, subLaneOf(block.id));

  const yToTrack = (contentY: number): number | undefined => {
    if (tracks.length === 0) return undefined;
    for (const t of tracks) {
      if (contentY < trackOffsetY(t.id) + trackHeight(t.id)) return t.id;
    }
    return tracks[tracks.length - 1].id; // below all bands -> last track
  };

  return {
    laneHeight, contentHeight, subLaneHeight, subLaneOffsetY, subLaneCount,
    subLaneOf, trackHeight, trackOffsetY, bandRect, blockRect, yToTrack,
  };
}
