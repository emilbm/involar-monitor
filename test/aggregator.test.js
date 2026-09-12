import test from 'node:test';
import assert from 'node:assert/strict';
import { PowerWindow, InverterTotals } from '../src/aggregator.js';

test('the window averages the samples it holds', () => {
  let t = 1_000_000;
  const w = new PowerWindow(300_000, () => t);
  w.add(100, t); t += 1000;
  w.add(200, t); t += 1000;
  w.add(300, t);

  assert.deepEqual(w.summarise(), { count: 3, average: 200, latest: 300 });
});

test('samples outside the window are pruned (regression: splice during forEach)', () => {
  let t = 1_000_000;
  const w = new PowerWindow(60_000, () => t);
  // Three consecutive stale samples: the original code skipped every other one.
  w.add(1, t); w.add(2, t + 1); w.add(3, t + 2);
  w.add(400, t + 70_000);

  t += 70_000;
  assert.deepEqual(w.summarise(), { count: 1, average: 400, latest: 400 });
});

test('an empty window reports nothing rather than zero', () => {
  const w = new PowerWindow(60_000);
  assert.equal(w.summarise(), null, 'a zero reading at night would be a lie, not a datum');
});

test('non-numeric readings are ignored', () => {
  const w = new PowerWindow(60_000);
  w.add(Number.NaN);
  w.add(undefined);
  assert.equal(w.size, 0);
});

test('only the newest total per inverter is kept', () => {
  const t = new InverterTotals();
  t.record('1a2b', 900);
  t.record('1a2b', 1100);
  t.record('3c4d', 800);

  const drained = t.drain().sort((a, b) => a.serial.localeCompare(b.serial));
  assert.deepEqual(drained.map((d) => [d.serial, d.energyWh]), [['1a2b', 1100], ['3c4d', 800]]);
});

test('draining clears the totals so an idle interval publishes nothing', () => {
  const t = new InverterTotals();
  t.record('1a2b', 900);
  assert.equal(t.drain().length, 1);
  assert.equal(t.drain().length, 0);
});

test('zero and invalid energy totals are rejected', () => {
  const t = new InverterTotals();
  assert.equal(t.record('1a2b', 0), false);
  assert.equal(t.record('1a2b', Number.NaN), false);
  assert.equal(t.size, 0);
});
