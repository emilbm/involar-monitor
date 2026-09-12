/**
 * Online backup of the reading database.
 *
 *   node src/backup.js [destination]
 *
 * Uses SQLite's own backup API rather than copying the file, so the result is
 * consistent even though the database is in WAL mode and being written to.
 * Nothing has to stop.
 */
import { DatabaseSync, backup } from 'node:sqlite';
import path from 'node:path';
import { loadConfig } from './config.js';

const cfg = loadConfig();
const dest = process.argv[2]
  ?? path.join(cfg.dataDir, `solar-backup-${new Date().toISOString().slice(0, 10)}.db`);

const db = new DatabaseSync(cfg.db.path, { readOnly: true });
try {
  await backup(db, dest);
  process.stdout.write(`backed up ${cfg.db.path} -> ${dest}\n`);
} finally {
  db.close();
}
