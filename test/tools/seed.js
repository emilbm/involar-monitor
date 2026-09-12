/**
 * Fills a database with plausible history so the dashboard can be exercised
 * without waiting months for real sun.
 *
 *   node test/tools/seed.js [days] [dbPath]
 *
 * Never point this at your real database.
 */
import { Store } from '../../src/store.js';
import { createClock } from '../../src/clock.js';

const days = Number(process.argv[2] ?? 120);
const dbPath = process.argv[3] ?? './data/seed.db';
const tz = process.env.TZ_NAME ?? 'Europe/Copenhagen';

const PEAK_W = 3600;
const STEP_S = 30;
const SERIALS = ['1a2b', '3c4d', '5e6f', 'aabb'];

const store = new Store({ dbPath, clock: createClock(tz), retentionDays: 0 });
store.open();

const now = Date.now();
let samples = 0;

for (let d = days - 1; d >= 0; d -= 1) {
  const dayStart = new Date(now - d * 86400_000);
  dayStart.setHours(0, 0, 0, 0);

  // Seasonal daylight and a per-day weather factor.
  const doy = Math.floor((dayStart - new Date(dayStart.getFullYear(), 0, 0)) / 86400_000);
  const season = 0.55 + 0.45 * Math.sin(((doy - 81) / 365) * 2 * Math.PI);
  const daylight = 8 + 8 * season;
  const sunrise = 12 - daylight / 2;
  const weather = 0.25 + 0.75 * Math.random() ** 0.6;

  let dayWh = 0;
  const endHour = d === 0 ? new Date(now).getHours() + 1 : 24;

  for (let h = Math.floor(sunrise); h < Math.min(endHour, sunrise + daylight); h += 1) {
    for (let s = 0; s < 3600; s += STEP_S) {
      const t = dayStart.getTime() + h * 3600_000 + s * 1000;
      if (t > now) break;

      const hour = h + s / 3600;
      const arc = Math.sin(((hour - sunrise) / daylight) * Math.PI);
      if (arc <= 0) continue;

      // Passing clouds, plus a little sensor noise.
      const cloud = 1 - 0.45 * Math.max(0, Math.sin(hour * 2.7 + doy) ** 4);
      const watts = Math.max(0, PEAK_W * season * weather * arc * cloud + (Math.random() - 0.5) * 40);

      store.recordPower(Math.round(watts * 10) / 10, new Date(t));
      dayWh += (watts * STEP_S) / 3600;
      samples += 1;
    }
  }

  // Each inverter carries a slightly different share of the array.
  SERIALS.forEach((serial, i) => {
    const share = [0.27, 0.26, 0.24, 0.23][i];
    store.recordInverterEnergy(serial, dayWh * share, new Date(dayStart.getTime() + 20 * 3600_000));
  });
}

console.log(`seeded ${samples.toLocaleString()} samples across ${days} days into ${dbPath}`);
console.log(store.stats());
store.close();
