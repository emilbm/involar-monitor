import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { PvOutputClient } from '../src/pvoutput.js';

function baseCfg(over = {}) {
  return {
    apiKey: 'k', systemId: '1', baseUrl: 'https://pvoutput.test/service/r2',
    dryRun: false, rateLimitPerHour: 60, maxQueueAgeMs: 24 * 3600 * 1000, ...over,
  };
}

function response(status, { body = 'OK', headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => body,
  };
}

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'i2pv-'));
}

test('a single reading is posted to addstatus with the reading\'s own timestamp', async () => {
  const calls = [];
  const client = new PvOutputClient(baseCfg(), {
    dataDir: await tmpDir(),
    fetchImpl: async (url, init) => { calls.push({ url, init }); return response(200); },
  });

  client.enqueue('1', { date: '20260912', time: '10:05', power: 1234.5 });
  await client.flush();

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /addstatus\.jsp$/);
  assert.equal(calls[0].init.headers['X-Pvoutput-SystemId'], '1');
  assert.equal(calls[0].init.headers['X-Pvoutput-Apikey'], 'k');

  const body = new URLSearchParams(calls[0].init.body.toString());
  assert.equal(body.get('d'), '20260912');
  assert.equal(body.get('t'), '10:05');
  assert.equal(body.get('v2'), '1234.5');
  assert.equal(body.get('v1'), null, 'energy should be omitted when not supplied');
  assert.equal(client.stats().queued, 0);
});

test('a backlog for one system is sent as a single batch request', async () => {
  const calls = [];
  const client = new PvOutputClient(baseCfg(), {
    dataDir: await tmpDir(),
    fetchImpl: async (url, init) => { calls.push({ url, init }); return response(200); },
  });

  client.enqueue('1', { date: '20260912', time: '10:10', power: 200 });
  client.enqueue('1', { date: '20260912', time: '10:00', power: 100 });
  await client.flush();

  assert.equal(calls.length, 1, 'three readings must not cost three requests');
  assert.match(calls[0].url, /addbatchstatus\.jsp$/);
  const data = new URLSearchParams(calls[0].init.body.toString()).get('data');
  assert.equal(data, '20260912,10:00,,100;20260912,10:10,,200', 'sorted oldest first');
});

test('a reading for a timestamp already queued replaces it instead of duplicating', async () => {
  const client = new PvOutputClient(baseCfg({ dryRun: true }), { dataDir: await tmpDir() });
  client.enqueue('1', { date: '20260912', time: '10:00', power: 100 });
  client.enqueue('1', { date: '20260912', time: '10:00', power: 150 });
  assert.equal(client.stats().queued, 1);
});

test('a network failure keeps the reading queued and backs off', async () => {
  let attempts = 0;
  const client = new PvOutputClient(baseCfg(), {
    dataDir: await tmpDir(),
    fetchImpl: async () => { attempts += 1; throw new Error('ECONNREFUSED'); },
  });

  client.enqueue('1', { date: '20260912', time: '10:00', power: 100 });
  await client.flush();

  assert.equal(attempts, 1);
  assert.equal(client.stats().queued, 1, 'the reading must survive the failure');
  assert.equal(client.stats().consecutiveFailures, 1);
  assert.ok(client.stats().pausedUntil > Date.now(), 'backoff should be armed');

  // Still paused, so a second flush must not hammer the API.
  await client.flush();
  assert.equal(attempts, 1);
});

test('a queued reading survives a restart and is posted with its original time', async () => {
  const dataDir = await tmpDir();
  const failing = new PvOutputClient(baseCfg(), {
    dataDir,
    fetchImpl: async () => { throw new Error('offline'); },
  });
  failing.enqueue('1', { date: '20260912', time: '09:45', power: 321 });
  await failing.flush();
  await failing.stop();

  const calls = [];
  const restarted = new PvOutputClient(baseCfg(), {
    dataDir,
    fetchImpl: async (url, init) => { calls.push(init); return response(200); },
  });
  await restarted.start();
  await restarted.flush();
  await restarted.stop();

  assert.equal(calls.length, 1);
  const body = new URLSearchParams(calls[0].body.toString());
  assert.equal(body.get('t'), '09:45', 'must not be re-stamped with the upload time');
  assert.equal(body.get('v2'), '321');
});

test('a 403 pauses uploads until the rate-limit reset the server reports', async () => {
  const resetAt = Math.floor(Date.now() / 1000) + 600;
  const client = new PvOutputClient(baseCfg(), {
    dataDir: await tmpDir(),
    fetchImpl: async () => response(403, {
      body: 'Forbidden el: Exceeded 60 requests per hour',
      headers: { 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': String(resetAt) },
    }),
  });

  client.enqueue('1', { date: '20260912', time: '10:00', power: 100 });
  await client.flush();

  const s = client.stats();
  assert.equal(s.queued, 1, 'the reading is retried, not thrown away');
  assert.equal(s.rateLimitRemaining, 0);
  assert.equal(s.pausedUntil, resetAt * 1000);
});

test('a 400 discards the reading rather than retrying forever', async () => {
  const client = new PvOutputClient(baseCfg(), {
    dataDir: await tmpDir(),
    fetchImpl: async () => response(400, { body: 'Bad request: Date is too far in the past' }),
  });

  client.enqueue('1', { date: '20200101', time: '10:00', power: 100 });
  await client.flush();

  assert.equal(client.stats().queued, 0);
  assert.equal(client.stats().dropped, 1);
});

test('readings older than the back-fill window are dropped, not posted', async () => {
  let called = false;
  const client = new PvOutputClient(baseCfg({ maxQueueAgeMs: 1000 }), {
    dataDir: await tmpDir(),
    fetchImpl: async () => { called = true; return response(200); },
  });

  client.enqueue('1', { date: '20260912', time: '10:00', power: 100 });
  client.now = () => Date.now() + 60_000;
  await client.flush();

  assert.equal(called, false);
  assert.equal(client.stats().queued, 0);
  assert.equal(client.stats().dropped, 1);
});

test('dry run queues and clears readings without touching the network', async () => {
  let called = false;
  const client = new PvOutputClient(baseCfg({ dryRun: true }), {
    dataDir: await tmpDir(),
    fetchImpl: async () => { called = true; return response(200); },
  });

  client.enqueue('1', { date: '20260912', time: '10:00', power: 100 });
  await client.flush();

  assert.equal(called, false);
  assert.equal(client.stats().queued, 0);
});
