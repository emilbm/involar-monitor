import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('store');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS samples (
  ts    INTEGER PRIMARY KEY,        -- unix seconds
  watts REAL NOT NULL
);

-- Rollups let long-range charts stay fast and keep working after raw samples
-- are pruned. Both are maintained incrementally as readings arrive.
CREATE TABLE IF NOT EXISTS hourly (
  hour      TEXT PRIMARY KEY,       -- YYYY-MM-DDTHH, local time
  hour_ts   INTEGER NOT NULL,       -- unix seconds at the start of that hour
  day       TEXT NOT NULL,
  sum_watts REAL NOT NULL DEFAULT 0,
  samples   INTEGER NOT NULL DEFAULT 0,
  max_watts REAL NOT NULL DEFAULT 0,
  wh        REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS hourly_ts ON hourly(hour_ts);
CREATE INDEX IF NOT EXISTS hourly_day ON hourly(day);

CREATE TABLE IF NOT EXISTS daily (
  day       TEXT PRIMARY KEY,       -- YYYY-MM-DD, local time
  wh        REAL NOT NULL DEFAULT 0,
  max_watts REAL NOT NULL DEFAULT 0,
  max_ts    INTEGER,
  samples   INTEGER NOT NULL DEFAULT 0,
  first_ts  INTEGER,
  last_ts   INTEGER
);

-- What each micro-inverter reported as its own running total for the day.
CREATE TABLE IF NOT EXISTS inverter_daily (
  day        TEXT NOT NULL,
  serial     TEXT NOT NULL,
  wh         REAL NOT NULL,
  updated_ts INTEGER NOT NULL,
  PRIMARY KEY (day, serial)
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export const RESOLUTIONS = ['sample', 'hour', 'day'];

/**
 * Everything that touches the database.
 *
 * The data is a nice-to-have, not a ledger: WAL plus NORMAL sync is the right
 * trade here. A corrupt file costs you history, never the live readings.
 */
export class Store {
  #db;
  #stmt = {};
  #last = null; // { ts, watts } - the previous sample, for energy integration

  constructor({ dbPath, clock, maxGapSeconds = 900, retentionDays = 400 }) {
    this.dbPath = dbPath;
    this.clock = clock;
    this.maxGapSeconds = maxGapSeconds;
    this.retentionDays = retentionDays;
  }

  open() {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.#db = new DatabaseSync(this.dbPath);
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA synchronous = NORMAL');
    this.#db.exec('PRAGMA busy_timeout = 5000');
    this.#db.exec(SCHEMA);
    this.#prepare();

    const last = this.#db.prepare('SELECT ts, watts FROM samples ORDER BY ts DESC LIMIT 1').get();
    if (last) this.#last = { ts: last.ts, watts: last.watts };

    log.info('database ready', {
      path: this.dbPath,
      samples: this.count('samples'),
      days: this.count('daily'),
    });
  }

  close() {
    try { this.#db?.close(); } catch { /* already closed */ }
    this.#db = null;
  }

  count(table) {
    return this.#db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  }

  #prepare() {
    const s = this.#stmt;
    s.insertSample = this.#db.prepare(
      'INSERT INTO samples (ts, watts) VALUES (?, ?) ON CONFLICT(ts) DO UPDATE SET watts = excluded.watts',
    );
    s.upsertHourly = this.#db.prepare(`
      INSERT INTO hourly (hour, hour_ts, day, sum_watts, samples, max_watts, wh)
      VALUES (?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(hour) DO UPDATE SET
        sum_watts = sum_watts + excluded.sum_watts,
        samples   = samples + 1,
        max_watts = MAX(max_watts, excluded.max_watts),
        wh        = wh + excluded.wh
    `);
    s.upsertDaily = this.#db.prepare(`
      INSERT INTO daily (day, wh, max_watts, max_ts, samples, first_ts, last_ts)
      VALUES (?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(day) DO UPDATE SET
        wh        = wh + excluded.wh,
        max_ts    = CASE WHEN excluded.max_watts > max_watts THEN excluded.max_ts ELSE max_ts END,
        max_watts = MAX(max_watts, excluded.max_watts),
        samples   = samples + 1,
        last_ts   = excluded.last_ts
    `);
    s.upsertInverter = this.#db.prepare(`
      INSERT INTO inverter_daily (day, serial, wh, updated_ts)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(day, serial) DO UPDATE SET
        -- The inverter reports a running total for the day, so it only climbs.
        -- MAX() keeps one glitched low reading from erasing the day.
        wh         = MAX(wh, excluded.wh),
        updated_ts = excluded.updated_ts
    `);
  }

  // ------------------------------------------------------------------ writes

  /**
   * Record one instantaneous power reading.
   *
   * Any finite wattage is accepted as-is - this feeds one household's own
   * dashboard, so there is nothing to guard against.
   *
   * @returns {{ts:number, watts:number, wh:number}|null}
   */
  recordPower(watts, at = new Date()) {
    if (!Number.isFinite(watts)) return null;

    const ts = Math.floor(at.getTime() / 1000);
    const day = this.clock.day(at);
    const hour = this.clock.hour(at);
    const hourTs = this.clock.hourStart(at);

    // Trapezoidal integration against the previous sample. A gap longer than
    // maxGapSeconds (overnight, an outage) contributes nothing, so a restart
    // cannot invent energy that was never generated.
    let wh = 0;
    if (this.#last) {
      const dt = ts - this.#last.ts;
      if (dt > 0 && dt <= this.maxGapSeconds) {
        wh = ((this.#last.watts + watts) / 2) * (dt / 3600);
      }
    }

    this.#db.exec('BEGIN');
    try {
      this.#stmt.insertSample.run(ts, watts);
      this.#stmt.upsertHourly.run(hour, hourTs, day, watts, watts, wh);
      this.#stmt.upsertDaily.run(day, wh, watts, ts, ts, ts);
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }

    this.#last = { ts, watts };
    return { ts, watts, wh };
  }

  /** Record a micro-inverter's running energy total for the day. */
  recordInverterEnergy(serial, wh, at = new Date()) {
    if (!Number.isFinite(wh) || wh < 0) return false;
    this.#stmt.upsertInverter.run(
      this.clock.day(at), serial, wh, Math.floor(at.getTime() / 1000),
    );
    return true;
  }

  /** Delete raw samples past the retention window. Rollups are kept forever. */
  prune(now = new Date()) {
    if (!this.retentionDays) return 0;
    const cutoff = Math.floor(now.getTime() / 1000) - this.retentionDays * 86400;
    const { changes } = this.#db.prepare('DELETE FROM samples WHERE ts < ?').run(cutoff);
    if (changes > 0) log.info('pruned old raw samples', { deleted: Number(changes), cutoff });
    return Number(changes);
  }

  // ------------------------------------------------------------------- reads

  latest() {
    return this.#db.prepare('SELECT ts, watts FROM samples ORDER BY ts DESC LIMIT 1').get() ?? null;
  }

  /** Mean wattage over the trailing `seconds`, or null if nothing was recorded. */
  recentAverage(seconds, now = new Date()) {
    const from = Math.floor(now.getTime() / 1000) - seconds;
    const row = this.#db
      .prepare('SELECT AVG(watts) AS avg, COUNT(*) AS n, MAX(watts) AS max FROM samples WHERE ts >= ?')
      .get(from);
    return row?.n ? { average: row.avg, max: row.max, samples: row.n } : null;
  }

  dayTotal(day) {
    return this.#db.prepare(
      'SELECT day, wh, max_watts, max_ts, samples, first_ts, last_ts FROM daily WHERE day = ?',
    ).get(day) ?? null;
  }

  days(fromDay, toDay) {
    return this.#db.prepare(
      'SELECT day, wh, max_watts, max_ts, samples FROM daily WHERE day BETWEEN ? AND ? ORDER BY day',
    ).all(fromDay, toDay);
  }

  /** The oldest and newest day with any data, for the UI's range limits. */
  span() {
    const row = this.#db.prepare('SELECT MIN(day) AS first, MAX(day) AS last FROM daily').get();
    return row?.first ? { first: row.first, last: row.last } : null;
  }

  /**
   * Power over time at one of three resolutions. Each point carries the mean
   * and the peak for its bucket, so smoothing never hides a real spike.
   *
   * @returns {{resolution:string, bucketSeconds:number, points:Array}}
   */
  series({ from, to, resolution, bucketSeconds }) {
    if (resolution === 'sample') {
      const b = Math.max(1, Math.floor(bucketSeconds));
      // node:sqlite binds JS numbers as REAL, so `ts / ?` would be floating
      // division and every sample would land in its own bucket. CAST forces
      // the integer division the bucketing depends on.
      const points = this.#db.prepare(`
        SELECT (ts / CAST(? AS INTEGER)) * CAST(? AS INTEGER) AS t,
               AVG(watts) AS w, MAX(watts) AS peak, COUNT(*) AS n
        FROM samples WHERE ts >= ? AND ts <= ?
        GROUP BY t ORDER BY t
      `).all(b, b, from, to);
      return { resolution, bucketSeconds: b, points };
    }

    if (resolution === 'hour') {
      const points = this.#db.prepare(`
        SELECT hour_ts AS t,
               CASE WHEN samples > 0 THEN sum_watts / samples ELSE 0 END AS w,
               max_watts AS peak, samples AS n, wh
        FROM hourly WHERE hour_ts >= ? AND hour_ts <= ? ORDER BY hour_ts
      `).all(from, to);
      return { resolution, bucketSeconds: 3600, points };
    }

    // Daily: mean wattage across the whole 24h, plus the day's peak.
    const points = this.#db.prepare(`
      SELECT d.day, MIN(h.hour_ts) AS t, d.wh / 24.0 AS w, d.max_watts AS peak, d.samples AS n, d.wh
      FROM daily d LEFT JOIN hourly h ON h.day = d.day
      WHERE d.day BETWEEN ? AND ?
      GROUP BY d.day ORDER BY d.day
    `).all(from, to);
    return { resolution, bucketSeconds: 86400, points };
  }

  /** Per-inverter energy across a day range. */
  inverters(fromDay, toDay) {
    return this.#db.prepare(`
      SELECT serial, SUM(wh) AS wh, MAX(updated_ts) AS updated_ts, COUNT(*) AS days
      FROM inverter_daily WHERE day BETWEEN ? AND ?
      GROUP BY serial ORDER BY wh DESC
    `).all(fromDay, toDay);
  }

  invertersForDay(day) {
    return this.#db.prepare(
      'SELECT serial, wh, updated_ts FROM inverter_daily WHERE day = ? ORDER BY serial',
    ).all(day);
  }

  stats() {
    return {
      path: this.dbPath,
      sizeBytes: fs.existsSync(this.dbPath) ? fs.statSync(this.dbPath).size : 0,
      samples: this.count('samples'),
      hours: this.count('hourly'),
      days: this.count('daily'),
      span: this.span(),
    };
  }
}
