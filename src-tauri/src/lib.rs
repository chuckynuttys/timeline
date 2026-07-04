use tauri::{
  menu::{Menu, MenuItem},
  tray::TrayIconBuilder,
  Manager,
};
use tauri_plugin_sql::{Migration, MigrationKind};

fn migrations() -> Vec<Migration> {
  vec![Migration {
    version: 1,
    description: "create_activities_scheduled_blocks_time_entries",
    kind: MigrationKind::Up,
    sql: r#"
      CREATE TABLE activities (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    NOT NULL,
        color       TEXT    NOT NULL DEFAULT '#888888',
        created_at  INTEGER NOT NULL
      );

      CREATE TABLE scheduled_blocks (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        activity_id      INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
        start_time       INTEGER NOT NULL,
        duration_seconds INTEGER NOT NULL,
        status           TEXT    NOT NULL DEFAULT 'scheduled'
                         CHECK (status IN ('scheduled', 'completed', 'canceled')),
        created_at       INTEGER NOT NULL
      );

      CREATE TABLE time_entries (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
        seconds     INTEGER NOT NULL,
        logged_at   INTEGER NOT NULL
      );

      CREATE INDEX idx_scheduled_blocks_start_time ON scheduled_blocks(start_time);
      CREATE INDEX idx_scheduled_blocks_activity   ON scheduled_blocks(activity_id);
      CREATE INDEX idx_time_entries_activity       ON time_entries(activity_id);
    "#,
  },
  Migration {
    version: 2,
    description: "add_tracks_and_block_track_id",
    kind: MigrationKind::Up,
    // SQLite can't ADD COLUMN with NOT NULL + REFERENCES (such columns must
    // default to NULL), so scheduled_blocks is rebuilt with the new column.
    // Existing blocks land on the first track (lowest sort_order).
    sql: r#"
      CREATE TABLE tracks (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    NOT NULL,
        color       TEXT    NOT NULL,
        sort_order  INTEGER NOT NULL,
        created_at  INTEGER NOT NULL
      );

      INSERT INTO tracks (name, color, sort_order, created_at) VALUES
        ('Leisure', '#f7b955', 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
        ('Study',   '#4f8ef7', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
        ('Rest',    '#c98bdb', 2, CAST(strftime('%s', 'now') AS INTEGER) * 1000);

      CREATE TABLE scheduled_blocks_new (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        activity_id      INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
        track_id         INTEGER NOT NULL REFERENCES tracks(id),
        start_time       INTEGER NOT NULL,
        duration_seconds INTEGER NOT NULL,
        status           TEXT    NOT NULL DEFAULT 'scheduled'
                         CHECK (status IN ('scheduled', 'completed', 'canceled')),
        created_at       INTEGER NOT NULL
      );

      INSERT INTO scheduled_blocks_new
        (id, activity_id, track_id, start_time, duration_seconds, status, created_at)
      SELECT
        id, activity_id,
        (SELECT id FROM tracks ORDER BY sort_order LIMIT 1),
        start_time, duration_seconds, status, created_at
      FROM scheduled_blocks;

      DROP TABLE scheduled_blocks;
      ALTER TABLE scheduled_blocks_new RENAME TO scheduled_blocks;

      CREATE INDEX idx_scheduled_blocks_start_time ON scheduled_blocks(start_time);
      CREATE INDEX idx_scheduled_blocks_activity   ON scheduled_blocks(activity_id);
      CREATE INDEX idx_scheduled_blocks_track      ON scheduled_blocks(track_id);
    "#,
  },
  Migration {
    version: 3,
    description: "add_activity_track_eligibility_and_time_entry_track",
    kind: MigrationKind::Up,
    // Eligibility is a many-to-many join table even though the UI currently
    // holds it to one row per activity. time_entries.track_id is nullable —
    // SQLite only allows ADD COLUMN with REFERENCES when it defaults to NULL,
    // and the table is empty anyway. Backfill gives every existing activity
    // exactly one eligible track: its most recently created block's track,
    // else the lowest-sort_order track.
    sql: r#"
      CREATE TABLE activity_track_eligibility (
        activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
        track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        PRIMARY KEY (activity_id, track_id)
      );

      CREATE INDEX idx_eligibility_track ON activity_track_eligibility(track_id);

      ALTER TABLE time_entries ADD COLUMN track_id INTEGER REFERENCES tracks(id);

      INSERT INTO activity_track_eligibility (activity_id, track_id)
      SELECT
        a.id,
        COALESCE(
          (SELECT sb.track_id FROM scheduled_blocks sb
           WHERE sb.activity_id = a.id
           ORDER BY sb.created_at DESC, sb.id DESC
           LIMIT 1),
          (SELECT t.id FROM tracks t ORDER BY t.sort_order LIMIT 1)
        )
      FROM activities a;
    "#,
  },
  Migration {
    version: 4,
    description: "add_time_entries_source_block_id",
    kind: MigrationKind::Up,
    // Makes "one ledger row per completed block" STRUCTURAL: nullable column
    // (rows predating v4 stay NULL — not back-attributable without guessing)
    // with a partial UNIQUE index. ON DELETE SET NULL so deleting a completed
    // block keeps its logged time but drops the link (deletion never touches
    // the ledger). Nullable REFERENCES is fine for ADD COLUMN (cf. v3).
    sql: r#"
      ALTER TABLE time_entries ADD COLUMN source_block_id INTEGER
        REFERENCES scheduled_blocks(id) ON DELETE SET NULL;

      CREATE UNIQUE INDEX idx_time_entries_source_block
        ON time_entries(source_block_id) WHERE source_block_id IS NOT NULL;
    "#,
  }]
}

/// Delete a profile database file (plus its -wal/-shm siblings) from the app
/// data dir. DELIBERATELY narrow: only `profile_<id>.db` names pass — the
/// original timeline.db (the user's real data) can never be deleted through
/// this, and path traversal is structurally impossible.
#[tauri::command]
fn delete_profile_db(app: tauri::AppHandle, file: String) -> Result<(), String> {
  let valid = file.starts_with("profile_")
    && file.ends_with(".db")
    && file[8..file.len() - 3]
      .chars()
      .all(|c| c.is_ascii_alphanumeric());
  if !valid {
    return Err(format!("refusing to delete non-profile file: {file}"));
  }
  let dir = app
    .path()
    .app_data_dir()
    .map_err(|e| format!("no app data dir: {e}"))?;
  for suffix in ["", "-wal", "-shm"] {
    let path = dir.join(format!("{file}{suffix}"));
    if path.exists() {
      std::fs::remove_file(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    }
  }
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![delete_profile_db])
    .plugin(
      tauri_plugin_sql::Builder::default()
        .add_migrations("sqlite:timeline.db", migrations())
        .build(),
    )
    .plugin(tauri_plugin_notification::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      let show = MenuItem::with_id(app, "show", "Show Timeline", true, None::<&str>)?;
      let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
      let menu = Menu::with_items(app, &[&show, &quit])?;

      TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("Timeline")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
          "show" => {
            if let Some(window) = app.get_webview_window("main") {
              let _ = window.show();
              let _ = window.set_focus();
            }
          }
          "quit" => app.exit(0),
          _ => {}
        })
        .build(app)?;

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
