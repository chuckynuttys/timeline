import {
  completeBlock,
  createActivity,
  createScheduledBlock,
  createTrack,
  deleteActivity,
  deleteScheduledBlock,
  deleteTrack,
  getActivities,
  getAllEligibility,
  getScheduledBlocks,
  getTracks,
  restoreActivitySnapshot,
  restoreScheduledBlock,
  setActivityEligibleTrack,
  uncompleteBlock,
  updateScheduledBlock,
  type Activity,
  type ActivitySnapshot,
  type ScheduledBlock,
  type Track,
} from './db';

/**
 * Shared reactive state. The pool drags from `activities`, the timeline
 * renders `tracks` (lanes) and `blocks`; mutations push here and the
 * timeline reacts. `eligibility` mirrors activity_track_eligibility as
 * activity_id -> track ids (single-element arrays for now, shaped for the
 * multi-select future).
 */
export const store = $state({
  activities: [] as Activity[],
  tracks: [] as Track[],
  blocks: [] as ScheduledBlock[],
  eligibility: {} as Record<number, number[]>,
  /** Set true once startup catch-up has run; gates the live completion tick. */
  reconciled: false,
  /** How many blocks the startup catch-up logged (drives the quiet toast). */
  catchUpLogged: 0,
  /** Bumped on any time_entries change (completion / uncompletion) — a refresh
   *  signal for the (future) stats panel to re-query totals. */
  ledgerVersion: 0,
  /** Bumped ONLY on live completions (the notification path in Timeline's 1s
   *  tick, gated on `reconciled`) — never by startup catch-up or uncompletion.
   *  The avatar reacts to this; it must stay a superficial read-only signal. */
  liveCompletionVersion: 0,
});

/**
 * Transient gesture state: the activity whose chip is mid-drag, so the
 * timeline can highlight eligible lanes and dim the rest.
 */
export const dragUI = $state({ activityId: null as number | null });

/**
 * Shared open flag for the pool-header ActivityManager dropdown. Lifted out of
 * the component so the pool's "+" quick-add chip can open the SAME
 * add-activity flow instead of growing a parallel creation form.
 */
export const activityManagerUI = $state({ open: false });

/** Synchronous eligibility check against the store mirror (UI hot paths). */
export function isEligible(activityId: number, trackId: number): boolean {
  return store.eligibility[activityId]?.includes(trackId) ?? false;
}

/**
 * Complete every still-scheduled block whose end_time has passed as of `now`,
 * via the idempotent completeBlock gate. Flips each newly-completed block's
 * status in the reactive store (so the timeline grays it) and returns just the
 * blocks THIS call completed — the caller fires side effects (notification +
 * sound live, nothing on startup catch-up). Safe to overlap: the DB gate hands
 * each block to exactly one caller, so nothing is completed or announced twice.
 */
export async function completeDue(now: number): Promise<ScheduledBlock[]> {
  const done: ScheduledBlock[] = [];
  // Snapshot so a concurrent reload/reassign of store.blocks can't disturb the
  // walk; we still mutate .status on the live proxy objects.
  for (const block of [...store.blocks]) {
    if (block.status !== 'scheduled') continue;
    if (block.start_time + block.duration_seconds * 1000 > now) continue;
    try {
      if (await completeBlock(block)) {
        block.status = 'completed';
        done.push(block);
      }
    } catch (e) {
      console.error('Failed to complete block', block.id, e);
    }
  }
  if (done.length > 0) store.ledgerVersion++; // signal a ledger change
  return done;
}

/**
 * Reschedule/resize commit hook: if a COMPLETED block was pulled so its new
 * end_time is now in the present/future, revert it (status -> scheduled, delete
 * its ledger row) via the sole reverser. Idempotent; drops the totals. The ~1s
 * tick handles the reverse direction (a still-active block whose end passes
 * completes again, logging exactly one fresh row). No new poll loop.
 */
async function maybeUncomplete(block: ScheduledBlock): Promise<void> {
  if (block.status !== 'completed') return;
  if (block.start_time + block.duration_seconds * 1000 <= Date.now()) return;
  try {
    if (await uncompleteBlock(block)) {
      block.status = 'scheduled'; // reactive -> un-grays, resumes dissolving
      store.ledgerVersion++;
    }
  } catch (e) {
    console.error('Failed to uncomplete block', block.id, e);
  }
}

/**
 * Startup catch-up: log (silently) any block that ended while the app was
 * closed, then mark the store reconciled so the live tick may begin. Must run
 * exactly once, AFTER loadStore and BEFORE the live tick. Never throws — the
 * reconciled flag is always set so a load hiccup can't wedge the live tick.
 */
export async function startupCatchUp(): Promise<number> {
  try {
    const done = await completeDue(Date.now());
    store.catchUpLogged = done.length;
    return done.length;
  } finally {
    store.reconciled = true;
  }
}

/**
 * Initial load. The first db call also runs migrations and seeds example
 * activities (see getDb in db.ts).
 */
export async function loadStore(): Promise<void> {
  store.activities = await getActivities();
  store.tracks = await getTracks();
  store.blocks = await getScheduledBlocks();
  const rows = await getAllEligibility();
  const map: Record<number, number[]> = {};
  for (const { activity_id, track_id } of rows) {
    (map[activity_id] ??= []).push(track_id);
  }
  store.eligibility = map;
}

/**
 * Optimistic reschedule: the block object is the reactive proxy from
 * store.blocks, so mutating it re-renders the timeline immediately; the DB
 * write follows. Cross-lane drags change track_id in the same gesture.
 */
export async function rescheduleBlock(
  block: ScheduledBlock,
  newStartTime: number,
  newTrackId: number = block.track_id,
): Promise<void> {
  block.start_time = newStartTime;
  block.track_id = newTrackId;
  await updateScheduledBlock(block.id, {
    start_time: newStartTime,
    track_id: newTrackId,
  });
  await maybeUncomplete(block); // dragged back into the present -> un-complete
}

/**
 * Optimistically remove a placed block (shift-click delete on the timeline)
 * and return the removed row so the timeline can offer Undo. Rolls the block
 * back into the store if the DB delete fails. Never touches the time ledger.
 */
export async function removeBlock(block: ScheduledBlock): Promise<ScheduledBlock> {
  const snapshot = { ...block };
  store.blocks = store.blocks.filter((b) => b.id !== block.id);
  try {
    await deleteScheduledBlock(block.id);
  } catch (e) {
    store.blocks.push(snapshot);
    throw e;
  }
  return snapshot;
}

/** Undo a block delete: re-insert with the original id and re-add to the store. */
export async function restoreBlock(block: ScheduledBlock): Promise<void> {
  await restoreScheduledBlock(block);
  store.blocks.push({ ...block });
}

/** Optimistic resize; duration only. */
export async function resizeBlock(
  block: ScheduledBlock,
  newDurationSeconds: number,
): Promise<void> {
  block.duration_seconds = newDurationSeconds;
  await updateScheduledBlock(block.id, { duration_seconds: newDurationSeconds });
  await maybeUncomplete(block); // resized so its end is now future -> un-complete
}

export async function scheduleActivity(
  activityId: number,
  trackId: number,
  startTime: number,
  durationSeconds: number,
): Promise<ScheduledBlock> {
  const block = await createScheduledBlock(activityId, trackId, startTime, durationSeconds);
  store.blocks.push(block);
  return block;
}

export async function addTrack(name: string, color: string): Promise<Track> {
  const track = await createTrack(name, color);
  store.tracks.push(track);
  return track;
}

/**
 * Removes a track (db.deleteTrack reassigns its blocks AND any eligibility
 * stranded on it, and enforces the min-1 rule), then reloads so lanes,
 * reassigned block colors, and eligibility all update.
 */
export async function removeTrack(id: number): Promise<void> {
  await deleteTrack(id);
  await loadStore();
}

export async function addActivity(
  name: string,
  color: string,
  trackId: number,
): Promise<Activity> {
  const activity = await createActivity(name, color, trackId);
  store.activities.push(activity);
  store.eligibility[activity.id] = [trackId];
  return activity;
}

/** Removes the activity, its blocks, and its eligibility; reloads the store. */
export async function removeActivity(id: number): Promise<void> {
  await deleteActivity(id);
  await loadStore();
}

/**
 * Delete an activity AND return an in-memory snapshot (activity, eligibility,
 * blocks) captured BEFORE the delete, so the pool's shift-click fast path can
 * offer Undo. The reload makes the timeline drop the removed blocks (even a
 * currently-active one) and the pool drop the chip reactively. Returns null if
 * the activity was already gone.
 */
export async function removeActivityWithSnapshot(
  id: number,
): Promise<ActivitySnapshot | null> {
  const activity = store.activities.find((a) => a.id === id);
  if (!activity) return null;
  // Detach plain clones from the reactive proxies before the store reloads.
  const snapshot: ActivitySnapshot = {
    activity: { ...activity },
    eligibleTrackIds: [...(store.eligibility[id] ?? [])],
    blocks: store.blocks.filter((b) => b.activity_id === id).map((b) => ({ ...b })),
  };
  await deleteActivity(id);
  await loadStore();
  return snapshot;
}

/** Undo a snapshot delete: re-insert the activity/eligibility/blocks, reload. */
export async function restoreActivity(snapshot: ActivitySnapshot): Promise<void> {
  await restoreActivitySnapshot(snapshot);
  await loadStore();
}

/** Single-select for now: the activity's eligible set becomes [trackId]. */
export async function setEligibleTrack(
  activityId: number,
  trackId: number,
): Promise<void> {
  await setActivityEligibleTrack(activityId, trackId);
  store.eligibility[activityId] = [trackId];
}
