import Database from '@tauri-apps/plugin-sql';

/** Must match the connection string the migrations are registered under in lib.rs. */
const DB_URL = 'sqlite:timeline.db';

export interface Activity {
  id: number;
  name: string;
  color: string;
  created_at: number;
}

export interface Track {
  id: number;
  name: string;
  color: string;
  sort_order: number;
  created_at: number;
}

export type BlockStatus = 'scheduled' | 'completed' | 'canceled';

export interface ScheduledBlock {
  id: number;
  activity_id: number;
  /** The lane (genre) this block lives in; determines fill color and row. */
  track_id: number;
  /** Epoch ms — position on the timeline. */
  start_time: number;
  /** Scheduled duration; equals the block's width on the timeline. */
  duration_seconds: number;
  status: BlockStatus;
  created_at: number;
}

export interface TimeEntry {
  id: number;
  activity_id: number;
  /** The track the time was spent under, for per-track aggregation. */
  track_id: number | null;
  /**
   * The completed block this row was logged from (unique when set). NULL on
   * rows predating migration v4 and after that block is later deleted.
   */
  source_block_id: number | null;
  /** Actual time spent. */
  seconds: number;
  logged_at: number;
}

export interface ActivityTotal {
  activity_id: number;
  seconds: number;
}

export interface TrackTotal {
  track_id: number | null;
  seconds: number;
}

/** One row of the many-to-many activity↔track eligibility relation. */
export interface EligibilityRow {
  activity_id: number;
  track_id: number;
}

let dbPromise: Promise<Database> | null = null;

/**
 * Shared connection. The first call runs pending migrations (the plugin
 * applies them on load) and seeds example activities if the table is empty.
 */
export function getDb(): Promise<Database> {
  dbPromise ??= Database.load(DB_URL).then(seedIfEmpty);
  return dbPromise;
}

async function seedIfEmpty(db: Database): Promise<Database> {
  const [{ n }] = await db.select<{ n: number }[]>(
    'SELECT COUNT(*) AS n FROM activities',
  );
  if (n === 0) {
    const now = Date.now();
    const examples: Array<[name: string, color: string]> = [
      ['Deep work', '#4f8ef7'],
      ['Exercise', '#4fc26e'],
      ['Reading', '#c98bdb'],
    ];
    // Seeding runs AFTER migrations, so the v3 backfill saw an empty table —
    // seeded activities must get their eligibility row here (first track).
    for (const [name, color] of examples) {
      const result = await db.execute(
        'INSERT INTO activities (name, color, created_at) VALUES ($1, $2, $3)',
        [name, color, now],
      );
      await db.execute(
        `INSERT INTO activity_track_eligibility (activity_id, track_id)
         SELECT $1, id FROM tracks ORDER BY sort_order LIMIT 1`,
        [result.lastInsertId],
      );
    }
  }
  return db;
}

export async function getTracks(): Promise<Track[]> {
  const db = await getDb();
  return db.select<Track[]>('SELECT * FROM tracks ORDER BY sort_order, id');
}

export async function createTrack(name: string, color: string): Promise<Track> {
  const db = await getDb();
  const created_at = Date.now();
  const [{ next }] = await db.select<{ next: number }[]>(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM tracks',
  );
  const result = await db.execute(
    'INSERT INTO tracks (name, color, sort_order, created_at) VALUES ($1, $2, $3, $4)',
    [name, color, next, created_at],
  );
  return { id: result.lastInsertId!, name, color, sort_order: next, created_at };
}

/**
 * Deletes a track, first reassigning all its blocks to the remaining track
 * with the lowest sort_order so nothing is orphaned. Any activity whose ONLY
 * eligible track is the deleted one is re-pointed at that same fallback, so
 * no activity ever ends with zero eligible tracks. Refuses to delete the
 * last remaining track.
 */
export async function deleteTrack(id: number): Promise<void> {
  const db = await getDb();
  const tracks = await getTracks();
  if (tracks.length <= 1) {
    throw new Error('Cannot delete the last remaining track');
  }
  const fallback = tracks.find((t) => t.id !== id);
  if (!fallback || !tracks.some((t) => t.id === id)) return;
  await db.execute('UPDATE scheduled_blocks SET track_id = $1 WHERE track_id = $2', [
    fallback.id,
    id,
  ]);
  // Activities eligible ONLY for the doomed track get the fallback first;
  // then the doomed track's rows go away (multi-eligible activities just
  // lose one row).
  await db.execute(
    `INSERT OR IGNORE INTO activity_track_eligibility (activity_id, track_id)
     SELECT ate.activity_id, $1 FROM activity_track_eligibility ate
     WHERE ate.track_id = $2
       AND NOT EXISTS (
         SELECT 1 FROM activity_track_eligibility o
         WHERE o.activity_id = ate.activity_id AND o.track_id != $2
       )`,
    [fallback.id, id],
  );
  await db.execute('DELETE FROM activity_track_eligibility WHERE track_id = $1', [id]);
  await db.execute('DELETE FROM tracks WHERE id = $1', [id]);
}

export async function getActivities(): Promise<Activity[]> {
  const db = await getDb();
  return db.select<Activity[]>('SELECT * FROM activities ORDER BY created_at, id');
}

/** Inserts the activity plus its single (for now) eligibility row. */
export async function createActivity(
  name: string,
  color: string,
  trackId: number,
): Promise<Activity> {
  const db = await getDb();
  const created_at = Date.now();
  const result = await db.execute(
    'INSERT INTO activities (name, color, created_at) VALUES ($1, $2, $3)',
    [name, color, created_at],
  );
  const id = result.lastInsertId!;
  await db.execute(
    'INSERT INTO activity_track_eligibility (activity_id, track_id) VALUES ($1, $2)',
    [id, trackId],
  );
  return { id, name, color, created_at };
}

/**
 * Removes an activity and everything hanging off it. The schema already has
 * ON DELETE CASCADE on scheduled_blocks.activity_id and time_entries.activity_id,
 * but the sql plugin doesn't guarantee `PRAGMA foreign_keys=ON` per connection,
 * so these explicit deletes make removal deterministic regardless.
 *
 * Deletion is NOT completion: removing the time_entries rows here never records
 * time, it only clears any that already existed (none can yet — see
 * completeBlock). A deleted activity leaves zero footprint in the ledger.
 */
export async function deleteActivity(id: number): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM scheduled_blocks WHERE activity_id = $1', [id]);
  await db.execute('DELETE FROM time_entries WHERE activity_id = $1', [id]);
  await db.execute('DELETE FROM activity_track_eligibility WHERE activity_id = $1', [id]);
  await db.execute('DELETE FROM activities WHERE id = $1', [id]);
}

/** Everything needed to undo a deleteActivity: captured from the store before delete. */
export interface ActivitySnapshot {
  activity: Activity;
  eligibleTrackIds: number[];
  blocks: ScheduledBlock[];
}

/**
 * Inverse of deleteActivity for the shift-click undo path. Re-inserts the
 * activity, its eligibility rows, and its blocks with their ORIGINAL ids, so
 * undo is a true restore (block/activity ids stay stable). Deliberately does
 * NOT restore time_entries: a deleted activity has no legitimate ledger rows
 * (nothing writes them yet), so there is nothing to bring back.
 */
export async function restoreActivitySnapshot(snap: ActivitySnapshot): Promise<void> {
  const db = await getDb();
  const a = snap.activity;
  await db.execute(
    'INSERT INTO activities (id, name, color, created_at) VALUES ($1, $2, $3, $4)',
    [a.id, a.name, a.color, a.created_at],
  );
  for (const trackId of snap.eligibleTrackIds) {
    await db.execute(
      `INSERT OR IGNORE INTO activity_track_eligibility (activity_id, track_id)
       VALUES ($1, $2)`,
      [a.id, trackId],
    );
  }
  for (const b of snap.blocks) {
    await db.execute(
      `INSERT INTO scheduled_blocks
         (id, activity_id, track_id, start_time, duration_seconds, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [b.id, b.activity_id, b.track_id, b.start_time, b.duration_seconds, b.status, b.created_at],
    );
  }
}

export async function getAllEligibility(): Promise<EligibilityRow[]> {
  const db = await getDb();
  return db.select<EligibilityRow[]>(
    'SELECT activity_id, track_id FROM activity_track_eligibility',
  );
}

export async function getActivityEligibleTracks(activityId: number): Promise<number[]> {
  const db = await getDb();
  const rows = await db.select<{ track_id: number }[]>(
    'SELECT track_id FROM activity_track_eligibility WHERE activity_id = $1',
    [activityId],
  );
  return rows.map((r) => r.track_id);
}

/**
 * Single-select for now: replaces the activity's eligibility with exactly
 * this track. Ordered so the set is never empty in between — delete every
 * OTHER row first, then upsert the target.
 */
export async function setActivityEligibleTrack(
  activityId: number,
  trackId: number,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    'DELETE FROM activity_track_eligibility WHERE activity_id = $1 AND track_id != $2',
    [activityId, trackId],
  );
  await db.execute(
    `INSERT OR IGNORE INTO activity_track_eligibility (activity_id, track_id)
     VALUES ($1, $2)`,
    [activityId, trackId],
  );
}

export async function isActivityEligibleForTrack(
  activityId: number,
  trackId: number,
): Promise<boolean> {
  const db = await getDb();
  const rows = await db.select<{ one: number }[]>(
    `SELECT 1 AS one FROM activity_track_eligibility
     WHERE activity_id = $1 AND track_id = $2`,
    [activityId, trackId],
  );
  return rows.length > 0;
}

/**
 * Blocks overlapping [from, to) when a range is given, otherwise all blocks.
 * duration_seconds is seconds while start_time is ms, hence the * 1000.
 */
export async function getScheduledBlocks(
  from?: number,
  to?: number,
): Promise<ScheduledBlock[]> {
  const db = await getDb();
  if (from !== undefined && to !== undefined) {
    return db.select<ScheduledBlock[]>(
      `SELECT * FROM scheduled_blocks
       WHERE start_time < $2 AND start_time + duration_seconds * 1000 > $1
       ORDER BY start_time`,
      [from, to],
    );
  }
  return db.select<ScheduledBlock[]>(
    'SELECT * FROM scheduled_blocks ORDER BY start_time',
  );
}

export async function createScheduledBlock(
  activity_id: number,
  track_id: number,
  start_time: number,
  duration_seconds: number,
): Promise<ScheduledBlock> {
  const db = await getDb();
  const created_at = Date.now();
  const result = await db.execute(
    `INSERT INTO scheduled_blocks (activity_id, track_id, start_time, duration_seconds, status, created_at)
     VALUES ($1, $2, $3, $4, 'scheduled', $5)`,
    [activity_id, track_id, start_time, duration_seconds, created_at],
  );
  return {
    id: result.lastInsertId!,
    activity_id,
    track_id,
    start_time,
    duration_seconds,
    status: 'scheduled',
    created_at,
  };
}

/**
 * Deletes a single placed block (shift-click delete on the timeline). This is
 * a plain block removal, NOT activity deletion — the activity, its other
 * blocks, and its eligibility are untouched. Deleting a block never records
 * time (see completeBlock): removing a block is not completing it.
 */
export async function deleteScheduledBlock(id: number): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM scheduled_blocks WHERE id = $1', [id]);
}

/**
 * Re-inserts a deleted block with its ORIGINAL id, for the timeline's
 * shift-click undo (true restore). No time_entries to bring back — a deleted
 * block never logged any.
 */
export async function restoreScheduledBlock(block: ScheduledBlock): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO scheduled_blocks
       (id, activity_id, track_id, start_time, duration_seconds, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      block.id,
      block.activity_id,
      block.track_id,
      block.start_time,
      block.duration_seconds,
      block.status,
      block.created_at,
    ],
  );
}

export type ScheduledBlockPatch = Partial<
  Pick<ScheduledBlock, 'start_time' | 'duration_seconds' | 'status' | 'track_id'>
>;

export async function updateBlockTrack(blockId: number, trackId: number): Promise<void> {
  await updateScheduledBlock(blockId, { track_id: trackId });
}

export async function updateScheduledBlock(
  id: number,
  patch: ScheduledBlockPatch,
): Promise<void> {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  // Keys come from the typed patch, so interpolating column names is safe.
  const sets = entries.map(([key], i) => `${key} = $${i + 2}`).join(', ');
  const db = await getDb();
  await db.execute(`UPDATE scheduled_blocks SET ${sets} WHERE id = $1`, [
    id,
    ...entries.map(([, v]) => v),
  ]);
}

/**
 * THE SINGLE WRITE SITE for time_entries — nothing else may INSERT here.
 *
 * Idempotent and effectively atomic: the status-guarded UPDATE is the claim.
 * SQLite serializes writes, so only ONE caller can flip a given block
 * scheduled -> completed, and only that caller (rowsAffected === 1) writes the
 * ledger row. Called again on an already-completed/canceled/deleted block it
 * does nothing and returns false — so re-ticks never duplicate a row, and the
 * live path fires exactly one notification/sound per block.
 *
 * Why not a BEGIN/COMMIT transaction: tauri-plugin-sql pools connections, so a
 * multi-statement transaction across separate execute() calls isn't reliably
 * one connection. The guarded UPDATE gives the same exactly-once guarantee; if
 * the ledger INSERT ever fails we compensate by reverting the status so a
 * retry can complete it (no completed block left without its row).
 *
 * seconds logged = duration_seconds: under this model the scheduled window IS
 * the time spent (no partial/elapsed tracking). Every row carries BOTH
 * activity_id and track_id so stats can group either way, plus
 * source_block_id — "one row per completed block" is enforced STRUCTURALLY by
 * a partial unique index (v4), with INSERT OR IGNORE as the guard, on top of
 * the behavioral status claim. completeBlock is NEVER called on delete or
 * cancel — deletion cascades the block away first.
 */
export async function completeBlock(block: ScheduledBlock): Promise<boolean> {
  const db = await getDb();
  const claim = await db.execute(
    `UPDATE scheduled_blocks SET status = 'completed'
     WHERE id = $1 AND status = 'scheduled'`,
    [block.id],
  );
  if (claim.rowsAffected !== 1) return false; // already done / canceled / gone
  try {
    const insert = await db.execute(
      `INSERT OR IGNORE INTO time_entries
         (activity_id, track_id, source_block_id, seconds, logged_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [block.activity_id, block.track_id, block.id, block.duration_seconds, Date.now()],
    );
    if (insert.rowsAffected === 0) {
      // Unique guard tripped: a ledger row for this block already exists
      // (shouldn't be reachable — the status claim precedes us). Keep the
      // completed status, add nothing.
      console.warn('completeBlock: ledger row already existed for block', block.id);
    }
  } catch (e) {
    // Compensate: release the claim so the block can be retried next tick.
    await db.execute(
      `UPDATE scheduled_blocks SET status = 'scheduled' WHERE id = $1`,
      [block.id],
    );
    throw e;
  }
  return true;
}

/**
 * THE ONLY reverser of a completion — the mirror of completeBlock. Idempotent
 * and effectively atomic via the same status-claim gate: ONLY if the block is
 * currently 'completed', flip it back to 'scheduled' AND delete THAT block's
 * own ledger row (identified by source_block_id — never guess by
 * activity/seconds). Returns true iff THIS call reverted it.
 *
 * Net effect of complete → uncomplete → complete is exactly ONE ledger row:
 * complete inserts (source_block_id = block.id), uncomplete deletes that exact
 * row, complete inserts again. Legacy rows predating source_block_id (or whose
 * block was deleted, nulling the FK) can't be matched — the status is still
 * reverted, but we warn LOUDLY rather than guess-delete, so the old row may
 * linger. Fires only from the reschedule/resize commit hooks (see store).
 */
export async function uncompleteBlock(block: ScheduledBlock): Promise<boolean> {
  const db = await getDb();
  const claim = await db.execute(
    `UPDATE scheduled_blocks SET status = 'scheduled'
     WHERE id = $1 AND status = 'completed'`,
    [block.id],
  );
  if (claim.rowsAffected !== 1) return false; // not completed / gone
  const del = await db.execute(
    'DELETE FROM time_entries WHERE source_block_id = $1',
    [block.id],
  );
  if (del.rowsAffected === 0) {
    console.warn(
      'uncompleteBlock: no ledger row found for block',
      block.id,
      '(legacy NULL source_block_id) — status reverted but logged time NOT reversed',
    );
  }
  return true;
}

export async function getTotalsByActivity(): Promise<ActivityTotal[]> {
  const db = await getDb();
  return db.select<ActivityTotal[]>(
    `SELECT activity_id, SUM(seconds) AS seconds
     FROM time_entries
     GROUP BY activity_id`,
  );
}

export async function getTotalsByTrack(): Promise<TrackTotal[]> {
  const db = await getDb();
  return db.select<TrackTotal[]>(
    `SELECT track_id, SUM(seconds) AS seconds
     FROM time_entries
     GROUP BY track_id`,
  );
}

/**
 * Raw ledger rows, optionally filtered to [since, until) by logged_at — for
 * the stats panel's date-range views next phase.
 */
export async function getTimeEntries(
  range: { since?: number; until?: number } = {},
): Promise<TimeEntry[]> {
  const db = await getDb();
  const clauses: string[] = [];
  const params: number[] = [];
  if (range.since !== undefined) {
    params.push(range.since);
    clauses.push(`logged_at >= $${params.length}`);
  }
  if (range.until !== undefined) {
    params.push(range.until);
    clauses.push(`logged_at < $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.select<TimeEntry[]>(
    `SELECT * FROM time_entries ${where} ORDER BY logged_at`,
    params,
  );
}
