const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()
  .map((r) => r.name);
console.log('tables:', tables.join(', '));
console.log('activities:', JSON.stringify(db.prepare('SELECT * FROM activities').all(), null, 2));
console.log(
  'counts:',
  JSON.stringify(
    db
      .prepare(
        'SELECT (SELECT COUNT(*) FROM scheduled_blocks) AS blocks, (SELECT COUNT(*) FROM time_entries) AS entries',
      )
      .get(),
  ),
);
