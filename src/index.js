import { loadConfig } from './config.js';
import { configureLogger, createLogger } from './logger.js';
import { createClock } from './clock.js';
import { PowerWindow, InverterTotals } from './aggregator.js';
import { PvOutputClient } from './pvoutput.js';
import { EgateServer } from './server.js';
import { RawLog } from './rawlog.js';
import { startHealthServer } from './health.js';

let cfg;
try {
  cfg = loadConfig();
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(78); // EX_CONFIG
}

configureLogger({ level: cfg.logLevel, tz: cfg.tz });
const log = createLogger('main');

const clock = createClock(cfg.tz);
const powerWindow = new PowerWindow(cfg.pvoutput.averageWindowMs);
const totals = new InverterTotals();
const uploader = new PvOutputClient(cfg.pvoutput, { dataDir: cfg.dataDir });
const rawLog = new RawLog({
  enabled: cfg.rawLog.enabled,
  dir: cfg.dataDir,
  maxBytes: cfg.rawLog.maxBytes,
  maxFiles: cfg.rawLog.maxFiles,
});

const runtime = {
  startedAt: Date.now(),
  listening: false,
  bytes: 0,
  frames: 0,
  lastFrameAt: null,
  lastStatusAt: null,
  lastPeer: null,
  unmappedSerials: new Set(),
};

const stats = {
  connectionOpened(peer) { runtime.lastPeer = peer; },
  bytesReceived(n) { runtime.bytes += n; },
};

function onFrame(decoded, meta) {
  runtime.frames += 1;
  runtime.lastFrameAt = Date.now();

  switch (decoded.kind) {
    case 'status':
      runtime.lastStatusAt = Date.now();
      powerWindow.add(decoded.watts);
      log.debug('array power', { watts: decoded.watts, samples: powerWindow.size });
      break;

    case 'detail': {
      const sid = cfg.pvoutput.mapping[decoded.serial];
      if (!sid) {
        // Log each unknown serial once, not on every table dump. Capped so a
        // stream of garbage frames cannot grow this without bound.
        if (!runtime.unmappedSerials.has(decoded.serial) && runtime.unmappedSerials.size < 64) {
          runtime.unmappedSerials.add(decoded.serial);
          log.warn('no PVOUTPUT_MICROINVERTER_MAPPING entry for this serial', {
            serial: decoded.serial,
            energyWh: Math.round(decoded.energyWh),
          });
        }
        break;
      }
      if (totals.record(decoded.serial, decoded.energyWh)) {
        log.debug('inverter daily energy', {
          serial: decoded.serial, sid, energyWh: Math.round(decoded.energyWh),
        });
      }
      break;
    }

    case 'serial':
    case 'keepalive':
      log.debug(`${decoded.kind} frame`, { peer: meta.peer });
      break;

    default:
      log.warn('undecodable frame', { kind: decoded.kind, ...decoded, peer: meta.peer });
  }
}

function onRaw(frame, decoded, port) {
  if (!cfg.rawLog.enabled) return;
  const { date, time } = clock.stamp();
  rawLog.write(`${date} ${time}\t${port}\t${decoded.kind}\t${frame.toString('hex')}`);
}

function publishArrayPower() {
  const summary = powerWindow.summarise();
  if (!summary) {
    log.debug('no power samples in the window, nothing to publish');
    return;
  }
  const { date, time } = clock.stamp();
  uploader.enqueue(cfg.pvoutput.systemId, { date, time, power: summary.average });
  log.info('array power queued', {
    watts: Math.round(summary.average), samples: summary.count, date, time,
  });
}

function publishInverters() {
  const readings = totals.drain();
  if (!readings.length) return;
  const { date, time } = clock.stamp();
  for (const { serial, energyWh } of readings) {
    const sid = cfg.pvoutput.mapping[serial];
    if (!sid) continue;
    uploader.enqueue(sid, { date, time, energy: energyWh });
  }
  log.info('inverter energy queued', { inverters: readings.length, date, time });
}

const egate = new EgateServer(cfg, { onFrame, onRaw, stats });

const timers = [];
let healthServer = null;

async function main() {
  log.info('involar2pvoutput starting', {
    tz: cfg.tz,
    ports: cfg.listen.ports,
    dryRun: cfg.pvoutput.dryRun,
    microInverterMode: cfg.pvoutput.microInverterMode,
    postIntervalSeconds: cfg.pvoutput.postIntervalMs / 1000,
  });

  if (cfg.pvoutput.dryRun && !cfg.pvoutput.systemId) {
    log.warn('dry run without PVOUTPUT_SYSTEM_ID: array readings will be logged '
      + 'with an empty system id. Set it to see exactly what will be posted.');
  }

  rawLog.open();
  await uploader.start();
  await egate.listen();
  runtime.listening = true;

  timers.push(setInterval(publishArrayPower, cfg.pvoutput.postIntervalMs));
  if (cfg.pvoutput.microInverterMode) {
    timers.push(setInterval(publishInverters, cfg.pvoutput.microIntervalMs));
  }

  if (cfg.health.enabled) {
    healthServer = await startHealthServer({
      port: cfg.health.port,
      snapshot: () => ({
        listening: runtime.listening,
        uptimeSeconds: Math.round((Date.now() - runtime.startedAt) / 1000),
        connections: egate.openConnections,
        lastPeer: runtime.lastPeer,
        framesReceived: runtime.frames,
        bytesReceived: runtime.bytes,
        lastFrameAt: runtime.lastFrameAt && new Date(runtime.lastFrameAt).toISOString(),
        lastStatusAt: runtime.lastStatusAt && new Date(runtime.lastStatusAt).toISOString(),
        powerSamplesInWindow: powerWindow.size,
        unmappedSerials: [...runtime.unmappedSerials],
        pvoutput: uploader.stats(),
      }),
    });
  }
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`received ${signal}, shutting down`);

  for (const t of timers) clearInterval(t);
  // Publish whatever is still in the window so a restart does not lose it.
  try { publishArrayPower(); } catch { /* best effort */ }
  if (cfg.pvoutput.microInverterMode) {
    try { publishInverters(); } catch { /* best effort */ }
  }

  await Promise.allSettled([
    egate.close(),
    uploader.stop(),
    healthServer && new Promise((r) => healthServer.close(() => r())),
  ]);
  rawLog.close();
  log.info('goodbye');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  log.error('unhandled promise rejection', reason instanceof Error ? reason : { reason });
});
process.on('uncaughtException', (err) => {
  // Let the container restart us rather than continue in an unknown state.
  log.error('uncaught exception, exiting so the supervisor can restart us', err);
  process.exit(1);
});

main().catch((err) => {
  log.error('failed to start', err);
  process.exit(1);
});
