import { RESOLUTIONS } from '../store.js';

const DAY = 86400;

/** Add `n` days to a `YYYY-MM-DD` key, staying in calendar terms. */
export function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** ISO-8601 week key, `YYYY-Www`. Weeks start Monday. */
export function isoWeek(day) {
  const d = new Date(`${day}T00:00:00Z`);
  const dayNum = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // the Thursday of this week
  const year = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((d - firstThursday) / (7 * DAY * 1000));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export function startOfIsoWeek(day) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/**
 * Roll daily rows up into day / week / month buckets.
 * Aggregating in JS keeps the SQL simple: there is only one row per day, so
 * even a decade of history is a few thousand rows.
 */
export function summarise(rows, period) {
  const keyOf = {
    day: (r) => r.day,
    week: (r) => isoWeek(r.day),
    month: (r) => r.day.slice(0, 7),
  }[period];

  const buckets = new Map();
  for (const r of rows) {
    const key = keyOf(r);
    let b = buckets.get(key);
    if (!b) {
      b = { key, wh: 0, peakWatts: 0, peakAt: null, days: 0, from: r.day, to: r.day };
      buckets.set(key, b);
    }
    b.wh += r.wh;
    b.days += 1;
    b.from = b.from < r.day ? b.from : r.day;
    b.to = b.to > r.day ? b.to : r.day;
    if (r.max_watts > b.peakWatts) {
      b.peakWatts = r.max_watts;
      b.peakAt = r.max_ts;
    }
  }

  return [...buckets.values()].map((b) => ({
    ...b,
    kwh: b.wh / 1000,
    averageWhPerDay: b.days ? b.wh / b.days : 0,
  }));
}

/** Pick a resolution and bucket size that keep a chart under ~1200 points. */
export function planSeries({ from, to, resolution = 'auto' }) {
  const span = Math.max(1, to - from);
  if (resolution === 'auto') {
    if (span <= 3 * DAY) resolution = 'sample';
    else if (span <= 90 * DAY) resolution = 'hour';
    else resolution = 'day';
  }
  if (!RESOLUTIONS.includes(resolution)) {
    throw Object.assign(new Error(`resolution must be one of ${RESOLUTIONS.join(', ')}, or auto`), { status: 400 });
  }
  // Round the bucket to something a human recognises on the axis.
  const targetPoints = 900;
  const nice = [10, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const raw = span / targetPoints;
  const bucketSeconds = nice.find((n) => n >= raw) ?? 3600;
  return { resolution, bucketSeconds };
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bad(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/**
 * The JSON API. Handlers return plain objects; the HTTP layer serialises them.
 */
export function createApi({ store, clock, config, runtime, reporter }) {
  const label = (serial) => config.inverterLabels[serial] ?? null;

  return {
    /** Current output and today's running totals - polled by the dashboard. */
    live() {
      const now = new Date();
      const nowTs = Math.floor(now.getTime() / 1000);
      const latest = store.latest();
      const window = store.recentAverage(config.web.liveWindowSeconds, now);
      const today = store.dayTotal(clock.day(now));
      const ageSeconds = latest ? nowTs - latest.ts : null;

      let state = 'offline';
      if (runtime.connections > 0) state = 'live';
      if (ageSeconds !== null && ageSeconds > config.web.staleAfterSeconds) state = 'stale';
      else if (ageSeconds !== null && ageSeconds <= config.web.staleAfterSeconds) state = 'live';

      return {
        state,
        now: nowTs,
        timeZone: clock.timeZone,
        watts: latest?.watts ?? null,
        at: latest?.ts ?? null,
        ageSeconds,
        smoothedWatts: window?.average ?? null,
        windowSeconds: config.web.liveWindowSeconds,
        connections: runtime.connections,
        lastFrameAt: runtime.lastFrameAt,
        today: today
          ? {
            day: today.day,
            wh: today.wh,
            kwh: today.wh / 1000,
            peakWatts: today.max_watts,
            peakAt: today.max_ts,
            firstAt: today.first_ts,
            lastAt: today.last_ts,
            samples: today.samples,
          }
          : { day: clock.day(now), wh: 0, kwh: 0, peakWatts: 0, peakAt: null, samples: 0 },
        inverters: store.invertersForDay(clock.day(now)).map((r) => ({
          serial: r.serial, label: label(r.serial), wh: r.wh, updatedAt: r.updated_ts,
        })),
      };
    },

    /** Power over time. `from`/`to` are unix seconds. */
    series(query) {
      const now = Math.floor(Date.now() / 1000);
      const to = num(query.to, now);
      const from = num(query.from, to - DAY);
      if (from >= to) throw bad('`from` must be earlier than `to`');

      const plan = planSeries({ from, to, resolution: query.resolution ?? 'auto' });

      if (plan.resolution === 'day') {
        const rows = store.series({
          from: clock.day(new Date(from * 1000)),
          to: clock.day(new Date(to * 1000)),
          resolution: 'day',
        });
        return {
          ...plan,
          from,
          to,
          points: rows.points.map((p) => ({
            t: p.t ?? Math.floor(new Date(`${p.day}T12:00:00Z`).getTime() / 1000),
            w: p.w ?? 0,
            peak: p.peak ?? 0,
            wh: p.wh ?? 0,
            n: p.n ?? 0,
          })),
        };
      }

      const rows = store.series({ from, to, ...plan });
      return { ...plan, from, to, points: rows.points };
    },

    /** Day / week / month energy totals, newest bucket last. */
    summary(query) {
      const period = query.period ?? 'day';
      if (!['day', 'week', 'month'].includes(period)) {
        throw bad('`period` must be day, week or month');
      }
      const limit = Math.min(Math.max(num(query.limit, 30), 1), 400);

      const today = clock.day(new Date());
      // Reach back far enough that `limit` buckets can be filled.
      const lookback = { day: limit, week: limit * 7 + 7, month: limit * 31 + 31 }[period];
      const fromDay = query.from ?? addDays(today, -lookback);
      const toDay = query.to ?? today;

      const rows = store.days(fromDay, toDay);
      const buckets = summarise(rows, period);
      const kept = buckets.slice(-limit);

      return {
        period,
        timeZone: clock.timeZone,
        buckets: kept,
        total: {
          wh: kept.reduce((s, b) => s + b.wh, 0),
          days: kept.reduce((s, b) => s + b.days, 0),
          best: kept.reduce((best, b) => (!best || b.wh > best.wh ? b : best), null),
        },
      };
    },

    /** Per-inverter energy over a day range. */
    inverters(query) {
      const today = clock.day(new Date());
      const fromDay = query.from ?? today;
      const toDay = query.to ?? today;
      const rows = store.inverters(fromDay, toDay);
      const total = rows.reduce((s, r) => s + r.wh, 0);
      return {
        from: fromDay,
        to: toDay,
        total,
        inverters: rows.map((r) => ({
          serial: r.serial,
          label: label(r.serial),
          wh: r.wh,
          kwh: r.wh / 1000,
          share: total > 0 ? r.wh / total : 0,
          days: r.days,
          updatedAt: r.updated_ts,
        })),
      };
    },

    /** Everything about the running process, for the status page. */
    status() {
      return {
        ok: runtime.listening,
        uptimeSeconds: Math.round((Date.now() - runtime.startedAt) / 1000),
        timeZone: clock.timeZone,
        listenPorts: config.listen.ports,
        connections: runtime.connections,
        lastPeer: runtime.lastPeer,
        framesReceived: runtime.frames,
        bytesReceived: runtime.bytes,
        lastFrameAt: runtime.lastFrameAt,
        unknownFrames: runtime.unknownFrames,
        unlabelledSerials: [...runtime.seenSerials].filter((s) => !config.inverterLabels[s]),
        database: store.stats(),
        errorReporting: reporter?.stats() ?? { enabled: false },
      };
    },
  };
}
