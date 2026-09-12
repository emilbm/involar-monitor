import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, parseLabels } from '../src/config.js';

test('defaults cover both Egate ports', () => {
  assert.deepEqual(loadConfig({}).listen.ports, [1020, 9800]);
});

test('the database lands inside the data directory by default', () => {
  const cfg = loadConfig({ DATA_DIR: '/var/lib/solar' });
  assert.match(cfg.db.path, /solar\.db$/);
  assert.match(cfg.db.path, /var[/\\]lib[/\\]solar/);
});

test('DB_PATH overrides the derived location', () => {
  assert.equal(loadConfig({ DB_PATH: '/tmp/x.db' }).db.path, '/tmp/x.db');
});

test('an unrecognised time zone is rejected at startup', () => {
  assert.throws(() => loadConfig({ TZ: 'Mars/Olympus' }), /not a recognised IANA/);
});

test('bad numbers, ports and booleans are rejected with the variable name', () => {
  assert.throws(() => loadConfig({ LISTEN_PORTS: '1020,abc' }), /LISTEN_PORTS/);
  assert.throws(() => loadConfig({ WEB_PORT: '99999' }), /WEB_PORT/);
  assert.throws(() => loadConfig({ INVOLAR_RELAY: 'maybe' }), /INVOLAR_RELAY/);
  assert.throws(() => loadConfig({ SAMPLE_RETENTION_DAYS: '-1' }), /SAMPLE_RETENTION_DAYS/);
});

test('retention can be disabled with 0', () => {
  assert.equal(loadConfig({ SAMPLE_RETENTION_DAYS: '0' }).db.retentionDays, 0);
});

test('inverter labels accept the compact form, JSON, and names with spaces', () => {
  assert.deepEqual(parseLabels('1a2b=Roof south, 3c4d=Garage'), {
    '1a2b': 'Roof south', '3c4d': 'Garage',
  });
  assert.deepEqual(parseLabels('{"1A2B":"Roof south"}'), { '1a2b': 'Roof south' });
});

test('malformed inverter labels are rejected', () => {
  assert.throws(() => parseLabels('zzzz=Roof'), /4 hex digits/);
  assert.throws(() => parseLabels('1a2b'), /serial=Name/);
  assert.throws(() => parseLabels('{oops'), /not valid JSON/);
});

test('no credentials are required any more - the app runs with an empty env', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.web.enabled, true);
  assert.equal(cfg.relay.enabled, false);
});

test('loadConfig does not leak the env object it was handed', () => {
  const before = process.env.LISTEN_PORTS;
  loadConfig({ LISTEN_PORTS: '1234' });
  assert.equal(process.env.LISTEN_PORTS, before);
});
