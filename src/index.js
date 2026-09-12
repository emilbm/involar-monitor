import { loadConfig } from './config.js';
import { configureLogger, createLogger } from './logger.js';
import { createClock } from './clock.js';
import { Store } from './store.js';
import { EgateServer } from './server.js';
import { RawLog } from './rawlog.js';
import { createApi } from './web/api.js';
import { createWebServer } from './web/server.js';
import { createErrorReporter } from './sentry.js';

const PRUNE_INTERVAL_MS = 6 * 3600 * 1000;

let cfg;
try {
  cfg = loadConfig();
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(78); // EX_CONFIG
}

configureLogger({ level: cfg.logLevel, tz: cfg.tz });
const log = createLogger('main');

const reporter = createErrorReporter({
  dsn: cfg.sentry.dsn,
  environment: cfg.sentry.environment,
  release: cfg.sentry.release || undefined,
  serverName: cfg.sentry.serverName || undefined,
  maxEventsPerMinute: cfg.sentry.maxEventsPerMinute,
});

const clock = createClock(cfg.tz);
const store = new Store({
  dbPath: cfg.db.path,
  clock,
  maxGapSeconds: cfg.db.maxGapSeconds,
  retentionDays: cfg.db.retentionDays,
});
const rawLog = new RawLog({
  enabled: cfg.rawLog.enabled,
  dir: cfg.dataDir,
  maxBytes: cfg.rawLog.maxBytes,
  maxFiles: cfg.rawLog.maxFiles,
});

const runtime = {
  startedAt: Date.now(),
  listening: false,
  connections: 0,
  bytes: 0,
  frames: 0,
  unknownFrames: 0,
  lastFrameAt: null,
  lastPeer: null,
  seenSerials: new Set(),
};

const stats = {
  connectionOpened(peer) { runtime.lastPeer = peer; },
  bytesReceived(n) { runtime.bytes += n; },
};

function onFrame(decoded, meta) {
  runtime.frames += 1;
  runtime.lastFrameAt = Math.floor(Date.now() / 1000);

  switch (decoded.kind) {
    case 'status': {
      // Every reading is stored exactly as reported - this is one household's
      // own array, so there is nothing to filter or sanity-check against.
      const row = store.recordPower(decoded.watts);
      log.debug('array power', { watts: decoded.watts, wh: row?.wh?.toFixed(3) });
      break;
    }

    case 'detail':
      if (runtime.seenSerials.size < 256) runtime.seenSerials.add(decoded.serial);
      store.recordInverterEnergy(decoded.serial, decoded.energyWh);
      log.debug('inverter daily energy', {
        serial: decoded.serial, energyWh: Math.round(decoded.energyWh),
      });
      break;

    case 'serial':
    case 'keepalive':
      log.debug(`${decoded.kind} frame`, { peer: meta.peer });
      break;

    default:
      runtime.unknownFrames += 1;
      log.warn('undecodable frame', { kind: decoded.kind, ...decoded, peer: meta.peer });
  }
}

function onRaw(frame, decoded, port) {
  if (!cfg.rawLog.enabled) return;
  rawLog.write(
    `${clock.day()} ${clock.hhmm()}\t${port}\t${decoded.kind}\t${frame.toString('hex')}`,
  );
}

const egate = new EgateServer(cfg, { onFrame, onRaw, stats, reporter });
const api = createApi({
  store,
  clock,
  config: cfg,
  reporter,
  runtime: new Proxy(runtime, {
    get: (t, k) => (k === 'connections' ? egate.openConnections : t[k]),
  }),
});

const timers = [];
let webServer = null;

async function main() {
  log.info('involar-monitor starting', {
    tz: cfg.tz,
    ports: cfg.listen.ports,
    db: cfg.db.path,
    web: cfg.web.enabled ? cfg.web.port : 'disabled',
  });

  store.open();
  store.prune();
  rawLog.open();

  await egate.listen();
  runtime.listening = true;

  timers.push(setInterval(() => {
    try {
      store.prune();
    } catch (err) {
      log.warn('prune failed', err);
      reporter.capture(err, { tags: { component: 'store-prune' } });
    }
  }, PRUNE_INTERVAL_MS));

  if (cfg.web.enabled) {
    webServer = await createWebServer({
      api, port: cfg.web.port, address: cfg.web.address, reporter,
    });
  }
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`received ${signal}, shutting down`);

  for (const t of timers) clearInterval(t);
  await Promise.allSettled([
    egate.close(),
    webServer && new Promise((r) => webServer.close(() => r())),
  ]);
  // Give a last report a moment to leave, so a crash-on-shutdown is not lost.
  await reporter.flush();
  rawLog.close();
  store.close();
  log.info('goodbye');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  log.error('unhandled promise rejection', reason instanceof Error ? reason : { reason });
  reporter.capture(reason, { tags: { handler: 'unhandledRejection' } });
});
process.on('uncaughtException', (err) => {
  // Let the container restart us rather than continue in an unknown state,
  // but give the report a moment to leave first.
  log.error('uncaught exception, exiting so the supervisor can restart us', err);
  reporter.capture(err, { tags: { handler: 'uncaughtException' } });
  reporter.flush(2000).finally(() => process.exit(1));
});

main().catch((err) => {
  log.error('failed to start', err);
  reporter.capture(err, { tags: { handler: 'startup' } });
  reporter.flush(2000).finally(() => process.exit(1));
});
