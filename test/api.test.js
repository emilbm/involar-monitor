import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { Store } from '../src/store.js';
import { createClock } from '../src/clock.js';
import { createApi, summarise, isoWeek, addDays, planSeries } from '../src/web/api.js';

const TZ = 'Europe/Copenhagen';
const DAY = 86400;

function harness({ labels = {} } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'solar-api-'));
  const clock = createClock(TZ);
  const store = new Store({ dbPath: path.join(dir, 'api.db'), clock });
  store.open();

  const runtime = {
    startedAt: Date.now(), listening: true, connections: 1,
    bytes: 100, frames: 10, unknownFrames: 0, lastFrameAt: 123, lastPeer: '10.0.0.5:1',
    seenSerials: new Set(['1a2b', 'ffff']),
  };
  const config = {
    inverterLabels: labels,
    listen: { ports: [1020, 9800] },
    web: { liveWindowSeconds: 120, staleAfterSeconds: 300 },
  };
  return { store, clock, api: createApi({ store, clock, config, runtime }), runtime };
}

// ------------------------------------------------------------- date helpers

test('ISO week keys roll over the year correctly', () => {
  assert.equal(isoWeek('2026-01-01'), '2026-W01');
  assert.equal(isoWeek('2026-06-15'), '2026-W25');
  // 2027-01-01 is a Friday, so it belongs to the last week of 2026.
  assert.equal(isoWeek('2027-01-01'), '2026-W53');
});

test('addDays crosses month and year boundaries', () => {
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
});

// ----------------------------------------------------------------- planning

test('the resolution auto-scales with the span so charts stay readable', () => {
  assert.equal(planSeries({ from: 0, to: 3600, resolution: 'auto' }).resolution, 'sample');
  assert.equal(planSeries({ from: 0, to: 10 * DAY, resolution: 'auto' }).resolution, 'hour');
  assert.equal(planSeries({ from: 0, to: 365 * DAY, resolution: 'auto' }).resolution, 'day');
});

test('sample buckets land on values a human reads off an axis', () => {
  const nice = [10, 30, 60, 120, 300, 600, 900, 1800, 3600];
  for (const span of [3600, 6 * 3600, DAY, 2 * DAY]) {
    const { bucketSeconds } = planSeries({ from: 0, to: span, resolution: 'sample' });
    assert.ok(nice.includes(bucketSeconds), `${bucketSeconds}s is not a round interval`);
  }
});

test('an unknown resolution is a 400, not a silent fallback', () => {
  assert.throws(
    () => planSeries({ from: 0, to: 100, resolution: 'fortnight' }),
    (err) => err.status === 400,
  );
});

// --------------------------------------------------------------- summarise

const DAYS = [
  { day: '2026-06-01', wh: 1000, max_watts: 500, max_ts: 1 }, // Monday
  { day: '2026-06-02', wh: 2000, max_watts: 900, max_ts: 2 },
  { day: '2026-06-08', wh: 3000, max_watts: 700, max_ts: 3 }, // the next Monday
  { day: '2026-07-01', wh: 4000, max_watts: 1100, max_ts: 4 },
];

test('daily summaries pass each day through untouched', () => {
  const out = summarise(DAYS, 'day');
  assert.equal(out.length, 4);
  assert.deepEqual(out.map((b) => b.wh), [1000, 2000, 3000, 4000]);
});

test('weekly summaries group by ISO week and keep the week that peaked', () => {
  const out = summarise(DAYS, 'week');
  assert.equal(out.length, 3);
  assert.equal(out[0].wh, 3000, 'the first two days share a week');
  assert.equal(out[0].days, 2);
  assert.equal(out[0].peakWatts, 900);
  assert.equal(out[0].from, '2026-06-01');
  assert.equal(out[0].to, '2026-06-02');
});

test('monthly summaries group by calendar month', () => {
  const out = summarise(DAYS, 'month');
  assert.deepEqual(out.map((b) => [b.key, b.wh]), [['2026-06', 6000], ['2026-07', 4000]]);
});

test('an empty range summarises to nothing rather than a zero bucket', () => {
  assert.deepEqual(summarise([], 'week'), []);
});

// -------------------------------------------------------------- endpoints

test('live reports the latest reading, a smoothed value and today so far', () => {
  const { api, store } = harness();
  const now = new Date();
  store.recordPower(1000, new Date(now.getTime() - 60_000));
  store.recordPower(2000, now);

  const live = api.live();
  assert.equal(live.watts, 2000, 'the raw latest reading');
  assert.equal(live.smoothedWatts, 1500, 'the mean across the live window');
  assert.equal(live.state, 'live');
  assert.equal(live.timeZone, TZ);
  assert.ok(live.today.wh > 0);
  store.close();
});

test('live reports stale when the readings stop, without any data loss', () => {
  const { api, store } = harness();
  store.recordPower(1500, new Date(Date.now() - 3600_000));

  const live = api.live();
  assert.equal(live.state, 'stale');
  assert.ok(live.ageSeconds > 300);
  assert.equal(live.watts, 1500, 'the last known reading is still reported');
  store.close();
});

test('live works on a cold database instead of throwing', () => {
  const { api, store } = harness();
  const live = api.live();
  assert.equal(live.watts, null);
  assert.equal(live.today.wh, 0);
  assert.deepEqual(live.inverters, []);
  store.close();
});

test('live carries per-inverter energy, labelled where a label exists', () => {
  const { api, store } = harness({ labels: { '1a2b': 'Roof south' } });
  store.recordInverterEnergy('1a2b', 4200);
  store.recordInverterEnergy('3c4d', 3900);

  const byLabel = Object.fromEntries(api.live().inverters.map((i) => [i.serial, i.label]));
  assert.equal(byLabel['1a2b'], 'Roof south');
  assert.equal(byLabel['3c4d'], null, 'an unlabelled inverter still appears');
  store.close();
});

test('series rejects a backwards range', () => {
  const { api, store } = harness();
  assert.throws(() => api.series({ from: 200, to: 100 }), /earlier than/);
  store.close();
});

test('series returns bucketed points inside the requested window', () => {
  const { api, store } = harness();
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 30; i += 1) {
    store.recordPower(i * 50, new Date((now - i * 60) * 1000));
  }

  const out = api.series({ from: now - 1800, to: now });
  assert.equal(out.resolution, 'sample');
  assert.ok(out.points.length > 0);
  assert.ok(out.points.every((p) => p.t >= out.from - out.bucketSeconds && p.t <= out.to));
  assert.ok(out.points.every((p) => Number.isFinite(p.w)));
  store.close();
});

test('summary honours the limit and reports the best bucket', () => {
  const { api, store, clock } = harness();
  const today = clock.day(new Date());
  for (let i = 0; i < 5; i += 1) {
    const d = new Date(Date.now() - i * DAY * 1000);
    store.recordPower(1000, d);
    store.recordPower(1000 + i * 200, new Date(d.getTime() + 600_000));
  }

  const out = api.summary({ period: 'day', limit: 3 });
  assert.equal(out.buckets.length, 3, 'only the requested number of buckets');
  assert.equal(out.buckets.at(-1).key, today, 'newest bucket last');
  assert.ok(out.total.best.wh >= out.buckets[0].wh);
  store.close();
});

test('summary rejects an unknown period', () => {
  const { api, store } = harness();
  assert.throws(() => api.summary({ period: 'fortnight' }), (err) => err.status === 400);
  store.close();
});

test('inverters reports each share of the range total', () => {
  const { api, store, clock } = harness({ labels: { '1a2b': 'Roof south' } });
  store.recordInverterEnergy('1a2b', 3000);
  store.recordInverterEnergy('3c4d', 1000);

  const out = api.inverters({ from: clock.day(new Date()), to: clock.day(new Date()) });
  assert.equal(out.total, 4000);
  assert.equal(out.inverters[0].serial, '1a2b');
  assert.equal(out.inverters[0].share, 0.75);
  assert.equal(out.inverters[0].label, 'Roof south');
  store.close();
});

test('status surfaces the serials that have no label yet', () => {
  const { api, store } = harness({ labels: { '1a2b': 'Roof south' } });
  assert.deepEqual(api.status().unlabelledSerials, ['ffff']);
  assert.equal(api.status().ok, true);
  store.close();
});
