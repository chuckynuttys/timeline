import Database from '@tauri-apps/plugin-sql';
import { invoke } from '@tauri-apps/api/core';

/**
 * PROFILES: fully separate data spaces, ONE SQLite FILE PER PROFILE.
 *
 * Architecture:
 * - A tiny REGISTRY database (`profiles.db`, never inside any profile DB) holds
 *   the profile list and the active pointer. It is the only cross-profile state.
 * - Each profile's data lives in its own file: the original `timeline.db` (kept
 *   under its original name — the safest possible "migration" of real data is
 *   the one that never touches the file) for the first profile, and
 *   `profile_<id>.db` for every profile created afterwards.
 * - Switching = write activeProfileId + `location.reload()`. On boot,
 *   db.ts -> resolveActiveProfile() opens the active file. The reload is the
 *   DESIGN: every store, the timeline, stats, and startup catch-up initialize
 *   cleanly against the new DB; no in-memory state can leak across profiles.
 * - New profile DBs are NOT covered by the Rust sqlx migrations (those are
 *   registered per connection-string, which can't be dynamic), so
 *   `ensureSchema` below builds the CURRENT schema idempotently in JS.
 *   ⚠ FUTURE SCHEMA CHANGES must land in BOTH lib.rs migrations (for
 *   timeline.db) AND ensureSchema (for profile_*.db files).
 *
 * Scope: profiles partition DATA ONLY (activities, tracks, blocks, ledger).
 * Layout/zoom/date-range localStorage prefs and the avatar stay device-global.
 */

export interface Profile {
  id: string;
  name: string;
  db_file: string;
  created_at: number;
}

const REGISTRY_URL = 'sqlite:profiles.db';
const ACTIVE_KEY = 'activeProfileId';

let registryPromise: Promise<Database> | null = null;
/** Resolved once per boot; a profile switch reloads the webview. */
let activeProfile: Profile | null = null;

function getRegistry(): Promise<Database> {
  registryPromise ??= Database.load(REGISTRY_URL).then(async (db) => {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS profiles (
        id         TEXT    PRIMARY KEY,
        name       TEXT    NOT NULL,
        db_file    TEXT    NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS registry (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    await firstRunMigration(db);
    return db;
  });
  return registryPromise;
}

/**
 * ONE-TIME adoption of the pre-profiles install, guarded by the registry being
 * empty: the existing `timeline.db` (real data) becomes the "Chardoh" profile
 * AS-IS — no file move/rename, its registry row simply points at it — and a
 * fresh "Test" profile is created and seeded for development. Active = Chardoh.
 */
async function firstRunMigration(reg: Database): Promise<void> {
  const rows = await reg.select<Profile[]>('SELECT * FROM profiles');
  if (rows.length > 0) return; // registry exists — migration already ran
  const now = Date.now();
  const chardohId = newId();
  const testId = newId();
  await reg.execute(
    'INSERT INTO profiles (id, name, db_file, created_at) VALUES ($1, $2, $3, $4)',
    [chardohId, 'Chardoh', 'timeline.db', now],
  );
  await reg.execute(
    'INSERT INTO profiles (id, name, db_file, created_at) VALUES ($1, $2, $3, $4)',
    [testId, 'Test', `profile_${testId}.db`, now],
  );
  await reg.execute(
    'INSERT OR REPLACE INTO registry (key, value) VALUES ($1, $2)',
    [ACTIVE_KEY, chardohId],
  );
  // Build Test's DB eagerly so it exists (schema + virgin defaults) from day 1.
  await bootstrapProfileDb(`profile_${testId}.db`);
  console.info('profiles: first-run migration — timeline.db adopted as "Chardoh", "Test" created');
}

function newId(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 12);
}

/**
 * The active profile for THIS boot (cached — switching always reloads).
 * Also stamps the window title so the current profile is always visible.
 */
export async function resolveActiveProfile(): Promise<Profile> {
  if (activeProfile) return activeProfile;
  const reg = await getRegistry();
  const kv = await reg.select<{ value: string }[]>(
    'SELECT value FROM registry WHERE key = $1',
    [ACTIVE_KEY],
  );
  const list = await reg.select<Profile[]>(
    'SELECT * FROM profiles ORDER BY created_at, id',
  );
  // Dangling pointer (e.g. crash mid-remove) falls back to the first profile.
  activeProfile = list.find((p) => p.id === kv[0]?.value) ?? list[0];
  if (!activeProfile) throw new Error('profiles: registry has no profiles');
  document.title = `Timeline — ${activeProfile.name}`;
  return activeProfile;
}

export async function listProfiles(): Promise<Profile[]> {
  const reg = await getRegistry();
  return reg.select<Profile[]>('SELECT * FROM profiles ORDER BY created_at, id');
}

/** Write the active pointer and reload — the ONLY way to change profiles. */
export async function switchProfile(id: string): Promise<void> {
  const reg = await getRegistry();
  await reg.execute(
    'INSERT OR REPLACE INTO registry (key, value) VALUES ($1, $2)',
    [ACTIVE_KEY, id],
  );
  window.location.reload();
}

/** Create a fresh profile: registry row + fully built + seeded DB file. */
export async function createProfile(name: string): Promise<Profile> {
  const reg = await getRegistry();
  const id = newId();
  const profile: Profile = {
    id,
    name: name.trim(),
    db_file: `profile_${id}.db`,
    created_at: Date.now(),
  };
  await bootstrapProfileDb(profile.db_file); // build BEFORE it's switchable
  await reg.execute(
    'INSERT INTO profiles (id, name, db_file, created_at) VALUES ($1, $2, $3, $4)',
    [profile.id, profile.name, profile.db_file, profile.created_at],
  );
  return profile;
}

/**
 * Remove a NON-ACTIVE profile: registry row + its DB file (via a narrow Rust
 * command that only ever deletes `profile_*.db` files — the original
 * timeline.db can never be file-deleted by the UI, a deliberate safety valve
 * for the real data; removing that profile only drops its registry row).
 */
export async function removeProfile(id: string): Promise<void> {
  const reg = await getRegistry();
  const active = await resolveActiveProfile();
  if (id === active.id) throw new Error('cannot remove the active profile');
  const all = await listProfiles();
  if (all.length <= 1) throw new Error('cannot remove the last profile');
  const target = all.find((p) => p.id === id);
  if (!target) return; // already gone
  await reg.execute('DELETE FROM profiles WHERE id = $1', [id]);
  if (/^profile_[a-z0-9]+\.db$/.test(target.db_file)) {
    try {
      await invoke('delete_profile_db', { file: target.db_file });
    } catch (e) {
      console.warn('profiles: registry row removed but DB file deletion failed', e);
    }
  } else {
    console.info(`profiles: kept ${target.db_file} on disk (safety valve)`);
  }
}

/* ---- schema bootstrap (JS mirror of lib.rs migrations v1–v4, idempotent) --- */

/**
 * Build the CURRENT schema on a virgin DB / no-op on an existing one, then
 * seed the same defaults a virgin install gets (three starter tracks; example
 * activities are seeded by db.ts seedIfEmpty on first open).
 */
export async function ensureSchema(db: Database): Promise<Database> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS activities (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      color       TEXT    NOT NULL DEFAULT '#888888',
      created_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tracks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      color       TEXT    NOT NULL,
      sort_order  INTEGER NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scheduled_blocks (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_id      INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
      track_id         INTEGER NOT NULL REFERENCES tracks(id),
      start_time       INTEGER NOT NULL,
      duration_seconds INTEGER NOT NULL,
      status           TEXT    NOT NULL DEFAULT 'scheduled'
                       CHECK (status IN ('scheduled', 'completed', 'canceled')),
      created_at       INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS time_entries (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_id     INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
      seconds         INTEGER NOT NULL,
      logged_at       INTEGER NOT NULL,
      track_id        INTEGER REFERENCES tracks(id),
      source_block_id INTEGER REFERENCES scheduled_blocks(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS activity_track_eligibility (
      activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
      track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      PRIMARY KEY (activity_id, track_id)
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_blocks_start_time ON scheduled_blocks(start_time);
    CREATE INDEX IF NOT EXISTS idx_scheduled_blocks_activity   ON scheduled_blocks(activity_id);
    CREATE INDEX IF NOT EXISTS idx_scheduled_blocks_track      ON scheduled_blocks(track_id);
    CREATE INDEX IF NOT EXISTS idx_time_entries_activity       ON time_entries(activity_id);
    CREATE INDEX IF NOT EXISTS idx_eligibility_track           ON activity_track_eligibility(track_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_time_entries_source_block
      ON time_entries(source_block_id) WHERE source_block_id IS NOT NULL;
  `);
  // Same starter tracks migration v2 gives a virgin install.
  const [{ n }] = await db.select<{ n: number }[]>('SELECT COUNT(*) AS n FROM tracks');
  if (n === 0) {
    const now = Date.now();
    await db.execute(
      `INSERT INTO tracks (name, color, sort_order, created_at) VALUES
        ('Leisure', '#f7b955', 0, $1),
        ('Study',   '#4f8ef7', 1, $1),
        ('Rest',    '#c98bdb', 2, $1)`,
      [now],
    );
  }
  return db;
}

/** Build + seed a profile DB, then CLOSE it (so a never-activated profile can
 *  be removed in the same session — Windows won't delete an open SQLite file).
 *  ⚠ close() MUST name the connection: the plugin's close with no argument
 *  closes EVERY pool in the app (registry + active profile included). */
async function bootstrapProfileDb(dbFile: string): Promise<void> {
  const db = await Database.load(`sqlite:${dbFile}`);
  await ensureSchema(db);
  await db.close(`sqlite:${dbFile}`);
}
