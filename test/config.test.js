import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, parseMapping } from '../src/config.js';

const MIN = { PVOUTPUT_API_KEY: 'abc', PVOUTPUT_SYSTEM_ID: '12345' };

test('defaults cover both Egate ports', () => {
  assert.deepEqual(loadConfig({ ...MIN }).listen.ports, [1020, 9800]);
});

test('the post interval defaults inside the free-tier rate limit', () => {
  const cfg = loadConfig({ ...MIN }).pvoutput;
  const requestsPerHour = 3600 / (cfg.postIntervalMs / 1000);
  assert.ok(requestsPerHour <= cfg.rateLimitPerHour, `${requestsPerHour}/h exceeds the budget`);
});

test('missing credentials are rejected at startup, not at the first upload', () => {
  assert.throws(() => loadConfig({}), /PVOUTPUT_API_KEY is required/);
  assert.throws(() => loadConfig({ PVOUTPUT_API_KEY: 'a' }), /PVOUTPUT_SYSTEM_ID/);
  assert.throws(
    () => loadConfig({ PVOUTPUT_API_KEY: 'a', PVOUTPUT_SYSTEM_ID: 'not-a-number' }),
    /PVOUTPUT_SYSTEM_ID/,
  );
});

test('dry run does not require credentials', () => {
  assert.equal(loadConfig({ PVOUTPUT_DRY_RUN: 'true' }).pvoutput.dryRun, true);
});

test('micro-inverter mode without a mapping is a configuration error', () => {
  assert.throws(
    () => loadConfig({ ...MIN, PVOUTPUT_MICROINVERTER_MODE: 'true' }),
    /MAPPING is empty/,
  );
});

test('an unrecognised time zone is rejected', () => {
  assert.throws(() => loadConfig({ ...MIN, TZ: 'Mars/Olympus' }), /not a recognised IANA/);
});

test('bad numbers and ports are rejected with the variable name', () => {
  assert.throws(() => loadConfig({ ...MIN, LISTEN_PORTS: '1020,abc' }), /LISTEN_PORTS/);
  assert.throws(() => loadConfig({ ...MIN, HEALTH_PORT: '99999' }), /HEALTH_PORT/);
  assert.throws(() => loadConfig({ ...MIN, INVOLAR_RELAY: 'maybe' }), /INVOLAR_RELAY/);
});

test('mapping accepts JSON', () => {
  assert.deepEqual(parseMapping('{"1A2B":"111","3c4d":222}'), { '1a2b': '111', '3c4d': '222' });
});

test('mapping accepts the compact serial=systemId form', () => {
  assert.deepEqual(parseMapping('1a2b=111, 3c4d:222'), { '1a2b': '111', '3c4d': '222' });
});

test('mapping rejects malformed serials and system ids', () => {
  assert.throws(() => parseMapping('zzzz=111'), /4 hex digits/);
  assert.throws(() => parseMapping('1a2b=abc'), /must be numeric/);
  assert.throws(() => parseMapping('1a2b'), /serial=systemId/);
  assert.throws(() => parseMapping('{oops'), /not valid JSON/);
});

test('loadConfig does not leak the env object it was handed', () => {
  const before = process.env.PVOUTPUT_API_KEY;
  loadConfig({ ...MIN });
  assert.equal(process.env.PVOUTPUT_API_KEY, before);
});
