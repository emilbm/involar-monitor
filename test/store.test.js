import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { Store } from '../src/store.js';
import { createClock } from '../src/clock.js';

const TZ = 'Europe/Copenhagen';

function newStore(opts = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'solar-'));
  const store = new Store({
    dbPath: path.join(dir, 'test.db'),
    clock: createClock(TZ),
    ...opts,
  });
  store.open();
  return store;
}

/** A local-time instant in the configured zone. */
function at(iso) {
  return new Date(iso);
}

test('a reading is stored verbatim - any wattage is accepted', () => {
  const store = newStore();
  for (const w of [0, 1, 4321.5, 99999, -25]) {
    const ts = store.recordPower(w, at('2026-06-01T10:00:00Z'));
    assert.equal(ts.watts, w);
  }
  assert.equal(store.latest().watts, -25);
  store.close();
});

test('non-numeric readings are ignored rather than corrupting the day', () => {
  const store = newStore();
  assert.equal(store.recordPower(Number.NaN), null);
  assert.equal(store.recordPower(undefined), null);
  assert.equal(store.latest(), null);
  store.close();
});

test('energy is integrated trapezoidally between consecutive readings', () => {
  const store = newStore();
  // 1000 W held for one hour == 1000 Wh.
  store.recordPower(1000, at('2026-06-01T08:00:00Z'));
  store.recordPower(1000, at('2026-06-01T08:10:00Z'));
  store.recordPower(1000, at('2026-06-01T08:20:00Z'));

  const day = store.dayTotal('2026-06-01');
  assert.ok(Math.abs(day.wh - 1000 / 3) < 0.001, `got ${day.wh} Wh for 20 minutes at 1 kW`);
  store.close();
});

test('a ramp integrates to the mean of its endpoints', () => {
  const store = newStore();
  store.recordPower(0, at('2026-06-01T08:00:00Z'));
  store.recordPower(2000, at('2026-06-01T08:10:00Z')); // mean 1000 W for 10 min

  assert.ok(Math.abs(store.dayTotal('2026-06-01').wh - 1000 / 6) < 0.001);
  store.close();
});

test('a long gap contributes no energy, so an outage cannot invent generation', () => {
  const store = newStore({ maxGapSeconds: 900 });
  store.recordPower(2000, at('2026-06-01T08:00:00Z'));
  store.recordPower(2000, at('2026-06-01T14:00:00Z')); // six hours later

  assert.equal(store.dayTotal('2026-06-01').wh, 0);
  store.close();
});

test('days are bucketed in local time, not UTC', () => {
  const store = newStore();
  // 22:30 UTC on 1 June is 00:30 on 2 June in Copenhagen (CEST).
  store.recordPower(500, at('2026-06-01T22:30:00Z'));
  assert.equal(store.dayTotal('2026-06-02')?.samples, 1);
  assert.equal(store.dayTotal('2026-06-01'), null);
  store.close();
});

test('the daily peak records both the value and when it happened', () => {
  const store = newStore();
  store.recordPower(800, at('2026-06-01T08:00:00Z'));
  store.recordPower(2400, at('2026-06-01T08:05:00Z'));
  store.recordPower(900, at('2026-06-01T08:10:00Z'));

  const day = store.dayTotal('2026-06-01');
  assert.equal(day.max_watts, 2400);
  assert.equal(day.max_ts, Math.floor(at('2026-06-01T08:05:00Z').getTime() / 1000));
  store.close();
});

test('hourly rollups carry the mean, the peak and the energy for the hour', () => {
  const store = newStore();
  store.recordPower(1000, at('2026-06-01T08:00:00Z'));
  store.recordPower(3000, at('2026-06-01T08:10:00Z'));

  const { points } = store.series({ from: 0, to: 4e9, resolution: 'hour' });
  assert.equal(points.length, 1, 'both readings fall in the same local hour');
  assert.equal(points[0].w, 2000, 'mean of the two readings');
  assert.equal(points[0].peak, 3000);
  // Mean 2000 W across 10 minutes.
  assert.ok(Math.abs(points[0].wh - 2000 / 6) < 0.001, `got ${points[0].wh} Wh`);
  store.close();
});

test('sample series buckets by the requested width and reports each bucket peak', () => {
  const store = newStore();
  const base = Date.parse('2026-06-01T08:00:00Z') / 1000;
  for (let i = 0; i < 12; i += 1) {
    store.recordPower(i * 100, new Date((base + i * 60) * 1000));
  }

  const { points } = store.series({
    from: base, to: base + 3600, resolution: 'sample', bucketSeconds: 300,
  });
  assert.equal(points.length, 3, 'twelve minutes into five-minute buckets');
  assert.equal(points[0].w, 200);   // 0..400 mean
  assert.equal(points[0].peak, 400);
  store.close();
});

test('inverter totals climb with the day and survive a glitched low reading', () => {
  const store = newStore();
  const t = at('2026-06-01T10:00:00Z');
  store.recordInverterEnergy('1a2b', 1200, t);
  store.recordInverterEnergy('1a2b', 3400, t);
  store.recordInverterEnergy('1a2b', 12, t); // a dropout mid-afternoon

  assert.equal(store.invertersForDay('2026-06-01')[0].wh, 3400);
  store.close();
});

test('inverter energy sums across a day range', () => {
  const store = newStore();
  store.recordInverterEnergy('1a2b', 4000, at('2026-06-01T10:00:00Z'));
  store.recordInverterEnergy('1a2b', 3000, at('2026-06-02T10:00:00Z'));
  store.recordInverterEnergy('3c4d', 1000, at('2026-06-02T10:00:00Z'));

  const rows = store.inverters('2026-06-01', '2026-06-02');
  assert.deepEqual(rows.map((r) => [r.serial, r.wh]), [['1a2b', 7000], ['3c4d', 1000]]);
  store.close();
});

test('pruning drops raw samples but keeps the rollups the charts fall back to', () => {
  const store = newStore({ retentionDays: 30 });
  // Snapped to five past the hour so the second reading cannot roll into the
  // next hourly bucket and make the assertion below depend on the clock.
  const old = new Date(Math.floor((Date.now() - 90 * 86400_000) / 3600_000) * 3600_000 + 300_000);
  store.recordPower(1500, old);
  store.recordPower(1500, new Date(old.getTime() + 60_000));
  const day = store.clock.day(old);

  assert.equal(store.count('samples'), 2);
  store.prune();

  assert.equal(store.count('samples'), 0, 'raw samples past the window are gone');
  assert.ok(store.dayTotal(day).wh > 0, 'the daily total survives');
  assert.equal(store.count('hourly'), 1);
  store.close();
});

test('retention of 0 disables pruning entirely', () => {
  const store = newStore({ retentionDays: 0 });
  store.recordPower(1500, new Date(Date.now() - 5 * 365 * 86400_000));
  store.prune();
  assert.equal(store.count('samples'), 1);
  store.close();
});

test('reopening the database picks the integration back up where it left off', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'solar-'));
  const dbPath = path.join(dir, 'reopen.db');
  const opts = { dbPath, clock: createClock(TZ) };

  const first = new Store(opts);
  first.open();
  first.recordPower(1000, at('2026-06-01T08:00:00Z'));
  first.close();

  const second = new Store(opts);
  second.open();
  second.recordPower(1000, at('2026-06-01T08:10:00Z'));
  second.close();

  const third = new Store(opts);
  third.open();
  assert.ok(
    Math.abs(third.dayTotal('2026-06-01').wh - 1000 / 6) < 0.001,
    'the gap across the restart is still integrated',
  );
  third.close();
});
